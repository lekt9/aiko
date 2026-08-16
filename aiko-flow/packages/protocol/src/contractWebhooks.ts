export type CredentialHandle = Readonly<{ handle: string; generation: number }>;
export type ContractTemplatePin = Readonly<{ name: string; generation: number }>;
export type ContractWebhookEndpoint = Readonly<{
  endpointId: string; tenantId: string; status: "active"|"paused"|"revoked"; endpointGeneration: number;
  provider: string; audience: string; route: string; methods: readonly string[]; contentType: string;
  bodyLimitBytes: number; credentialHandle: CredentialHandle; replayWindowSeconds: number;
  contractTemplate: ContractTemplatePin; requiredScopes: readonly string[];
}>;
export type CreateContractWebhookRequest = Omit<ContractWebhookEndpoint,"endpointId"|"tenantId"|"status"|"endpointGeneration">;
export type ContractWebhookRpcRequestMap = {
 "contractWebhooks.create": CreateContractWebhookRequest; "contractWebhooks.list": Record<string, never>;
 "contractWebhooks.inspect": {endpointId:string}; "contractWebhooks.rotate": {endpointId:string;expectedGeneration:number;credentialHandle:CredentialHandle};
 "contractWebhooks.pause": {endpointId:string;expectedGeneration:number}; "contractWebhooks.revoke": {endpointId:string;expectedGeneration:number};
};
export type ContractWebhookRpcResponseMap = {
 "contractWebhooks.create": ContractWebhookEndpoint; "contractWebhooks.list": readonly ContractWebhookEndpoint[];
 "contractWebhooks.inspect": ContractWebhookEndpoint; "contractWebhooks.rotate": ContractWebhookEndpoint;
 "contractWebhooks.pause": ContractWebhookEndpoint; "contractWebhooks.revoke": ContractWebhookEndpoint;
};
