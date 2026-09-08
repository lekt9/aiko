import { createHash } from "node:crypto";
import { SandboxCompute } from "./sandbox-compute.ts";
import { CODING_WORKSPACE_ABI, codingWorkspaceAuthorized, codingWorkspaceEnvironment, validateCodingWorkspaceRequest, type CodingRepositoryGrant, type CodingWorkspaceBinding, type CodingWorkspaceRequest } from "./coding-workspace.ts";
import type { ProjectCollection, ProjectContextOptions, ProjectReadIdentity, ProjectSelection } from "./project-instructions.ts";
import { sandboxDigest, type SandboxJobReceipt } from "./sandbox-job.ts";

export interface CodingWorkspaceHostConfig {
  /** Exact trusted coding-workspace-main bundle. Build with target=bun. */
  runnerBundle: string;
  repositories: CodingRepositoryGrant[];
  /** Must match the installed runtime; bootstrap currently pins Bun 1.4.0. */
  bunVersion: string;
  wallMs?: number;
  /** Optional trusted deployment path; never supplied by a tool caller. */
  stateRoot?: string;
}
/** Same runner and JSON protocol for local Bun hosts and Cloudflare hosts.
 * Commands run in existing owner compute, never the application host or vault. */
export class CodegraffCodingWorkspace {
  readonly config: CodingWorkspaceHostConfig;
  constructor(readonly compute: SandboxCompute, config: CodingWorkspaceHostConfig) {
    if (!config.runnerBundle || !config.bunVersion || !Array.isArray(config.repositories) ||
        config.repositories.some(grant => !grant.id || !grant.root.startsWith("/") || !Array.isArray(grant.actions) || !grant.checks)) throw Error("Trusted coding repository configuration required");
    this.config = structuredClone(config);
  }
  get grantRevision() { return createHash("sha256").update(JSON.stringify({ abi: CODING_WORKSPACE_ABI, bunVersion: this.config.bunVersion,
    runner: createHash("sha256").update(this.config.runnerBundle).digest("hex"), repositories: this.config.repositories })).digest("hex"); }
  binding(thread: string, redact: (text: string) => string): CodingWorkspaceBinding {
    return { owner: this.compute.owner, thread, redact,
      grantRevision: this.grantRevision,
      authorizeRetained: command => !!command && codingWorkspaceAuthorized(this.config.repositories.find(grant => grant.id === command.repository), command),
      invoke: (request, signal) => {
      if (request.thread !== thread) throw Error("Coding workspace thread mismatch");
      return this.invoke(request, signal);
    } };
  }
  projectContext(thread: string, redact: (text: string) => string, current?: () => CodegraffCodingWorkspace | undefined | Promise<CodegraffCodingWorkspace | undefined>): ProjectContextOptions | undefined {
    const repositories = this.config.repositories.filter(grant => grant.actions.includes("read") && grant.actions.includes("list")).map(grant => grant.id);
    if (!repositories.length) return undefined;
    const owner = this.compute.owner, revision = this.grantRevision;
    const active = async () => {
      const workspace = current ? await current() : this;
      return workspace?.compute.owner === owner && workspace.grantRevision === revision ? workspace : undefined;
    };
    const authorizeRetained = async (selection?: Partial<ProjectSelection>) => {
      const workspace = await active();
      return !!workspace && (selection?.repository ? [selection.repository] : repositories).every(id => workspace.config.repositories.some(grant => grant.id === id && grant.actions.includes("read") && grant.actions.includes("list")));
    };
    const read = async (selection: ProjectSelection, kind: "collect" | "load", path: string | undefined, identity: ProjectReadIdentity, signal: AbortSignal) => {
      const workspace = await active();
      if (!workspace || !await authorizeRetained(selection)) throw Error("Project repository read/list authority changed; refresh the project binding");
      const command = { action: "context" as const, ...selection, kind, ...(path === undefined ? {} : { path }) };
      const operationId = `project:${(await sandboxDigest([identity.callId, command])).slice(7)}`;
      const receipt = await workspace.invoke({ version: 1, owner, thread, turn: identity.turn, operationId, command }, signal);
      if (!await authorizeRetained(selection)) throw Error("Project repository authority changed during the read");
      if (receipt.status !== "completed" || receipt.output === undefined) throw Error(receipt.reason ?? "Project context read did not complete");
      return JSON.parse(redact(JSON.stringify(receipt.output)));
    };
    return { owner, thread, redact, remote: { repositories, grantRevision: revision, authorizeRetained,
      collect: (selection, identity, signal) => read(selection, "collect", undefined, identity, signal) as Promise<ProjectCollection>,
      load: (selection, path, identity, signal) => read(selection, "load", path, identity, signal),
    } };
  }
  async invoke(raw: CodingWorkspaceRequest, signal: AbortSignal): Promise<SandboxJobReceipt> {
    const request = validateCodingWorkspaceRequest(structuredClone(raw));
    if (request.owner !== this.compute.owner) throw Error("Coding workspace owner mismatch");
    const grant = this.config.repositories.find(repository => repository.id === request.command.repository);
    if (!codingWorkspaceAuthorized(grant, request.command)) throw Error("Repository action has no owner grant");
    const environmentDigest = await codingWorkspaceEnvironment(this.config.runnerBundle, this.config.bunVersion), jobDigest = await sandboxDigest(request);
    const base = { operationId: request.operationId, jobDigest, harnessDigest: await sandboxDigest(CODING_WORKSPACE_ABI), environmentDigest, requests: 0, browserStarts: 0 as const };
    let terminalOperation: { thread: string; operation: string } | undefined;
    if (request.command.action === "reconcile") {
      const originalJob = createHash("sha256").update(JSON.stringify([request.owner, request.thread, `coding:${request.command.operation}`])).digest("hex");
      const observed = await this.compute.confirmTerminal(request.thread, originalJob, signal).catch(() => undefined);
      // A DELETE acknowledgement may precede actual process termination. Only
      // a provider GET reporting completion and an exit code proves terminal.
      if (observed?.state === "completed" && "exitCode" in observed && Number.isInteger(observed.exitCode)) terminalOperation = { thread: request.thread, operation: request.command.operation };
    }
    const config = { owner: request.owner, environmentDigest, repositories: this.config.repositories, ...(terminalOperation ? { terminalOperation } : {}), ...(this.config.wallMs === undefined ? {} : { wallMs: this.config.wallMs }), ...(this.config.stateRoot === undefined ? {} : { stateRoot: this.config.stateRoot }) };
    const runner = `/tmp/aiko-coding-${(await sandboxDigest(this.config.runnerBundle)).slice(7)}.js`;
    const configPath = `/tmp/aiko-coding-${(await sandboxDigest(config)).slice(7)}.config.json`;
    const input = `/tmp/aiko-coding-${jobDigest.slice(7)}.input.json`, output = `/tmp/aiko-coding-${jobDigest.slice(7)}.receipt.json`;
    const invocation = `coding:${request.operationId}`;
    // Derive the same compute handle even if cancellation loses its launch reply.
    const jobId = createHash("sha256").update(JSON.stringify([request.owner, request.thread, invocation])).digest("hex");
    let machine: string | undefined;
    try {
      machine = await this.compute.ensureMachine(signal);
      for (const [path, text] of [[runner, this.config.runnerBundle], [configPath, JSON.stringify(config)], [input, JSON.stringify(request)]])
        await this.compute.gateway.request(`/v1/sandboxes/${machine}/upload`, { path, contentBase64: Buffer.from(text!).toString("base64") }, signal);
      let status: any = await this.compute.exec(request.thread, invocation, { command: `/home/daytona/.bun/bin/bun ${runner} --config ${configPath} job ${input} ${output}` }, signal);
      while (status.state === "running") status = await this.compute.wait(request.thread, jobId, signal, 1000);
      const data = await this.compute.gateway.request(`/v1/sandboxes/${machine}/download`, { path: output }, signal, undefined, 2 * 1024 * 1024);
      if (typeof data.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.contentBase64)) throw Error("Coding receipt encoding unavailable");
      const bytes = Buffer.from(data.contentBase64, "base64");
      if (bytes.length > 1048576 || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw Error("Coding receipt exceeds transfer bounds");
      const receipt = JSON.parse(bytes.toString("utf8")) as SandboxJobReceipt;
      if (!["completed", "failed", "unknown"].includes(receipt.status) || receipt.operationId !== base.operationId || receipt.jobDigest !== jobDigest ||
          receipt.harnessDigest !== base.harnessDigest || receipt.environmentDigest !== environmentDigest || receipt.requests !== 0 || receipt.browserStarts !== 0 ||
          receipt.outputDigest !== (receipt.output === undefined ? undefined : await sandboxDigest(receipt.output))) throw Error("Coding receipt identity or runtime mismatch");
      return receipt;
    } catch (error) {
      return { ...base, status: "unknown", reason: String(error instanceof Error ? error.message : error).slice(0, 512) };
    } finally {
      if (signal.aborted && machine) await this.compute.poll(request.thread, jobId, AbortSignal.timeout(10000), true).catch(() => undefined);
    }
  }
}
