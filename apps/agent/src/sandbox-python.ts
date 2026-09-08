import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SealedRuntimeImage, resourceGate } from "./sandbox-runtime-image.ts";
import { createResourceScope, resourceParent, resourceCpuMax, type SandboxResourceUsage } from "./sandbox-resources.ts";
import { sandboxCanonical, sandboxDigest, type SandboxArtifact, type SandboxDigest, type SandboxJob } from "./sandbox-job.ts";

export interface PythonRuntimeOptions {
  python?: string;
  tools?: Record<string, string>;
  /** Trusted host libraries loaded with dlopen rather than ELF DT_NEEDED,
   * e.g. /usr/lib/libSDL3.so.0 for this host's FFmpeg build. */
  sharedLibraries?: string[];
  /** Exact installed site-packages and model snapshot, supplied by the host. */
  packages?: string;
  models?: string;
  bubblewrap?: string;
  temporaryRoot?: string;
  /** Existing delegated cgroup v2 parent; no ancestor controller is modified. */
  cgroupRoot?: string;
}
export interface PythonRuntimeLock {
  version: 2;
  imageDigest: SandboxDigest;
  resourcePolicyDigest: SandboxDigest;
  platform: string;
  architecture: string;
  pythonVersion: string;
  pythonDigest: SandboxDigest;
  stdlibDigest: SandboxDigest;
  libraries: Record<string, SandboxDigest>;
  tools: Record<string, SandboxDigest>;
  packagesDigest: SandboxDigest | null;
  modelsDigest: SandboxDigest | null;
  driverDigest: SandboxDigest;
  isolationDigest: SandboxDigest;
}
export interface SandboxPythonRuntime {
  readonly lock: PythonRuntimeLock;
  readonly lockDigest: SandboxDigest;
  readonly capture: { files: number; sourceBytes: number; retainedBytes: number };
  /** Verify retained sealed bytes and the trusted launch utility. */
  check(signal?: AbortSignal): Promise<void>;
  execute(job: SandboxJob, signal: AbortSignal, observe?: (usage: SandboxResourceUsage) => void): Promise<unknown>;
  dispose(): void;
}

const pathAllowed = (name: string) => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) && name.length <= 200 && name.split("/").every(part => part !== "." && part !== "..");
const DRIVER = `import asyncio, base64, importlib.util, inspect, json, os, pathlib, resource, sys
config = json.load(sys.stdin)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_AS, (config['memory'], config['memory']))
resource.setrlimit(resource.RLIMIT_CPU, (config['cpu'], config['cpu'] + 1))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
resource.setrlimit(resource.RLIMIT_FSIZE, (config['scratch'], config['scratch']))
sys.path.insert(0, '/program')
if os.path.isdir('/packages'): sys.path.insert(0, '/packages')
if config['mode'] == 'build':
    for path in pathlib.Path('/program').rglob('*.py'):
        compile(path.read_bytes(), str(path), 'exec')
    result = {'built': True}
else:
    spec = importlib.util.spec_from_file_location('__harness_entry__', '/program/' + config['entry'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    value = config['input']
    value['_files'] = {name: '/input/' + name for name in config['assets']}
    result = module.run(value)
    if inspect.isawaitable(result): result = asyncio.run(result)
encoded = json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
if len(encoded.encode('ascii')) > config['outputBytes']: raise ValueError('Output budget exceeded')
sys.stdout.write(encoded)
`;

async function fileDigest(path: string): Promise<SandboxDigest> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}
async function command(args: string[], parent: AbortSignal, limit = 1048576): Promise<string> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15000)]); signal.throwIfAborted();
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const stop = () => child.kill("SIGKILL"); signal.addEventListener("abort", stop, { once: true });
  const bounded = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        bytes += chunk.length; if (bytes > limit) { child.kill(); throw Error("Runtime probe output limit"); } chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [out, , exit] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
    signal.throwIfAborted(); if (exit !== 0) throw Error("Python runtime dependency probe failed");
    return out;
  } finally { signal.removeEventListener("abort", stop); stop(); await child.exited; }
}

/** Linux-only trusted adapter. It is never installed implicitly in the browser
 * runner. The sandbox sees selected read-only runtime bytes, job code/assets and
 * bounded tmpfs scratch, with no host home, vault, gateway env or network. */
export async function createPythonSandboxRuntime(options: PythonRuntimeOptions = {}): Promise<SandboxPythonRuntime> {
  if (process.platform !== "linux") throw Error("Python isolation requires Linux Bubblewrap");
  const setup = AbortSignal.timeout(120000), parent = await resourceParent(options.cgroupRoot);
  const probeScope = await createResourceScope(parent, { wallMs: 1000, requests: 0, outputBytes: 1 });
  await probeScope.close();
  const python = await realpath(options.python ?? "/usr/bin/python3"), bubblewrap = await realpath(options.bubblewrap ?? "/usr/bin/bwrap");
  const information = JSON.parse(await command([python, "-s", "-S", "-B", "-c", "import json,sys,sysconfig; print(json.dumps({'version':sys.version,'minor':str(sys.version_info[0])+'.'+str(sys.version_info[1]),'stdlib':sysconfig.get_path('stdlib')}))"], setup));
  const stdlib = await realpath(information.stdlib), packages = options.packages ? await realpath(options.packages) : undefined, models = options.models ? await realpath(options.models) : undefined;
  const tools: Record<string, string> = {};
  for (const [name, path] of Object.entries(options.tools ?? {})) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw Error("Invalid Python runtime tool name");
    tools[name] = await realpath(path);
  }
  const libraries = new Map<string, string>();
  const unresolvedLibraries = new Set<string>();
  const dynamic = async (path: string) => {
    const file = await open(path, "r"), header = Buffer.alloc(4);
    try { await file.read(header, 0, 4, 0); } finally { await file.close(); }
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return;
    const text = await command(["/usr/bin/ldd", path], setup);
    for (const line of text.split("\n")) {
      const missing = line.match(/^\s*(\S+)\s+=>\s+not found/);
      if (missing) unresolvedLibraries.add(missing[1]!);
      const target = line.match(/=>\s+(\/[^\s]+)/)?.[1] ?? line.match(/^\s*(\/[^\s]+)/)?.[1];
      if (target) {
        const source = await realpath(target);
        libraries.set(target, source);
        // The ELF interpreter may be reported as an absolute alias on the left
        // of =>. execve needs that path even when ldd resolves it elsewhere.
        const alias = line.match(/^\s*(\/[^\s]+)\s+=>/)?.[1];
        if (alias) libraries.set(alias, source);
      }
    }
  };
  await Promise.all([python, ...Object.values(tools)].map(dynamic));
  for (const path of options.sharedLibraries ?? []) {
    if (!path.startsWith("/") || !/\.so(?:\.|$)/.test(path)) throw Error("Invalid configured shared library path");
    const source = await realpath(path);
    libraries.set(path, source);
    libraries.set(source, source);
    await dynamic(source);
  }
  const extensions = async (root: string, omitPackages = false) => {
    const visit = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (omitPackages && path === root && ["site-packages", "dist-packages"].includes(entry.name)) continue;
        const full = join(path, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile() && /\.so(?:\.|$)/.test(entry.name)) await dynamic(full);
      }
    };
    await visit(root);
  };
  await extensions(stdlib, true);
  if (packages) await extensions(packages);
  // Wheel-private libraries can resolve through the importing extension's
  // RPATH while a standalone ldd on that library has no such search path.
  for (const name of unresolvedLibraries) {
    if (![...libraries.keys()].some(path => path.endsWith(`/${name}`))) throw Error("Python runtime dependency unavailable");
  }
  const image = new SealedRuntimeImage(2 * 1024 ** 3, 16384, true);
  // This trusted bootstrap runs only after admission to the job cgroup. Stock
  // Bubblewrap limits all expanded arguments to 9000; one private root snapshot
  // handles large native package trees without modifying that utility.
  // The host/supervisor is trusted. Copies are private and read-only to guests,
  // not a defence against a hostile host process with the supervisor's UID.
  const LAUNCH = `import os, sys, json, hashlib, stat, zlib
token = os.read(3, 1)
os.close(3)
if token != bytes([1]): raise RuntimeError('Resource admission failed')
with os.fdopen(4, 'r') as stream: spec = json.load(stream)
root = spec['root']
info = os.lstat(root)
if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
    raise RuntimeError('Private snapshot root unavailable')
if len(spec['files']) > 16576 or sum(item['bytes'] for item in spec['files']) > 2 * 1024**3 + 64 * 1024**2:
    raise RuntimeError('Snapshot capacity exceeded')
def target(name):
    if not name.startswith('/') or name == '/' or any(p in ('', '.', '..') for p in name[1:].split('/')):
        raise RuntimeError('Invalid snapshot path')
    return root + name
for name in spec['directories']:
    os.makedirs(target(name), mode=0o700, exist_ok=True)
for item in spec['files']:
    destination = target(item['path'])
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    count = 0
    digest = hashlib.sha256()
    try:
        encoding = item.get('encoding', 'raw')
        if encoding not in ('raw', 'deflate'): raise RuntimeError('Unknown snapshot encoding')
        decoder = zlib.decompressobj(-15) if encoding == 'deflate' else None
        stored = 0
        while True:
            packed = os.read(item['fd'], 262144)
            if not packed: break
            stored += len(packed)
            if stored > item['storedBytes']: raise RuntimeError('Snapshot storage growth')
            while packed:
                chunk = decoder.decompress(packed, 262144) if decoder else packed
                packed = decoder.unconsumed_tail if decoder else b''
                count += len(chunk)
                if count > item['bytes']: raise RuntimeError('Snapshot source growth')
                digest.update(chunk)
                offset = 0
                while offset < len(chunk): offset += os.write(descriptor, chunk[offset:])
                if decoder and decoder.unused_data: raise RuntimeError('Trailing compressed bytes')
        if stored != item['storedBytes'] or decoder and not decoder.eof:
            raise RuntimeError('Truncated snapshot storage')
        if count != item['bytes'] or 'sha256:' + digest.hexdigest() != item['digest']:
            raise RuntimeError('Snapshot integrity mismatch')
        os.fchmod(descriptor, item['mode'])
    finally:
        os.close(descriptor)
        os.close(item['fd'])
for name in ('/work', '/dev', '/proc', '/tools'):
    os.makedirs(target(name), mode=0o700, exist_ok=True)
os.symlink('/work/tmp', target('/tmp'))
descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
if descriptor != 4:
    os.dup2(descriptor, 4, inheritable=True)
    os.close(descriptor)
else: os.set_inheritable(4, True)
os.execv(sys.argv[1], sys.argv[1:])
`;
  try {
    const stdlibTarget = `/runtime/lib/python${information.minor}`;
    const pythonDigest = await image.file(python, "/runtime/bin/python", setup);
    await image.tree(stdlib, stdlibTarget, { omit: ["site-packages", "dist-packages"], omitBytecodeCache: true, signal: setup });
    if (packages) await image.tree(packages, "/packages", { omitBytecodeCache: true, signal: setup });
    if (models) await image.tree(models, "/models", { signal: setup });
    const libraryDigests: Record<string, SandboxDigest> = {}, toolDigests: Record<string, SandboxDigest> = {};
    const targetOf = (path: string) => {
      const absolute = resolve(path);
      for (const [source, target] of [[packages, "/packages"], [stdlib, stdlibTarget]] as const)
        if (source && (absolute === source || absolute.startsWith(source + "/"))) return join(target, relative(source, absolute));
      return absolute;
    };
    for (const [target, source] of libraries) {
      const destination = targetOf(target);
      if (!image.has(destination)) libraryDigests[destination] = await image.file(source, destination, setup);
    }
    for (const [name, path] of Object.entries(tools)) toolDigests[name] = await image.file(path, `/tools/${name}`, setup);
    const driverDigest = await image.bytes("/driver.py", Buffer.from(DRIVER)), imageDigest = await image.seal(), entries = image.entries();
    const subset = (path: string) => sandboxDigest(entries.filter(entry => entry.path.startsWith(path + "/")));
    const policy = { version: 2, guestRuntime: "sealed-deflate-memfd-private-snapshot", snapshotTrust: "trusted-host-and-supervisor", snapshotAccounting: "per-job-cgroup", resources: "cgroup-v2", cpuQuota: resourceCpuMax, swap: 0, oomGroup: true, childUserNamespaces: false, rootReadOnly: true, scratch: "work-and-shm-partitions" };
    const lock: PythonRuntimeLock = Object.freeze({ version: 2, imageDigest, resourcePolicyDigest: await sandboxDigest([policy, LAUNCH]), platform: process.platform, architecture: process.arch, pythonVersion: information.version, pythonDigest, stdlibDigest: await subset(stdlibTarget), libraries: Object.freeze(libraryDigests), tools: Object.freeze(toolDigests), packagesDigest: packages ? await subset("/packages") : null, modelsDigest: models ? await subset("/models") : null, driverDigest, isolationDigest: await fileDigest(bubblewrap) });
    const lockDigest = await sandboxDigest(lock);
    const check = async (signal?: AbortSignal) => { signal?.throwIfAborted(); image.check(); if (await fileDigest(bubblewrap) !== lock.isolationDigest) throw Error("Trusted isolation utility changed"); signal?.throwIfAborted(); };
    const execute = async (job: SandboxJob, cancellation: AbortSignal, observe?: (usage: SandboxResourceUsage) => void): Promise<unknown> => {
      const signal = AbortSignal.any([cancellation, AbortSignal.timeout(job.budget.wallMs)]), artifact = job.artifact as Extract<SandboxArtifact, { kind: "python" }>;
      if (artifact.kind !== "python" || artifact.runtimeLockDigest !== lockDigest) throw Error("Python runtime lock mismatch");
      if (job.authority.origins.length || job.authority.methods.length || job.budget.requests !== 0) throw Error("Python execution has no network capability");
      if (Object.hasOwn(job.input, "_files")) throw Error("Reserved Python input field");
      const modules = Object.entries(artifact.modules), assets = Object.entries(job.assets ?? {});
      if (!modules.length || modules.length > 64 || assets.length > 128 || !Object.hasOwn(artifact.modules, artifact.entry)) throw Error("Python entry or input capacity unavailable");
      const memory = job.budget.memoryBytes ?? 536870912, processes = job.budget.processes ?? 32, scratch = job.budget.scratchBytes ?? 67108864;
      if (!Number.isSafeInteger(memory) || memory < 67108864 || memory > 8589934592 || !Number.isInteger(processes) || processes < 2 || processes > 128 || !Number.isSafeInteger(scratch) || scratch < 1048576 || scratch > 536870912) throw Error("Invalid Python resource budget");
      await check(signal);
      const privateImage = new SealedRuntimeImage(64 * 1024 ** 2, 192), argsImage = new SealedRuntimeImage(4 * 1024 ** 2, 1);
      let runtimeLease: ReturnType<SealedRuntimeImage["lease"]> | undefined, privateLease: typeof runtimeLease, argsLease: typeof runtimeLease;
      let scope: Awaited<ReturnType<typeof createResourceScope>> | undefined, gate: ReturnType<typeof resourceGate> | undefined;
      let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined, usage: SandboxResourceUsage | undefined;
      let staging: string | undefined;
      let failure: unknown, output: unknown, monitor: ReturnType<typeof setTimeout> | undefined, watching = false;
      const stop = () => { child?.kill("SIGKILL"); if (scope) void scope.kill().catch(() => {}); };
      try {
        privateImage.directory("/program"); privateImage.directory("/input");
        for (const [name, module] of modules) { signal.throwIfAborted(); if (!pathAllowed(name) || !name.endsWith(".py") || module.digest !== await sandboxDigest(module.source)) throw Error("Python source pin mismatch"); await privateImage.bytes(`/program/${name}`, Buffer.from(module.source)); }
        let inputBytes = 0;
        for (const [name, asset] of assets) {
          signal.throwIfAborted(); if (!pathAllowed(name) || typeof asset.data !== "string") throw Error("Invalid Python asset name");
          const bytes = Buffer.from(asset.data, "base64");
          if (bytes.toString("base64") !== asset.data || bytes.length !== asset.bytes || (inputBytes += bytes.length) > 48 * 1024 ** 2 || await sandboxDigest(asset.data) !== asset.digest) throw Error("Python asset pin or byte limit mismatch");
          await privateImage.bytes(`/input/${name}`, bytes);
        }
        await privateImage.seal(); runtimeLease = image.lease(5); privateLease = privateImage.lease(5 + runtimeLease.fds.length);
        staging = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "unlock-python-snapshot-")); await chmod(staging, 0o700);
        const shm = Math.floor(scratch / 4 / 4096) * 4096, work = Math.floor((scratch - shm) / 4096) * 4096;
        const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--ro-bind-fd", "4", "/",
          "--size", String(work), "--tmpfs", "/work", "--dir", "/work/tmp", "--proc", "/proc", "--dev", "/dev", "--size", String(shm), "--tmpfs", "/dev/shm", "--remount-ro", "/dev", "--remount-ro", "/",
          "--setenv", "PYTHONHOME", "/runtime", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "PATH", "/tools", "--setenv", "HOME", "/work", "--setenv", "TMPDIR", "/tmp", "--setenv", "LC_ALL", "C.UTF-8", "--setenv", "HF_HUB_OFFLINE", "1", "--setenv", "OMP_NUM_THREADS", "2", "--setenv", "OPENBLAS_NUM_THREADS", "2", "--chdir", "/work"];
        await argsImage.bytes("/arguments", Buffer.from(JSON.stringify({ root: staging, files: [...runtimeLease.files, ...privateLease.files], directories: [...new Set([...runtimeLease.directories, ...privateLease.directories])] }))); await argsImage.seal(); argsLease = argsImage.lease(4);
        scope = await createResourceScope(parent, job.budget); gate = resourceGate(); signal.throwIfAborted();
        child = Bun.spawn([python, "-I", "-S", "-B", "-c", LAUNCH, bubblewrap, ...args, "--", "/runtime/bin/python", "-s", "-S", "-B", "/driver.py"], { stdio: ["pipe", "pipe", "pipe", gate.read, ...argsLease.fds, ...runtimeLease.fds, ...privateLease.fds], env: {} });
        signal.addEventListener("abort", stop, { once: true });
        await scope.admit(child.pid); signal.throwIfAborted(); gate.release(); gate.close();
        watching = true;
        const watch = async () => { try { if (!watching) return; if (await scope!.cpuUsec() > job.budget.wallMs * 1000) { stop(); return; } if (watching) monitor = setTimeout(watch, 25); } catch { if (watching) stop(); } }; monitor = setTimeout(watch, 25);
        const read = async (stream: ReadableStream<Uint8Array>, limit: number) => {
          const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
          try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > limit) { stop(); throw Error("Python output limit exceeded"); } chunks.push(value); } }
          finally { reader.releaseLock(); } return Buffer.concat(chunks);
        };
        const stdout = read(child.stdout, job.budget.outputBytes), stderr = read(child.stderr, 8192);
        const exited = child.exited.then(async code => { await scope!.kill(); return code; });
        const settled = Promise.all([stdout, stderr, exited]); void settled.catch(() => {});
        child.stdin.write(JSON.stringify({ entry: artifact.entry, input: job.input, assets: assets.map(([name]) => name), mode: job.mode ?? "run", memory, scratch, cpu: Math.max(1, Math.ceil(job.budget.wallMs / 1000)), outputBytes: job.budget.outputBytes })); await child.stdin.end();
        const [bytes, , exit] = await settled; signal.throwIfAborted();
        if (exit !== 0) throw Error("Isolated Python execution failed"); output = JSON.parse(bytes.toString("utf8")); sandboxCanonical(output);
      } catch (error) { failure = error; }
      finally {
        watching = false; if (monitor) clearTimeout(monitor); signal.removeEventListener("abort", stop); stop();
        if (child) await child.exited; gate?.close();
        try { if (scope) { usage = await scope.close(); observe?.(usage); } } catch (error) { failure ??= error; }
        if (staging && (!child || usage?.cleaned)) try { await rm(staging, { recursive: true, force: true }); } catch (error) { failure ??= error; }
        argsLease?.release(); privateLease?.release(); runtimeLease?.release(); argsImage.dispose(); privateImage.dispose();
      }
      signal.throwIfAborted();
      if (failure) throw failure;
      if (!usage?.cleaned || usage.oomKills || usage.processLimitHits || usage.cpuUsec > job.budget.wallMs * 1000) throw Error("Python aggregate resource budget violated");
      return output;
    };
    return { lock, lockDigest, capture: { files: entries.length, sourceBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), retainedBytes: entries.reduce((sum, entry) => sum + entry.storedBytes, 0) }, check, execute, dispose: () => image.dispose() };
  } catch (error) { image.dispose(); throw error; }
}
