import { Validator } from "@cfworker/json-schema";
import { resolveObservedRead, type ObservedNetworkBinding, type ObservedReadRevision } from "./observed-network.ts";
import { observedRequestEvidenceAvailable } from "./harness-revisions.ts";
import { harnessDigest, type HarnessArtifact, type HarnessContract, type HarnessContext, type HarnessJson, type HarnessLibraryBinding, type HarnessVerifier } from "./harness-library.ts";

/** Explicit host capability. Definitions/checkers and grants never come from captures. */
export interface ObservedNetworkHarnessOptions {
  binding: ObservedNetworkBinding;
  definitions: readonly { contract: HarnessContract; verifier: HarnessVerifier }[];
  current(): { active: boolean; revision: string };
  authorize(artifact: HarnessArtifact, input: HarnessJson, purpose: "run" | "evaluation", signal: AbortSignal): Promise<boolean>;
  send?: ObservedReadRevision["send"];
}
const slot = "observedNetworkRead";
const sourceDigest = (contract: HarnessContract): string | undefined => {
  const value = contract.applicability.observedRequest;
  return value && typeof value === "object" && !Array.isArray(value) && value.version === 1 && value.effect === "read" && typeof value.toolDigest === "string" ? value.toolDigest : undefined;
};
/** Wrap the native library, keeping its journal, blob custody and operation claims.
 * No replay reconciliation exists for these reads: an interrupted run stays unknown. */
export function observedNetworkHarnessBinding(base: HarnessLibraryBinding, options: ObservedNetworkHarnessOptions): HarnessLibraryBinding {
  if (options.binding.owner !== base.owner || options.binding.thread !== base.thread || base.thread !== `user-${base.owner}` || !options.binding.readEvents) throw Error("Observed harness owner binding mismatch");
  const definitions = [...options.definitions];
  for (const {contract,verifier} of definitions) if (contract.effect !== "read" || !sourceDigest(contract) || contract.verifierDigest !== verifier.digest || contract.evaluatorDigest !== verifier.evaluatorDigest) throw Error("Independent observed read contract required");
  const verifiers = new Map(base.verifiers);
  for (const definition of definitions) {
    if (verifiers.has(definition.verifier.digest) && verifiers.get(definition.verifier.digest) !== definition.verifier) throw Error("Observed verifier identity conflict");
    verifiers.set(definition.verifier.digest, definition.verifier);
  }
  const unwrapped = (context: HarnessContext) => { const bindings = {...context.bindings}; delete bindings[slot]; return {...context,bindings}; };
  const current = async (signal: AbortSignal) => {
    const policy = structuredClone(options.current());
    const sources: Record<string,string> = {};
    if (policy.active) for (const digest of new Set(definitions.map(d => sourceDigest(d.contract)!))) {
      try { sources[digest] = (await resolveObservedRead(options.binding,digest,signal)).generation; }
      catch { signal.throwIfAborted(); sources[digest] = "unavailable"; }
    }
    if (harnessDigest(policy) !== harnessDigest(options.current())) throw Error("Observed read policy changed");
    return { policy, sources };
  };
  const context = async (signal: AbortSignal): Promise<HarnessContext> => {
    const original = await base.context(signal);
    if (slot in original.bindings) throw Error("Reserved observed read context slot");
    return {...original,bindings:{...original.bindings,[slot]:await current(signal)}};
  };
  const admit = async (artifact: HarnessArtifact, contract: HarnessContract, ctx: HarnessContext, input: HarnessJson, signal: AbortSignal, caseId?: string) => {
    signal.throwIfAborted();
    const trusted = definitions.find(d => harnessDigest(d.contract) === harnessDigest(contract));
    const digest = sourceDigest(contract), state = await current(signal);
    const purpose = caseId === undefined ? "run" : "evaluation";
    const caseMatches = (fresh: HarnessJson) => caseId === undefined || !!trusted?.verifier.cases.some(fixture => fixture.id === caseId && harnessDigest(fixture.input) === harnessDigest(fresh));
    if (harnessDigest(unwrapped(ctx)) !== harnessDigest(await base.context(signal)) || !caseMatches(input) || !state.policy.active || !trusted || !digest || state.sources[digest] === "unavailable" || harnessDigest(ctx.bindings[slot]) !== harnessDigest(state) || artifact.runtime !== "network" || contract.effect !== "read" || artifact.contractDigest !== harnessDigest(contract) || artifact.dependencies.length || Object.keys(artifact.files).length !== 1 ||
      !artifact.sources.some(source => source.uri === `aiko-request:${digest}` && source.digest === digest) ||
      !observedRequestEvidenceAvailable(artifact, await options.binding.readEvents!()) || !new Validator(contract.inputSchema).validate(input).valid ||
      !await options.authorize(structuredClone(artifact),structuredClone(input),purpose,signal)) throw Error("Current observed read authority unavailable");
    const parsed = JSON.parse(artifact.files[artifact.entrypoint]!);
    const resolved = await resolveObservedRead(options.binding,digest,signal,{
      graph:parsed.graph,actionId:parsed.actionId,send:options.send,
      authorize:async (fresh,s) => {
        const now = await current(s);
        return harnessDigest(unwrapped(ctx)) === harnessDigest(await base.context(s)) && harnessDigest(now) === harnessDigest(state) && observedRequestEvidenceAvailable(artifact,await options.binding.readEvents!()) &&
          caseMatches(JSON.parse(JSON.stringify(fresh)) as HarnessJson) && new Validator(contract.inputSchema).validate(fresh).valid && await options.authorize(structuredClone(artifact),JSON.parse(JSON.stringify(fresh)) as HarnessJson,purpose,s);
      },
    });
    return resolved;
  };
  return {...base,verifiers,context,
    authorize: async (a,c,x,i,s) => a.runtime !== "network" ? base.authorize(a,c,unwrapped(x),i,s) : admit(a,c,x,i,s).then(()=>true,()=>false),
    authorizeEvaluation: async (a,c,x,fixture,s) => {
      if(a.runtime !== "network") return base.authorizeEvaluation ? base.authorizeEvaluation(a,c,unwrapped(x),fixture,s) : c.effect === "read";
      const definition=definitions.find(d=>harnessDigest(d.contract)===harnessDigest(c));
      if(!definition?.verifier.cases.some(value=>harnessDigest(value)===harnessDigest(fixture)) || !await options.authorize(structuredClone(a),structuredClone(fixture.input),"evaluation",s)) return false;
      return admit(a,c,x,fixture.input,s,fixture.id).then(()=>true,()=>false);
    },
    execute: async (job,signal) => {
      job = structuredClone(job);
      if(job.artifact.runtime !== "network") return base.execute({...job,context:unwrapped(job.context)},signal);
      if(job.owner !== base.owner || job.artifactDigest !== harnessDigest(job.artifact)) throw Error("Observed harness owner or revision mismatch");
      const resolved = await admit(job.artifact,job.contract,job.context,job.input,signal,job.caseId);
      let output: HarnessJson = null;
      const measured=await resolved.execute(job.input as Record<string,HarnessJson>,(step,body)=>{if(step===resolved.stepIds.at(-1))output=JSON.parse(JSON.stringify(body ?? null)) as HarnessJson;},signal,{maxCalls:16,maxBytes:262144});
      await admit(job.artifact,job.contract,job.context,job.input,signal,job.caseId);
      base.guard(output);
      return {status:"succeeded",output,evidence:[`observed-read-operation:${job.operationId}`,`observed-read-source:${resolved.digest}`,`observed-read-revision:${job.artifactDigest}`],measurements:{networkRequests:measured.calls,browserStarts:0,modelCalls:0,tokens:0}};
    },
    reconcile: async (job,s) => job.artifact.runtime === "network" ? {status:"unknown",evidence:["observed-read-receipt-unavailable-no-replay"]} : base.reconcile ? base.reconcile({...job,context:unwrapped(job.context)},s) : {status:"unknown",evidence:["receipt-reader-unavailable"]},
  };
}
