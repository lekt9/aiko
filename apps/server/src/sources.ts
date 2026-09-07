import { createClient } from "@1password/sdk";
import {
  getValue,
  getSecrets,
  inMemoryStorage,
  initialize as initializeKeeper,
} from "@keeper-security/secrets-manager-core";
import { request } from "undici";
import { VaultError } from "./errors.js";

/**
 * A native password manager / secret store integration. Providers receive the
 * tenant-sealed service credential and one of the kind's validated references
 * (see @unlock/protocol sourceInput) and return the referenced secret string.
 * Failures collapse to SOURCE_UNAVAILABLE so provider internals never leak.
 */
export interface PasswordSource {
  resolve(token: string, reference: string): Promise<string>;
}

/**
 * Dispatches resolution by the source kind persisted in the vault database.
 * Kinds without a registered provider (for example a cluster address that is
 * not configured) fail closed with SOURCE_UNAVAILABLE.
 */
export class SourceRegistry {
  constructor(
    private readonly providers: Readonly<Record<string, PasswordSource>>,
  ) {}
  has(kind: string) {
    return !!this.providers[kind];
  }
  resolve(kind: string, token: string, reference: string): Promise<string> {
    const provider = this.providers[kind];
    if (!provider)
      return Promise.reject(new VaultError("SOURCE_UNAVAILABLE", 503));
    return provider.resolve(token, reference);
  }
}

/** 1Password service accounts through the official JavaScript SDK. */
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

/** Keeper Secrets Manager through the official JavaScript SDK. */
export class KeeperSource implements PasswordSource {
  private initialized = false;
  async resolve(token: string, reference: string) {
    try {
      if (!this.initialized) {
        initializeKeeper();
        this.initialized = true;
      }
      const storage = inMemoryStorage(keeperConfig(token));
      const uid = reference.slice("keeper://".length).split("/", 1)[0];
      const secrets = await getSecrets({ storage }, [uid]);
      const value = getValue(secrets, reference);
      if (typeof value !== "string" || !value)
        throw new VaultError("SOURCE_UNAVAILABLE", 503);
      return value;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("SOURCE_UNAVAILABLE", 503);
    }
  }
}

function keeperConfig(token: string): Record<string, unknown> {
  const trimmed = token.trim();
  const json = trimmed.startsWith("{")
    ? trimmed
    : trimmed.slice(trimmed.indexOf(":") + 1);
  const config = JSON.parse(Buffer.from(json, "base64").toString("utf8")) as {
    clientId?: string;
  };
  if (typeof config.clientId !== "string" || !config.clientId)
    throw new VaultError("SOURCE_UNAVAILABLE", 503);
  return config;
}

export interface HashiCorpVaultSourceOptions {
  /** Operator-configured cluster origin, e.g. https://vault.internal:8200 */
  address: string;
  namespace?: string;
}

/** HashiCorp Vault KV v2 data fields over the documented REST API. */
export class HashiCorpVaultSource implements PasswordSource {
  private readonly base: string;
  private readonly namespace?: string;
  constructor(options: HashiCorpVaultSourceOptions) {
    const url = new URL(options.address);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        "Vault address must not include userinfo, a query or a fragment",
      );
    this.base = url.origin + (url.pathname === "/" ? "" : url.pathname);
    this.namespace = options.namespace;
  }
  async resolve(token: string, reference: string) {
    const match = reference.match(
      /^vault:\/\/([A-Za-z0-9_-]+)((?:\/[A-Za-z0-9_.-]+)+)#([A-Za-z0-9_.-]+)$/,
    );
    if (
      !match ||
      match[2].split("/").some((segment) => segment === "." || segment === "..")
    )
      throw new VaultError("SOURCE_UNAVAILABLE", 503);
    try {
      const response = await request(
        `${this.base}/v1/${match[1]}/data${match[2]}`,
        {
          method: "GET",
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
          headers: {
            Accept: "application/json",
            "X-Vault-Token": token,
            ...(this.namespace ? { "X-Vault-Namespace": this.namespace } : {}),
          },
        },
      );
      const body = (await readJson(response)) as {
        data?: { data?: Record<string, unknown> };
      };
      const value = body.data?.data?.[match[3]];
      if (typeof value !== "string" || !value)
        throw new VaultError("SOURCE_UNAVAILABLE", 503);
      return value;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("SOURCE_UNAVAILABLE", 503);
    }
  }
}

/** Doppler service tokens (project/config scoped) over the REST v3 API. */
export class DopplerSource implements PasswordSource {
  async resolve(token: string, reference: string) {
    const match = reference.match(/^doppler:\/\/([A-Za-z0-9_.-]+)$/);
    if (!match) throw new VaultError("SOURCE_UNAVAILABLE", 503);
    const name = match[1];
    try {
      const url = new URL("https://api.doppler.com/v3/configs/config/secrets");
      url.searchParams.set("name", name);
      const response = await request(url, {
        method: "GET",
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const body = (await readJson(response)) as {
        secrets?: Record<string, { computed?: unknown }>;
      };
      const secrets = body.secrets ?? {};
      const entry =
        secrets[name] ??
        Object.entries(secrets).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        )?.[1];
      const value = entry?.computed;
      if (typeof value !== "string" || !value)
        throw new VaultError("SOURCE_UNAVAILABLE", 503);
      return value;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("SOURCE_UNAVAILABLE", 503);
    }
  }
}

async function readJson(response: {
  statusCode: number;
  body: AsyncIterable<Uint8Array> & { destroy(): void };
}): Promise<unknown> {
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new VaultError("SOURCE_UNAVAILABLE", 503);
  let text = "",
    size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1_048_576) {
      response.body.destroy();
      throw new VaultError("SOURCE_UNAVAILABLE", 503);
    }
    text += chunk.toString();
  }
  return JSON.parse(text) as unknown;
}
