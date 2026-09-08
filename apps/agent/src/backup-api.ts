import { createHash } from "node:crypto";
import { CloudBackups, type BackupManifest } from "./cloud-backup.ts";
import type { CodegraffSandbox } from "./codegraff.ts";

export type AccountBackup = {
  version: 1;
  owner: string;
  threads: unknown;
  memory: unknown;
  state: [string, unknown][];
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function backupApi(
  request: Request,
  options: {
    owner: string;
    backups: CloudBackups;
    sandbox: CodegraffSandbox;
    resting(): Promise<boolean>;
    account(): Promise<AccountBackup>;
    importAccount?(id: string, archive: AccountBackup): Promise<void>;
    /** Required for every restore, including VM-only and imported retries.
     * Host must also hold its owner restore/erasure mutex; a guard is not a lock. */
    authorizeRestore?(
      id: string,
      archive: AccountBackup,
      mode: "vm" | "account",
    ): Promise<{ check(): Promise<void> }>;
    record(manifest: BackupManifest): Promise<void>;
    list(): Promise<unknown>;
  },
) {
  const path = new URL(request.url).pathname;
  if (path === "/api/control/backups" && request.method === "GET")
    return Response.json({ backups: await options.list() });
  if (
    request.method !== "POST" ||
    !["/api/control/backup", "/api/control/restore"].includes(path)
  )
    return new Response(null, { status: 404 });
  if (options.sandbox.busy || !(await options.resting()))
    return Response.json({ error: "account_busy" }, { status: 409 });
  if (path === "/api/control/backup") {
    const manifest = await options.sandbox.backup(async (source) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify(await options.account()),
      );
      if (bytes.length > 64 * 1024 * 1024)
        throw Error("Account snapshot exceeds supported size");
      const sha256 = digest(bytes);
      const manifest = await options.backups.save(options.owner, {
        files: [
          ...source.files,
          { path: "account.json", bytes: bytes.length, sha256 },
        ],
        read: (path, offset, length) =>
          path === "account.json"
            ? Promise.resolve(bytes.slice(offset, offset + length))
            : source.read(path, offset, length),
        validate: async () => {
          if (
            digest(
              new TextEncoder().encode(JSON.stringify(await options.account())),
            ) !== sha256
          )
            throw Error("Account changed during backup; retry at rest");
        },
      });
      await options.record(manifest);
      return manifest;
    });
    return Response.json(
      {
        id: manifest.id,
        at: manifest.at,
        files: manifest.files.length,
        status: "verified",
      },
      { status: 201 },
    );
  }
  const text = await request.text();
  if (text.length > 512)
    return Response.json({ error: "invalid_restore" }, { status: 400 });
  const input = JSON.parse(text) as { id: string; mode: "vm" | "account" };
  if (
    !input ||
    !/^[a-f0-9-]{36}$/.test(input.id) ||
    !["vm", "account"].includes(input.mode) ||
    Object.keys(input).some((k) => !["id", "mode"].includes(k))
  )
    return Response.json({ error: "invalid_restore" }, { status: 400 });
  if (!options.authorizeRestore)
    throw Error("Restore authorization unavailable");
  const { manifest: inventory, bytes: accountBytes } =
    await options.backups.readFile(
      options.owner,
      input.id,
      "account.json",
      64 * 1024 * 1024,
    );
  const archive = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(accountBytes),
  ) as AccountBackup;
  if (
    !archive ||
    archive.version !== 1 ||
    archive.owner !== options.owner ||
    !Array.isArray(archive.state)
  )
    throw Error("Account backup binding mismatch");
  // Keep authorization inputs independent of mutable host callback references.
  const guard = await options.authorizeRestore(
    input.id,
    structuredClone(archive),
    input.mode,
  );
  if (!guard || typeof guard.check !== "function")
    throw Error("Restore authorization unavailable");
  await guard.check();
  const allowed: { id: string; domain: string; revision: number }[] = [];
  await options.sandbox.restore(
    async (sink) =>
      options.backups.restore(
        options.owner,
        input.id,
        {
          write: async (path, offset, bytes) => {
            await guard.check();
            if (path !== "account.json") await sink.write(path, offset, bytes);
          },
          abort: () => sink.abort(),
          commit: async (manifest) => {
            await guard.check();
            if (input.mode === "account") {
              if (!options.importAccount)
                throw Error("Account recovery unavailable");
              await options.importAccount(input.id, structuredClone(archive));
            }
            // Authorize from today's control-plane records, including a freshly
            // imported account. Never reactivate a revoked/stale backup generation.
            await guard.check();
            const current = await options.account();
            await guard.check();
            for (const [, value] of current.state) {
              const row = value as {
                id?: string;
                owner?: string;
                provider?: string;
                status?: string;
                connectorId?: string;
                browserVerification?: { revision: number };
              } | null;
              if (
                row?.owner === options.owner &&
                row.provider === "browser" &&
                row.status === "connected" &&
                row.connectorId?.startsWith("browser:") &&
                row.id &&
                Number.isSafeInteger(row.browserVerification?.revision)
              )
                allowed.push({
                  id: row.id,
                  domain: row.connectorId.slice(8),
                  revision: row.browserVerification!.revision,
                });
            }
            await guard.check();
            await sink.commit({
              ...manifest,
              files: manifest.files.filter(
                (file) => file.path !== "account.json",
              ),
            });
          },
        },
        inventory,
      ),
    allowed,
  );
  return Response.json({ id: input.id, status: "restored", mode: input.mode });
}
