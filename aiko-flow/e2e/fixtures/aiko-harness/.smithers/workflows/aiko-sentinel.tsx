// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Aiko sentinel (e2e fixture)
// smithers-description: Single-task workflow that runs on the aiko harness and writes a sentinel file. Driven by e2e/aiko-harness-gate.sh.
// smithers-disable-model-invocation: true
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";

const inputSchema = z.object({
  sentinelPath: z
    .string()
    .min(1)
    .describe("Absolute path the aiko agent must write the sentinel file to."),
  sentinelContent: z
    .string()
    .min(1)
    .describe("Exact single-line content the sentinel file must contain."),
});
const outputSchema = z.object({
  ok: z.boolean(),
  sentinelPath: z.string(),
});
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  result: outputSchema,
});

export default smithers((ctx) => (
  <Workflow name="aiko-sentinel">
    <Task id="write-sentinel" output={outputs.result} agent={providers.aiko} retries={1}>
      {[
        `Create a file at exactly this absolute path: ${ctx.input.sentinelPath}`,
        `The file's entire content must be exactly this single line followed by one trailing newline:`,
        ctx.input.sentinelContent,
        `Do not add anything else to the file — no comments, no extra whitespace.`,
        `Use your file-writing tool to create it (create parent directories if needed).`,
        `After the file is written, reply with ONLY this JSON object and nothing else:`,
        `{"ok": true, "sentinelPath": ${JSON.stringify(ctx.input.sentinelPath)}}`,
      ].join("\n")}
    </Task>
  </Workflow>
));
