import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import type { HarnessJsonValue } from "@unbrowse/browser-harness/harness-runtime";
import { validateNoSecrets } from "entity-learn/cloudflare";
import { validateRouterInput } from "./connector-router-host.ts";
import { createHash } from "node:crypto";

export type WorkflowJson = HarnessJsonValue;
export type WorkflowBinding = { kind: "input"; name: string } | { kind: "result"; step: string; path: string[] } | { kind: "literal"; value: WorkflowJson };
export interface WorkflowDefinition {
  version: 1;
  id: string;
  parameters: string[];
  steps: { id: string; toolId: string; dependsOn: string[]; arguments: Record<string, WorkflowBinding> }[];
  limits?: { maxConcurrency?: number; maxCalls?: number; timeoutMs?: number };
}
export type WorkflowStepStatus = "succeeded" | "failed" | "unknown" | "authorization_required" | "skipped";
export interface WorkflowReceipt {
  version: 1; owner: string; workflowId: string; digest: string; runId: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  calls: number; steps: { id: string; status: WorkflowStepStatus; toolDigest?: string }[];
  reason?: "procedure-evidence-unavailable" | "procedure-dependencies-changed";
}
export interface WorkflowApplicability {
  version: 1;
  /** Successful execution is a saved example, not independent outcome verification. */
  basis: "observed-success";
  steps: { id: string; toolDigest: string }[];
}
export interface WorkflowRecord {
  owner: string; definition: WorkflowDefinition; digest: string; reusable: boolean;
  provenance?: { runId: string };
  applicability?: WorkflowApplicability;
}
export function workflowApplicability(record: WorkflowRecord): WorkflowApplicability | undefined {
  const pinned = record.applicability;
  if (pinned?.version !== 1 || pinned.basis !== "observed-success" || !Array.isArray(pinned.steps) ||
    pinned.steps.length !== record.definition.steps.length || pinned.steps.some(s => !s || typeof s.id !== "string" || typeof s.toolDigest !== "string" || !/^[a-f0-9]{64}$/.test(s.toolDigest)) ||
    new Set(pinned.steps.map(s => s.id)).size !== record.definition.steps.length ||
    !record.definition.steps.every(s => pinned.steps.some(p => p.id === s.id))) return;
  return pinned;
}
/** Code artifacts share the owner workflow store; source is immutable at a given id. */
export interface CodeWorkflowRecord {
  version: 1; owner: string; id: string; description: string; code: string; digest: string;
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  dependencies: { name: string; schemaDigest: string }[];
  reusable: boolean;
  provenance?: { thread: string; execId: string; harness: "aiko-code/1" };
}
/** Matches persisted v1 code artifacts; dependencies are hashed children of the source root. */
export const codeSchemaDigest = (schema: unknown) => createHash("sha256").update(JSON.stringify(schema)).digest("hex");
export function codeWorkflowDigest(record: CodeWorkflowRecord): string {
  const { version, owner, id, description, code, inputSchema, outputSchema, dependencies } = record;
  return codeSchemaDigest({ version, owner, id, description, code, inputSchema, outputSchema, dependencies });
}
/** Trusted durable storage. Every operation is owner scoped; never persist execution inputs or outputs.
 * putDefinition must atomically reject conflicting digests; claimRun is atomic insert-if-absent.
 * finishRun must replace only the corresponding running record, without resetting terminal receipts.
 */
export interface WorkflowStore {
  getCode?(owner: string, id: string): Promise<CodeWorkflowRecord | undefined>;
  putCode?(owner: string, record: CodeWorkflowRecord): Promise<void>;
  listCode?(owner: string): Promise<CodeWorkflowRecord[]>;
  getDefinition(owner: string, id: string): Promise<WorkflowRecord | undefined>;
  putDefinition(owner: string, record: WorkflowRecord): Promise<void>;
  listDefinitions(owner: string): Promise<WorkflowRecord[]>;
  getRun(owner: string, runId: string): Promise<WorkflowReceipt | undefined>;
  claimRun(owner: string, receipt: WorkflowReceipt): Promise<boolean>;
  finishRun(owner: string, receipt: WorkflowReceipt): Promise<void>;
}
export interface WorkflowCall {
  owner: string; runId: string; stepId: string; input: Record<string, WorkflowJson>; signal: AbortSignal;
}
export interface RegisteredWorkflowTool {
  owner: string; id: string; effect: "read" | "write"; inputSchema: Record<string, unknown>;
  /** Must validate the exact registered input schema, including unknown fields. */
  validate(input: Record<string, WorkflowJson>): boolean;
  /** Existing host policy/auth, checked afresh for BOTH reads and writes. */
  authorize(call: WorkflowCall): Promise<boolean>;
  /** No retries. Host must enforce owner/auth/SSRF at execution and propagate cancellation. */
  execute(call: WorkflowCall): Promise<{ status: "succeeded"; output: unknown } | { status: "failed" | "unknown" | "authorization_required" }>;
}
export interface WorkflowDispatcher {
  resolve(context: { owner: string; toolId: string; signal: AbortSignal }): Promise<RegisteredWorkflowTool | undefined>;
}
export const workflowToolDigest = (tool: Pick<RegisteredWorkflowTool, "owner" | "id" | "effect" | "inputSchema">) =>
  sha256(canonicalStringify({ owner: tool.owner, id: tool.id, effect: tool.effect, inputSchema: tool.inputSchema }));
export interface ToolWorkflowsOptions {
  owner: string; store: WorkflowStore; dispatcher: WorkflowDispatcher;
  /** Private, memory-only sink. Never journal the argument or derived response values. */
  consume?(value: { owner: string; workflowId: string; runId: string; stepId: string; output: WorkflowJson }, signal: AbortSignal): Promise<void>;
  /** Additional host credential/redaction guard. Throw on secret material. */
  guard?(value: unknown): void;
}
const label = /^[A-Za-z0-9_-]{1,128}$/;
const validId = (value: unknown): value is string => typeof value === "string" && label.test(value);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error("Invalid workflow fields");
}
function json(value: unknown, maxBytes = 131072): asserts value is WorkflowJson {
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 16384 || depth > 16) throw new Error("Workflow value limit");
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (!Array.isArray(v) && !object(v)) throw new Error("Expected workflow JSON");
    for (const [k, item] of Object.entries(v)) { if (forbidden.has(k)) throw new Error("Unsafe workflow key"); visit(item, depth + 1); }
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) throw new Error("Workflow value limit");
}
function guard(value: unknown, extra?: ToolWorkflowsOptions["guard"]) {
  json(value); validateRouterInput(value); validateNoSecrets(value); extra?.(value);
}
function limit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error("Invalid workflow limit");
  return value as number;
}
/** Closed declarative language: references, literals and registered calls only. */
export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  json(value, 32768); guard(value);
  if (!object(value)) throw new Error("Invalid workflow");
  keys(value, ["version", "id", "parameters", "steps", "limits"]);
  if (value.version !== 1 || typeof value.id !== "string" || !label.test(value.id) || !Array.isArray(value.parameters) || value.parameters.length > 32 || value.parameters.some(p => typeof p !== "string" || !label.test(p) || forbidden.has(p)) || new Set(value.parameters).size !== value.parameters.length || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 32) throw new Error("Invalid workflow");
  const limits = value.limits ?? {};
  if (!object(limits)) throw new Error("Invalid workflow limits");
  keys(limits, ["maxConcurrency", "maxCalls", "timeoutMs"]);
  limit(limits.maxConcurrency, 4, 8); limit(limits.maxCalls, 32, 32); limit(limits.timeoutMs, 30000, 60000);
  const ids = new Set<string>();
  for (const s of value.steps) {
    if (!object(s)) throw new Error("Invalid workflow step");
    keys(s, ["id", "toolId", "dependsOn", "arguments"]);
    if (typeof s.id !== "string" || !label.test(s.id) || ids.has(s.id) || typeof s.toolId !== "string" || !s.toolId.length || s.toolId.length > 512 || !Array.isArray(s.dependsOn) || s.dependsOn.some(d => typeof d !== "string") || new Set(s.dependsOn).size !== s.dependsOn.length || !object(s.arguments)) throw new Error("Invalid workflow step");
    ids.add(s.id);
    for (const b of Object.values(s.arguments)) {
      if (!object(b)) throw new Error("Invalid workflow binding");
      if (b.kind === "input") { keys(b, ["kind", "name"]); if (!value.parameters.includes(b.name)) throw new Error("Unknown workflow parameter"); }
      else if (b.kind === "result") {
        keys(b, ["kind", "step", "path"]);
        if (!s.dependsOn.includes(b.step) || !Array.isArray(b.path) || b.path.length > 16 || b.path.some(p => typeof p !== "string" || p.length > 128 || forbidden.has(p))) throw new Error("Invalid workflow dependency binding");
      } else if (b.kind === "literal") { keys(b, ["kind", "value"]); json(b.value); }
      else throw new Error("Unsupported workflow operation");
    }
  }
  const def = value as unknown as WorkflowDefinition;
  const done = new Set<string>();
  while (done.size < ids.size) {
    const ready = def.steps.filter(s => !done.has(s.id) && s.dependsOn.every(d => done.has(d)));
    if (!ready.length) throw new Error("Cyclic or missing workflow dependency");
    ready.forEach(s => done.add(s.id));
  }
  return structuredClone(def);
}
const digestOf = (definition: WorkflowDefinition) => sha256(canonicalStringify(definition));
/** Race every host await against the whole-run deadline, even if a host ignores cancellation.
 * This bounds the caller, not remote effects: timed-out dispatched steps are UNKNOWN and never retried.
 */
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new Error("Workflow cancelled")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class ToolWorkflows {
  private readonly options: ToolWorkflowsOptions;
  constructor(options: ToolWorkflowsOptions) {
    if (!validId(options.owner)) throw new Error("Invalid workflow owner");
    this.options = { ...options };
  }
  private checked(record: WorkflowRecord, id: string) {
    if (record.owner !== this.options.owner || record.definition.id !== id) throw new Error("Workflow owner mismatch");
    const definition = validateWorkflowDefinition(record.definition);
    guard(definition, this.options.guard);
    if (record.digest !== digestOf(definition)) throw new Error("Workflow definition mismatch");
    return structuredClone(record);
  }
  async define(value: WorkflowDefinition): Promise<WorkflowRecord> {
    const definition = validateWorkflowDefinition(value); guard(definition, this.options.guard);
    const { owner, store } = this.options;
    const old = await store.getDefinition(owner, definition.id);
    if (old) {
      const record = this.checked(old, definition.id);
      if (record.digest !== digestOf(definition)) throw new Error("Workflow definitions are immutable; use a new ID");
      return record;
    }
    const record: WorkflowRecord = { owner, definition, digest: digestOf(definition), reusable: false };
    await store.putDefinition(owner, structuredClone(record));
    return record;
  }
  async describe(workflowId: string): Promise<WorkflowRecord | undefined> {
    if (!validId(workflowId)) throw new Error("Invalid workflow ID");
    const record = await this.options.store.getDefinition(this.options.owner, workflowId);
    return record ? this.checked(record, workflowId) : undefined;
  }
  async list(): Promise<WorkflowRecord[]> {
    const records = await this.options.store.listDefinitions(this.options.owner);
    return records.map(r => this.checked(r, r.definition.id));
  }
  async crystallize({ workflowId, runId }: { workflowId: string; runId: string }): Promise<WorkflowRecord> {
    if (!validId(runId)) throw new Error("Invalid workflow run ID");
    const record = await this.describe(workflowId);
    const receipt = await this.options.store.getRun(this.options.owner, runId);
    if (!record || !receipt || receipt.owner !== record.owner || receipt.runId !== runId || receipt.workflowId !== workflowId || receipt.digest !== record.digest || receipt.status !== "succeeded" || receipt.calls !== record.definition.steps.length || receipt.steps.length !== record.definition.steps.length || !record.definition.steps.every(s => receipt.steps.some(r => r.id === s.id && r.status === "succeeded"))) throw new Error("Successful owned workflow evidence required");
    if (receipt.steps.some(s => !s.toolDigest || !/^[a-f0-9]{64}$/.test(s.toolDigest))) throw new Error("Pinned tool evidence required; run a new workflow definition before saving it");
    if (record.reusable) return record;
    const reusable: WorkflowRecord = { ...record, reusable: true, provenance: { runId },
      applicability: { version: 1, basis: "observed-success", steps: receipt.steps.map(s => ({ id: s.id, toolDigest: s.toolDigest! })) } };
    await this.options.store.putDefinition(record.owner, structuredClone(reusable));
    return reusable;
  }
  /** Reconcile an interrupted native tool from its existing durable receipt, never by rerunning it. */
  async receipt(runId: string): Promise<WorkflowReceipt | undefined> {
    if (!validId(runId)) throw new Error("Invalid workflow run ID");
    const prior = await this.options.store.getRun(this.options.owner, runId);
    if (!prior) return undefined;
    const record = await this.describe(prior.workflowId);
    if (!record || prior.owner !== this.options.owner || prior.runId !== runId || prior.digest !== record.digest)
      throw new Error("Workflow receipt mismatch");
    return { ...structuredClone(prior), status: prior.status === "running" ? "unknown" : prior.status };
  }
  async run(request: { workflowId: string; runId: string; input: Record<string, WorkflowJson>; signal?: AbortSignal }): Promise<WorkflowReceipt> {
    const { owner, store, dispatcher } = this.options;
    if (!validId(request.runId)) throw new Error("Invalid workflow run ID");
    guard(request.input, this.options.guard);
    const record = await this.describe(request.workflowId);
    if (!record) throw new Error("Unknown owned workflow");
    const definition = record.definition;
    if (!object(request.input) || Object.keys(request.input).some(k => !definition.parameters.includes(k)) || definition.parameters.some(k => !Object.hasOwn(request.input, k))) throw new Error("Invalid workflow inputs");
    const input = structuredClone(request.input);
    const receipt: WorkflowReceipt = { version: 1, owner, workflowId: definition.id, digest: record.digest, runId: request.runId, status: "running", calls: 0, steps: definition.steps.map(s => ({ id: s.id, status: "skipped" })) };
    // Atomic durable claim survives worker crashes. A prior running run has an uncertain outcome.
    request.signal?.throwIfAborted();
    if (!await store.claimRun(owner, structuredClone(receipt))) {
      const old = await store.getRun(owner, request.runId);
      if (!old || old.owner !== owner || old.runId !== request.runId || old.workflowId !== definition.id || old.digest !== record.digest) throw new Error("Workflow invocation conflict");
      return { ...structuredClone(old), status: old.status === "running" ? "unknown" : old.status };
    }
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), limit(definition.limits?.timeoutMs, 30000, 60000));
    const concurrency = limit(definition.limits?.maxConcurrency, 4, 8), callBudget = limit(definition.limits?.maxCalls, 32, 32);
    const outputs = new Map<string, WorkflowJson>(), done = new Set<string>();
    let outputBytes = 0;
    const set = (id: string, status: WorkflowStepStatus) => { receipt.steps.find(s => s.id === id)!.status = status; };
    const pinned = workflowApplicability(record);
    const resolve = async (step: WorkflowDefinition["steps"][number]) => {
      try {
        const tool = await bounded(() => dispatcher.resolve({ owner, toolId: step.toolId, signal }), signal);
        if (!tool || tool.owner !== owner || tool.id !== step.toolId || !["read", "write"].includes(tool.effect) || !object(tool.inputSchema) || typeof tool.validate !== "function" || typeof tool.authorize !== "function" || typeof tool.execute !== "function") throw new Error("Registered owned tool unavailable");
        const toolDigest = workflowToolDigest(tool);
        if (record.reusable && pinned?.steps.find(s => s.id === step.id)?.toolDigest !== toolDigest) throw new Error("Saved procedure prerequisites changed");
        return tool;
      } catch (error) {
        if (record.reusable) receipt.reason = "procedure-dependencies-changed";
        throw error;
      }
    };
    const execute = async (step: WorkflowDefinition["steps"][number], tool: RegisteredWorkflowTool) => {
      let dispatched = false;
      try {
        const args: Record<string, WorkflowJson> = {};
        for (const [name, binding] of Object.entries(step.arguments)) {
          let value: unknown;
          if (binding.kind === "literal") value = binding.value;
          else if (binding.kind === "input") value = input[binding.name];
          else {
            value = outputs.get(binding.step);
            for (const key of binding.path) {
              if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("Missing bound result");
              value = (value as Record<string, unknown>)[key];
            }
          }
          json(value); args[name] = structuredClone(value);
        }
        guard(args, this.options.guard);
        if (tool.validate(structuredClone(args)) !== true) throw new Error("Registered input schema rejected arguments");
        const call = () => ({ owner, runId: request.runId, stepId: step.id, input: structuredClone(args), signal });
        if (await bounded(() => tool.authorize(call()), signal) !== true) { set(step.id, "authorization_required"); return; }
        signal.throwIfAborted();
        if (receipt.calls >= callBudget) throw new Error("Workflow call budget reached");
        const toolDigest = workflowToolDigest(tool);
        if (record.reusable && pinned?.steps.find(s => s.id === step.id)?.toolDigest !== toolDigest) {
          receipt.reason = "procedure-dependencies-changed";
          throw new Error("Saved procedure prerequisites changed");
        }
        receipt.steps.find(s => s.id === step.id)!.toolDigest = toolDigest;
        receipt.calls++; dispatched = true;
        const result = await bounded(() => tool.execute(call()), signal);
        if (!result || !["succeeded", "failed", "unknown", "authorization_required"].includes(result.status)) throw new Error("Ambiguous tool result");
        if (result.status !== "succeeded") { set(step.id, result.status); return; }
        json(result.output); guard(result.output, this.options.guard);
        outputBytes += new TextEncoder().encode(JSON.stringify(result.output)).length;
        if (outputBytes > 1048576) throw new Error("Workflow output budget");
        const output = structuredClone(result.output);
        // Late completions cannot reach the sink after timeout, or unblock dependent calls.
        signal.throwIfAborted();
        if (this.options.consume) await bounded(() => this.options.consume!({ owner, workflowId: definition.id, runId: request.runId, stepId: step.id, output: structuredClone(output) }, signal), signal);
        outputs.set(step.id, output); done.add(step.id); set(step.id, "succeeded");
      } catch { set(step.id, dispatched ? "unknown" : "failed"); }
    };
    try {
      // Check the entire saved procedure before its first effect, including
      // downstream tools. Resolve again at each step to detect later changes.
      if (record.reusable) {
        if (!pinned) {
          receipt.reason = "procedure-evidence-unavailable";
          throw new Error("Saved procedure needs current tool evidence");
        }
        for (const step of definition.steps) await resolve(step);
      }
      while (done.size < definition.steps.length) {
        signal.throwIfAborted();
        if (receipt.calls >= callBudget) break;
        const ready = definition.steps.filter(s => !done.has(s.id) && s.dependsOn.every(d => done.has(d)));
        const batch: { step: WorkflowDefinition["steps"][number]; tool: RegisteredWorkflowTool }[] = [];
        for (const step of ready) {
          const tool = await resolve(step);
          if (tool.effect === "write" && batch.length) break;
          batch.push({ step, tool });
          if (tool.effect === "write" || batch.length >= Math.min(concurrency, callBudget - receipt.calls)) break;
        }
        if (!batch.length) break;
        await Promise.all(batch.map(({ step, tool }) => execute(step, tool)));
        if (batch.some(({ step }) => !done.has(step.id))) break;
      }
    } catch { /* Structural, registration and pre-dispatch failures carry no external error text. */ }
    finally { clearTimeout(timer); controller.abort(); outputs.clear(); }
    receipt.status = receipt.steps.some(s => s.status === "unknown") ? "unknown" : done.size === definition.steps.length ? "succeeded" : "failed";
    // Failure to save propagates a fixed error. The durable running claim still prevents re-execution.
    try { await store.finishRun(owner, structuredClone(receipt)); }
    catch { throw new Error("Workflow receipt persistence unavailable; do not retry with a new run ID"); }
    return receipt;
  }
}
