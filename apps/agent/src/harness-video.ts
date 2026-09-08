import { Validator } from "@cfworker/json-schema";
import { harnessDigest, type HarnessDigest, type HarnessJson, type HarnessContract } from "./harness-library.ts";
import type { BuiltinHarnessDefinition } from "./harness-builtins.ts";
import { mediaLifecycleBudgets } from "./harness-media.ts";

export interface VideoOracleCase {
  id: string;
  split: "development" | "held-out";
  input: HarnessJson;
  /** Authored scene truth, outside candidate source. Sparse absence is never true absence. */
  expected: { status: string; answer: string; occupancy: [boolean, boolean][]; order: string[] };
}
const object = (properties: Record<string, unknown>) => ({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const times = {type:"array",maxItems:16,items:{type:"number",minimum:0,maximum:600}};
const quality = {semanticAccuracy:"unmeasured",domain:"schematic-crossing-v1",absenceEstablished:false};

const videoOutputSchema = object({status:{enum:["interpreted","unsupported_scene","invalid_media","no_video"]},task:{const:"crossing-conflict"},answer:{enum:["observed_conflict","not_observed","unavailable"]},
    observations:{type:"array",maxItems:16,items:object({atSeconds:{type:"number",minimum:0,maximum:600},vehicleInCrossing:{type:"boolean"},pedestrianInCrossing:{type:"boolean"}})},
    conflictAtSeconds:times,firstObservedOrder:{type:"array",maxItems:2,items:{enum:["vehicle","pedestrian","simultaneous"]}},
    coverage:object({exhaustive:{const:false},sampledSeconds:times,maxUnsampledGapSeconds:{type:"number",minimum:0,maximum:600}}),quality:{const:quality}});

/** A catalog artifact, not another scheduler or provider callback. This bounded
 * visual grammar does NOT recognize natural photographic road users. */
export function mediaVideoHarnessDefinition(runtimeLockDigest: HarnessDigest, sourceCode: string, config: {
  frames: BuiltinHarnessDefinition;
  fixtures: readonly VideoOracleCase[];
}): BuiltinHarnessDefinition {
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeLockDigest) || !sourceCode.trim() || config.frames.artifact.name !== "media.frames" || config.frames.contract.applicability.runtimeLockDigest !== runtimeLockDigest) throw Error("Pinned video/frame runtime required");
  const fixtures = structuredClone(config.fixtures), frames = config.frames;
  if (!fixtures.some(f=>f.split==="development") || !fixtures.some(f=>f.split==="held-out") || fixtures.length>16 || new Set(fixtures.map(f=>f.id)).size!==fixtures.length) throw Error("Independent video oracle cases required");
  const inputSchema = object({asset:{type:"string",pattern:"^[A-Za-z0-9_.-]{1,120}$"},task:{const:"crossing-conflict"},frames:structuredClone(frames.contract.outputSchema)});
  const outputSchema = videoOutputSchema;
  const evaluatorDigest = harnessDigest(["video-crossing-oracle/v1",fixtures]);
  const verifierDigest = harnessDigest(["video-crossing-verifier/v1",check.toString(),frames.contract,frames.verifier.digest,evaluatorDigest]);
  const contract: HarnessContract = {version:1,outcome:"Interpret sampled schematic vehicle/pedestrian crossing occupancy and observed order; witness conflicts, never infer absence between frames or photographic accuracy.",
    inputSchema,outputSchema,effect:"read",verifierDigest,evaluatorDigest,timeoutMs:mediaLifecycleBudgets.invocationWallMs,
    applicability:{capability:"media.video.crossing",runtimeLockDigest,scope:"owned-private-schematic-video",media:{version:1,priority:3,accepts:["video/"],requires:{capability:"media.probe",field:"hasVideo",equals:true},inputs:{asset:{source:"asset"},task:{source:"literal",value:"crossing-conflict"},frames:{source:"output",capability:"media.frames"}}}}};
  const contractDigest = harnessDigest(contract);
  const artifact: BuiltinHarnessDefinition["artifact"] = {version:1,name:"media.video.crossing",description:contract.outcome,runtime:"python",entrypoint:"video.py",files:{"video.py":sourceCode},dependencies:[],contractDigest,
    sources:[{uri:"unlock:media/media-video.py",revision:harnessDigest(sourceCode),digest:harnessDigest(sourceCode),license:"NOASSERTION"}]};
  const seedDigest = harnessDigest(artifact);
  return {artifact,contract,verifier:{digest:verifierDigest,evaluatorDigest,cases:fixtures.map(({id,split,input})=>({id,split,input})),
    async verify({contract:supplied,artifactDigest,input,output,caseId},signal) {
      let passed=false;
      try {
        signal.throwIfAborted();
        if(harnessDigest(supplied)!==contractDigest || !new Validator(inputSchema as any).validate(input).valid || !new Validator(outputSchema as any).validate(output).valid) throw Error("Video schema or contract mismatch");
        const value=input as any, result=output as any;
        const frameTimes=value.frames.frames?.map((f:any)=>f.requestedSeconds) ?? [];
        const physical=await frames.verifier.verify({contract:frames.contract,artifactDigest:harnessDigest(frames.artifact),input:{asset:value.asset,timestamps:frameTimes.length?frameTimes:[0]},output:value.frames},signal);
        if(!physical.passed || !check(value.frames,result)) throw Error("Source evidence or semantic consistency failed");
        if(caseId) {
          const oracle=fixtures.find(f=>f.id===caseId && harnessDigest(f.input)===harnessDigest(input))?.expected;
          passed=!!oracle && oracle.status===result.status && oracle.answer===result.answer && harnessDigest(oracle.occupancy)===harnessDigest(result.observations.map((o:any)=>[o.vehicleInCrossing,o.pedestrianInCrossing])) && harnessDigest(oracle.order)===harnessDigest(result.firstObservedOrder);
        } else passed=artifactDigest===seedDigest;
        signal.throwIfAborted();
      } catch { /* Never include private pixels/answers in witnesses. */ }
      return {passed,quality:caseId?(passed?1:0):null,evidence:[`trusted-video-crossing:${passed?"satisfied":"violated"}`,caseId?"fixed-scene-oracle":"semantic-accuracy-unmeasured","sampled-coverage-only"]};
    }}};
}
function check(frames:any, result:any):boolean {
  if(harnessDigest(result.quality)!==harnessDigest(quality)) return false;
  const observations=result.observations;
  if(result.status!=="interpreted") return result.answer==="unavailable" && observations.length===0 && result.conflictAtSeconds.length===0 && result.firstObservedOrder.length===0 && result.coverage.sampledSeconds.length===0 && result.coverage.maxUnsampledGapSeconds===(frames.durationSeconds??0) && (frames.status==="ok"?result.status==="unsupported_scene":result.status===frames.status);
  if(frames.status!=="ok" || observations.length!==frames.frames.length) return false;
  const times:number[]=frames.frames.map((f:any)=>f.atSeconds);
  if(times.some((t,i)=>!Number.isFinite(t)||t<0||t>=frames.durationSeconds||(i>0&&t<=times[i-1]!)) || observations.some((o:any,i:number)=>o.atSeconds!==times[i])) return false;
  const conflicts=observations.filter((o:any)=>o.vehicleInCrossing&&o.pedestrianInCrossing).map((o:any)=>o.atSeconds);
  const order:string[]=[],seen=new Set<string>();
  for(const o of observations) { const newly=["vehicle","pedestrian"].filter(n=>o[`${n}InCrossing`]&&!seen.has(n)); if(newly.length)order.push(newly.length===2?"simultaneous":newly[0]!);newly.forEach(n=>seen.add(n)); }
  const gaps=times.map((t,i)=>t-(i?times[i-1]!:0));gaps.push(frames.durationSeconds-times.at(-1)!);
  return result.answer===(conflicts.length?"observed_conflict":"not_observed") && harnessDigest(conflicts)===harnessDigest(result.conflictAtSeconds) && harnessDigest(order)===harnessDigest(result.firstObservedOrder) && harnessDigest(times)===harnessDigest(result.coverage.sampledSeconds) && Math.abs(Math.max(...gaps)-result.coverage.maxUnsampledGapSeconds)<1e-6;
}

/** Only call with scope-authorized retained, satisfied stage outputs. The host
 * uses this deterministic final renderer instead of asking inference to invent
 * photographic meaning from base64. No pixels or attachment instructions enter
 * the reply; sparse misses explicitly remain unknown. */
export function renderVerifiedVideoFinding(output: unknown, frames: unknown): string {
  const unavailable = "Video interpretation unknown: this runtime supports only schematic crossing diagrams. No verified semantic finding is available; unsampled events remain unknown.";
  try {
    if (!output || !frames || !new Validator(videoOutputSchema as any).validate(output).valid || !check(frames, output)) return unavailable;
    const value = output as any;
    if (value.status !== "interpreted") return unavailable;
    const seconds = (n: number) => `${Number(n.toFixed(3))}s`;
    const findings = value.observations.map((o: any) => `${seconds(o.atSeconds)}: vehicle ${o.vehicleInCrossing ? "inside" : "outside"} crossing; pedestrian ${o.pedestrianInCrossing ? "inside" : "outside"} crossing.`);
    const conflict = value.conflictAtSeconds.length
      ? `Observed shared crossing occupancy at ${value.conflictAtSeconds.map(seconds).join(", ")}.`
      : "No shared crossing occupancy observed in sampled frames; whether it occurred between frames is unknown.";
    const order = value.firstObservedOrder.length ? `First observed entry order: ${value.firstObservedOrder.join(" then ")}.` : "No entry observed in sampled frames.";
    return ["Verified schematic crossing samples (not general photographic interpretation):", ...findings, conflict, order,
      `Largest unsampled gap: ${seconds(value.coverage.maxUnsampledGapSeconds)}. Coverage is not exhaustive; missed brief events remain unknown. General semantic accuracy is unmeasured.`].join("\n");
  } catch { return unavailable; }
}
