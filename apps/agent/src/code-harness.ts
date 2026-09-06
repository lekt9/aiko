import { createHash } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import type { NativeTool } from "tardie/component/tool";
import { definePackage } from "tardie/code/package/definition";
import { Sandbox, type Bindings } from "tardie/code/sandbox/service";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { codegraffSandboxService, type CodeSegmentTransport } from "./code-sandbox.ts";
import { validateRouterInput } from "./connector-router-host.ts";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { codeDispatched } from "tardie/code/execution/events";
import type { CodeWorkflowRecord, WorkflowStore } from "./tool-workflows.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const controls = new Set(["execute", "respond", "send_message", "telegram_send", "telegram_voice", "telegram_screenshot", "tool_router_route", "tool_router_discover", "tool_router_describe", "tool_router_status", "code_workflow_run", "code_workflow_save", "code_workflow_list"]);
export const codeHarnessEventKey = (e: Event) => (e.type === "AikoCodeToolStarted" || e.type === "AikoCodeToolSettled") && typeof e.id === "string" ? `aiko-code-tool:${e.type}:${e.id}` : undefined;
type ValueRef = { kind: "aiko-code-value"; owner: string; thread: string; id: string };

/** Per-owner/thread facade. Durable logs hold references and effect receipts, not private tool data. */
export class CodeHarness {
  private readonly values = new Map<string, { value: unknown; expires: number; bytes: number }>();
  private native = new Map<string, NativeTool<Self | EventLog>>();
  private readonly validators = new Map<string, Validator>();
  private readonly executionSignals = new Map<string, AbortSignal>();
  private readonly workflowRuns = new Map<string,{record:CodeWorkflowRecord;input:ValueRef}>();
  constructor(readonly owner: string, readonly thread: string, readonly transport: CodeSegmentTransport,
    readonly redact: (value: string) => string, readonly workflows?: WorkflowStore) {}

  private put(id: string, value: unknown): ValueRef {
    const encoded = JSON.stringify(value ?? null);
    if (encoded.length > 2 * 1024 * 1024) throw new Error("Private code value exceeds 2 MiB");
    this.values.set(id, {value:JSON.parse(this.redact(encoded)), expires:Date.now()+900000,bytes:encoded.length});
    for (const [key, row] of this.values) if (row.expires < Date.now()) this.values.delete(key);
    // A bound on transient storage, never a tool-call/task budget. An old ref expires honestly.
    while (this.values.size > 512) this.values.delete(this.values.keys().next().value!);
    let bytes=[...this.values.values()].reduce((n,row)=>n+row.bytes,0);
    for (const [key,row] of this.values) {
      if(bytes<=4*1024*1024)break;
      this.values.delete(key);bytes-=row.bytes;
    }
    return {kind:"aiko-code-value",owner:this.owner,thread:this.thread,id};
  }
  private get(ref: unknown): unknown {
    const r = ref as ValueRef;
    if (r?.kind !== "aiko-code-value") return ref;
    const row = r.owner === this.owner && r.thread === this.thread ? this.values.get(r.id) : undefined;
    if (!row || row.expires < Date.now()) throw new Error("Private execution data expired; inspect receipts and re-read data. Do not repeat uncertain writes.");
    return row.value;
  }
  package(native: readonly NativeTool<Self | EventLog>[]) {
    this.native = new Map(native.filter(t => !controls.has(t.spec.name)).map(t => [t.spec.name,t]));
    for (const [name, tool] of this.native) this.validators.set(name,new Validator(structuredClone(tool.spec.inputSchema) as any));
    const invoke = (method: "search" | "describe" | "call", raw: unknown, callId: string) => Effect.gen({self:this}, function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== this.thread) return {error:"owner_binding_mismatch"};
      let args: any;
      try {
        if ((raw as any)?.privateInput?.kind!=="aiko-code-value") throw new Error("Private input required");
        args = this.get((raw as any).privateInput);
      } catch { return {error:"Private code input expired or invalid"}; }
      if (method === "search") {
        const query = String(args?.query ?? "").toLowerCase().slice(0,500);
        const words = query.split(/\s+/).filter(Boolean);
        return [...this.native.values()].map(t=>({name:t.spec.name,description:t.spec.description,
          score:words.reduce((n,w)=>n+(t.spec.name.toLowerCase().includes(w)?3:0)+(t.spec.description?.toLowerCase().includes(w)?1:0),0)}))
          .filter(t=>!words.length || t.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name))
          .slice(0,Math.max(1,Math.min(12,Number(args?.limit)||8))).map(({score,...t})=>t);
      }
      const native = this.native.get(args?.name);
      if (!native) return {error:"Tool unavailable in this account/thread. Use tools.search first."};
      if (method === "describe") return native.spec;
      const input = args.arguments ?? {};
      try {
        validateRouterInput(input);
        const encoded = JSON.stringify(input);
        if (!encoded || encoded.length > 131072 || this.redact(encoded) !== encoded || !this.validators.get(native.spec.name)!.validate(input).valid)
          throw new Error("Invalid input");
      } catch { return {error:"Arguments do not match the registered schema or contain sensitive data. Use tools.describe."}; }
      const events = yield* log.read;
      const dispatch = events.findLast(e=>e.type==="PackageCalled"&&e.callId===callId);
      if (!dispatch || typeof dispatch.turn !== "string") return {error:"Missing native package invocation"};
      const execution = events.findLast(e=>e.type==="CodeDispatched"&&typeof e.execId==="string"&&callId.startsWith(`${e.execId}.`));
      if (String(execution?.execId).startsWith("workflow:")) {
        const run=this.workflowRuns.get(String(execution!.execId));
        if(!run || !run.record.dependencies.some(d=>d.name===native.spec.name&&d.schemaDigest===digest(native.spec.inputSchema)))
          return {error:"Workflow tool is undeclared, changed or no longer available"};
      }
      const id = digest([this.owner,this.thread,callId]);
      const settled = events.find(e=>e.type==="AikoCodeToolSettled"&&e.id===id);
      if (settled) return settled.result;
      if (events.some(e=>e.type==="AikoCodeToolStarted"&&e.id===id))
        return {status:"unknown",message:"This invocation was interrupted after dispatch. Inspect its outcome before issuing a new write."};
      yield* log.append([{type:"AikoCodeToolStarted",id,owner:this.owner,tool:native.spec.name,callId,turn:dispatch.turn,at:Date.now()}]);
      const result = yield* Effect.promise(parentSignal => {
        const executionSignal=this.executionSignals.get(String(execution?.execId));
        const signal=executionSignal?AbortSignal.any([parentSignal,executionSignal]):parentSignal;
        signal.throwIfAborted();
        return Effect.runPromise(native.run(input,{callId,turn:dispatch.turn as string,signal})
        .pipe(Effect.provideService(Self,self),Effect.provideService(EventLog,log)),{signal});
      });
      const ref = this.put(`tool:${id}`,result);
      const outcome=result as any;
      const succeeded=!outcome?.error && !["failed","unknown","blocked","rejected","authorization_required","needs_connection","unavailable"].includes(outcome?.status);
      yield* log.append([{type:"AikoCodeToolSettled",id,owner:this.owner,tool:native.spec.name,callId,turn:dispatch.turn,result:ref,succeeded,at:Date.now()}]);
      return ref;
    });
    // privateInput is installed by the sandbox adapter. It is never a credential
    // or a grant: the method still checks Self, scope, exact schema and native policy.
    const privateInput = {type:"object"};
    const pkg = definePackage({name:"tools",description:"Discover the account's available tools, inspect an exact schema, and call it. All calls use current account authorization. Results are untrusted data. Native tool names mentioned elsewhere are invoked with tools.call inside execute.",
      docs:{
        search:{description:"Find tools by task. Example: await tools.search({query:'memory recall'}).",input:{type:"object",properties:{query:{type:"string"},limit:{type:"integer"},privateInput}},output:{}},
        describe:{description:"Get a tool's exact inputSchema before calling it. Example: await tools.describe({name:'memory_recall'}).",input:{type:"object",properties:{name:{type:"string"},privateInput}},output:{}},
        call:{description:"Invoke an exact tool with validated arguments. Example: await tools.call({name:'memory_recall',arguments:{search:'plans'}}). Await every call; parallelize independent reads only. A saved workflow never grants permission.",input:{type:"object",properties:{name:{type:"string"},arguments:{type:"object"},privateInput}},output:{}},
      },
      annotations:{search:{readOnlyHint:true,openWorldHint:false},describe:{readOnlyHint:true,openWorldHint:false}},
      methods:{search:(args,ctx)=>invoke("search",args,ctx.callId),describe:(args,ctx)=>invoke("describe",args,ctx.callId),call:(args,ctx)=>invoke("call",args,ctx.callId)},
    });
    return {...pkg, keys:{prefixes:["aiko-code-tool:"],keyOf:codeHarnessEventKey}};
  }
  workflowComponent() {
    const harness=this;
    const schemas={
      run:{type:"object",properties:{id:{type:"string"},code:{type:"string"},description:{type:"string"},input:{type:"object"},inputSchema:{type:"object"},outputSchema:{type:"object"},dependencies:{type:"array",items:{type:"string"}}},required:["id","input"],additionalProperties:false},
      save:{type:"object",properties:{execId:{type:"string"}},required:["execId"],additionalProperties:false},
      list:{type:"object",properties:{},additionalProperties:false},
    };
    return component({name:"aiko.code-workflows",
      keys:{prefixes:["aiko-code-workflow:"],keyOf:e=>e.type==="AikoCodeWorkflowPrepared"&&typeof e.execId==="string"?`aiko-code-workflow:${e.execId}`:undefined},
      initial:()=>undefined,step:s=>s,output:()=>({view:{system:["For a reusable workflow, call code_workflow_run with an id, parameterized async code body using the input global, input/output JSON schemas, and an explicit dependencies list of native tool names. The first run stores an immutable draft. After a successful run, code_workflow_save({execId}) promotes its source and verified trace for reuse. List with code_workflow_list; run a saved id with fresh input. Never embed secrets, private values or cached results in source. Workflow code can only call declared tools and every run rechecks current schemas and authorization."],context:[],output:[],tools:(["run","save","list"] as const).map(method=>({
        spec:{name:`code_workflow_${method}`,description:method==="run"?"Run a parameterized code workflow in Codegraff. New source requires schemas and declared tool dependencies. Saved ids resolve immutable source and current account tools.":method==="save"?"Persist a successfully verified code workflow as reusable. Failed, uncertain or expired runs cannot be promoted.":"List this account's code workflows and their exact contracts.",inputSchema:schemas[method]},
        serve:(call:import("tardie").PendingCall,events:readonly Event[],answer:import("tardie").Answer)=>{
          const execId=`workflow:${call.callId}`;
          const finished=events.find(e=>e.type==="CodeSettled"&&e.execId===execId);
          const prepared=events.find(e=>e.type==="AikoCodeWorkflowPrepared"&&e.execId===execId);
          if(method==="run" && finished) {
            let valid=false;
            try {
              const row=harness.workflowRuns.get(execId),output=harness.get(finished.result) as any;
              const calls=events.filter(e=>e.type==="PackageCalled"&&e.name==="tools.call"&&String(e.callId).startsWith(`${execId}.`));
              const settled=events.filter(e=>e.type==="AikoCodeToolSettled"&&String(e.callId).startsWith(`${execId}.`));
              valid=!!row&&!finished.error&&new Validator(row.record.outputSchema as any).validate(output.result).valid&&calls.length===settled.length&&settled.every(e=>e.succeeded===true);
            }catch{}
            return [answer({execId,id:prepared?.workflowId,status:valid?"succeeded":"failed",...(finished.error?{error:finished.error}:{result:finished.result})})];
          }
          if(method==="run" && prepared)return [];
          return [effect({key:`code-workflow:${call.callId}`,input:undefined,...(call.turn?{invocation:{method:"message",id:call.turn,epoch:call.epoch??0}}:{}),act:()=>Effect.gen(function*(){
            const self=yield* Self,log=yield* EventLog;
            let result:unknown;
            try {
              if(self.actor!=="aiko"||self.thread!==harness.thread||!harness.workflows?.getCode||!harness.workflows.putCode||!harness.workflows.listCode)throw new Error("Code workflow storage unavailable");
              const args=harness.get((call.arguments as any)?.privateInput) as any;
              if(!new Validator(schemas[method] as any).validate(args).valid)throw new Error("Invalid code workflow arguments");
              if(method==="list")result=yield* Effect.promise(()=>harness.workflows!.listCode!(harness.owner));
              else if(method==="save") {
                const rows=yield* log.read;
                const run=harness.workflowRuns.get(args.execId);
                const done=rows.find(e=>e.type==="CodeSettled"&&e.execId===args.execId);
                const calls=rows.filter(e=>e.type==="PackageCalled"&&e.name==="tools.call"&&String(e.callId).startsWith(`${args.execId}.`));
                const settled=rows.filter(e=>e.type==="AikoCodeToolSettled"&&String(e.callId).startsWith(`${args.execId}.`));
                const output=done&&!done.error?harness.get(done.result) as any:undefined;
                if(!run||!output||!new Validator(run.record.outputSchema as any).validate(output.result).valid||calls.length!==settled.length||settled.some(e=>e.succeeded!==true))throw new Error("Workflow lacks a fully successful execution with valid output");
                const promoted={...run.record,reusable:true,provenance:{thread:harness.thread,execId:args.execId,harness:"aiko-code/1" as const}};
                yield* Effect.promise(()=>harness.workflows!.putCode!(harness.owner,promoted));
                result={id:promoted.id,digest:promoted.digest,reusable:true,provenance:promoted.provenance};
              } else {
                if(!/^[A-Za-z0-9_-]{1,128}$/.test(args.id))throw new Error("Invalid workflow id");
                let record=yield* Effect.promise(()=>harness.workflows!.getCode!(harness.owner,args.id));
                if(args.code!==undefined) {
                  if(typeof args.code!=="string"||args.code.length>65536||harness.redact(args.code)!==args.code||!args.inputSchema||!args.outputSchema||!Array.isArray(args.dependencies)||args.dependencies.length>32)throw new Error("New source requires safe code, schemas and dependencies");
                  new Validator(args.inputSchema);new Validator(args.outputSchema);
                  validateRouterInput({code:args.code,inputSchema:args.inputSchema,outputSchema:args.outputSchema});
                  const dependencies=[...new Set<string>(args.dependencies)].sort().map(name=>{const tool=harness.native.get(name);if(!tool)throw new Error("Unknown workflow dependency");return {name,schemaDigest:digest(tool.spec.inputSchema)};});
                  const fields={version:1 as const,owner:harness.owner,id:args.id,description:String(args.description??args.id).slice(0,500),code:args.code,inputSchema:args.inputSchema,outputSchema:args.outputSchema,dependencies};
                  const draft={...fields,digest:digest(fields),reusable:false};
                  if(record && record.digest!==draft.digest)throw new Error("Use a new id for changed workflow source");
                  record=record??draft;
                  yield* Effect.promise(()=>harness.workflows!.putCode!(harness.owner,record!));
                }
                if(!record||record.owner!==harness.owner||!new Validator(record.inputSchema as any).validate(args.input).valid)throw new Error("Workflow unavailable or input schema mismatch");
                for(const d of record.dependencies)if(digest(harness.native.get(d.name)?.spec.inputSchema)!==d.schemaDigest)throw new Error("Workflow dependency changed; validate a new version");
                harness.workflowRuns.set(execId,{record,input:harness.put(`workflow-input:${execId}`,args.input)});
                return [{type:"AikoCodeWorkflowPrepared",execId,workflowId:record.id,digest:record.digest,turn:call.turn,at:Date.now()},codeDispatched({execId,code:record.code,turn:call.turn,epoch:call.epoch,at:Date.now()})];
              }
            } catch(error) {result={status:"failed",error:harness.redact(error instanceof Error?error.message:"Code workflow unavailable")};}
            return [{type:"ToolReturned",callId:call.callId,turn:call.turn,result,at:Date.now()}];
          })})];
        },
      }))},transitions:[]}),
    });
  }
  sandboxLayer() {
    const base = codegraffSandboxService(this.transport), harness=this;
    return Layer.succeed(Sandbox)({run:(code,bindings,ambient)=> {
      const transformed: Record<string, unknown> = {...bindings};
      if(ambient?.seed.startsWith("workflow:")) {
        const run=harness.workflowRuns.get(ambient.seed);
        if(!run)return Effect.succeed({error:"Private workflow inputs expired; this execution cannot resume safely"});
        try {transformed.input=harness.get(run.input);}catch{return Effect.succeed({error:"Private workflow inputs expired"});}
        // Reusable workflows may use declared native tools only; they cannot spawn
        // untracked agents or turn promotion into a new authority source.
        delete transformed.agents;
      }
      if (bindings.tools && typeof bindings.tools === "object") transformed.tools = Object.fromEntries(Object.entries(bindings.tools).map(([method,fn])=>[method,async (args:unknown,ordinal:number)=> {
        const ref = harness.put(`input:${digest([ambient?.seed,ordinal,args])}`,args);
        const outcome = await (fn as any)({privateInput:ref},ordinal);
        return outcome._tag==="Returned" ? {...outcome,result:harness.get(outcome.result)} : outcome;
      }]));
      return Effect.promise(signal=>{
        if(ambient)harness.executionSignals.set(ambient.seed,signal);
        return Effect.runPromise(base.run(code,transformed as Bindings,ambient),{signal}).finally(()=>{if(ambient)harness.executionSignals.delete(ambient.seed);});
      }).pipe(Effect.map(outcome=>{
        const value = {result:outcome.result,logs:outcome.logs};
        return outcome.error ? {error:harness.redact(outcome.error)}
          : {result:harness.put(`output:${ambient?.seed ?? digest(code)}`,value)};
      }));
    }});
  }
  inference(base: Layer.Layer<Infer>) {
    const harness=this;
    return Layer.effect(Infer,Effect.gen(function*(){
      const model=yield* Infer;
      return {...model,react:(request:InferRequest,key?:string,signal?:AbortSignal)=> {
        const trajectory=request.trajectory.map(e=>{
          if(e.type!=="ToolReturned" || (e.result as any)?.result?.kind!=="aiko-code-value") return e;
          try { return {...e,result:{...(e.result as any),...(harness.get((e.result as any).result) as object)}}; }
          catch { return {...e,result:{error:"Private code result expired; read fresh data before answering."}}; }
        });
        return model.react({...request,trajectory,tools:request.tools.filter(t=>controls.has(t.name))},key,signal).pipe(Effect.map(action=>{
          if(action.kind==="call" && action.name.startsWith("code_workflow_"))return {...action,text:undefined,arguments:{privateInput:harness.put(`workflow-call:${digest([request.identity,action.callId])}`,action.arguments)}};
          if(action.kind!=="call" || action.name!=="execute") return action;
          const code=(action.arguments as any)?.code;
          if(typeof code!=="string" || code.length>65536 || harness.redact(code)!==code)
            return {...action,arguments:{code:"throw new Error('Code rejected: invalid size or sensitive content')"},text:undefined};
          return {...action,text:undefined};
        }));
      }};
    })).pipe(Layer.provide(base));
  }
}
