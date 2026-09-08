import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, open, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPythonSandboxRuntime, type SandboxPythonRuntime } from "../src/sandbox-python.ts";
import { SealedRuntimeImage } from "../src/sandbox-runtime-image.ts";
import { runSandboxJob, sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { sandboxArtifactDependencies, sandboxDigest, verifySandboxReceipt, type SandboxJob } from "../src/sandbox-job.ts";

let runtime: SandboxPythonRuntime, directory: string, db: Database;
let binding: Parameters<typeof runSandboxJob>[1];
beforeAll(async () => {
  directory = await mkdtemp("/tmp/unlock-python-tests-");
  runtime = await createPythonSandboxRuntime({ temporaryRoot: directory });
  db = new Database(join(directory, "jobs.sqlite"));
  binding = { owner: "python-owner", environmentDigest: await sandboxEnvironment("python-resource-test-v2"), python: runtime, journal: await sandboxJobJournal(db, join(directory, "key")) };
}, 30000);
afterAll(async () => { runtime?.dispose(); db?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function job(source: string, budget: Partial<SandboxJob["budget"]> = {}, selected = runtime): Promise<SandboxJob> {
  const artifact = { kind: "python" as const, entry: "main.py", modules: { "main.py": { source, digest: await sandboxDigest(source) } }, runtimeLockDigest: selected.lockDigest };
  const dependencyLock = sandboxArtifactDependencies(artifact);
  return { version: 1, owner: binding.owner, operationId: crypto.randomUUID(), contextRef: "private-context", authorityRef: "pure-compute", artifact, harnessDigest: await sandboxDigest(artifact), dependencyLock, dependencyLockDigest: await sandboxDigest(dependencyLock), environmentDigest: binding.environmentDigest, input: {}, authority: { origins: [], methods: [] }, budget: { wallMs: 10000, requests: 0, outputBytes: 8192, ...budget } };
}
async function noStaging() { expect((await readdir(directory)).filter(name => name.startsWith("unlock-python-snapshot-"))).toEqual([]); }

test("actual Python checks read-only roots, denied network, private assets and measured receipt replay", async () => {
  const input = await job(`import os, socket
def run(input):
    denied = []
    for path in ['/program/change.py', '/runtime/change', '/dev/change', '/input/owned.bin']:
        try:
            with open(path, 'wb') as f: f.write(b'x')
            denied.append(False)
        except OSError: denied.append(True)
    network = socket.socket()
    network.settimeout(0.1)
    try:
        network.connect(('198.51.100.1', 80))
        denied.append(False)
    except OSError: denied.append(True)
    network.close()
    descriptors = []
    for name in os.listdir('/proc/self/fd'):
        try: descriptors.append([int(name), os.readlink('/proc/self/fd/' + name)])
        except FileNotFoundError: pass
    return {'denied': denied, 'bytes': list(open(input['_files']['owned.bin'], 'rb').read()), 'fds': [fd for fd, path in descriptors if fd > 2], 'home': os.path.exists('/home/deck')}
`);
  const data = Buffer.from([3, 5, 9]).toString("base64"); input.assets = { "owned.bin": { data, bytes: 3, digest: await sandboxDigest(data) } };
  const receipt = await runSandboxJob(input, binding);
  expect(receipt.status).toBe("completed");
  expect(receipt.output).toEqual({ denied: [true, true, true, true, true], bytes: [3, 5, 9], fds: [], home: false });
  expect(receipt.resources?.memoryPeakBytes).toBeGreaterThan(0); expect(receipt.resources?.cpuUsec).toBeGreaterThan(0);
  expect(receipt.resources?.cleaned).toBe(true); await verifySandboxReceipt(input, receipt);
  expect(await runSandboxJob(input, binding)).toEqual(receipt);
  for (const resources of [undefined, { ...receipt.resources!, cleaned: false }, { ...receipt.resources!, processLimit: 999 }, { ...receipt.resources!, cpuUsec: -1 }])
    await expect(verifySandboxReceipt(input, { ...receipt, resources })).rejects.toThrow("resource evidence");
  await noStaging();
}, 20000);

test("kernel cgroup stops aggregate child memory that fits each process limit", async () => {
  const input = await job(`import os, time
def run(input):
    for n in range(4):
        if os.fork() == 0:
            data = bytearray(96 * 1024 * 1024)
            time.sleep(30)
            os._exit(0)
    for n in range(4): os.wait()
    return True
`, { memoryBytes: 256 * 1024 ** 2, processes: 16 });
  const receipt = await runSandboxJob(input, binding);
  expect(receipt.status).toBe("failed"); expect(receipt.resources?.oomKills).toBeGreaterThan(0);
  expect(receipt.resources?.cleaned).toBe(true); await verifySandboxReceipt(input, receipt); await noStaging();
}, 20000);

test("kernel cgroup bounds descendants even when the guest catches fork refusal", async () => {
  const receipt = await runSandboxJob(await job(`import os, time
def run(input):
    try:
        for n in range(30):
            if os.fork() == 0:
                time.sleep(30)
                os._exit(0)
    except OSError: return 'fork refused'
    return 'unbounded'
`, { processes: 8 }), binding);
  expect(receipt.status).toBe("failed"); expect(receipt.resources?.processLimitHits).toBeGreaterThan(0);
  expect(receipt.resources?.cleaned).toBe(true); await noStaging();
}, 20000);

test("scratch bounds apply across files and cancellation reaps subprocesses", async () => {
  const receipt = await runSandboxJob(await job(`def run(input):
    stored = 0
    try:
        for n in range(100):
            with open('/work/file-' + str(n), 'wb') as stream:
                stored += stream.write(b'x' * 1024 * 1024)
    except OSError: return {'bounded': True, 'bytes': stored}
    return {'bounded': False, 'bytes': stored}
`, { scratchBytes: 16 * 1024 ** 2 }), binding);
  expect(receipt.status).toBe("completed"); expect((receipt.output as any).bounded).toBe(true);
  expect((receipt.output as any).bytes).toBeLessThanOrEqual(16 * 1024 ** 2);
  const cancelled = await runSandboxJob(await job(`import os, time
def run(input):
    os.fork()
    time.sleep(30)
    return True
`), binding, AbortSignal.timeout(2000));
  expect(cancelled.status).toBe("failed"); expect(cancelled.reason).toBe("cancelled_or_deadline");
  expect(cancelled.resources?.processPeak).toBeGreaterThanOrEqual(4); expect(cancelled.resources?.cleaned).toBe(true); await noStaging();
}, 20000);

test("large runtime trees remain frozen after original package replacement and support concurrent leases", async () => {
  const packages = join(directory, "packages"); await mkdir(packages);
  await writeFile(join(packages, "fixture_value.py"), "value = 42\n");
  for (let index = 0; index < 3100; index++) await writeFile(join(packages, `data-${index}.txt`), "");
  const selected = await createPythonSandboxRuntime({ packages, temporaryRoot: directory });
  try {
    await writeFile(join(packages, "fixture_value.py"), "value = -1\n"); await selected.check();
    const source = "import fixture_value\ndef run(input): return fixture_value.value\n";
    const receipts = await Promise.all([1, 2].map(async () => runSandboxJob(await job(source, { wallMs: 20000 }, selected), { ...binding, python: selected })));
    expect(receipts.map(receipt => receipt.status)).toEqual(["completed", "completed"]);
    expect(receipts.map(receipt => receipt.output)).toEqual([42, 42]);
    await noStaging();
  } finally { selected.dispose(); }
}, 40000);

test("capture rejects escaping file symlinks and sealing during an unfinished read", async () => {
  const tree = join(directory, "image-tree"), outside = join(directory, "outside");
  await mkdir(tree); await writeFile(outside, "controlled bytes"); await symlink(outside, join(tree, "escape"));
  const escaped = new SealedRuntimeImage();
  try { await expect(escaped.tree(tree, "/package")).rejects.toThrow("escaped"); } finally { escaped.dispose(); }
  const handle = await open(outside, "r"), prototype = Object.getPrototypeOf(handle), original = prototype.read; await handle.close();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  prototype.read = async function (...args: any[]) { enter(); await gate; return original.apply(this, args); };
  const image = new SealedRuntimeImage();
  try {
    const capture = image.file(outside, "/captured"); await entered;
    await expect(image.seal()).rejects.toThrow("pending"); release(); await capture;
    const digest = await image.seal(); expect(await image.seal()).toBe(digest);
    const lease = image.lease(3);
    try { image.dispose(); expect(readFileSync(`/proc/self/fd/${lease.fds[0]}`, "utf8")).toBe("controlled bytes"); }
    finally { lease.release(); }
  } finally { release(); prototype.read = original; image.dispose(); }
});

test("compressed immutable runtime retains exact source bytes after deletion and bounds expanded snapshots", async () => {
  const packages = join(directory, "compressed-packages"); await mkdir(packages);
  const payload = Buffer.alloc(4 * 1024 ** 2, 97);
  await writeFile(join(packages, "payload.bin"), payload);
  await writeFile(join(packages, "fixture_blob.py"), "from pathlib import Path\ndef value(): return Path('/packages/payload.bin').read_bytes()\n");
  const image = new SealedRuntimeImage(8 * 1024 ** 2, 10, true);
  try {
    await image.file(join(packages,"payload.bin"),"/payload"); await image.seal();
    const entry=image.entries()[0]!;
    expect(entry.bytes).toBe(payload.length);
    expect(entry.storedBytes).toBeLessThan(payload.length / 10);
    expect(entry.encoding).toBe("deflate");
    const lease=image.lease(3);
    try {
      expect(()=>lease.args).toThrow("checked snapshot");
      await expect(writeFile(`/proc/self/fd/${lease.fds[0]}`, "corrupt")).rejects.toThrow();
    } finally { lease.release(); }
  } finally { image.dispose(); }
  const bounded=new SealedRuntimeImage(1024,10,true);
  try { await expect(bounded.file(join(packages,"payload.bin"),"/payload")).rejects.toThrow("capacity"); } finally { bounded.dispose(); }
  const selected=await createPythonSandboxRuntime({packages,temporaryRoot:directory});
  try {
    await rm(packages,{recursive:true});
    const receipt=await runSandboxJob(await job("import fixture_blob\ndef run(input):\n data=fixture_blob.value()\n return {'bytes':len(data),'exact':data==b'a'*4194304}\n",{wallMs:20000},selected),{...binding,python:selected});
    expect(receipt.status).toBe("completed");
    expect(receipt.output).toEqual({bytes:4194304,exact:true});
    expect(receipt.resources?.cleaned).toBe(true);
    await noStaging();
  } finally { selected.dispose(); }
},30000);
