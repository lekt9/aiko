import { ContractWebhookClient } from "@smthrs/gateway-client";
/** Public CLI adapter; argument parsing remains owned by the composition root. */
export async function runContractWebhooksCommand({ gateway, action, input = {} }) {
 const client = new ContractWebhookClient(gateway);
 if (action === "create") return client.create(input);
 if (action === "list") return client.list();
 if (action === "inspect") return client.inspect(input.endpointId);
 if (action === "rotate") return client.rotate(input);
 if (action === "pause") return client.pause(input.endpointId,input.expectedGeneration);
 if (action === "revoke") return client.revoke(input.endpointId,input.expectedGeneration);
 throw new Error(`unknown contract-webhooks action: ${action}`);
}
