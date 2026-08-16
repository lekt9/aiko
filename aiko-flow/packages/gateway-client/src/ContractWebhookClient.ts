import type { ContractWebhookRpcRequestMap, ContractWebhookRpcResponseMap } from "@smthrs/protocol/contractWebhooks";
type Transport = { rpcRaw(method: string, params?: unknown): Promise<unknown> };
export class ContractWebhookClient {
 constructor(private readonly gateway: Transport) {}
 private call<M extends keyof ContractWebhookRpcRequestMap>(method:M & string, params:ContractWebhookRpcRequestMap[M]) { return this.gateway.rpcRaw(method, params) as Promise<ContractWebhookRpcResponseMap[M]>; }
 create(input:ContractWebhookRpcRequestMap["contractWebhooks.create"]){return this.call("contractWebhooks.create",input)}
 list(){return this.call("contractWebhooks.list",{})}
 inspect(endpointId:string){return this.call("contractWebhooks.inspect",{endpointId})}
 rotate(input:ContractWebhookRpcRequestMap["contractWebhooks.rotate"]){return this.call("contractWebhooks.rotate",input)}
 pause(endpointId:string,expectedGeneration:number){return this.call("contractWebhooks.pause",{endpointId,expectedGeneration})}
 revoke(endpointId:string,expectedGeneration:number){return this.call("contractWebhooks.revoke",{endpointId,expectedGeneration})}
}
