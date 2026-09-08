import { mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { SandboxJob } from "./sandbox-job.ts";

export interface SandboxResourceUsage {
  version: 1;
  backend: "cgroup-v2";
  memoryPeakBytes: number;
  cpuUsec: number;
  processPeak: number | null;
  memoryLimitBytes: number;
  processLimit: number;
  scratchLimitBytes: number;
  oomKills: number;
  processLimitHits: number;
  cleaned: boolean;
}
const pairs = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => { const [key, value] = line.trim().split(/\s+/); return [key!, Number(value)]; }));
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
export const resourceCpuMax = "100000 100000";

/** Only a newly created leaf is mutated. The existing delegated hierarchy and
 * other actors' resource settings are never changed by a SandboxJob. */
export async function resourceParent(configured?: string) {
  const mount = await realpath("/sys/fs/cgroup");
  const current = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!current) throw Error("Cgroup v2 resource control unavailable");
  const parent = await realpath(configured ?? (current === "/" ? mount : dirname(join(mount, current))));
  const rel = relative(mount, parent);
  if (rel.startsWith("../") || rel === "..") throw Error("Resource root escaped cgroup mount");
  const controllers = (await readFile(join(parent, "cgroup.subtree_control"), "utf8")).trim().split(/\s+/);
  if (!["cpu", "memory", "pids"].every(name => controllers.includes(name))) throw Error("Delegated CPU, memory and process controllers are required");
  return parent;
}
export async function createResourceScope(parent: string, budget: SandboxJob["budget"]) {
  const path = join(parent, `unlock-python-${crypto.randomUUID()}`), memory = budget.memoryBytes ?? 536870912, processes = budget.processes ?? 32, scratch = budget.scratchBytes ?? 67108864;
  await mkdir(path);
  try {
    for (const [name, value] of Object.entries({ "memory.max": memory, "memory.swap.max": 0, "memory.oom.group": 1, "pids.max": processes, "cpu.max": resourceCpuMax })) await writeFile(join(path, name), String(value));
    // Read back the kernel's accepted limits rather than treating a write or
    // a configuration field as evidence of enforcement.
    for (const [name, value] of Object.entries({ "memory.max": memory, "memory.swap.max": 0, "memory.oom.group": 1, "pids.max": processes, "cpu.max": resourceCpuMax })) if ((await readFile(join(path, name), "utf8")).trim() !== String(value)) throw Error("Resource controller limit mismatch");
  } catch (error) { await rmdir(path); throw error; }
  let removed = false;
  const populated = async () => pairs(await readFile(join(path, "cgroup.events"), "utf8")).populated !== 0;
  const kill = async () => { if (!removed) await writeFile(join(path, "cgroup.kill"), "1"); };
  return {
    path,
    async admit(pid: number) {
      if (!Number.isInteger(pid) || pid <= 0) throw Error("Invalid resource admission process");
      await writeFile(join(path, "cgroup.procs"), String(pid));
      const group = (await readFile(`/proc/${pid}/cgroup`, "utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
      if (!group || await realpath(join("/sys/fs/cgroup", group)) !== path) throw Error("Resource process placement mismatch");
    },
    kill,
    async cpuUsec() { return pairs(await readFile(join(path, "cpu.stat"), "utf8")).usage_usec!; },
    async close(): Promise<SandboxResourceUsage> {
      await kill();
      const deadline = performance.now() + 2000;
      while (await populated()) { if (performance.now() > deadline) throw Error("Sandbox descendant cleanup was not verified"); await pause(); }
      try {
        const cpu = pairs(await readFile(join(path, "cpu.stat"), "utf8")), memoryEvents = pairs(await readFile(join(path, "memory.events"), "utf8")), processEvents = pairs(await readFile(join(path, "pids.events"), "utf8"));
        const usage: SandboxResourceUsage = { version: 1, backend: "cgroup-v2", memoryPeakBytes: Number((await readFile(join(path, "memory.peak"), "utf8")).trim()), cpuUsec: cpu.usage_usec!, processPeak: await readFile(join(path, "pids.peak"), "utf8").then(value => Number(value.trim()), () => null), memoryLimitBytes: memory, processLimit: processes, scratchLimitBytes: scratch, oomKills: memoryEvents.oom_kill!, processLimitHits: processEvents.max!, cleaned: true };
        if ([usage.memoryPeakBytes, usage.cpuUsec, usage.oomKills, usage.processLimitHits, ...(usage.processPeak === null ? [] : [usage.processPeak])].some(value => !Number.isSafeInteger(value) || value < 0)) throw Error("Invalid kernel resource evidence");
        return usage;
      } finally { await rmdir(path); removed = true; }
    },
  };
}
