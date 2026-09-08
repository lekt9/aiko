/** Independent adversarial cases. Deliberately non-green while any required
 * continuation/custody assertion fails; these are not whole-requirement claims. */
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const dir=process.argv[2];assert(dir);mkdirSync(dir,{recursive:true});
const nonce=crypto.randomUUID(), scenarios=['resume','missing-before-claim','missing-after-handoff','unknown','late','cancel','missing-output'];
const graph=await Bun.build({entrypoints:[import.meta.path,resolve(import.meta.dir,'fixtures/self-composing-channels.ts')],target:'bun',metafile:true});assert(graph.success&&graph.metafile);
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const pins=Object.fromEntries(Object.keys(graph.metafile.inputs).sort().map(path=>[path,hash(path)]));
writeFileSync(join(dir,'source-observations.json'),JSON.stringify(pins,null,2));
const results=[];
for(const scenario of scenarios){
 const folder=join(dir,scenario);mkdirSync(folder,{recursive:true});
 let exit=0;
 for(const mode of ['prepare','recover']){
  const p=Bun.spawn([process.execPath,'--no-env-file',resolve(import.meta.dir,'fixtures/self-composing-channels.ts'),mode,folder,nonce+'-'+scenario,scenario],{cwd:resolve(import.meta.dir,'..'),env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:Bun.file(join(folder,mode+'.stdout')),stderr:Bun.file(join(folder,mode+'.stderr')),timeout:20000});
  exit=await p.exited;if(exit!==0)break;
 }
 let evidence:any;try{evidence=JSON.parse(readFileSync(join(folder,'boundary-result.json'),'utf8'));}catch{}
 const traces:any={};for(const name of ['boundary.json','boundary-recover-trace.json']){try{traces[name]=createHash('sha256').update(readFileSync(join(folder,name))).digest('hex');}catch{}}
 results.push({scenario,exit,evidence,traces});
}
const sourceChanges=Object.entries(pins).filter(([path,digest])=>hash(path)!==digest).map(([path])=>path);
const failures=results.filter(r=>r.exit!==0||r.evidence?.gap);
writeFileSync(join(dir,'report.json'),JSON.stringify({nonce,sourceChanges,wholeRequirementsAccepted:[],results,failures:failures.map(r=>r.scenario)},null,2));
console.log(JSON.stringify({report:join(dir,'report.json'),cases:results.length,failures:failures.map(r=>r.scenario),wholeRequirementsAccepted:[]}));
process.exitCode=failures.length||sourceChanges.length?1:0;
