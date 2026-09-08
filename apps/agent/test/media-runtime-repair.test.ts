import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {Effect,Layer} from 'effect';
import {Infer} from 'tardie';
import {createService} from '../src/server.ts';
import {PERSONA,type AikoConfig} from '../src/config.ts';
import {credentialDigest} from '../src/plane-auth.ts';
import {Codegraff} from '../src/codegraff.ts';
import {ProvisionedComputeHarness,trustedCodegraffMediaRecipe} from '../src/compute-harness.ts';
import {createPythonSandboxRuntime,type SandboxPythonRuntime} from '../src/sandbox-python.ts';
import {pythonComputeRunner,computeRunnerEnvironment} from '../src/compute-runner-entry.ts';
import {sandboxJobJournal} from '../src/sandbox-job-journal.ts';
import {runSandboxJob} from '../src/sandbox-job-runner.ts';
import {runCodeSegment} from '../src/code-sandbox-runner.ts';
import {sandboxDigest,type SandboxJob} from '../src/sandbox-job.ts';

test('production native media repairs definite missing closure on retained compute, admits linked child and reuses across channels/reopen',async()=>{
 const dir=await mkdtemp('/tmp/native-media-repair-'),db=new Database(join(dir,'jobs.sqlite'));
 const journal=await sandboxJobJournal(db,join(dir,'job.key'));
 const bundle='controlled trusted compute fixture';
 const recipe=trustedCodegraffMediaRecipe('fixture==1 --hash=sha256:'+'a'.repeat(64),{repository:'fixture/model',revision:'a'.repeat(40),files:{'model.bin':{bytes:1,sha256:'a'.repeat(64)}}});
 let allocations=0,builds=0,jobs:SandboxJob[]=[],missing=true;
 let selected:SandboxPythonRuntime|undefined,packages='',config:any,service:Awaited<ReturnType<typeof createService>>|undefined;
 const runtimes:SandboxPythonRuntime[]=[], files=new Map<string,string>(),sends:any[]=[];
 const gateway=new Codegraff('controlled-never-external',async(url,init)=>{
  const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
  if(path==='/v1/sandboxes'){allocations++;return Response.json({id:'retained-compute'});}
  if(path.endsWith('/upload')){files.set(body.path,Buffer.from(body.contentBase64,'base64').toString());return Response.json({});}
  if(path.endsWith('/download')){const data=files.get(body.path);return data===undefined?new Response('',{status:404}):Response.json({contentBase64:Buffer.from(data).toString('base64')});}
  if(path.endsWith('/exec')){
   const args=body.command.split(' ');
   if(body.command.startsWith('bash /tmp/aiko-compute-cloak-'))return Response.json({execId:'cloak'});
   if(args[2]==='setup'){
    builds++;packages=join(dir,`packages-${builds}`);await mkdir(packages);await writeFile(join(packages,'marker.py'),'VALUE = 42\n');
    selected=await createPythonSandboxRuntime({packages,tools:{ffmpeg:'/usr/bin/ffmpeg',ffprobe:'/usr/bin/ffprobe'},sharedLibraries:['/usr/lib/libSDL3.so.0']});runtimes.push(selected);
    config={version:1,ready:true,bunVersion:Bun.version,recipeDigest:await sandboxDigest(recipe),runnerDigest:await sandboxDigest(bundle),runtimeLockDigest:selected.lockDigest,lock:selected.lock,
      environmentDigest:await computeRunnerEnvironment(bundle,selected.lockDigest,Bun.version),runtime:{packages},cgroupRoot:'/sys/fs/cgroup/aiko-compute-fixture'};
    files.set(args[4],JSON.stringify(config));return Response.json({execId:`setup-${builds}`});
   }
   if(args.includes('environment')){
    const output=args.at(-1)!;
    if(missing){
     await rm(packages,{recursive:true});
     // Execute the actual trusted preflight against genuinely missing bytes.
     await pythonComputeRunner({runtime:{packages},runtimeLockDigest:selected!.lockDigest},['environment',output]);
     files.set(output,await readFile(output,'utf8'));await rm(output);missing=false;
    }else{await selected!.check();files.set(output,JSON.stringify({environmentDigest:config.environmentDigest,runtimeLockDigest:selected!.lockDigest}));}
    return Response.json({execId:'environment'});
   }
   if(args.includes('job')){
    const index=args.indexOf('job'),job=JSON.parse(files.get(args[index+1])!) as SandboxJob;jobs.push(job);
    const receipt=await runSandboxJob(job,{owner:'123',environmentDigest:config.environmentDigest,python:selected!,journal});
    files.set(args[index+2],JSON.stringify(receipt));return Response.json({execId:`job-${jobs.length}`});
   }
   throw Error('Unexpected controlled command');
  }
  if(path.includes('/exec/'))return Response.json({state:'completed',exitCode:0});
  return Response.json({state:'running'});
 });
 const token='fixture_media_repair_token_12345678901234567890';
 const settings:AikoConfig={mode:'live',replyStyle:'direct',codeMode:true,port:4242,stateDir:dir,operatorToken:'fixture-operator',persona:PERSONA,voiceEnabled:false,botToken:'fixture:only',webhookSecret:'fixture_webhook_12345678901234567890',allowedUsers:new Set(['123']),planeCredentials:[{account:'123',digest:credentialDigest(token),scopes:['read','write']}]};
 const video=await readFile(new URL('./fixtures/video-crossing/crossing-safe.mp4',import.meta.url));
 const overrides={registrySandbox:(owner:string,kv:any)=>({placement:'local' as const,codeTransport:runCodeSegment,sandbox:new ProvisionedComputeHarness(owner,gateway,kv,bundle,recipe)}),
  telegramFetch:async(input:any,init?:any)=>{
   const url=String(input);
   if(url.endsWith('/getFile'))return Response.json({ok:true,result:{file_id:'video',file_path:'owned.mp4'}});
   if(url.includes('/file/bot'))return new Response(video,{headers:{'content-type':'video/mp4'}});
   if(url.endsWith('/sendMessage'))sends.push(JSON.parse(String(init?.body)));
   return Response.json({ok:true,result:{message_id:99,chat:{id:123}}});
  },model:Layer.succeed(Infer,{resolve:()=>({model:{provider:'fixture',model_id:'repair'}}),react:()=>Effect.succeed({kind:'complete' as const,output:'Verified sampled media is available.'})})};
 const post=()=>service!.fetch(new Request('http://localhost/api/media',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({id:'repair_input_001',text:'PRIVATE_REPAIR_CAPTION',media:{mimeType:'video/mp4',data:video.toString('base64')}})}));
 try{
  service=await createService(settings,overrides);expect((await post()).status).toBe(202);await service.host.wake('user-123');
  let rows=await service.host.read('user-123');
  expect(rows.filter(e=>e.type==='AikoMediaIngressFailed'&&e.id==='media:repair_input_001')).toHaveLength(1);
  const repair=rows.find(e=>e.type==='AikoMediaRuntimeRepairSettled'&&e.id==='media:repair_input_001');expect(repair?.status).toBe('ready');
  const child=String(repair!.operationId);expect(child).not.toBe('media:repair_input_001');
  expect(rows.find(e=>e.type==='AikoMediaIngressAccepted'&&e.id===child)?.repairedFrom).toBe('media:repair_input_001');
  expect(rows.find(e=>e.type==='AikoMediaCompleted'&&e.id===child)?.status).toBe('processed');
  expect(rows.some(e=>e.type==='AikoMediaCompleted'&&e.id==='media:repair_input_001')).toBe(false);
  expect(builds).toBe(2);expect(allocations).toBe(1);expect(jobs.length).toBeGreaterThan(0);
  expect(jobs.every(j=>j.artifact.kind==='python'&&j.artifact.runtimeLockDigest===selected!.lockDigest)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_REPAIR_CAPTION');
  const count=jobs.length,digests=rows.filter(e=>e.type==='AikoHarnessPromoted').map(e=>e.harnessDigest).sort();
  await service.close();service=await createService(settings,overrides);
  expect((await post()).status).toBe(202);await service.host.wake('user-123');expect(jobs.length).toBe(count);expect(builds).toBe(2);
  const response=await service.fetch(new Request('http://localhost/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':settings.webhookSecret!},body:JSON.stringify({update_id:901,message:{message_id:901,date:Math.floor(Date.now()/1000),from:{id:123,is_bot:false},chat:{id:123,type:'private'},video:{file_id:'video',mime_type:'video/mp4',duration:3}}})}));
  expect(response.status).toBe(200);await service.host.wake('user-123');rows=await service.host.read('user-123');
  expect(rows.find(e=>e.type==='AikoMediaCompleted'&&e.id==='telegram:901')?.status).toBe('processed');
  expect(rows.filter(e=>e.type==='AikoHarnessPromoted').map(e=>e.harnessDigest).sort()).toEqual(digests);
  expect(sends.some(s=>s.chat_id==='123'&&s.reply_parameters?.message_id===901)).toBe(true);
  expect(builds).toBe(2);expect(allocations).toBe(1);
  await service.host.seed('user-123',[{type:'AikoMediaIngressAccepted',owner:'123',id:'forged-repair',channel:'api',repairedFrom:'media:repair_input_001',contentRef:rows.find(e=>e.type==='AikoMediaIngressAccepted')!.contentRef},{type:'RepairForgerySentinel'}]);
  expect((await service.host.read('user-123')).some(e=>e.type==='RepairForgerySentinel')).toBe(false);
  expect((await service.fetch(new Request('http://localhost/api/media',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status).toBe(401);
 }finally{await service?.close();runtimes.forEach(r=>r.dispose());db.close();await rm(dir,{recursive:true,force:true});}
},180000);


test('trusted preflight records corrupt closure separately from unknown execution and emits no candidate receipt',async()=>{
 const dir=await mkdtemp('/tmp/corrupt-runtime-');let original:SandboxPythonRuntime|undefined;
 const report=`/tmp/aiko-compute-${(await sandboxDigest(crypto.randomUUID())).slice(7)}.environment.json`;
 try{
  const packages=join(dir,'packages');await mkdir(packages);await writeFile(join(packages,'fixture.py'),'VALUE = 1\n');
  original=await createPythonSandboxRuntime({packages});
  await writeFile(join(packages,'fixture.py'),'VALUE = 2\n');
  await pythonComputeRunner({runtime:{packages},runtimeLockDigest:original.lockDigest},['environment',report]);
  expect(JSON.parse(await readFile(report,'utf8'))).toEqual({ready:false,reason:'runtime-lock-mismatch',runtimeLockDigest:original.lockDigest});
 }finally{original?.dispose();await rm(report,{force:true});await rm(dir,{recursive:true,force:true});}
},30000);
