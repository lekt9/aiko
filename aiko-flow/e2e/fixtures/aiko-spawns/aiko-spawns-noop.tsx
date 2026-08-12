// smithers-source: e2e-fixture (aiko.spawns_smithers witness)
// smithers-display-name: Aiko Spawns Noop
// smithers-description: Inert one-task workflow (no agent, pure function) used by
// tmp/witness-aiko-spawns-smithers.sh to prove a headless aiko invocation can start
// a real Smithers run. Safe to delete together with the witness.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const { Workflow, Task, smithers, outputs } = createSmithers({
  out: z.object({ ok: z.boolean(), sentinel: z.string() }),
});

export default smithers(() => (
  <Workflow name="aiko-spawns-noop">
    <Task id="noop" output={outputs.out} retries={0}>
      {() => ({ ok: true, sentinel: "AIKO_SPAWNS_NOOP" })}
    </Task>
  </Workflow>
));
