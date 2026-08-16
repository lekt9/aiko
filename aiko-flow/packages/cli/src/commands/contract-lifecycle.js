import { ContractLifecycleClient } from "@smthrs/gateway-client";
/** Public CLI adapter. It only speaks authenticated Gateway RPC. */
export async function runContractLifecycleCommand({ gateway, action, input = {} }) {
  const client = new ContractLifecycleClient(gateway);
  if (action === "inspect") return client.inspect(input.runId);
  if (action === "pause") return client.pause(input.runId,input.expectedGeneration);
  if (action === "resume") return client.resume(input.runId,input.expectedGeneration);
  if (action === "cancel") return client.cancel(input.runId,input.expectedGeneration,input.reason);
  if (action === "revoke") return client.revoke(input);
  if (action === "semantic-rollback") return client.semanticRollback(input);
  if (action === "time-travel-fork") return client.timeTravelFork(input.runId,input.expectedGeneration,input.frameNo);
  throw new Error(`unknown contract-lifecycle action: ${action}`);
}
