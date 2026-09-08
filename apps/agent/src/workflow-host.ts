import { createHash, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { Infer, tool, type InferRequest } from "tardie";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { NativeTool } from "tardie/component/tool";
import { Validator, type Schema } from "@cfworker/json-schema";
import { ToolWorkflows, type WorkflowJson } from "./tool-workflows.ts";
import { validateRouterInput } from "./connector-router-host.ts";
import { replayCapabilities, capabilityURL } from "./capability-builder.ts";
import { executableObservedReads } from "./capability-builder-network.ts";
import { artifact } from "./request-memory.ts";
import { sendPublicHarnessRequest } from "./observed-network.ts";
import { executeHarnessAction, type HarnessJsonValue } from "@unbrowse/browser-harness/harness-runtime";

import { readPublicPage } from "./public-web.ts";
import type { ConnectorEngine } from "./connectors.ts";
import type { Event } from "tardie/core/event";

type Options = ConstructorParameters<typeof ToolWorkflows>[0];
export interface WorkflowKV {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
  list(prefix: string): Promise<unknown[]>;
  claim(key: string, value: unknown): Promise<boolean>;
  update(key: string, change: (previous: unknown) => unknown): Promise<void>;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function createWorkflowStore(kv: WorkflowKV): Options["store"] {
  const prefix = (owner: string, kind: string) =>
    `workflows:${digest(owner)}:${kind}:`;
  const key = (owner: string, kind: string, id: string) =>
    prefix(owner, kind) + digest(id);
  return {
    getCode: async (owner,id) => (await kv.get(key(owner,"code",id))) as any,
    putCode: async (owner,record) => {
      if (record.owner !== owner) throw new Error("Foreign code workflow owner");
      await kv.update(key(owner,"code",record.id),previous=>{
        const old=previous as typeof record|undefined;
        if(old && (old.owner!==owner || old.digest!==record.digest)) throw new Error("Code workflow definition conflict");
        return old?.reusable ? old : record;
      });
    },
    listCode: async owner => (await kv.list(prefix(owner,"code"))) as any,
    getDefinition: async (owner, id) =>
      (await kv.get(key(owner, "definition", id))) as any,
    putDefinition: async (owner, record) => {
      await kv.update(
        key(owner, "definition", record.definition.id),
        (previous) => {
          const old = previous as typeof record | undefined;
          if (old && (old.owner !== owner || old.digest !== record.digest))
            throw new Error("Workflow definition conflict");
          return old?.reusable ? old : record;
        },
      );
    },
    listDefinitions: async (owner) =>
      (await kv.list(prefix(owner, "definition"))) as any,
    getRun: async (owner, id) => (await kv.get(key(owner, "run", id))) as any,
    claimRun: (owner, receipt) =>
      kv.claim(key(owner, "run", receipt.runId), receipt),
    finishRun: async (owner, receipt) => {
      await kv.update(key(owner, "run", receipt.runId), (previous) => {
        const old = previous as typeof receipt | undefined;
        if (
          !old ||
          old.owner !== owner ||
          old.digest !== receipt.digest ||
          old.workflowId !== receipt.workflowId
        )
          throw new Error("Workflow run conflict");
        if (old.status !== "running") {
          if (JSON.stringify(old) !== JSON.stringify(receipt))
            throw new Error("Workflow run already settled");
          return old;
        }
        return receipt;
      });
    },
  };
}

/** Every workflow step resolves against the owner's current registered capability and access state. */
export function workflowDispatcher(binding: {
  owner: string;
  engine: ConnectorEngine;
  readEvents: () => Promise<readonly Event[]>;
  redact: (s: string) => string;
  read?: typeof readPublicPage;
}): Options["dispatcher"] {
  return {
    resolve: async ({ owner, toolId }) => {
      if (owner !== binding.owner) throw new Error("Workflow owner mismatch");
      if (toolId.startsWith("arcade:")) {
        const tool = await binding.engine.describe(toolId);
        if (
          (tool.metadata.behavior as any)?.read_only !== true ||
          (tool.metadata.behavior as any)?.destructive === true
        )
          throw new Error("Workflow tool is not an explicitly classified read");
        const validator = new Validator(tool.inputSchema);
        return {
          owner,
          id: toolId,
          effect: "read" as const,
          inputSchema: tool.inputSchema,
          validate: (input: unknown) => validator.validate(input).valid,
          authorize: async () =>
            (await binding.engine.connections()).some(
              (c) => (c.connectorId === toolId || c.toolIds?.includes(toolId)) && c.status === "connected",
            ),
          execute: async ({ input, signal }) => {
            signal.throwIfAborted();
            const connection = (await binding.engine.connections()).find(
              c => (c.connectorId === toolId || c.toolIds?.includes(toolId)) && c.status === "connected",
            );
            if (!connection) return { status: "authorization_required" as const };
            const result = await binding.engine.execute(connection.id, input, toolId);
            return result.status === "succeeded"
              ? {
                  status: "succeeded" as const,
                  output: (result.value ?? null) as WorkflowJson,
                }
              : { status: result.status };
          },
        };
      }
      const events = await binding.readEvents();
      const observed = executableObservedReads(events).find(e => e.toolId === toolId || e.toolDigest === toolId);
      if (observed) {
        const origins = [...new Set(observed.definition.steps.map(s => new URL(s.origin).hostname))];
        const properties = Object.fromEntries(observed.definition.inputs.filter(i => i.source === "caller").map(i => [i.name, i.type === "json" ? {} : { type: i.type }]));
        const required = observed.definition.inputs.filter(i => i.required && i.source === "caller").map(i => i.name);
        const inputSchema = { type: "object" as const, properties, required, additionalProperties: false };
        const validator = new Validator(inputSchema);
        return {
          owner, id: toolId, effect: "read" as const, inputSchema,
          validate: (input: unknown) => validator.validate(input).valid,
          authorize: async () => {
            for (const domain of origins) {
              if (!(await binding.engine.search(domain)).fallbackAllowed) return false;
            }
            return true;
          },
          execute: async ({ input, signal }) => {
            signal.throwIfAborted();
            let terminal: HarnessJsonValue | undefined;
            const result = await executeHarnessAction({
              artifact: artifact(observed.definition),
              actionId: observed.actionId,
              input: input as Record<string, HarnessJsonValue>,
              adapters: {
                clock: { now: () => new Date() },
                uuid: { next: () => crypto.randomUUID() },
                transport: {
                  send: async (request) => {
                    signal.throwIfAborted();
                    const response = await sendPublicHarnessRequest(request, signal);
                    terminal = response.body;
                    return response;
                  },
                },
              },
            });
            if (result.status !== "completed") return { status: "failed" as const };
            return { status: "succeeded" as const, output: (terminal ?? null) as WorkflowJson };
          },
        };
      }
      const capability = replayCapabilities(
        { owner, thread: `user-${owner}`, redact: binding.redact },
        events,
      ).find((c) => c.id === toolId);
      if (!capability) throw new Error("Owned workflow tool unavailable");
      const inputSchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
      return {
        owner,
        id: toolId,
        effect: "read" as const,
        inputSchema,
        validate: (input: unknown) =>
          !!input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          !Object.keys(input).length,
        authorize: async () =>
          (await binding.engine.search(new URL(capability.url).hostname))
            .fallbackAllowed,
        execute: async ({ signal }) => {
          const page = await (binding.read ?? readPublicPage)(
            capabilityURL(capability.url),
            signal,
          );
          if (page.url !== capability.url || page.truncated)
            return { status: "failed" as const };
          return {
            status: "succeeded" as const,
            output: { url: page.url, text: binding.redact(page.text) },
          };
        },
      };
    },
  };
}

/** Native logs contain opaque handles and receipts; intermediate values exist only at the inference seam. */
export class WorkflowController {
  readonly engine: ToolWorkflows;
  private calls = new Map<
    string,
    { turn: string; name: string; args: any; expires: number }
  >();
  private outputs = new Map<
    string,
    { turn: string; value: unknown; expires: number }
  >();
  constructor(
    readonly owner: string,
    readonly thread: string,
    options: Omit<Options, "owner" | "consume">,
    readonly redact: (s: string) => string,
  ) {
    this.engine = new ToolWorkflows({
      ...options,
      owner,
      consume: async (row) => {
        const pending = this.outputs.get(row.runId);
        if (!pending) return;
        const steps = pending.value as Record<string, unknown>;
        steps[row.stepId] = JSON.parse(this.redact(JSON.stringify(row.output)));
        if (JSON.stringify(steps).length > 64000) delete steps[row.stepId];
      },
    });
  }
  private prune() {
    const now = Date.now();
    for (const [k, v] of this.calls) if (v.expires < now) this.calls.delete(k);
    for (const [k, v] of this.outputs)
      if (v.expires < now) this.outputs.delete(k);
    while (this.outputs.size > 32)
      this.outputs.delete(this.outputs.keys().next().value!);
  }
  inference(base: Layer.Layer<Infer>) {
    const c = this;
    return Layer.effect(
      Infer,
      Effect.gen(function* () {
        const model = yield* Infer;
        return {
          ...model,
          react: (
            request: InferRequest,
            key?: string,
            signal?: AbortSignal,
          ) => {
            c.prune();
            const trajectory = request.trajectory.map((e) => {
              const r = e.result as any;
              if (
                e.type !== "ToolReturned" ||
                r?.kind !== "workflow-receipt" ||
                r.owner !== c.owner
              )
                return e;
              const output = c.outputs.get(r.runId);
              return request.identity.thread === c.thread && output?.turn === request.identity.turn
                ? { ...e, result: { ...r, untrustedToolResults: JSON.parse(c.redact(JSON.stringify(output.value))) } }
                : e;
            });
            return model.react({ ...request, trajectory }, key, signal).pipe(
              Effect.map((action) => {
                const workflowTurn=request.trajectory.some(e=>e.type==="ToolReturned"&&e.turn===request.identity.turn&&(e.result as any)?.kind==="workflow-receipt");
                if(action.kind==="complete"&&workflowTurn)return {...action,output:typeof action.output==="string"?c.redact(action.output):JSON.parse(c.redact(JSON.stringify(action.output)))};
                if(action.kind==="fail"&&workflowTurn)return {...action,error:c.redact(String(action.error)),failure:undefined};
                if((action.kind==="call"||action.kind==="calls")&&workflowTurn&&typeof action.text==="string")
                  action={...action,text:c.redact(action.text)};
                const seal=<C extends {callId:string;name:string;arguments:unknown}>(call:C):C=>{
                if(!call.name.startsWith("workflow_"))return call;
                let args: unknown = {};
                try {
                  const encoded = JSON.stringify(call.arguments);
                  if (
                    !encoded ||
                    encoded.length > 32768 ||
                    c.redact(encoded) !== encoded
                  )
                    throw new Error();
                  validateRouterInput(call.arguments);
                  args = call.arguments;
                } catch {}
                const id = randomUUID();
                c.calls.set(id, {
                  turn: request.identity.turn,
                  name: call.name,
                  args,
                  expires: Date.now() + 900000,
                });
                return {
                  ...call,
                  callId: `workflow_${digest(`${request.identity.turn}:${call.callId}`).slice(0, 32)}`,
                  arguments: { request: id },
                  text: undefined,
                };
                };
                if(action.kind==="call")return seal(action);
                if(action.kind==="calls")return {...action,calls:action.calls.map(seal)};
                return action;
              }),
            );
          },
        };
      }),
    ).pipe(Layer.provide(base));
  }
  component() {
    return {
      ...tool(this.tools()),
      name: "aiko.workflows",
      keys: {
        prefixes: ["aiko-workflow:"],
        keyOf: (e: Event) => ["AikoWorkflowStarted", "AikoWorkflowSettled"].includes(e.type) && e.owner === this.owner && typeof e.runId === "string"
          ? `aiko-workflow:${e.type}:${e.runId}` : undefined,
      },
    };
  }
  codeTools(): NativeTool<Self | EventLog>[] {
    return this.tools().map(native => ({ spec: native.spec, run: (args, context) => Effect.gen({self:this}, function* () {
      const self = yield* Self;
      if (self.actor !== "aiko" || self.thread !== this.thread || !context.turn)
        return {status:"blocked", reason:"owner_binding_mismatch"};
      const encoded = JSON.stringify(args);
      if (!encoded || encoded.length > 32768 || this.redact(encoded) !== encoded) return {status:"blocked"};
      try { validateRouterInput(args); } catch { return {status:"blocked"}; }
      const ref = randomUUID();
      this.calls.set(ref, {turn:context.turn, name:native.spec.name, args, expires:Date.now()+900000});
      try {
        const result = yield* native.run({request:ref}, context);
        const receipt = result as {runId?:string};
        const output = receipt.runId ? this.outputs.get(receipt.runId) : undefined;
        return output?.turn === context.turn ? {...receipt, untrustedToolResults:output.value} : result;
      } finally { this.calls.delete(ref); }
    }) }));
  }
  tools(): NativeTool<Self | EventLog>[] {
    return ["run", "crystallize", "list"].map((operation) => ({
      spec: {
        name: `workflow_${operation}`,
        description:
          operation === "run"
            ? "Execute a bounded tool workflow program. Independent reads run in parallel; result bindings feed dependencies. Pass runtime values via input parameters. Supply program (version:1,id,parameters,steps:[id,toolId,dependsOn,arguments bindings],limits) or a saved workflowId. Bindings: {kind:input,name}, {kind:result,step,path:string[]}, {kind:literal,value}. Only registered owner read tools are available. No Python/shell evaluation."
            : operation === "crystallize"
              ? "Save a successfully executed workflowId/runId with pinned tool schemas and effect types. This is one successful example, not independent verification of its outcome. Changed prerequisites block reuse; use a new definition and run to establish new evidence. Stores no result values."
              : "List saved workflow programs and reusable status.",
        inputSchema:
          operation === "run"
            ? {
                type: "object",
                properties: {
                  program: {
                    type: "string",
                    description:
                      "JSON workflow program source; omit when running a saved workflowId",
                  },
                  workflowId: { type: "string" },
                  input: {
                    type: "string",
                    description:
                      "JSON object containing runtime parameter values",
                  },
                },
                additionalProperties: false,
              }
            : operation === "crystallize"
              ? {
                  type: "object",
                  properties: {
                    workflowId: { type: "string" },
                    runId: { type: "string" },
                  },
                  required: ["workflowId", "runId"],
                  additionalProperties: false,
                }
              : { type: "object", properties: {}, additionalProperties: false },
      },
      run: (
        input: unknown,
        context: Parameters<NativeTool<Self | EventLog>["run"]>[1],
      ) =>
        Effect.gen({ self: this }, function* () {
          const self = yield* Self;
          const log = yield* EventLog;
          if (self.actor !== "aiko" || self.thread !== this.thread)
            return { kind: "workflow-receipt", owner: this.owner, status: "blocked" };
          const events = yield* log.read;
          const runId = digest(JSON.stringify([this.owner, this.thread, context.turn, context.callId]));
          const settled = events.find(e => e.type === "AikoWorkflowSettled" && e.owner === this.owner && e.runId === runId);
          if (settled) return settled.result;
          const started = events.find(e => e.type === "AikoWorkflowStarted" && e.owner === this.owner && e.runId === runId);
          if (started) {
            const receipt = yield* Effect.tryPromise(() => this.engine.receipt(runId)).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const result = { kind: "workflow-receipt", owner: this.owner, runId,
              ...(receipt ? { receipt } : { status: "unknown", message: "Interrupted workflow; do not repeat this run." }) };
            yield* log.append([{ type: "AikoWorkflowSettled", owner: this.owner, runId, turn: context.turn, result, at: Date.now() }]);
            return result;
          }
          const ref = (input as any)?.request;
          const call = this.calls.get(ref);
          this.calls.delete(ref);
          if (
            self.actor !== "aiko" ||
            self.thread !== this.thread ||
            !call ||
            call.turn !== context.turn ||
            call.name !== `workflow_${operation}` ||
            call.expires < Date.now()
          )
            return {
              kind: "workflow-receipt",
              owner: this.owner,
              status: "blocked",
            };
          yield* log.append([{ type: "AikoWorkflowStarted", owner: this.owner, runId, turn: context.turn, callId: context.callId, operation, at: Date.now() }]);
          const result = yield* Effect.tryPromise({
            try: async () => {
              this.outputs.set(runId, {
                turn: context.turn!,
                value: {},
                expires: Date.now() + 900000,
              });
              let receipt: unknown;
              if (operation === "run") {
                const program = call.args.program
                  ? JSON.parse(call.args.program)
                  : undefined;
                const parameters = call.args.input
                  ? JSON.parse(call.args.input)
                  : {};
                if (program) await this.engine.define(program);
                const workflowId = program?.id ?? call.args.workflowId;
                receipt = await this.engine.run({
                  workflowId,
                  runId,
                  input: parameters,
                  signal: context.signal,
                });
              } else if (operation === "crystallize")
                receipt = await this.engine.crystallize(call.args);
              else {
                const list = await this.engine.list();
                this.outputs.get(runId)!.value = list;
                receipt = { status: "completed" };
              }
              return {
                kind: "workflow-receipt",
                owner: this.owner,
                runId,
                receipt,
              };
            },
            catch: () => ({
              kind: "workflow-receipt",
              owner: this.owner,
              status: "blocked",
              message:
                "Workflow program, tool access, or execution could not be verified.",
            }),
          }).pipe(Effect.catch((result) => Effect.succeed(result)));
          yield* log.append([{ type: "AikoWorkflowSettled", owner: this.owner, runId, turn: context.turn, result, at: Date.now() }]);
          return result;
        }),
    }));
  }
}
