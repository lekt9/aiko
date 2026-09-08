import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {Effect,Layer} from "effect";
import {actor,agentMessageMethod,codeMode} from "tardie";
import {createCloudflareAccountHost,type AccountStorage} from "../src/cloudflare-host.ts";
import {createHostedChannels,channelHarnessHandlers} from "../src/channel-host.ts";
import {channelRegistryContinuations} from "../src/channel-registry.ts";
import {channelWiringEventKey,channelWiringAppendAllowed} from "../src/channel-wiring.ts";
import {HarnessLibrary,harnessBlobStore,harnessDigest,harnessLibraryEventKey,type HarnessLibraryBinding,type HarnessContract,type HarnessArtifact} from "../src/harness-library.ts";
import {sqliteWorkflowKV} from "../src/workflow-store.ts";
import {CodeHarness} from "../src/code-harness.ts";
import {runCodeSegment} from "../src/code-sandbox-runner.ts";
import {createHarnessSandboxBinding} from "../src/harness-sandbox.ts";
import {localHarnessSandbox} from "../src/harness-sandbox-local.ts";
import {sandboxJobJournal} from "../src/sandbox-job-journal.ts";
import {sandboxEnvironment} from "../src/sandbox-job-runner.ts";

for(const scenario of ["restart","registration","wrong-final","revoked","missing-input","missing-source","missing-output"] as const)test(`pinned registry handler composes native child channels and independently settles: ${scenario}`,async()=>{
 const dir=await mkdtemp("/tmp/channel-registry-native-");let db=new Database(`${dir}/native.sqlite`);
 let host:Awaited<ReturnType<typeof createCloudflareAccountHost>>,hosted:ReturnType<typeof createHostedChannels>,registry:ReturnType<typeof channelRegistryContinuations>;
 let binding:HarnessLibraryBinding,library:HarnessLibrary,paused=scenario!=="missing-output",pauseVerification=scenario==="missing-output",pauseRegistration=scenario==="registration",allowed=true,childJobs=0,parentJobs=0,checks=0;
 const runtimeDigest=await sandboxEnvironment("channel-management-registry-test");
 const schema={type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false};
 const inputSchema={type:"object",properties:{value:{type:"object"},schema:{type:"string"},correlation:{type:"string"}},required:["value","schema","correlation"],additionalProperties:false};
 const verifiers=new Map();
 const definition=(name:string,effects:string[],source:string,prefix:string)=>{
  const verifier={digest:harnessDigest([name,"checker"]),evaluatorDigest:harnessDigest([name,"fixed-cases"]),cases:[{id:"dev",split:"development",input:{value:{text:"dev",preflight:true},schema:"text.v1",correlation:"dev"}},{id:"held",split:"held-out",input:{value:{text:"held",preflight:true},schema:"text.v1",correlation:"held"}}],
   verify:async({input,output}:any)=>{checks++;return {passed:output.text===`${prefix}${input.value.text}`,evidence:["independent-exact-output-contract"]};}};
  verifiers.set(verifier.digest,verifier);
  const contract:HarnessContract={version:1,outcome:`Produce ${prefix} followed by input text`,inputSchema,outputSchema:schema,effect:"read",verifierDigest:verifier.digest,evaluatorDigest:verifier.evaluatorDigest,applicability:{hook:{accepts:"text.v1",emits:"text.v1",inputSchema:{type:"object"},effects}},timeoutMs:60000};
  const artifact:HarnessArtifact={version:1,name,description:name,runtime:"javascript",entrypoint:"main.js",files:{"main.js":source},dependencies:[],sources:[],contractDigest:harnessDigest(contract)};
  return {contract,artifact,pin:{harness:harnessDigest(artifact),contract:harnessDigest(contract)}};
 };
 const child=definition("child",["pure","channel.reply"],"return {text:'child:'+input.value.text};","child:");
 const parentSource=`if(input.value.preflight)return {text:'parent:child:'+input.value.text};
 const a=await channels.bind({schema:'text.v1',directions:['inbox','outbox']});
 const b=await channels.bind({schema:'text.v1',directions:['inbox','outbox']});
 await channels.connect({generation:1,input:{channel:a.channel,generation:1},accepts:'text.v1',handler:${JSON.stringify(child.pin)},output:{channel:b.channel,generation:1,mode:'port'},start:'after-registration'});
 const reply=await channels.request({send:{port:{channel:a.channel,generation:1},schema:'text.v1',value:input.value,correlation:input.correlation},reply:{port:{channel:b.channel,generation:1},handler:${JSON.stringify(child.pin)},schema:'text.v1',correlation:input.correlation,deadline:input.value.deadline}});
 return {text:${scenario==="wrong-final"?"'forged:'":"'parent:'"}+reply.value.text};`;
 const parent=definition("parent",["channel.manage"],parentSource,"parent:child:");
 const storage:AccountStorage={sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const open=async()=>{
  const sandbox=localHarnessSandbox({owner:"alice",environmentDigest:runtimeDigest,journal:await sandboxJobJournal(db,`${dir}/key`)});
  const bridge=createHarnessSandboxBinding({owner:"alice",thread:"user-alice",placement:"local",sandbox,current:async()=>({owner:"alice",active:allowed,runtimeDigest,contextRef:"ctx",authorityRef:"grant",sessionRevision:null,effects:["read"],origins:[],methods:[],budget:{wallMs:5000,requests:0,outputBytes:32768}})});
  binding={owner:"alice",thread:"user-alice",blobs:harnessBlobStore(sqliteWorkflowKV(db)),verifiers,guard:()=>{},...bridge,execute:async(i,s)=>{if(i.artifact.name==="child")childJobs++;if(i.artifact.name==="parent")parentJobs++;return bridge.execute(i,s);}};
  const journal={read:()=>host.read("user-alice"),append:async(events:any[])=>{await host.seed("user-alice",events);}};
  library=new HarnessLibrary(binding,journal);
  const delegate={accepts:(...a:Parameters<typeof registry.accepts>)=>registry.accepts(...a),execute:(...a:Parameters<typeof registry.execute>)=>registry.execute(...a),reconcile:(...a:Parameters<typeof registry.reconcile>)=>registry.reconcile(...a)};
  hosted=createHostedChannels("alice",()=>host,undefined,{wiring:channelHarnessHandlers(binding,journal,async(o,g)=>allowed&&o==="alice"&&g==="grant",delegate)});
  registry=channelRegistryContinuations({binding,journal,wiring:()=>hosted.wiring!,transport:runCodeSegment,authorize:async(pin)=>allowed&&pin.harness===parent.pin.harness,
   grant:async(_pin,operation,execution)=>({owner:"alice",execution,parentOperation:operation,revision:"one",authorityRef:"grant",depth:0,maxDepth:2,maxCalls:8,maxBytes:4096,backlog:8,maxHops:2,deadline:Date.now()+59900,handlers:[child.pin],methods:["bind","connect","request"]})});
  const harness=new CodeHarness("alice","user-alice",runCodeSegment,s=>s);
  const native=hosted.wiring!.component;
  const controlled={...native,machine:{...native.machine,output:(state:any)=>{const out=native.machine.output(state);return {...out,transitions:out.transitions.filter(t=>!paused||!String(t.key).startsWith("aiko-channel-wiring:dispatch:")||!(state.state as any[]).some(e=>e.type==="AikoChannelWiringClaimed"&&String(t.key).includes(String(e.id))&&(e.wire as any)?.handler?.harness===child.pin.harness))};}}};
  const verification={...registry.component,machine:{...registry.component.machine,output:(state:any)=>{const out=registry.component.machine.output(state);return {...out,transitions:out.transitions.filter(t=>(!pauseVerification||!String(t.key).startsWith("channel-handler-verify:"))&&(!pauseRegistration||!String(t.key).startsWith("channel-handler-dispatch:")))};}}};
  const def=actor({name:"aiko",methods:{message:agentMessageMethod},components:[controlled,verification,codeMode([hosted.wiring!.package])]});
  host=await createCloudflareAccountHost({storage,actorName:"aiko",actorInstance:"registry",ownsThread:t=>t==="user-alice",actorFor:()=>def,layersFor:()=>registry.sandboxLayer(hosted.wiring!.sandboxLayer(harness.sandboxLayer())),keyOf:e=>channelWiringEventKey(e)??harnessLibraryEventKey(e),canAppend:(_t,b,r)=>channelWiringAppendAllowed(b,r)});
 };
 try{
  await open();await host!.commitRoot(host!.self("user-alice"),{type:"MessageReceived",id:"init",text:"initialize",at:0});
  for(const d of [child,parent]){await library!.registerContract(d.contract);await library!.record(d.artifact);expect((await library!.evaluate(d.pin.harness,`eval-${d.artifact.name}`,AbortSignal.timeout(10000))).eligible).toBe(true);}
  const baseline=childJobs,parentBaseline=parentJobs,checkBaseline=checks;
  const closed=channelHarnessHandlers(binding!,{read:()=>host!.read("user-alice"),append:async events=>{await host!.seed("user-alice",events);}},async()=>true);
  expect((await closed.execute(parent.pin,{value:{text:"denied"},schema:"text.v1",correlation:"denied"},"no-management-grant",AbortSignal.timeout(1000))).status).toBe("rejected");
  expect(parentJobs).toBe(parentBaseline);
  const input=await hosted!.run(hosted!.wiring!.api.bind({name:"parent-input",schema:"text.v1",directions:["inbox","outbox"],authorityRef:"grant",operationId:"parent-input"}));
  const output=await hosted!.run(hosted!.wiring!.api.bind({name:"parent-output",schema:"text.v1",directions:["inbox","outbox"],authorityRef:"grant",operationId:"parent-output"}));
  await hosted!.run(hosted!.wiring!.api.connect({name:"parent-wire",generation:1,input:{channel:input.channel,generation:1},accepts:"text.v1",handler:parent.pin,output:{channel:output.channel,generation:1,mode:"port"},start:"after-registration",authorityRef:"grant",operationId:"parent-wire"}));
  await hosted!.run(hosted!.wiring!.api.emit({port:{channel:input.channel,generation:1},schema:"text.v1",value:{text:"private-owned-input",deadline:Date.now()+55000},occurrence:"parent-once",correlation:"parent-task",authorityRef:"grant"}));
  await host!.drive();
  const before=await host!.read("user-alice");
  expect(before.some(e=>e.type==="BlockedOn")).toBe(scenario!=="registration");
  expect(before.filter(e=>e.type==="AikoChannelWiringBound")).toHaveLength(scenario==="registration"?2:4);
  expect(childJobs).toBe(baseline+(scenario==="missing-output"?1:0));
  if(scenario==="revoked")allowed=false;
  if(scenario.startsWith("missing-")){
   const request=before.find(e=>e.type==="AikoChannelWiringHandlerDispatched")!;
   const retained=scenario==="missing-input"?request.inputRef:scenario==="missing-source"?request.sourceRef:before.find(e=>e.type==="CodeSettled"&&e.execId===request.id)!.result;
   expect(db.query("DELETE FROM workflow_records WHERE key=?").run(`harness-blobs:${harnessDigest("alice")}:${(retained as any).ref}`).changes).toBe(1);
  }
  await host!.close();db.close();db=new Database(`${dir}/native.sqlite`);paused=false;pauseVerification=false;pauseRegistration=false;await open();await host!.recover();await host!.drive();
  const after=await host!.read("user-alice"),checked=after.find(e=>e.type==="AikoChannelWiringHandlerChecked");
  if(scenario==="restart"||scenario==="registration"){
   expect(checked?.status).toBe("satisfied");
   expect(after.filter(e=>e.type==="AikoChannelWiringWaitDelivered")).toHaveLength(1);
   expect(childJobs).toBe(baseline+1);
  } else if(scenario!=="revoked") {
   expect(checked?.status).toBe(scenario==="wrong-final"?"violated":"unavailable");
  }
  expect(after.filter(e=>e.type==="AikoChannelWiringBound")).toHaveLength(4);
  expect(parentJobs).toBe(parentBaseline);
  if(scenario==="restart"||scenario==="registration"||scenario==="wrong-final")expect(checks).toBe(checkBaseline+2);
  const count=childJobs;await host!.recover();await host!.drive();expect(childJobs).toBe(count);
  expect(JSON.stringify(after)).not.toContain("private-owned-input");expect(JSON.stringify(after)).not.toContain(parentSource);
 }finally{await host!?.close();db.close();await rm(dir,{recursive:true,force:true});}
},30000);
