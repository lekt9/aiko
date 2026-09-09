import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import type { EventLog } from "tardie/core/log";
import type { NativeTool } from "tardie/component/tool";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Codegraff, type SandboxStore } from "./codegraff.ts";
import browserBootstrap from "../assets/bootstrap.sh" with { type: "text" };
import browserInstaller from "../assets/runner.txt" with { type: "text" };

type Machine = { owner: string; phase: "provisioning" | "available"; id?: string };
type Installation = { owner: string; machine: string; artifact: string; state: "dispatching" | "running" | "ready" | "failed"; execId?: string; exitCode?: number };
const installationArtifact = createHash("sha256").update(browserBootstrap).update(browserInstaller).digest("hex");
const installationKey = (machine: string) => `codegraff:compute-cloak:${machine}:${installationArtifact}`;
type Job = { commandDigest: string; owner: string; thread: string; jobId: string; sandboxId: string; execId?: string; state: "dispatching" | "running" | "completed" | "cancelled"; exitCode?: number };
const identity = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw Error("Invalid compute identity");
  return value;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const EXPORT_LIMIT_BYTES = 50 * 1024 * 1024;
const EXPORT_SCRIPT = `import base64, hashlib, json, sys
from pathlib import Path
job = json.loads(Path(sys.argv[1]).read_text())
src = Path(job["path"])
prefix = Path(job["outPrefix"])
limit = int(job["limitBytes"])
if src.is_symlink() or not src.is_file():
    raise SystemExit("not_a_regular_file")
resolved = src.resolve()
text = str(resolved)
if not (text.startswith("/tmp/") or text.startswith("/home/")):
    raise SystemExit("path_not_allowed")
size = resolved.stat().st_size
if size < 1 or size > limit:
    raise SystemExit("size_out_of_range")
data = resolved.read_bytes()
if len(data) != size:
    raise SystemExit("size_changed")
(prefix.with_name(prefix.name + ".meta.json")).write_text(
    json.dumps({"version": 1, "size": size, "sha256": hashlib.sha256(data).hexdigest()}),
    encoding="ascii",
)
(prefix.with_name(prefix.name + ".payload.b64")).write_text(base64.b64encode(data).decode("ascii"), encoding="ascii")
print("aiko-export-ready")
`;

/** Owned compute-VM paths only. Host filesystem, URLs and parent traversal are rejected. */
export function computeExportPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 5 || value.length > 255)
    throw Error("Invalid sandbox file path");
  if (
    value.includes("\0") ||
    value.includes("//") ||
    value.split("/").includes("..") ||
    value.endsWith("/") ||
    !(value.startsWith("/tmp/") || value.startsWith("/home/")) ||
    !/^\/(?:tmp|home)\/[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value)
  )
    throw Error("Sandbox media must be an owned /tmp or /home file");
  return value;
}

/** Account-owned general compute, separate from the browser VM and its cookies.
 * Gateway credentials never enter the VM. Durable dispatch markers prevent
 * a restarted actor from repeating an uncertain command (including paid APIs).
 * Disk is intentionally retained across the provider's idle stop.
 */
export interface ComputeStore extends SandboxStore {
  claim?(key: string, value: unknown): Promise<boolean>;
}
export class SandboxCompute {
  private waking?: Promise<string>;
  private launches = new Map<string, { digest: string; promise: Promise<unknown> }>();
  constructor(readonly owner: string, readonly gateway: Codegraff, readonly store: ComputeStore, readonly lifecycle: {autoStopMinutes?:number} = {}) {
    if(lifecycle.autoStopMinutes!==undefined&&(!Number.isInteger(lifecycle.autoStopMinutes)||lifecycle.autoStopMinutes<1||lifecycle.autoStopMinutes>30))throw Error("Invalid compute idle budget");
  }
  private async machine() {
    const machine = await this.store.get<Machine>("codegraff:compute");
    if (machine && machine.owner !== this.owner) throw Error("Compute owner mismatch");
    return machine;
  }
  async status(signal?: AbortSignal) {
    const machine = await this.machine();
    if (!machine && !this.store.claim) return { available:false,state:"unavailable",reason:"Atomic compute custody unavailable" };
    if (!machine) return { available: true, state: "unallocated", runtime: "Codegraff command sandbox", credentials: "No host credentials or browser cookies are injected" };
    if (!machine.id) return { available: false, state: "unknown", reason: "Sandbox creation was interrupted; do not allocate another automatically" };
    const current = await this.gateway.request(`/v1/sandboxes/${identity(machine.id)}`, undefined, signal);
    const installation = await this.store.get<Installation>(installationKey(machine.id));
    if (!installation || installation.owner !== this.owner || installation.state !== "ready") return { available: false, state: "provisioning", sandboxId: machine.id, setupState: installation?.state ?? "required", ...(installation?.execId ? { setupExecId: installation.execId } : {}) };
    return { available: true, state: String(current.state ?? current.status ?? "unknown"), runtime: "Codegraff command sandbox", credentials: "No host credentials or browser cookies are injected" };
  }
  /** Control-plane access for trusted file-backed harness adapters only. */
  ensureMachine(signal: AbortSignal): Promise<string> { return this.ensure(signal); }
  private ensure(signal: AbortSignal): Promise<string> {
    if (!this.waking) this.waking = this.wake(AbortSignal.any([signal, AbortSignal.timeout(600_000)])).finally(() => { this.waking = undefined; });
    return this.waking;
  }
  private async wake(signal: AbortSignal) {
    let machine = await this.machine();
    if (machine && !machine.id) throw Error("Compute creation outcome unknown; inspect provider state before retrying");
    if (!machine) {
      if (!this.store.claim) throw Error("Atomic compute custody unavailable");
      if (!await this.store.claim("codegraff:compute", { owner: this.owner, phase: "provisioning" })) throw Error("Compute allocation already claimed; reconcile existing machine");
      const created = await this.gateway.request("/v1/sandboxes", { language: "javascript", autoStopMinutes: this.lifecycle.autoStopMinutes ?? 30 }, signal);
      machine = { owner: this.owner, phase: "provisioning", id: identity(created.id) };
      await this.store.put("codegraff:compute", machine);
    } else {
      const current = await this.gateway.request(`/v1/sandboxes/${identity(machine.id)}`, undefined, signal);
      const state = String(current.state ?? current.status);
      if (["stopped", "archived"].includes(state)) {
        await this.gateway.request(`/v1/sandboxes/${machine.id}/start`, {}, signal);
        for (let attempt = 0; ; attempt++) {
          const current = await this.gateway.request(`/v1/sandboxes/${machine.id}`, undefined, signal);
          if (["started", "running"].includes(String(current.state ?? current.status))) break;
          if (attempt >= 60) throw Error("Compute start unconfirmed; retain existing VM");
          await delay(1000, undefined, { signal });
        }
      }
      else if (!["started", "running"].includes(state)) throw Error(`Compute is ${state}; check sandbox_status before retrying`);
    }
    await this.installBrowser(machine.id!, signal);
    await this.store.put("codegraff:compute", { ...machine, phase: "available" });
    return machine.id!;
  }
  private async installBrowser(machine: string, signal: AbortSignal) {
    const key = installationKey(machine);
    let receipt = await this.store.get<Installation>(key);
    if (!receipt) {
      if (!this.store.claim) throw Error("Atomic compute custody unavailable");
      // Uploads are repeatable; command dispatch is claimed before any execution.
      const base = `/tmp/aiko-compute-cloak-${installationArtifact}`;
      for (const [path, text] of [[`${base}.sh`, browserBootstrap], [`${base}.js`, browserInstaller]]) {
        await this.gateway.request(`/v1/sandboxes/${machine}/upload`, { path, contentBase64: Buffer.from(text!).toString("base64") }, signal);
      }
      receipt = { owner: this.owner, machine, artifact: installationArtifact, state: "dispatching" };
      if (await this.store.claim(key, receipt)) {
        try {
          const result = await this.gateway.request(`/v1/sandboxes/${machine}/exec`, {
            command: `bash ${base}.sh --compute && /home/daytona/.bun/bin/bun ${base}.js install`, async: true,
          }, signal);
          receipt.execId = identity(result.execId);
          receipt.state = "running";
          await this.store.put(key, receipt);
        } catch { throw Error("CloakBrowser setup dispatch unknown; retained VM must be reconciled, no automatic reinstall"); }
      } else receipt = await this.store.get<Installation>(key);
    }
    if (!receipt || receipt.owner !== this.owner || receipt.machine !== machine || receipt.artifact !== installationArtifact) throw Error("CloakBrowser setup custody mismatch");
    if (receipt.state === "ready") return;
    if (!receipt.execId) throw Error("CloakBrowser setup dispatch unknown; no automatic reinstall");
    if (receipt.state === "failed") throw Error(`CloakBrowser setup failed (${receipt.exitCode}); inspect retained exec ${receipt.execId}, no automatic reinstall`);
    for (;;) {
      signal.throwIfAborted();
      const result = await this.gateway.request(`/v1/sandboxes/${machine}/exec/${identity(receipt.execId)}?tail=4096`, undefined, signal);
      if (result.state === "completed" && Number.isInteger(result.exitCode)) {
        receipt.exitCode = result.exitCode;
        receipt.state = result.exitCode === 0 ? "ready" : "failed";
        await this.store.put(key, receipt);
        if (receipt.state === "failed") throw Error(`CloakBrowser setup failed (${receipt.exitCode}); inspect retained exec ${receipt.execId}, no automatic reinstall`);
        return;
      }
      if (result.state !== "running") throw Error("CloakBrowser setup status unavailable; reconcile retained exec");
      await delay(1000, undefined, { signal });
    }
  }
  async exec(thread: string, invocation: string, args: { command: string; cwd?: string }, signal: AbortSignal) {
    if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 64000 ||
        args.command.includes("\0") || args.cwd !== undefined && (typeof args.cwd !== "string" || args.cwd.length > 1000 || args.cwd.includes("\0"))) throw Error("Invalid command or working directory");
    args = structuredClone(args);
    const commandDigest = digest([args.command, args.cwd ?? ""]);
    const jobId = digest([this.owner, thread, invocation]);
    const active = this.launches.get(jobId);
    if (active) {
      if (active.digest !== commandDigest) throw Error("Compute command identity conflict");
      return active.promise;
    }
    const launch = this.launch(thread, jobId, args, signal).finally(() => this.launches.delete(jobId));
    this.launches.set(jobId, {digest:commandDigest,promise:launch});
    return launch;
  }
  private async launch(thread: string, jobId: string, args: { command: string; cwd?: string }, signal: AbortSignal) {
    const previous = await this.store.get<Job>(`codegraff:compute-job:${jobId}`);
    const commandDigest = digest([args.command, args.cwd ?? ""]);
    if (previous) {
      if (previous.commandDigest !== commandDigest) throw Error("Compute command identity conflict");
      return this.poll(thread, jobId, signal);
    }
    if (!this.store.claim) throw Error("Atomic compute custody unavailable");
    const sandboxId = await this.ensure(signal);
    signal.throwIfAborted();
    const job: Job = { commandDigest, owner: this.owner, thread, jobId, sandboxId, state: "dispatching" };
    if (!await this.store.claim(`codegraff:compute-job:${jobId}`, job)) {
      const claimed = await this.store.get<Job>(`codegraff:compute-job:${jobId}`);
      if (claimed?.commandDigest !== commandDigest) throw Error("Compute command identity conflict");
      return this.poll(thread, jobId, signal);
    }
    // Never use synchronous exec: builds and provider generation can exceed the gateway's ~95s cap.
    try {
      const result = await this.gateway.request(`/v1/sandboxes/${sandboxId}/exec`, { command: args.command, ...(args.cwd ? { cwd: args.cwd } : {}), async: true }, signal);
      job.execId = identity(result.execId);
      job.state = "running";
      await this.store.put(`codegraff:compute-job:${jobId}`, job);
    } catch {
      return { jobId, state: "unknown", reason: "Command dispatch was interrupted. Do not rerun: it may have executed." };
    }
    return this.poll(thread, jobId, signal);
  }
  /** Fresh provider evidence for trusted reconciliation. A cached cancellation
   * is only its DELETE acknowledgement; it cannot prove that execution ended.
   * This observes the existing mapping without changing cancellation or dispatch state. */
  async confirmTerminal(thread: string, jobId: string, signal: AbortSignal): Promise<
    {jobId:string;state:"running"|"unknown"} | {jobId:string;state:"completed";exitCode:number}
  > {
    signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw Error("Invalid job reference");
    const key = `codegraff:compute-job:${jobId}`, job = await this.store.get<Job>(key);
    if (!job || job.owner !== this.owner || job.thread !== thread || job.jobId !== jobId)
      throw Error("Job unavailable in this account/thread");
    if (!job.execId) return {jobId,state:"unknown"};
    const path = `/v1/sandboxes/${identity(job.sandboxId)}/exec/${identity(job.execId)}?tail=32768`;
    const result = await this.gateway.request(path, undefined, signal);
    signal.throwIfAborted();
    const current = await this.store.get<Job>(key);
    if (!current || current.owner !== job.owner || current.thread !== thread || current.jobId !== jobId ||
        current.sandboxId !== job.sandboxId || current.execId !== job.execId || current.commandDigest !== job.commandDigest)
      throw Error("Compute job mapping changed during terminal observation");
    if (result.state === "running") return {jobId,state:"running"};
    if (result.state !== "completed" || !Number.isInteger(result.exitCode))
      throw Error("Compute terminal observation requires completion and an exit code");
    return {jobId,state:"completed",exitCode:result.exitCode};
  }
  async poll(thread: string, jobId: string, signal: AbortSignal, cancel = false) {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw Error("Invalid job reference");
    const job = await this.store.get<Job>(`codegraff:compute-job:${jobId}`);
    if (!job || job.owner !== this.owner || job.thread !== thread) throw Error("Job unavailable in this account/thread");
    if (!job.execId) return { jobId, state: "unknown", reason: "Command dispatch was interrupted. Do not rerun: it may have executed." };
    if (job.state === "cancelled") return { jobId, state: "cancelled" };
    const path = `/v1/sandboxes/${identity(job.sandboxId)}/exec/${identity(job.execId)}`;
    if (cancel && job.state !== "completed") {
      await this.gateway.request(path, undefined, signal, "DELETE");
      job.state = "cancelled";
      await this.store.put(`codegraff:compute-job:${jobId}`, job);
      return { jobId, state: "cancelled", message: "Process stopped; external effects already submitted may still complete." };
    }
    const result = await this.gateway.request(`${path}?tail=32768`, undefined, signal);
    if (!["running", "completed"].includes(result.state)) throw Error("Invalid compute job response");
    if (result.state === "completed" && !Number.isInteger(result.exitCode)) throw Error("Compute completion has no exit code");
    job.state = result.state;
    job.exitCode = result.exitCode;
    await this.store.put(`codegraff:compute-job:${jobId}`, job);
    return { jobId, state: job.state, ...(job.state === "completed" ? { exitCode: job.exitCode } : {}), output: String(result.output ?? "").slice(-32768), outputIsTail: true };
  }

  /** One native tool effect waits for a change; unchanged observations do not
   * each require a fresh model completion. Reads remain safe to resume. */
  async wait(thread: string, jobId: string, signal: AbortSignal, timeoutMs = 20_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
      throw Error("Compute wait must be between 0 and 30000 milliseconds");
    const deadline = Date.now() + timeoutMs;
    const first = await this.poll(thread, jobId, signal);
    const initialOutput = "output" in first ? first.output : undefined;
    let result = first;
    while (result.state === "running" && Date.now() < deadline) {
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal });
      result = await this.poll(thread, jobId, signal);
      if (result.state !== "running" || ("output" in result ? result.output : undefined) !== initialOutput) break;
    }
    return { ...result, ...(result.state === "running" ? {
      unchanged: ("output" in result ? result.output : undefined) === initialOutput,
      instruction: "The existing job is still running. Do not resubmit it. If progress remains unchanged, inspect its output or polling script and explain the wait to the user. For provider jobs use the returned status_url/response_url, not a guessed route; bound error retries.",
    } : {}) };
  }

  /** Read an existing owned VM file through the host gateway. The VM never
   * receives Telegram or host credentials. Binary files are ASCII-armored
   * because the gateway UTF-8-decodes downloads. */
  async exportFile(path: string, signal: AbortSignal, limitBytes = EXPORT_LIMIT_BYTES) {
    const source = computeExportPath(path);
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > EXPORT_LIMIT_BYTES)
      throw Error("Invalid export size limit");
    const machine = await this.machine();
    if (!machine?.id) throw Error("No compute VM is allocated; create the file with sandbox_exec first");
    const id = await this.ensure(signal);
    const operation = crypto.randomUUID();
    const prefix = `/tmp/aiko-export-${operation}`;
    const job = { path: source, limitBytes, outPrefix: prefix };
    const fileName = source.slice(source.lastIndexOf("/") + 1);
    try {
      await this.gateway.request(`/v1/sandboxes/${id}/upload`, {
        path: `${prefix}.py`, contentBase64: Buffer.from(EXPORT_SCRIPT).toString("base64"),
      }, signal);
      await this.gateway.request(`/v1/sandboxes/${id}/upload`, {
        path: `${prefix}.json`, contentBase64: Buffer.from(JSON.stringify(job)).toString("base64"),
      }, signal);
      const prepared = await this.gateway.request(`/v1/sandboxes/${id}/exec`, {
        command: `/usr/bin/python3 ${prefix}.py ${prefix}.json`, async: false,
      }, signal, undefined, 4096);
      if (prepared.exitCode !== 0 || !String(prepared.output ?? "").includes("aiko-export-ready"))
        throw Error("Sandbox file was missing, too large, or not a regular owned file");
      const metadata = await this.gateway.request(`/v1/sandboxes/${id}/download`, { path: `${prefix}.meta.json` }, signal, undefined, 4096);
      if (typeof metadata.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(metadata.contentBase64))
        throw Error("Invalid sandbox export metadata");
      const meta = JSON.parse(Buffer.from(metadata.contentBase64, "base64").toString("utf8"));
      if (meta?.version !== 1 || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > limitBytes ||
          typeof meta.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(meta.sha256))
        throw Error("Invalid sandbox export metadata");
      const armorBytes = 4 * Math.ceil(meta.size / 3);
      const downloaded = await this.gateway.request(
        `/v1/sandboxes/${id}/download`, { path: `${prefix}.payload.b64` }, signal, undefined,
        4 * Math.ceil(armorBytes / 3) + 4096,
      );
      if (typeof downloaded.contentBase64 !== "string") throw Error("Invalid sandbox export transfer");
      const armor = Buffer.from(downloaded.contentBase64, "base64").toString("utf8");
      if (armor.length !== armorBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(armor))
        throw Error("Sandbox export transfer invalid");
      const bytes = new Uint8Array(Buffer.from(armor, "base64"));
      if (bytes.byteLength !== meta.size || createHash("sha256").update(bytes).digest("hex") !== meta.sha256)
        throw Error("Sandbox export integrity mismatch");
      return { bytes, fileName, size: meta.size, sha256: meta.sha256 };
    } finally {
      await this.gateway.request(`/v1/sandboxes/${id}/exec`, {
        command: `/usr/bin/python3 -c 'from pathlib import Path; p="${prefix}"; [Path(p+s).unlink(missing_ok=True) for s in [".py",".json",".meta.json",".payload.b64"]]'`,
        async: false,
      }, AbortSignal.timeout(15_000), undefined, 4096).catch(() => undefined);
    }
  }
}

export function sandboxComputeTools(compute: SandboxCompute, binding: { owner: string; thread: string; redact: (text: string) => string }): NativeTool<Self | EventLog>[] {
  if (compute.owner !== binding.owner) throw Error("Compute tool owner mismatch");
  const specs = [
    { name: "sandbox_status", description: "Check actual Codegraff command sandbox availability without creating a VM. Shell, Node/Python scripts, filesystem, package installation and outbound HTTP are supported. API credentials are separate from runtime availability.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "sandbox_exec", description: "Run a shell command, Node/Python code, install packages, process files or call a third-party API in this account's Codegraff compute VM. Returns a jobId; use sandbox_job until completed and inspect exitCode/output. For long Python jobs use python -u (or PYTHONUNBUFFERED=1) and flush progress so sandbox_job can observe it while the process runs. Save the provider submission receipt and its exact status_url/response_url before polling; never reconstruct queue routes or retry an uncertain paid submission. Omit cwd or use an empty string for the default home directory. Credentials and browser cookies are not automatically injected. Use environment references for provisioned service credentials, never key literals. Execute only work authorized by the user; a running job is not success. Do not resubmit uncertain paid/API writes.", inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 64000 }, cwd: { type: "string", maxLength: 1000 } }, required: ["command"], additionalProperties: false } },
    { name: "sandbox_job", description: "Wait for a previously returned compute job to change or finish (up to 20 seconds by default), or cancel its process. The host polls without additional model calls. waitMs may be 0–30000. Output is the last 32 KiB. An unchanged running job is not completion: inspect stalled scripts and give the user a useful progress update. Never resubmit an uncertain command.", inputSchema: { type: "object", properties: { jobId: { type: "string", pattern: "^[a-f0-9]{64}$" }, cancel: { type: "boolean" }, waitMs: { type: "integer", minimum: 0, maximum: 30000 } }, required: ["jobId"], additionalProperties: false } },
  ];
  return specs.map(spec => ({ spec, run: (raw, context) => Effect.gen(function* () {
    const self = yield* Self;
    if (self.actor !== "aiko" || self.thread !== binding.thread) throw Error("Compute tool scope mismatch");
    const args = raw as any;
    if (!args || typeof args !== "object" || binding.redact(JSON.stringify(args)) !== JSON.stringify(args)) return { status: "blocked", reason: "Use credential references, not secret literals, in command arguments" };
    return yield* Effect.tryPromise({ try: async () => {
      const result = spec.name === "sandbox_status" ? await compute.status(context.signal)
        : spec.name === "sandbox_job" ? args.cancel === true
          ? await compute.poll(binding.thread, args.jobId, context.signal, true)
          : await compute.wait(binding.thread, args.jobId, context.signal, args.waitMs ?? 20_000)
        : await compute.exec(binding.thread, `${context.turn}:${context.callId}`, args, context.signal);
      return JSON.parse(binding.redact(JSON.stringify(result)));
    }, catch: error => ({ status: "unknown", reason: binding.redact(error instanceof Error ? error.message : "Compute request failed"), instruction: "Inspect the existing job/status; do not repeat an uncertain command or claim the runtime is unavailable." }) }).pipe(Effect.catch(result => Effect.succeed(result)));
  }) }));
}

/** Native cancellation owns remote process cleanup, including commands whose
 * launch tool returned earlier. No command arguments are retained here. */
export function sandboxComputeCancellation(compute: SandboxCompute, thread: string) {
  type Running = { jobId: string; turn: string; epoch: number };
  return component({
    name: "aiko.compute-cancellation",
    keys: { prefixes: ["aiko-compute-cancel:"], keyOf: e =>
      e.type === "AikoComputeCancellationSettled" && typeof e.jobId === "string"
        ? `aiko-compute-cancel:${e.jobId}` : undefined },
    initial: () => ({ jobs: new Map<string, Running>(), epochs: new Map<string, number>(), settled: new Set<string>() }),
    step: (state, e) => {
      if (["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(e.type) && typeof e.turn === "string") {
        const jobs = new Map(state.jobs), settled = new Set(state.settled);
        for (const [id, job] of jobs) if (job.turn === e.turn && job.epoch === Number(e.epoch ?? 0)) {
          jobs.delete(id); settled.delete(id);
        }
        return { ...state, jobs, settled };
      }
      if (e.type === "TurnResumed" && typeof e.turn === "string")
        return { ...state, epochs: new Map(state.epochs).set(e.turn, Number(e.epoch)) };
      if (e.type === "AikoComputeCancellationSettled" && typeof e.jobId === "string")
        return { ...state, settled: new Set(state.settled).add(e.jobId) };
      if (typeof e.turn !== "string" || typeof e.callId !== "string" ||
          !(e.type === "ToolCalled" && e.name === "sandbox_exec" ||
            e.type === "AikoCodeToolStarted" && e.tool === "sandbox_exec" && e.owner === compute.owner)) return state;
      const jobId = digest([compute.owner, thread, `${e.turn}:${e.callId}`]);
      return { ...state, jobs: new Map(state.jobs).set(jobId, {
        jobId, turn: e.turn, epoch: Number(e.epoch ?? state.epochs.get(e.turn) ?? 0),
      }) };
    },
    output: () => ({ view: undefined, transitions: [] }),
    cancelState: (state, cancellation) => cancellation.invocation.method !== "message" ? [] :
      [...state.jobs.values()].filter(job => job.turn === cancellation.invocation.id &&
        job.epoch === cancellation.invocation.epoch && !state.settled.has(job.jobId)).map(job => effect({
        key: `aiko-compute-cancel:${job.jobId}`, input: job,
        act: (input, signal) => Effect.tryPromise({
          try: () => compute.poll(thread, input.jobId, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), true),
          catch: () => ({ state: "unknown", reason: "Remote process cancellation could not be confirmed; submitted external actions may still complete." }),
        }).pipe(Effect.timeout(10_000), Effect.catch(() => Effect.succeed({ state: "unknown" })), Effect.map(result => [{
          type: "AikoComputeCancellationSettled", ...input,
          result: { state: result.state, ...(result.state === "unknown" ? {
            reason: "Remote process cancellation could not be confirmed; submitted external actions may still complete.",
          } : {}) }, at: Date.now(),
        }])),
      })),
  });
}
