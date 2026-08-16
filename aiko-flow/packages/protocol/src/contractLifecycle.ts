export type ContractPinKind = "graph" | "input" | "cell" | "limb" | "credential";
export type ContractRunPin = Readonly<{ kind: ContractPinKind; id: string; digest: string; generation: number }>;
export type ContractExecutionRun = Readonly<{
  tenantId: string; ownerId: string; contractRoot: string; runId: string;
  phase: "runnable" | "active" | "paused" | "cancelled" | "settled" | "invalidated";
  lifecycleGeneration: number; pins: readonly ContractRunPin[];
}>;
export type ContractLifecycleRpcRequestMap = {
  "contractLifecycle.inspect": { runId: string };
  "contractLifecycle.pause": { runId: string; expectedGeneration: number };
  "contractLifecycle.resume": { runId: string; expectedGeneration: number };
  "contractLifecycle.cancel": { runId: string; expectedGeneration: number; reason: string };
  "contractLifecycle.revoke": { runId: string; kind: "tool" | "credential"; id: string; expectedGeneration: number; reason: string };
  "contractLifecycle.semanticRollback": { runId: string; expectedGeneration: number; targetOccurrenceId: string; reason: string };
  "contractLifecycle.timeTravelFork": { runId: string; expectedGeneration: number; frameNo: number };
};
export type ContractLifecycleRpcResponseMap = {
  "contractLifecycle.inspect": ContractExecutionRun;
  "contractLifecycle.pause": Readonly<{ run: ContractExecutionRun; newClaims: "blocked"; claims: readonly Readonly<{claimId:string; instruction:"drain"|"park"}>[] }>;
  "contractLifecycle.resume": ContractExecutionRun;
  "contractLifecycle.cancel": ContractExecutionRun;
  "contractLifecycle.revoke": Readonly<{kind:"tool"|"credential"; id:string; generation:number; revoked:true}>;
  "contractLifecycle.semanticRollback": Readonly<{targetOccurrenceId:string; occurrences: readonly Readonly<Record<string, unknown>>[]}>;
  "contractLifecycle.timeTravelFork": Readonly<{contractRoot:string; parentRunId:string; childRunId:string; frameNo:number}>;
};
