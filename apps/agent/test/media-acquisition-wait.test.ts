import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {openMediaWaitHost} from './fixtures/media-wait-host.ts';
import {retainMediaAsset,mediaProcessingNextWake} from '../src/media-processing.ts';
const timeout=()=>AbortSignal.timeout(15000);
async function child(dir:string,id:string,mode=""){const p=Bun.spawn(['bun',new URL('./fixtures/media-wait-host.ts',import.meta.url).pathname,dir,id,mode],{stdout:'pipe',stderr:'pipe',env:{...process.env,TMPDIR:'/tmp'}});const error=await new Response(p.stderr).text();expect(await p.exited,error).toBe(0);}
for(const outcome of ['complete','race','cancel','expire','unknown'] as const)test(`native cross-process media acquisition follower: ${outcome}`,async()=>{
 const dir=await mkdtemp('/tmp/media-wait-');let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const f=await openMediaWaitHost(dir,'leader',async()=>{entered();await blocked;},outcome==='unknown');
 try{
  const contentRef=await retainMediaAsset(f.library.blobs,'123',new Uint8Array([1,2,3]));
  const followerContentRef=await retainMediaAsset(f.library.blobs,'123',new Uint8Array([4,5,6]));
  const admission=(id:string)=>({owner:'123',channel:id==='leader'?'api':'telegram',operationId:id,contentRef:id==='leader'?contentRef:followerContentRef,mimeType:'video/mp4',deadline:Date.now()+(outcome==='expire'&&id==='follower'?4000:12000)});
  const leader=admission('leader'),follower=admission('follower');
  await f.media.admit(leader,timeout());await f.media.admit(follower,timeout());
  const run=f.host.wake('user-123');await started;
  if(outcome==='race'){
    const p=Bun.spawn(['bun',new URL('./fixtures/media-wait-host.ts',import.meta.url).pathname,dir,'follower','race'],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,TMPDIR:'/tmp'}});
    const reader=p.stdout.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain('WAITING');
    release();await run;p.stdin.write('continue');p.stdin.end();expect(await p.exited,await new Response(p.stderr).text()).toBe(0);
  }else await child(dir,'follower','forge');
  let rows=await f.rows();expect(rows.filter(e=>e.type==='AikoMediaAcquisitionWaiting'&&e.id==='follower')).toHaveLength(1);
  if(outcome!=='race'){
  expect((await f.media.status(follower,timeout())).status).toBe('pending');
  expect(mediaProcessingNextWake(rows,'123')).toBe(follower.deadline);expect(await f.alarm()).toBe(follower.deadline);
  expect((await f.rows()).some(e=>e.type==='WaitFenceSentinel')).toBe(false);
  const count=f.counts().length;
  await child(dir,'follower');expect(f.counts()).toHaveLength(count);
  // Unrelated settlements cannot wake or dispatch the exact waiting acquisition.
  await f.host.seed('user-123',[{type:'AikoHarnessEvaluated',owner:'999',id:'foreign',eligible:true}]);
  await child(dir,'follower');expect(f.counts()).toHaveLength(count);
  }
  if(outcome==='cancel')await f.media.cancel(follower,timeout());
  if(outcome==='expire')await new Promise(r=>setTimeout(r,Math.max(0,follower.deadline-Date.now()+10)));
  release();await run;
  await child(dir,'follower');rows=await f.rows();
  const status=await f.media.status(follower,timeout());
  expect(status.status).toBe((outcome==='complete'||outcome==='race')?'processed':outcome==='cancel'?'cancelled':outcome==='expire'?'unavailable':'unknown');
  expect(rows.filter(e=>e.type==='AikoHarnessEvaluationStarted')).toHaveLength(1);
  const executions=f.counts().filter(c=>c.kind==='execute');expect(new Set(executions.map(c=>c.id)).size).toBe(executions.length);
  expect(executions.length).toBe((outcome==='complete'||outcome==='race')?4:outcome==='unknown'?2:3);
  expect(rows.filter(e=>e.type==='MessageReceived'&&e.mediaOperationId==='follower')).toHaveLength(outcome==='cancel'?0:1);
  const finished=f.counts().length;
  await child(dir,'follower');expect(f.counts()).toHaveLength(finished);
  if(outcome==='complete'||outcome==='race'){
    const a=await f.media.readResult(leader,timeout()),b=await f.media.readResult(follower,timeout());
    expect(a!.stages[0]!.operationId).not.toBe(b!.stages[0]!.operationId);
    expect((await f.media.readOutput(leader,a!.stages[0]!.operationId!,timeout())).output).toEqual({asset:`media-${contentRef.slice(7)}`});
    expect((await f.media.readOutput(follower,b!.stages[0]!.operationId!,timeout())).output).toEqual({asset:`media-${followerContentRef.slice(7)}`});
    expect(f.counts().filter(c=>c.kind==='send')).toHaveLength(2);expect(rows.filter(e=>e.type==='AikoDeliverySettled').map(e=>e.turn).sort()).toEqual(['follower','leader']);expect(rows.filter(e=>e.type==='AikoHarnessPromoted')).toHaveLength(1);}
 }finally{release();await f.close();await rm(dir,{recursive:true,force:true});}
},20000);
