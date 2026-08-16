import type { ContractLifecycleRpcRequestMap, ContractLifecycleRpcResponseMap } from "@smthrs/protocol/contractLifecycle";
type Transport = { rpcRaw(method: string, params?: unknown): Promise<unknown> };
export class ContractLifecycleClient {
  constructor(private readonly gateway: Transport) {}
  private call<M extends keyof ContractLifecycleRpcRequestMap>(method: M & string, params: ContractLifecycleRpcRequestMap[M]) {
    return this.gateway.rpcRaw(method, params) as Promise<ContractLifecycleRpcResponseMap[M]>;
  }
  inspect(runId:string){ return this.call("contractLifecycle.inspect", {runId}); }
  pause(runId:string, expectedGeneration:number){ return this.call("contractLifecycle.pause", {runId, expectedGeneration}); }
  resume(runId:string, expectedGeneration:number){ return this.call("contractLifecycle.resume", {runId, expectedGeneration}); }
  cancel(runId:string, expectedGeneration:number, reason:string){ return this.call("contractLifecycle.cancel", {runId, expectedGeneration, reason}); }
  revoke(input:ContractLifecycleRpcRequestMap["contractLifecycle.revoke"]){ return this.call("contractLifecycle.revoke", input); }
  semanticRollback(input:ContractLifecycleRpcRequestMap["contractLifecycle.semanticRollback"]){ return this.call("contractLifecycle.semanticRollback", input); }
  timeTravelFork(runId:string, expectedGeneration:number, frameNo:number){ return this.call("contractLifecycle.timeTravelFork", {runId, expectedGeneration, frameNo}); }
}
