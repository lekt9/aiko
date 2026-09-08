import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { createBunHost } from "tardie/bun/host";
import { scanLearningSources, verifyLearningOrigin, learningEventDigest, LEARNING_ORIGIN_POLICY } from "../src/learning-origin.ts";
import type { MemoryBinding } from "../src/memory.ts";
import { harnessDigest } from "../src/harness-library.ts";

test("source scanner binds native rows, separate duplicate occurrences and bounded windows beyond 800", async () => {
  const dir = await mkdtemp("/tmp/learning-origin-");
  const host = await createBunHost({database:join(dir,"actor.sqlite"),actorName:"aiko",actorInstance:"origin",actorFor:()=>actor({name:"aiko",methods:{},components:[]})});
  try {
    const self = parseThreadAddress(host.self("user-123"));
    await host.commitRoot(host.self(self.thread),{type:"FixtureRoot",at:1});
    // Scanner fixture facts only; these are not evidence of actual harness promotion.
    const cause = {type:"AikoHarnessPromoted",owner:"123",id:"same-cause",at:1,privatePayload:"PRIVATE_ORIGIN_PAYLOAD"};
    await host.seed(self.thread,Array.from({length:850},(_,i)=>i===66||i===820 ? cause : {type:"FixtureNoise",at:1,index:i}));
    const binding: MemoryBinding = {stateDir:dir,owner:"123",thread:self.thread,redact:s=>s,readPage:(a,n)=>host.readPage(self.thread,a,n)};
    const cut=(await host.readPage(self.thread,0,1000)).at(-1)!.seq;
    let after=0; const origins=[]; let pages=0;
    while(after<cut) {
      const result=await scanLearningSources(binding,self,after,new AbortController().signal,cut);
      expect(result.status).toBe("advanced"); expect(result.through-after).toBeLessThanOrEqual(64);
      const rows=await host.readPage(self.thread,after,64);
      for(const origin of result.origins) {
        const source=rows.find(r=>r.seq===origin.sequence)!;
        expect(source).toBeDefined(); expect(origin.eventDigest).toBe(learningEventDigest(source.event));
        expect(origin.window).toEqual({after,through:result.through,digest:harnessDigest(rows.map(r=>[r.seq,learningEventDigest(r.event)]))});
        expect(origin.projectionVersion).toBe(LEARNING_ORIGIN_POLICY); expect(origin.source).toEqual(self);
      }
      origins.push(...result.origins); after=result.through; pages++;
    }
    expect(pages).toBe(14); expect(origins).toHaveLength(2);
    const retained = await host.readPage(self.thread,0,1000);
    expect(origins.map(o=>o.sequence)).toEqual(retained.filter(r=>r.event.type==="AikoHarnessPromoted").map(r=>r.seq));
    expect(origins[0]!.eventDigest).toBe(origins[1]!.eventDigest);
    expect(JSON.stringify(origins)).not.toContain("PRIVATE_ORIGIN_PAYLOAD");
    for(const missing of [11,65]) {
      const broken={...binding,readPage:async(a:number,n:number)=>(await binding.readPage(a,n)).filter(r=>r.seq!==missing)};
      const result=await scanLearningSources(broken,self,0,new AbortController().signal,cut);
      // Interior and lookahead gaps must both block the entire window.
      if(missing===65) {
        const changed={...binding,readPage:async(a:number,n:number)=>(await binding.readPage(a,n)).map(r=>r.seq===65?{...r,seq:66}:r)};
        const bad=await scanLearningSources(changed,self,0,new AbortController().signal,cut);
        expect(bad.status).toBe("unavailable");expect(bad.through).toBe(0);expect(bad.origins).toEqual([]);
      } else {expect(result.status).toBe("unavailable");expect(result.through).toBe(0);expect(result.origins).toEqual([]);}
    }
    const wrong=await scanLearningSources({...binding,owner:"456"},self,0,new AbortController().signal,cut);
    expect(wrong.reason).toBe("source_binding_invalid");
    const original=origins[0]!;
    expect(await verifyLearningOrigin(binding,self,original,new AbortController().signal)).toBe(true);
    const rejected=[];
    for(const forged of [
      {...original,eventIdentity:"different-cause"},
      {...original,source:{...original.source,instance:"another-instance"}},
      {...original,source:{...original.source,thread:"background-123-indexer"}},
      {...original,window:{...original.window,digest:`sha256:${"0".repeat(64)}`}},
    ]) rejected.push(await verifyLearningOrigin(binding,self,forged,new AbortController().signal));
    console.log("origin tampering accepted [identity,instance,thread,window]:",rejected);
    const changedBytes={...binding,readPage:async(a:number,n:number)=>(await binding.readPage(a,n)).map(r=>r.seq===original.sequence?{...r,event:{...r.event,privatePayload:"CHANGED"}}:r)};
    expect(await verifyLearningOrigin(changedBytes,self,original,new AbortController().signal)).toBe(false);
    // A fixed cut must not chase receipts appended by its own scan.
    await host.seed(self.thread,[{type:"AikoLearningSourceScanned",at:1,id:"late-scan-receipt"}]);
    const exhausted=await scanLearningSources(binding,self,cut,new AbortController().signal,cut);
    console.log("fixed cut observed",{cut,through:exhausted.through});
    const unavailable={...binding,readPage:async()=>[]};
    expect((await scanLearningSources(unavailable,self,0,new AbortController().signal,cut)).status).toBe("unavailable");
    expect((await scanLearningSources(binding,self,0,new AbortController().signal,cut)).status).toBe("advanced");
    expect(rejected).toEqual([false,false,false,false]);
    expect(exhausted.through).toBe(cut);expect(exhausted.origins).toEqual([]);
  } finally {await host.close();await rm(dir,{recursive:true,force:true});}
},30_000);
