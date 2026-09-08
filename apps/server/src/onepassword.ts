import {
  decrypt,
  digest,
  encrypt,
  type Ciphertext,
  type KeyWrapper,
  type WrappedKey,
} from "./crypto.js";

/**
 * 1Password-backed root of trust. The data-encryption keys of envelopes are
 * themselves encrypted (wrapped) with a 256-bit key that lives as a field
 * inside a 1Password item, fetched from a 1Password Connect server (or the
 * service-account API, which shares the path shape). 1Password never sees
 * envelope contexts; per-context binding stays enforced locally by the
 * AES-256-GCM AAD in VaultCipher, exactly like the local keyring.
 *
 * Fail-closed rules: HTTPS-only origin (loopback HTTP only when the operator
 * explicitly enables local development), no redirects, bounded responses,
 * strictly shaped `op://` references, and exactly 32 bytes of key material.
 */
export const ONE_PASSWORD_REF =
  /^op:\/\/([^/\s]{1,128})\/([^/\s]{1,128})\/([^/\s]{1,128})$/u;

const MAX_ITEM_BYTES = 262_144;

export interface OnePasswordOptions {
  origin: string;
  token: string;
  /** `op://<vault>/<item>/<field>` — vault and item may be UUIDs or Connect-resolvable names. */
  secretRef: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  localDevelopment?: boolean;
}

type ConnectField = { id?: unknown; label?: unknown; value?: unknown };
type ConnectItem = { fields?: unknown };

const loopback = (origin: string) =>
  ["127.0.0.1", "[::1]", "localhost"].includes(new URL(origin).hostname);

export class OnePasswordKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly origin: string;
  private readonly token: string;
  private readonly vault: string;
  private readonly item: string;
  private readonly field: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private cached?: { key: Buffer; at: number };

  constructor(
    options: OnePasswordOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(options.origin);
    if (
      url.origin !== options.origin ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(options.localDevelopment === true && url.protocol === "http:" && loopback(options.origin)))
    )
      throw new Error("Invalid 1Password origin");
    if (options.token.length < 20 || options.token.length > 200 || /[\s\p{C}]/u.test(options.token))
      throw new Error("Invalid 1Password token");
    const parts = ONE_PASSWORD_REF.exec(options.secretRef);
    if (!parts) throw new Error("Invalid 1Password secret reference");
    this.origin = options.origin;
    this.token = options.token;
    this.vault = decodeURIComponent(parts[1]);
    this.item = decodeURIComponent(parts[2]);
    this.field = decodeURIComponent(parts[3]);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.keyId = digest(`1password-connect:${options.secretRef}`);
  }

  private async itemField(signal: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(
      `${this.origin}/v1/vaults/${encodeURIComponent(this.vault)}/items/${encodeURIComponent(this.item)}`,
      {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      },
    );
    if (!response.ok) throw new Error("1Password item unavailable");
    const text = await response.text();
    if (text.length > MAX_ITEM_BYTES) throw new Error("1Password item too large");
    let item: ConnectItem;
    try {
      item = JSON.parse(text) as ConnectItem;
    } catch {
      throw new Error("1Password item malformed");
    }
    if (!Array.isArray(item.fields)) throw new Error("1Password item malformed");
    const match = item.fields.find(
      (f) =>
        !!f &&
        typeof f === "object" &&
        (f.id === this.field || f.label === this.field) &&
        typeof f.value === "string" &&
        f.value.length > 0,
    ) as ConnectField | undefined;
    if (!match || typeof match.value !== "string") throw new Error("1Password key field missing");
    return match.value;
  }

  /** Fresh 32-byte key material; the previous cache buffer is zeroed on refresh. */
  private async key(signal: AbortSignal): Promise<Buffer> {
    if (this.cached && (this.cacheTtlMs === 0 || Date.now() - this.cached.at < this.cacheTtlMs))
      return this.cached.key;
    const raw = (await this.itemField(signal)).trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
      key.fill(0);
      throw new Error("1Password key material must be 32 bytes");
    }
    const previous = this.cached;
    this.cached = { key, at: Date.now() };
    previous?.key.fill(0);
    return key;
  }

  async wrap(key: Uint8Array, context: string): Promise<WrappedKey> {
    const kek = await this.key(AbortSignal.timeout(this.timeoutMs));
    return {
      provider: "1password-connect",
      keyId: this.keyId,
      data: JSON.stringify(encrypt(kek, key, `dek:${context}`) satisfies Ciphertext),
    };
  }

  async unwrap(key: WrappedKey, context: string): Promise<Uint8Array> {
    if (key.provider !== "1password-connect" || key.keyId !== this.keyId)
      throw new Error("Unknown encryption key");
    const kek = await this.key(AbortSignal.timeout(this.timeoutMs));
    return decrypt(kek, JSON.parse(key.data) as Ciphertext, `dek:${context}`);
  }
}
