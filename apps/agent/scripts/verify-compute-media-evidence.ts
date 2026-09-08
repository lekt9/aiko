/** Read-only verification of retained physical canary jobs. No gateway access. */
import { createHash } from "node:crypto";
import { mediaHarnessDefinitions, mediaWordErrorRate } from "../src/harness-media.ts";
import { harnessDigest } from "../src/harness-library.ts";
import { sandboxDigest, sandboxArtifactDependencies, sandboxCanonical, verifySandboxReceipt, type SandboxJob } from "../src/sandbox-job.ts";
import { createMultilingualFixtures } from "../test/fixtures/media-multilingual-fixtures.ts";
import english from "../assets/media-model.lock.json";
import multilingual from "../assets/media-multilingual-model.lock.json";
const directory=process.argv[2];
if(!directory)throw Error("Pass the retained physical-media evidence directory");
const read=(name:string)=>Bun.file(`${directory}/${name}`).json();
const setup=await read("setup-report.json"),config=await read("qualified-config.json"),summary=await read("summary.json");
if(!setup.ready||setup.runtimeLockDigest!==await sandboxDigest(setup.lock)||config.runtimeLockDigest!==setup.runtimeLockDigest||!setup.capture||setup.capture.retainedBytes>=setup.capture.sourceBytes)throw Error("Runtime capture attestation mismatch");
if(summary.cleanup!=="deleted-confirmed-404"||summary.canaryId===summary.existingVmPreserved||summary.cloakBinaryVersion!=="Chromium 146.0.7680.177")throw Error("Canary lifecycle or browser witness mismatch");
if(config.runnerBundle!==await Bun.file(`${directory}/qualified-runner.txt`).text()||summary.runnerSha256!==createHash("sha256").update(config.runnerBundle).digest("hex"))throw Error("Execution bundle changed");
const inventory=await read("final-inventory.json");
for(const [name,pin] of [["whisper-tiny.en",english.model],["whisper-tiny",multilingual.model]] as const) for(const [file,expected] of Object.entries(pin.files)) {
 const actual=inventory.models[`${name}/${file}`];
 if(actual?.sha256!==expected.sha256||actual?.bytes!==expected.bytes)throw Error("Physical model pin mismatch");
}
if(inventory.wheelArchivesRetained||inventory.embeddingPackagesPresent||!/^oom_kill 0$/m.test(inventory.memory["memory.events"]))throw Error("Physical footprint or parent OOM witness failed");
const fixture=await createMultilingualFixtures();
try {
 for(const id of ["frames-colors","6930-75918-0000","cof_00610_00008989777","silence-es","malformed-es"]){
  const sample=fixture.fixtures.find(f=>f.id===id)!;
  const job=await read(`qualified-job-${id}.json`) as SandboxJob,result=await read(`qualified-result-${id}.json`);
  const spanish=(sample.input as any).language==="es";
  const definitions=mediaHarnessDefinitions(setup.runtimeLockDigest,await Bun.file(new URL("../assets/media-harness.py",import.meta.url)).text(),{modelPath:spanish?"/models/whisper-tiny":"/models/whisper-tiny.en",modelRevision:(spanish?multilingual:english).model.revision,languages:spanish?["en","es"]:["en"],fixtures:fixture.fixtures,decodeFrame:fixture.decodeFrame,reference:async(cap,input)=>fixture.fixtures.find(f=>f.capability===cap&&harnessDigest(f.input)===harnessDigest(input))?.expected});
  const definition=definitions.find(d=>d.artifact.name===sample.capability)!;
  const modules=Object.fromEntries(await Promise.all(Object.entries(definition.artifact.files).map(async([name,source])=>[name,{source,digest:await sandboxDigest(source)}])));
  const expectedArtifact={kind:"python",entry:definition.artifact.entrypoint,modules,runtimeLockDigest:setup.runtimeLockDigest};
  if(sandboxCanonical(job.artifact)!==sandboxCanonical(expectedArtifact)||sandboxCanonical(job.dependencyLock)!==sandboxCanonical(sandboxArtifactDependencies(job.artifact))||job.owner!==summary.owner||job.environmentDigest!==config.environmentDigest||sandboxCanonical(job.input)!==sandboxCanonical(sample.input)||job.authority.origins.length||job.authority.methods.length||job.budget.requests!==0)throw Error(`Job pin/scope mismatch: ${id}`);
  const bytes=await fixture.bytes((sample.input as any).asset),asset=job.assets?.[(sample.input as any).asset];
  if(!asset||asset.data!==bytes.toString("base64")||asset.bytes!==bytes.length||asset.digest!==await sandboxDigest(asset.data))throw Error(`Fixture bytes mismatch: ${id}`);
  const receipt=await verifySandboxReceipt(job,result.receipt);
  if(receipt.status!=="completed"||!receipt.resources?.cleaned||receipt.resources.oomKills||receipt.resources.processLimitHits||!result.replayEqual||result.replayGatewayCalls!==0)throw Error(`Physical/restart receipt failed: ${id}`);
  const checked=await definition.verifier.verify({contract:definition.contract,artifactDigest:harnessDigest(definition.artifact),input:job.input,output:receipt.output as any,caseId:id},AbortSignal.timeout(60000));
  if(!checked.passed)throw Error(`Independent outcome failed: ${id}`);
  console.log(JSON.stringify({id,passed:true,wer:sample.expected.transcript===undefined?undefined:mediaWordErrorRate(sample.expected.transcript,(receipt.output as any).text??""),peakBytes:receipt.resources.memoryPeakBytes}));
 }
}finally{await fixture.close();}
