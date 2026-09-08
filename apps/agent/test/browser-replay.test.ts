import { expect, test } from "bun:test";
import { replayBrowserRequest, readBrowserConnectionPage } from "../src/browser-driver.ts";
import {
  replayKeys,
  wrapReplay,
  unwrapReplay,
  openReplay,
  sealReplay,
} from "../src/codegraff.ts";
import type { HarnessTransportRequest } from "@unbrowse/browser-harness/harness-runtime";
const request = (
  url = "https://api.vendor.com/items",
): HarnessTransportRequest => ({
  stepId: "items",
  attempt: 1,
  method: "GET",
  url,
  headers: {},
  redirect: "manual",
});

test("transient VM envelopes hide request and response values; restart and tampering fail closed", () => {
  const keys = replayKeys();
  const wrapped = wrapReplay(
    { url: "https://api.vendor.com/items?id=PRIVATE_INPUT" },
    keys.publicKey,
  );
  expect(JSON.stringify(wrapped.envelope)).not.toContain("PRIVATE_INPUT");
  const opened = unwrapReplay(wrapped.envelope, keys.privateKey);
  expect(opened.value.url).toContain("PRIVATE_INPUT");
  const result = sealReplay({ body: { name: "PRIVATE_RESPONSE" } }, opened.key);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_RESPONSE");
  expect(openReplay(result, wrapped.key).body.name).toBe("PRIVATE_RESPONSE");
  expect(() =>
    unwrapReplay(wrapped.envelope, replayKeys().privateKey),
  ).toThrow();
  expect(() =>
    openReplay(
      { ...result, tag: Buffer.alloc(16).toString("base64") },
      wrapped.key,
    ),
  ).toThrow();
});

test("trusted browser transport rejects off-origin, private URLs, mutations and supplied credential values before CDP", async () => {
  for (const item of [
    request("https://other.vendor.com/items"),
    request("http://127.0.0.1/items"),
    { ...request(), method: "POST" as const },
    { ...request(), headers: { authorization: "private" } },
    { ...request(), body: { private: "value" } },
  ])
    await expect(
      replayBrowserRequest("invalid", "https://api.vendor.com", item),
    ).rejects.toThrow();
});

test("fixed CDP replay targets one current owned page and returns response only transiently", async () => {
  const calls: any[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const call = JSON.parse(String(raw));
        calls.push(call);
        const result =
          call.method === "Target.getTargets"
            ? {
                targetInfos: [
                  {
                    type: "page",
                    targetId: "page-1",
                    url: "https://api.vendor.com/",
                  },
                ],
              }
            : call.method === "Target.attachToTarget"
              ? { sessionId: "session-1" }
              : {
                  result: {
                    value: {
                      status: 200,
                      headers: {},
                      classification: "application",
                      body: { name: "TRANSIENT_ONLY" },
                    },
                  },
                };
        ws.send(JSON.stringify({ id: call.id, result }));
      },
    },
  });
  try {
    const result = await replayBrowserRequest(
      `ws://127.0.0.1:${server.port}/devtools/browser/fixture`,
      "https://api.vendor.com",
      request(),
    );
    expect(result.body).toEqual({ name: "TRANSIENT_ONLY" });
    const evaluation = calls.find((c) => c.method === "Runtime.evaluate");
    expect(evaluation.sessionId).toBe("session-1");
    expect(evaluation.params.expression).toContain('credentials:"same-origin"');
    expect(evaluation.params.expression).toContain('redirect:"manual"');
    expect(evaluation.params.expression).not.toContain("TRANSIENT_ONLY");
  } finally {
    server.stop(true);
  }
});

const endpoint = process.env.AIKO_REPLAY_TEST_CDP;
test("fixed inherited DOM and accessibility reads bind one origin, exclude input values and reject private forms",async()=>{
 const calls:any[]=[];let privateForm=false,ambiguous=false;
 const server=Bun.serve({port:0,fetch(req,server){if(server.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,raw){
  const call=JSON.parse(String(raw));calls.push(call);
  const page={type:"page",targetId:"owned",url:"https://example.com/page"};
  const result=call.method==="Target.getTargets"?{targetInfos:[page,{...page,targetId:"foreign",url:ambiguous?"https://example.com/other":"https://other.com/"}]}:
    call.method==="Target.attachToTarget"?{sessionId:"owned-session"}:
    call.method==="Accessibility.getFullAXTree"?{nodes:[{role:{value:"heading"},name:{value:"Public heading"}},{role:{value:"textbox"},name:{value:"Input"},value:{value:"PRIVATE_INPUT_VALUE"}},{role:{value:"link"},name:{value:"Projects"}}]}:
    privateForm?{exceptionDetails:{text:"Sign-in context unavailable"}}:
    {result:{value:{url:page.url,title:"Public page",text:"Visible public text",links:["https://example.com/project","https://other.com/foreign"],count:2}}};
  ws.send(JSON.stringify({id:call.id,result}));
 }}});
 try {
  const endpoint=`ws://127.0.0.1:${server.port}/devtools/browser/fixture`;
  const result=await readBrowserConnectionPage(endpoint,"https://example.com",0,undefined,true);
  expect(result).toMatchObject({title:"Public page",links:["https://example.com/project"],snapshot:"heading: Public heading\nlink: Projects"});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_INPUT_VALUE");
  expect(calls.find(call=>call.method==="Accessibility.getFullAXTree").sessionId).toBe("owned-session");
  expect(calls.some(call=>call.method==="Page.navigate")).toBe(false);
  expect(calls.find(call=>call.method==="Runtime.evaluate").params.expression).toContain('input[type="password"]');
  privateForm=true;await expect(readBrowserConnectionPage(endpoint,"https://example.com",0,undefined,true)).rejects.toThrow("unavailable");
  privateForm=false;ambiguous=true;await expect(readBrowserConnectionPage(endpoint,"https://example.com",0,undefined,true)).rejects.toThrow("Ambiguous");
 }finally{server.stop(true);}
});
(endpoint ? test : test.skip)("real Chrome reads navigation links in one DOM batch and excludes sign-out",async()=>{
 const page=await readBrowserConnectionPage(endpoint!,"https://replay-fixture.aiko.ai");
 expect(page.links).toEqual(["https://replay-fixture.aiko.ai/projects","https://replay-fixture.aiko.ai/projects?id=12"]);
 expect(page.linksTruncated).toBe(false);
 expect(page.text).toContain("Project review");
 await expect(readBrowserConnectionPage(endpoint!,"https://replay-fixture.aiko.ai",-1)).rejects.toThrow("offset");
});
(endpoint ? test : test.skip)(
  "real Chromium preserves HttpOnly browser session and blocks redirects/auth failures",
  async () => {
    const origin = "https://replay-fixture.aiko.ai";
    const read = async (path: string) =>
      replayBrowserRequest(endpoint!, origin, request(origin + path));
    expect((await read("/items")).body).toEqual({ item: "fresh-item" });
    expect((await read("/details?item=fresh-item")).body).toEqual({
      name: "TRANSIENT_BROWSER_RESULT",
    });
    expect((await read("/unauthorized")).classification).toBe(
      "browser_session_required",
    );
    await expect(read("/redirect")).rejects.toThrow();
  },
);

(endpoint && process.env.AIKO_REPLAY_TEST_EMBEDDING ? test : test.skip)(
  "live observation auto-indexes locally then semantically searches and rehydrates fresh browser data",
  async () => {
    const { CdpNetworkListener } =
      await import("@unbrowse/browser-harness/network-listener");
    const { BrowserLearning } = await import("../src/browser-learning.ts");
    const { RequestMemory } = await import("../src/request-memory.ts");
    const { createRequestEmbedding } =
      await import("../src/request-embedding.ts");
    const { nodeStorage } = await import("entity-learn");
    const { ownedNetworkDefinitions } =
      await import("../src/capability-builder-network.ts");
    const origin = "https://replay-fixture.aiko.ai",
      events: any[] = [],
      consumed: any[] = [];
    const storage = nodeStorage(":memory:");
    const memory = new RequestMemory({
      owner: "browser_qa",
      storage,
      readOwnedEvents: async () => events,
      embedding: createRequestEmbedding("/tmp/aiko-request-embedding-qa"),
      embedResponseValues: true,
      authorizeSession: async (requirements) =>
        requirements.every((id) => id === "implicit-browser-session-v1"),
      transport: { send: (r) => replayBrowserRequest(endpoint!, origin, r) },
      consume: async (r) => {
        consumed.push(r);
      },
    });
    let sequence = 0,
      indexed = 0;
    const learning = new BrowserLearning({
      browserSession: (origin) => ({
        id: "implicit-browser-session-v1",
        origin,
      }),
      threadId: "browser-qa",
      nextSequence: () => ++sequence,
      emit: async (e) => {
        events.push(e);
      },
      onPrepared: async (e, responses) => {
        await memory.index(e.toolDigest, ["catalog"], responses);
        indexed++;
      },
    });
    const observer = new CdpNetworkListener((entry, index, complete) =>
      learning.observe(entry, index, complete),
    );
    try {
      await observer.connect(endpoint!);
      const startedAtMs = Date.now();
      const first = await replayBrowserRequest(
        endpoint!,
        origin,
        request(origin + "/items"),
      );
      await replayBrowserRequest(
        endpoint!,
        origin,
        request(origin + "/details?item=" + first.body.item),
      );
      const endedAtMs = Date.now();
      const entries = await observer.stopAndSnapshot();
      await learning.compile(
        entries,
        [
          {
            callId: "qa",
            action: "navigate",
            startedAtMs,
            endedAtMs,
            direct: true,
            resultObserved: true,
          },
        ],
        origin,
      );
      if (!indexed)
        await Bun.write(
          "artifacts/request-memory/live-pipeline-witness.json",
          JSON.stringify(
            {
              status: "blocked",
              observedRequests: entries.length,
              indexed,
              blockers: events
                .filter((e) => e.type === "AikoBrowserLearningPending")
                .map((e) => ({ reason: e.reason, findings: e.findings })),
            },
            null,
            2,
          ),
        );
      expect(indexed).toBeGreaterThan(0);
      const found = await memory.search("catalog item details");
      expect(found.items.length).toBeGreaterThan(0);
      const definitions = ownedNetworkDefinitions(events);
      const pointer =
        found.items.find((p) => p.requestIds.length === 2) ?? found.items[0]!;
      const definition = definitions.find(
        (d) =>
          JSON.stringify(d.definition.evidence.map((e) => e.requestId)) ===
          JSON.stringify(pointer.requestIds),
      )!.definition;
      const inputs = Object.fromEntries(
        definition.inputs.map((i) => [
          i.name,
          i.name.includes("0001") ? "items" : "details",
        ]),
      );
      const hydrated = await memory.hydrate(pointer.pointerId, inputs);
      expect(hydrated.status).toBe("completed");
      expect(consumed).toHaveLength(1);
      expect(JSON.stringify(memory.memory.exportArchive())).not.toContain(
        "TRANSIENT_BROWSER_RESULT",
      );
      expect(JSON.stringify(hydrated)).not.toContain(
        "TRANSIENT_BROWSER_RESULT",
      );
      await Bun.write(
        "artifacts/request-memory/live-pipeline-witness.json",
        JSON.stringify(
          {
            model: found.model,
            indexed,
            observedRequests: entries.length,
            shortlist: found.items.length,
            status: hydrated.status,
            requests: hydrated.counts.requests,
            consumed: hydrated.consumed,
            responseValuesPersisted: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await observer.stopAndSnapshot().catch(() => {});
      storage.close();
    }
  },
  60000,
);

test("portable workerd transport interoperates with the Bun runner", async () => {
  const {wrapReplayPortable,openReplayPortable}=await import("../src/codegraff.ts");
  const identity=replayKeys();
  const wrapped=await wrapReplayPortable({private:"password-fixture"},identity.publicKey);
  const decoded=unwrapReplay(wrapped.envelope,identity.privateKey);
  expect(decoded.value).toEqual({private:"password-fixture"});
  expect(await openReplayPortable(sealReplay({output:{status:"pending"}},decoded.key),wrapped.key)).toEqual({output:{status:"pending"}});
});
