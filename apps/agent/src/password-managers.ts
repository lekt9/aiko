/** Account-scoped password manager bindings for the connect mini app.
 * OAuth grants are sealed at rest with AES-256-GCM and never reach the model;
 * the mini app only ever sees metadata. Resolution happens only inside a
 * trusted native sign-in fill, never as a model tool. */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import {
  managerMcp,
  type ManagerGrant,
  type ManagerProvider,
} from "./password-manager-mcp.ts";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectorDomain } from "./connectors.ts";

/** Sealing key for password manager OAuth grants: base64 that decodes to exactly 32 bytes. */
export function parseManagerKey(value?: string) {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/=_-]{43,44}$/.test(value.trim()))
    throw new Error("AIKO_MANAGER_KEY must be a base64 32-byte key");
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32)
    throw new Error("AIKO_MANAGER_KEY must decode to exactly 32 bytes");
  return value.trim();
}

export const managerKinds = [
  "bitwarden",
  "remote-mcp",
  "onepassword",
  "onepassword-connect",
  "keeper",
  "hashicorp-vault",
  "doppler",
] as const;
export type ManagerKind = (typeof managerKinds)[number];

export type ManagerEntry = {
  reference: string;
  label: string;
  website?: string;
};
export type ManagerView = {
  id: string;
  kind: ManagerKind;
  name: string;
  entries: ManagerEntry[];
  createdAt: number;
  providerId?: string;
  status: "connected" | "authorization_required";
};
export type SealedToken = { v: 1; iv: string; data: string; tag: string };

export const validReference = (_kind: ManagerKind, reference: string) =>
  reference.length > 0 && reference.length <= 500 && !/\p{C}/u.test(reference);

const text = (value: unknown, max: number): string => {
  if (typeof value !== "string")
    throw new Error("Invalid password manager details");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /\p{C}/u.test(trimmed))
    throw new Error("Invalid password manager details");
  return trimmed;
};

export function parseManagerAdd(input: unknown): {
  kind: ManagerKind;
  name: string;
  providerId: string;
  entries: ManagerEntry[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid password manager details");
  const body = input as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== "string" || !managerKinds.includes(kind as ManagerKind))
    throw new Error("Unsupported password manager");
  if (
    Object.keys(body).some(
      (key) => !["kind", "name", "providerId", "entries"].includes(key),
    )
  )
    throw new Error(
      "Authorize a password manager connection; pasted tokens are no longer accepted",
    );
  const providerId = text(body.providerId, 100);
  if (typeof body.name !== "string" || !body.name.trim())
    throw new Error("Give the connection a name");
  const name = text(body.name, 60);
  if (
    !Array.isArray(body.entries) ||
    body.entries.length < 1 ||
    body.entries.length > 50
  )
    throw new Error("Add at least one saved login reference");
  const entries = body.entries.map((raw): ManagerEntry => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid password manager details");
    const entry = raw as Record<string, unknown>;
    const reference = text(entry.reference, 500);
    if (!validReference(kind as ManagerKind, reference))
      throw new Error("Enter a valid saved login reference");
    const label = text(entry.label, 60);
    if (entry.website === undefined || entry.website === "")
      return { reference, label };
    const website = connectorDomain(String(entry.website));
    return { reference, label, website };
  });
  const seen = new Set(entries.map((entry) => entry.reference));
  if (seen.size !== entries.length)
    throw new Error("Each reference can be saved once per manager");
  return { kind: kind as ManagerKind, name, providerId, entries };
}

export function aadFor(owner: string, id: string) {
  return `aiko-manager:v1:${createHash("sha256").update(owner).digest("hex")}:${id}`;
}

export function sealManagerToken(
  key: Buffer,
  owner: string,
  id: string,
  token: string,
): SealedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aadFor(owner, id)));
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: Buffer.from(iv).toString("base64"),
    data: Buffer.from(data).toString("base64"),
    tag: Buffer.from(cipher.getAuthTag()).toString("base64"),
  };
}

export function openManagerToken(
  key: Buffer,
  owner: string,
  id: string,
  sealed: SealedToken,
): string {
  if (
    sealed?.v !== 1 ||
    typeof sealed.iv !== "string" ||
    typeof sealed.data !== "string" ||
    typeof sealed.tag !== "string"
  )
    throw new Error("Saved password manager needs reconnection");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(sealed.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(aadFor(owner, id)));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Saved password manager needs reconnection");
  }
}

export interface ManagerHost {
  add(input: unknown): Promise<ManagerView & { authorizationUrl?: string }>;
  providers(): { id: string; name: string; kind: string }[];
  authorize(id: string): Promise<{ authorizationUrl?: string }>;
  finishAuthorization(
    id: string,
    state: string,
    code: string,
  ): Promise<ManagerView>;
  list(): Promise<ManagerView[]>;
  remove(id: string): Promise<void>;
  resolvePassword(
    managerId: string,
    reference: string,
    website?: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

type ManagerRecord = {
  id: string;
  owner: string;
  kind: ManagerKind;
  name: string;
  entries: ManagerEntry[];
  providerId?: string;
  /** Bind authorization to exact operator configuration, including tool and endpoints. */
  providerFingerprint?: string;
  status?: "connected" | "authorization_required";
  sealed?: SealedToken;
  createdAt: number;
  removedAt?: number;
};

export const MAX_MANAGERS_PER_OWNER = 8;

export class FilePasswordManagerHost implements ManagerHost {
  private prefix: string;
  constructor(
    private options: {
      store: {
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<void>;
        list(prefix: string): Promise<unknown[]>;
      };
      owner: string;
      key?: string;
      providers?: ManagerProvider[];
      fetch?: FetchLike;
    },
  ) {
    this.prefix = `connectors:${createHash("sha256").update(options.owner).digest("hex")}:manager:`;
  }
  private key() {
    const key = Buffer.from(this.options.key ?? "", "base64");
    if (key.length !== 32)
      throw new Error(
        "This host has no password manager sealing key configured",
      );
    return key;
  }
  providers() {
    return (this.options.providers ?? []).map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    }));
  }
  private provider(record: ManagerRecord) {
    const provider = this.options.providers?.find(
      (p) => p.id === record.providerId && p.kind === record.kind,
    );
    if (!provider || record.providerFingerprint !== this.fingerprint(provider))
      throw new Error(
        "Password manager configuration changed. Disconnect and connect it again.",
      );
    return provider;
  }
  private fingerprint(provider: ManagerProvider) {
    return createHash("sha256").update(JSON.stringify(provider)).digest("hex");
  }
  private async load(id: string): Promise<ManagerRecord> {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Password manager unavailable");
    const record = (await this.options.store.get(`${this.prefix}${id}`)) as
      ManagerRecord | undefined;
    if (
      !record ||
      record.owner !== this.options.owner ||
      record.id !== id ||
      record.removedAt
    )
      throw new Error("Password manager unavailable");
    return record;
  }
  private view(record: ManagerRecord): ManagerView {
    return {
      id: record.id,
      kind: record.kind,
      name: record.name,
      entries: record.entries.map(({ reference, label, website }) => ({
        reference,
        label,
        ...(website ? { website } : {}),
      })),
      createdAt: record.createdAt,
      providerId: record.providerId,
      status: record.providerId
        ? (record.status ?? "authorization_required")
        : "authorization_required",
    };
  }
  private grant(record: ManagerRecord): ManagerGrant {
    // Legacy service-token rows can be listed and removed, but never resolved.
    if (!record.providerId || !record.sealed)
      throw new Error("Reconnect your password manager using OAuth");
    return JSON.parse(
      openManagerToken(
        this.key(),
        this.options.owner,
        record.id,
        record.sealed,
      ),
    );
  }
  private async save(record: ManagerRecord, grant: ManagerGrant) {
    await this.load(record.id); // A disconnect during network I/O must not resurrect a grant.
    record.sealed = sealManagerToken(
      this.key(),
      this.options.owner,
      record.id,
      JSON.stringify(grant),
    );
    await this.options.store.set(`${this.prefix}${record.id}`, record);
  }
  async add(input: unknown) {
    const parsed = parseManagerAdd(input);
    const key = this.key();
    const provider = this.options.providers?.find(
      (p) => p.id === parsed.providerId && p.kind === parsed.kind,
    );
    if (!provider)
      throw new Error("Choose an available password manager connection");
    if ((await this.list()).length >= MAX_MANAGERS_PER_OWNER)
      throw new Error(
        "This account already has the maximum number of password managers",
      );
    const id = randomUUID();
    const record: ManagerRecord = {
      ...parsed,
      id,
      owner: this.options.owner,
      providerFingerprint: this.fingerprint(provider),
      status: "authorization_required",
      sealed: sealManagerToken(key, this.options.owner, id, "{}"),
      createdAt: Date.now(),
    };
    await this.options.store.set(`${this.prefix}${id}`, record);
    // A failed provider remains visible for retry/removal instead of orphaning a connection.
    const result = await this.authorize(id);
    return { ...this.view(await this.load(id)), ...result };
  }
  async authorize(id: string) {
    const record = await this.load(id);
    const provider = this.provider(record);
    const grant = this.grant(record);
    delete grant.tokens;
    grant.state = Buffer.from(randomBytes(32)).toString("base64url");
    grant.expiresAt = Date.now() + 10 * 60_000;
    record.status = "authorization_required";
    try {
      const result = await managerMcp(provider, grant, {}, this.options.fetch);
      if (!result.authorizationUrl) record.status = "connected";
      return result;
    } finally {
      await this.save(record, grant);
    }
  }
  async finishAuthorization(id: string, state: string, code: string) {
    const record = await this.load(id);
    const provider = this.provider(record);
    const grant = this.grant(record);
    if (
      !state ||
      state !== grant.state ||
      !grant.expiresAt ||
      grant.expiresAt < Date.now() ||
      !grant.verifier ||
      typeof code !== "string" ||
      !code ||
      code.length > 4096 ||
      /\p{C}/u.test(code)
    )
      throw new Error(
        "Authorization expired or invalid. Reconnect your password manager.",
      );
    // Consume state durably before exchanging a one-use authorization code.
    delete grant.state;
    delete grant.expiresAt;
    await this.save(record, grant);
    try {
      await managerMcp(provider, grant, { code }, this.options.fetch);
      record.status = "connected";
      return this.view(record);
    } finally {
      delete grant.verifier;
      await this.save(record, grant);
    }
  }
  async list() {
    const views: ManagerView[] = [];
    for (const raw of await this.options.store.list(this.prefix)) {
      const record = raw as ManagerRecord;
      if (record?.owner === this.options.owner && !record.removedAt)
        views.push(this.view(record));
    }
    return views.sort((a, b) => a.createdAt - b.createdAt);
  }
  async remove(id: string) {
    const record = await this.load(id);
    record.removedAt = Date.now();
    delete record.sealed;
    await this.options.store.set(`${this.prefix}${id}`, record);
  }
  async resolvePassword(
    managerId: string,
    reference: string,
    website?: string,
    signal?: AbortSignal,
  ) {
    const record = await this.load(managerId);
    const entry = record.entries.find((entry) => entry.reference === reference);
    if (!entry)
      throw new Error("That saved login is not part of this password manager");
    if (
      entry.website &&
      (!website || connectorDomain(website) !== entry.website)
    )
      throw new Error("That saved login belongs to a different website");
    if (record.status !== "connected")
      throw new Error("Reconnect your password manager using OAuth");
    const provider = this.provider(record);
    const grant = this.grant(record);
    try {
      const result = await managerMcp(
        provider,
        grant,
        { reference, signal },
        this.options.fetch,
      );
      await this.load(managerId);
      if (!result.password)
        throw new Error("Password manager did not resolve this reference");
      return result.password;
    } finally {
      await this.save(record, grant);
    }
  }
}
