export const CONTRACT_LIFECYCLE_RPC_METHODS = Object.freeze([
  "contractLifecycle.inspect", "contractLifecycle.pause", "contractLifecycle.resume",
  "contractLifecycle.cancel", "contractLifecycle.revoke", "contractLifecycle.semanticRollback",
  "contractLifecycle.timeTravelFork",
]);
export const isContractLifecycleRpcMethod = (method) => CONTRACT_LIFECYCLE_RPC_METHODS.includes(method);
export function routeContractLifecycleRpc(surface, method, context, params) {
  if (!surface || typeof surface.rpc !== "function") throw new Error("Contract lifecycle surface is not configured");
  if (!isContractLifecycleRpcMethod(method)) throw new Error(`Unknown Contract lifecycle RPC method: ${method}`);
  return surface.rpc(method, context, params);
}
