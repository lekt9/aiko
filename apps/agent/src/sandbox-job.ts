/** Portable wire contract. Authorization and native effect ownership stay in the actor. */
export type SandboxDigest = `sha256:${string}`;
export type SandboxArtifact =
  | { kind: "python"; entry: string; modules: Record<string, { source: string; digest: SandboxDigest }>; runtimeLockDigest: SandboxDigest }
  | { kind: "library"; entry: string; modules: Record<string, { source: string; digest: SandboxDigest }> }
  | { kind: "code"; code: string }
  | { kind: "network"; graph: import("@unbrowse/browser-harness/harness-artifact").SiteHarnessArtifact; actionId: string };
export interface SandboxJob {
  version: 1;
  operationId: string;
  owner: string;
  contextRef: string;
  authorityRef: string;
  artifact: SandboxArtifact;
  harnessDigest: SandboxDigest;
  dependencyLock: Record<string, SandboxDigest>;
  dependencyLockDigest: SandboxDigest;
  environmentDigest: SandboxDigest;
  input: Record<string, unknown>;
  /** Private binary inputs are hydrated by an owner-scoped host binding. Names
   * are sandbox-relative, never host paths; bytes are bound into the job digest. */
  assets?: Record<string, { data: string; digest: SandboxDigest; bytes: number }>;
  mode?: "build" | "run";
  authority: { origins: string[]; methods: string[] };
  budget: { wallMs: number; requests: number; outputBytes: number; memoryBytes?: number; processes?: number; scratchBytes?: number };
}
export interface SandboxJobReceipt {
  operationId: string;
  jobDigest: SandboxDigest;
  harnessDigest: SandboxDigest;
  environmentDigest: SandboxDigest;
  status: "completed" | "failed" | "unknown";
  output?: unknown;
  outputDigest?: SandboxDigest;
  builtArtifact?: Extract<SandboxArtifact, { kind: "code" }>;
  builtDigest?: SandboxDigest;
  reason?: string;
  requests: number;
  browserStarts: 0;
  /** Kernel observations minted by the trusted Python supervisor. */
  resources?: import("./sandbox-resources.ts").SandboxResourceUsage;
}
export function sandboxArtifactDependencies(artifact: SandboxArtifact): Record<string, SandboxDigest> {
  if (artifact.kind !== "library" && artifact.kind !== "python") return {};
  return { ...Object.fromEntries(Object.entries(artifact.modules).map(([name, module]) => [name, module.digest])), ...(artifact.kind === "python" ? { "runtime:python": artifact.runtimeLockDigest } : {}) };
}
export function sandboxCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sandboxCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${sandboxCanonical((value as any)[k])}`).join(",")}}`;
  throw Error("Sandbox values must be JSON");
}
export async function sandboxDigest(value: unknown): Promise<SandboxDigest> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sandboxCanonical(value)));
  return `sha256:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("")}`;
}
export async function verifySandboxReceipt(job: SandboxJob, receipt: SandboxJobReceipt) {
  if (!receipt || !["completed", "failed", "unknown"].includes(receipt.status) || !Number.isInteger(receipt.requests) || receipt.requests < 0 || receipt.requests > job.budget.requests || receipt.browserStarts !== 0 ||
      (receipt.status === "completed" ? !Object.hasOwn(receipt, "output") : receipt.output !== undefined || receipt.outputDigest !== undefined) ||
      (receipt.reason !== undefined && (typeof receipt.reason !== "string" || receipt.reason.length > 512))) throw Error("Sandbox receipt shape mismatch");
  const usage = receipt.resources;
  if (usage !== undefined) {
    if (job.artifact.kind !== "python" || usage.version !== 1 || usage.backend !== "cgroup-v2" || usage.cleaned !== true ||
        usage.memoryLimitBytes !== (job.budget.memoryBytes ?? 536870912) || usage.processLimit !== (job.budget.processes ?? 32) || usage.scratchLimitBytes !== (job.budget.scratchBytes ?? 67108864) ||
        [usage.memoryPeakBytes, usage.cpuUsec, usage.oomKills, usage.processLimitHits, ...(usage.processPeak === null ? [] : [usage.processPeak])].some(value => !Number.isSafeInteger(value) || value < 0) ||
        (receipt.status === "completed" && (usage.oomKills !== 0 || usage.processLimitHits !== 0 || usage.cpuUsec > job.budget.wallMs * 1000))) throw Error("Sandbox resource evidence mismatch");
  }
  if (job.artifact.kind === "python" && receipt.status === "completed" && !usage) throw Error("Sandbox resource evidence unavailable");
  if (receipt.operationId !== job.operationId || receipt.jobDigest !== await sandboxDigest(job) || receipt.harnessDigest !== job.harnessDigest || receipt.environmentDigest !== job.environmentDigest ||
      receipt.outputDigest !== (receipt.output === undefined ? undefined : await sandboxDigest(receipt.output)) ||
      receipt.builtDigest !== (receipt.builtArtifact === undefined ? undefined : await sandboxDigest(receipt.builtArtifact))) throw Error("Sandbox receipt integrity mismatch");
  return receipt;
}
