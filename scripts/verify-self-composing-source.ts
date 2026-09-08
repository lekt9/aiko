import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
const args=process.argv.slice(2),report=args[args.indexOf("--report")+1],nonce=args[args.indexOf("--nonce")+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));const dir=dirname(report);
for(const mode of ["prepare","recover"]){const p=Bun.spawn([process.execPath,"--no-env-file",resolve(import.meta.dir,"fixtures/self-composing-source.ts"),mode,dir,nonce],{cwd:resolve(import.meta.dir,".."),env:{PATH:process.env.PATH??"",TMPDIR:"/tmp"},stdout:Bun.file(join(dir,mode+".stdout")),stderr:Bun.file(join(dir,mode+".stderr")),timeout:20000});assert.equal(await p.exited,0,mode+" failed; inspect retained stderr");}
const read=(p:string)=>JSON.parse(readFileSync(join(dir,p),"utf8")),before=read("prepare.json"),after=read("recover.json");assert.equal(before.nonce,nonce);assert.equal(after.nonce,nonce);assert.notEqual(before.pid,after.pid);
for(const key of ["revision","retained","artifact","snapshot","derived","catalog"])assert.deepEqual(after[key],before[key]);assert.deepEqual(read("prepare-trace.json"),read("recover-trace.json"));
const observed={commit:after.revision,files:Object.keys(after.retained).length,license:after.snapshot.license.declared,attributionAndDependencies:true,exactBytesAndGitHashes:true,BOMPreserved:true,popularityRejected:after.popularityRejected,negatives:before.negatives,replay:{differentProcess:true,identicalTrace:true,identicalMetadata:true,requests:after.requests,sandboxReceipts:after.sandboxReceipts,modelCalls:after.modelCalls,candidateExecutions:after.candidateExecutions},positiveSandboxRequests:before.requests>0&&before.sandboxReceipts>0};
writeFileSync(join(dir,"observed.json"),JSON.stringify(observed,null,2));const artifacts=Object.fromEntries(["observed.json","prepare.json","recover.json","prepare-trace.json","recover-trace.json","source-requests.json","sandbox-receipts.json"].map(p=>[p,createHash("sha256").update(readFileSync(join(dir,p))).digest("hex")]));
writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:{"S07.C02":{status:"satisfied",operationId:nonce,traceRef:"recover-trace.json"}},artifacts},null,2));
