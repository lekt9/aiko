import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { sandboxDigest, type SandboxJobReceipt } from "./sandbox-job.ts";

/** Repository identifiers resolve through trusted owner grants, never guest paths. */
export type CodingWorkspaceCommand =
  | { action: "create"; repository: string; workspace: string; base?: string }
  | { action: "status" | "index" | "close"; repository: string; workspace: string }
  | { action: "list"; repository: string; workspace: string; path?: string }
  | { action: "read"; repository: string; workspace: string; path: string; offset?: number; length?: number }
  | { action: "edit"; repository: string; workspace: string; changes: { path: string; expected: string | null; content: string | null }[] }
  | { action: "undo"; repository: string; workspace: string; turn?: string }
  | { action: "query"; repository: string; workspace: string; query: string; kind?: "text" | "symbol"; limit?: number }
  | { action: "test"; repository: string; workspace: string }
  | { action: "reconcile"; repository: string; workspace: string; operation: string }
  | { action: "merge"; repository: string; workspace: string; testOperation: string; message: string };
export type CodingWorkspaceAction = CodingWorkspaceCommand["action"];
export interface CodingRepositoryGrant {
  id: string;
  /** A path inside the isolated owner compute VM, configured by the host. */
  root: string;
  actions: CodingWorkspaceAction[];
  /** Named commands are trusted grant configuration. All must pass for merge. */
  checks: Record<string, string[]>;
}
export interface CodingWorkspaceRequest {
  version: 1;
  owner: string;
  thread: string;
  turn: string;
  operationId: string;
  command: CodingWorkspaceCommand;
  /** Supplied only from the native original-operation record, never model args. */
  reconciliation?: { expectedDigest: string };
}
export interface CodingWorkspaceBinding {
  owner: string;
  thread: string;
  /** Changes when trusted repository roots, actions or checks change. */
  grantRevision?: string;
  authorizeRetained?(command: CodingWorkspaceCommand): boolean | Promise<boolean>;
  invoke(request: CodingWorkspaceRequest, signal: AbortSignal): Promise<SandboxJobReceipt>;
  redact(text: string): string;
}
export const CODING_WORKSPACE_ABI = "aiko-coding-workspace/2";
export const codingWorkspaceEnvironment = async (bundle: string, bunVersion: string) => sandboxDigest({ abi: CODING_WORKSPACE_ABI, bundle: await sandboxDigest(bundle), bunVersion });
export const codingWorkspaceDigest = (request: CodingWorkspaceRequest) => sandboxDigest(request);
const codingActions: readonly CodingWorkspaceAction[] = ["create", "status", "index", "close", "list", "read", "edit", "undo", "query", "test", "reconcile", "merge"];
/** Trusted deployment configuration only. Project text cannot create grants. */
export function parseCodingRepositories(raw: string | undefined): Readonly<Record<string, CodingRepositoryGrant[]>> {
  if (!raw?.trim()) return {};
  if (new TextEncoder().encode(raw).length > 262144) throw Error("Coding repository configuration exceeds 256 KiB");
  const value = JSON.parse(raw);
  const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input);
  const identifier = (input: unknown) => typeof input === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(input);
  const absolute = (input: unknown) => typeof input === "string" && input.length < 1024 && input.startsWith("/") && !input.includes("\\") &&
    !/[\u0000-\u001f]/.test(input) && input.slice(1).split("/").every(part => part && part !== "." && part !== "..");
  if (!object(value) || Object.keys(value).length > 1000) throw Error("Invalid owner coding repository configuration");
  for (const [owner, grants] of Object.entries(value)) {
    if (!identifier(owner) || !Array.isArray(grants) || grants.length > 32) throw Error("Invalid coding repository owner or grant list");
    const seen = new Set<string>();
    for (const grant of grants) {
      if (!object(grant) || Object.keys(grant).some(field => !["id", "root", "actions", "checks"].includes(field)) ||
          !identifier(grant.id) || seen.has(grant.id as string) || !absolute(grant.root) || !Array.isArray(grant.actions) || !grant.actions.length ||
          new Set(grant.actions).size !== grant.actions.length || grant.actions.some(action => !codingActions.includes(action)) || !object(grant.checks)) throw Error("Invalid coding repository grant");
      seen.add(grant.id as string);
      const checks = Object.entries(grant.checks);
      if (checks.length > 32 || (grant.actions.includes("test") || grant.actions.includes("merge")) && !checks.length || grant.actions.includes("merge") && !grant.actions.includes("test")) throw Error("Coding verification commands are required for test and merge grants");
      for (const [name, argv] of checks) {
        if (!identifier(name) || !Array.isArray(argv) || !argv.length || argv.length > 64 || !absolute(argv[0]) ||
            argv.some(argument => typeof argument !== "string" || argument.includes("\0") || argument.length > 4096)) throw Error("Coding checks require a bounded argv with an absolute executable");
      }
    }
  }
  return value as Record<string, CodingRepositoryGrant[]>;
}
export function validateCodingWorkspaceRequest(value: CodingWorkspaceRequest) {
  const id = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(s);
  const nativeId = (s: unknown) => typeof s === "string" && s.length >= 1 && s.length <= 2048 && !/[\u0000-\u001f]/.test(s);
  if (value?.version !== 1 || !id(value.owner) || !nativeId(value.thread) || !nativeId(value.turn) || !nativeId(value.operationId) ||
      !value.command || !id(value.command.repository) || !id(value.command.workspace) ||
      !codingActions.includes(value.command.action))
    throw Error("Invalid coding workspace request");
  if (value.command.action === "reconcile" ? !nativeId(value.command.operation) || !/^sha256:[a-f0-9]{64}$/.test(value.reconciliation?.expectedDigest ?? "") : value.reconciliation !== undefined)
    throw Error("Reconciliation requires an exact retained native operation digest");
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) throw Error("Coding request exceeds 1 MiB");
  return value;
}

/** These native journal entries contain operation identities and verification
 * metadata only. File contents and command output stay in private receipts. */
export function codingWorkspaceEventKey(event: Event): string | undefined {
  if (event.type === "AikoCodingOperation" && typeof event.owner === "string" && typeof event.thread === "string" &&
      typeof event.callId === "string" && ["started", "settled", "reconciled"].includes(String(event.phase)))
    return `aiko-coding:${JSON.stringify([event.owner, event.thread, event.callId, event.phase])}`;
}
type CodingProgress = { repository: string; workspace: string; dirty: boolean; mutation?: string; test?: string; verifiedGrantRevision?: string; verifiedTree?: string; verifiedRevision?: number; pending: Set<string> };
const codingEffectfulActions = ["create", "edit", "undo", "test", "index", "merge", "close"];
function codingProgress(events: readonly Event[], owner: string, thread: string) {
  const states = new Map<string, CodingProgress>(), started = new Map<string, Event>(), settled = new Set<string>(), reconciled = new Set<string>();
  for (const event of events) {
    if (!codingWorkspaceEventKey(event) || event.owner !== owner || event.thread !== thread ||
        typeof event.repository !== "string" || typeof event.workspace !== "string" || typeof event.callId !== "string") continue;
    const key = JSON.stringify([event.repository, event.workspace]);
    let state = states.get(key);
    if (!state) states.set(key, state = { repository: event.repository, workspace: event.workspace, dirty: false, pending: new Set() });
    if (event.phase === "started" && !started.has(event.callId)) {
      started.set(event.callId, event);
      if (event.action === "edit" || event.action === "undo") {
        state.dirty = true; state.mutation = event.callId; state.pending.add(event.callId);
      } else if (event.action === "test") {
        // A failed or interrupted later check cannot leave an older pass valid.
        state.dirty = true; state.test = event.callId; state.pending.add(event.callId);
      } else if (codingEffectfulActions.includes(String(event.action))) {
        state.pending.add(event.callId);
      }
    } else if (event.phase === "settled" && started.has(event.callId) && !settled.has(event.callId)) {
      settled.add(event.callId);
      if (reconciled.has(event.callId)) continue;
      const start = started.get(event.callId)!;
      // An unknown host result does not prove that the compute process stopped.
      // Only a final receipt or explicit reconciliation can release this fence.
      if (event.status === "completed" || event.status === "failed") state.pending.delete(event.callId);
      if (start.action === "edit" || start.action === "undo") {
        state.dirty = true;
      } else if (start.action === "test" && state.test === event.callId && event.verified === true &&
          start.after === (state.mutation ?? null) && state.pending.size === 0) {
        state.dirty = false; state.verifiedGrantRevision = typeof start.grantRevision === "string" ? start.grantRevision : undefined;
        state.verifiedTree = typeof event.tree === "string" ? event.tree : undefined; state.verifiedRevision = typeof event.revision === "number" ? event.revision : undefined;
      }
    } else if (event.phase === "reconciled" && started.has(event.callId) && !reconciled.has(event.callId)) {
      reconciled.add(event.callId); state.pending.delete(event.callId);
      if (event.preserveVerification !== true) state.dirty = true;
    }
  }
  return states;
}
export function codingWorkspacePending(events: readonly Event[], owner: string, thread: string, grantRevision?: string) {
  return [...codingProgress(events, owner, thread).values()].filter(state => state.dirty || state.pending.size || state.test !== undefined && grantRevision !== undefined && state.verifiedGrantRevision !== grantRevision)
    .map(({ repository, workspace }) => ({ repository, workspace }));
}
/** A host invariant on the native inference result. Failure uses the existing
 * native terminal; this does not schedule checks or hide an unverified answer. */
export function codingWorkspaceInference<R>(base: Layer.Layer<Infer, never, R>, owner: string, thread: string, grantRevision?: string): Layer.Layer<Infer, never, R | EventLog> {
  return Layer.effect(Infer, Effect.gen(function* () {
    const delegate = yield* Infer, log = yield* EventLog;
    return { ...delegate, react: (request: InferRequest, key?: string, signal?: AbortSignal) => Effect.gen(function* () {
      if (request.identity.actor !== "aiko" || request.identity.thread !== thread) return yield* Effect.die(Error("Coding inference scope mismatch"));
      const pending = codingWorkspacePending(yield* log.read, owner, thread, grantRevision);
      const action = yield* delegate.react({ ...request, system: `${request.system}\n\nCoding completion requires successful fresh coding_workspace test receipts after the last edit or undo in every modified workspace. An interrupted or failed check is not verification. Resolve uncertain operations before testing. ${pending.length ? `Still requiring verification: ${JSON.stringify(pending)}.` : ""}` }, key, signal);
      const terminal = (call: { name: string; arguments: unknown }) => call.name === "respond" ||
        ["send_message", "telegram_send", "telegram_voice", "telegram_screenshot"].includes(call.name) && (call.arguments as any)?.final === true;
      if (action.kind === "calls" && action.calls.some(terminal) && action.calls.some(call => !terminal(call)))
        return { kind: "fail" as const, error: "Coding completion must follow tool results; send the final response in a separate action after verification.",
          usage: action.usage, endpoint: action.endpoint, mode: action.mode,
          failure: { cause: "output_validation_failed" as const, attempts: 0, policy: { source: "coding_workspace_verification" } } };
      if (action.kind !== "complete" && !(action.kind === "call" && terminal(action)) && !(action.kind === "calls" && action.calls.some(terminal))) return action;
      const remaining = codingWorkspacePending(yield* log.read, owner, thread, grantRevision);
      if (!remaining.length) return action;
      return { kind: "fail" as const, error: `Coding completion refused: successful fresh checks are required for ${JSON.stringify(remaining)}.`,
        usage: action.usage, endpoint: action.endpoint, mode: action.mode,
        failure: { cause: "output_validation_failed" as const, attempts: 0, policy: { source: "coding_workspace_verification" } } };
    }) };
  })).pipe(Layer.provide(base));
}

/** The native tool call supplies the operation identity and cancellation scope. */
export function codingWorkspaceTools(binding: CodingWorkspaceBinding): NativeTool<Self | EventLog>[] {
  return [{
    spec: {
      name: "coding_workspace",
      description: "Operate an explicitly granted repository in isolated compute: create/status/list/read/edit/index/query/undo/test/reconcile/merge/close. Edits require expected content hashes (null for missing files). Completion and merge require the unchanged tree's fresh successful test operation. Reconcile an original native operation ID after a lost acknowledgement; this never repeats the effect or counts as verification. Tests use a filesystem/PID/network sandbox with only this worktree and system runtimes; external services and files are unavailable. Undo restores this turn's before-images. Repository and workspace identifiers are scoped to your account." + (binding.grantRevision ? ` Grant revision: ${binding.grantRevision}.` : ""),
      inputSchema: { type: "object", properties: {
        action: { type: "string", enum: codingActions },
        repository: { type: "string" }, workspace: { type: "string" }, base: { type: "string" },
        path: { type: "string" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 131072 },
        changes: { type: "array", maxItems: 64, items: { type: "object", properties: { path: { type: "string" }, expected: { type: ["string", "null"] }, content: { type: ["string", "null"] } }, required: ["path", "expected", "content"], additionalProperties: false } },
        turn: { type: "string" }, query: { type: "string" }, kind: { type: "string", enum: ["text", "symbol"] }, limit: { type: "integer", minimum: 1, maximum: 100 },
        testOperation: { type: "string" }, operation: { type: "string" }, message: { type: "string" },
      }, required: ["action", "repository", "workspace"], additionalProperties: false },
    },
    authorizeRetained: async input => {
      try { return !!binding.authorizeRetained && await binding.authorizeRetained(input as CodingWorkspaceCommand); } catch { return false; }
    },
    run: (command, context) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread) throw Error("Coding workspace scope mismatch");
      const turn = context.turn;
      if (!turn) return { status: "blocked", reason: "Coding workspace requires an owning invocation" };
      const text = JSON.stringify(command);
      if (binding.redact(text) !== text) return { status: "blocked", reason: "Use credential references instead of secret literals" };
      const rows = yield* log.read;
      const args = command as CodingWorkspaceCommand;
      const target = args?.action === "reconcile" ? rows.find(event => event.type === "AikoCodingOperation" && event.phase === "started" && event.owner === binding.owner && event.thread === binding.thread &&
        event.callId === args.operation && event.repository === args.repository && event.workspace === args.workspace && typeof event.jobDigest === "string") : undefined;
      let request: CodingWorkspaceRequest;
      try { request = validateCodingWorkspaceRequest({ version: 1, owner: binding.owner, thread: binding.thread, turn, operationId: context.callId, command: args,
        ...(target ? { reconciliation: { expectedDigest: target.jobDigest as string } } : {}) }); }
      catch { return { status: "blocked", reason: "Invalid coding workspace request" }; }
      const tracked = codingEffectfulActions.includes(request.command.action);
      const prior = rows.find(event => event.type === "AikoCodingOperation" && event.owner === binding.owner && event.thread === binding.thread && event.callId === context.callId && event.phase === "started");
      const progress = codingProgress(rows, binding.owner, binding.thread).get(JSON.stringify([request.command.repository, request.command.workspace]));
      if (request.command.action === "close" && progress && (progress.dirty || progress.pending.size || binding.grantRevision !== undefined && progress.test !== undefined && progress.verifiedGrantRevision !== binding.grantRevision))
        return { status: "blocked", reason: "Resolve pending operations and obtain fresh passing verification before closing a modified workspace" };
      const jobDigest = yield* Effect.promise(() => codingWorkspaceDigest(request));
      if (tracked && prior && prior.jobDigest !== jobDigest) return { status: "blocked", reason: "Coding operation journal identity conflict" };
      const started: Event = prior ?? { type: "AikoCodingOperation", owner: binding.owner, thread: binding.thread, callId: context.callId, turn,
        jobDigest,
        repository: request.command.repository, workspace: request.command.workspace, action: request.command.action, phase: "started", after: progress?.mutation ?? null,
        ...(binding.grantRevision ? { grantRevision: binding.grantRevision } : {}), at: Date.now() };
      if (tracked) {
        yield* log.append([started]);
        if (!(yield* log.read).some(event => event.type === "AikoCodingOperation" && event.owner === binding.owner && event.thread === binding.thread &&
            event.phase === "started" && event.callId === context.callId && event.jobDigest === jobDigest && event.turn === turn &&
            event.repository === request.command.repository && event.workspace === request.command.workspace && event.action === request.command.action))
          return { status: "blocked", reason: "Coding operation journal did not persist; no effect was dispatched" };
      }
      let settled: Event = { ...started, phase: "settled", status: "unknown", verified: false, at: Date.now() };
      let reconciled: Event | undefined;
      return yield* Effect.tryPromise({
        try: async () => {
          const receipt = await binding.invoke(request, context.signal);
          if (receipt.operationId !== request.operationId || receipt.jobDigest !== await codingWorkspaceDigest(request) ||
              receipt.harnessDigest !== await sandboxDigest(CODING_WORKSPACE_ABI) || receipt.browserStarts !== 0 || receipt.requests !== 0 ||
              receipt.outputDigest !== (receipt.output === undefined ? undefined : await sandboxDigest(receipt.output))) throw Error("Coding workspace receipt integrity mismatch");
          const evidence = receipt.output as Record<string, unknown> | undefined;
          if (target && receipt.status === "completed" && evidence?.idle === true && evidence.operation === target.callId && evidence.targetDigest === target.jobDigest &&
              evidence.repository === target.repository && evidence.workspace === target.workspace)
            reconciled = { ...target, phase: "reconciled", status: "unknown", verified: false, reconciledBy: context.callId,
              preserveVerification: !["edit", "undo", "test"].includes(String(target.action)) && !progress?.dirty &&
                (evidence.state === "closed" || target.action === "create" && evidence.state === "absent" ||
                  progress?.verifiedTree !== undefined && evidence.tree === progress.verifiedTree && evidence.revision === progress.verifiedRevision), at: Date.now() };
          const verified = request.command.action === "test" && receipt.status === "completed" && evidence?.verified === true &&
            evidence.repository === request.command.repository && evidence.workspace === request.command.workspace &&
            Number.isSafeInteger(evidence.revision) && typeof evidence.tree === "string" && /^sha256:[a-f0-9]{64}$/.test(evidence.tree) &&
            typeof evidence.checksDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(evidence.checksDigest);
          settled = { ...started, phase: "settled", status: receipt.status, verified,
            ...(verified ? { revision: evidence!.revision, tree: evidence!.tree, checksDigest: evidence!.checksDigest } : {}), at: Date.now() };
          const result = JSON.parse(binding.redact(JSON.stringify(receipt)));
          if (request.command.action === "status") {
            const pending = codingProgress(rows, binding.owner, binding.thread).get(JSON.stringify([request.command.repository, request.command.workspace]))?.pending;
            result.pendingOperations = rows.filter(event => event.type === "AikoCodingOperation" && event.phase === "started" &&
              event.owner === binding.owner && event.thread === binding.thread && pending?.has(event.callId as string))
              .map(event => ({ operation: event.callId, action: event.action, turn: event.turn, status: "unknown" }));
          }
          return result;
        },
        catch: error => ({ status: "unknown", reason: binding.redact(error instanceof Error ? error.message : "Coding workspace unavailable"), instruction: "Inspect the same operation/workspace; do not repeat an uncertain edit, test, or merge." }),
      }).pipe(Effect.catch(result => Effect.succeed(result)), Effect.ensuring(Effect.suspend(() => {
        const observations = [...(tracked ? [settled] : []), ...(reconciled ? [reconciled] : [])];
        return observations.length ? log.append(observations).pipe(Effect.asVoid) : Effect.void;
      })));
    }),
  }];
}
