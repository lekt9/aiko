import {runSandboxJob,type SandboxJobBinding} from "./sandbox-job-runner.ts";
import type {HarnessSandboxClient} from "./harness-sandbox.ts";
/** Import only in Bun hosts. Keeping this separate prevents Worker bundlers from
 * following Bun/SQLite runtime dependencies when selecting Codegraff placement. */
export function localHarnessSandbox(binding:SandboxJobBinding):HarnessSandboxClient {
  return {
    async harnessEnvironment(signal) {signal?.throwIfAborted();return binding.environmentDigest;},
    async harnessJob(job,signal) {return runSandboxJob(job,binding,signal);},
  };
}
