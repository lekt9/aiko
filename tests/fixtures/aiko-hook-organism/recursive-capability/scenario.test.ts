import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContractAikoAgent } from "../../../../aiko-flow/packages/agents/src/ContractAikoAgent.js";

const DIGEST = (character: string) => character.repeat(64);
const scratch: string[] = [];
afterEach(async () => Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

type Mutation = "same-child" | "widen-authority" | "leak-transcript" | "leak-account" | "leak-global-memory";

async function syntheticAiko(delayMs = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "e2e-recursive-capability-"));
  scratch.push(dir);
  const workspace = path.join(dir, "workspace");
  const bin = path.join(dir, "bin");
  const invocations = path.join(dir, "invocations.jsonl");
  await mkdir(workspace);
  await mkdir(bin);
  const executable = path.join(bin, "aiko");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const at = process.argv.indexOf("--single");
const prompt = process.argv[at + 1] || "";
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ prompt, argv: process.argv.slice(2) }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "text", data: "RESULT-THAT-MUST-NOT-BE-COPIED:" + prompt }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "end", sessionId: "synthetic", usage: {} }) + "\\n");
}, ${delayMs});
`);
  await chmod(executable, 0o755);
  return { dir, workspace, bin, invocations };
}

class SyntheticContract {
  rows: Record<string, unknown>[] = [];
  effects: { effectId: string }[] = [];
  ordinal = 1;
  lifecycle = { authored: false, admitted: false, attached: false, revoked: false, cellPinned: false };
  issued: any;
  mutation?: Mutation;
  onBegin?: () => Promise<void> | void;

  constructor(readonly file: string, mutation?: Mutation) {
    this.mutation = mutation;
    this.flush();
  }
  flush() { writeFileSync(this.file, JSON.stringify({ rows: this.rows, effects: this.effects })); }
  add(type: string, data: Record<string, unknown> = {}) {
    this.rows.push({ ordinal: this.ordinal++, type, ...data });
    this.flush();
  }
  authorPinnedCell() {
    this.lifecycle.authored = true;
    this.add("cell.authored_inert", { cellPackageDigest: DIGEST("d"), workflowDigest: DIGEST("e") });
  }
  admitAndAttachLimb() {
    if (!this.lifecycle.authored) throw new Error("Cell must exist before capability admission");
    this.lifecycle.admitted = true;
    this.lifecycle.attached = true;
    this.add("limb.admitted", { digest: DIGEST("c"), attachmentGeneration: 1 });
  }
  pinCell() {
    if (!this.lifecycle.authored) throw new Error("cannot pin an absent Cell");
    this.lifecycle.cellPinned = true;
    this.add("cell.pinned", { cellPackageDigest: DIGEST("d"), workflowDigest: DIGEST("e") });
  }
  revokeLimb() {
    this.lifecycle.revoked = true;
    this.lifecycle.attached = false;
    this.add("limb.revoked", { digest: DIGEST("c") });
  }
  send(effectId: string) { this.effects.push({ effectId }); this.add("effect.sent", { effectId }); }

  async authenticateHook(request: any) {
    this.add("hook.authenticated", { deliveryId: request.deliveryId });
    return { authenticatedSubject: "hook-subject", tenant: "tenant-contract", grantedScopes: ["deploy-aiko", "send:webhook", "resource:roster"], credentialGeneration: "credential-7", verificationEvidence: { citationId: DIGEST("9") } };
  }
  async acceptHook(data: any) {
    this.add("occurrence.accepted", data);
    return { rootId: "root-contract", occurrenceId: "occ-parent", executionId: "exec-parent", effectScopes: ["admin", "send:webhook"], resourceScopes: ["resource:all", "resource:roster"], maxEffects: 4, readOnly: false };
  }
  async readPurposeContext() {
    const field = this.mutation === "leak-transcript" ? "transcript" : this.mutation === "leak-account" ? "account" : this.mutation === "leak-global-memory" ? "globalMemory" : "roster";
    return { sourceVersion: 3, items: [{ field, value: field === "roster" ? "cas:roster-v4" : "FORBIDDEN-CONTEXT", citationId: DIGEST("a"), commitOrdinal: 7 }] };
  }
  async readAdmittedLimb({ digest }: { digest: string }) {
    const usable = this.lifecycle.admitted && this.lifecycle.attached && !this.lifecycle.revoked;
    return { status: usable ? "admitted" : this.lifecycle.revoked ? "revoked" : "authored", digest, attachmentGeneration: 1 };
  }
  async readPinnedCellWorkflow(input: any) { return { ...input, status: this.lifecycle.cellPinned ? "pinned" : "authored" }; }
  async beginExecution(data: any) { this.add("execution.started", data); await this.onBegin?.(); }
  async issueDelegation(data: any) { this.issued = data; this.add("delegation.issued", data); return { grantId: DIGEST("b") }; }
  async adoptDelegation() {
    const same = this.mutation === "same-child";
    return { rootId: "root-contract", parentOccurrenceId: "occ-parent", occurrenceId: same ? "occ-parent" : "occ-child", executionId: same ? "exec-parent" : "exec-child", effectScopes: this.mutation === "widen-authority" ? ["admin"] : this.issued.effectScopes, resourceScopes: this.issued.resourceScopes, citationIds: this.issued.citationIds, maxEffects: this.issued.maxEffects, readOnly: this.issued.readOnly, credentialGeneration: this.issued.credentialGeneration };
  }
  async runDelegatedChild(binding: any, invoke: () => Promise<any>) { this.add("child.adopted", binding); return invoke(); }
  async recordExecutionEvidence(data: any) { this.add("execution.evidence", data); }
  async requestCancellation(data: any) { this.add("execution.cancelled", data); }
  async readExternalEffects() { return this.effects; }
  async openCompensation(data: any) { this.add("compensation.opened", data); return { compensationId: "compensation-1" }; }
}

function fixtureOptions(runtime: Awaited<ReturnType<typeof syntheticAiko>>, contract: SyntheticContract) {
  const account = { id: "fixed-account", provider: "xai", generation: "credential-7", credential: { name: "XAI_API_KEY", value: "ACCOUNT-SECRET" } };
  return {
    contract, purpose: "deploy-aiko", audience: "smithers",
    pins: { limbDigest: DIGEST("c"), cellPackageDigest: DIGEST("d"), workflowDigest: DIGEST("e") },
    childPolicy: { effectScopes: ["send:webhook"], resourceScopes: ["resource:roster"], maxEffects: 1 },
    spawn: { workspaceRoot: runtime.workspace, runtimeEnv: { PATH: `${runtime.bin}${path.delimiter}${process.env.PATH}`, LANG: "C" }, account, agent: { model: "grok-code-fast-1" } },
    childSpawn: { account, agent: { model: "grok-code-fast-1" } },
  };
}

async function calls(runtime: Awaited<ReturnType<typeof syntheticAiko>>) {
  if (!existsSync(runtime.invocations)) return [];
  const body = await readFile(runtime.invocations, "utf8");
  return body.trim().split("\n").filter(Boolean).map(JSON.parse);
}

function ready(contract: SyntheticContract) { contract.authorPinnedCell(); contract.admitAndAttachLimb(); contract.pinCell(); }

describe("installed recursive capability organism fixture", () => {
  test("authors a pinned Cell and delegates one least-authority cited child through the admitted public surface", async () => {
    const runtime = await syntheticAiko();
    const contract = new SyntheticContract(path.join(runtime.dir, "contract.json"));
    ready(contract);
    const agent = createContractAikoAgent(fixtureOptions(runtime, contract));
    const result = await agent.launchFromHook({ deliveryId: "delivery-1", tenant: "attacker", account: "attacker-account", transcript: "attacker-transcript", globalMemory: "attacker-memory" });

    expect(result).toMatchObject({ status: "settled", rootId: "root-contract", occurrenceId: "occ-parent", executionId: "exec-parent", childOccurrenceId: "occ-child", childExecutionId: "exec-child" });
    expect(contract.issued.effectScopes).toEqual(["send:webhook"]);
    expect(contract.issued.resourceScopes).toEqual(["resource:roster"]);
    expect(contract.issued.maxEffects).toBe(1);
    expect(contract.issued.citationIds).toEqual([DIGEST("a")]);
    expect(contract.issued).not.toHaveProperty("transcript");
    expect(contract.issued).not.toHaveProperty("account");
    expect(contract.issued).not.toHaveProperty("globalMemory");

    const spawned = await calls(runtime);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].prompt).toBe(`Purpose: deploy-aiko\nDelegated citations: ${DIGEST("a")}`);
    expect(spawned[1].prompt).not.toContain("RESULT-THAT-MUST-NOT-BE-COPIED");
    const durable = await readFile(contract.file, "utf8");
    for (const forbidden of ["attacker-account", "attacker-transcript", "attacker-memory", "ACCOUNT-SECRET", "RESULT-THAT-MUST-NOT-BE-COPIED"]) expect(durable).not.toContain(forbidden);

    contract.revokeLimb();
    await expect(agent.launchFromHook({ deliveryId: "after-revoke" })).rejects.toThrow("pinned limb is not admitted and attached");
  });

  test("mutation falsifiers refuse direct pre-admission use, leaked context, shared identity, and widened authority", async () => {
    let runtime = await syntheticAiko();
    let contract = new SyntheticContract(path.join(runtime.dir, "not-admitted.json"));
    contract.authorPinnedCell(); contract.pinCell();
    await expect(createContractAikoAgent(fixtureOptions(runtime, contract)).launchFromHook({ deliveryId: "bypass" })).rejects.toThrow("not admitted and attached");

    for (const mutation of ["leak-transcript", "leak-account", "leak-global-memory", "same-child", "widen-authority"] as Mutation[]) {
      runtime = await syntheticAiko(); contract = new SyntheticContract(path.join(runtime.dir, `${mutation}.json`), mutation); ready(contract);
      const attempt = createContractAikoAgent(fixtureOptions(runtime, contract)).launchFromHook({ deliveryId: mutation });
      await expect(attempt).rejects.toThrow(mutation.startsWith("leak-") ? "forbidden context field" : mutation === "same-child" ? "distinct occurrence/execution" : "widened or moved");
    }
  });

  test("queued and executing cancellation fence child creation; after-send cancellation opens compensation", async () => {
    let runtime = await syntheticAiko();
    let contract = new SyntheticContract(path.join(runtime.dir, "queued.json")); ready(contract);
    let agent = createContractAikoAgent(fixtureOptions(runtime, contract));
    const queued = await agent.enqueueFromHook({ deliveryId: "queued" });
    expect(await agent.cancel(queued.occurrenceId, "queued-test")).toEqual({ status: "cancelled", phase: "queued" });
    expect(await queued.completion).toMatchObject({ status: "cancelled", phase: "queued" });
    expect(await calls(runtime)).toHaveLength(0);
    expect(contract.rows.some((row) => row.type === "delegation.issued")).toBe(false);

    runtime = await syntheticAiko(3000); contract = new SyntheticContract(path.join(runtime.dir, "executing.json")); ready(contract);
    agent = createContractAikoAgent(fixtureOptions(runtime, contract));
    contract.onBegin = async () => { setTimeout(() => void agent.cancel("occ-parent", "executing-test"), 30); };
    expect(await agent.launchFromHook({ deliveryId: "executing" })).toMatchObject({ status: "cancelled", phase: "executing" });
    expect((await calls(runtime)).length).toBeLessThanOrEqual(1);
    expect(contract.rows.some((row) => row.type === "delegation.issued")).toBe(false);

    runtime = await syntheticAiko(); contract = new SyntheticContract(path.join(runtime.dir, "after-send.json")); ready(contract);
    agent = createContractAikoAgent(fixtureOptions(runtime, contract));
    expect((await agent.launchFromHook({ deliveryId: "after-send" })).status).toBe("settled");
    contract.send("effect-7");
    expect(await agent.cancel("occ-parent", "after-send-test")).toEqual({ status: "compensating", compensationId: "compensation-1" });
    expect(contract.rows.filter((row) => row.type === "execution.cancelled")).toHaveLength(0);
    expect(contract.rows.find((row) => row.type === "compensation.opened")?.effectIds).toEqual(["effect-7"]);
    expect(await calls(runtime)).toHaveLength(2);
  });
});
