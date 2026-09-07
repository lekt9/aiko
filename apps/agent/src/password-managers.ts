/** Account-scoped password manager bindings for the connect mini app.
 * Provider tokens are sealed at rest with AES-256-GCM and never leave the host;
 * the mini app only ever sees metadata. Resolution happens only inside a
 * trusted native sign-in fill, never as a model tool. */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import { connectorDomain } from "./connectors.ts";

/** Sealing key for password manager tokens: base64 that decodes to exactly 32 bytes. */
export function parseManagerKey(value?: string) {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/=_-]{43,44}$/.test(value.trim()))
    throw new Error("AIKO_MANAGER_KEY must be a base64 32-byte key");
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32)
    throw new Error("AIKO_MANAGER_KEY must decode to exactly 32 bytes");
  return value.trim();
}

/** HashiCorp Vault cluster address: origin-only HTTPS, optional namespace. */
/** Origin-only HTTPS base URL for operator-hosted infrastructure (no credentials in the URL). */
function originOnlyHttps(value: string | undefined, envName: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw new Error(`${envName} must be an origin-only HTTPS address`);
  return value.replace(/\/+$/, "");
}

export function parseVaultAddress(address?: string, namespace?: string) {
  if (!address) {
    if (namespace)
      throw new Error("AIKO_HASHICORP_VAULT_NAMESPACE requires an address");
    return undefined;
  }
  const url = originOnlyHttps(address, "AIKO_HASHICORP_VAULT_ADDRESS");
  if (namespace && (namespace.length > 200 || /\p{C}/u.test(namespace)))
    throw new Error("Invalid AIKO_HASHICORP_VAULT_NAMESPACE");
  return { address: url!, ...(namespace ? { namespace } : {}) };
}

/** 1Password Connect server base URL (operator configuration). */
export function parseConnectUrl(value?: string) {
  return originOnlyHttps(value, "AIKO_ONEPASSWORD_CONNECT_URL");
}

export const managerKinds = [
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
};
export type SealedToken = { v: 1; iv: string; data: string; tag: string };

export const MANAGER_KIND_HELP: Record<ManagerKind, string> = {
  onepassword:
    "1Password service account token; references like op://Vault/Item/password",
  "onepassword-connect":
    "1Password Connect credentials token; resolves through the operator's Connect server",
  keeper:
    "Keeper Secrets Manager one-line config; references like keeper://RECORD_UID/field/password",
  "hashicorp-vault":
    "Vault service token; references like vault://secret/data/app/token#value",
  doppler: "Doppler service token; references like doppler://API_KEY",
};

const referencePatterns: Record<ManagerKind, RegExp> = {
  onepassword: /^op:\/\/[^/?#]+\/[^/?#]+(?:\/[^/?#]+)?\/[^/?#]+$/,
  "onepassword-connect": /^op:\/\/[^/?#]+\/[^/?#]+(?:\/[^/?#]+)?\/[^/?#]+$/,
  keeper:
    /^keeper:\/\/[A-Za-z0-9_-]{22}\/(?:field|custom_field)\/[A-Za-z0-9_.-]+$/,
  "hashicorp-vault":
    /^vault:\/\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+#[A-Za-z0-9_.-]+$/,
  doppler: /^doppler:\/\/[A-Za-z0-9_.-]+$/,
};

export const validReference = (kind: ManagerKind, reference: string) =>
  reference.length <= 500 &&
  !/\p{C}/u.test(reference) &&
  referencePatterns[kind].test(reference) &&
  !reference
    .split(/[#/]/)
    .some((segment) => segment === "." || segment === "..");

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
  token: string;
  entries: ManagerEntry[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid password manager details");
  const body = input as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== "string" || !managerKinds.includes(kind as ManagerKind))
    throw new Error("Unsupported password manager");
  const token = text(body.token, 16384);
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
      throw new Error(
        `That reference does not match ${kind}. ${MANAGER_KIND_HELP[kind as ManagerKind]}`,
      );
    const label = text(entry.label, 60);
    if (entry.website === undefined || entry.website === "")
      return { reference, label };
    const website = connectorDomain(String(entry.website));
    return { reference, label, website };
  });
  const seen = new Set(entries.map((entry) => entry.reference));
  if (seen.size !== entries.length)
    throw new Error("Each reference can be saved once per manager");
  return { kind: kind as ManagerKind, name, token, entries };
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

export type ManagerResolvers = Record<
  ManagerKind,
  (token: string, reference: string) => Promise<string>
>;

export interface ManagerHost {
  add(input: unknown): Promise<ManagerView>;
  list(): Promise<ManagerView[]>;
  remove(id: string): Promise<void>;
  resolvePassword(managerId: string, reference: string): Promise<string>;
}

type ManagerRecord = {
  id: string;
  owner: string;
  kind: ManagerKind;
  name: string;
  entries: ManagerEntry[];
  sealed: SealedToken;
  createdAt: number;
  removedAt?: number;
};

export const MAX_MANAGERS_PER_OWNER = 8;

/** Owner-bound host over the connector store. Tokens are sealed with an
 * AES-256-GCM host key (AIKO_MANAGER_KEY); without it, adding fails closed. */
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
      vault?: { address?: string; namespace?: string };
      onePasswordConnectUrl?: string;
      /** Runtime-provided resolvers that win over the defaults for their kind (used where the SDK cannot run). */
      sandboxResolvers?: Partial<ManagerResolvers>;
      resolvers?: ManagerResolvers;
    },
  ) {
    this.prefix = `connectors:${createHash("sha256").update(options.owner).digest("hex")}:manager:`;
  }
  private key() {
    if (!this.options.key)
      throw new Error(
        "This host has no password manager sealing key configured",
      );
    const key = Buffer.from(this.options.key, "base64");
    if (key.length !== 32)
      throw new Error(
        "This host has no password manager sealing key configured",
      );
    return key;
  }
  private resolvers() {
    return {
      ...defaultResolvers(
        this.options.vault?.address,
        this.options.vault?.namespace,
        this.options.onePasswordConnectUrl,
      ),
      ...this.options.sandboxResolvers,
      ...this.options.resolvers,
    };
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
    };
  }
  async add(input: unknown) {
    const parsed = parseManagerAdd(input);
    const key = this.key();
    const existing = (await this.list()).length;
    if (existing >= MAX_MANAGERS_PER_OWNER)
      throw new Error(
        "This account already has the maximum number of password managers",
      );
    const id = randomUUID();
    const record: ManagerRecord = {
      id,
      owner: this.options.owner,
      kind: parsed.kind,
      name: parsed.name,
      entries: parsed.entries,
      sealed: sealManagerToken(key, this.options.owner, id, parsed.token),
      createdAt: Date.now(),
    };
    await this.options.store.set(`${this.prefix}${id}`, record);
    return this.view(record);
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
    // Tombstoned so an in-flight fill fails closed instead of silently reusing a removed credential.
    await this.options.store.set(`${this.prefix}${id}`, record);
  }
  async resolvePassword(managerId: string, reference: string) {
    const record = await this.load(managerId);
    if (!record.entries.some((entry) => entry.reference === reference))
      throw new Error("That saved login is not part of this password manager");
    const token = openManagerToken(
      this.key(),
      this.options.owner,
      record.id,
      record.sealed,
    );
    return await this.resolvers()[record.kind](token, reference);
  }
}

const providerError = (kind: ManagerKind) =>
  new Error(
    `Could not reach ${kind}. Check the saved credential and try again.`,
  );

/** Default resolvers. Official SDKs load lazily so module import never pulls them. */
export function defaultResolvers(
  vaultAddress?: string,
  vaultNamespace?: string,
  onePasswordConnectUrl?: string,
): ManagerResolvers {
  return {
    async onepassword(token, reference) {
      try {
        // Computed specifier: the 1Password SDK needs the local desktop app,
        // so it must stay out of the workerd bundle and fail closed there.
        const onePasswordModule = ["@1password", "sdk"].join("/");
        const { createClient } = await import(onePasswordModule);
        const client = await createClient({
          auth: token,
          integrationName: "Aiko",
          integrationVersion: "0.2.0",
        });
        return await client.secrets.resolve(reference);
      } catch {
        throw providerError("onepassword");
      }
    },
    async keeper(token, reference) {
      try {
        const { getValue, getSecrets, inMemoryStorage, initialize } =
          await import("@keeper-security/secrets-manager-core");
        initialize();
        const oneLine = !token.trim().startsWith("{")
          ? token.trim().slice(token.trim().indexOf(":") + 1)
          : token.trim();
        const config = JSON.parse(
          Buffer.from(oneLine, "base64").toString("utf8"),
        ) as { clientId?: string };
        if (typeof config.clientId !== "string" || !config.clientId)
          throw new Error();
        const secrets = await getSecrets({ storage: inMemoryStorage(config) }, [
          reference.slice("keeper://".length).split("/", 1)[0]!,
        ]);
        const value = getValue(secrets, reference);
        if (typeof value !== "string" || !value) throw new Error();
        return value;
      } catch {
        throw providerError("keeper");
      }
    },
    async "hashicorp-vault"(token, reference) {
      if (!vaultAddress)
        throw new Error("This host has no Vault cluster configured");
      const match = reference.match(
        /^vault:\/\/([A-Za-z0-9_-]+)((?:\/[A-Za-z0-9_.-]+)+)#([A-Za-z0-9_.-]+)$/,
      );
      if (
        !match ||
        match[2]!
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      )
        throw providerError("hashicorp-vault");
      try {
        const url = new URL(
          `${new URL(vaultAddress).origin}/v1/${match[1]}/data${match[2]}`,
        );
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Vault-Token": token,
            ...(vaultNamespace ? { "X-Vault-Namespace": vaultNamespace } : {}),
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error();
        const body = (await response.json()) as {
          data?: { data?: Record<string, unknown> };
        };
        const value = body.data?.data?.[match[3]!];
        if (typeof value !== "string" || !value) throw new Error();
        return value;
      } catch {
        throw providerError("hashicorp-vault");
      }
    },
    async "onepassword-connect"(token, reference) {
      const match = reference.match(
        /^op:\/\/([^/?#]+)\/([^/?#]+)(?:\/[^/?#]+)?\/([^/?#]+)$/,
      );
      if (!match) throw providerError("onepassword-connect");
      try {
        if (!onePasswordConnectUrl) throw new Error();
        const base = onePasswordConnectUrl.replace(/\/+$/, "");
        const headers = {
          Authorization: `Token ${token}`,
          Accept: "application/json",
        };
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const getJson = async <T>(path: string): Promise<T> => {
          const response = await fetch(base + path, {
            headers,
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error();
          return (await response.json()) as T;
        };
        let vaultId = match[1]!;
        if (!uuid.test(vaultId)) {
          const filter = encodeURIComponent(
            `name eq "${vaultId.replace(/"/g, '\\"')}"`,
          );
          const vaults = await getJson<Array<{ id?: string; name?: string }>>(
            `/v1/vaults?filter=${filter}`,
          );
          vaultId =
            vaults.find((v) => v.name?.toLowerCase() === vaultId.toLowerCase())
              ?.id ?? "";
          if (!vaultId) throw new Error();
        }
        let itemId = match[2]!;
        if (!uuid.test(itemId)) {
          const filter = encodeURIComponent(
            `title eq "${itemId.replace(/"/g, '\\"')}"`,
          );
          const items = await getJson<Array<{ id?: string; title?: string }>>(
            `/v1/vaults/${vaultId}/items?filter=${filter}`,
          );
          itemId =
            items.find((i) => i.title?.toLowerCase() === itemId.toLowerCase())
              ?.id ?? "";
          if (!itemId) throw new Error();
        }
        const item = await getJson<{
          fields?: Array<{ label?: string; id?: string; value?: unknown }>;
        }>(`/v1/vaults/${vaultId}/items/${itemId}`);
        const field = (item.fields ?? []).find(
          (f) => f.label === match[3] || f.id === match[3],
        );
        const value = field?.value;
        if (typeof value !== "string" || !value) throw new Error();
        return value;
      } catch {
        throw providerError("onepassword-connect");
      }
    },
    async doppler(token, reference) {
      const match = reference.match(/^doppler:\/\/([A-Za-z0-9_.-]+)$/);
      if (!match) throw providerError("doppler");
      try {
        const url = new URL(
          "https://api.doppler.com/v3/configs/config/secrets",
        );
        url.searchParams.set("name", match[1]!);
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error();
        const body = (await response.json()) as {
          secrets?: Record<string, { computed?: unknown }>;
        };
        const secrets = body.secrets ?? {};
        const entry =
          secrets[match[1]!] ??
          Object.entries(secrets).find(
            ([key]) => key.toLowerCase() === match[1]!.toLowerCase(),
          )?.[1];
        const value = entry?.computed;
        if (typeof value !== "string" || !value) throw new Error();
        return value;
      } catch {
        throw providerError("doppler");
      }
    },
  };
}
