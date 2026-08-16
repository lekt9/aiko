// smithers-source: user
// smithers-metadata-version: 1
// smithers-display-name: Deploy Aiko through Contract
// smithers-description: Authenticated Contract hook -> pinned Cell/workflow -> admitted Aiko -> one delegated child.
// smithers-tags: aiko, contract, cell, webhook
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { ContractAikoAgent } from "@smthrs/agents/ContractAikoAgent";
import { z } from "zod/v4";

const SERVICE = Symbol.for("smithers.contract-aiko-agent.v1");
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  // This is a public-hook delivery reference, not an authority DTO. Tenant,
  // root, role, account and effects are deliberately not caller-controlled.
  input: z.object({
    hookDeliveryHandle: z.string().min(16),
    canonicalRequestDigest: z.string().regex(/^[0-9a-f]{64}$/i),
  }).strict(),
  output: z.object({
    status: z.enum(["settled", "cancelled", "compensating"]),
    rootId: z.string().optional(),
    occurrenceId: z.string(),
    childOccurrenceId: z.string().optional(),
    childExecutionId: z.string().optional(),
    workflowDigest: z.string().optional(),
  }).strict(),
});

function boundContractAgent() {
  const agent = globalThis[SERVICE];
  if (!(agent instanceof ContractAikoAgent)) {
    throw new Error("deploy-aiko requires an explicitly bound ContractAikoAgent service");
  }
  return agent;
}

/**
 * Smithers only schedules the invocation. ContractAikoAgent re-authenticates
 * the public delivery handle, reads purpose-scoped cited Contract context,
 * checks the admitted limb and pinned Cell/workflow, then delegates one child.
 */
export default smithers((ctx) => (
  <Workflow name="deploy-aiko-contract-organism">
    <Sequence>
      <Task id="contract-hook" output={outputs.output}>
        {async () => {
          const result = await boundContractAgent().launchFromHook({
            deliveryHandle: ctx.input.hookDeliveryHandle,
            canonicalRequestDigest: ctx.input.canonicalRequestDigest,
          });
          return {
            status: result.status,
            rootId: result.rootId,
            occurrenceId: result.occurrenceId,
            childOccurrenceId: result.childOccurrenceId,
            childExecutionId: result.childExecutionId,
            workflowDigest: result.workflowDigest,
          };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
