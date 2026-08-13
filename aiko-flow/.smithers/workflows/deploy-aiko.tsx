// smithers-source: user
// smithers-metadata-version: 1
// smithers-display-name: Deploy Aiko
// smithers-description: Seat Aiko as a Cell harness inside this workflow, then continue as the Aiko agent. Account credentials, not API keys.
// smithers-tags: aiko, cell, fde
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { AikoAgent } from "smthrs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod/v4";

const selfWire = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../cell/patterns/fde/self-wire.cell.yaml",
);

const { Workflow, Task, Sequence, Cell, smithers, outputs } = createSmithers({
  input: z.object({
    tenant: z.string().default("acme"),
    origin: z.string().default("https://mail.example"),
    account_id: z.string().default("aiko-ops"),
    role: z.string().default("ops-staffer"),
    outcome: z.string().default("own daily roster confirmation"),
    seatAgent: z.boolean().default(false),
  }),
  handoff: z.object({
    agent: z.string().optional(),
    seat: z.string().optional(),
    auth: z.string().optional(),
    role: z.string().optional(),
    workflow_digest: z.string().optional(),
    handle_id: z.string().optional(),
    tenant: z.string().optional(),
    origin: z.string().optional(),
    account_id: z.string().optional(),
    authority: z.array(z.string()).optional(),
    _cell: z.unknown().optional(),
  }).passthrough(),
  output: z.object({
    handle_id: z.string().optional(),
    workflow_digest: z.string().optional(),
    role: z.string().optional(),
    agent: z.string().optional(),
  }),
});

/**
 * Harness within the workflow: a Cell seats Aiko. Optionally an AikoAgent
 * task continues as that employee. Smithers is control; Cell is the harness.
 */
export default smithers((ctx) => {
  const handoff = ctx.outputMaybe(outputs.handoff, { nodeId: "wire" });
  return (
    <Workflow name="deploy-aiko">
      <Sequence>
        <Cell
          id="wire"
          cell={selfWire}
          output={outputs.handoff}
          outputPort="handoff"
          inputs={{
            account: {
              tenant: ctx.input.tenant,
              origin: ctx.input.origin,
              account_id: ctx.input.account_id,
            },
            role: ctx.input.role,
            outcome: ctx.input.outcome,
          }}
        />
        {handoff && ctx.input.seatAgent ? (
          <Task id="aiko" agent={new AikoAgent({})} output={outputs.output} deps={{ handoff: outputs.handoff }}>
            {() =>
              `You are Aiko, seated as ${handoff.role ?? ctx.input.role} via handle ${handoff.handle_id ?? ""}. Own: ${ctx.input.outcome}`
            }
          </Task>
        ) : handoff ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              handle_id: handoff.handle_id,
              workflow_digest: handoff.workflow_digest,
              role: handoff.role,
              agent: handoff.agent,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
