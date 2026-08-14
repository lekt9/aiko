// smithers-source: e2e-fixture (recursion.depth2 gate)
// smithers-display-name: Recursive Outer (aiko harness)
// smithers-description: The OUTER run of the depth-2 recursive seal: its single
// task executes on the aiko harness, and the aiko agent's one job is to run the
// spawn command that starts the INNER Smithers run with --parent-run-id
// "$SMITHERS_RUN_ID" (the provenance edge). The spawn command arrives fully
// quoted via input so the gate owns the quoting; $SMITHERS_RUN_ID stays
// unexpanded until the aiko worker's own shell, where taskContextEnv injected
// it. Driven by e2e/recursive-stack-gate.sh.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";

const inputSchema = z.object({
  spawnCommand: z
    .string()
    .min(1)
    .describe("Exact shell command the aiko agent must execute to start the inner run."),
  innerRunId: z.string().min(1).describe("Run id the inner run was assigned."),
});
const outputSchema = z.object({
  ok: z.boolean(),
  innerRunId: z.string(),
});
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  result: outputSchema,
});

export default smithers((ctx) => (
  <Workflow name="recursive-outer">
    <Task id="spawn-inner" output={outputs.result} agent={providers.aiko} retries={1}>
      {[
        `Execute exactly this shell command and nothing else:`,
        ctx.input.spawnCommand,
        `Do not modify the command, do not run anything before or after it.`,
        `If the command exits 0, reply with ONLY this JSON object and nothing else:`,
        `{"ok": true, "innerRunId": ${JSON.stringify(ctx.input.innerRunId)}}`,
        `If it exits nonzero, reply with ONLY:`,
        `{"ok": false, "innerRunId": ${JSON.stringify(ctx.input.innerRunId)}}`,
      ].join("\n")}
    </Task>
  </Workflow>
));
