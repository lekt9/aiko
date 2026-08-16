export const CONTRACT_WEBHOOK_RPC_METHODS = Object.freeze([
  "contractWebhooks.create", "contractWebhooks.list", "contractWebhooks.inspect",
  "contractWebhooks.rotate", "contractWebhooks.pause", "contractWebhooks.revoke",
]);
export const isContractWebhookRpcMethod = (method) => CONTRACT_WEBHOOK_RPC_METHODS.includes(method);
export function routeContractWebhookRpc(surface, method, context, params) {
  if (!surface || typeof surface.rpc !== "function") throw new Error("Contract webhook surface is not configured");
  if (!isContractWebhookRpcMethod(method)) throw new Error(`Unknown Contract webhook RPC method: ${method}`);
  return surface.rpc(method, context, params);
}
