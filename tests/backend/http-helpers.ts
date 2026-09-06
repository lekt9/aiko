import { createServer, type Server } from "node:http";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { CookieJar } from "tough-cookie";
export async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP listener");
  return "http://127.0.0.1:" + address.port;
}
export async function close(server: Server) {
  await new Promise<void>((r) => server.close(() => r()));
}
export async function freePort() {
  const server = createServer();
  const origin = await listen(server);
  await close(server);
  return new URL(origin);
}
export function signingKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKey,
    privateJwk: {
      ...privateKey.export({ format: "jwk" }),
      kid: "test-key",
      use: "sig",
      alg: "RS256",
    },
    publicJwk: {
      ...publicKey.export({ format: "jwk" }),
      kid: "test-key",
      use: "sig",
      alg: "RS256",
    },
  };
}
/** Fixture identity provider; never linked into the application or accepted by production configuration. */
export async function mockIdentityProvider() {
  const keys = signingKeys(),
    codes = new Map<
      string,
      { nonce: string; challenge: string; client: string; redirect: string }
    >();
  let issuer = "",
    subject = "owner-sub",
    badNonce = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      res.end(JSON.stringify({ keys: [keys.publicJwk] }));
      return;
    }
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        client: url.searchParams.get("client_id")!,
        redirect: url.searchParams.get("redirect_uri")!,
      });
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: target.href });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body),
        saved = codes.get(form.get("code")!);
      codes.delete(form.get("code")!);
      if (
        !saved ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== saved.challenge ||
        form.get("redirect_uri") !== saved.redirect
      ) {
        res.writeHead(400);
        res.end('{"error":"invalid_grant"}');
        return;
      }
      const at = Math.floor(Date.now() / 1000),
        head = Buffer.from(
          JSON.stringify({ alg: "RS256", kid: "test-key" }),
        ).toString("base64url"),
        payload = Buffer.from(
          JSON.stringify({
            iss: issuer,
            sub: subject,
            aud: saved.client,
            iat: at,
            exp: at + 300,
            nonce: badNonce ? "incorrect-fixture-nonce" : saved.nonce,
          }),
        ).toString("base64url"),
        signed = head + "." + payload,
        signature = createSign("RSA-SHA256")
          .update(signed)
          .sign(keys.privateKey)
          .toString("base64url");
      res.end(
        JSON.stringify({
          access_token: "synthetic-upstream-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: signed + "." + signature,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  issuer = await listen(server);
  return {
    issuer,
    server,
    setSubject(value: string) {
      subject = value;
    },
    setBadNonce(value: boolean) {
      badNonce = value;
    },
  };
}
export class HttpBrowser {
  jar = new CookieJar();
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers),
      cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const value of response.headers.getSetCookie())
      await this.jar.setCookie(value, url);
    return response;
  }
  async follow(url: string) {
    for (let i = 0; i < 12; i++) {
      const response = await this.request(url);
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location")
      ) {
        url = new URL(response.headers.get("location")!, url).href;
        continue;
      }
      return response;
    }
    throw new Error("Fixture redirect limit");
  }
}
