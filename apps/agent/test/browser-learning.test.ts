import { expect, test } from "bun:test";
import type { Event } from "tardie/core/log/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { decodeBrowserTraceEvent } from "@unbrowse/browser-harness/trace";
import { learningFromBrowserTrace } from "../src/unbrowse-learning.ts";
import { BrowserEventQueue } from "../src/browser-event-queue.ts";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const entry = (method = "GET") => ({
  startedDateTime: new Date(1_000).toISOString(),
  time: 20,
  _observationComplete: true,
  request: {
    method,
    url: "https://shop.example.com/items?locale=secret-query-sentinel",
    headers: [],
    cookies: [],
  },
  response: {
    status: 200,
    headers: [],
    cookies: [],
    content: {
      mimeType: "application/json",
      size: 60,
      text: '{"items":[{"id":"raw-user-id-sentinel","name":"private-value-sentinel"}]}',
    },
  },
});
const windows = [
  {
    callId: "call-1",
    action: "navigate" as const,
    startedAtMs: 999,
    endedAtMs: 1050,
    direct: true,
    resultObserved: true,
  },
];

test("page-scoped checkpoints exclude siblings and ambiguous traffic without changing live IDs or leaking targets", async () => {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({threadId:"tabs",pageScoped:true,nextSequence:()=>++sequence,emit:async e=>{events.push(e);}});
  const entries = [entry(), entry(), entry()];
  for (const [index,pageTargetId] of [[0,"PAGE_A_SENTINEL"],[1,"PAGE_B_SENTINEL"],[2,undefined]] as const)
    await learning.observe(entries[index]!,index,true,{pageTargetId});
  const scope = (pageTargetId: string) => ({pageTargetId,callIds:new Set(["call-1"])});
  expect((await learning.compile(entries,windows,"https://shop.example.com")).prepared).toBe(0);
  expect((await learning.compile(entries,windows,"https://shop.example.com",scope("PAGE_B_SENTINEL"))).prepared).toBeGreaterThan(0);
  expect(events.findLast(e=>e.type==="NetworkGraphCheckpointPrepared")?.sourceRequestIds).toEqual(["req-0002"]);
  expect((await learning.compile(entries,windows,"https://shop.example.com",scope("PAGE_A_SENTINEL"))).prepared).toBeGreaterThan(0);
  expect(events.findLast(e=>e.type==="NetworkGraphCheckpointPrepared")?.sourceRequestIds).toEqual(["req-0001"]);
  expect(events.filter(e=>e.type==="NetworkFactObserved")).toHaveLength(6); // Unknown ownership is still structural evidence.
  for (const sentinel of ["PAGE_","secret-query-sentinel","raw-user-id-sentinel","private-value-sentinel"])
    expect(JSON.stringify(events)).not.toContain(sentinel);
});

test("observer replacement cannot recycle a live request ID or revive an old tab's capture eligibility", async () => {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({threadId:"observer-restart",pageScoped:true,nextSequence:()=>++sequence,emit:async e=>{events.push(e);}});
  const scope=(pageTargetId:string)=>({pageTargetId,callIds:new Set(["call-1"])});
  await learning.observe(entry(),0,true,{pageTargetId:"old"});
  await learning.compile([entry()],windows,"https://shop.example.com",scope("old"));
  learning.beginObservation();
  await learning.observe(entry(),0,true,{pageTargetId:"new"});
  const before=events.length;
  expect((await learning.compile([entry()],windows,"https://shop.example.com",scope("old"))).prepared).toBe(0);
  expect(events).toHaveLength(before);
  expect((await learning.compile([entry()],windows,"https://shop.example.com",scope("new"))).prepared).toBeGreaterThan(0);
  expect(events.filter(e=>e.type==="NetworkGraphCheckpointPrepared").map(e=>e.sourceRequestIds)).toEqual([["req-0001"],["req-0002"]]);
  expect(events.filter(e=>e.type==="NetworkFactObserved")).toHaveLength(4);
});

test("same-origin sibling command timing cannot authorize a page-scoped read, or hide global clock reversal", async () => {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({threadId:"tab-timing",pageScoped:true,nextSequence:()=>++sequence,emit:async e=>{events.push(e);}});
  await learning.observe(entry(),0,true,{pageTargetId:"page-a"});
  const ownWindow = {...windows[0]!,callId:"own",startedAtMs:0,endedAtMs:20};
  const result = await learning.compile([entry()],[ownWindow,...windows],"https://shop.example.com",{pageTargetId:"page-a",callIds:new Set(["own"])});
  expect(result.prepared).toBe(0);
  expect(result.fallbacks).toMatchObject([{reason:"association_missing"}]);
  const reversed = await learning.compile([entry()],[...windows,ownWindow],"https://shop.example.com",{pageTargetId:"page-a",callIds:new Set(["call-1"])});
  expect(reversed.prepared).toBe(0);
  expect(events.some(e=>e.type==="BrowserNetworkDependencyInferred")).toBe(false);
});

test("a sibling response cannot supply another tab's CSRF producer", async () => {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({threadId:"tab-dependencies",pageScoped:true,nextSequence:()=>++sequence,emit:async e=>{events.push(e);}});
  const upstream = entry(); upstream.request.url="https://shop.example.com/csrf";
  upstream.response.content.text='{"csrf":"PRIVATE_CSRF_SENTINEL"}';
  const downstream = {...entry(), startedDateTime:new Date(1100).toISOString(),
    request:{...entry().request,headers:[{name:"x-csrf-token",value:"PRIVATE_CSRF_SENTINEL"}]}};
  await learning.observe(upstream,0,true,{pageTargetId:"page-a"});
  await learning.observe(downstream,1,true,{pageTargetId:"page-b"});
  const result = await learning.compile([upstream,downstream],[...windows,{...windows[0]!,callId:"b",startedAtMs:1099,endedAtMs:1150}],
    "https://shop.example.com",{pageTargetId:"page-b",callIds:new Set(["b"])});
  expect(result.prepared).toBe(0);
  expect(result.fallbacks).toMatchObject([{reason:"session_requirement_missing",findings:[{location:"request.header.x-csrf-token",code:"session_adapter_required"}]}]);
  expect(events.find(e=>e.type==="NetworkGraphCheckpointPrepared")?.sourceRequestIds).toEqual(["req-0002"]);
  expect(events.some(e=>e.type==="HarDependencyInferred")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_CSRF_SENTINEL");
});

test("background traffic and navigation in one tab cannot exhaust or clear its sibling's capture", async () => {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({threadId:"tab-budget",pageScoped:true,nextSequence:()=>++sequence,emit:async e=>{events.push(e);}});
  const entries = Array.from({length:63}, () => entry());
  await learning.observe(entries[0]!,0,true,{pageTargetId:"page-b"});
  learning.beginNavigation("page-a");
  for (let i=1;i<62;i++) await learning.observe(entries[i]!,i,true,{pageTargetId:"page-a"});
  await learning.observe(entries[62]!,62,true,{pageTargetId:"page-b"});
  expect(events.filter(e=>e.type==="NetworkFactObserved")).toHaveLength(124);
  expect((await learning.compile(entries,windows,"https://shop.example.com",{pageTargetId:"page-b",callIds:new Set(["call-1"])})).prepared).toBeGreaterThan(0);
  expect(events.findLast(e=>e.type==="NetworkGraphCheckpointPrepared")?.sourceRequestIds).toEqual(["req-0001","req-0063"]);
});

test("prepared structural capture survives a process exit during enrichment without retaining response bodies", async () => {
  const dir = await mkdtemp("/tmp/aiko-capture-boundary-");
  const file = join(dir, "events.sqlite");
  const module = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
  const child = `import { Database } from 'bun:sqlite';
    import { BrowserEventQueue } from ${JSON.stringify(module("browser-event-queue"))};
    import { BrowserLearning } from ${JSON.stringify(module("browser-learning"))};
    const db = new Database(${JSON.stringify(file)}), queue = new BrowserEventQueue(db); let sequence = 0;
    const learning = new BrowserLearning({threadId:'process-capture',nextSequence:()=>++sequence,
      emit:async e=>queue.append(e),onPrepared:async()=>process.exit(17)});
    const entry = ${JSON.stringify(entry())};
    await learning.observe(entry,0,true);
    await learning.compile([entry],${JSON.stringify(windows)},'https://shop.example.com');
    process.exit(99);`;
  try {
    const producer = Bun.spawn([process.execPath, "--eval", child], { stdout: "pipe", stderr: "pipe" });
    expect(await producer.exited).toBe(17);
    const db = new Database(file);
    try {
      const queue = new BrowserEventQueue(db), batch = queue.batch();
      const prepared = batch.events.find((e: any) => e.type === "BrowserNetworkToolPrepared");
      expect(decodeBrowserTraceEvent(prepared)?.type).toBe("BrowserNetworkToolPrepared");
      expect(learningFromBrowserTrace(prepared as any)?.kind).toBe("skill");
      expect(JSON.stringify(batch)).not.toContain("private-value-sentinel");
      expect(JSON.stringify(batch)).not.toContain("raw-user-id-sentinel");
      expect(JSON.stringify(batch)).not.toContain("secret-query-sentinel");
      queue.acknowledge(batch.through);
      expect(queue.batch().events).toHaveLength(0);
      expect(db.query("SELECT digest FROM browser_drafts").all().length).toBeGreaterThan(0);
    } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed action preparation persistence propagates and remains retryable without executing a write", async () => {
  const events: Event[] = []; let sequence = 0, reject = true;
  const learning = new BrowserLearning({ threadId: "prepare-retry", nextSequence: () => ++sequence,
    emit: async e => {
      if (e.type === "AikoObservedActionPrepared" && reject) throw Error("Persistence unavailable");
      events.push(e);
    } });
  const get = entry(); get.request.url = "https://api.vendor.com/csrf";
  get.response.content.text = '{"csrf":"fresh"}';
  const post = { ...entry("POST"), startedDateTime: new Date(1100).toISOString(),
    request: { method: "POST", url: "https://api.vendor.com/items", headers: [{ name: "content-type", value: "application/json" }],
      cookies: [{ name: "sid", value: "SECRET_COOKIE" }], postData: { mimeType: "application/json", text: '{"title":"n"}' } },
    response: { ...entry().response, status: 201, content: { mimeType: "application/json", size: 12, text: '{"ok":true}' } } };
  await learning.observe(get, 0, true); await learning.observe(post, 1, true);
  const compile = () => learning.compile([get, post], [{ callId: "call", action: "click", startedAtMs: 1090, endedAtMs: 1150, direct: true, resultObserved: true }], "https://api.vendor.com");
  await expect(compile()).rejects.toThrow("Persistence unavailable");
  expect(events.some(e => e.type === "AikoObservedActionPrepared")).toBe(false);
  reject = false; await compile(); await compile();
  expect(events.filter(e => e.type === "AikoObservedActionPrepared")).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("SECRET_COOKIE");
});

test("a busy first page does not exhaust network learning for subsequent routes", async () => {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({threadId:"multi-page-trace",nextSequence:()=>++sequence,emit:async e=>{events.push(e);}});
  const entries = Array.from({length:62}, (_, i) => ({...entry(),request:{...entry().request,url:`https://shop.example.com/items/${i}`}}));
  for (let i=0;i<61;i++) await learning.observe(entries[i]!,i,true);
  expect(events.filter(e=>e.type==="NetworkFactObserved")).toHaveLength(120);
  learning.beginNavigation();
  await learning.observe(entries[61]!,61,true);
  const compiled = await learning.compile(entries,windows,"https://shop.example.com");
  expect(compiled.prepared).toBeGreaterThan(0);
  const checkpoint = events.findLast(e=>e.type==="NetworkGraphCheckpointPrepared");
  expect(checkpoint?.sourceRequestIds).toEqual(["req-0062"]);
  expect(events.filter(e=>e.type==="NetworkFactObserved")).toHaveLength(122);
});

test("native passive network facts compile owner-local read definitions without leaking query or response values", async () => {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId: "trace-fixture",
    nextSequence: () => ++sequence,
    emit: async (event) => {
      events.push(event);
    },
  });
  const observed = entry();
  await learning.observe(observed, 0, true);
  const result = await learning.compile(
    [observed],
    windows,
    "https://shop.example.com",
  );
  const raw = JSON.stringify(events);
  for (const sentinel of [
    "secret-query-sentinel",
    "raw-user-id-sentinel",
    "private-value-sentinel",
  ])
    expect(raw).not.toContain(sentinel);
  expect(events.some((event) => event.type === "NetworkFactObserved")).toBe(
    true,
  );
  expect(
    events.some((event) => event.type === "NetworkGraphCheckpointPrepared"),
  ).toBe(true);
  expect(result.prepared).toBeGreaterThan(0);
  const prepared = events.find(
    (event) => event.type === "BrowserNetworkToolPrepared",
  )!;
  expect(decodeBrowserTraceEvent(prepared)?.type).toBe(
    "BrowserNetworkToolPrepared",
  );
  expect(learningFromBrowserTrace(prepared)?.kind).toBe("skill");
  const count = events.length;
  expect(
    (await learning.compile([observed], windows, "https://shop.example.com"))
      .prepared,
  ).toBe(0);
  expect(events).toHaveLength(count);
});

test("credential-dependent observed routes remain non-executable and do not become prepared tools", async () => {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId: "trace-sensitive",
    nextSequence: () => ++sequence,
    emit: async (event) => {
      events.push(event);
    },
  });
  const observed = entry();
  observed.request.url += "&access_token=private-access-token-sentinel";
  await learning.observe(observed, 0, true);
  const result = await learning.compile(
    [observed],
    windows,
    "https://shop.example.com",
  );
  expect(result.prepared).toBe(0);
  expect(result.fallbacks?.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain("private-access-token-sentinel");
});

test("incomplete responses and uncorroborated browser windows cannot produce prepared routes", async () => {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId: "trace-incomplete",
    nextSequence: () => ++sequence,
    emit: async (event) => {
      events.push(event);
    },
  });
  const observed = { ...entry(), _observationComplete: false };
  await learning.observe(observed, 0, false);
  expect(
    (await learning.compile([observed], windows, "https://shop.example.com"))
      .prepared,
  ).toBe(0);
  observed._observationComplete = true;
  await learning.observe(observed, 0, true);
  expect(
    (
      await learning.compile(
        [observed],
        windows.map((window) => ({ ...window, resultObserved: false })),
        "https://shop.example.com",
      )
    ).prepared,
  ).toBe(0);
  expect(
    events.some((event) => event.type === "BrowserNetworkToolPrepared"),
  ).toBe(false);
});

test("public document JSON exposes native ambient-header blockers without claiming session readiness", async () => {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId: "trace-ambient",
    nextSequence: () => ++sequence,
    emit: async (event) => {
      events.push(event);
    },
  });
  const observed = {
    ...entry(),
    _resourceType: "Document",
    request: {
      ...entry().request,
      headers: [
        "accept-encoding",
        "accept-language",
        "priority",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-fetch-user",
        "upgrade-insecure-requests",
        "user-agent",
      ].map((name) => ({ name, value: "private-ambient-value-sentinel" })),
    },
  };
  await learning.observe(observed, 0, true);
  const first = await learning.compile(
    [observed],
    windows,
    "https://shop.example.com",
  );
  expect(first.prepared).toBe(0);
  expect(first.fallbacks?.[0]?.reason).toBe("unresolved_finding");
  expect(first.fallbacks?.[0]?.findings).toHaveLength(8);
  expect(
    first.fallbacks?.[0]?.findings?.every(
      (finding) => finding.code === "dynamic_value_missing",
    ),
  ).toBe(true);
  expect(first.fallbacks?.[0]?.omittedFindings).toBe(4);

  const repeated = {
    ...observed,
    startedDateTime: new Date(1100).toISOString(),
  };
  await learning.observe(repeated, 1, true);
  const second = await learning.compile(
    [observed, repeated],
    [
      ...windows,
      { ...windows[0]!, callId: "call-2", startedAtMs: 1099, endedAtMs: 1150 },
    ],
    "https://shop.example.com",
  );
  expect(second.prepared).toBe(0);
  expect(second.fallbacks?.[0]?.reason).toBe("session_requirement_missing");
  expect(
    second.fallbacks?.[0]?.findings?.some(
      (finding) => finding.code === "session_adapter_required",
    ),
  ).toBe(true);
  expect(JSON.stringify([events, first, second])).not.toContain(
    "private-ambient-value-sentinel",
  );
  expect(
    events.some((event) => event.type === "BrowserNetworkToolPrepared"),
  ).toBe(false);
});

test("approved implicit browser adapter preserves ambient evidence and explicit resolution requirements", async()=>{
 const observed=entry() as any;
 observed.request.headers=[{name:"accept",value:"application/json"},{name:"cookie",value:"sid=private-session-sentinel"},{name:"accept-language",value:"en-US"},{name:"sec-fetch-site",value:"same-origin"}];
 const events:Event[]=[];let sequence=0;
 const learning=new BrowserLearning({threadId:"session-test",nextSequence:()=>++sequence,emit:async e=>{events.push(e)},browserSession:origin=>({id:"implicit-browser-session-v1",origin})});
 await learning.observe(observed,0,true);
 const repeated={...observed,startedDateTime:new Date(1100).toISOString()};await learning.observe(repeated,1,true);
 const result=await learning.compile([observed,repeated],[...windows,{...windows[0]!,callId:"two",startedAtMs:1099,endedAtMs:1150}],"https://shop.example.com");
 expect(result.prepared).toBeGreaterThan(0);
 const prepared=events.filter(e=>e.type==="BrowserNetworkToolPrepared");
 expect((prepared[0]!.definition as any).sessionRequirements).toEqual(["implicit-browser-session-v1"]);
 expect(events.some(e=>e.type==="AikoBrowserSessionFindingResolved"&&e.location==="request.header.cookie")).toBe(true);
 expect(JSON.stringify(events)).toContain("accept-language");expect(JSON.stringify(events)).not.toContain("private-session-sentinel");
});

test("implicit browser adapter never resolves application authorization headers",async()=>{
 const observed=entry() as any;observed.request.headers=[{name:"authorization",value:"Bearer private-auth-sentinel"}];
 let sequence=0;const learning=new BrowserLearning({threadId:"auth-test",nextSequence:()=>++sequence,emit:async()=>{},browserSession:origin=>({id:"implicit-browser-session-v1",origin})});
 await learning.observe(observed,0,true);expect((await learning.compile([observed],windows,"https://shop.example.com")).prepared).toBe(0);
});
