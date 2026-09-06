/** Node-only private OAuth storage; never expose store methods as tools. */
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { UnlockError } from "./transport.js";
export interface OAuthState {
  binding?: string;
  pending?: {
    state: string;
    nonce: string;
    verifier: string;
    expiresAt: number;
  };
  tokens?: { accessToken: string; refreshToken?: string; expiresAt: number };
  refreshInFlight?: boolean;
}
export interface TokenStore {
  withLock<T>(
    fn: (
      state: OAuthState,
      save: (next: OAuthState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}
export class MemoryTokenStore implements TokenStore {
  private state: OAuthState = {};
  private tail: Promise<unknown> = Promise.resolve();
  withLock<T>(
    fn: (
      state: OAuthState,
      save: (next: OAuthState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const work = () =>
      fn(structuredClone(this.state), async (next) => {
        this.state = structuredClone(next);
      });
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
/** Encrypted, fsynced atomic replacement; exclusive process lock spans refresh. Stale locks fail closed. */
export class EncryptedFileTokenStore implements TokenStore {
  private key: Buffer;
  constructor(
    private path: string,
    key: Uint8Array,
  ) {
    if (key.byteLength !== 32)
      throw new TypeError(
        "A separately protected 32-byte storage key is required",
      );
    this.key = Buffer.from(key);
  }
  private fault() {
    return new UnlockError(
      "TOKEN_STORAGE",
      0,
      "Private OAuth storage is unavailable. Check permissions, key and lock state.",
    );
  }
  async withLock<T>(
    fn: (
      state: OAuthState,
      save: (next: OAuthState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await stat(directory);
    if (dir.mode & 0o077) throw this.fault();
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const until = Date.now() + 5000;
    while (!lock) {
      try {
        lock = await open(
          this.path + ".lock",
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          Date.now() >= until
        )
          throw this.fault();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      let state: OAuthState = {};
      try {
        const file = await open(
          this.path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if ((await file.stat()).mode & 0o077) throw this.fault();
          const bytes = await file.readFile();
          if (bytes.length > 131072) throw this.fault();
          const iv = bytes.subarray(0, 12),
            tag = bytes.subarray(12, 28),
            ciphertext = bytes.subarray(28),
            decipher = createDecipheriv("aes-256-gcm", this.key, iv);
          decipher.setAAD(Buffer.from("unlock:oauth:v1"));
          decipher.setAuthTag(tag);
          const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]);
          try {
            state = JSON.parse(plaintext.toString("utf8"));
          } finally {
            plaintext.fill(0);
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw this.fault();
      }
      const save = async (next: OAuthState) => {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from("unlock:oauth:v1"));
        const plaintext = Buffer.from(JSON.stringify(next));
        let encrypted: Buffer;
        try {
          encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        } finally {
          plaintext.fill(0);
        }
        const temporary = this.path + "." + randomUUID() + ".tmp";
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(
              Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
            );
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, this.path);
          const parent = await open(directory, "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } catch {
          await unlink(temporary).catch(() => {});
          throw this.fault();
        }
      };
      return await fn(state, save);
    } finally {
      await lock.close();
      await unlink(this.path + ".lock");
    }
  }
}
