import { mkdir, open, readdir, rename, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, connectorRecords } from "./db.ts";
import type { ConnectorStore } from "./connectors.ts";

const CONNECTOR_KEY =
  /^connectors:[a-f0-9]{64}:(?:connection|capability|manager|login-progress|integration):[a-f0-9-]+$/;
const CONNECTOR_PREFIX =
  /^connectors:[a-f0-9]{64}:(?:connection|capability|manager|login-progress|integration):$/;

/** Host-private durable records. Never put this directory under a static web root or share it with untrusted processes. */
export class FileConnectorStore implements ConnectorStore {
  private directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error("Connector store requires a private directory");
  }
  private name(key: string) {
    if (!CONNECTOR_KEY.test(key)) throw new Error("Invalid connector storage key");
    return `${key}.json`;
  }
  async get(key: string): Promise<unknown> {
    await this.ready();
    let file;
    try {
      file = await open(
        join(this.directory, this.name(key)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 128000 || stat.mode & 0o077)
        throw new Error("Unsafe connector record");
      return JSON.parse(await file.readFile("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Connector storage read failed");
    } finally {
      await file?.close();
    }
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.ready();
    const name = this.name(key);
    const content = JSON.stringify(value);
    if (content.length > 128000) throw new Error("Connector record too large");
    const temp = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(this.directory, name));
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async list(prefix: string): Promise<unknown[]> {
    if (!CONNECTOR_PREFIX.test(prefix))
      throw new Error("Invalid connector storage prefix");
    await this.ready();
    const result: unknown[] = [];
    for (const name of await readdir(this.directory)) {
      if (name.startsWith(prefix) && name.endsWith(".json"))
        result.push(await this.get(name.slice(0, -5)));
    }
    return result;
  }
}

/** Host-private durable records on the shared Postgres (Supabase) pooler. */
export class PostgresConnectorStore implements ConnectorStore {
  private async row(key: string) {
    if (!CONNECTOR_KEY.test(key)) throw new Error("Invalid connector storage key");
    const [record] = await db()
      .select({ value: connectorRecords.value })
      .from(connectorRecords)
      .where(eq(connectorRecords.key, key))
      .limit(1);
    return record;
  }
  async get(key: string): Promise<unknown> {
    return (await this.row(key))?.value;
  }
  async set(key: string, value: unknown): Promise<void> {
    if (!CONNECTOR_KEY.test(key)) throw new Error("Invalid connector storage key");
    const content = JSON.stringify(value);
    if (content.length > 128000) throw new Error("Connector record too large");
    const parsed = JSON.parse(content) as unknown;
    await db()
      .insert(connectorRecords)
      .values({ key, value: parsed, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: connectorRecords.key,
        set: { value: parsed, updatedAt: Date.now() },
      });
  }
  async list(prefix: string): Promise<unknown[]> {
    if (!CONNECTOR_PREFIX.test(prefix))
      throw new Error("Invalid connector storage prefix");
    const rows = await db()
      .select({ value: connectorRecords.value })
      .from(connectorRecords)
      .where(like(connectorRecords.key, `${prefix}%`));
    return rows.map((row) => row.value);
  }
}
