import type { Database } from "bun:sqlite";
import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  LocalKeyring,
  VaultCipher,
  type Envelope,
} from "../../server/src/crypto.ts";
import type { NativeLoginInput, NativeLoginState } from "./native-login.ts";
import { cookieJar, type VaultCookie } from "@unlock/protocol";
import {
  decodeCdpCookie,
  cdpCookieParameters,
} from "../../../packages/sdk/src/cdp.ts";
import { createVaultBridge, type PrivateBrowserAdapter } from "../../../packages/sdk/src/agent.ts";

type Credentials = { username?: string; password?: string; credentialReference?: { managerId: string; reference: string } };
type SavedLogin = {
  revision: number;
  jarRevision?: number;
  expiresAt: number;
  credentials?: Credentials;
  credentialReference?: { managerId: string; reference: string };
  cookies: VaultCookie[];
};

/** Reuse Unlock's envelope cipher. The VM wrapping key is private host state,
 * separate from the SQLite ciphertext, and must not be published with exports. */
export function nativeLoginCipher(directory: string, db?: Database) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Unsafe native vault directory");
  const path = join(directory, "unlock-vault.key");
  try {
    // Missing key material must not silently create a new, incompatible vault.
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const exists = db
        ?.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='native_vault'",
        )
        .get();
      if (exists && db!.query("SELECT id FROM native_vault LIMIT 1").get())
        throw Error("Native vault wrapping key missing");

    }
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, randomBytes(32));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(fd);
    if (
      !file.isFile() ||
      file.size !== 32 ||
      file.nlink !== 1 ||
      file.mode & 0o077 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw Error("Unsafe native vault key");
    const key = readFileSync(fd);
    try {
      return new VaultCipher(
        new LocalKeyring("vm-v1", {
          "vm-v1": Buffer.from(key).toString("base64"),
        }),
      );
    } finally {
      key.fill(0);
    }
  } finally {
    closeSync(fd);
  }
}

/** Host-only custody. Candidates stay in RAM until the browser verifies login;
 * neither passwords nor cookies belong in Tardigrade events or entity memory. */
export class NativeLoginVault {
  private pending = new Map<
    string,
    Credentials & { domain: string; revision: number; expiresAt: number }
  >();
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private db: Database,
    private owner: string,
    private cipher: VaultCipher,
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner))
      throw Error("Invalid vault owner");
    db.exec(
      "CREATE TABLE IF NOT EXISTS native_vault(id TEXT PRIMARY KEY,domain TEXT NOT NULL,envelope TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS native_cookie_checkpoint(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, token TEXT NOT NULL)",
    );
  }
  private context(state: Pick<NativeLoginState, "connectionId" | "domain">) {
    return `unlock:native-login:v1:${this.owner}:${state.connectionId}:${state.domain}`;
  }
  stage(state: NativeLoginState, input: NativeLoginInput) {
    for (const [id, candidate] of this.pending)
      if (candidate.expiresAt <= Date.now()) this.discard(id);
    if (
      state.status !== "pending" ||
      state.expiresAt <= Date.now() ||
      state.connectionId !== input.connectionId ||
      state.domain !== input.domain
    )
      throw Error("Invalid credential candidate");
    const old = this.pending.get(state.connectionId);
    const previous =
      old?.domain === state.domain && old.revision === state.revision
        ? old
        : undefined;
    const username = input.username || previous?.username;
    const password =
      input.password ||
      (input.username && input.username !== previous?.username
        ? undefined
        : previous?.password);
    this.discard(state.connectionId);
    this.pending.set(state.connectionId, {
      domain: state.domain,
      revision: state.revision,
      expiresAt: state.expiresAt,
      username,
      password,
      credentialReference:
        input.credentialReference ??
        (input.password ? undefined : previous?.credentialReference),
    });
    const timer = setTimeout(
      () => this.discard(state.connectionId),
      state.expiresAt - Date.now(),
    );
    timer.unref();
    this.expiry.set(state.connectionId, timer);
  }
  discard(id: string) {
    this.pending.delete(id);
    clearTimeout(this.expiry.get(id));
    this.expiry.delete(id);
  }
  remove(id: string) {
    this.discard(id);
    this.db.transaction(() => {
      this.db.query("DELETE FROM native_vault WHERE id=?").run(id);
      this.db.query("DELETE FROM native_cookie_checkpoint WHERE id=?").run(id);
    })();
  }
  close() {
    for (const id of this.pending.keys()) this.discard(id);
  }
  /** Expiry ends a session, not its saved password. Only a still-authorized
   * connection can use this private callback; disconnected generations cannot. */
  async renew<T>(
    state: NativeLoginState,
    use: (credentials: { username: string; password: string }) => Promise<T>,
  ): Promise<T | undefined> {
    if (state.status !== "connected") return;
    const row = this.db
      .query("SELECT domain,envelope FROM native_vault WHERE id=?")
      .get(state.connectionId) as { domain: string; envelope: string } | null;
    if (!row) return;
    if (row.domain !== state.domain)
      throw Error("Native vault binding mismatch");
    const saved = await this.cipher.open<SavedLogin>(
      this.context(state),
      JSON.parse(row.envelope),
    );
    if (
      saved.revision !== state.revision ||
      saved.expiresAt !== state.expiresAt
    )
      throw Error("Native vault session changed");
    if (!saved.credentials?.username || !saved.credentials.password) return;
    return use({
      username: saved.credentials.username,
      password: saved.credentials.password,
    });
  }
  async verified(state: NativeLoginState, raw: unknown[]): Promise<boolean> {
    if (state.status !== "connected" || state.expiresAt <= Date.now())
      throw Error("Verified session required");
    const before = this.db
      .query("SELECT envelope FROM native_vault WHERE id=?")
      .get(state.connectionId) as { envelope: string } | null;
    const cookies = cookieJar.parse(
      raw.flatMap((value) => {
        const c = value as Partial<VaultCookie>;
        if (
          !c ||
          typeof c.name !== "string" ||
          typeof c.value !== "string" ||
          !c.value ||
          typeof c.domain !== "string" ||
          typeof c.path !== "string" ||
          c.secure !== true ||
          typeof c.httpOnly !== "boolean" ||
          typeof c.expires !== "number" ||
          !Number.isFinite(c.expires)
        )
          return [];
        const domain = c.domain.replace(/^\./, "");
        if (
          (domain !== state.domain && !domain.endsWith(`.${state.domain}`)) ||
          (c.expires !== -1 && c.expires * 1000 <= Date.now())
        )
          return [];
        return [decodeCdpCookie(c)];
      }),
    );
    if (!cookies.some((c) => c.httpOnly && c.value))
      throw Error("Restorable session unavailable");
    const candidate = this.pending.get(state.connectionId);
    let credentialReference =
      candidate?.domain === state.domain &&
      candidate.revision === state.revision - 1 &&
      candidate.expiresAt > Date.now()
        ? candidate.credentialReference
        : undefined;
    let credentials =
      candidate?.domain === state.domain &&
      candidate.revision === state.revision - 1 &&
      candidate.expiresAt > Date.now() &&
      candidate.username &&
      candidate.password &&
      !credentialReference
        ? { username: candidate.username, password: candidate.password }
        : undefined;
    // Verification may be retried after a login-tab close failed. Do not replace
    // already verified credentials with an empty record on that retry.
    if (!candidate) {
      const row = this.db
        .query("SELECT domain,envelope FROM native_vault WHERE id=?")
        .get(state.connectionId) as { domain: string; envelope: string } | null;
      if (row) {
        if (row.domain !== state.domain)
          throw Error("Native vault binding mismatch");
        const saved = await this.cipher.open<SavedLogin>(
          this.context(state),
          JSON.parse(row.envelope),
        );
        if (saved.revision === state.revision)
          credentialReference = saved.credentialReference;
        if (
          saved.revision === state.revision &&
          saved.credentials?.username &&
          saved.credentials.password
        )
          credentials = {
            username: saved.credentials.username,
            password: saved.credentials.password,
          };
      }
    }
    const record: SavedLogin = {
      revision: state.revision,
      expiresAt: state.expiresAt,
      cookies,
      ...(credentials ? { credentials } : {}),
      ...(credentialReference ? { credentialReference } : {}),
    };
    const sealed = await this.cipher.seal(this.context(state), record);
    this.db.transaction(() => {
      const latest = this.db
        .query("SELECT envelope FROM native_vault WHERE id=?")
        .get(state.connectionId) as { envelope: string } | null;
      if (latest?.envelope !== before?.envelope)
        throw Error("Native vault session changed");
      const checkpoint = this.db
        .query("SELECT revision FROM native_cookie_checkpoint WHERE id=?")
        .get(state.connectionId) as { revision: number } | null;
      if (checkpoint && checkpoint.revision >= state.revision)
        throw Error(
          "Native session needs verification after an uncertain cookie save",
        );
      this.db
        .query(
          "INSERT INTO native_vault(id,domain,envelope) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET domain=excluded.domain,envelope=excluded.envelope",
        )
        .run(state.connectionId, state.domain, JSON.stringify(sealed));
      this.db
        .query("DELETE FROM native_cookie_checkpoint WHERE id=?")
        .run(state.connectionId);
    })();
    this.discard(state.connectionId);
    return !!credentials;
  }
  private checkpoint(state: NativeLoginState, token?: string) {
    const pending = this.db
      .query("SELECT revision,token FROM native_cookie_checkpoint WHERE id=?")
      .get(state.connectionId) as { revision: number; token: string } | null;
    if (
      pending &&
      (pending.revision !== state.revision || pending.token !== token)
    )
      throw Error(
        "Native session needs verification after an uncertain cookie save",
      );
  }
  async session(state: NativeLoginState) {
    this.checkpoint(state);
    if (state.status !== "connected" || state.expiresAt <= Date.now()) return;
    const row = this.db
      .query("SELECT domain,envelope FROM native_vault WHERE id=?")
      .get(state.connectionId) as { domain: string; envelope: string } | null;
    if (!row) {
      if (state.credentialsSaved !== undefined)
        throw Error("Native vault session missing");
      return;
    }
    if (row.domain !== state.domain)
      throw Error("Native vault binding mismatch");
    const saved = await this.cipher.open<SavedLogin>(
      this.context(state),
      JSON.parse(row.envelope) as Envelope,
    );
    if (
      saved.revision !== state.revision ||
      saved.expiresAt !== state.expiresAt ||
      saved.expiresAt <= Date.now()
    )
      throw Error("Native vault session changed");
    const cookies = cookieJar
      .parse(saved.cookies)
      .filter((c) => c.expires === -1 || c.expires * 1000 > Date.now());
    this.checkpoint(state);
    if (!cookies.some((c) => c.httpOnly && c.value))
      throw Error("Native vault session expired");
    return cookies;
  }
  /** Independent cookie CAS; rotation must not change login/continuation identity. */
  private async material(state: NativeLoginState, token?: string) {
    this.checkpoint(state, token);
    if (state.status !== "connected" || state.expiresAt <= Date.now())
      throw Error("Verified session required");
    const row = this.db
      .query("SELECT domain,envelope FROM native_vault WHERE id=?")
      .get(state.connectionId) as { domain: string; envelope: string } | null;
    if (!row || row.domain !== state.domain)
      throw Error("Native vault binding unavailable");
    const saved = await this.cipher.open<SavedLogin>(
      this.context(state),
      JSON.parse(row.envelope),
    );
    if (
      saved.revision !== state.revision ||
      saved.expiresAt !== state.expiresAt
    )
      throw Error("Native vault session changed");
    this.checkpoint(state, token);
    return { saved, envelope: row.envelope };
  }
  async sync(
    state: NativeLoginState,
    revision: number,
    input: VaultCookie[],
    current: () => NativeLoginState | undefined,
    token?: string,
  ) {
    const check = () => {
      const latest = current();
      if (
        !latest ||
        latest.status !== "connected" ||
        latest.connectionId !== state.connectionId ||
        latest.domain !== state.domain ||
        latest.revision !== state.revision ||
        latest.expiresAt !== state.expiresAt ||
        latest.expiresAt <= Date.now()
      )
        throw Error("Native vault session changed");
    };
    check();
    const { saved, envelope } = await this.material(state, token);
    if ((saved.jarRevision ?? 1) !== revision)
      throw Error("Native vault cookie revision changed");
    const cookies = cookieJar.parse(input);
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      const partition =
        cookie.partitionKey && new URL(cookie.partitionKey.topLevelSite);
      if (
        !cookie.secure ||
        cookie.hostOnly !== !cookie.domain.startsWith(".") ||
        (domain !== state.domain && !domain.endsWith(`.${state.domain}`)) ||
        (partition &&
          (partition.protocol !== "https:" ||
            (partition.hostname !== state.domain &&
              !partition.hostname.endsWith(`.${state.domain}`))))
      )
        throw Error("Native vault cookie scope mismatch");
    }
    const live = cookies.filter(
      (c) => c.expires === -1 || c.expires * 1000 > Date.now(),
    );
    const next = revision + 1;
    if (!Number.isSafeInteger(next))
      throw Error("Native vault cookie revision exhausted");
    const sealed = await this.cipher.seal(this.context(state), {
      ...saved,
      jarRevision: next,
      cookies: live,
    });
    check();
    this.db.transaction(() => {
      this.checkpoint(state, token);
      const result = this.db
        .query(
          "UPDATE native_vault SET envelope=? WHERE id=? AND domain=? AND envelope=?",
        )
        .run(
          JSON.stringify(sealed),
          state.connectionId,
          state.domain,
          envelope,
        );
      if (result.changes !== 1)
        throw Error("Native vault cookie revision changed");
      if (token)
        this.db
          .query("DELETE FROM native_cookie_checkpoint WHERE id=? AND token=?")
          .run(state.connectionId, token);
    })();
    // Preserve the verified lease; website cookie rotation cannot extend it.
    return {
      revision: next,
      expiresAt: live.some((c) => c.httpOnly && c.value)
        ? state.expiresAt
        : Date.now(),
    };
  }
  /** Bind the SDK bridge to this account's encrypted store, not another service. */
  async bridge(
    state: NativeLoginState,
    browser: PrivateBrowserAdapter,
    runtimeId: string,
    domains: string[],
    current: () => NativeLoginState | undefined,
  ) {
    const binding = structuredClone(state);
    if (
      !domains.includes(binding.domain) ||
      domains.some(
        (d) => d !== binding.domain && !d.endsWith(`.${binding.domain}`),
      )
    )
      throw Error("Native vault cookie scope mismatch");
    const scope = [...new Set(domains)];
    const check = () => {
      const latest = current();
      if (
        !latest ||
        latest.status !== "connected" ||
        latest.connectionId !== binding.connectionId ||
        latest.domain !== binding.domain ||
        latest.revision !== binding.revision ||
        latest.expiresAt !== binding.expiresAt
      )
        throw Error("Native vault session changed");
    };
    check();
    // restore() has already recovered missing material without replacing a
    // newer profile cookie. Checkpoint that full jar before SDK initialization.
    const { saved } = await this.material(binding);
    const restored = await browser.exportCookies(scope, true);
    if (
      !restored.some(
        (c) =>
          c.httpOnly &&
          c.value &&
          c.secure &&
          (c.expires === -1 || c.expires * 1000 > Date.now()),
      )
    )
      throw Error(
        "Restore the verified native session before binding its browser",
      );
    await this.sync(binding, saved.jarRevision ?? 1, restored, current);
    let checkpointToken: string | undefined;
    const bridge = createVaultBridge(
      {
        retrieve: async (id) => {
          if (id !== binding.connectionId)
            throw Error("Native vault binding mismatch");
          check();
          const { saved } = await this.material(binding);
          const cookies = cookieJar
            .parse(saved.cookies)
            .filter((c) => c.expires === -1 || c.expires * 1000 > Date.now());
          if (!cookies.some((c) => c.httpOnly && c.value))
            throw Error("Native vault session expired");
          check();
          return {
            connectionId: id,
            profileId: this.owner,
            runtimeId,
            allowedDomains: scope,
            revision: saved.jarRevision ?? 1,
            expiresAt: saved.expiresAt,
            cookies,
          };
        },
        sync: (id, input) => {
          if (id !== binding.connectionId)
            throw Error("Native vault binding mismatch");
          return this.sync(
            binding,
            input.revision,
            input.cookies,
            current,
            checkpointToken,
          );
        },
      },
      browser,
      {
        connectionId: binding.connectionId,
        profileId: this.owner,
        runtimeId,
        domains: scope,
        includeSubdomains: true,
      },
    );
    return {
      ...bridge,
      run: <T>(
        action: () => Promise<T>,
        onSyncError?: (code: string) => void,
      ) =>
        bridge.run(async () => {
          checkpointToken = undefined;
          check();
          const { saved, envelope } = await this.material(binding);
          check();
          if ((saved.jarRevision ?? 1) !== bridge.status().revision)
            throw Error("Native vault cookie revision changed");
          const token = Buffer.from(randomBytes(24)).toString("hex");
          // Fence BEFORE dispatch. A crash or failed export must not resurrect
          // the pre-action jar in a new browser. Commit and fence removal are atomic.
          this.db.transaction(() => {
            this.checkpoint(binding);
            const latest = this.db
              .query("SELECT envelope FROM native_vault WHERE id=?")
              .get(binding.connectionId) as { envelope: string } | null;
            if (latest?.envelope !== envelope)
              throw Error("Native vault cookie revision changed");
            this.db
              .query(
                "INSERT INTO native_cookie_checkpoint(id,revision,token) VALUES(?,?,?)",
              )
              .run(binding.connectionId, binding.revision, token);
          })();
          checkpointToken = token;
          return action();
        }, onSyncError),
    };
  }
  async restore(
    state: NativeLoginState,
    cdp: Pick<import("./native-login.ts").PrivateCdp, "send">,
  ) {
    const cookies = await this.session(state);
    if (!cookies) return false;
    const current = await cdp.send("Storage.getCookies", {});
    if (!Array.isArray(current?.cookies))
      throw Error("Current browser session unavailable");
    // Preserve rotated values by exact cookie scope. One surviving cookie must
    // not suppress recovery of the rest of the session, including CSRF cookies.
    const missing = cookies.filter(
      (saved) =>
        !current.cookies.some(
          (c: any) =>
            c &&
            c.secure === true &&
            c.httpOnly === saved.httpOnly &&
            typeof c.value === "string" &&
            c.value.length > 0 &&
            (c.session === true ||
              c.expires === -1 ||
              c.expires * 1000 > Date.now()) &&
            saved.name === c.name &&
            saved.domain === c.domain &&
            saved.path === c.path &&
            !c.partitionKeyOpaque &&
            saved.partitionKey?.topLevelSite === c.partitionKey?.topLevelSite &&
            saved.partitionKey?.hasCrossSiteAncestor ===
              c.partitionKey?.hasCrossSiteAncestor,
        ),
    );
    if (missing.length)
      await cdp.send("Storage.setCookies", {
        cookies: missing.map(cdpCookieParameters),
      });
    return true;
  }
}
