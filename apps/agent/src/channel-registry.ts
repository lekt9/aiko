import { hookClosure, type HookAdoption } from "./channel-hook-lifetime.ts";
import { channelDigest, CHANNEL_PROVENANCE } from "./channel-bindings.ts";
import type { Event } from "tardie/core/event";
import type { HandlerPin } from "./channel-wiring.ts";

/** Resolved from a retained parent invocation by trusted host code on EVERY call.
 * This is never accepted from sandbox input. A grant is not inherited by children. */
export interface ChannelManagementGrant {
  owner: string;
  execution: string;
  parentOperation: string;
  revision: string;
  authorityRef: string;
  depth: number;
  maxDepth: number;
  maxCalls: number;
  maxBytes: number;
  backlog: number;
  maxHops: number;
  deadline: number;
  handlers: readonly HandlerPin[];
  methods: readonly ("bind" | "connect" | "emit" | "request" | "wait")[];
}
export interface ChannelManagementBinding {
  /** Must check retained parent pin/claim, current authority and cancellation. */
  resolve(owner: string, execution: string): Promise<ChannelManagementGrant | undefined>;
}
const denied = () => Error("channel_management_denied");
export async function prepareChannelManagement(binding: ChannelManagementBinding, owner: string, execution: string,
  ordinal: number, method: string, raw: unknown, rows: readonly Event[]) {
  const grant = structuredClone(await binding.resolve(owner, execution).catch(() => { throw denied(); }));
  if (!grant || grant.owner !== owner || grant.execution !== execution || !grant.parentOperation || !grant.revision || !grant.authorityRef ||
    !Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(grant.maxCalls) || grant.maxCalls < 1 || grant.maxCalls > 64 || ordinal >= grant.maxCalls ||
    !Number.isSafeInteger(grant.depth) || !Number.isSafeInteger(grant.maxDepth) || grant.depth < 0 || grant.depth >= grant.maxDepth || grant.maxDepth > 8 ||
    !Number.isSafeInteger(grant.deadline) || grant.deadline <= Date.now() ||
    !Number.isSafeInteger(grant.maxBytes) || grant.maxBytes < 1 || grant.maxBytes > 1048576 ||
    !Number.isSafeInteger(grant.backlog) || grant.backlog < 1 || grant.backlog > 1024 ||
    !Number.isSafeInteger(grant.maxHops) || grant.maxHops < 1 || grant.maxHops > 32 ||
    !grant.methods.includes(method as never)) throw denied();
  const namespace = `child:${channelDigest([owner,execution,grant.parentOperation,grant.revision])}`;
  if (rows.some(e=>e.type === "AikoChannelWiringHandlerChecked" && e.owner === owner && e.id === execution)) throw denied();
  if (hookClosure(rows, owner, {execution, namespace, parentOperation: grant.parentOperation, deadline: grant.deadline}, Date.now())) throw denied();
  const operationId = `${namespace}:${ordinal}`;
  const args = structuredClone(raw) as any;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.hasOwn(args,"owner") || Object.hasOwn(args,"authorityRef")) throw denied();
  const portAllowed = (port: any) => rows.some(e => e.type === "AikoChannelWiringBound" && e.provenance === CHANNEL_PROVENANCE && e.owner === owner &&
    typeof e.operationId === "string" && e.operationId.startsWith(`${namespace}:`) &&
    (e.port as any)?.channel === port?.channel && (e.port as any)?.generation === port?.generation);
  const pinAllowed = (pin: any) => grant.handlers.some(p => p.harness === pin?.harness && p.contract === pin?.contract);
  const sending = (value: any) => {
    if (!value || value.authorityRef !== undefined || !portAllowed(value.port) || Buffer.byteLength(JSON.stringify(value.value ?? null)) > grant.maxBytes) throw denied();
    return {...value,occurrence:operationId,authorityRef:grant.authorityRef};
  };
  const waiting = (value: any) => {
    if (!value || value.authorityRef !== undefined || !portAllowed(value.port) || !pinAllowed(value.handler) ||
      !Number.isSafeInteger(value.deadline) || value.deadline > grant.deadline || value.deadline <= Date.now()) throw denied();
    return {...value,authorityRef:grant.authorityRef};
  };
  let prepared: unknown;
  if (method === "bind") {
    if (args.operationId !== undefined || args.maxBytes > grant.maxBytes || args.backlog > grant.backlog || args.maxHops > grant.maxHops) throw denied();
    prepared = {...args,name:operationId,operationId,authorityRef:grant.authorityRef,
      maxBytes:args.maxBytes ?? grant.maxBytes,backlog:args.backlog ?? grant.backlog,maxHops:args.maxHops ?? grant.maxHops};
  } else if (method === "connect") {
    if (args.operationId !== undefined || args.generation !== 1 || args.start !== "after-registration" || !portAllowed(args.input) || !portAllowed(args.output) || !pinAllowed(args.handler)) throw denied();
    prepared = {...args,name:operationId,operationId,authorityRef:grant.authorityRef};
  } else if (method === "emit") prepared = sending(args);
  else if (method === "wait") prepared = waiting(args);
  else if (method === "request") {
    if (args.operationId !== undefined) throw denied();
    prepared = {...args,operationId,send:sending(args.send),reply:waiting(args.reply)};
  } else throw denied();
  return {args:prepared, async recheck() {
    const current = await binding.resolve(owner,execution).catch(() => { throw denied(); });
    if (!current || current.deadline <= Date.now() || channelDigest(current) !== channelDigest(grant)) throw denied();
  }};
}

/** Uses the existing owner EventLog and private blobs. Only trusted host assembly
 * receives grant(); the sandbox only sees the attenuated channels package. */
export function retainedChannelManagement(
  journal: import("./harness-library.ts").HarnessJournal,
  blobs: import("./harness-library.ts").HarnessBlobStore,
  authorize: (owner: string, execution: string) => Promise<boolean>,
) {
  const find = async (owner: string, execution: string) => (await journal.read()).find(e =>
    e.type === "AikoChannelWiringManagementGranted" && e.provenance === CHANNEL_PROVENANCE && e.owner === owner && e.id === execution);
  const allowed = async (owner: string, execution: string) => {
    try { if (await authorize(owner,execution)) return; } catch {}
    throw denied();
  };
  return {
    async grant(value: ChannelManagementGrant) {
      const grant = structuredClone(value);
      await allowed(grant.owner,grant.execution);
      const grantRef = await blobs.putPrivate(grant.owner,grant);
      const previous = await find(grant.owner,grant.execution);
      if (previous) {
        if (previous.grantRef !== grantRef) throw Error("channel_management_grant_conflict");
        return;
      }
      await journal.append([{type:"AikoChannelWiringManagementGranted",provenance:CHANNEL_PROVENANCE,
        owner:grant.owner,id:grant.execution,grantRef,lifetime:"task",queuedWork:"cancel",
        namespace:`child:${channelDigest([grant.owner,grant.execution,grant.parentOperation,grant.revision])}`,
        parentOperation:grant.parentOperation,deadline:grant.deadline,at:0}]);
      if ((await find(grant.owner,grant.execution))?.grantRef !== grantRef) throw Error("channel_management_grant_conflict");
    },
    async resolve(owner: string, execution: string) {
      await allowed(owner,execution);
      const receipt = await find(owner,execution);
      if (!receipt) return undefined;
      try {
        const value = await blobs.get(owner,receipt.grantRef as import("./harness-library.ts").HarnessDigest) as ChannelManagementGrant;
        await allowed(owner,execution);
        if (value.owner !== owner || value.execution !== execution) throw denied();
        return value;
      } catch { throw denied(); }
    },
  };
}

import { Effect, Layer } from "effect";
import { Validator } from "@cfworker/json-schema";
import { Sandbox, type Bindings } from "tardie/code/sandbox/service";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { codeDispatched } from "tardie/code/execution/events";
import { codegraffSandboxLayer, type CodeSegmentTransport } from "./code-sandbox.ts";
import { HarnessLibrary, harnessDigest, harnessLibraryState, type HarnessLibraryBinding, type HarnessJournal, type HarnessJson, type HarnessDigest } from "./harness-library.ts";
import { channelSeal, channelHydrate } from "./channel-custody.ts";
import type { createChannelWiring, HandlerResult } from "./channel-wiring.ts";

export interface ChannelRegistryContinuationOptions {
  binding: HarnessLibraryBinding;
  journal: HarnessJournal;
  wiring(): ReturnType<typeof createChannelWiring>;
  /** Use the same isolated code-segment transport as the account CodeHarness. */
  transport: CodeSegmentTransport;
  authorize(pin: HandlerPin, operation: string | undefined, signal: AbortSignal): Promise<boolean>;
  /** Trusted policy derives depth/limits from retained parent lineage. Not exposed as a package. */
  grant(pin: HandlerPin, operation: string, execution: string, signal: AbortSignal): Promise<ChannelManagementGrant>;
  authorizeAdoption?(adoption: HookAdoption): Promise<string | undefined>;
}
/** Known pinned handlers run in the native code reactor. There is no promise waiter,
 * callback state, inferred source, ambient host eval, or retry of a one-shot job. */
export function channelRegistryContinuations(options: ChannelRegistryContinuationOptions) {
  const {binding,journal}=options, owner=binding.owner;
  const library=new HarnessLibrary(binding,journal);
  const execution=(operation:string)=>`channel-handler:${channelDigest([owner,binding.thread,operation])}`;
  const rowFor=async(exec:string)=>(await journal.read()).find(e=>e.type === "AikoChannelWiringHandlerDispatched" && e.owner === owner && e.id === exec && e.provenance === CHANNEL_PROVENANCE);
  const safeFact=(kind:string,id:string,data:object):Event=>({type:`AikoChannelWiring${kind}`,owner,id,provenance:CHANNEL_PROVENANCE,at:0,...data});
  const check=async(pin:HandlerPin,operation:string|undefined,signal:AbortSignal)=>{
    signal.throwIfAborted();
    if (!await options.authorize(pin,operation,signal)) throw denied();
    const resolved=await library.resolve(pin.harness as HarnessDigest);
    const hook=resolved.contract.applicability.hook as any;
    const context=await binding.context(signal), contextDigest=harnessDigest(context);
    if (resolved.artifact.contractDigest !== pin.contract || resolved.artifact.runtime !== "javascript" || resolved.artifact.dependencies.length ||
      Object.keys(resolved.artifact.files).length !== 1 || !Array.isArray(hook?.effects) || !hook.effects.includes("channel.manage") ||
      hook.effects.some((e:string)=>!["pure","channel.reply","channel.manage"].includes(e)) ||
      ![...harnessLibraryState(await journal.read(),owner).evaluations.values()].some(e=>e.eligible === true && e.harnessDigest === pin.harness && e.contractDigest === pin.contract && e.contextDigest === contextDigest)) throw denied();
    signal.throwIfAborted();
    return {...resolved,context,contextDigest};
  };
  const management=retainedChannelManagement(journal,binding.blobs,async(o,exec)=>{
    const row=await rowFor(exec);
    if(o!==owner||!row)return false;
    try {await check(row.pin as HandlerPin,String(row.operation),AbortSignal.timeout(5000));return true;}catch{return false;}
  });
  const readResult=async(pin:HandlerPin,operation:string,signal:AbortSignal):Promise<HandlerResult>=>{
    await check(pin,operation,signal);
    const row=await rowFor(execution(operation));
    if(!row || harnessDigest(row.pin)!==harnessDigest(pin))return {status:"pending",evidence:"native_handler_not_dispatched"};
    const checked=(await journal.read()).find(e=>e.type === "AikoChannelWiringHandlerChecked" && e.owner === owner && e.id === row.id);
    if(!checked)return {status:"pending",evidence:"native_handler_continuation_pending"};
    if(checked.status === "unavailable")return {status:"unavailable",evidence:"native_handler_private_data_unavailable"};
    const witness=harnessLibraryState(await journal.read(),owner).witnesses.get(operation);
    if(!witness||witness.status === "unknown")return {status:"pending",evidence:"native_handler_verification_unknown"};
    if(witness?.status !== "satisfied" || witness.harnessDigest!==pin.harness || witness.contractDigest!==pin.contract || !witness.outputRef)return {status:"rejected",evidence:"native_handler_contract_unconfirmed"};
    if(!await management.resolve(owner,String(row.id)))throw denied();
    const resolved=await check(pin,operation,signal);
    const retained=await channelHydrate(binding.blobs,owner,row.inputRef);
    if(retained.operation!==operation||harnessDigest(retained.pin)!==harnessDigest(pin)||resolved.contextDigest!==row.contextDigest||!await binding.authorize(resolved.artifact,resolved.contract,resolved.context,retained.input,signal))throw denied();
    const result=await binding.blobs.get(owner,witness.outputRef);
    await check(pin,operation,signal);
    return {status:"satisfied",output:result,evidence:`native-handler:${operation}`};
  };
  const api={
    async accepts(pin:HandlerPin,signal:AbortSignal) {try {await check(pin,undefined,signal);return true;}catch{return false;}},
    async execute(pin:HandlerPin,input:unknown,operation:string,signal:AbortSignal):Promise<HandlerResult> {
      const resolved=await check(pin,operation,signal),exec=execution(operation);
      if(!new Validator(resolved.contract.inputSchema as any).validate(input).valid)return {status:"rejected",evidence:"channel_handler_input_contract"};
      const old=await rowFor(exec);
      if(old) {
        const retained=await channelHydrate(binding.blobs,owner,old.inputRef);
        if(retained.operation!==operation||harnessDigest(retained.pin)!==harnessDigest(pin)||JSON.stringify(retained.input)!==JSON.stringify(input))throw Error("channel_handler_operation_conflict");
        return readResult(pin,operation,signal);
      }
      if(!await binding.authorize(resolved.artifact,resolved.contract,resolved.context,input as HarnessJson,signal))throw denied();
      const grant=await options.grant(pin,operation,exec,signal);
      if(grant.owner!==owner||grant.execution!==exec||grant.parentOperation!==operation||grant.deadline>Date.now()+resolved.contract.timeoutMs)throw denied();
      const inputRef=await channelSeal(binding.blobs,owner,{operation,pin,input}),sourceRef=await channelSeal(binding.blobs,owner,{execution:exec,source:resolved.artifact.files[resolved.artifact.entrypoint]});
      // Registration precedes dispatch; a crash in between is recovered by the component.
      const grantRef=await binding.blobs.putPrivate(owner,grant);
      await journal.append([safeFact("HandlerDispatched",exec,{operation,pin,inputRef,sourceRef,contextDigest:resolved.contextDigest,deadline:grant.deadline}),safeFact("ManagementGranted",exec,{grantRef,lifetime:"task",queuedWork:"cancel",namespace:`child:${channelDigest([owner,exec,grant.parentOperation,grant.revision])}`,parentOperation:grant.parentOperation,deadline:grant.deadline})]);
      return {status:"pending",evidence:"native_handler_registered"};
    },
    reconcile:readResult,
  };
  const native=component({name:"aiko.channel-registry-continuations",initial:()=>[] as Event[],step:(rows,e)=>[...rows,e],output:(rows)=>{
    const transitions=[];
    for(const row of rows.filter(e=>e.type === "AikoChannelWiringHandlerDispatched"&&e.owner===owner&&e.provenance===CHANNEL_PROVENANCE)) {
      const exec=String(row.id),operation=String(row.operation);
      if(rows.some(e=>e.type === "AikoChannelWiringHandlerChecked"&&e.owner===owner&&e.id===exec))continue;
      const settled=rows.find(e=>e.type === "CodeSettled"&&e.execId===exec);
      if(!rows.some(e=>e.type === "CodeDispatched"&&e.execId===exec)) {
        transitions.push(effect({key:`channel-handler-dispatch:${exec}`,input:undefined,act:()=>Effect.promise(async()=>{
          const signal=AbortSignal.timeout(Math.max(1,Number(row.deadline)-Date.now()));
          try {
            await check(row.pin as HandlerPin,operation,signal);
            if(!await management.resolve(owner,exec))throw denied();
            return [codeDispatched({execId:exec,code:"/* retained immutable channel handler */",at:0})];
          } catch { return [safeFact("HandlerChecked",exec,{operation,status:"unavailable"}),safeFact("Reconcile",`native:${exec}`,{invocation:operation})]; }
        })}));
      } else if(settled) transitions.push(effect({key:`channel-handler-verify:${exec}`,input:undefined,act:()=>Effect.promise(async()=>{
        let status="rejected";
        try {
          const signal=AbortSignal.timeout(Math.max(1,Number(row.deadline)-Date.now()));
          const resolved=await check(row.pin as HandlerPin,operation,signal);
          if(resolved.contextDigest!==row.contextDigest||Date.now()>=Number(row.deadline)||settled.error)throw denied();
          const retainedInput=await channelHydrate(binding.blobs,owner,row.inputRef);
          if(!await binding.authorize(resolved.artifact,resolved.contract,resolved.context,retainedInput.input,signal))throw denied();
          const retainedOutput=await channelHydrate(binding.blobs,owner,settled.result);
          if(retainedInput.operation!==operation||harnessDigest(retainedInput.pin)!==harnessDigest(row.pin)||retainedOutput.execution!==exec)throw denied();
          const input=retainedInput.input as HarnessJson,output=retainedOutput.output;
          await check(row.pin as HandlerPin,operation,signal);
          // Reuse the actual independent verifier, schema, witness and private output custody.
          const verifierLibrary=new HarnessLibrary({...binding,execute:async()=>{
            await check(row.pin as HandlerPin,operation,signal);
            return {status:"succeeded",output:output as HarnessJson,evidence:[`native-code:${exec}`]};
          }},journal);
          const witness=await verifierLibrary.run((row.pin as HandlerPin).harness as HarnessDigest,input,operation,signal);
          status=witness.status;
        }catch{status="unavailable";}
        return [safeFact("HandlerChecked",exec,{operation,status}),safeFact("Reconcile",`native:${exec}`,{invocation:operation})];
      })}));
    }
    return {view:{system:[],context:[],output:[],tools:[]},transitions};
  }});
  const sandboxLayer=<R,E>(base:Layer.Layer<never,E,R>)=>Layer.effect(Sandbox,Effect.gen(function*(){
    const ordinary=yield* Sandbox;
    const managed=yield* Sandbox.pipe(Effect.provide(options.wiring().sandboxLayer(codegraffSandboxLayer(options.transport),management)));
    return {run:(code:string,supplied:Bindings,ambient:any)=>{
      if(!String(ambient?.seed).startsWith("channel-handler:"))return ordinary.run(code,supplied,ambient);
      return Effect.promise(async()=>{
        const row=await rowFor(ambient.seed);if(!row)throw denied();
        const signal=AbortSignal.timeout(Math.max(1,Number(row.deadline)-Date.now()));
        const resolved=await check(row.pin as HandlerPin,String(row.operation),signal);
        if(resolved.contextDigest!==row.contextDigest||Date.now()>=Number(row.deadline)||!await management.resolve(owner,ambient.seed))throw denied();
        const retainedSource=await channelHydrate(binding.blobs,owner,row.sourceRef),retainedInput=await channelHydrate(binding.blobs,owner,row.inputRef);
        if(retainedSource.execution!==ambient.seed||retainedInput.operation!==row.operation||harnessDigest(retainedInput.pin)!==harnessDigest(row.pin)||retainedSource.source!==resolved.artifact.files[resolved.artifact.entrypoint])throw denied();
        const source=retainedSource.source,input=retainedInput.input;
        if(!await binding.authorize(resolved.artifact,resolved.contract,resolved.context,input,signal))throw denied();
        await check(row.pin as HandlerPin,String(row.operation),signal);
        return {source:String(source),input,row};
      }).pipe(Effect.flatMap(({source,input,row})=>managed.run(source,{channels:supplied.channels!,input},ambient).pipe(
        Effect.flatMap(outcome=>Effect.promise(async()=>{
          if(outcome.error)return {error:"native_channel_handler_failed"};
          await check(row.pin as HandlerPin,String(row.operation),AbortSignal.timeout(5000));
          return {result:await channelSeal(binding.blobs,owner,{execution:ambient.seed,output:outcome.result})};
        })),
      )),Effect.catchCause(()=>Effect.succeed({error:"native_channel_handler_unavailable"})));
    }};
  })).pipe(Layer.provide(base));
  return {...api,component:native,sandboxLayer,management,authorizeAdoption:options.authorizeAdoption};
}
