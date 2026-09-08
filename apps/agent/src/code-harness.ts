import { createHash } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import type { NativeTool } from "tardie/component/tool";
import { definePackage, type Package } from "tardie/code/package/definition";
import { Sandbox, type Bindings } from "tardie/code/sandbox/service";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { codegraffSandboxService, type CodeSegmentTransport } from "./code-sandbox.ts";
import { validateRouterInput } from "./connector-router-host.ts";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { codeDispatched } from "tardie/code/execution/events";
import { codeWorkflowDigest, type CodeWorkflowRecord, type WorkflowStore } from "./tool-workflows.ts";

import type { HarnessBlobStore, HarnessDigest } from "./harness-library.ts";
import { sandboxCanonical } from "./sandbox-job.ts";
import { createCodeSpeculation } from "./code-speculation.ts";
import { CodeData, codeDataEventKey, type CodeDataHandle } from "./code-data.ts";

export type CodeResultScope = { owner: string; thread: string; callId: string; tool: string; definitionDigest: string };
export interface CodeResultCustody {
  blobs: HarnessBlobStore;
  /** Trusted host policy: recheck current account, tool and invocation authority. */
  authorize(scope: CodeResultScope): Promise<boolean>;
  authorizeData?(scope: { owner: string; thread: string }): Promise<boolean>;
  read?(): Promise<readonly Event[]>;
}
type RetainedResult = CodeResultScope & { kind: "aiko-code-retained.v1"; ref: HarnessDigest };
type CodeCompactionState = {kind:"aiko-code-compaction.v1";owner:string;thread:string;providerState:unknown;sources:CodeResultScope[]};
const unavailable = "Private tool result unavailable; inspect retained receipts. Do not repeat uncertain writes.";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const controls = new Set(["execute", "respond", "send_message", "telegram_send", "telegram_voice", "telegram_screenshot", "tool_router_route", "tool_router_discover", "tool_router_describe", "tool_router_status", "code_workflow_run", "code_workflow_save", "code_workflow_list"]);
export const codeHarnessEventKey = (e: Event) => codeDataEventKey(e) ?? (["AikoCodeToolStarted", "AikoCodeToolSettled", "AikoToolDefinitionRecorded", "AikoCodeWorkflowSaved"].includes(e.type) && typeof e.id === "string" ? `aiko-code-tool:${e.type}:${e.id}` : undefined);
type ValueRef = { kind: "aiko-code-value"; owner: string; thread: string; id: string };

/** Per-owner/thread facade. Durable logs hold references and effect receipts, not private tool data. */
export class CodeHarness {
  private readonly values = new Map<string, { value: unknown; expires: number; bytes: number }>();
  private currentPackage?: Package<Self | EventLog>;
  private native = new Map<string, NativeTool<Self | EventLog>>();
  private readonly validators = new Map<string, Validator>();
  private readonly executionSignals = new Map<string, AbortSignal>();
  private readonly workflowRuns = new Map<string,{record:CodeWorkflowRecord;input:ValueRef}>();
  constructor(readonly owner: string, readonly thread: string, readonly transport: CodeSegmentTransport,
    readonly redact: (value: string) => string, readonly workflows?: WorkflowStore, readonly custody?: CodeResultCustody) {}

  toolSpecs() { return [...this.native.values()].map(tool => tool.spec); }

  private async contextSources(events:readonly Event[]):Promise<CodeResultScope[]> {
    const rows=this.custody?.read?await this.custody.read():events;
    const executions=events.filter(e=>e.type==="ToolReturned"&&typeof e.callId==="string").flatMap(result=>{
      const call=rows.findLast(e=>e.type==="ToolCalled"&&e.callId===result.callId&&e.turn===result.turn);
      const id=call?.name==="execute"?String(call.callId):call?.name==="code_workflow_run"?`workflow:${call.callId}`:undefined;
      return id&&rows.some(e=>e.type==="CodeDispatched"&&e.execId===id&&e.turn===call?.turn)?[id]:[];
    });
    const sources=rows.filter(e=>typeof e.callId==="string"&&executions.some(id=>String(e.callId).startsWith(`${id}.`))).flatMap(e=>
      e.type==="AikoCodeToolSettled"?[{owner:this.owner,thread:this.thread,callId:String(e.callId),tool:String(e.tool),definitionDigest:String(e.definitionDigest)}]:
      e.type==="AikoCodeDataRead"&&Array.isArray(e.sources)?e.sources as CodeResultScope[]:[]);
    return this.uniqueSources(sources);
  }
  private uniqueSources(sources:readonly CodeResultScope[]):CodeResultScope[] {
    const unique=[...new Map(sources.map(scope=>[sandboxCanonical(scope),scope])).values()];
    if(unique.length>2048)throw Error("Compaction source limit exceeded");
    return unique;
  }
  private async contextAuthorized(sources:readonly CodeResultScope[]):Promise<boolean> {
    for(const source of sources)if(!await this.authorized(source))return false;
    return true;
  }
  private async compactedContext(state:unknown):Promise<{providerState:unknown;sources:CodeResultScope[]}> {
    const row=state as CodeCompactionState;
    if(row?.kind!=="aiko-code-compaction.v1"||row.owner!==this.owner||row.thread!==this.thread||!Array.isArray(row.sources)||row.sources.length>2048||!Object.hasOwn(row,"providerState"))throw Error("Compaction source custody unavailable");
    if(!await this.contextAuthorized(row.sources))throw Error("Compaction source authority changed");
    return {providerState:row.providerState,sources:row.sources};
  }

  private speculationAuthority(method: string, args: any): boolean {
    if (["search", "describe", "query", "load"].includes(method)) return true;
    if (method !== "call" || args?.retain === true || typeof args?.name !== "string") return false;
    const native = this.native.get(args.name);
    if (native?.speculativeRead !== true) return false;
    try {
      const input = args.arguments ?? {};
      validateRouterInput(input);
      const encoded = JSON.stringify(input);
      return !!encoded && encoded.length <= 131072 && this.redact(encoded) === encoded && this.validators.get(args.name)?.validate(input).valid === true;
    } catch { return false; }
  }

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
  private async authorized(scope: CodeResultScope): Promise<boolean> {
    try {
      const custody = this.custody;
      if (!custody || !await custody.authorize({...scope})) return false;
      const native = this.native.get(scope.tool);
      if (!native?.authorizeRetained) return true;
      if (!custody.read || scope.owner !== this.owner || scope.thread !== this.thread || scope.definitionDigest !== `sha256:${digest(native.spec)}`) return false;
      const events = await custody.read();
      const settled = events.findLast(e => e.type === "AikoCodeToolSettled" && e.callId === scope.callId);
      // Initial invocation still passes the tool's ordinary current-authority gate.
      if (!settled) return true;
      if (settled.owner !== scope.owner || settled.tool !== scope.tool || settled.definitionDigest !== scope.definitionDigest) return false;
      const ref = settled.result as any;
      if (ref?.owner !== scope.owner || ref.thread !== scope.thread || ref.callId !== scope.callId || typeof ref.ref !== "string") return false;
      const row = await custody.blobs.get(this.owner, ref.ref) as any;
      if (row?.kind !== ref.kind || row.owner !== scope.owner || row.thread !== scope.thread || row.callId !== scope.callId) return false;
      let input: unknown;
      if (row.kind === "aiko-code-retained.v1") {
        if (row.tool !== scope.tool || row.definitionDigest !== scope.definitionDigest || !Object.hasOwn(row, "arguments")) return false;
        input = row.arguments;
      } else if (row.kind === "aiko-code-data-return.v1") {
        if (row.method !== "call" || row.args?.name !== scope.tool) return false;
        input = row.args.arguments ?? {};
      } else return false;
      return await native.authorizeRetained(input) && await custody.authorize({...scope});
    } catch { return false; }
  }
  private data(log?: typeof EventLog.Service) {
    const custody = this.custody;
    if (!custody?.authorizeData || !custody.read) throw Error("Persistent working data is unavailable on this host");
    return new CodeData({owner:this.owner,thread:this.thread,blobs:custody.blobs,
      read:log ? () => Effect.runPromise(log.read) : () => custody.read!(),
      append:events => log ? Effect.runPromise(log.append(events)) : Promise.reject(Error("Data writes require a native package invocation")),
      current:() => custody.authorizeData!({owner:this.owner,thread:this.thread}),
      authorizeSource:scope => this.authorized(scope),redact:this.redact});
  }
  private async retainDataReturn(method:string,args:unknown,callId:string,value:unknown,handles:CodeDataHandle[]) {
    const ref=await this.custody!.blobs.putPrivate(this.owner,{kind:"aiko-code-data-return.v1",owner:this.owner,thread:this.thread,callId,method,args,value,handles});
    return {kind:"aiko-code-data-return.v1",owner:this.owner,thread:this.thread,callId,ref};
  }
  private async hydrateResult(ref: unknown, callId: string, args: any, method="call"): Promise<unknown> {
    if ((ref as any)?.kind === "aiko-code-data-return.v1") {
      const r=ref as any,data=this.data();
      if(r.owner!==this.owner||r.thread!==this.thread||r.callId!==callId||!await this.custody!.authorizeData!({owner:this.owner,thread:this.thread}))throw Error(unavailable);
      const row=await this.custody!.blobs.get(this.owner,r.ref) as any;
      if(row?.kind!==r.kind||row.owner!==this.owner||row.thread!==this.thread||row.callId!==callId||row.method!==method||sandboxCanonical(row.args)!==sandboxCanonical(args)||!Array.isArray(row.handles))throw Error(unavailable);
      for(const handle of row.handles)await data.authorize(handle);
      if(!await this.custody!.authorizeData!({owner:this.owner,thread:this.thread}))throw Error(unavailable);
      return row.value;
    }
    const r = ref as RetainedResult;
    if (r?.kind !== "aiko-code-retained.v1") return this.get(ref);
    const native = this.native.get(args?.name);
    const scope: CodeResultScope = {owner:this.owner,thread:this.thread,callId,tool:args?.name,
      definitionDigest:`sha256:${digest(native?.spec ?? null)}`};
    if (!native || Object.entries(scope).some(([key,value]) => (r as any)[key] !== value) || !await this.authorized(scope))
      throw Error(unavailable);
    try {
      const row = await this.custody!.blobs.get(this.owner,r.ref) as any;
      if (row?.kind !== r.kind || Object.entries(scope).some(([key,value]) => row[key] !== value) ||
          sandboxCanonical(row.arguments) !== sandboxCanonical(args.arguments ?? {}) || !await this.authorized(scope)) throw Error(unavailable);
      return row.value;
    } catch { throw Error(unavailable); }
  }
  package(native: readonly NativeTool<Self | EventLog>[]) {
    this.native = new Map(native.filter(t => !controls.has(t.spec.name)).map(t => [t.spec.name,t]));
    for (const [name, tool] of this.native) this.validators.set(name,new Validator(structuredClone(tool.spec.inputSchema) as any));
    const invoke = (method: "search" | "describe" | "call" | "retain" | "query" | "bind" | "load" | "drop", raw: unknown, callId: string) => Effect.gen({self:this}, function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== this.thread) return {error:"owner_binding_mismatch"};
      let args: any;
      try {
        if ((raw as any)?.privateInput?.kind!=="aiko-code-value") throw new Error("Private input required");
        args = this.get((raw as any).privateInput);
      } catch { return {error:"Private code input expired or invalid"}; }
      if (["retain","query","bind","load","drop"].includes(method)) {
        const required: Record<string, readonly string[]> = { retain: ["value"], query: ["handle"], bind: ["name", "handle", "expectedGeneration"], load: ["name"], drop: ["name", "expectedGeneration"] };
        if (!args || typeof args !== "object" || required[method]!.some(field => !Object.hasOwn(args, field))) return { error: `Missing required ${method} input` };
        return yield* Effect.promise(async () => {
          try {
            const rows=await Effect.runPromise(log.read);
            const invocation=rows.findLast(e=>e.type==="PackageCalled"&&e.callId===callId&&e.name===`tools.${method}`);
            const execution=rows.findLast(e=>(e.type==="CodeDispatched"||e.type==="CodeSpeculationStarted")&&typeof e.execId==="string"&&callId.startsWith(`${e.execId}.`));
            if(!invocation||!execution||execution.turn!==invocation.turn)throw Error("Missing native data invocation");
            const data=this.data(log),handles:CodeDataHandle[]=[];
            let value:unknown;
            if(method==="retain") {
              // Derived values inherit the source authority of reads in this execution.
              const sources:CodeResultScope[]=rows.filter(e=>String(e.callId).startsWith(`${execution.execId}.`)).flatMap(e=>
                e.type==="AikoCodeToolSettled" ? [{owner:this.owner,thread:this.thread,callId:String(e.callId),tool:String(e.tool),definitionDigest:String(e.definitionDigest)}] :
                e.type==="AikoCodeDataRead"&&Array.isArray(e.sources) ? e.sources as CodeResultScope[] : []);
              const handle=await data.retain(args.value,callId,sources);handles.push(handle);value=handle;
            } else if(method==="query") {
              handles.push(args.handle);value=await data.query(args.handle,args,callId);
            } else {
              const bound=method==="load" ? await data.load(args.name,callId) : await data.bind(args.name,method==="drop"?undefined:args.handle,args.expectedGeneration,callId);
              if(bound.handle)handles.push(bound.handle);value=bound;
            }
            return await this.retainDataReturn(method,args,callId,value,handles);
          } catch (error) {return {error:this.redact(error instanceof Error?error.message:"Working data unavailable")};}
        });
      }
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
        validateRouterInput(input, 0, native.spec.name === "harness_experiment_start" ? ["proposalTokens"] : []);
        const encoded = JSON.stringify(input);
        if (!encoded || encoded.length > 131072 || this.redact(encoded) !== encoded || !this.validators.get(native.spec.name)!.validate(input).valid)
          throw new Error("Invalid input");
      } catch { return {error:"Arguments do not match the registered schema or contain sensitive data. Use tools.describe."}; }
      const events = yield* log.read;
      const schemaDigest = digest(native.spec.inputSchema);
      const definitionDigest = digest(native.spec);
      if (!events.some(e => e.type === "AikoToolDefinitionRecorded" && e.digest === `sha256:${definitionDigest}`)) {
        yield* log.append([{type:"AikoToolDefinitionRecorded",id:digest([definitionDigest,callId]),owner:this.owner,
          tool:native.spec.name,description:this.redact(native.spec.description ?? "").slice(0,500),
          digest:`sha256:${definitionDigest}`,schemaDigest:`sha256:${schemaDigest}`,at:Date.now()}]);
      }
      const dispatch = events.findLast(e=>e.type==="PackageCalled"&&e.callId===callId);
      if (!dispatch || typeof dispatch.turn !== "string") return {error:"Missing native package invocation"};
      const execution = events.findLast(e=>(e.type==="CodeDispatched"||e.type==="CodeSpeculationStarted")&&typeof e.execId==="string"&&callId.startsWith(`${e.execId}.`));
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
      const scope: CodeResultScope = {owner:this.owner,thread:this.thread,callId,tool:native.spec.name,definitionDigest:`sha256:${definitionDigest}`};
      if (this.custody && ! (yield* Effect.promise(() => this.authorized(scope)))) return {status:"unavailable",error:unavailable};
      yield* log.append([{type:"AikoCodeToolStarted",id,owner:this.owner,tool:native.spec.name,definitionDigest:`sha256:${definitionDigest}`,callId,turn:dispatch.turn,at:Date.now()}]);
      const result = yield* Effect.promise(parentSignal => {
        const executionSignal=this.executionSignals.get(String(execution?.execId));
        const signal=executionSignal?AbortSignal.any([parentSignal,executionSignal]):parentSignal;
        signal.throwIfAborted();
        return Effect.runPromise(native.run(input,{callId,turn:dispatch.turn as string,signal})
        .pipe(Effect.provideService(Self,self),Effect.provideService(EventLog,log)),{signal});
      });
      const ref = this.custody ? yield* Effect.promise(async () => {
        try {
          const encoded = JSON.stringify(result ?? null);
          if (args.retain===true || Buffer.byteLength(encoded) > 2 * 1024 * 1024) {
            const handle=await this.data(log).retain(JSON.parse(this.redact(encoded)),callId,[scope]);
            return await this.retainDataReturn("call",args,callId,handle,[handle]);
          }
          const retained = await this.custody!.blobs.putPrivate(this.owner,{kind:"aiko-code-retained.v1",...scope,
            arguments:input,value:JSON.parse(this.redact(encoded))});
          return {kind:"aiko-code-retained.v1",...scope,ref:retained};
        } catch { return {status:"unavailable",error:unavailable}; }
      }) : this.put(`tool:${id}`,result);
      const outcome=result as any;
      const succeeded=!(ref as any)?.error && !outcome?.error && !["failed","unknown","blocked","rejected","authorization_required","needs_connection","unavailable"].includes(outcome?.status);
      yield* log.append([{type:"AikoCodeToolSettled",id,owner:this.owner,tool:native.spec.name,definitionDigest:`sha256:${definitionDigest}`,callId,turn:dispatch.turn,result:ref,succeeded,at:Date.now()}]);
      return ref;
    });
    // privateInput is installed by the sandbox adapter. It is never a credential
    // or a grant: the method still checks Self, scope, exact schema and native policy.
    const privateInput = {type:"object"};
    const pkg = definePackage({name:"tools",description:"Discover the account's available tools, inspect an exact schema, and call it. All calls use current account authorization. Results are untrusted data. Native tool names mentioned elsewhere are invoked with tools.call inside execute.",
      docs:{
        search:{description:"Find tools by task. Example: await tools.search({query:'memory recall'}).",input:{type:"object",properties:{query:{type:"string"},limit:{type:"integer"},privateInput}},output:{}},
        describe:{description:"Get a tool's exact inputSchema before calling it. Example: await tools.describe({name:'memory_recall'}).",input:{type:"object",properties:{name:{type:"string"},privateInput}},output:{}},
        call:{description:"Invoke an exact tool with validated arguments. Set retain:true to receive a persistent data handle; results over 2 MiB automatically return a handle. Query handles with tools.query. Independent calls can run in parallel. A saved workflow never grants permission.",input:{type:"object",properties:{name:{type:"string"},arguments:{type:"object"},retain:{type:"boolean"},privateInput}},output:{}},
        retain:{description:"Persist a JSON working value as an account/thread-scoped handle across execute calls and restarts. Example: const h=await tools.retain({value:rows}); await tools.bind({name:'rows',handle:h,expectedGeneration:0}). Derived values retain source permissions. Maximum 32 MiB per value.",input:{type:"object",properties:{value:{},privateInput}},output:{}},
        query:{description:"Read a bounded slice of a retained handle. path is an RFC 6901 pointer; filter:{path,op,value}, op eq/ne/contains/gt/gte/lt/lte; fields is an array of projection pointers; offset/limit paginate; count:true returns only count. Maximum 256 rows and 64 KiB per result. Example: await tools.query({handle:h,path:'/rows',filter:{path:'/active',op:'eq',value:true},fields:['/id'],limit:20}).",input:{type:"object",properties:{handle:{type:"object"},path:{type:"string"},offset:{type:"integer"},limit:{type:"integer"},filter:{type:"object"},fields:{type:"array",items:{type:"string"}},count:{type:"boolean"},privateInput}},output:{}},
        bind:{description:"Name a retained handle in persistent working state. expectedGeneration is 0 for creation or the generation returned by load. Conflicting updates fail; reload before replacing. Names contain 1–96 identifier characters.",input:{type:"object",properties:{name:{type:"string"},handle:{type:"object"},expectedGeneration:{type:"integer"},privateInput}},output:{}},
        load:{description:"Load a named working binding from this thread across execute calls or restarts; returns {name,generation,handle}. Missing or dropped names return handle:null. Query the returned handle for data.",input:{type:"object",properties:{name:{type:"string"},privateInput}},output:{}},
        drop:{description:"Remove a named working binding using its current expectedGeneration. A tombstone preserves concurrency and replay; immutable historical handles remain governed by source permissions.",input:{type:"object",properties:{name:{type:"string"},expectedGeneration:{type:"integer"},privateInput}},output:{}},
      },
      authorizeSpeculation: (method, raw) => {
        try { return this.speculationAuthority(method, this.get((raw as any)?.privateInput)); } catch { return false; }
      },
      annotations:{search:{readOnlyHint:true,openWorldHint:false},describe:{readOnlyHint:true,openWorldHint:false},load:{readOnlyHint:true,openWorldHint:false},query:{readOnlyHint:true,openWorldHint:false}},
      methods:{search:(args,ctx)=>invoke("search",args,ctx.callId),describe:(args,ctx)=>invoke("describe",args,ctx.callId),call:(args,ctx)=>invoke("call",args,ctx.callId),retain:(args,ctx)=>invoke("retain",args,ctx.callId),query:(args,ctx)=>invoke("query",args,ctx.callId),bind:(args,ctx)=>invoke("bind",args,ctx.callId),load:(args,ctx)=>invoke("load",args,ctx.callId),drop:(args,ctx)=>invoke("drop",args,ctx.callId)},
    });
    const mounted = {...pkg, keys:{prefixes:["aiko-code-tool:","aiko-code-data:"],keyOf:codeHarnessEventKey}};
    this.currentPackage = mounted;
    return mounted;
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
                yield* log.append([{type:"AikoCodeWorkflowSaved",id:digest([promoted.digest,call.callId]),owner:harness.owner,
                  workflowId:promoted.id,description:promoted.description,digest:`sha256:${promoted.digest}`,
                  dependencies:promoted.dependencies.map(d=>({tool:d.name,digest:`sha256:${d.schemaDigest}`})),
                  execId:args.execId,harness:"aiko-code/1",at:Date.now()}]);
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
                if(!record||record.owner!==harness.owner||codeWorkflowDigest(record)!==record.digest||!new Validator(record.inputSchema as any).validate(args.input).valid)throw new Error("Workflow unavailable or input schema mismatch");
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
    return Layer.succeed(Sandbox)({managesParking:base.managesParking,replayVersion:base.replayVersion,run:(code,bindings,ambient)=> {
      const transformed: Record<string, unknown> = {...bindings};
      if(ambient?.seed.startsWith("workflow:")) {
        const run=harness.workflowRuns.get(ambient.seed);
        if(!run)return Effect.succeed({error:"Private workflow inputs expired; this execution cannot resume safely"});
        try {transformed.input=harness.get(run.input);}catch{return Effect.succeed({error:"Private workflow inputs expired"});}
        // Reusable workflows may use declared native tools only; they cannot spawn
        // untracked agents or turn promotion into a new authority source.
        delete transformed.agents;
      }
      if (bindings.tools && typeof bindings.tools === "object") transformed.tools = Object.fromEntries(Object.entries(bindings.tools).map(([method,fn])=>[method,async (args:unknown,ordinal:number,callSignal?:AbortSignal)=> {
        const inputId = harness.custody
          ? await harness.custody.blobs.putPrivate(harness.owner,{kind:"aiko-code-input.v1",owner:harness.owner,thread:harness.thread,callId:`${ambient?.seed}.${ordinal}`,method,args}).catch(() => { throw Error("Private code input unavailable"); })
          : digest([ambient?.seed,ordinal,args]);
        const ref = harness.put(`input:${inputId}`,args);
        const outcome = await (fn as any)({privateInput:ref},ordinal,callSignal);
        return outcome._tag==="Returned" ? {...outcome,result:await harness.hydrateResult(outcome.result,`${ambient?.seed}.${ordinal}`,args,method)} : outcome;
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
  inference<R>(base: Layer.Layer<Infer, never, R>) {
    const harness=this;
    return Layer.effect(Infer,Effect.gen(function*(){
      const model=yield* Infer;
      const hydrateTrajectory = async(events: readonly Event[]) => {
        const projected:Event[]=[];
        for(const e of events) {
          if(e.type==="CompactionCompleted"&&e.providerState!==undefined) {
            try{projected.push({...e,providerState:(await harness.compactedContext(e.providerState)).providerState});}catch{/* Restore the original authorized history instead of a revoked opaque window. */}
            continue;
          }
          if(e.type!=="ToolReturned" || (e.result as any)?.result?.kind!=="aiko-code-value") {projected.push(e);continue;}
          try {
            if(harness.custody&&!await harness.contextAuthorized(await harness.contextSources([e])))throw Error(unavailable);
            projected.push({...e,result:{...(e.result as any),...(harness.get((e.result as any).result) as object)}});
          }catch{projected.push({...e,result:{error:"Private code result expired or source authority changed; read fresh data before answering."}});}
        }
        return projected;
      };
      return {...model,
        ...(model.compact === undefined ? {} : { compact: (request: import("tardie/inference/contract").CompactionRequest, key?: string, signal?: AbortSignal) =>
          Effect.gen(function*(){
            const prepared=yield* Effect.promise(async()=>{
              try{
                const previous=request.previous===undefined?undefined:await harness.compactedContext(request.previous);
                const sources=harness.uniqueSources([...previous?.sources??[],...await harness.contextSources(request.trajectory)]);
                if(!await harness.contextAuthorized(sources))return undefined;
                return {sources,request:{...request,previous:previous?.providerState,trajectory:await hydrateTrajectory(request.trajectory)}};
              }catch{return undefined;}
            });
            if(!prepared)return undefined;
            const result=yield* model.compact!(prepared.request,key,signal);
            if(!result||!(yield* Effect.promise(()=>harness.contextAuthorized(prepared.sources))))return undefined;
            return {...result,state:{kind:"aiko-code-compaction.v1",owner:harness.owner,thread:harness.thread,providerState:result.state,sources:prepared.sources} satisfies CodeCompactionState};
          }) }),
        react:(request:InferRequest,key?:string,signal?:AbortSignal)=> {
        const sanitize = (action: import("tardie/log/events").Action) => {
          const normalize=(call:{callId:string;name:string;arguments:unknown})=> {
            if(call.name.startsWith("code_workflow_"))return {...call,arguments:{privateInput:harness.put(`workflow-call:${digest([request.identity,call.callId])}`,call.arguments)}};
            if(call.name!=="execute")return call;
            const code=(call.arguments as any)?.code;
            return typeof code!=="string"||code.length>65536||harness.redact(code)!==code
              ? {...call,arguments:{code:"throw new Error('Code rejected: invalid size or sensitive content')"}} : call;
          };
          if(action.kind==="call")return {...action,...normalize(action),...(typeof action.text==="string"?{text:harness.redact(action.text)}:{})};
          if(action.kind==="calls")return {...action,calls:action.calls.map(normalize),...(typeof action.text==="string"?{text:harness.redact(action.text)}:{})};
          return action;
        };
        return Effect.gen(function* () {
          const trajectory=yield* Effect.promise(()=>hydrateTrajectory(request.trajectory));
          const nativeCode = request.nativeCode === undefined ? undefined : {
            run: <A>(work: Effect.Effect<A, never, import("tardie/inference/contract").NativeCodeServices>, attemptSignal?: AbortSignal) =>
              request.nativeCode!.run(work.pipe(Effect.provide(harness.sandboxLayer())), attemptSignal)
          };
          const scopedRequest = { ...request, trajectory, nativeCode, tools: request.tools.filter(t => controls.has(t.name)) };
          const session = yield* createCodeSpeculation({ request: scopedRequest, attempt: key,
            packages: harness.currentPackage === undefined ? [] : [harness.currentPackage],
            authority: ({ packageName, method, args }) => packageName === "tools" && harness.speculationAuthority(method, args),
            acceptsSource: source => source.length <= 65536 && harness.redact(source) === source, signal });
          return yield* model.react({ ...scopedRequest, onToolCallProgress: session.onToolCallProgress }, key, signal)
            .pipe(Effect.map(sanitize), Effect.flatMap(session.finish), Effect.ensuring(Effect.sync(session.abort)));
        });
      }};
    })).pipe(Layer.provide(base));
  }
}
