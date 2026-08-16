import { describe, expect, test } from "bun:test";
import { createContractLifecycleSurface } from "../src/contractLifecycle.js";
import { routeContractLifecycleRpc } from "../../gateway/src/rpc/contractLifecycle.js";
import { ContractLifecycleClient } from "../../gateway-client/src/ContractLifecycleClient.ts";

function fixture() {
  const commands=[];
  const run={tenantId:"tenant-a",ownerId:"owner-a",contractRoot:"root-1",runId:"run-1",phase:"active",lifecycleGeneration:1,
    pins:["graph","input","cell","credential"].map((kind,i)=>({kind,id:`${kind}-${i}`,digest:`digest-${i}`,generation:1})),
    activeClaims:[{claimId:"uncrossed",crossed:false},{claimId:"crossed",crossed:true}]};
  const contract={
    async read(q){
      if(q.projection==="execution_run") return structuredClone(run);
      if(q.projection==="pin_validity") return {...q,valid:true,tenantId:run.tenantId,runId:run.runId};
      if(q.projection==="capability_generation") return {tenantId:run.tenantId,runId:run.runId,kind:q.kind,id:q.id,generation:4,revoked:false};
      if(q.projection==="settlement_boundary") return {tenantId:run.tenantId,runId:run.runId,settlements:[{settlementId:"s-local",crossed:false},{settlementId:"s-crossed",crossed:true}]};
    },
    async command(c){ commands.push(structuredClone(c)); if(c.next) Object.assign(run,c.next); return {durable:true}; },
  };
  const surface=createContractLifecycleSurface({contract,allocateForkRunId:()=>"run-fork"});
  const context={verifiedTenant:"tenant-a",verifiedOwner:"owner-a",grantedScopes:["run:write"]};
  const gateway={rpcRaw:(method,params)=>routeContractLifecycleRpc(surface,method,context,params)};
  return {run,commands,surface,context,client:new ContractLifecycleClient(gateway)};
}

describe("public Contract lifecycle",()=>{
  test("pause drains crossed claims, parks uncrossed claims, and resume keeps identity after pin readback",async()=>{
    const f=fixture(); const paused=await f.client.pause("run-1",1);
    expect(paused.newClaims).toBe("blocked"); expect(paused.claims).toEqual([{claimId:"uncrossed",instruction:"park"},{claimId:"crossed",instruction:"drain"}]);
    expect(f.run.phase).toBe("paused");
    const resumed=await f.client.resume("run-1",2);
    expect([resumed.contractRoot,resumed.runId,resumed.phase]).toEqual(["root-1","run-1","runnable"]);
    expect(f.commands.map(x=>x.type)).toEqual(["execution.pause","execution.resume"]);
    expect(f.commands[1].revalidatedPins).toHaveLength(4);
  });
  test("cancel, capability CAS revoke, semantic rollback, and operational fork are append-only commands",async()=>{
    const f=fixture();
    const revoked=await f.client.revoke({runId:"run-1",kind:"credential",id:"cred",expectedGeneration:4,reason:"rotated"});
    expect(revoked).toEqual({kind:"credential",id:"cred",generation:5,revoked:true});
    const rollback=await f.client.semanticRollback({runId:"run-1",expectedGeneration:1,targetOccurrenceId:"occ-old",reason:"incorrect-input"});
    expect(rollback.occurrences).toEqual([{kind:"invalidation",targetOccurrenceId:"occ-old",reason:"incorrect-input"},{kind:"compensation",settlementId:"s-crossed",resend:false}]);
    const fork=await f.client.timeTravelFork("run-1",1,7);
    expect(fork).toEqual({contractRoot:"root-1",parentRunId:"run-1",childRunId:"run-fork",frameNo:7});
    expect(f.commands[0]).toMatchObject({type:"capability.revoke",appendOnly:true,expectedGeneration:4,nextGeneration:5});
    expect(f.commands[1]).toMatchObject({type:"execution.semantic_rollback",appendOnly:true,preserveSettlements:true});
    expect(f.commands[2]).toMatchObject({type:"execution.operational_fork",semantics:"operational-only"});
    const cancelled=await f.client.cancel("run-1",1,"operator-stop"); expect(cancelled.phase).toBe("cancelled");
    await expect(f.client.pause("run-1",2)).rejects.toMatchObject({code:"CANCELLED"});
  });
  test("Gateway-derived tenant, owner, and run:write authority fail closed",async()=>{
    const f=fixture();
    for(const context of [
      {verifiedTenant:"tenant-b",verifiedOwner:"owner-a",grantedScopes:["run:write"]},
      {verifiedTenant:"tenant-a",verifiedOwner:"owner-b",grantedScopes:["run:write"]},
      {verifiedTenant:"tenant-a",verifiedOwner:"owner-a",grantedScopes:["run:read"]},
      {userId:"owner-a",scopes:["run:write"]},
    ]) await expect(routeContractLifecycleRpc(f.surface,"contractLifecycle.inspect",context,{runId:"run-1"})).rejects.toBeTruthy();
    expect(f.commands).toHaveLength(0);
  });
});
