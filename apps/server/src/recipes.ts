import { lookup } from "node:dns";
import { Agent, request, type Dispatcher } from "undici";
import ipaddr from "ipaddr.js";
import { Cookie, CookieJar, getPublicSuffix } from "tough-cookie";
import { createClient } from "@1password/sdk";
import { cookieJar, type VaultCookie } from "@unlock/protocol";
import { VaultError } from "./errors.js";
export interface Verified {
  identity: string;
  cookies: VaultCookie[];
  expiresAt: number;
}
export interface PrivateSsoContext {
  identity: string;
  cookies: VaultCookie[];
  domains: string[];
  revision: number;
  checkpoint(cookies: VaultCookie[]): Promise<{ revision: number }>;
}
export interface RecipeContext {
  identity: string;
  website: string;
  domains: string[];
  cookies: VaultCookie[];
  signal: AbortSignal;
  password: () => Promise<string | undefined>;
  sso: () => Promise<PrivateSsoContext | undefined>;
}
export interface AuthRecipe {
  id: string;
  runtimeId?: string;
  verify(ctx: RecipeContext): Promise<Verified>;
  renew(ctx: RecipeContext): Promise<Verified>;
}
export interface PasswordSource {
  resolve(token: string, reference: string): Promise<string>;
}
export class OnePasswordSource implements PasswordSource {
  async resolve(token: string, reference: string) {
    try {
      const client = await createClient({
        auth: token,
        integrationName: "Unlock",
        integrationVersion: "0.2.0",
      });
      return await client.secrets.resolve(reference);
    } catch {
      throw new VaultError("SOURCE_UNAVAILABLE", 503);
    }
  }
}
export function validateCookies(
  cookies: unknown,
  domains: string[],
): VaultCookie[] {
  const parsed = cookieJar.parse(cookies),
    seen = new Set<string>();
  for (const c of parsed) {
    const host = c.domain.replace(/^\./, "").toLowerCase();
    if (
      (!c.hostOnly && !getPublicSuffix(host)) ||
      !domains.includes(host) ||
      c.domain !== c.domain.toLowerCase() ||
      !c.secure ||
      (c.hostOnly && c.domain.startsWith(".")) ||
      (!c.hostOnly && !c.domain.startsWith(".")) ||
      (c.name.startsWith("__Host-") && (!c.hostOnly || c.path !== "/")) ||
      (c.partitionKey &&
        new URL(c.partitionKey.topLevelSite).protocol !== "https:")
    )
      throw new VaultError("FORBIDDEN", 403);
    const key = JSON.stringify([
      c.name,
      c.domain,
      c.path,
      c.partitionKey ?? null,
    ]);
    if (seen.has(key)) throw new VaultError("INVALID_INPUT");
    seen.add(key);
  }
  return parsed;
}
/** Fixed operator-approved origins only. Every DNS connection rejects non-public addresses. */
export function publicDispatcher() {
  return new Agent({
    connect: {
      lookup(host, options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) {
            callback(error, "", 4);
            return;
          }
          if (
            !addresses.length ||
            addresses.some(
              (a) => ipaddr.process(a.address).range() !== "unicast",
            )
          ) {
            callback(new Error("Destination refused"), "", 4);
            return;
          }
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    },
  });
}
export interface HttpRecipeConfig {
  id: string;
  origin: string;
  identityPath: string;
  identityField: string;
  loginPath?: string;
  refreshPath?: string;
  bootstrapPath?: string;
  csrfField?: string;
  form?: boolean;
  maxSessionMs?: number;
}
/** For documented JSON/form login APIs, not arbitrary website or Google browser SSO automation. */
export function createHttpRecipe(
  config: HttpRecipeConfig,
  dispatcher: Dispatcher = publicDispatcher(),
): AuthRecipe {
  const origin = new URL(config.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== config.origin ||
    origin.hostname === "localhost" ||
    (ipaddr.isValid(origin.hostname.replace(/[\[\]]/g, "")) &&
      ipaddr.process(origin.hostname.replace(/[\[\]]/g, "")).range() !==
        "unicast")
  )
    throw new Error("Recipe requires an exact HTTPS origin");
  for (const path of [
    config.identityPath,
    config.loginPath,
    config.refreshPath,
    config.bootstrapPath,
  ].filter(Boolean))
    if (new URL(path!, origin).origin !== origin.origin)
      throw new Error("Recipe paths must stay on origin");
  async function run(ctx: RecipeContext, renew: boolean) {
    if (
      new URL(ctx.website).origin !== origin.origin ||
      !ctx.domains.includes(origin.hostname)
    )
      throw new VaultError("FORBIDDEN", 403);
    const jar = new CookieJar();
    for (const c of validateCookies(ctx.cookies, ctx.domains)) {
      if (c.partitionKey) throw new VaultError("RUNTIME_UNAVAILABLE", 409);
      const line = `${c.name}=${c.value}; Path=${c.path}; Secure${c.httpOnly ? "; HttpOnly" : ""}${c.hostOnly ? "" : `; Domain=${c.domain}`}${c.expires > 0 ? `; Expires=${new Date(c.expires * 1000).toUTCString()}` : ""}; SameSite=${c.sameSite}`;
      await jar.setCookie(line, origin.origin + c.path);
    }
    const call = async (path: string, fields?: Record<string, string>) => {
      try {
        const url = new URL(path, origin),
          cookieHeader = await jar.getCookieString(url.href);
        const response = await request(url, {
          dispatcher,
          method: fields ? "POST" : "GET",
          signal: ctx.signal,
          headersTimeout: 10000,
          bodyTimeout: 10000,
          headers: {
            Accept: "application/json",
            Cookie: cookieHeader,
            ...(fields
              ? {
                  "Content-Type": config.form
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
                  Origin: origin.origin,
                }
              : {}),
          },
          ...(fields
            ? {
                body: config.form
                  ? new URLSearchParams(fields).toString()
                  : JSON.stringify(fields),
              }
            : {}),
        });
        const setCookies = response.headers["set-cookie"];
        for (const value of Array.isArray(setCookies)
          ? setCookies
          : setCookies
            ? [setCookies]
            : [])
          await jar.setCookie(value, url.href);
        let text = "",
          size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 65536) {
            response.body.destroy();
            throw new VaultError("UNAVAILABLE", 503);
          }
          text += chunk.toString();
        }
        if ([401, 403].includes(response.statusCode))
          throw new VaultError("REAUTH_REQUIRED", 409);
        if (response.statusCode < 200 || response.statusCode >= 300)
          throw new VaultError("UNAVAILABLE", 503);
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw new VaultError("UNAVAILABLE", 503);
      }
    };
    if (renew) {
      let refreshed = false;
      if (config.refreshPath && ctx.cookies.length) {
        try {
          await call(config.refreshPath, {});
          refreshed = true;
        } catch (error) {
          if (
            !(error instanceof VaultError) ||
            error.code !== "REAUTH_REQUIRED"
          )
            throw error;
        }
      }
      if (!refreshed) {
        if (!config.loginPath) throw new VaultError("REAUTH_REQUIRED", 409);
        const password = await ctx.password();
        if (!password) throw new VaultError("REAUTH_REQUIRED", 409);
        const fields: Record<string, string> = {
          username: ctx.identity,
          password,
        };
        if (config.bootstrapPath && config.csrfField) {
          const value = (await call(config.bootstrapPath))[config.csrfField];
          if (typeof value !== "string" || value.length > 4096)
            throw new VaultError("REAUTH_REQUIRED", 409);
          fields[config.csrfField] = value;
        }
        await call(config.loginPath, fields);
      }
    }
    const account = await call(config.identityPath),
      who = account[config.identityField];
    if (typeof who !== "string" || who !== ctx.identity)
      throw new VaultError("REAUTH_REQUIRED", 409);
    const cookies = (await jar.serialize()).cookies
      .map((c) => Cookie.fromJSON(c)!)
      .filter(Boolean)
      .map((c) => ({
        name: c.key,
        value: c.value,
        domain: c.hostOnly ? c.domain! : "." + c.domain,
        path: c.path ?? "/",
        hostOnly: !!c.hostOnly,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: (c.sameSite
          ? c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1)
          : "Lax") as VaultCookie["sameSite"],
        expires: Number.isFinite(c.expiryTime())
          ? (c.expiryTime() ?? 0) / 1000
          : -1,
      }))
      .filter((c) => c.expires < 0 || c.expires * 1000 > Date.now());
    const cap =
        Date.now() + Math.min(config.maxSessionMs ?? 300_000, 3_600_000),
      expiry = Math.min(
        cap,
        ...cookies.filter((c) => c.expires > 0).map((c) => c.expires * 1000),
      );
    return {
      identity: who,
      cookies: validateCookies(cookies, ctx.domains),
      expiresAt: expiry,
    };
  }
  return {
    id: config.id,
    verify: (ctx) => run(ctx, false),
    renew: (ctx) => run(ctx, true),
  };
}
