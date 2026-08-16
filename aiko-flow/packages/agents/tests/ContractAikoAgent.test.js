import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContractAikoAgent } from "../src/ContractAikoAgent.js";

const D = (c) => c.repeat(64);
const scratch = [];
afterEach(async () => Promise.all(scratch.splice(0).map((p) => rm(p, { recursive: true, force: true }))));

async function runtime({ delayMs = 0 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "contract-aiko-")); scratch.push(dir);
  const workspace = path.join(dir, "workspace"), bin = path.join(dir, "bin"), invocations = path.join(dir, "invocations.jsonl");
  await mkdir(workspace); await mkdir(bin);
  const executable = path.join(bin, "aiko");
  await writeFile(executable, `#!/usr/bin/env node
const fs=require("node:fs");
const promptAt=process.argv.indexOf("--single"); const prompt=process.argv[promptAt+1]||"";
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({prompt,env:process.env,argv:process.argv.slice(2)})+"\\n");
setTimeout(()=>{process.stdout.write(JSON.stringify({type:"text",data:"completed:"+prompt})+"\\n");process.stdout.write(JSON.stringify({type:"end",sessionId:"s",usage:{}})+"\\n");}, ${delayMs});
`); await chmod(executable, 0o755);
  return { dir, workspace, bin, invocations };
}

class DurableContract {
  constructor(file) { this.file=file; this.rows=[]; this.effects=[]; this.next=1; this.write(); }
  write() { writeFileSync(this.file, JSON.stringify({ rows:this.rows, effects:this.effects })); }
  add(type, data={}) { this.rows.push({ ordinal:this.next++, type, ...data }); this.write(); }
  async authenticateHook(request) {
    this.add("hook.authenticated", { deliveryId:request.deliveryId });
    return { authenticatedSubject:"hook-subject", tenant:"tenant-a", grantedScopes:["context.read","deploy-aiko","send:webhook","resource:roster"], credentialGeneration:"generation-7", verificationEvidence:{ citationId:D("9") } };
  }
  async acceptHook(x) { this.add("occurrence.accepted",x); queueMicrotask(()=>this.onAccepted?.()); return { rootId:"root-1", occurrenceId:"occ-parent", executionId:"exec-parent", effectScopes:["send:webhook","admin"], resourceScopes:["resource:roster","resource:all"], maxEffects:2, readOnly:false }; }
  async readPurposeContext(q) { this.add("context.read",q); return { sourceVersion:7, items:[{ field:"roster", value:"cas:roster-v3", citationId:D("a"), commitOrdinal:4 }] }; }
  async readAdmittedLimb({digest}) { return { status:"admitted", digest, attachmentGeneration:3 }; }
  async readPinnedCellWorkflow(x) { return { status:"pinned", ...x }; }
  async beginExecution(x) { this.add("execution.started",x); await this.onBegin?.(); }
  async issueDelegation(x) { this.issued=x; this.add("delegation.issued",x); return { grantId:D("b") }; }
  async adoptDelegation() { return { rootId:"root-1", parentOccurrenceId:"occ-parent", occurrenceId:"occ-child", executionId:"exec-child", effectScopes:this.issued.effectScopes, resourceScopes:this.issued.resourceScopes, citationIds:this.issued.citationIds, maxEffects:this.issued.maxEffects, readOnly:this.issued.readOnly, credentialGeneration:this.issued.credentialGeneration }; }
  async runDelegatedChild(binding, invoke) { this.childBinding=binding; this.add("child.adopted",binding); return invoke(); }
  async recordExecutionEvidence(x) { this.evidence=x; this.add("execution.evidence",x); }
  async requestCancellation(x) { this.add("execution.cancelled",x); }
  async readExternalEffects() { return this.effects; }
  async openCompensation(x) { this.add("compensation.opened",x); return { compensationId:"comp-1" }; }
  send(effectId="effect-1") { this.effects.push({effectId}); this.add("effect.sent",{effectId}); }
}

function options(r, contract) {
  const account={ id:"operations-1", provider:"xai", generation:"generation-7", credential:{name:"XAI_API_KEY",value:"only-secret"} };
  return {
    contract, purpose:"deploy-aiko", audience:"smithers",
    pins:{ limbDigest:D("c"), cellPackageDigest:D("d"), workflowDigest:D("e") },
    childPolicy:{ effectScopes:["send:webhook"], resourceScopes:["resource:roster"], maxEffects:1 },
    spawn:{ workspaceRoot:r.workspace, runtimeEnv:{PATH:`${r.bin}${path.delimiter}${process.env.PATH}`,LANG:"C"}, account, agent:{model:"grok-code-fast-1"} },
    childSpawn:{ account, agent:{model:"grok-code-fast-1"} },
  };
}

async function invocations(r) {
  if (!existsSync(r.invocations)) return [];
  return (await readFile(r.invocations,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

describe("ContractAikoAgent organism", () => {
  test("authenticated empty-state hook pins capability/Cell and runs one bounded child", async () => {
    const r=await runtime(), contract=new DurableContract(path.join(r.dir,"contract.json"));
    const agent=createContractAikoAgent(options(r,contract));
    const result=await agent.launchFromHook({deliveryId:"delivery-1",tenant:"attacker",account:{provider:"openai"},rootId:"fake"});
    expect(result.status).toBe("settled");
    expect(result.rootId).toBe("root-1");
    expect(result.childOccurrenceId).toBe("occ-child");
    expect(result.childExecutionId).toBe("exec-child");
    expect(contract.issued.effectScopes).toEqual(["send:webhook"]);
    expect(contract.issued.resourceScopes).toEqual(["resource:roster"]);
    expect(contract.issued.maxEffects).toBe(1);
    expect(contract.issued.citationIds).toEqual([D("a")]);
    expect(contract.childBinding).toEqual({grantId:D("b"),rootId:"root-1",occurrenceId:"occ-child",executionId:"exec-child",citationIds:[D("a")]});
    const calls=await invocations(r);
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toContain(`roster=cas:roster-v3 [citation:${D("a")}]`);
    expect(calls[1].prompt).toBe(`Purpose: deploy-aiko\nDelegated citations: ${D("a")}`);
    expect(calls[1].prompt).not.toContain("completed:");
    for (const call of calls) {
      expect(call.argv).not.toContain("bypassPermissions");
      expect(call.env.HOME).toBeUndefined(); expect(call.env.OPENAI_API_KEY).toBeUndefined();
      expect(call.env.XAI_API_KEY).toBe("only-secret"); expect(call.env.AIKO_ACCOUNT_ID).toBe("operations-1");
    }
    const persisted=JSON.parse(readFileSync(contract.file,"utf8"));
    expect(JSON.stringify(persisted)).not.toContain("only-secret");
    expect(JSON.stringify(persisted)).not.toContain("completed:");
  });

  test("fails closed on context leakage, moved pins, widened adoption and account-generation mutation", async () => {
    const r=await runtime();
    let c=new DurableContract(path.join(r.dir,"c1.json")); c.readPurposeContext=async()=>({sourceVersion:1,items:[{field:"transcript",value:"secret",citationId:D("a"),commitOrdinal:1}]});
    await expect(createContractAikoAgent(options(r,c)).launchFromHook({deliveryId:"x"})).rejects.toThrow("forbidden context");
    c=new DurableContract(path.join(r.dir,"c2.json")); c.readAdmittedLimb=async({digest})=>({status:"compiled",digest,attachmentGeneration:1});
    await expect(createContractAikoAgent(options(r,c)).launchFromHook({deliveryId:"x"})).rejects.toThrow("not admitted");
    c=new DurableContract(path.join(r.dir,"c3.json")); const original=c.adoptDelegation.bind(c); c.adoptDelegation=async()=>({...await original(),effectScopes:["admin"]});
    await expect(createContractAikoAgent(options(r,c)).launchFromHook({deliveryId:"x"})).rejects.toThrow("widened");
    c=new DurableContract(path.join(r.dir,"c4.json")); const o=options(r,c); o.childSpawn.account={...o.childSpawn.account,generation:"generation-8"};
    expect(()=>createContractAikoAgent(o)).toThrow("fixed parent account/provider generation");
  });

  test("public cancellation fences queued and executing work before any child", async () => {
    let r=await runtime(), c=new DurableContract(path.join(r.dir,"queued.json")), agent=createContractAikoAgent(options(r,c));
    const handle=await agent.enqueueFromHook({deliveryId:"queued"});
    const cancelled=await agent.cancel(handle.occurrenceId,"queued-test");
    expect(cancelled).toMatchObject({status:"cancelled",phase:"queued"});
    const queued=await handle.completion;
    expect(queued).toMatchObject({status:"cancelled",phase:"queued"});
    expect(existsSync(r.invocations)).toBe(false);

    r=await runtime({delayMs:5000}); c=new DurableContract(path.join(r.dir,"executing.json")); agent=createContractAikoAgent(options(r,c));
    c.onBegin=async()=>{ setTimeout(()=>agent.cancel("occ-parent","executing-test"),50); };
    const executing=await agent.launchFromHook({deliveryId:"executing"});
    expect(executing).toMatchObject({status:"cancelled",phase:"executing"});
    const calls=await invocations(r); expect(calls.length).toBeLessThanOrEqual(1);
    expect(c.rows.some(x=>x.type==="execution.started")).toBe(true);
    expect(c.rows.some(x=>x.type==="delegation.issued")).toBe(false);
  });

  test("cancellation after external send opens compensation and never records cancellation", async () => {
    const r=await runtime(), c=new DurableContract(path.join(r.dir,"sent.json")), agent=createContractAikoAgent(options(r,c));
    const settled=await agent.launchFromHook({deliveryId:"sent"}); expect(settled.status).toBe("settled");
    c.send("effect-7");
    const cancelled=await agent.cancel("occ-parent","after-send");
    expect(cancelled).toEqual({status:"compensating",compensationId:"comp-1"});
    const opened=c.rows.find(x=>x.type==="compensation.opened"); expect(opened.effectIds).toEqual(["effect-7"]);
    expect(c.rows.filter(x=>x.type==="execution.cancelled")).toHaveLength(0);
    expect(await invocations(r)).toHaveLength(2);
  });
});
