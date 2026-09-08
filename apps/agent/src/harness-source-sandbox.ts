import { validateSiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";
import { harnessDigest } from "./harness-library.ts";
import type { HarnessSandboxOptions } from "./harness-sandbox.ts";
import type { HarnessSourceTransport } from "./harness-sources.ts";
import { sandboxDigest, verifySandboxReceipt, type SandboxJob } from "./sandbox-job.ts";

/** Registry acquisition uses the same fresh network DAG jobs as learned reads.
 * No browser startup, ambient host fetch, install hook or credential inheritance. */
export function sandboxSourceTransport(options: HarnessSandboxOptions): HarnessSourceTransport {
  return { async get(target, operationId, signal) {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !["api.github.com", "skills.sh", "www.skills.sh"].includes(url.hostname)) throw Error("Unsupported registry origin");
    const authority = structuredClone(await options.current(signal));
    if (!authority.active || authority.owner !== options.owner || !authority.effects.includes("read") || !authority.origins.includes(url.origin) || !authority.methods.includes("GET") || authority.budget.requests < 1) throw Error("Registry read outside current authority");
    if (await options.sandbox.harnessEnvironment(signal) !== authority.runtimeDigest) throw Error("Registry runtime changed");
    const input: Record<string, string> = {}, pathParameters: Record<string, { kind: "input"; name: string }> = {}, query: Record<string, { kind: "input"; name: string }> = {};
    const parts = url.pathname.split("/").filter(Boolean);
    const path = "/" + parts.map((part, i) => {
      const name = `part${i}`; input[name] = decodeURIComponent(part); pathParameters[name] = { kind: "input", name }; return `{${name}}`;
    }).join("/");
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(query, key)) throw Error("Ambiguous registry query");
      const name = `query${Object.keys(query).length}`; input[name] = value; query[key] = { kind: "input", name };
    }
    const graph = validateSiteHarnessArtifact({ schemaVersion: 2, executorAbi: "site-harness/1", siteId: "registry-source", version: "1", sourceCaptureDigest: harnessDigest("registry-source-get-v1"), allowedOrigins: [url.origin],
      actions: [{ id: "fetch", inputs: Object.keys(input).map(name => ({ name, type: "string", required: true })), steps: [{ id: "fetch", method: "GET", origin: url.origin, path, pathParameters, query, headers: {}, dependsOn: [], expectedStatuses: [200] }] }] });
    const artifact = { kind: "network" as const, graph, actionId: "fetch" };
    const job: SandboxJob = { version: 1, operationId: `registry:${harnessDigest([options.thread, operationId, target]).slice(7)}`, owner: options.owner,
      contextRef: authority.contextRef, authorityRef: authority.authorityRef, artifact, harnessDigest: await sandboxDigest(artifact), dependencyLock: {}, dependencyLockDigest: await sandboxDigest({}), environmentDigest: authority.runtimeDigest, input,
      authority: { origins: [url.origin], methods: ["GET"] }, budget: { requests: 1, wallMs: Math.min(authority.budget.wallMs, 30000), outputBytes: Math.min(authority.budget.outputBytes, 262144) } };
    if (harnessDigest(await options.current(signal)) !== harnessDigest(authority)) throw Error("Registry authority changed before dispatch");
    signal.throwIfAborted();
    const receipt = await verifySandboxReceipt(job, await options.sandbox.harnessJob(job, signal));
    const current = await options.current(signal);
    if (harnessDigest(current) !== harnessDigest(authority)) throw Error("Registry authority changed during fetch");
    if (receipt.status !== "completed") throw Error("Registry fetch unconfirmed; inspect sandbox receipt");
    const output = receipt.output as { terminal: unknown };
    if (!output || !Object.hasOwn(output, "terminal")) throw Error("Registry response unavailable");
    return { value: output.terminal, receipt: `sandbox-operation:${receipt.operationId}` };
  } };
}
