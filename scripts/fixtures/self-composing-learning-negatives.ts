/** Fault inputs to the existing production S21 journey, never successful receipts.
 * Host page loss and a real mid-scan write are bounded process-local seams.
 */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openMemory} from '../../apps/agent/src/memory.ts';
import {memorySnapshot} from '../../apps/agent/src/learning.ts';
import {accountDirectory} from '../../apps/agent/src/accounts.ts';

export async function learningNegatives({service,dir,nonce,counts,deliveries,Memory}:any){
 const host=service.host,thread='background-123-indexer',binding={stateDir:accountDirectory(dir,'123'),owner:'123'};
 const start=await host.read('user-123'),decision=start.find((e:any)=>e.type==='AikoProactiveDecision'&&e.outcome?.operationId==='verified-task');assert(decision);
 const physicalBefore=JSON.stringify({counts,deliveries}),faults:any[]=[];
 const readPage=host.readPage.bind(host);
 for(const kind of ['gap','unavailable']){
  let reads=0;
  host.readPage=async(t:string,a:number,n:number)=>{
   const rows=await readPage(t,a,n);
   if(t===thread){reads++;if(kind==='unavailable')throw Error('Independent source storage unavailable');return rows.filter((_:any,i:number)=>i!==0);}
   return rows;
  };
  const id='independent-negative-'+kind;
  try{
   await host.commitRoot(host.self(thread),{type:'AikoIndexRequested',id,cause:id,owner:'123',at:Date.now(),notification:{decision:'silent',reason:'Independent negative source'}});
   await host.wake(thread);await host.drive();
  }finally{host.readPage=readPage;}
  const rows=await host.read(thread),failed=rows.find((e:any)=>e.type==='AikoBackgroundFailed'&&e.id===id);
  assert(failed,'Native failure required for '+kind);assert.equal(failed.errorCode,kind==='gap'?'source_sequence_gap':'source_read_unavailable');
  assert(reads>0&&reads<=3,'Source fault must settle finitely');
  assert(!rows.some((e:any)=>['AikoKnowledgeChanged','AikoKnowledgeUnchanged','AikoLearningIndexed'].includes(e.type)&&e.id===id));
  const scans=rows.filter((e:any)=>e.type==='AikoLearningSourceScanned'&&e.status==='unavailable');assert(scans.some((e:any)=>e.through===e.after));
  faults.push({kind,reads,failure:failed});
 }
 // Mutate the real journal during an actual semantic snapshot read. No fake
 // version, partial-page success, complete flag or Merkle root is supplied.
 let writes=0;const get=Memory.prototype.get;
 Memory.prototype.get=function(...args:any[]){
  const hit=get.apply(this,args);
  if(!writes&&this.scope==='aiko:123'&&new Error().stack?.includes('memorySnapshot')){
   writes++;
   this.remember({subject:'independent/mid-snapshot',title:'Concurrent fixture observation',type:'fact',payload:'MID_SCAN_FIXTURE'},
    {key:'independent-mid-snapshot',producer:{kind:'agent',reference:'independent-fixture'}});
  }
  return hit;
 };
 const incompleteId='independent-incomplete-snapshot';
 try{
  await host.commitRoot(host.self(thread),{type:'AikoIndexRequested',id:incompleteId,cause:incompleteId,owner:'123',at:Date.now(),notification:{decision:'silent',reason:'Independent incomplete scan'}});
  await host.wake(thread);await host.drive();
 }finally{Memory.prototype.get=get;}
 assert.equal(writes,1,'Actual concurrent journal commit required');
 const incompleteRows=await host.read(thread),incomplete=incompleteRows.find((e:any)=>e.type==='AikoBackgroundFailed'&&e.id===incompleteId);
 assert.equal(incomplete?.errorCode,'snapshot_capacity_exceeded');
 assert(!incompleteRows.some((e:any)=>['AikoKnowledgeChanged','AikoKnowledgeUnchanged'].includes(e.type)&&e.id===incompleteId));
 faults.push({kind:'incomplete',writes,failure:incomplete});
 // A distinct later native job can recover; failed causes are not retried.
 const fresh='independent-after-faults';
 await host.commitRoot(host.self(thread),{type:'AikoIndexRequested',id:fresh,cause:fresh,owner:'123',at:Date.now(),notification:{decision:'silent',reason:'Independent recovered source'}});
 await host.wake(thread);await host.drive();
 const rows=await host.read(thread),transition=rows.find((e:any)=>e.type==='AikoKnowledgeChanged'&&e.id===fresh);
 assert(transition?.complete);assert.equal(transition.root,memorySnapshot(binding).root);assert.equal(transition.scopeVersion,transition.endScopeVersion);
 for(const owner of ['123','456']){
  const response=await service.fetch(new Request('http://localhost/v1/memory/observations/'+decision.supports[0],{headers:{authorization:'Bearer independent-reader-'+owner+'-00112233445566'}}));
  assert.equal(response.status,owner==='123'?200:404);
  const body=await response.json();if(owner==='123')assert.equal(body.observation.id,decision.supports[0]);else assert.deepEqual(body,{error:'not_found'});
 }
 const foreign={...decision,id:'independent-foreign-notification',owner:'456',sourceThread:'background-456-reflection',outcome:undefined};
 await host.commitRoot(host.self('user-456'),foreign);await host.wake('user-456');await host.drive();
 const foreignRows=await host.read('user-456');
 assert(foreignRows.some((e:any)=>e.type==='AikoProactiveSuppressed'&&e.id===foreign.id&&e.reason==='Evidence is no longer current or decision is invalid'));
 assert(!foreignRows.some((e:any)=>e.type==='AikoProactiveAccepted'||e.type==='AikoDeliveryStarted'&&String(e.turn).startsWith('proactive:')));
 const memory=openMemory(binding);
 try{
  const hit=memory.get(decision.supports[0]);assert(hit?.observation.producer.sourceId);
  const source=memory.sources().find(s=>s.id===hit.observation.producer.sourceId);assert(source);
  memory.approveSource(source.id,source.revision,false,'independent-citation-revocation');
 }finally{memory.close();}
 const unavailable={...decision,id:'independent-unavailable-citation'};
 await host.commitRoot(host.self('user-123'),unavailable);await host.wake('user-123');await host.drive();
 assert((await host.read('user-123')).some((e:any)=>e.type==='AikoProactiveSuppressed'&&e.id===unavailable.id&&e.reason==='Evidence is no longer current or decision is invalid'));
 assert.equal(JSON.stringify({counts,deliveries}),physicalBefore,'Negative causes must never infer/execute/send');
 const traces=Object.fromEntries(await Promise.all(['user-123','user-456',thread,'background-123-reflection'].map(async t=>[t,await host.read(t)])));
 const result={nonce,faults,transition,crossOwnerObservationDenied:true,crossOwnerNotificationDenied:true,unavailableCitationSuppressed:true,counts:{...counts},deliveries:deliveries.length,traces};
 writeFileSync(join(dir,'negatives.json'),JSON.stringify(result,null,2));return result;
}
