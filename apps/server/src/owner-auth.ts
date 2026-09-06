import * as oidc from "openid-client";
import { digest, randomToken, same, type Envelope } from "./crypto.js";
import { Vault } from "./vault.js";
import { VaultError } from "./errors.js";
export interface OwnerIdentityProvider {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
  allowedSubjects: string[];
  allowLocalHttp?: boolean;
}
export interface OwnerSession {
  tenant: string;
  csrf: string;
  hash: string;
  expiresAt: number;
}
export function cookies(header: string | undefined) {
  return Object.fromEntries(
    (header ?? "").split(";").map((s) => {
      const at = s.indexOf("=");
      return at < 0 ? ["", ""] : [s.slice(0, at).trim(), s.slice(at + 1)];
    }),
  );
}
export class OwnerAuth {
  private configuration?: Promise<oidc.Configuration>;
  constructor(
    public vault: Vault,
    public origin: string,
    private provider?: OwnerIdentityProvider,
  ) {}
  private cookieName(name: string) {
    return this.origin.startsWith("https:") ? "__Host-" + name : name;
  }
  cookie(name: string, value: string, maxAge: number) {
    return `${this.cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  private config() {
    if (!this.provider) throw new VaultError("UNAVAILABLE", 503);
    const p = this.provider;
    this.configuration ??= oidc.discovery(
      new URL(p.issuer),
      p.clientId,
      p.clientSecret,
      p.clientSecret
        ? p.tokenEndpointAuthMethod === "client_secret_post"
          ? oidc.ClientSecretPost(p.clientSecret)
          : oidc.ClientSecretBasic(p.clientSecret)
        : oidc.None(),
      p.allowLocalHttp && new URL(p.issuer).protocol === "http:"
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined,
    );
    return this.configuration;
  }
  async session(header: string | undefined): Promise<OwnerSession | undefined> {
    const token = cookies(header)[this.cookieName("unlock_owner")];
    if (!token) return undefined;
    const hash = digest(token),
      s = (
        await this.vault.db.query<{
          tenant: string;
          csrf: string;
          expires_at: string;
        }>(
          "SELECT tenant,csrf,expires_at FROM owner_sessions WHERE hash=$1 AND expires_at>$2",
          [hash, this.vault.now()],
        )
      ).rows[0];
    return s
      ? {
          tenant: s.tenant,
          csrf: s.csrf,
          expiresAt: Number(s.expires_at),
          hash,
        }
      : undefined;
  }
  /** Invoked only after upstream identity verification, never exposed as a bootstrap HTTP endpoint. */
  async createSession(issuer: string, subject: string) {
    const tenant = await this.vault.owner(issuer, subject),
      token = randomToken(),
      csrf = randomToken();
    await this.vault.db.query(
      "INSERT INTO owner_sessions(hash,tenant,csrf,expires_at) VALUES($1,$2,$3,$4)",
      [digest(token), tenant, csrf, this.vault.now() + 8 * 3600_000],
    );
    return { tenant, token, csrf };
  }
  async begin(returnTo = "/") {
    if (
      returnTo !== "/" &&
      !/^\/oauth\/interaction\/[A-Za-z0-9_-]+$/.test(returnTo)
    )
      throw new VaultError("INVALID_INPUT");
    const state = oidc.randomState(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce(),
      browser = randomToken(),
      hash = digest(state),
      config = await this.config();
    const secret = await this.vault.cipher.seal(
      `unlock:v1:auth-state:${hash}`,
      { verifier, nonce, browser: digest(browser), returnTo },
    );
    await this.vault.db.query(
      "INSERT INTO auth_states(hash,secret,expires_at) VALUES($1,$2,$3)",
      [hash, JSON.stringify(secret), this.vault.now() + 600_000],
    );
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.origin + "/auth/callback",
      scope: "openid",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    return { url: url.href, cookie: this.cookie("unlock_login", browser, 600) };
  }
  async finish(url: URL, header: string | undefined) {
    const state = url.searchParams.get("state"),
      browser = cookies(header)[this.cookieName("unlock_login")];
    if (!state || !browser) throw new VaultError("UNAUTHENTICATED", 401);
    const hash = digest(state),
      stored = await this.vault.db.transaction(async (sql) => {
        const row = (
          await sql.query<{ secret: Envelope }>(
            "SELECT secret FROM auth_states WHERE hash=$1 AND expires_at>$2 FOR UPDATE",
            [hash, this.vault.now()],
          )
        ).rows[0];
        if (!row) throw new VaultError("UNAUTHENTICATED", 401);
        const data = await this.vault.cipher.open<{
          verifier: string;
          nonce: string;
          browser: string;
          returnTo: string;
        }>(`unlock:v1:auth-state:${hash}`, row.secret);
        if (!same(data.browser, digest(browser)))
          throw new VaultError("UNAUTHENTICATED", 401);
        await sql.query("DELETE FROM auth_states WHERE hash=$1", [hash]);
        return data;
      });
    const tokens = await oidc.authorizationCodeGrant(await this.config(), url, {
      pkceCodeVerifier: stored.verifier,
      expectedState: state,
      expectedNonce: stored.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || !this.provider?.allowedSubjects.includes(claims.sub))
      throw new VaultError("FORBIDDEN", 403);
    const session = await this.createSession(this.provider.issuer, claims.sub);
    return {
      returnTo: stored.returnTo,
      cookies: [
        this.cookie("unlock_owner", session.token, 8 * 3600),
        this.cookie("unlock_login", "", 0),
      ],
    };
  }
  async logout(session: OwnerSession) {
    await this.vault.db.query("DELETE FROM owner_sessions WHERE hash=$1", [
      session.hash,
    ]);
    return this.cookie("unlock_owner", "", 0);
  }
}
