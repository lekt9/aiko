/** Node-only agent authorization. Tokens/verifiers remain in this trusted host and private store. */
import * as oidc from "openid-client";
import { UnlockError } from "./transport.js";
import {
  MemoryTokenStore,
  type TokenStore,
  type OAuthState,
} from "./token-store.js";
export { MemoryTokenStore, EncryptedFileTokenStore } from "./token-store.js";
export type { TokenStore } from "./token-store.js";
export interface AgentOAuthOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  store?: TokenStore;
  allowLocalHttp?: boolean;
}
export function createAgentOAuth(options: AgentOAuthOptions) {
  const issuer = new URL(options.issuer),
    redirect = new URL(options.redirectUri);
  for (const url of [issuer, redirect])
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol !== "https:" &&
        !(
          (options.allowLocalHttp || url === redirect) &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1"
        ))
    )
      throw new TypeError(
        "Use HTTPS; explicit loopback HTTP is for local development only",
      );
  const store = options.store ?? new MemoryTokenStore(),
    binding = JSON.stringify([issuer.href, options.clientId, redirect.href]),
    resource = issuer.origin + "/v1";
  let configuration: Promise<oidc.Configuration> | undefined;
  const config = () =>
    (configuration ??= oidc
      .discovery(
        issuer,
        options.clientId,
        undefined,
        oidc.None(),
        options.allowLocalHttp && issuer.protocol === "http:"
          ? { execute: [oidc.allowInsecureRequests] }
          : undefined,
      )
      .then((configuration) => {
        const metadata = configuration.serverMetadata();
        for (const value of [
          metadata.authorization_endpoint,
          metadata.token_endpoint,
          metadata.jwks_uri,
          metadata.revocation_endpoint,
        ].filter((s): s is string => !!s)) {
          if (new URL(value).origin !== issuer.origin)
            throw new UnlockError(
              "INVALID_RESPONSE",
              0,
              "Unexpected authorization endpoint origin.",
            );
        }
        return configuration;
      }));
  const fault = (code = "UNAUTHENTICATED") =>
    new UnlockError(code, 401, "Agent authorization must be completed again.");
  const check = (state: OAuthState) => {
    if (state.binding && state.binding !== binding) throw fault();
  };
  const record = (
    tokens: oidc.TokenEndpointResponse,
    previousRefresh?: string,
  ) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefresh,
    expiresAt: Date.now() + Math.min(tokens.expires_in ?? 300, 300) * 1000,
  });
  return {
    async begin() {
      try {
        return await store.withLock(async (state, save) => {
          check(state);
          const pending = {
            state: oidc.randomState(),
            nonce: oidc.randomNonce(),
            verifier: oidc.randomPKCECodeVerifier(),
            expiresAt: Date.now() + 600_000,
          };
          await save({ ...state, binding, pending });
          const url = oidc.buildAuthorizationUrl(await config(), {
            redirect_uri: redirect.href,
            scope:
              "openid offline_access sessions:read sessions:write maintenance:request",
            resource,
            prompt: "consent",
            state: pending.state,
            nonce: pending.nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(
              pending.verifier,
            ),
            code_challenge_method: "S256",
          });
          return { url: url.href };
        });
      } catch (error) {
        if (error instanceof UnlockError) throw error;
        throw fault("UNAVAILABLE");
      }
    },
    async finish(callback: string) {
      try {
        return await store.withLock(async (state, save) => {
          check(state);
          const url = new URL(callback),
            pending = state.pending;
          if (
            !pending ||
            pending.expiresAt <= Date.now() ||
            url.origin !== redirect.origin ||
            url.pathname !== redirect.pathname
          )
            throw fault();
          await save({ ...state, pending: undefined });
          const tokens = await oidc.authorizationCodeGrant(
            await config(),
            url,
            {
              pkceCodeVerifier: pending.verifier,
              expectedState: pending.state,
              expectedNonce: pending.nonce,
              idTokenExpected: true,
            },
            { resource },
          );
          await save({ binding, tokens: record(tokens) });
          return { authorized: true as const };
        });
      } catch (error) {
        if (error instanceof UnlockError) throw error;
        throw fault();
      }
    },
    /** Pass this function directly as the trusted runtime client's token provider. Never print its return. */
    async accessToken(): Promise<string> {
      return store.withLock(async (state, save) => {
        check(state);
        if (!state.tokens || state.refreshInFlight) throw fault();
        if (state.tokens.expiresAt > Date.now() + 30000)
          return state.tokens.accessToken;
        if (!state.tokens.refreshToken) throw fault();
        await save({ ...state, refreshInFlight: true });
        try {
          const tokens = record(
            await oidc.refreshTokenGrant(
              await config(),
              state.tokens.refreshToken,
              { resource },
            ),
            state.tokens.refreshToken,
          );
          await save({ binding, tokens });
          return tokens.accessToken;
        } catch {
          await save({ binding });
          throw fault();
        }
      });
    },
    async status() {
      return store.withLock(async (state) => {
        check(state);
        return {
          hasCredentials: !!state.tokens && !state.refreshInFlight,
          expiresAt: state.tokens?.expiresAt ?? null,
        };
      });
    },
    async logout() {
      return store.withLock(async (state, save) => {
        check(state);
        let remoteRevoked = false;
        try {
          if (state.tokens) {
            await oidc.tokenRevocation(
              await config(),
              state.tokens.refreshToken ?? state.tokens.accessToken,
            );
            remoteRevoked = true;
          }
        } catch {
          /* Local deletion still succeeds; do not claim remote revocation. */
        } finally {
          await save({ binding });
        }
        return { localCleared: true as const, remoteRevoked };
      });
    },
  };
}
