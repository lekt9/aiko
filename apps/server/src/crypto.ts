import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
export const randomToken = () =>
  Buffer.from(randomBytes(32)).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export type Ciphertext = { iv: string; tag: string; data: string };
export interface WrappedKey {
  provider: string;
  keyId: string;
  data: string;
}
export interface KeyWrapper {
  wrap(key: Uint8Array, context: string): Promise<WrappedKey>;
  unwrap(key: WrappedKey, context: string): Promise<Uint8Array>;
}
export interface Envelope extends Ciphertext {
  v: 1;
  key: WrappedKey;
}
export function encrypt(
  key: Uint8Array,
  data: Uint8Array,
  context: string,
): Ciphertext {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  return {
    iv: Buffer.from(iv).toString("base64"),
    data: Buffer.concat([cipher.update(data), cipher.final()]).toString(
      "base64",
    ),
    tag: Buffer.from(cipher.getAuthTag()).toString("base64"),
  };
}
export function decrypt(key: Uint8Array, value: Ciphertext, context: string): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.data, "base64")),
    decipher.final(),
  ]);
}
export class LocalKeyring implements KeyWrapper {
  constructor(
    private active: string,
    private keys: Record<string, string>,
  ) {
    if (
      !active ||
      !keys[active] ||
      Object.values(keys).some(
        (key) => Buffer.from(key, "base64").length !== 32,
      )
    )
      throw new Error("Invalid keyring");
  }
  async wrap(key: Uint8Array, context: string): Promise<WrappedKey> {
    return {
      provider: "local",
      keyId: this.active,
      data: JSON.stringify(
        encrypt(
          Buffer.from(this.keys[this.active], "base64"),
          key,
          `dek:${context}`,
        ),
      ),
    };
  }
  async unwrap(key: WrappedKey, context: string) {
    if (key.provider !== "local" || !Object.hasOwn(this.keys, key.keyId))
      throw new Error("Unknown encryption key");
    return decrypt(
      Buffer.from(this.keys[key.keyId], "base64"),
      JSON.parse(key.data) as Ciphertext,
      `dek:${context}`,
    );
  }
}
export class KmsKeyWrapper implements KeyWrapper {
  constructor(
    private client: Pick<KMSClient, "send">,
    private keyId: string,
  ) {}
  async wrap(key: Uint8Array, context: string): Promise<WrappedKey> {
    const response = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: key,
        EncryptionContext: { unlock: context },
      }),
    );
    if (!response.CiphertextBlob || !response.KeyId)
      throw new Error("Key wrapping unavailable");
    return {
      provider: "aws-kms",
      keyId: response.KeyId,
      data: Buffer.from(response.CiphertextBlob).toString("base64"),
    };
  }
  async unwrap(key: WrappedKey, context: string) {
    if (key.provider !== "aws-kms") throw new Error("Unknown encryption key");
    const response = await this.client.send(
      new DecryptCommand({
        KeyId: key.keyId,
        CiphertextBlob: Buffer.from(key.data, "base64"),
        EncryptionContext: { unlock: context },
      }),
    );
    if (!response.Plaintext) throw new Error("Key unwrapping unavailable");
    return response.Plaintext;
  }
}
export class VaultCipher {
  constructor(private keys: KeyWrapper) {}
  async seal(context: string, value: unknown): Promise<Envelope> {
    const key = randomBytes(32),
      data = Buffer.from(JSON.stringify(value));
    try {
      return {
        v: 1,
        ...encrypt(key, data, context),
        key: await this.keys.wrap(key, context),
      };
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }
  async open<T>(context: string, value: Envelope): Promise<T> {
    if (value.v !== 1) throw new Error("Unsupported encrypted record");
    const key = await this.keys.unwrap(value.key, context);
    let data: Buffer | undefined;
    try {
      data = decrypt(key, value, context);
      return JSON.parse(new TextDecoder().decode(data)) as T;
    } finally {
      key.fill(0);
      data?.fill(0);
    }
  }
  async rewrap(context: string, value: Envelope): Promise<Envelope> {
    const key = await this.keys.unwrap(value.key, context);
    try {
      const checked = decrypt(key, value, context);
      checked.fill(0);
      return { ...value, key: await this.keys.wrap(key, context) };
    } finally {
      key.fill(0);
    }
  }
}
