import { expect, test } from "bun:test";
import type { Event } from "tardie/core/log/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { decodeBrowserTraceEvent } from "@unbrowse/browser-harness/trace";
import { learningFromBrowserTrace } from "../src/unbrowse-learning.ts";

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
