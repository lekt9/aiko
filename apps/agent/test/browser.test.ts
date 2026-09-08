import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  infer,
  tool,
  outputValidateOnce,
  Infer,
  type InferRequest,
} from "tardie";
import { createBunHost } from "tardie/bun/host";
import type { Action } from "tardie/log/events";
import { createHmac } from "node:crypto";
import { createService } from "../src/server.ts";
import {
  publicTarget,
  publicAddress,
  publicIPv4,
  createPublicProxy,
} from "../src/browser-proxy.ts";
import { AgentBrowserClientError, isolatedAgentBrowserEnvironment } from "@unbrowse/browser-harness/client";
import { BrowserController } from "../src/browser.ts";
import { Self } from "tardie/core/runtime";
import type { BrowserDriverFactory } from "../src/browser-driver.ts";
import { voiceAndOutbox, type AikoEvent } from "../src/actor.ts";
import { createVoice } from "../src/voice.ts";
import { request as httpRequest } from "node:http";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const token = "public-test-operator-token-not-a-secret";
const page = "PAGE_BODY_MUST_STAY_TRANSIENT_57493";
const path = "private-browser-path-57493";
const mockModel = (react: (request: InferRequest) => Action) =>
  Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "browser" } }),
    react: (request) => Effect.succeed(react(request)),
  });
const returns = (req: InferRequest) =>
  req.trajectory.filter(
    (e) =>
      e.type === "ToolReturned" &&
      (e as { turn?: string }).turn === req.identity.turn,
  );
test("inherited inspection uses the parent's existing browser and current per-origin grants, cancellation and private gate",async()=>{
  let privateSession=false, pendingLogin=false, credentialsValid=true, opened=0, inspections=0;
  let grant:{scope:"research"|"browser";origins?:string[]}|undefined={scope:"research"};
  let duringRead:(()=>Promise<void>)|undefined;
  const actions:string[]=[];
  const app=await nativeAnswerHost(mockModel(req=>!returns(req).length
    ? {kind:"call",callId:"navigate",name:"agent_browser_navigate",arguments:{url:"https://example.com/page"}}
    : {kind:"complete",output:"Page opened."}),async()=>{
      opened++;
      return {execute:async action=>{actions.push(action.action);return {url:"https://example.com/page"};},close:async()=>{},
        authorizeInspection:async()=>!pendingLogin&&credentialsValid,
        inspectCurrentPage:async(policy,signal)=>{
          inspections++;expect(policy.origin).toBe("https://example.com");
          if(pendingLogin||(policy.publicOnly&&privateSession))throw Error("Private inspection blocked");
          await duringRead?.();signal?.throwIfAborted();
          return {url:"https://example.com/page",title:"Parent page",text:"PUBLIC_TEXT",snapshot:"[link]",links:["https://example.com/one","https://other.com/foreign"],linksTruncated:false};
        }};
    });
  const native=app.browser.workerInspectionTools("123","worker",{parentThread:"user-123",current:async()=>grant})[0]!;
  const invoke=(input:unknown={origin:"https://example.com",publicOnly:grant?.scope!=="browser"},signal=new AbortController().signal,thread="worker")=>Effect.runPromise(native.run(input,{turn:"inspect",callId:crypto.randomUUID(),signal}).pipe(Effect.provideService(Self,{actor:"aiko",instance:"test",thread})));
  expect(await invoke()).toMatchObject({status:"denied"});expect(opened).toBe(0);
  await app.send("parent-open","Open parent page");
  expect(await invoke()).toMatchObject({status:"completed",untrustedPageContent:{text:"PUBLIC_TEXT",links:["https://example.com/one"]}});
  expect(opened).toBe(1);expect(actions).toEqual(["navigate"]);
  for (const [owner,parentThread] of [["456","user-123"],["123","different-parent"]]) {
    const other=app.browser.workerInspectionTools(owner!,"worker",{parentThread:parentThread!,current:async()=>grant})[0]!;
    expect(await Effect.runPromise(other.run({origin:"https://example.com",publicOnly:true},{turn:"inspect",callId:crypto.randomUUID(),signal:new AbortController().signal}).pipe(Effect.provideService(Self,{actor:"aiko",instance:"test",thread:"worker"})))).toMatchObject({status:"denied"});
  }
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  duringRead=async()=>{enter();await gate;};const pending=invoke();await entered;
  const concurrently=inspections;expect(await invoke()).toMatchObject({status:"denied"});expect(inspections).toBe(concurrently);
  release();expect(await pending).toMatchObject({status:"completed"});duringRead=undefined;
  expect(await invoke({origin:"https://example.com",action:"navigate"})).toMatchObject({status:"denied"});
  expect(await invoke({origin:"http://127.0.0.1"})).toMatchObject({status:"denied"});
  expect(await invoke(undefined,undefined,"foreign-thread")).toMatchObject({status:"denied"});
  privateSession=true;expect(await invoke()).toMatchObject({status:"denied"});
  grant={scope:"browser",origins:["https://example.com"]};expect(await invoke()).toMatchObject({status:"completed"});
  pendingLogin=true;expect(await invoke()).toMatchObject({status:"denied"});pendingLogin=false;
  const original={origin:"https://example.com",publicOnly:false};expect(await native.authorizeRetained!(original)).toBe(true);
  credentialsValid=false;expect(await native.authorizeRetained!(original)).toBe(false);credentialsValid=true;
  expect(await invoke({origin:"https://example.com",publicOnly:true})).toMatchObject({status:"denied"});
  grant={scope:"browser",origins:["https://other.com"]};const before=inspections;
  expect(await invoke()).toMatchObject({status:"denied"});expect(inspections).toBe(before);expect(await native.authorizeRetained!(original)).toBe(false);
  grant={scope:"research"};privateSession=false;expect(await native.authorizeRetained!(original)).toBe(false);
  duringRead=async()=>{grant=undefined;};expect(await invoke()).toMatchObject({status:"denied"});
  grant={scope:"research"};const abort=new AbortController();duringRead=async()=>abort.abort();
  expect(await invoke(undefined,abort.signal)).toMatchObject({status:"denied"});
  duringRead=undefined;expect(await invoke()).toMatchObject({status:"completed"});
  await app.browser.retire("123");expect(await invoke()).toMatchObject({status:"denied"});expect(opened).toBe(1);
  expect(await native.authorizeRetained!({origin:"https://example.com",publicOnly:true})).toBe(true);
  grant={scope:"browser",origins:["https://example.com"]};expect(await native.authorizeRetained!(original)).toBe(false);
});
test("browser and request-memory calls in one provider batch keep distinct private inputs and sibling metadata",async()=>{
  const browser=new BrowserController({domains:["*"],factory:async()=>{throw Error("No dispatch expected");},redact:s=>s});
  try {
    const action={kind:"calls" as const,batchId:"provider-batch",calls:[
      {callId:"page-one",name:"agent_browser_navigate",arguments:{url:"https://example.com/private-first"}},
      {callId:"page-two",name:"agent_browser_navigate",arguments:{url:"https://example.com/private-second"}},
      {callId:"search",name:"request_memory_search",arguments:{query:"PRIVATE_INDEX_QUERY"}},
      {callId:"other",name:"ordinary_read",arguments:{count:2}},
    ],usage:{promptTokens:20,completionTokens:8},endpoint:{provider:"fixture",model:"batch"}};
    const layer=browser.inference(mockModel(()=>action),"123");
    const result=await Effect.runPromise(Effect.gen(function*(){return yield* (yield* Infer).react({identity:{actor:"aiko",instance:"test",thread:"user-123",turn:"batch"},trajectory:[],system:"",tools:[]},"same-model-attempt");}).pipe(Effect.provide(layer)));
    expect(result.kind).toBe("calls");if(result.kind!=="calls")throw Error("Missing batch");
    expect(result.calls).toHaveLength(4);expect(new Set(result.calls.map(call=>call.callId)).size).toBe(4);
    expect(new Set(result.calls.slice(0,3).map(call=>(call.arguments as any).request)).size).toBe(3);
    expect(result.calls[3]).toEqual(action.calls[3]);expect(result.usage).toEqual(action.usage);expect(result.endpoint).toEqual(action.endpoint);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_INDEX_QUERY|private-first|private-second/);
  }finally{await browser.close();}
});
async function setup(
  model: Layer.Layer<Infer>,
  factory: BrowserDriverFactory,
  telegram = false,
  toolCallLimit?: number,
) {
  const stateDir = await mkdtemp("/tmp/aiko-browser-test-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const config = {
    mode: "demo" as const,
    port: 4242,
    toolCallLimit,
    stateDir,
    operatorToken: token,
    persona: "fixture",
    voiceEnabled: false,
    allowedUsers: new Set(telegram ? ["123", "456"] : []),
    ...(telegram
      ? {
          botToken: "123:public-telegram-fixture",
          webhookSecret: "public-webhook-fixture-01234567890123456789",
        }
      : {}),
    browser: { executablePath: "/test/host-owned-browser", domains: ["*"] },
  };
  const service = await createService(config, {
    model,
    browserFactory: factory,
    telegramFetch: async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
  });
  cleanup.push(() => service.close());
  const request = (path: string, body?: unknown, auth = token) =>
    service.fetch(
      new Request(`http://127.0.0.1:4242${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: auth.startsWith("tma ") ? auth : `Bearer ${auth}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { service, request };
}
async function waitFor(check: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Condition not reached");
}

async function nativeAnswerHost(
  model: Layer.Layer<Infer>,
  factory: BrowserDriverFactory,
  allowModelAnswers = true,
  redact = (text: string) => text,
) {
  const dir = await mkdtemp("/tmp/aiko-browser-answer-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const browser = new BrowserController({
    domains: ["*"],
    factory,
    redact,
    allowModelAnswers,
    requireInteractionApproval: false,
  });
  cleanup.push(() => browser.close());
  const sent: string[] = [];
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [
      infer([tool(browser.tools("123", "user-123")), outputValidateOnce]),
      voiceAndOutbox(
        "123",
        createVoice({ enabled: false, persona: "fixture" }),
        async (_owner, text) => {
          sent.push(text);
          return { status: "delivered", providerId: String(sent.length) };
        },
        { live: true, redact, browserAnswers: allowModelAnswers },
      ),
    ],
  });
  const host = await createBunHost({
    database: join(dir, "actor.sqlite"),
    actorName: "aiko",
    actorInstance: "test",
    actorFor: () => definition,
    layersFor: () => browser.inference(model, "123"),
    keyOf: (e) =>
      e.type.startsWith("AikoBrowser") && typeof e.id === "string"
        ? `${e.type}:${e.id}`
        : undefined,
  });
  cleanup.push(() => host.close());
  return {
    host,
    browser,
    sent,
    send: async (id: string, text: string) => {
      await host.commitRoot(host.self("user-123"), {
        type: "MessageReceived",
        id,
        text,
        source: "telegram",
        chat: "123",
        at: Date.now(),
      });
      await host.wake("user-123");
    },
  };
}

describe("native production browser answers", () => {
  test("request-memory arguments return to model context without entering durable history", async () => {
    const query="transient pointer query 74589";
    let restored=false;
    const app=await nativeAnswerHost(mockModel(req=>{
      if(!returns(req).length)return {kind:"call",callId:"pointer-search",name:"request_memory_search",arguments:{query}};
      restored=req.trajectory.some(e=>e.type==="ToolCalled"&&e.name==="request_memory_search"&&(e.arguments as any).query===query);
      return {kind:"complete",output:"Pointer search checked."};
    }),async()=>({
      execute:async()=>({}),close:async()=>{},
      requestSearch:async()=>({items:[],model:"fixture",coverage:"complete",reasons:[],scanned:0,sourceVersion:0}),
    }));
    await app.send("pointer-context","Search request memory");
    expect(restored).toBe(true);
    expect(JSON.stringify(await app.host.read("user-123"))).not.toContain(query);
  });

  test("allowModelAnswers delivers the actual redacted answer while raw browser evidence stays transient", async () => {
    const answer = "The observed product costs $9.99. PRIVATE_MODEL_SENTINEL";
    let hydrated = false;
    const app = await nativeAnswerHost(
      mockModel((req) => {
        if (!returns(req).length)
          return {
            kind: "call",
            callId: "lookup",
            name: "agent_browser_navigate",
            arguments: { url: "https://example.com/product" },
          };
        hydrated = JSON.stringify(req.trajectory).includes(page);
        return { kind: "complete", output: answer };
      }),
      async () => ({
        execute: async () => ({ evidence: page }),
        close: async () => {},
      }),
      true,
      (text) => text.replaceAll("PRIVATE_MODEL_SENTINEL", "[REDACTED]"),
    );
    await app.send("production-answer", "Read the product price");
    const log = await app.host.read("user-123");
    expect(hydrated).toBe(true);
    expect(log.find((e) => e.type === "TurnCompleted")?.output).toBe(
      answer.replace("PRIVATE_MODEL_SENTINEL", "[REDACTED]"),
    );
    expect(app.sent).toEqual([
      answer.replace("PRIVATE_MODEL_SENTINEL", "[REDACTED]"),
    ]);
    expect(JSON.stringify(log)).not.toContain(page);
    expect(JSON.stringify(log)).not.toContain("PRIVATE_MODEL_SENTINEL");
    expect(JSON.stringify(log)).not.toContain("Browser receipts are ready");
  });

  for (const allowModelAnswers of [false, true])
    test(`history above 96 KB ${allowModelAnswers ? "retains" : "omits"} transient hydration in ${allowModelAnswers ? "production" : "legacy"} mode`, async () => {
      let hydrated = false,
        historyBytes = 0;
      const app = await nativeAnswerHost(
        mockModel((req) => {
          if (
            !req.trajectory.some(
              (e) =>
                e.type === "MessageReceived" && e.id === "large-history-read",
            )
          )
            return { kind: "complete", output: "Prior context. ".repeat(220) };
          if (!returns(req).length)
            return {
              kind: "call",
              callId: "read-after-history",
              name: "agent_browser_navigate",
              arguments: { url: "https://example.com" },
            };
          const history = JSON.stringify(req.trajectory);
          historyBytes = Buffer.byteLength(history);
          hydrated = history.includes(page);
          return { kind: "complete", output: "The current page was observed." };
        }),
        async () => ({
          execute: async () => ({ evidence: page }),
          close: async () => {},
        }),
        allowModelAnswers,
      );
      // Real completed native conversation turns, not an invented model context or private-state mutation.
      for (let i = 0; i < 24; i++)
        await app.send(`history-${i}`, "Earlier user context. ".repeat(85));
      await app.send(
        "large-history-read",
        "Read this page using the existing conversation context",
      );
      expect(historyBytes).toBeGreaterThan(96_000);
      expect(hydrated).toBe(allowModelAnswers);
      expect(JSON.stringify(await app.host.read("user-123"))).not.toContain(
        page,
      );
      expect(app.sent.at(-1)).toContain(
        allowModelAnswers
          ? "The current page was observed."
          : "Browser navigate completed",
      );
    });

  test("a read rejected before browser startup removes the failed session and preserves infrastructure guidance", async () => {
    let opens = 0;
    const app = await nativeAnswerHost(
      mockModel((req) =>
        returns(req).length
          ? {
              kind: "complete",
              output: "The browser needs operator reconciliation.",
            }
          : {
              kind: "call",
              callId: "read-without-session",
              name: "agent_browser_get_text",
              arguments: { selector: "main" },
            },
      ),
      async () => {
        opens++;
        throw Object.assign(new Error("Uncertain provider allocation"), {
          code: "sandbox_reconciliation_required",
        });
      },
    );
    await app.send("bootstrap-failure", "Inspect the current browser");
    const log = await app.host.read("user-123");
    const result = log.find((e) => e.type === "ToolReturned")?.result as {
      status: string;
      text: string;
    };
    expect(opens).toBe(1);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("operator reconciliation");
    expect(result.text).not.toContain("Successful earlier reads");
    expect(log.some((e) => e.type === "AikoBrowserActionStarted")).toBe(false);
    expect(app.browser.status("123").sessionActive).toBe(false);
  });

  for (const read of ["get_text", "wait"] as const)
  test(`a failed ${read} selector is blocked, retains earlier evidence, and reuses the healthy owner session`, async () => {
    let opens = 0,
      closes = 0,
      priorEvidenceSurvived = false;
    const executed: string[] = [];
    const app = await nativeAnswerHost(
      mockModel((req) => {
        const count = returns(req).length;
        if (count === 2)
          priorEvidenceSurvived = JSON.stringify(req.trajectory).includes(page);
        const calls = [
          {
            name: "agent_browser_navigate",
            arguments: { url: "https://example.com" },
          },
          {
            name: read === "wait" ? "agent_browser_wait_for_selector" : "agent_browser_get_text",
            arguments: { selector: "#missing" },
          },
          { name: "agent_browser_title", arguments: {} },
        ];
        return count < calls.length
          ? { kind: "call", callId: `read-${count}`, ...calls[count]! }
          : {
              kind: "complete",
              output:
                "The title is available; the missing selector returned no evidence.",
            };
      }),
      async () => {
        opens++;
        return {
          execute: async (action) => {
            executed.push(action.action);
            if (action.action === read)
              throw new AgentBrowserClientError("element_not_found", "The element was not found");
            return { evidence: page, title: "Public product" };
          },
          close: async () => {
            closes++;
          },
        };
      },
    );
    await app.send(
      "readonly-miss",
      "Inspect this page and recover from a missing selector",
    );
    const log = await app.host.read("user-123");
    expect(
      log
        .filter((e) => e.type === "ToolReturned")
        .map((e) => (e.result as { status: string }).status),
    ).toEqual(["completed", "blocked", "completed"]);
    expect(
      log
        .filter((e) => e.type === "AikoBrowserActionFinished")
        .map((e) => (e.receipt as { status: string }).status),
    ).toEqual(["completed", "blocked", "completed"]);
    expect(executed).toEqual(["navigate", read, "title"]);
    expect(priorEvidenceSurvived).toBe(true);
    expect(opens).toBe(1);
    expect(closes).toBe(0);
    expect(app.browser.status("123").sessionActive).toBe(true);
    expect(app.sent.at(-1)).toContain("missing selector returned no evidence");
    expect(JSON.stringify(log)).not.toContain(page);
  });

  test("a started side-effect failure stays unknown, closes the session, and cannot become a confident answer", async () => {
    let closes = 0,
      clicks = 0;
    const app = await nativeAnswerHost(
      mockModel((req) => {
        const count = returns(req).length;
        return count >= 2
          ? { kind: "complete", output: "Everything succeeded." }
          : {
              kind: "call",
              callId: `effect-${count}`,
              name: count ? "agent_browser_click" : "agent_browser_navigate",
              arguments: count
                ? { selector: "#submit" }
                : { url: "https://example.com" },
            };
      }),
      async () => ({
        execute: async (action) => {
          if (action.action === "click") {
            clicks++;
            throw new Error("connection_lost_after_start");
          }
          return { evidence: page };
        },
        close: async () => {
          closes++;
        },
      }),
    );
    await app.send("uncertain-effect", "Inspect and select the button");
    const log = await app.host.read("user-123");
    expect(
      log
        .filter((e) => e.type === "ToolReturned")
        .map((e) => (e.result as { status: string }).status),
    ).toEqual(["completed", "unknown"]);
    expect(
      log.filter((e) => e.type === "AikoBrowserActionStarted"),
    ).toHaveLength(2);
    expect(
      log.filter((e) => e.type === "AikoBrowserActionFinished").at(-1)?.receipt,
    ).toMatchObject({ status: "unknown" });
    expect(clicks).toBe(1);
    expect(closes).toBe(1);
    expect(app.browser.status("123").sessionActive).toBe(false);
    expect((app.sent.at(-1) ?? "").includes("couldn’t confirm the results")).toBe(false);
    expect(app.sent.at(-1) ?? "").not.toContain("Everything succeeded");
  });
});

describe("Aiko native browser integration", () => {
  test("sixteen native tool calls replace the four-call ceiling; replies remain bounded and browser data stays transient", async () => {
    let calls = 0,
      hydrated = false;
    const model = mockModel((req) => {
      hydrated ||= JSON.stringify(req.trajectory).includes(page);
      const count = returns(req).length;
      return count >= 16
        ? { kind: "complete", output: page + " model answer" }
        : {
            kind: "call",
            callId: "provider-reused-id",
            name: count ? "agent_browser_title" : "agent_browser_navigate",
            arguments: count ? {} : { url: `https://example.com/${path}` },
            text: page + " preamble",
          };
    });
    const app = await setup(model, async () => ({
      execute: async () => ({ text: page, index: ++calls }),
      close: async () => {},
    }));
    await app.request("/api/messages", {
      id: "browser_read_001",
      text: "Inspect a public website",
    });
    await app.service.host.drive();
    expect(calls).toBe(16);
    expect(hydrated).toBe(true);
    const log = (await app.service.host.read("user-local")) as AikoEvent[];
    expect(log.filter((e) => e.type === "ToolReturned" && (e.result as any)?.kind === "browser-receipt")).toHaveLength(16);
    const reply = String(
      (
        log.find((e) => e.type === "AikoReplyPrepared")?.result as {
          text?: string;
        }
      )?.text,
    );
    expect(reply.length).toBeLessThan(4_000);
    expect(reply).toContain("some results are omitted");
    expect(
      log
        .filter((e) => e.type === "ToolCalled" && e.name !== "respond")
        .every((e) => Object.keys(e.arguments as object).join() === "request"),
    ).toBe(true);
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(page);
    expect(serialized).not.toContain(path);
    const browser = await (await app.request("/api/browser")).json();
    expect(JSON.stringify(browser.observations)).toContain(page);
    expect(browser.observations.at(-1).action).toBe("model_draft");
    expect((await app.request("/api/browser", undefined, "wrong")).status).toBe(
      401,
    );
  });

  test("the actual GLM adapter sees browser evidence while its mocked wire response stays out of durable logs", async () => {
    const stateDir = await mkdtemp("/tmp/aiko-browser-wire-");
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    let calls = 0,
      hydrated = false;
    const app = await createService(
      {
        mode: "live",
        port: 4242,
        stateDir,
        operatorToken: token,
        modelKey: "public-model-fixture-key",
        persona: "fixture",
        voiceEnabled: false,
        allowedUsers: new Set(),
        browser: { executablePath: "/fixture/no-browser", domains: ["*"] },
      },
      {
        browserFactory: async () => ({
          execute: async (action) =>
            action.action === "snapshot"
              ? { snapshot: page }
              : { navigation: true },
          close: async () => {},
        }),
        modelFetch: async (url, init) => {
          expect(String(url)).toBe(
            "https://gateway.codegraff.com/v1/chat/completions",
          );
          const body = JSON.parse(String(init?.body));
          expect(body.model).toBe("glm-5.3-flash");
          hydrated ||= JSON.stringify(body.messages).includes(page);
          const n = calls++;
          const delta =
            n < 2
              ? {
                  role: "assistant",
                  content: page + " preamble",
                  tool_calls: [
                    {
                      index: 0,
                      id: "reused-provider-id",
                      type: "function",
                      function: {
                        name: n
                          ? "agent_browser_snapshot"
                          : "agent_browser_navigate",
                        arguments: JSON.stringify(
                          n ? {} : { url: `https://example.com/${path}` },
                        ),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: page + " final interpretation" };
          const chunk = (delta: object, finish_reason: string | null) => ({
            id: "fixture-completion",
            object: "chat.completion.chunk",
            created: 1,
            model: "glm-5.3-flash",
            choices: [{ index: 0, delta, finish_reason }],
          });
          return new Response(
            `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, n < 2 ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    cleanup.push(() => app.close());
    await app.fetch(
      new Request("http://127.0.0.1:4242/api/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "browser_wire_01",
          text: "Inspect a website",
        }),
      }),
    );
    await app.host.drive();
    expect(calls).toBe(3);
    expect(hydrated).toBe(true);
    const log = JSON.stringify(await app.host.read("user-local"));
    expect(log).not.toContain(page);
    expect(log).not.toContain(path);
    expect(log).not.toContain("public-model-fixture-key");
  });

  test("an earlier uncertain outcome stays disclosed when a long reply omits individual receipts", async () => {
    let calls = 0;
    const model = mockModel((req) => {
      const n = returns(req).length;
      return n >= 10
        ? { kind: "complete", output: "Done" }
        : {
            kind: "call",
            callId: `c${n}`,
            name: "agent_browser_navigate",
            arguments: { url: `https://example.com/${n}` },
          };
    });
    const app = await setup(model, async () => ({
      execute: async () => {
        if (++calls === 1)
          throw new Error("Simulated connection loss after action start");
        return { result: calls };
      },
      close: async () => {},
    }));
    await app.request("/api/messages", {
      id: "browser_unknown1",
      text: "Test uncertain long task",
    });
    await app.service.host.drive();
    const log = (await app.service.host.read("user-local")) as AikoEvent[];
    // An uncertain action gets a visible notice even when verbose diagnostics are off.
    const replies = log.filter((e) => e.type === "AikoReplyPrepared");
    expect(replies).toHaveLength(1);
    expect((replies[0] as any).result.text).toContain("couldn’t confirm");
    expect((replies[0] as any).result.text).toContain("before trying it again");
    expect(log.some((e) => e.type === "AikoDeliverySettled")).toBe(false);
  });

  test("exact interaction approval precedes execution; restored interrupted native attempts never replay", async () => {
    let clicked = 0;
    const model = mockModel((req) => {
      const n = returns(req).length;
      if (
        returns(req).some(
          (e) =>
            (e as { result?: { status?: string } }).result?.status ===
            "unknown",
        ) ||
        n >= 2
      )
        return { kind: "complete", output: "Done" };
      return {
        kind: "call",
        callId: `provider-${n}`,
        name: n ? "agent_browser_click" : "agent_browser_navigate",
        arguments: n ? { selector: "@e1" } : { url: "https://example.com" },
      };
    });
    const factory: BrowserDriverFactory = async () => ({
      execute: async (action) => {
        if (action.action === "click") clicked++;
        return {
          url: "https://example.com",
          snapshot: "button Submit [ref=e1]",
        };
      },
      close: async () => {},
    });
    const app = await setup(model, factory);
    await app.request("/api/messages", {
      id: "browser_click_01",
      text: "Inspect and interact",
    });
    await waitFor(
      async () =>
        (await (await app.request("/api/browser")).json()).pending.length === 1,
    );
    const pending = (await (await app.request("/api/browser")).json())
      .pending[0];
    expect(clicked).toBe(0);
    expect(pending.snapshot).toContain("Submit");
    expect(
      (
        await app.request(
          "/api/browser/approval",
          { id: pending.id, approve: true },
          "wrong",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/browser/approval", {
          id: pending.id,
          approve: true,
          owner: "other",
        })
      ).status,
    ).toBe(400);
    expect(clicked).toBe(0);
    expect(
      (
        await app.request("/api/browser/approval", {
          id: pending.id,
          approve: true,
        })
      ).status,
    ).toBe(202);
    await app.service.host.drive();
    expect(clicked).toBe(1);
    const log = (await app.service.host.read("user-local")) as AikoEvent[];
    const start = log.findLastIndex(
      (e) => e.type === "AikoBrowserActionStarted",
    );
    expect(
      log.findIndex((e) => e.type === "AikoBrowserApprovalGranted"),
    ).toBeLessThan(start);
    expect(JSON.stringify(log)).not.toContain("button Submit");
    expect(JSON.stringify(log)).not.toContain("@e1");
    const recovery = await setup(model, async () => {
      throw new Error("Recovery must not open a browser");
    });
    await recovery.service.host.seed("user-local", log.slice(0, start + 1));
    await recovery.service.host.recover();
    const recovered = (await recovery.service.host.read(
      "user-local",
    )) as AikoEvent[];
    expect(
      recovered.filter((e) => e.type === "ToolReturned" && (e.result as any)?.kind === "browser-receipt").at(-1)?.result,
    ).toMatchObject({ kind: "browser-receipt", status: "unknown" });
    expect(clicked).toBe(1);
  });

  test("synthetic signed Mini App owners cannot inspect or approve each other's browser state", async () => {
    const auth = (id: number) => {
      const data = new URLSearchParams({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id }),
        query_id: `public-fixture-${id}`,
      });
      const check = [...data]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      data.set(
        "hash",
        createHmac(
          "sha256",
          createHmac("sha256", "WebAppData")
            .update("123:public-telegram-fixture")
            .digest(),
        )
          .update(check)
          .digest("hex"),
      );
      return `tma ${data}`;
    };
    let opened = 0;
    const model = mockModel((req) =>
      returns(req).length >= 2
        ? { kind: "complete", output: "Finished" }
        : {
            kind: "call",
            callId: `c${returns(req).length}`,
            name: returns(req).length
              ? "agent_browser_click"
              : "agent_browser_navigate",
            arguments: returns(req).length
              ? { selector: "@e1" }
              : { url: "https://example.com" },
          },
    );
    const app = await setup(
      model,
      async () => {
        const session = ++opened;
        return {
          execute: async () => ({
            url: "https://example.com",
            snapshot: `Private session ${session} button [ref=e1]`,
          }),
          close: async () => {},
        };
      },
      true,
    );
    await app.request(
      "/api/messages",
      { id: "owner_browser_1", text: "Inspect site" },
      auth(123),
    );
    await waitFor(
      async () =>
        (await (await app.request("/api/browser", undefined, auth(123))).json())
          .pending.length === 1,
    );
    const own = await (
      await app.request("/api/browser", undefined, auth(123))
    ).json();
    const foreign = await (
      await app.request("/api/browser", undefined, auth(456))
    ).json();
    expect(foreign.pending).toHaveLength(0);
    expect(foreign.observations).toHaveLength(0);
    expect(
      (
        await app.request(
          "/api/browser/approval",
          { id: own.pending[0].id, approve: true },
          auth(456),
        )
      ).status,
    ).toBe(404);
    expect(
      (await (await app.request("/api/browser", undefined, auth(123))).json())
        .pending,
    ).toHaveLength(1);
    await app.request(
      "/api/browser/approval",
      { id: own.pending[0].id, approve: false },
      auth(123),
    );
    await app.service.host.drive();
    expect(opened).toBe(1);
    await app.request(
      "/api/messages",
      { id: "owner_browser_2", text: "Inspect another site" },
      auth(456),
    );
    await waitFor(
      async () =>
        (await (await app.request("/api/browser", undefined, auth(456))).json())
          .pending.length === 1,
    );
    const second = await (
      await app.request("/api/browser", undefined, auth(456))
    ).json();
    expect(second.pending[0].snapshot).toContain("Private session 2");
    expect(JSON.stringify(second.observations)).not.toContain(
      "Private session 1",
    );
    await app.request(
      "/api/browser/approval",
      { id: second.pending[0].id, approve: false },
      auth(456),
    );
    await app.service.host.drive();
    expect(opened).toBe(2);
  });

  test("denial and page changes cannot execute an approved stale interaction", async () => {
    for (const scenario of ["deny", "snapshot", "url"]) {
      let snapshots = 0,
        locations = 0,
        clicked = 0;
      const model = mockModel((req) =>
        returns(req).length >= 2
          ? { kind: "complete", output: "Done" }
          : {
              kind: "call",
              callId: `c${returns(req).length}`,
              name: returns(req).length
                ? "agent_browser_click"
                : "agent_browser_navigate",
              arguments: returns(req).length
                ? { selector: "@e1" }
                : { url: "https://example.com" },
            },
      );
      const app = await setup(model, async () => ({
        execute: async (action) => {
          if (action.action === "click") clicked++;
          return {
            url:
              action.action === "url" && ++locations > 1 && scenario === "url"
                ? "https://www.iana.org"
                : "https://example.com",
            snapshot:
              action.action === "snapshot" && scenario === "snapshot"
                ? `page-${++snapshots}`
                : "stable page",
          };
        },
        close: async () => {},
      }));
      await app.request("/api/messages", {
        id: "browser_deny_001",
        text: "Test interaction",
      });
      await waitFor(
        async () =>
          (await (await app.request("/api/browser")).json()).pending.length ===
          1,
      );
      const pending = (await (await app.request("/api/browser")).json())
        .pending[0];
      await app.request("/api/browser/approval", {
        id: pending.id,
        approve: scenario !== "deny",
      });
      await app.service.host.drive();
      expect(clicked).toBe(0);
    }
  });

  test("native cancellation releases an approval without performing the action", async () => {
    let clicked = 0;
    const model = mockModel((req) => ({
      kind: "call",
      callId: `c${returns(req).length}`,
      name: returns(req).length
        ? "agent_browser_click"
        : "agent_browser_navigate",
      arguments: returns(req).length
        ? { selector: "@e1" }
        : { url: "https://example.com" },
    }));
    const app = await setup(model, async () => ({
      execute: async (action) => {
        if (action.action === "click") clicked++;
        return { url: "https://example.com", snapshot: "button [ref=e1]" };
      },
      close: async () => {},
    }));
    await app.request("/api/messages", {
      id: "browser_cancel1",
      text: "Test cancellation",
    });
    await waitFor(
      async () =>
        (await (await app.request("/api/browser")).json()).pending.length === 1,
    );
    await app.request("/api/cancel", { id: "local:browser_cancel1" });
    await app.service.host.drive();
    expect(clicked).toBe(0);
    expect(
      (await (await app.request("/api/browser")).json()).pending,
    ).toHaveLength(0);
    const log = (await app.service.host.read("user-local")) as AikoEvent[];
    const reply = String(
      (
        log.find((e) => e.type === "AikoReplyPrepared")?.result as {
          text?: string;
        }
      )?.text,
    );
    expect(reply).toContain("Actions already submitted may still complete");
    expect(reply).not.toContain("No app changes were made");
  });

  test("unlimited native execution continues through repeated observations and compaction beyond 64 calls", async () => {
    let calls = 0,
      requested = 0;
    const model = mockModel((req) => {
      if (req.identity.turn.startsWith("compact-"))
        return {
          kind: "complete",
          output:
            "Continue the current read task; prior receipts are metadata.",
        };
      if (requested === 200)
        return { kind: "complete", output: "Finished the fixture task." };
      const n = requested++;
      return {
        kind: "call",
        callId: "reused-provider-id",
        name: n ? "agent_browser_title" : "agent_browser_navigate",
        arguments: n ? {} : { url: "https://example.com" },
      };
    });
    const app = await setup(model, async () => ({
      execute: async () => {
        calls++;
        return { title: "Same" };
      },
      close: async () => {},
    }));
    await app.request("/api/messages", {
      id: "unlimited_read1",
      text: "Keep observing until the fixture planner finishes",
    });
    await app.service.host.drive();
    const log = (await app.service.host.read("user-local")) as AikoEvent[];
    expect(calls).toBe(200);
    expect(log.filter((e) => e.type === "ToolReturned" && (e.result as any)?.kind === "browser-receipt")).toHaveLength(200);
    expect(log.some((e) => e.type === "CompactionCompleted")).toBe(true);
    expect(
      log.some(
        (e) =>
          e.type === "BudgetExhausted" || e.type === "AikoBrowserNoProgress",
      ),
    ).toBe(false);
    expect(log.filter((e) => e.type === "TurnCompleted")).toHaveLength(1);
    expect(
      (await (await app.request("/api/status")).json()).toolCallLimit,
    ).toBeNull();
  }, 30_000);

  test("the owner can cancel an ongoing unlimited turn after the former 64-call wall", async () => {
    let calls = 0;
    const model = mockModel((req) =>
      req.identity.turn.startsWith("compact-")
        ? { kind: "complete", output: "Keep observing." }
        : {
            kind: "call",
            callId: "same-provider-id",
            name: calls ? "agent_browser_title" : "agent_browser_navigate",
            arguments: calls ? {} : { url: "https://example.com" },
          },
    );
    const app = await setup(model, async () => ({
      execute: async () => {
        calls++;
        await Bun.sleep(1);
        return { title: "Same" };
      },
      close: async () => {},
    }));
    await app.request("/api/messages", {
      id: "unlimited_cancel",
      text: "Observe until cancelled",
    });
    await waitFor(async () => calls >= 80);
    await app.request("/api/cancel", { id: "local:unlimited_cancel" });
    await app.service.host.drive();
    const count = calls;
    await Bun.sleep(10);
    expect(calls).toBe(count);
    expect(
      (await app.service.host.read("user-local")).filter(
        (e) => e.type === "TurnCancelled",
      ),
    ).toHaveLength(1);
  }, 30_000);

  test("a finite native budget applies only when the host explicitly opts in", async () => {
    let calls = 0;
    const model = mockModel((req) =>
      !req.tools.some((t) => t.name === "agent_browser_navigate")
        ? { kind: "complete", output: "The optional budget is spent." }
        : {
            kind: "call",
            callId: `finite-${calls}`,
            name: calls ? "agent_browser_title" : "agent_browser_navigate",
            arguments: calls ? {} : { url: "https://example.com" },
          },
    );
    const app = await setup(
      model,
      async () => ({
        execute: async () => {
          calls++;
          return { title: "Same" };
        },
        close: async () => {},
      }),
      false,
      3,
    );
    await app.request("/api/messages", {
      id: "finite_opt_in_1",
      text: "Use the explicitly configured finite budget",
    });
    await app.service.host.drive();
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10);
    expect(
      (await app.service.host.read("user-local")).some(
        (e) => e.type === "BudgetExhausted",
      ),
    ).toBe(true);
    expect(
      (await (await app.request("/api/status")).json()).toolCallLimit,
    ).toBe(3);
  });

  test("browser shutdown does not short-circuit unrelated native memory inference", async () => {
    const browser = new BrowserController({
      domains: ["*"],
      redact: (s) => s,
      factory: async () => {
        throw new Error("No browser should launch");
      },
    });
    await browser.close();
    const layer = browser.inference(
      mockModel(() => ({
        kind: "call",
        callId: "memory-after-close",
        name: "memory_remember",
        arguments: {
          subject: "notes/queued",
          title: "Queued note",
          payload: { text: "Use UTC" },
        },
      })),
      "local",
    );
    const action = await Effect.runPromise(
      Effect.gen(function* () {
        const infer = yield* Infer;
        return yield* infer.react({
          identity: {
            actor: "aiko",
            instance: "demo",
            thread: "user-local",
            turn: "queued-memory",
          },
          trajectory: [
            {
              type: "MessageReceived",
              id: "queued-memory",
              text: "Remember: Use UTC",
              at: Date.now(),
            },
          ],
          system: "",
          tools: [],
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(action).toMatchObject({ kind: "call", name: "memory_remember" });
  });

  test("the browser capability surface is pure and owner-scoped", async () => {
    let opened = 0;
    const browser = new BrowserController({
      domains: ["*"],
      redact: (text) => text,
      factory: async () => {
        opened++;
        throw new Error("must not open");
      },
    });
    const available = browser.tools("123", "user-123");
    expect(available).toHaveLength(31);
    expect(available.map((tool) => tool.spec.name)).toEqual(expect.arrayContaining([
      "request_memory_search", "request_memory_hydrate",
    ]));
    expect(opened).toBe(0);
    expect(browser.status("456").observations).toEqual([]);
    expect(browser.decide("456", "unknown", true)).toBe(false);
    await browser.close();
  });
});

describe("public-web boundary", () => {
  test("browser enablement and larger native budgets require explicit valid host configuration", async () => {
    const root = await mkdtemp("/tmp/aiko-browser-config-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const env = {
      AIKO_SECRET_FILE: join(root, "absent.env"),
      AIKO_OPERATOR_TOKEN: token,
      AIKO_STATE_DIR: join(root, "state"),
    };
    const normal = await loadConfig(env);
    expect(normal.browser).toBeUndefined();
    expect(normal.toolCallLimit).toBeNull();
    expect(
      (await loadConfig({ ...env, AIKO_TOOL_CALL_LIMIT: "unlimited" }))
        .toolCallLimit,
    ).toBeNull();
    expect(
      (await loadConfig({ ...env, AIKO_TOOL_CALL_LIMIT: "10001" }))
        .toolCallLimit,
    ).toBe(10001);
    expect(
      (await loadConfig({ ...env, AIKO_TOOL_CALL_LIMIT: "400" })).toolCallLimit,
    ).toBe(400);
    for (const limit of ["0", "-1", "Infinity", "1.5", "9007199254740992"])
      await expect(
        loadConfig({ ...env, AIKO_TOOL_CALL_LIMIT: limit }),
      ).rejects.toThrow();
    await expect(
      loadConfig({ ...env, AIKO_BROWSER_ENABLED: "true" }),
    ).rejects.toThrow("AIKO_BROWSER_EXECUTABLE");
    await expect(
      loadConfig({ ...env, AIKO_BROWSER_ENABLED: "yes" }),
    ).rejects.toThrow();
  });
  test("public mode cannot accidentally bypass its filtering proxy", () => {
    const isolation = {
      configPath: "/tmp/config",
      actionPolicyPath: "/tmp/policy",
      socketDirectory: "/tmp/socket",
      temporaryDirectory: "/tmp/temporary",
      session: "a",
      namespace: "a",
      allowedDomains: ["*"],
      requirePublicProxy: true,
    };
    expect(() => isolatedAgentBrowserEnvironment({}, isolation)).toThrow(
      "proxy",
    );
    const env = isolatedAgentBrowserEnvironment(
      { CODEGRAFF_API_KEY: "private", AIKO_OPERATOR_TOKEN: "private" },
      { ...isolation, publicProxy: "http://127.0.0.1:54321" },
    );
    expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBeUndefined();
    expect(env.AGENT_BROWSER_PROXY_BYPASS).toBe("<-loopback>");
    expect(env.CODEGRAFF_API_KEY).toBeUndefined();
    expect(env.AIKO_OPERATOR_TOKEN).toBeUndefined();
  });
  test("private, alternate-encoded, metadata, credential and arbitrary-port targets are rejected", async () => {
    for (const url of [
      "http://localhost",
      "http://127.0.0.1",
      "http://2130706433",
      "http://0x7f000001",
      "http://[::1]",
      "http://metadata.google.internal",
      "http://example.com:4242",
      "https://u:p@example.com",
      "file:///etc/passwd",
      "https://example.com.",
    ])
      expect(() => publicTarget(url)).toThrow();
    expect(publicTarget("https://www.example.com/path").hostname).toBe(
      "www.example.com",
    );
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "198.18.0.1",
      "::ffff:127.0.0.1",
    ])
      expect(publicIPv4(ip)).toBe(false);
    await expect(
      publicAddress("example.com", async () => ["93.184.215.14", "127.0.0.1"]),
    ).rejects.toThrow();
    expect(
      await publicAddress("example.com", async () => ["93.184.215.14"]),
    ).toBe("93.184.215.14");
  });
  test("a real loopback proxy denies internal HTTP requests before making a connection", async () => {
    const proxy = await createPublicProxy();
    cleanup.push(() => proxy.close());
    const url = new URL(proxy.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: "http://127.0.0.1:4242/health",
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

for(const code of ["private_sign_in_pending","private_sign_in_cleanup_failed"]) test(`private browser gate stays blocked without stopping the sign-in: ${code}`,async()=>{
 let closes=0;
 const app=await nativeAnswerHost(mockModel(req=>returns(req).length
  ? {kind:"complete",output:"The browser is waiting for sign-in."}
  : {kind:"call",callId:"private-gate",name:"agent_browser_navigate",arguments:{url:"https://example.com"}}),
  async()=>({execute:async()=>{throw Object.assign(new Error("private data"),{code});},close:async()=>{closes++;}}));
 await app.send("private-gate","Browse the public site");
 const log=await app.host.read("user-123");
 const result=log.find(e=>e.type==="ToolReturned")?.result;
 expect(result).toMatchObject({status:"blocked",reason:code,operation:"agent_browser_navigate"});
 expect(JSON.stringify(result)).not.toContain("private data");
 expect(closes).toBe(0);
});
