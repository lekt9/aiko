import Provider, { errors, type Configuration } from "oidc-provider";
import type { IncomingMessage, ServerResponse } from "node:http";
import { oidcAdapter } from "./oidc-adapter.js";
import { OwnerAuth } from "./owner-auth.js";
import { digest, same } from "./crypto.js";
import { Vault, type RuntimePrincipal } from "./vault.js";
import { VaultError } from "./errors.js";
const scopes = "sessions:read sessions:write maintenance:request";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export class OAuth {
  readonly provider: Provider;
  readonly resource: string;
  constructor(
    public vault: Vault,
    public owner: OwnerAuth,
    public origin: string,
    keys: NonNullable<Configuration["jwks"]>,
    cookieKeys: string[],
  ) {
    if (!cookieKeys.length || cookieKeys.some((k) => k.length < 32))
      throw new Error("OAuth cookie signing keys are required");
    this.resource = origin + "/v1";
    this.provider = new Provider(origin + "/oauth", {
      adapter: oidcAdapter(vault),
      jwks: keys,
      cookies: {
        keys: cookieKeys,
        long: {
          secure: origin.startsWith("https:"),
          httpOnly: true,
          sameSite: "lax",
        },
        short: {
          secure: origin.startsWith("https:"),
          httpOnly: true,
          sameSite: "lax",
        },
      },
      clients: [],
      responseTypes: ["code"],
      scopes: ["openid", "offline_access"],
      pkce: { required: () => true },
      features: {
        devInteractions: { enabled: false },
        registration: { enabled: false },
        revocation: { enabled: true },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => this.resource,
          useGrantedResource: () => true,
          getResourceServerInfo: async (_ctx, resource, client) => {
            if (
              resource !== this.resource ||
              !(
                await vault.db.query(
                  "SELECT id FROM clients WHERE id=$1 AND enabled",
                  [client.clientId],
                )
              ).rows.length
            )
              throw new errors.InvalidTarget();
            return {
              scope: scopes,
              audience: this.resource,
              accessTokenFormat: "opaque",
              accessTokenTTL: 300,
            };
          },
        },
      },
      ttl: {
        AccessToken: 300,
        IdToken: 300,
        AuthorizationCode: 60,
        RefreshToken: 86400 * 7,
        Grant: 86400 * 30,
        Session: 28800,
        Interaction: 600,
      },
      rotateRefreshToken: true,
      issueRefreshToken: (_ctx, client, code) =>
        client.grantTypeAllowed("refresh_token") &&
        !!code.scope?.split(" ").includes("offline_access"),
      interactions: {
        url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}`,
      },
      findAccount: async (ctx, accountId) => {
        if (
          ctx.oidc.route === "authorization" &&
          (await owner.session(ctx.headers.cookie))?.tenant !== accountId
        )
          return undefined;
        if (
          !(
            await vault.db.query("SELECT id FROM vaults WHERE id=$1", [
              accountId,
            ])
          ).rows.length
        )
          return undefined;
        return { accountId, claims: async () => ({ sub: accountId }) };
      },
      extraTokenClaims: async (_ctx, token) => {
        if (
          !(
            await vault.db.query(
              "SELECT id FROM clients WHERE id=$1 AND tenant=$2 AND enabled",
              [
                token.clientId,
                "accountId" in token ? token.accountId : undefined,
              ],
            )
          ).rows.length
        )
          throw new errors.InvalidGrant();
        return {};
      },
      renderError: async (ctx) => {
        ctx.type = "text/html";
        ctx.body =
          "<h1>Authorization could not be completed.</h1><p>Return to the requesting application and try again.</p>";
      },
    });
    this.provider.proxy = origin.startsWith("https:");
    this.provider.on("server_error", () => {
      /* No raw requests, tokens or provider errors in logs. */
    });
  }
  async authenticate(token: string): Promise<RuntimePrincipal> {
    const value = await this.provider.AccessToken.find(token);
    if (
      !value ||
      value.isExpired ||
      value.aud !== this.resource ||
      !value.accountId ||
      !value.clientId ||
      !value.grantId ||
      !(await this.provider.Grant.find(value.grantId))
    )
      throw new VaultError("UNAUTHENTICATED", 401);
    const client = (
      await this.vault.db.query<{
        tenant: string;
        profile: string;
        connections: string[];
      }>(
        "SELECT tenant,profile,connections FROM clients WHERE id=$1 AND tenant=$2 AND enabled",
        [value.clientId, value.accountId],
      )
    ).rows[0];
    if (!client) throw new VaultError("UNAUTHENTICATED", 401);
    return {
      ...client,
      client: value.clientId,
      scope: (value.scope ?? "").split(" "),
    };
  }
  async interaction(req: IncomingMessage, res: ServerResponse) {
    const details = await this.provider.interactionDetails(req, res),
      session = await this.owner.session(req.headers.cookie);
    if (!session) {
      res.writeHead(302, {
        Location:
          "/auth/login?returnTo=" +
          encodeURIComponent(`/oauth/interaction/${details.uid}`),
      });
      res.end();
      return;
    }
    const clientId = String(details.params.client_id),
      client = (
        await this.vault.db.query<{ name: string; profile: string }>(
          "SELECT name,profile FROM clients WHERE tenant=$1 AND id=$2 AND enabled",
          [session.tenant, clientId],
        )
      ).rows[0];
    if (!client) throw new VaultError("FORBIDDEN", 403);
    const profile = (
      await this.vault.db.query<{ name: string }>(
        "SELECT name FROM profiles WHERE tenant=$1 AND id=$2 AND enabled",
        [session.tenant, client.profile],
      )
    ).rows[0];
    if (!profile) throw new VaultError("FORBIDDEN", 403);
    const csrf = digest(session.csrf + ":" + details.uid);
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect agent to Unlock</title><style>body{font:17px/1.6 system-ui;max-width:600px;margin:10vh auto;padding:24px;overflow-wrap:anywhere}button{padding:14px;margin:10px 12px 0 0;min-height:44px;min-width:44px}</style></head><body><main><h1>Connect ${escape(client.name)}?</h1><p>Use ${escape(profile.name)} with its owner-approved login assignments. The permissions below apply to its selected logins within this profile. No per-task approval is required.</p><p>Permissions requested: ${escape(String(details.params.scope ?? ""))}. Revocation stops future vault access, not cookies already delivered.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">Connect agent</button><button name="decision" value="deny">Cancel</button></form></main></body></html>`,
      );
      return;
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== this.origin ||
      !req.headers["content-type"]?.startsWith(
        "application/x-www-form-urlencoded",
      )
    )
      throw new VaultError("FORBIDDEN", 403);
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 8192) throw new VaultError("INVALID_INPUT");
    }
    const form = new URLSearchParams(body);
    if (!same(form.get("csrf") ?? "", csrf))
      throw new VaultError("FORBIDDEN", 403);
    if (form.get("decision") !== "approve") {
      await this.provider.interactionFinished(
        req,
        res,
        { error: "access_denied" },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    const grant = new this.provider.Grant({
      accountId: session.tenant,
      clientId,
    });
    grant.addOIDCScope("openid offline_access");
    const requested = String(details.params.scope ?? "")
      .split(" ")
      .filter((scope) => scopes.split(" ").includes(scope))
      .join(" ");
    grant.addResourceScope(this.resource, requested);
    const grantId = await grant.save();
    await this.vault.audit(
      this.vault.db,
      session.tenant,
      "owner",
      "oauth.authorized",
      clientId,
      { profile: client.profile },
    );
    await this.provider.interactionFinished(
      req,
      res,
      { login: { accountId: session.tenant }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
  }
}
