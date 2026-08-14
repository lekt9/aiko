// smithers-source: e2e-fixture (recursion.depth2 gate)
// smithers-display-name: Recursive Inner (inert)
// smithers-description: The INNER run of the depth-2 recursive seal. Deliberately
// inert: a pure function task, no agent, and it spawns NOTHING — the depth cap
// is the termination proof for the recursion, the same way redrive and
// authoring are bounded searches. Driven by e2e/recursive-stack-gate.sh.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const inputSchema = z.object({
  sentinelPath: z
    .string()
    .min(1)
    .describe("Absolute path this inert task writes its sentinel to."),
  sentinelContent: z
    .string()
    .min(1)
    .describe("Exact single-line sentinel content."),
});
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  out: z.object({ ok: z.boolean(), sentinelPath: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="recursive-inner">
    <Task id="inert-sentinel" output={outputs.out} retries={0}>
      {async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        fs.mkdirSync(path.dirname(ctx.input.sentinelPath), { recursive: true });
        fs.writeFileSync(ctx.input.sentinelPath, ctx.input.sentinelContent + "\n");
        return { ok: true, sentinelPath: ctx.input.sentinelPath };
      }}
    </Task>
  </Workflow>
));
