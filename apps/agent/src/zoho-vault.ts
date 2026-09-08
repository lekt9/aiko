/** Private Zoho Vault OAuth adapter; never exposed as an assistant tool. */
import {
  createHash,
  randomBytes,
  createPrivateKey,
  privateDecrypt,
  constants,
} from "node:crypto";
import {
  decryptZohoVaultField,
  type ZohoUnlockParameters,
} from "@unlock/protocol";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ManagerGrant, ManagerProvider } from "./password-manager-mcp.ts";
import { boundedText } from "./security.ts";

type Secret = Record<string, unknown>;
export type ZohoEntry = { reference: string; label: string; website: string };
const failed = () =>
  new Error(
    "Could not use Zoho Vault. Check authorization and unlock your vault again.",
  );
const secretId = (reference: string) => {
  const match = /^zohovault:\/\/([0-9]{1,40})\/password$/.exec(reference);
  if (!match) throw new Error("Invalid Zoho Vault login reference");
  return match[1];
};

export class ZohoVault {
  private signal: AbortSignal;
  private refreshing?: Promise<void>;
  constructor(
    private provider: ManagerProvider,
    private grant: ManagerGrant,
    private fetchFn: FetchLike = fetch,
    signal?: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
  }
  authorize() {
    if (!this.grant.state) throw failed();
    const verifier = Buffer.from(randomBytes(32)).toString("base64url");
    this.grant.verifier = verifier;
    delete this.grant.zoho;
    const url = new URL(
      "/oauth/v2/auth",
      this.provider.authorizationOrigins[0],
    );
    url.search = new URLSearchParams({
      client_id: this.provider.clientId!,
      response_type: "code",
      redirect_uri: this.provider.redirectUrl,
      scope: this.provider.scope!,
      access_type: "offline",
      prompt: "consent",
      state: this.grant.state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(verifier)
        .digest("base64url"),
    }).toString();
    return { authorizationUrl: url.href };
  }
  private async json(url: URL, init: RequestInit = {}) {
    try {
      this.signal.throwIfAborted();
      const response = await this.fetchFn(url, {
        ...init,
        redirect: "error",
        signal: this.signal,
      });
      if (!response.ok) throw failed();
      const body = await boundedText(response, 4 * 1024 * 1024);
      this.signal.throwIfAborted();
      return JSON.parse(body);
    } catch {
      throw failed();
    }
  }
  async exchange(code?: string) {
    const refresh = this.grant.tokens?.refresh_token;
    if (!code && !refresh) throw failed();
    const data = await this.json(
      new URL("/oauth/v2/token", this.provider.authorizationOrigins[0]),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.provider.clientId!,
          client_secret: this.provider.clientSecret!,
          ...(code
            ? {
                grant_type: "authorization_code",
                code,
                redirect_uri: this.provider.redirectUrl,
                code_verifier: this.grant.verifier!,
              }
            : { grant_type: "refresh_token", refresh_token: refresh! }),
        }).toString(),
      },
    );
    if (
      data.error ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.access_token.length > 8192 ||
      !Number.isFinite(Number(data.expires_in)) ||
      Number(data.expires_in) <= 0
    )
      throw failed();
    if (
      data.refresh_token !== undefined &&
      (typeof data.refresh_token !== "string" ||
        !data.refresh_token ||
        data.refresh_token.length > 8192)
    )
      throw failed();
    this.grant.tokens = {
      access_token: data.access_token,
      token_type: "Bearer",
      expires_in: Number(data.expires_in),
      refresh_token: data.refresh_token ?? refresh,
    };
    this.grant.zoho = {
      ...this.grant.zoho,
      tokenExpiresAt: Date.now() + Number(data.expires_in) * 1000,
    };
  }
  private async api(path: string, hints = this.grant.zoho) {
    if (
      !this.grant.tokens ||
      (this.grant.zoho?.tokenExpiresAt ?? 0) < Date.now() + 30_000
    )
      await (this.refreshing ??= this.exchange().finally(() => {
        this.refreshing = undefined;
      }));
    const headers: Record<string, string> = {
      authorization: `Zoho-oauthtoken ${this.grant.tokens!.access_token}`,
    };
    if (hints?.lastChanged) headers.LastPassphraseChange = hints.lastChanged;
    if (hints?.created) headers.PassphraseCreated = hints.created;
    const body = await this.json(new URL(path, this.provider.url), { headers });
    if (body?.operation?.result?.status !== "Success") throw failed();
    return body.operation.Details ?? body.operation.details;
  }
  private async login() {
    const login = await this.api(
      "/api/json/login?OPERATION_NAME=GET_LOGIN",
      {},
    );
    if (!login || login.LOGIN !== "PBKDF2_AES")
      throw new Error(
        "Update your vault to PBKDF2 encryption in Zoho Vault before connecting it.",
      );
    if (
      typeof login.SALT !== "string" ||
      !login.SALT ||
      login.SALT.length > 1024 ||
      !Number.isSafeInteger(Number(login.ITERATION)) ||
      Number(login.ITERATION) < 1 ||
      Number(login.ITERATION) > 10_000_000 ||
      typeof login.PASSPHRASE !== "string"
    )
      throw failed();
    return login;
  }
  async parameters(): Promise<ZohoUnlockParameters> {
    const login = await this.login();
    return { salt: login.SALT, iterations: Number(login.ITERATION) };
  }
  async unlock(key: string) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
      throw new Error("Invalid vault unlock key");
    const login = await this.login();
    try {
      JSON.parse(await decryptZohoVaultField(login.PASSPHRASE, key));
    } catch {
      throw new Error(
        "Could not unlock Zoho Vault. Check your master password.",
      );
    }
    const hints = {
      lastChanged: String(login.LASTMODFIEDTIME ?? ""),
      created: String(login.CREATIONTIME ?? ""),
    };
    const keys = await this.api("/api/rest/json/v1/user/orgkey", hints);
    let orgKey: string | undefined;
    if (keys?.sharedKey) {
      try {
        const privateKey = await decryptZohoVaultField(keys.privateKey, key);
        if (keys.rsaKeyType === "RSA_4096") {
          const rsa = await crypto.subtle.importKey(
            "pkcs8",
            Uint8Array.from(atob(privateKey), (c) => c.charCodeAt(0)),
            { name: "RSA-OAEP", hash: "SHA-256" },
            false,
            ["decrypt"],
          );
          orgKey = new TextDecoder().decode(
            await crypto.subtle.decrypt(
              "RSA-OAEP",
              rsa,
              Uint8Array.from(atob(keys.sharedKey), (c) => c.charCodeAt(0)),
            ),
          );
        } else if (!keys.rsaKeyType || keys.rsaKeyType === "RSA_1024") {
          const parts = privateKey.split(",");
          if (parts.length !== 8 || parts.some((p) => !/^[a-f0-9]+$/i.test(p)))
            throw failed();
          const jwk: Record<string, string> = { kty: "RSA" };
          for (const [i, field] of [
            "n",
            "e",
            "d",
            "p",
            "q",
            "dp",
            "dq",
            "qi",
          ].entries()) {
            const hex = parts[i].replace(/^0+/, "") || "0";
            jwk[field] = Buffer.from(
              hex.length % 2 ? `0${hex}` : hex,
              "hex",
            ).toString("base64url");
          }
          // The legacy provider format is RSAES-PKCS1-v1_5 (hex ciphertext).
          // Decode a full RSA block locally; do not expose padding errors.
          if (
            typeof keys.sharedKey !== "string" ||
            !/^[a-f0-9]{1,256}$/i.test(keys.sharedKey)
          )
            throw failed();
          const block = privateDecrypt(
            {
              // Workerd's privateDecrypt accepts PEM, but rejects KeyObject.
              key: createPrivateKey({ key: jwk, format: "jwk" }).export({
                format: "pem",
                type: "pkcs8",
              }),
              padding: constants.RSA_NO_PADDING,
            },
            Buffer.from(keys.sharedKey.padStart(256, "0"), "hex"),
          );
          const end = block.indexOf(0, 2);
          if (block[0] !== 0 || block[1] !== 2 || end < 10) throw failed();
          orgKey = Buffer.from(block.subarray(end + 1)).toString("utf8");
        } else throw failed();
        if (!orgKey || orgKey.length > 4096) throw failed();
      } catch {
        throw new Error(
          "Could not unlock shared Zoho Vault logins. Check your vault sharing keys.",
        );
      }
    }
    this.grant.zoho = {
      ...this.grant.zoho,
      key,
      orgKey,
      lastChanged: String(login.LASTMODFIEDTIME ?? ""),
      created: String(login.CREATIONTIME ?? ""),
    };
  }
  private async entry(raw: Secret): Promise<ZohoEntry | undefined> {
    if (
      raw.istrashed === true ||
      raw.istrashed === "YES" ||
      raw.istrashed === "true" ||
      !/^[0-9]{1,40}$/.test(String(raw.secretid))
    )
      return;
    let name = raw.secretname;
    let urls: unknown[] = Array.isArray(raw.secretmultipleurl)
      ? raw.secretmultipleurl
      : [raw.secreturl];
    try {
      const key =
        raw.isshared === "YES" ? this.grant.zoho?.orgKey : this.grant.zoho?.key;
      if (raw.encsecretname)
        name = await decryptZohoVaultField(
          raw.encsecretname as string,
          key ?? "",
        );
      if (raw.encryptedurls) {
        if (!Array.isArray(raw.encryptedurls) || raw.encryptedurls.length > 50)
          return;
        urls = await Promise.all(
          raw.encryptedurls.map((value) =>
            decryptZohoVaultField(value, key ?? ""),
          ),
        );
      }
    } catch {
      return;
    }
    if (typeof name !== "string") return;
    for (const value of urls) {
      if (typeof value !== "string" || !value || value.length > 2048) continue;
      try {
        const url = new URL(value.includes("://") ? value : `https://${value}`);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !url.hostname.includes(".")
        )
          continue;
        const label = name.replace(/\p{C}/gu, "").trim().slice(0, 60);
        if (!label) continue;
        return {
          reference: `zohovault://${raw.secretid}/password`,
          label,
          website: url.hostname.toLowerCase().replace(/^www\./, ""),
        };
      } catch {
        /* Skip unsupported website metadata. */
      }
    }
  }
  async entries(page: number) {
    if (!this.grant.zoho?.key) throw new Error("Unlock your Zoho Vault first");
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
      throw new Error("Invalid vault page");
    const details = await this.api(
      `/api/rest/json/v1/secrets?isAsc=true&pageNum=${page - 1}&rowPerPage=50`,
    );
    if (!Array.isArray(details)) throw failed();
    // Project metadata only. Never return secretData, usernames, notes or provider errors.
    const projected = await Promise.all(
      details.map((raw) => (raw ? this.entry(raw) : undefined)),
    );
    return {
      entries: projected.filter((entry): entry is ZohoEntry => !!entry),
      nextPage: details.length === 50 ? page + 1 : undefined,
    };
  }
  private async secret(
    reference: string,
  ): Promise<{ raw: Secret; entry: ZohoEntry }> {
    if (!this.grant.zoho?.key) throw new Error("Unlock your Zoho Vault first");
    const details = await this.api(
      `/api/rest/json/v1/secrets/${secretId(reference)}`,
    );
    const raw =
      Array.isArray(details) && details.length === 1 ? details[0] : details;
    if (!raw || String(raw.secretid) !== secretId(reference)) throw failed();
    const entry = await this.entry(raw);
    if (!entry) throw failed();
    return { raw, entry };
  }
  async select(reference: string) {
    return (await this.secret(reference)).entry;
  }
  async resolve(reference: string, website?: string) {
    const { raw, entry } = await this.secret(reference);
    if (!website || entry.website !== website)
      throw new Error("That saved login belongs to a different website");
    try {
      const fields =
        typeof raw.secretData === "string"
          ? JSON.parse(raw.secretData)
          : raw.secretData;
      const key =
        raw.isshared === "YES" ? this.grant.zoho?.orgKey : this.grant.zoho?.key;
      if (!key) throw failed();
      const password = await decryptZohoVaultField(fields.password, key);
      const username = await decryptZohoVaultField(fields.username, key);
      if (
        !password ||
        password.length > 2048 ||
        !username ||
        username.length > 2048 ||
        /\p{C}/u.test(username)
      )
        throw failed();
      return { password, username };
    } catch {
      throw failed();
    }
  }
}
