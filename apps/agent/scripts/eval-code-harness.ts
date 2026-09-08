import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce, system, tool } from "tardie";
import {createModelRouting,parseModelRouting} from "../src/model-routing.ts";
import { usageIn } from "tardie/inference/usage";
import { loadConfig } from "../src/config.ts";
import { Codegraff, CodegraffSandbox } from "../src/codegraff.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

// Fixed matched cases: external effects are fixture reads; only inference and
// execution in the already-owned probe VM are live. Eight model calls per case.
process.umask(0o077);
const config=await loadConfig();
if(config.mode!=="live"||!config.modelKey)throw new Error("Live configuration required");
const root=new URL("../../..",import.meta.url).pathname;
const reportDirectory=`${root}/artifacts/aiko-cloudflare`;
await mkdir(reportDirectory,{recursive:true,mode:0o700});
const probe=new Database(join(process.env.AIKO_PROBE_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "unbrowse/aiko/cloudflare-probe"), "probe.sqlite"));
const sandbox=new CodegraffSandbox({owner:"acct_cloudflare_probe01",gateway:new Codegraff(config.modelKey),store:{
  get:async <T>(key:string)=>{const row=probe.query("SELECT value FROM state WHERE key=?").get(key) as any;return row?JSON.parse(row.value) as T:undefined;},
  put:async(key,value)=>{probe.query("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value));},
},emit:async()=>{},runnerBundle:await Bun.file(new URL("../assets/runner.txt",import.meta.url)).text(),bootstrap:await Bun.file(new URL("../assets/bootstrap.sh",import.meta.url)).text()});
const cases=[
  {id:"development",prompt:"Find the total hours for the open tasks on project North. Read the list, then fetch details only for its open tasks. Return exactly JSON {\"hours\":number,\"ids\":string[]} with ids sorted.",project:"North",rows:[{id:"n1",open:true,hours:3},{id:"n2",open:false,hours:99},{id:"n3",open:true,hours:5}],expected:{hours:8,ids:["n1","n3"]}},
  {id:"heldout",prompt:"Find the total hours for the open tasks on project South. Read the list, then fetch details only for its open tasks. Return exactly JSON {\"hours\":number,\"ids\":string[]} with ids sorted.",project:"South",rows:[{id:"s9",open:false,hours:20},{id:"s3",open:true,hours:7},{id:"s1",open:true,hours:11}],expected:{hours:18,ids:["s1","s3"]}},
];
const report:{at:string;model:string;sourceDigest:string;results:any[];scope:string}={at:new Date().toISOString(),model:config.model??"glm-5.3-flash",sourceDigest:createHash("sha256").update(await Bun.file(new URL("../src/code-harness.ts",import.meta.url)).text()).digest("hex"),results:[],scope:"Fixed fixture tasks through a live model; code executes in Codegraff. Not a representative production benchmark."};
try {
  for(const testCase of cases)for(const mode of ["direct","code"] as const){
    const db=new Database(":memory:");let alarm:number|null=null;
    const storage:AccountStorage={sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;},deleteAlarm:async()=>{alarm=null;}};
    const observed:string[]=[];
    const native=[
      {spec:{name:"fixture_list",description:"List task ids and open state for a project; hours require fixture_detail.",inputSchema:{type:"object",properties:{project:{type:"string"}},required:["project"],additionalProperties:false}},run:(args:any)=>Effect.sync(()=>{observed.push(`list:${args.project}`);return args.project===testCase.project?testCase.rows.map(({hours,...row})=>row):[];})},
      {spec:{name:"fixture_detail",description:"Read a task's details, including its hours.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}},run:(args:any)=>Effect.sync(()=>{observed.push(args.id);return testCase.rows.find(row=>row.id===args.id)??{error:"not_found"};})},
    ];
    const harness=new CodeHarness("123","user-123",(input,signal)=>sandbox.codeSegment(input,signal),s=>s);
    const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([
      system("Complete the task only from observed tool results. Available read tools are fixture_list and fixture_detail. Return the requested JSON with no prose or markdown. "+(mode==="code"?"Use execute and tools.describe/ tools.call. Compose independent reads in one JavaScript body when practical.":"Call the available read tools.")),
      mode==="code"?codeMode([harness.package(native)],{policy:{call:{attemptTimeoutMs:300000,retryDelaysMs:[]}}}):tool(native),outputValidateOnce,
    ])]});
    let modelCalls=0;
    const live=createModelRouting({owner:"123",config:parseModelRouting({}, {model:report.model,maxOutputTokens:1536,contextWindowTokens:32768}),env:{CODEGRAFF_API_KEY:config.modelKey,AIKO_ALLOW_PAID_INFERENCE:"true"}}).layer("conversation");
    const limited=Layer.effect(Infer,Effect.gen(function*(){const model=yield* Infer;return {...model,react:(...args:Parameters<typeof model.react>)=>++modelCalls>8?Effect.succeed({kind:"fail" as const,error:"Evaluation model-call limit"}):model.react(...args)};})).pipe(Layer.provide(live));
    const host=await createCloudflareAccountHost({storage,actorName:"aiko",actorInstance:`eval-${mode}`,ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>mode==="code"?Layer.merge(harness.inference(limited),harness.sandboxLayer()):limited});
    const start=Date.now();
    try {
      await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:testCase.id,text:testCase.prompt,at:Date.now()});await host.drive();
      const events=await host.read("user-123"),terminal=events.findLast(e=>e.type==="TurnCompleted");
      const output=typeof terminal?.output==="string"?JSON.parse(terminal.output):terminal?.output;
      const correct=JSON.stringify(output)===JSON.stringify(testCase.expected)||output?.hours===testCase.expected.hours&&JSON.stringify(output.ids)===JSON.stringify(testCase.expected.ids);
      const relevant=observed.length===3 && observed[0]===`list:${testCase.project}` && observed.slice(1).sort().join(",")===testCase.expected.ids.join(",");
      const item={case:testCase.id,mode,correct,relevant,modelCalls,durationMs:Date.now()-start,usage:usageIn(events,testCase.id),observed,output};
      report.results.push(item);console.log(JSON.stringify(item));
      await Bun.write(`${reportDirectory}/code-harness-${testCase.id}-${mode}-trace.json`,JSON.stringify(events,null,2));
    }catch(error){const item={case:testCase.id,mode,correct:false,error:String(error),modelCalls,durationMs:Date.now()-start};report.results.push(item);console.log(JSON.stringify(item));}
    finally{db.close();await Bun.write(`${reportDirectory}/code-harness-eval.json`,JSON.stringify(report,null,2));}
  }
  if(report.results.some(row=>!row.correct||!row.relevant))process.exitCode=1;
}finally{probe.close();}
