import { expect, test } from "bun:test";
import { Effect } from "effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { BrowserController } from "../src/browser.ts";
import { BrowserTaskGate, withBrowserTabs } from "../src/browser-tabs.ts";
import type { BrowserDriver } from "../src/browser-driver.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; };
function fixture() {
  let next=0, active=0, destroyed=0, privateCalls=0;
  const closed:number[]=[], calls:number[]=[], gates=new Map<number, ReturnType<typeof deferred>>();
  const driver=withBrowserTabs<{id:number}>({
    execute:async(_action,signal)=>{ const id=active;calls.push(id);await gates.get(id)?.promise;signal?.throwIfAborted();expect(active).toBe(id);return {id}; },
    screenshot:async()=>new Uint8Array([active]),
    nativeAuth:async()=>{privateCalls++;return {status:"pending"} as any;},
    close:async()=>{destroyed++;},
  },{initial:()=>({id:next++}),select:async state=>{active=state.id;},close:async state=>{closed.push(state.id);}});
  return {driver,calls,closed,gates,destroyed:()=>destroyed,privateCalls:()=>privateCalls};
}

test("task tabs are stable, selection and dispatch cannot interleave, and one close preserves siblings",async()=>{
  const f=fixture();try{
    const a=await f.driver.forTab!("a"),b=await f.driver.forTab!("b");expect(await f.driver.forTab!("a")).toBe(a);
    const gate=deferred();f.gates.set(1,gate);
    const first=a.execute({action:"navigate",url:"https://example.com/a"});
    const second=b.execute({action:"navigate",url:"https://example.com/b"});
    await Bun.sleep(5);expect(f.calls).toEqual([1]);gate.resolve();
    expect(await first).toEqual({id:1});expect(await second).toEqual({id:2});
    await a.close();await a.close();expect(f.closed).toEqual([1]);expect(f.destroyed()).toBe(0);
    await expect(a.execute({action:"title"})).rejects.toThrow("closed");
    expect(await b.execute({action:"title"})).toEqual({id:2});
    expect(await f.driver.screenshot!()).toEqual(new Uint8Array([2]));
    await expect(b.execute({action:"tab_switch",tabId:"t1"})).rejects.toThrow("host");
    expect(b.nativeAuth).toBeUndefined();expect(b.installSession).toBeUndefined();
  }finally{await f.driver.close();expect(f.destroyed()).toBe(1);}
});

test("queued cancellation never dispatches and private sign-in invalidates task handles",async()=>{
  const f=fixture();try{
    const a=await f.driver.forTab!("a"),b=await f.driver.forTab!("b"),abort=new AbortController();
    const gate=deferred();f.gates.set(1,gate);
    const first=a.execute({action:"title"}),second=b.execute({action:"title"},abort.signal).catch(error=>error);
    abort.abort();gate.resolve();await first;expect(await second).toBeInstanceOf(Error);expect(f.calls).toEqual([1]);
    await f.driver.nativeAuth!({connectionId:"fixture",domain:"example.com",action:"status"});
    expect(f.closed).toEqual([1,2]);expect(f.privateCalls()).toBe(1);
    await expect(a.execute({action:"title"})).rejects.toThrow("closed");
    expect(await f.driver.forTab!("a")).not.toBe(a);
  }finally{await f.driver.close();}
});

test("runner admission separates task lanes and fences account-wide private operations",()=>{
  const gate=new BrowserTaskGate();const a=gate.acquire("a"),b=gate.acquire("b");
  expect(()=>gate.acquire("a")).toThrow();expect(()=>gate.acquire()).toThrow();expect(()=>gate.acquire("../bad")).toThrow();
  a();a();expect(gate.busy).toBe(true);b();expect(gate.busy).toBe(false);
  const privateLease=gate.acquire();expect(()=>gate.acquire("a")).toThrow();privateLease();expect(gate.busy).toBe(false);
});

test("controller admits concurrent task threads but not overlapping work on the same tab; cleanup is task scoped",async()=>{
  const held=deferred(),entered=deferred();let accounts=0,closed=0;const tabs=new Map<string,BrowserDriver>();
  const controller=new BrowserController({domains:["*"],redact:s=>s,requireInteractionApproval:false,factory:async()=>{
    accounts++;return {execute:async()=>{throw Error("Unscoped action");},close:async()=>{closed++;},forTab:async key=>{
      const driver:BrowserDriver={execute:async action=>{
        if(action.action==="navigate"&&action.url.endsWith("/slow")){entered.resolve();await held.promise;}
        return {tab:key};
      },close:async()=>{tabs.delete(key);}};
      tabs.set(key,driver);return driver;
    }};
  }});
  const run=(thread:string,path:string,signal=new AbortController().signal)=>{
    const tools=controller.codeTools("owner",thread),native=tools.find(t=>t.spec.name==="agent_browser_navigate")!;
    const rows:any[]=[];
    const log={read:Effect.sync(()=>rows),head:Effect.sync(()=>rows.length),readFrom:(n:number)=>Effect.sync(()=>rows.slice(n)),append:(events:readonly any[])=>Effect.sync(()=>{rows.push(...events);})};
    return Effect.runPromise(native.run({url:`https://example.com/${path}`},{turn:"turn",callId:crypto.randomUUID(),signal}).pipe(Effect.provideService(Self,{actor:"aiko",instance:"test",thread}),Effect.provideService(EventLog,log)));
  };
  try{
    const first=run("first","slow");await entered.promise;
    expect(await run("second","fast")).toMatchObject({status:"completed"});
    expect(await run("first","overlap")).toMatchObject({status:"blocked"});
    expect(accounts).toBe(1);expect(controller.status("owner").taskTabs).toBe(2);expect(await controller.retire("owner")).toBe(false);
    held.resolve();expect(await first).toMatchObject({status:"completed"});
    const cancelled=new AbortController();cancelled.abort();await run("second","never",cancelled.signal);
    expect(closed).toBe(0);
  }finally{held.resolve();await controller.close();expect(closed).toBe(1);}
});
