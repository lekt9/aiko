import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SandboxJobJournal } from "./sandbox-job-runner.ts";
import { sandboxCanonical, sandboxDigest, type SandboxDigest, type SandboxJobReceipt } from "./sandbox-job.ts";
import { CODING_WORKSPACE_ABI, validateCodingWorkspaceRequest, type CodingRepositoryGrant, type CodingWorkspaceRequest } from "./coding-workspace.ts";

type Image = { path: string; before: string | null; beforeHash: string | null; afterHash: string | null; mode: number };
type Edit = { id: string; turn: string; images: Image[]; undone?: boolean };
type Manifest = { version: 2; owner: string; thread: string; repository: string; repositoryRoot: string; workspace: string; base: string; branch: string; path: string; state: "open" | "merged" | "closed"; revision: number; edits: Edit[]; commit?: string };
type TreeFile = { path: string; hash: string; mode: number; bytes: number };
type Tree = { digest: SandboxDigest; files: TreeFile[] };
export interface CodingWorkspaceRuntime {
  owner: string;
  /** Runner-private disk in the isolated owner compute VM, outside every repo. */
  stateRoot: string;
  repositories: CodingRepositoryGrant[];
  environmentDigest: SandboxDigest;
  journal: SandboxJobJournal;
  wallMs?: number;
  /** Trusted host observation of the original compute process, not a timer. */
  terminalOperation?: { thread: string; operation: string };
}
const bytesHash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const key = (value: unknown) => createHash("sha256").update(sandboxCanonical(value)).digest("hex");
async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function replaceFile(path: string, bytes: Uint8Array | null, mode: number) {
  if (bytes === null) await rm(path, { force: true });
  else {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.aiko-${randomUUID()}`;
    const file = await open(temporary, "wx", mode);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  }
  try { const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
}
function childOf(parent: string, path: string) { return path !== parent && path.startsWith(parent + sep); }
async function workspacePath(root: string, path: string) {
  if (typeof path !== "string" || path.length > 1000 || !path || path.includes("\\") || path.includes("\0") || path.startsWith("/") ||
      path.split("/").some(piece => !piece || piece === "." || piece === ".." || piece.toLowerCase() === ".git")) throw Error("Invalid repository-relative path");
  const destination = resolve(root, path);
  if (!childOf(root, destination)) throw Error("Repository path escapes workspace");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw Error("Repository symlink access denied"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  return destination;
}
async function fileImage(root: string, path: string) {
  const destination = await workspacePath(root, path);
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw Error("Repository file type or size exceeds limits");
    const bytes = await readFile(destination);
    return { bytes, hash: bytesHash(bytes), mode: info.mode & 0o777 };
  } catch (error: any) { if (error.code === "ENOENT") return { bytes: null, hash: null, mode: 0o644 }; throw error; }
}
/** Only the trusted runner invokes argv. No shell expansion or inherited credentials. */
function command(argv: string[], cwd: string, signal: AbortSignal, limit = 262144): Promise<{ code: number; output: string }> {
  signal.throwIfAborted();
  if (!argv.length || argv.some(value => typeof value !== "string" || !value || value.includes("\0") || value.length > 4096)) throw Error("Invalid registered check command");
  // Even trusted Git children must die with a killed runner. Otherwise a stale
  // parent lock plus terminal compute status could race a detached Git write.
  // Filesystem authority here belongs to the finite trusted Git adapter; checks
  // use the much narrower mount plan in isolatedCheck below.
  const invocation = argv[0] === "git" ? ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--chdir", cwd, "--", "/usr/bin/git", ...argv.slice(1)] : argv;
  return new Promise((resolveResult, reject) => {
    const child = spawn(invocation[0]!, invocation.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = []; let size = 0, exceeded = false;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    const collect = (chunk: Buffer) => { size += chunk.length; if (size > limit) { exceeded = true; stop(); } else chunks.push(chunk); };
    child.stdout!.on("data", collect); child.stderr!.on("data", collect);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.on("error", error => { signal.removeEventListener("abort", stop); reject(error); });
    child.on("close", code => {
      stop();
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(Error("Coding operation cancelled or deadline exceeded"));
      else if (exceeded) reject(Error("Coding command output exceeds 256 KiB"));
      else resolveResult({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
async function git(root: string, args: string[], signal: AbortSignal, allowed = [0]) {
  const controls = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "core.attributesFile=/dev/null",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "log.showSignature=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
  // A clean/smudge driver may execute a repository-authored program. Query names
  // without evaluating a driver, then neutralize every configured driver before
  // trusted checkout/add/merge work can encounter model-edited attributes.
  const configured = await command(["git", ...controls, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], root, signal);
  if (![0, 1].includes(configured.code)) throw Error("Git filter configuration unavailable");
  const drivers = new Set(configured.output.split("\0").filter(Boolean).map(name => name.slice(0, name.lastIndexOf("."))));
  if (drivers.size > 128) throw Error("Git filter configuration exceeds 128 drivers");
  for (const driver of drivers) {
    if (!/^filter\.[^\u0000-\u001f]+$/.test(driver) || driver.length > 1000) throw Error("Invalid Git filter configuration");
    for (const setting of ["clean=", "smudge=", "process=", "required=false"]) controls.push("-c", `${driver}.${setting}`);
  }
  const result = await command(["git", ...controls, ...args], root, signal);
  if (!allowed.includes(result.code)) throw Error(`Git ${args[0]} failed (${result.code}): ${result.output.slice(0, 2000)}`);
  return result.output.trimEnd();
}
/** Mandatory kernel isolation for repository-authored check code. The trusted
 * runner, receipt key, manifests, other worktrees and host PIDs are never mounted.
 * Deployments need bubblewrap and Linux user/mount/PID/network namespaces; no
 * unconfined fallback is permitted when those features are unavailable. */
async function isolatedCheck(argv: string[], workspace: string, stateRoot: string, repositories: readonly CodingRepositoryGrant[], signal: AbortSignal) {
  const unavailable = "Coding check isolation unavailable: install /usr/bin/bwrap and enable Linux user, mount, PID and network namespaces; checks cannot run unconfined";
  if (process.platform !== "linux" || !argv.length || !argv[0]?.startsWith("/")) throw Error(unavailable);
  let executable: string;
  try { executable = await realpath(argv[0]); if (!(await lstat("/usr/bin/bwrap")).isFile()) throw Error(); }
  catch { throw Error(unavailable); }
  if (executable === stateRoot || childOf(stateRoot, executable)) throw Error("Check executable cannot come from private runner state");
  const args = ["/usr/bin/bwrap", "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
  // System runtimes are immutable mounts. Refuse a deployment that places any
  // private state or granted repository underneath a shared runtime directory.
  for (const directory of ["/usr", "/bin", "/lib", "/lib64"]) {
    let path: string;
    try { path = await realpath(directory); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    for (const protectedPath of [stateRoot, workspace, ...await Promise.all(repositories.map(repository => realpath(repository.root)))])
      if (protectedPath === path || childOf(path, protectedPath)) throw Error("Coding state and repositories cannot be inside shared system runtime directories");
    args.push("--ro-bind", path, directory);
  }
  const dotGit = await lstat(join(workspace, ".git"));
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw Error("Coding worktree metadata changed before checks");
  args.push("--ro-bind", executable, "/aiko-check", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/workspace",
    "--bind", workspace, "/workspace", "--ro-bind", "/dev/null", "/workspace/.git", "--chdir", "/workspace",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8", "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null", "--setenv", "GIT_TERMINAL_PROMPT", "0");
  // Probe the exact mount/namespace plan before launching project code. Errors
  // identify missing host prerequisites rather than claiming a failed test ran.
  const probe = await command([...args, "--", "/usr/bin/true"], workspace, signal);
  if (probe.code !== 0) throw Error(`${unavailable}: ${probe.output.slice(0, 1200)}`);
  return command([...args, "--", "/aiko-check", ...argv.slice(1)], workspace, signal);
}
async function tree(root: string, signal: AbortSignal): Promise<Tree> {
  const paths = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal)).split("\0").filter(Boolean);
  const unique = [...new Set(paths)].sort();
  if (unique.length > 10000) throw Error("Repository index exceeds 10000 files");
  const files: TreeFile[] = []; let bytes = 0;
  for (const path of unique) {
    signal.throwIfAborted();
    const image = await fileImage(root, path);
    if (!image.bytes) continue;
    bytes += image.bytes.length;
    if (bytes > 64 * 1024 * 1024) throw Error("Repository snapshot exceeds 64 MiB");
    files.push({ path, hash: image.hash!, mode: image.mode, bytes: image.bytes.length });
  }
  return { digest: await sandboxDigest(files), files };
}
async function lock(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); await file.close();
      return async () => { if ((await json<{ token: string }>(path))?.token === token) await rm(path); };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const prior = await json<{ pid: number; token: string }>(path).catch(() => undefined);
      if (!prior || !Number.isSafeInteger(prior.pid) || prior.pid < 1) throw Error("Workspace lock requires reconciliation");
      try { process.kill(prior.pid, 0); throw Error("Workspace has a live operation; retry after it settles"); }
      catch (alive: any) { if (alive.code !== "ESRCH") throw alive; }
      if ((await json<{ token: string }>(path))?.token !== prior.token) throw Error("Workspace lock changed");
      await rm(path);
    }
  }
  throw Error("Workspace lock unavailable");
}

/** A finite effect adapter. The existing encrypted sandbox journal fences retries;
 * Tardie remains the sole workflow coordinator. Run this inside account compute. */
export async function runCodingWorkspace(raw: CodingWorkspaceRequest, binding: CodingWorkspaceRuntime, cancellation?: AbortSignal): Promise<SandboxJobReceipt> {
  const request = validateCodingWorkspaceRequest(JSON.parse(sandboxCanonical(raw)));
  if (request.owner !== binding.owner) throw Error("Coding repository owner mismatch");
  const grant = binding.repositories.find(repository => repository.id === request.command.repository);
  if (!grant || !grant.actions.includes(request.command.action)) throw Error("Repository action has no owner grant");
  const wallMs = binding.wallMs ?? 300000;
  if (!Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > 300000) throw Error("Invalid coding deadline");
  const signal = AbortSignal.any([...(cancellation ? [cancellation] : []), AbortSignal.timeout(wallMs)]);
  const jobDigest = await sandboxDigest(request), harnessDigest = await sandboxDigest(CODING_WORKSPACE_ABI);
  const operationKey = (operationId: string) => `coding:${key([request.thread, operationId])}`;
  const journalId = operationKey(request.operationId);
  const base = { operationId: request.operationId, jobDigest, harnessDigest, environmentDigest: binding.environmentDigest, requests: 0, browserStarts: 0 as const };
  if (!await binding.journal.claim(binding.owner, journalId, jobDigest)) {
    const prior = await binding.journal.read(binding.owner, journalId);
    if (prior?.digest !== jobDigest) throw Error("Coding operation identity conflict");
    return prior.receipt ?? { ...base, status: "unknown", reason: "dispatched_without_receipt_reconcile_required" };
  }
  let release: (() => Promise<void>) | undefined, dispatched = false;
  let receipt: SandboxJobReceipt;
  try {
    const root = await realpath(grant.root);
    await mkdir(binding.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(binding.stateRoot);
    if (stateRoot === root || childOf(root, stateRoot) || childOf(stateRoot, root)) throw Error("Repository and private coding state must be separate");
    const id = key([binding.owner, grant.id, request.command.workspace]);
    const manifestPath = join(stateRoot, "manifests", `${id}.json`);
    release = await lock(join(stateRoot, "locks", `${id}.lock`));
    let manifest = await json<Manifest>(manifestPath);
    const args = request.command;
    const persist = () => save(manifestPath, manifest);
    let output: unknown;
    if (args.action === "reconcile") {
      if (manifest && (manifest.version !== 2 || manifest.owner !== binding.owner || manifest.thread !== request.thread || manifest.repository !== grant.id ||
          manifest.repositoryRoot !== root || manifest.workspace !== args.workspace || manifest.path !== join(stateRoot, "worktrees", id))) throw Error("Reconciliation requires the workspace's creating native thread and repository");
      const original = await binding.journal.read(binding.owner, operationKey(args.operation));
      if (!original || original.digest !== request.reconciliation?.expectedDigest) throw Error("Original operation is absent or has a different native identity");
      const terminal = binding.terminalOperation?.thread === request.thread && binding.terminalOperation.operation === args.operation;
      const known = original.receipt;
      if (known && (known.operationId !== args.operation || known.jobDigest !== original.digest)) throw Error("Original operation receipt identity mismatch");
      if (!known && terminal) await binding.journal.settle(binding.owner, operationKey(args.operation), {
        ...base, operationId: args.operation, jobDigest: original.digest as SandboxDigest, status: "unknown", reason: "Original compute process is terminal and workspace is idle; effect outcome was not acknowledged",
      });
      let current: { state: string; revision?: number; tree?: string } = { state: manifest?.state ?? "absent", ...(manifest ? { revision: manifest.revision } : {}) };
      if ((known || terminal) && manifest && manifest.state !== "closed") {
        try {
          if (await realpath(manifest.path) !== manifest.path) throw Error("Workspace root changed");
          current = { ...current, tree: (await tree(manifest.path, signal)).digest };
        } catch { current = { ...current, state: "incomplete" }; }
      }
      output = { repository: grant.id, workspace: args.workspace, operation: args.operation, targetDigest: original.digest, ...current,
        idle: !!known || terminal, outcome: "unknown", observedReceiptStatus: known?.status ?? null, verified: false,
        instruction: known || terminal ? "Original effect was not repeated. Inspect the workspace; content changes and uncertain checks require fresh verification." : "Original process termination is not confirmed. Keep this operation unknown; do not repeat it." };
    } else if (args.action === "create") {
      if (manifest) throw Error("Workspace identifier already exists");
      if (args.base !== undefined && (typeof args.base !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(args.base) || args.base.includes(".."))) throw Error("Invalid base reference");
      const baseCommit = await git(root, ["rev-parse", "--verify", "--end-of-options", `${args.base ?? "HEAD"}^{commit}`], signal);
      const workspace = join(stateRoot, "worktrees", id), branch = `aiko/${id}`;
      await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
      manifest = { version: 2, owner: binding.owner, thread: request.thread, repository: grant.id, repositoryRoot: root, workspace: args.workspace, base: baseCommit, branch, path: workspace, state: "open", revision: 0, edits: [] };
      dispatched = true;
      // Persist intended identity before git can create the worktree; status can
      // inspect a lost acknowledgement without creating a second branch.
      await persist();
      await git(root, ["worktree", "add", "-b", branch, workspace, baseCommit], signal);
      output = { workspace: args.workspace, repository: grant.id, thread: request.thread, base: baseCommit, branch, state: "open" };
    } else {
      if (!manifest || manifest.owner !== binding.owner || manifest.repository !== grant.id || manifest.repositoryRoot !== root || manifest.workspace !== args.workspace || manifest.path !== join(stateRoot, "worktrees", id)) throw Error("Workspace is not registered to this owner");
      if (!["status", "read", "list", "query"].includes(args.action) && (manifest.version !== 2 || manifest.thread !== request.thread))
        throw Error("Workspace mutations and verification require its creating native thread; create an isolated workspace for this worker");
      if (manifest.state === "closed" && args.action !== "status") throw Error("Workspace is closed");
      const workspace = manifest.path;
      if (manifest.state !== "closed" && await realpath(workspace) !== workspace) throw Error("Workspace root changed");
      if (args.action === "status") {
        output = { workspace: args.workspace, state: manifest.state, ...(typeof manifest.thread === "string" ? { thread: manifest.thread } : {}), base: manifest.base, branch: manifest.branch,
          ...(manifest.state === "closed" ? {} : { head: await git(workspace, ["rev-parse", "HEAD"], signal), changes: await git(workspace, ["status", "--short"], signal), tree: (await tree(workspace, signal)).digest }),
          ...(manifest.commit ? { commit: manifest.commit } : {}) };
      } else if (args.action === "read") {
        const image = await fileImage(workspace, args.path), offset = args.offset ?? 0, length = args.length ?? 131072;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 131072) throw Error("Invalid read range");
        const bytes = image.bytes;
        output = { path: args.path, hash: image.hash, bytes: bytes?.length ?? 0, offset, text: bytes?.subarray(offset, offset + length).toString("utf8") ?? null, truncated: bytes ? offset + length < bytes.length : false };
      } else if (args.action === "list") {
        const path = args.path ? await workspacePath(workspace, args.path) : workspace;
        const entries = await readdir(path, { withFileTypes: true });
        if (entries.length > 2000) throw Error("Directory listing exceeds 2000 entries");
        output = { path: args.path ?? "", entries: entries.filter(entry => entry.name.toLowerCase() !== ".git" && !entry.isSymbolicLink()).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" })).sort((a, b) => a.name.localeCompare(b.name)) };
      } else if (args.action === "edit") {
        if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 64 || new Set(args.changes.map(change => change.path)).size !== args.changes.length) throw Error("Invalid edit batch");
        const images: Image[] = [];
        for (const change of args.changes) {
          if (change.content !== null && (typeof change.content !== "string" || Buffer.byteLength(change.content) > 131072)) throw Error("Edit content exceeds 128 KiB");
          const before = await fileImage(workspace, change.path);
          if (before.hash !== change.expected) throw Error(`File changed before edit: ${change.path}`);
          images.push({ path: change.path, before: before.bytes?.toString("base64") ?? null, beforeHash: before.hash, afterHash: change.content === null ? null : bytesHash(Buffer.from(change.content)), mode: before.mode });
        }
        if (manifest.edits.length >= 200 || Buffer.byteLength(JSON.stringify([...manifest.edits, { images }])) > 16 * 1024 * 1024)
          throw Error("Workspace undo history exceeds its retained byte/count budget; create a fresh worktree");
        manifest.edits.push({ id: request.operationId, turn: request.turn, images });
        manifest.revision++;
        await persist();
        for (let index = 0; index < args.changes.length; index++) {
          signal.throwIfAborted(); const change = args.changes[index]!, path = await workspacePath(workspace, change.path);
          dispatched = true;
          await replaceFile(path, change.content === null ? null : Buffer.from(change.content), images[index]!.mode);
        }
        output = { edited: images.map(image => ({ path: image.path, hash: image.afterHash })), undoTurn: request.turn, tree: (await tree(workspace, signal)).digest };
      } else if (args.action === "undo") {
        const selected = manifest.edits.filter(edit => !edit.undone && edit.turn === (args.turn ?? request.turn)).reverse();
        // Validate the complete reverse chain before restoring any file. A later
        // unrelated edit cannot be overwritten by undoing an earlier turn.
        const current = new Map<string, string | null>();
        for (const edit of selected) for (const image of [...edit.images].reverse()) {
          const hash = current.has(image.path) ? current.get(image.path)! : (await fileImage(workspace, image.path)).hash;
          if (hash !== image.afterHash && hash !== image.beforeHash) throw Error(`File changed after recorded edit: ${image.path}`);
          current.set(image.path, image.beforeHash);
        }
        if (selected.length) { manifest.revision++; await persist(); }
        for (const edit of selected) {
          for (const image of [...edit.images].reverse()) {
            signal.throwIfAborted(); const path = await workspacePath(workspace, image.path); dispatched = true;
            await replaceFile(path, image.before === null ? null : Buffer.from(image.before, "base64"), image.mode);
          }
          edit.undone = true; await persist();
        }
        output = { undone: selected.map(edit => edit.id), tree: (await tree(workspace, signal)).digest };
      } else if (args.action === "index") {
        const snapshot = await tree(workspace, signal), entries: { path: string; text: string; symbols: { name: string; line: number }[] }[] = [];
        let bytes = 0;
        for (const file of snapshot.files) {
          if (file.bytes > 524288) continue;
          const source = (await fileImage(workspace, file.path)).bytes!;
          if (source.includes(0)) continue;
          bytes += source.length; if (bytes > 8 * 1024 * 1024) throw Error("Code text index exceeds 8 MiB");
          const text = source.toString("utf8"), symbols: { name: string; line: number }[] = [];
          text.split("\n").forEach((line, index) => {
            const match = /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|def|fn|struct|enum|func)\s+([A-Za-z_$][\w$]*)/.exec(line);
            if (match) symbols.push({ name: match[1]!, line: index + 1 });
          });
          entries.push({ path: file.path, text, symbols });
        }
        await save(join(stateRoot, "indexes", `${id}.json`), { tree: snapshot.digest, entries });
        output = { tree: snapshot.digest, files: entries.length, symbols: entries.reduce((sum, entry) => sum + entry.symbols.length, 0), engine: "bounded lexical declarations and text" };
      } else if (args.action === "query") {
        if (typeof args.query !== "string" || !args.query || args.query.length > 2000 || !Number.isSafeInteger(args.limit ?? 30) || (args.limit ?? 30) < 1 || (args.limit ?? 30) > 100) throw Error("Invalid code index query");
        const index = await json<{ tree: string; entries: { path: string; text: string; symbols: { name: string; line: number }[] }[] }>(join(stateRoot, "indexes", `${id}.json`));
        if (!index || index.tree !== (await tree(workspace, signal)).digest) throw Error("Code index missing or stale; run index for the current tree");
        const results: unknown[] = [], needle = args.query.toLowerCase(), limit = args.limit ?? 30;
        for (const entry of index.entries) {
          const rows = args.kind === "symbol" ? entry.symbols.filter(symbol => symbol.name.toLowerCase().includes(needle)).map(symbol => ({ path: entry.path, ...symbol }))
            : entry.text.split("\n").flatMap((text, line) => text.toLowerCase().includes(needle) ? [{ path: entry.path, line: line + 1, text: text.slice(0, 500) }] : []);
          results.push(...rows.slice(0, limit - results.length)); if (results.length >= limit) break;
        }
        output = { tree: index.tree, results, limit };
      } else if (args.action === "test") {
        const checks = Object.entries(grant.checks);
        if (!checks.length) throw Error("No verification commands are granted for this repository");
        const before = await tree(workspace, signal), head = await git(workspace, ["rev-parse", "HEAD"], signal);
        const results: { name: string; code: number; output: string }[] = [];
        for (const [name, argv] of checks) { dispatched = true; results.push({ name, ...await isolatedCheck(argv, workspace, stateRoot, binding.repositories, signal) }); }
        const after = await tree(workspace, signal);
        output = { repository: grant.id, workspace: args.workspace, revision: manifest.revision, verified: results.every(result => result.code === 0) && before.digest === after.digest, tree: after.digest, head, checksDigest: await sandboxDigest(grant.checks), checks: results };
      } else if (args.action === "merge") {
        if (typeof args.testOperation !== "string" || typeof args.message !== "string" || !args.message.trim() || args.message.length > 2000) throw Error("Invalid merge request");
        const proof = (await binding.journal.read(binding.owner, operationKey(args.testOperation)))?.receipt, evidence = proof?.output as any;
        const snapshot = await tree(workspace, signal), head = await git(workspace, ["rev-parse", "HEAD"], signal);
        if (proof?.status !== "completed" || proof.harnessDigest !== harnessDigest || proof.environmentDigest !== binding.environmentDigest || proof.outputDigest !== await sandboxDigest(evidence ?? null) ||
            !evidence?.verified || evidence.repository !== grant.id || evidence.workspace !== args.workspace || evidence.revision !== manifest.revision || evidence.tree !== snapshot.digest || evidence.head !== head || evidence.checksDigest !== await sandboxDigest(grant.checks)) throw Error("Fresh passing verification for this exact tree is required");
        if (await git(root, ["rev-parse", "HEAD"], signal) !== manifest.base || await git(root, ["status", "--porcelain"], signal)) throw Error("Merge target moved or has local changes");
        dispatched = true;
        await git(workspace, ["add", "--all", "--", "."], signal);
        await git(workspace, ["-c", "user.name=Aiko", "-c", "user.email=aiko@localhost", "commit", "--allow-empty", "-m", args.message], signal);
        manifest.commit = await git(workspace, ["rev-parse", "HEAD"], signal); await persist();
        await git(root, ["merge", "--ff-only", "--no-edit", manifest.commit], signal);
        manifest.state = "merged"; manifest.base = manifest.commit; await persist();
        output = { merged: true, commit: manifest.commit, tree: snapshot.digest, testOperation: args.testOperation };
      } else if (args.action === "close") {
        if (await git(workspace, ["status", "--porcelain"], signal)) throw Error("Cannot close a workspace with uncommitted changes");
        await git(root, ["merge-base", "--is-ancestor", await git(workspace, ["rev-parse", "HEAD"], signal), "HEAD"], signal);
        dispatched = true;
        await git(root, ["worktree", "remove", workspace], signal);
        manifest.state = "closed"; await persist();
        output = { closed: true, workspace: args.workspace };
      }
    }
    if (Buffer.byteLength(sandboxCanonical(output)) > 1048576) throw Error("Coding output exceeds 1 MiB");
    receipt = { ...base, status: "completed", output, outputDigest: await sandboxDigest(output) };
  } catch (error) {
    receipt = { ...base, status: dispatched ? "unknown" : "failed", reason: String(error instanceof Error ? error.message : error).slice(0, 512) };
  } finally { await release?.(); }
  await binding.journal.settle(binding.owner, journalId, receipt);
  return receipt;
}
