/** Unregistered whole-C04 verifier. Keep violated retention claims red. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=await mkdtemp('/tmp/learning-lifecycle-proof-'),nonce=crypto.randomUUID();console.log(root);
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const graph=async()=>{
 const build=await Bun.build({entrypoints:[import.meta.path,resolve('scripts/fixtures/self-composing-learning-provenance.ts')],target:'bun',metafile:true});
 assert(build.success&&build.metafile,'Native verifier graph must resolve');
 const paths=[...new Set([...Object.keys(build.metafile.inputs),'pnpm-lock.yaml','patches/tardie@0.22.0.patch'])].sort();
 return Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(resolve(p))).digest('hex')])));
};
const before=await graph();await writeFile(join(root,'source-before.json'),JSON.stringify(before,null,2));
const run=async(dir:string,mode:string)=>{
 const child=Bun.spawn([process.execPath,'--no-env-file',resolve('scripts/fixtures/self-composing-learning-provenance.ts'),dir,nonce,mode],{env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:'pipe',stderr:'pipe'});
 const timeout=setTimeout(()=>child.kill(),60000);
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timeout);
 await writeFile(join(dir,mode+'-'+Date.now()+'.log'),out+err);return {exit,error:err.slice(-3000)};
};
const result:any={nonce,root,sourceRoot:process.cwd(),runtimeSha256:createHash('sha256').update(await readFile(process.execPath)).digest('hex'),registered:false,wholeC04:false,wholeS21:false,cases:[],errors:[]};
for(const kind of ['correction','deletion','revocation','supersession']){
 const dir=join(root,kind);await mkdir(dir,{mode:0o700});
 try{
  const prefix=kind==='supersession'?'c04-artifact':'c04-source';
  const cut=await run(dir,prefix+'-cut');assert.equal(cut.exit,74,cut.error);
  const mutation=await run(dir,prefix+'-'+kind);
  const observed=await json(join(dir,'c04-observed.json'));assert.equal(observed.nonce,nonce);assert.equal(observed.staleDispatches,0);
  const physical=await json(join(dir,'physical.json'));
  for(let pass=0;pass<2;pass++){
   const recovery=await run(dir,'recover');assert.equal(recovery.exit,0,recovery.error);
   assert.deepEqual(await json(join(dir,'physical.json')),physical,'Recovery cannot repeat mutations or delivery');
   const recovered=await json(join(dir,'recovered.json'));assert.deepEqual(recovered.snapshots.at(-1).nativeRows,observed.nativeRows,'Retained native sequences and history must remain exact');
   if(kind==='deletion'){
    assert(!JSON.stringify(recovered.snapshots.at(-1).memoryRows).includes('SYNTHETIC_DELETE_ME_'+nonce),'Recovery must not re-ingest the erased observation');
    assert(!JSON.stringify(recovered.snapshots.at(-1).memoryHistory).includes('SYNTHETIC_DELETE_ME_'+nonce),'Recovery must not rehydrate erased memory history');
   }
  }
  result.cases.push({kind,directory:dir,mutationExit:mutation.exit,staleDispatches:0,retainedPayloadLocations:observed.retainedPayloadLocations,processReplays:2,counts:observed.counts,passed:mutation.exit===0});
  assert.equal(mutation.exit,0,mutation.error);
 }catch(error){result.errors.push({kind,directory:dir,error:String(error)});}
}
const after=await graph();await writeFile(join(root,'source-after.json'),JSON.stringify(after,null,2));
result.sourceInputs=Object.keys(before).length;result.sourceDrift=Object.keys({...before,...after}).filter(p=>before[p]!==after[p]);
if(result.sourceDrift.length)result.errors.push({error:'Source changed during proof'});
result.wholeC04=result.errors.length===0&&result.cases.length===4&&result.cases.every((c:any)=>c.passed);
await writeFile(join(root,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(!result.wholeC04)process.exitCode=1;
