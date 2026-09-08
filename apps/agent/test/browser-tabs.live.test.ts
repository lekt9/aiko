import {expect,spyOn,test} from "bun:test";
import {browserDriverFactory} from "../src/browser-driver.ts";
import {BrowserLearning} from "../src/browser-learning.ts";

// Public read-only smoke, no model/provider credentials or personal profile.
// AIKO_TAB_TEST_BROWSER=/absolute/path/to/chrome bun test test/browser-tabs.live.test.ts
const executable=process.env.AIKO_TAB_TEST_BROWSER;
test.skipIf(!executable)("real pinned browser keeps same-origin task pages separate and preserves the sibling after close",async()=>{
  const pages=new Map<string,string>(), requestPages=new Map<number,string|undefined>();
  const calls=new Map<string,Set<string>>(), checkpoints: string[][]=[];
  const observe=BrowserLearning.prototype.observe, compile=BrowserLearning.prototype.compile;
  const observer=spyOn(BrowserLearning.prototype,"observe").mockImplementation(async function(this: BrowserLearning,entry,index,complete,source) {
    const url=new URL((entry.request as {url:string}).url), task=url.searchParams.get("task");
    if(task) {
      expect(source?.pageTargetId).toBeString();
      if(pages.has(task)) expect(source?.pageTargetId).toBe(pages.get(task));
      pages.set(task,source!.pageTargetId!);
    }
    requestPages.set(index,source?.pageTargetId);
    return observe.call(this,entry,index,complete,source);
  });
  const compiler=spyOn(BrowserLearning.prototype,"compile").mockImplementation(async function(this: BrowserLearning,entries,windows,origin,scope) {
    expect(scope?.pageTargetId).toBeString();
    const owned=calls.get(scope!.pageTargetId)??new Set<string>();
    for(const call of scope!.callIds) owned.add(call);
    calls.set(scope!.pageTargetId,owned);
    return compile.call(this,entries,windows,origin,scope);
  });
  let driver: Awaited<ReturnType<ReturnType<typeof browserDriverFactory>>> | undefined;
  const signal=AbortSignal.timeout(45000);
  try {
    driver=await browserDriverFactory(executable!)({owner:"task_tabs_canary",domains:["example.com"],emit:async(event)=>{
      if((event as any).type!=="NetworkGraphCheckpointPrepared")return;
      const targets=(event as {sourceRequestIds:string[]}).sourceRequestIds.map(id=>requestPages.get(Number(id.slice(4))-1));
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.every(target=>typeof target==="string")).toBe(true);
      expect(new Set(targets).size).toBe(1);
      checkpoints.push(targets as string[]);
    }});
    const a=await driver.forTab!("a"),b=await driver.forTab!("b");
    const navigations=await Promise.allSettled([
      a.execute({action:"navigate",url:"https://example.com/?task=a"},signal),
      b.execute({action:"navigate",url:"https://example.com/?task=b"},signal),
    ]);
    for(const navigation of navigations)if(navigation.status==="rejected")throw navigation.reason;
    expect(await a.execute({action:"url"},signal)).toMatchObject({url:"https://example.com/?task=a"});
    expect(await b.execute({action:"url"},signal)).toMatchObject({url:"https://example.com/?task=b"});
    await a.close();
    expect(await b.execute({action:"url"},signal)).toMatchObject({url:"https://example.com/?task=b"});
    await b.close();
    const replacement=await driver.forTab!("replacement");
    await replacement.execute({action:"navigate",url:"https://example.com/?task=new"},signal);
    expect(await replacement.execute({action:"url"},signal)).toMatchObject({url:"https://example.com/?task=new"});
    expect(new Set(pages.values()).size).toBe(3);
    expect(pages.size).toBe(3);
    for(const target of pages.values()) {
      expect(checkpoints.some(checkpoint=>checkpoint[0]===target)).toBe(true);
      expect(calls.get(target)!.size).toBeGreaterThan(0);
      for(const [sibling,ids] of calls) if(sibling!==target)
        expect([...calls.get(target)!].some(id=>ids.has(id))).toBe(false);
    }
  }finally{try{await driver?.close();}finally{observer.mockRestore();compiler.mockRestore();}}
},60000);
