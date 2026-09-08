import {Database} from 'bun:sqlite';
import {Effect,Layer} from 'effect';
import {EventLog} from 'tardie/core/log';
import {actor,infer,Infer,outputValidateOnce} from 'tardie';
import {createCloudflareAccountHost,type AccountStorage} from '../../src/cloudflare-host.ts';
import {voiceAndOutbox} from '../../src/actor.ts';
import {harnessBlobStore,harnessDigest,harnessLibraryEventKey,harnessLibraryAppendAllowed,type HarnessLibraryBinding,type HarnessContract} from '../../src/harness-library.ts';
import {sqliteWorkflowKV} from '../../src/workflow-store.ts';
import {createMediaProcessing,mediaProcessingEventKey,mediaProcessingAppendAllowed,mediaProcessingNextWake} from '../../src/media-processing.ts';

// Controlled finite executor, NOT a Python/media-quality witness. Independent
// processes share actual native SQLite append claims and encrypted private KV.
export async function openMediaWaitHost(dir:string,target:string,beforeExecute?:()=>Promise<void>,unknown=false,beforeWait?:()=>Promise<void>){
 const privateDb=new Database(dir+'/private.sqlite');
 privateDb.exec('CREATE TABLE IF NOT EXISTS fixture_counts(kind TEXT, id TEXT)');
 privateDb.exec('CREATE TABLE IF NOT EXISTS fixture_alarm(id INTEGER PRIMARY KEY, at INTEGER)');
 const count=(kind:string,id:string)=>privateDb.query('INSERT INTO fixture_counts VALUES (?,?)').run(kind,id);
 const verifierDigest=harnessDigest('wait-fixed-verifier'),evaluatorDigest=harnessDigest('wait-fixed-cases');
 const contract:HarnessContract={version:1,outcome:'Return the owned fixture asset identifier',inputSchema:{type:'object',properties:{asset:{type:'string'}},required:['asset'],additionalProperties:false},outputSchema:{type:'object',properties:{asset:{type:'string'}},required:['asset'],additionalProperties:false},effect:'read',verifierDigest,evaluatorDigest,timeoutMs:5000,applicability:{capability:'media.fixture',media:{version:1,priority:0,accepts:['video/'],inputs:{asset:{source:'asset'}}}}};
 const artifact={version:1 as const,name:'media.fixture',description:contract.outcome,runtime:'python' as const,entrypoint:'main.py',files:{'main.py':'def run(input): return input'},dependencies:[],contractDigest:harnessDigest(contract),sources:[]};
 const verifier={digest:verifierDigest,evaluatorDigest,cases:[{id:'a',split:'development' as const,input:{asset:'fixture-a'}},{id:'b',split:'held-out' as const,input:{asset:'fixture-b'}}],verify:async({input,output}:any)=>({passed:JSON.stringify(input)===JSON.stringify(output),quality:1,evidence:['controlled-exact-value']})};
 const library:HarnessLibraryBinding={owner:'123',thread:'user-123',blobs:harnessBlobStore(sqliteWorkflowKV(privateDb)),guard:()=>{},verifiers:new Map([[verifierDigest,verifier]]),context:async()=>({placement:'local',runtimeDigest:harnessDigest('wait-runtime'),bindings:{owner:'123'}}),authorize:async()=>true,authorizeEvaluation:async()=>true,execute:async(request)=>{count('execute',request.operationId);if(beforeExecute&&String((request.input as any).asset)==='fixture-a')await beforeExecute();return unknown?{status:'unknown',evidence:['controlled-unknown']}:{status:'succeeded',output:request.input,evidence:['controlled-executor']};}};
 let host:Awaited<ReturnType<typeof createCloudflareAccountHost>>;
 const journal={read:()=>host.read('user-123'),append:(events:any[])=>host.seed('user-123',events)};
 const media=createMediaProcessing({library,definitions:[{artifact,contract,verifier}],journal,authorize:async s=>s.owner==='123',delivery:async()=>({source:'telegram',chat:'123',sender:'123'})});
 const selected={...media.component,machine:{...media.component.machine,output:(state:unknown)=>{const value=media.component.machine.output(state);return {...value,transitions:value.transitions.filter(t=>t.kind==='effect'&&(t.input as any).id===target).map(t=>t.kind!=='effect'?t:{...t,act:(input:any,signal:AbortSignal)=>(t.act as any)(input,signal).pipe(Effect.tap((events:any)=>Effect.gen(function*(){const wait=events.find((e:any)=>e.type==='AikoMediaAcquisitionWaiting');if(wait&&process.argv[4]==='forge'){const log=yield* EventLog;yield* log.append([{...wait,evaluationId:'foreign-evaluation',observed:harnessDigest('forged-wait')},{type:'WaitFenceSentinel'}]);}if(wait)yield* Effect.promise(async()=>{await beforeWait?.();});})))})};}}};
 const outbox=voiceAndOutbox('123',input=>Effect.succeed({text:input.kind==='answer'?input.text:'done',source:'template' as const}),async(_chat,text)=>{count('send',text);return {status:'delivered'};});
 const definition=actor({name:'aiko',methods:{},components:[selected,infer([outputValidateOnce]),outbox]});
 const db=new Database(dir+'/native.sqlite');
 const storage:AccountStorage={sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>(privateDb.query('SELECT at FROM fixture_alarm WHERE id=1').get() as any)?.at??null,setAlarm:async(at)=>{privateDb.query('INSERT OR REPLACE INTO fixture_alarm VALUES (1,?)').run(Number(at));},deleteAlarm:async()=>{privateDb.query('DELETE FROM fixture_alarm').run();}};
 host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'media-wait-fixture',ownsThread:t=>t==='user-123',actorFor:()=>definition,layersFor:()=>Layer.succeed(Infer,{react:(r)=>Effect.succeed({kind:'complete' as const,output:'done:'+r.identity.turn}),resolve:()=>({model:{provider:'fixture',model_id:'wait'}})}),keyOf:e=>mediaProcessingEventKey(e)??harnessLibraryEventKey(e)??outbox.keys?.keyOf(e),canAppend:(_t,events,read)=>mediaProcessingAppendAllowed(events,read)&&harnessLibraryAppendAllowed(events,read),nextWake:async()=>mediaProcessingNextWake(await journal.read(),'123')});
 return {host,media,library,rows:journal.read,alarm:()=>storage.getAlarm(),counts:()=>privateDb.query('SELECT kind,id FROM fixture_counts').all() as {kind:string,id:string}[],close:async()=>{await host.close();db.close();privateDb.close();}};
}
if(import.meta.main){const f=await openMediaWaitHost(process.argv[2]!,process.argv[3]!,undefined,false,process.argv[4]==='race'?async()=>{process.stdout.write('WAITING\n');await Bun.stdin.text();}:undefined);try{await f.host.alarm();}finally{await f.close();}}
