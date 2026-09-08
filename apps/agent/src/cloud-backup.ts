import { createHash } from "node:crypto";

export const BACKUP_CHUNK_BYTES = 192 * 1024;
export type BackupFile = { path: string; bytes: number; sha256: string };
export type BackupManifest = {
  version: 1;
  owner: string;
  id: string;
  at: number;
  files: BackupFile[];
};
export interface BackupBucket {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
}
export interface BackupSource {
  files: BackupFile[];
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  validate?(): Promise<void>;
}
export interface BackupSink {
  write(path: string, offset: number, bytes: Uint8Array): Promise<void>;
  commit(manifest: BackupManifest): Promise<void>;
  abort(): Promise<void>;
}
const hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw Error("Invalid backup identity");
  return value;
};
export function validateBackupFiles(files: BackupFile[]) {
  if (!Array.isArray(files) || !files.length || files.length > 128)
    throw Error("Invalid backup inventory");
  const paths = new Set<string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.path) ||
      file.path.split("/").some((p) => p === "." || p === "..") ||
      file.path.length > 240 ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 4 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error("Invalid backup file");
    paths.add(file.path);
  }
}

/** R2 sees authenticated ciphertext only. The wrapping key lives in the
 * control-plane secret store and is never included in the backup itself. */
export class CloudBackups {
  private key: Promise<CryptoKey>;
  constructor(
    private bucket: BackupBucket,
    base64Key: string,
  ) {
    const bytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
    if (bytes.length !== 32) throw Error("A 256-bit backup key is required");
    this.key = crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    bytes.fill(0);
  }
  private prefix(owner: string, id: string) {
    return `aiko/${identity(owner)}/${identity(id)}`;
  }
  private async seal(context: string, bytes: Uint8Array) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(context),
        },
        await this.key,
        bytes as Uint8Array<ArrayBuffer>,
      ),
    );
    const result = new Uint8Array(iv.length + encrypted.length);
    result.set(iv);
    result.set(encrypted, iv.length);
    return result;
  }
  private async open(context: string, bytes: Uint8Array) {
    if (bytes.length < 28) throw Error("Invalid backup ciphertext");
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(0, 12),
          additionalData: new TextEncoder().encode(context),
        },
        await this.key,
        bytes.slice(12),
      ),
    );
  }
  private async readObject(key: string, maxBytes: number) {
    const object = await this.bucket.get(key);
    if (!object) throw Error("Backup object missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length > maxBytes) throw Error("Backup object too large");
    return this.open(key, bytes);
  }
  async save(owner: string, source: BackupSource): Promise<BackupManifest> {
    validateBackupFiles(source.files);
    const manifest: BackupManifest = {
      version: 1,
      owner: identity(owner),
      id: crypto.randomUUID(),
      at: Date.now(),
      files: structuredClone(source.files),
    };
    const prefix = this.prefix(owner, manifest.id),
      written: string[] = [];
    try {
      for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index]!,
          hash = createHash("sha256");
        for (
          let offset = 0;
          offset < file.bytes;
          offset += BACKUP_CHUNK_BYTES
        ) {
          const length = Math.min(BACKUP_CHUNK_BYTES, file.bytes - offset);
          const bytes = await source.read(file.path, offset, length);
          if (bytes.length !== length) throw Error("Backup source changed");
          hash.update(bytes);
          const name = `${prefix}/${index}/${offset}`;
          written.push(name);
          await this.bucket.put(name, await this.seal(name, bytes));
          // A receipt is not proof that the intended bytes were stored.
          const stored = await this.readObject(name, BACKUP_CHUNK_BYTES + 28);
          if (hex(stored) !== hex(bytes))
            throw Error("Backup readback mismatch");
        }
        if (hash.digest("hex") !== file.sha256)
          throw Error("Backup source integrity mismatch");
      }
      await source.validate?.();
      const name = `${prefix}/manifest`,
        bytes = new TextEncoder().encode(JSON.stringify(manifest));
      written.push(name);
      await this.bucket.put(name, await this.seal(name, bytes));
      if (hex(await this.readObject(name, 128_000)) !== hex(bytes))
        throw Error("Backup manifest readback mismatch");
      return manifest;
    } catch (error) {
      for (const name of written.reverse())
        await this.bucket.delete(name).catch(() => undefined);
      throw error;
    }
  }
  async manifest(owner: string, id: string): Promise<BackupManifest> {
    const value = JSON.parse(
      new TextDecoder().decode(
        await this.readObject(`${this.prefix(owner, id)}/manifest`, 128_000),
      ),
    ) as BackupManifest;
    if (
      value.version !== 1 ||
      value.owner !== owner ||
      value.id !== id ||
      !Number.isSafeInteger(value.at)
    )
      throw Error("Backup binding mismatch");
    validateBackupFiles(value.files);
    return value;
  }
  private async readVerifiedFile(
    manifest: BackupManifest,
    index: number,
    write: (offset: number, bytes: Uint8Array) => Promise<void>,
  ) {
    const file = manifest.files[index]!,
      hash = createHash("sha256");
    if (file.bytes === 0) await write(0, new Uint8Array());
    for (let offset = 0; offset < file.bytes; offset += BACKUP_CHUNK_BYTES) {
      const bytes = await this.readObject(
        `${this.prefix(manifest.owner, manifest.id)}/${index}/${offset}`,
        BACKUP_CHUNK_BYTES + 28,
      );
      if (bytes.length !== Math.min(BACKUP_CHUNK_BYTES, file.bytes - offset))
        throw Error("Backup chunk size mismatch");
      hash.update(bytes);
      await write(offset, bytes);
    }
    if (hash.digest("hex") !== file.sha256)
      throw Error("Backup file integrity mismatch");
  }
  /** Authenticated bounded read using the same encrypted manifest/chunks as restore. */
  async readFile(owner: string, id: string, path: string, maxBytes: number) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > 64 * 1024 * 1024
    )
      throw Error("Invalid backup read bound");
    const manifest = await this.manifest(owner, id),
      index = manifest.files.findIndex((file) => file.path === path);
    if (index < 0 || manifest.files[index]!.bytes > maxBytes)
      throw Error("Backup file unavailable or exceeds read bound");
    const bytes = new Uint8Array(manifest.files[index]!.bytes);
    await this.readVerifiedFile(manifest, index, async (offset, chunk) => {
      bytes.set(chunk, offset);
    });
    return { manifest, bytes };
  }
  async restore(
    owner: string,
    id: string,
    sink: BackupSink,
    expected?: BackupManifest,
  ) {
    try {
      const manifest = await this.manifest(owner, id);
      if (expected && JSON.stringify(manifest) !== JSON.stringify(expected))
        throw Error("Backup manifest changed after authorization");
      for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index]!;
        await this.readVerifiedFile(manifest, index, (offset, bytes) =>
          sink.write(file.path, offset, bytes),
        );
      }
      await sink.commit(manifest);
      return manifest;
    } catch (error) {
      await sink.abort().catch(() => undefined);
      throw error;
    }
  }
}
