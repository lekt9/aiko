import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Validator } from "@cfworker/json-schema";
import {
  actor,
  agentMessageMethod,
  codeMode,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import { EventLog, withWatermark } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { Router } from "tardie/core/communication/router";
import { methodEnvelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { formatThreadAddress } from "tardie/core/communication/endpoint";
import type { Event } from "tardie/core/event";
import { threadCreated, childCreated } from "tardie/core/thread";
import { cancellationRequested } from "tardie/core/method/cancellation";
import { cancelComponent } from "tardie/core/component";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  createCodeChildActor,
  scopedAgentsPackage,
  workerGrantOf,
  workerEventKey,
  workerInference,
  scopedWorkerTools,
  workerIndexTools,
  type WorkerBinding,
  type WorkerGrant,
} from "../src/code-agents.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { BROWSER_ACTOR_PROFILE, BROWSER_ACTOR_INSTRUCTIONS, BROWSER_DELEGATION_INSTRUCTIONS, browserTaskOutput } from "../src/browser-actor.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createService } from "../src/server.ts";
import { PERSONA } from "../src/config.ts";
import { nodeStorage } from "entity-learn";
import { RequestMemory } from "../src/request-memory.ts";
import { memoryTools, openMemory, type MemoryBinding } from "../src/memory.ts";
import { followLogMemory } from "../src/log-memory.ts";
import { BrowserLearning } from "../src/browser-learning.ts";
import type { BrowserDriverFactory } from "../src/browser-driver.ts";
import { createActionApprovals } from "../src/action-approval.ts";
import {
  ownedObservedActions,
  ownedNetworkDefinitions,
} from "../src/capability-builder-network.ts";
import { createObservedNetworkTools } from "../src/observed-network.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const redact = (text: string) => text;
function storage(): AccountStorage {
  const db = new Database(":memory:");
  cleanup.push(async () => db.close());
  let alarm: number | null = null;
  return {
    sql: {
      exec: (q, ...a) => {
        const rows = db.query(q).all(...(a as any));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}
const parentAddress = {
  actor: "aiko",
  instance: "fixture",
  thread: "user-123",
};
const childAddress = { ...parentAddress, thread: "ag.4:turncall" };
function grantFixture(scope: WorkerGrant["scope"] = "research") {
  const grant: WorkerGrant = {
    type: "AikoWorkerGranted",
    owner: "123",
    parentThread: "user-123",
    turn: "turn",
    epoch: 0,
    callId: "call",
    scope,
    origins: ["https://api.vendor.com"],
    actions: [],
    background: true,
    placement: "independent",
    at: 1,
  };
  const parent: Event[] = [
    threadCreated(parentAddress, undefined, 0),
    grant as unknown as Event,
    childCreated(
      "call",
      childAddress,
      { parent: parentAddress, depth: 1, placement: "independent" },
      1,
      "turn",
    ),
  ];
  const child: Event[] = [
    threadCreated(
      childAddress,
      { parent: parentAddress, depth: 1, placement: "independent" },
      1,
    ),
    {
      type: "MessageReceived",
      id: "call",
      text: "brief",
      link: { source: parentAddress, target: childAddress },
      at: 1,
    },
  ];
  const binding: WorkerBinding = {
    owner: "123",
    thread: childAddress.thread,
    readParent: async () => parent,
    readChild: async () => child,
  };
  return { grant, parent, child, binding };
}
function runTool(
  tool: ReturnType<typeof scopedWorkerTools>[number],
  input: unknown,
  f: ReturnType<typeof grantFixture>,
) {
  return Effect.runPromise(
    tool
      .run(input, {
        callId: "effect",
        turn: "call",
        signal: new AbortController().signal,
      })
      .pipe(
        Effect.provideService(Self, childAddress),
        Effect.provideService(
          EventLog,
          withWatermark({
            read: Effect.sync(() => f.child),
            append: (rows) =>
              Effect.sync(() => {
                f.child.push(...rows);
              }),
          }),
        ),
      ),
  );
}
test("worker discovery results match their advertised schemas and expose usable model references", async () => {
  const route={provider:"codegraff",model_id:"configured-model",efforts:["high"],contextWindowTokens:65536,maxOutputTokens:4096,protocol:"openai-chat-completions"};
  const workers=scopedAgentsPackage("123",{models:()=>[route],scopes:["research","browser"],browserOperations:["navigate"],mcp:()=>[{id:"inventory",revision:"v1",tools:{list_projects:"read"}}]});
  const discover=(package_:typeof workers,name:"models"|"providers")=>Effect.runPromise(package_.methods[name]!({},{callId:name}).pipe(
    Effect.provideService(Self,parentAddress),
    Effect.provideService(EventLog,withWatermark({read:Effect.succeed([]),append:()=>Effect.die(Error("Discovery must not append"))})),
    Effect.provideService(Router,{send:()=>Effect.die(Error("Discovery must not dispatch"))}),
  ));
  const models=await discover(workers,"models");
  const providers=await discover(workers,"providers");
  expect(new Validator(workers.docs!.models!.output as any).validate(models).valid).toBe(true);
  expect(new Validator(workers.docs!.providers!.output as any).validate(providers).valid).toBe(true);
  expect(models).toMatchObject({items:[{provider:route.provider,model_id:route.model_id,efforts:["high"]}],browserOperations:["navigate"],mcp:[{id:"inventory"}]});
  expect(providers).toEqual({items:[{provider:route.provider,status:"configured"}]});
  expect(new Validator(workers.docs!.models!.input as any).validate({sort:"promptUsdPerToken"}).valid).toBe(false);
  const empty=scopedAgentsPackage("123");
  expect(new Validator(empty.docs!.models!.output as any).validate(await discover(empty,"models")).valid).toBe(true);
});

test("a rejected durable worker grant cannot dispatch an unowned child", async () => {
  const rows: Event[] = [
    threadCreated(parentAddress, undefined, 0),
    { type: "MessageReceived", id: "turn", text: "Delegate research", at: 1 },
    {
      type: "PackageCalled",
      callId: "call",
      name: "agents.run",
      arguments: {},
      turn: "turn",
      at: 2,
    },
  ];
  let sends = 0;
  const result = await Effect.runPromise(
    scopedAgentsPackage("123").methods.run!(
      { text: "Research the fixture", background: true },
      { callId: "call" },
    ).pipe(
      Effect.provideService(Self, parentAddress),
      Effect.provideService(
        EventLog,
        withWatermark({
          read: Effect.sync(() => rows),
          // A native host policy can reject an append without throwing.
          append: () => Effect.void,
        }),
      ),
      Effect.provideService(Router, {
        send: () =>
          Effect.sync(() => {
            sends++;
          }),
      }),
    ),
  );
  expect(result).toMatchObject({ status: "blocked" });
  expect(sends).toBe(0);
});

test("worker UI controls require current explicit operation and origin grants", async () => {
  const f=grantFixture("browser");let calls=0;
  const native={spec:{name:"worker_browser_navigate",description:"Scoped navigation fixture",inputSchema:{type:"object" as const}},run:()=>Effect.sync(()=>{calls++;return {status:"completed"};})};
  const tool=scopedWorkerTools(f.binding,[native])[0]!,input={origin:"https://api.vendor.com",url:"https://api.vendor.com/new"};
  expect(await runTool(tool,input,f)).toMatchObject({status:"blocked"});
  f.grant.browserOperations=["navigate"];
  expect(await runTool(tool,input,f)).toMatchObject({status:"completed"});
  expect(await tool.authorizeRetained!(input)).toBe(true);
  expect(await runTool(tool,{...input,origin:"https://foreign.vendor.com"},f)).toMatchObject({status:"blocked"});
  f.grant.scope="research";
  expect(await runTool(tool,input,f)).toMatchObject({status:"blocked"});
  f.grant.scope="browser";f.grant.actions=["sha256:"+"a".repeat(64)];
  expect(await runTool(tool,input,f)).toMatchObject({status:"blocked"});
  expect(await tool.authorizeRetained!(input)).toBe(false);
  expect(calls).toBe(1);
});

test("delegation rejects unmounted or ambiguous browser operation grants before dispatch", async () => {
  for(const input of [
    {scope:"research",browserOperations:["navigate"]},
    {scope:"browser",browserOperations:["navigate","navigate"]},
    {scope:"browser",browserOperations:["click"]},
    {scope:"browser",browserOperations:["arbitrary_command"]},
    {scope:"browser",browserOperations:["navigate"],actions:["sha256:"+"a".repeat(64)]},
  ]){
    const rows:Event[]=[threadCreated(parentAddress,undefined,0),{type:"MessageReceived",id:"turn",text:"Delegate",at:1},{type:"PackageCalled",callId:"call",name:"agents.run",arguments:{},turn:"turn",at:2}];
    let sends=0;
    const result=await Effect.runPromise(scopedAgentsPackage("123",{scopes:["research","browser"],browserOperations:["navigate"]}).methods.run!({text:"Run browser task",origins:["https://api.vendor.com"],...input},{callId:"call"}).pipe(
      Effect.provideService(Self,parentAddress),Effect.provideService(EventLog,withWatermark({read:Effect.sync(()=>rows),append:events=>Effect.sync(()=>{rows.push(...events);})})),Effect.provideService(Router,{send:()=>Effect.sync(()=>{sends++;})}),
    ));
    expect(result).toMatchObject({status:"blocked"});expect(sends).toBe(0);expect(rows.some(event=>event.type==="AikoWorkerGranted")).toBe(false);
  }
});

test("worker authority requires exact durable lineage and is revoked by parent cancellation", () => {
  const f = grantFixture();
  expect(workerGrantOf(f.binding, f.parent, f.child)).toEqual(f.grant);
  expect(
    workerGrantOf({ ...f.binding, owner: "456" }, f.parent, f.child),
  ).toBeUndefined();
  for (const key of ["actor", "instance", "thread"])
    for (const side of ["source", "target"]) {
      const child = structuredClone(f.child);
      const link = child[1]!.link as any;
      link[side][key] = "foreign";
      expect(workerGrantOf(f.binding, f.parent, child)).toBeUndefined();
    }
  expect(
    workerGrantOf(
      f.binding,
      f.parent.filter((e) => e.type !== "ChildCreated"),
      f.child,
    ),
  ).toBeUndefined();
  expect(
    workerGrantOf(f.binding, f.parent, [...f.child.slice(1)]),
  ).toBeUndefined();
  expect(
    workerGrantOf(f.binding, f.parent, [
      { ...f.child[0]!, placement: "colocated" },
      ...f.child.slice(1),
    ]),
  ).toBeUndefined();
  f.parent.push(
    cancellationRequested({
      invocation: { method: "message", id: "turn", epoch: 0 },
      request: "stop",
      cause: "requested",
      at: 2,
    }),
  );
  expect(workerGrantOf(f.binding, f.parent, f.child)).toBeUndefined();
});
test("scoped worker effects cannot invoke compute with a research grant or inherit unrelated tools", async () => {
  let calls = 0;
  const f = grantFixture();
  const tools = scopedWorkerTools(f.binding, [
    {
      spec: { name: "sandbox_exec", description: "compute", inputSchema: {} },
      run: () =>
        Effect.sync(() => {
          calls++;
          return { exitCode: 0 };
        }),
    },
    {
      spec: { name: "telegram_send", description: "send", inputSchema: {} },
      run: () => Effect.succeed({ sent: true }),
    },
  ]);
  expect(tools.map((t) => t.spec.name)).toEqual(["sandbox_exec"]);
  expect(await runTool(tools[0]!, {}, f)).toMatchObject({ status: "blocked" });
  expect(calls).toBe(0);
  f.grant.scope = "compute";
  expect(await runTool(tools[0]!, {}, f)).toMatchObject({ exitCode: 0 });
  expect(calls).toBe(1);
  f.binding.active = () => false;
  expect(await runTool(tools[0]!, {}, f)).toMatchObject({ status: "blocked" });
  expect(calls).toBe(1);
});
test("browser worker discovers and replays the actual indexed Merkle DAG only within granted origins", async () => {
  const f = grantFixture("browser");
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId: "owned-trace",
    nextSequence: () => ++sequence,
    emit: async (e) => {
      f.parent.push(e);
    },
  });
  const entry = {
    startedDateTime: new Date(1000).toISOString(),
    time: 20,
    _observationComplete: true,
    request: {
      method: "GET",
      url: "https://api.vendor.com/items",
      headers: [],
      cookies: [],
    },
    response: {
      status: 200,
      headers: [],
      cookies: [],
      content: { mimeType: "application/json", size: 12, text: '{"items":[]}' },
    },
  };
  await learning.observe(entry, 0, true);
  await learning.compile(
    [entry],
    [
      {
        callId: "observed",
        action: "navigate",
        startedAtMs: 999,
        endedAtMs: 1050,
        direct: true,
        resultObserved: true,
      },
    ],
    "https://api.vendor.com",
  );
  const prepared = ownedNetworkDefinitions(f.parent)[0]!;
  expect(prepared).toBeDefined();
  f.parent.push({
    type: "AikoRequestMemoryIndexed",
    toolDigest: prepared.toolDigest,
  });
  const discovery = workerIndexTools(f.binding)[0]!;
  expect(await runTool(discovery, {}, f)).toMatchObject({
    definitions: [{ toolDigest: prepared.toolDigest }],
  });
  let requests = 0;
  const tools = scopedWorkerTools(
    f.binding,
    createObservedNetworkTools({
      owner: "123",
      thread: childAddress.thread,
      redact,
      readEvents: async () => f.parent,
      checkArcade: async () => true,
      send: async (request) => {
        requests++;
        expect(request.url).toBe("https://api.vendor.com/items");
        return {
          status: 200,
          headers: {},
          classification: "application",
          body: { items: ["fresh"] },
        };
      },
    }),
  );
  const args = {
    toolDigest: prepared.toolDigest,
    inputs: Object.fromEntries(
      prepared.definition.inputs.map((i) => [i.name, "items"]),
    ),
  };
  expect(await runTool(tools[0]!, args, f)).toMatchObject({
    status: "completed",
    browser: false,
  });
  expect(requests).toBe(1);
  expect(await tools[0]!.authorizeRetained!(args)).toBe(true);
  f.grant.origins = ["https://other.vendor.com"];
  expect(await tools[0]!.authorizeRetained!(args)).toBe(false);
  expect(await runTool(discovery, {}, f)).toMatchObject({ definitions: [] });
  expect(await runTool(tools[0]!, args, f)).toMatchObject({
    status: "blocked",
  });
  expect(requests).toBe(1);
});
test("native background independent worker dispatch keeps ownership and completes through agents.result", async () => {
  const harnesses = new Map<string, CodeHarness>();
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const harness = (thread: string) => {
    let h = harnesses.get(thread);
    if (!h) {
      h = new CodeHarness("123", thread, runCodeSegment, redact);
      harnesses.set(thread, h);
    }
    return h;
  };
  const binding = (thread: string): WorkerBinding => ({
    owner: "123",
    thread,
    readParent: () => host.read("user-123"),
  });
  const definitions = new Map<
    string,
    ReturnType<typeof createCodeChildActor>
  >();
  let effects = 0;
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
    react: (request) => {
      const done = request.trajectory.some((e) => e.type === "ToolReturned");
      return Effect.succeed(
        done
          ? {
              kind: "complete" as const,
              output: request.identity.thread.startsWith("ag.")
                ? "Child complete"
                : "Parent complete",
            }
          : {
              kind: "call" as const,
              name: "execute",
              callId: "exec",
              arguments: {
                code: request.identity.thread.startsWith("ag.")
                  ? "return await tools.call({name:'sandbox_exec',arguments:{command:'fixture'}});"
                  : "const child=await agents.run({text:'compute fixture',scope:'compute',background:true,placement:'independent'}); const status=await agents.status({id:child.callId}); const result=await agents.result({id:child.callId}); return {status,result};",
              },
            },
      );
    },
  });
  host = await createCloudflareAccountHost({
    storage: storage(),
    actorName: "aiko",
    actorInstance: "fixture",
    ownsThread: (t) => t === "user-123",
    allowChild: (p, c) => p === "user-123" && c.startsWith("ag."),
    allowIndependentChildren: true,
    keyOf: workerEventKey,
    actorFor: (thread) => {
      let definition = definitions.get(thread);
      if (!definition) {
        definition =
          thread === "user-123"
            ? actor({
                name: "aiko",
                methods: { message: agentMessageMethod },
                components: [
                  infer([
                    codeMode([
                      harness(thread).package([]),
                      scopedAgentsPackage("123", {
                        scopes: ["research", "compute"],
                        readChild: (t) => host.read(t),
                      }),
                    ]),
                    outputValidateOnce,
                  ]),
                ],
              })
            : createCodeChildActor(
                harness(thread),
                [
                  {
                    spec: {
                      name: "sandbox_exec",
                      description: "fixture",
                      inputSchema: {
                        type: "object",
                        properties: { command: { type: "string" } },
                        required: ["command"],
                        additionalProperties: false,
                      },
                    },
                    run: () =>
                      Effect.sync(() => {
                        effects++;
                        return { exitCode: 0 };
                      }),
                  },
                ],
                binding(thread),
              );
        definitions.set(thread, definition);
      }
      return definition;
    },
    layersFor: (thread) =>
      Layer.merge(
        harness(thread).inference(
          thread === "user-123"
            ? model
            : workerInference(model, binding(thread)),
        ),
        harness(thread).sandboxLayer(),
      ),
  });
  cleanup.push(() => host.close());
  await host.commitRoot(host.self("user-123"), {
    type: "MessageReceived",
    id: "turn",
    text: "delegate",
    at: 1,
  });
  await host.drive();
  const rows = await host.read("user-123"),
    claim = rows.find((e) => e.type === "ChildCreated")!;
  expect(rows.find((e) => e.type === "TurnCompleted")?.output).toBe(
    "Parent complete",
  );
  expect(effects).toBe(1);
  expect(claim.placement).toBe("independent");
  expect(
    rows.some(
      (e) => e.type === "InvocationLinked" && (e.parent as any)?.id === "turn",
    ),
  ).toBe(true);
  const child = String((claim.address as any).thread);
  expect(
    workerGrantOf(binding(child), rows, await host.read(child))?.scope,
  ).toBe("compute");
});
test.each(["completed", "blocked", "uncertain", "invalid", "cancelled"] as const)("Bun chat delegates to the browser specialist and preserves the %s outcome", async outcome => {
  const stateDir=await mkdtemp("/tmp/aiko-worker-browser-control-");cleanup.push(()=>rm(stateDir,{recursive:true,force:true}));
  const result = { status: outcome, summary: `TASK_SUMMARY_${outcome}`, sources: [{ url: "https://vendor.com/new-page", finding: "Continue button observed" }], receipts: [], nextStep: outcome === "completed" ? "" : "Check the original action before continuing" };
  let navigations=0,clicks=0;
  const model=Layer.succeed(Infer,{
    resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),
    react:request=>{
      const child=request.identity.thread.startsWith("ag."),done=request.trajectory.some(event=>event.type==="ToolReturned");
      expect(request.system).toContain(child ? BROWSER_ACTOR_INSTRUCTIONS : BROWSER_DELEGATION_INSTRUCTIONS);
      if(done&&child) {
        expect(request.trajectory.find(event => event.type === "MessageReceived")?.output).toEqual({ name: browserTaskOutput.name, schema: browserTaskOutput.schema });
        if (outcome === "completed" || outcome === "invalid") expect(JSON.stringify(request.trajectory)).toContain("WORKER_BROWSER_CLICKED_73142");
        else expect(JSON.stringify(request.trajectory)).toContain(outcome === "uncertain" ? "unknown" : "blocked");
      }
      if(done&&!child) {
        expect(JSON.stringify(request.trajectory)).toContain(outcome === "invalid" ? "declared output contract" : result.summary);
        expect(JSON.stringify(request.trajectory)).not.toContain("WORKER_BROWSER_CLICKED_73142");
      }
      const mode = { kind: "local" as const, name: "validate-once" as const };
      return Effect.succeed(done?{kind:"complete" as const,mode,output:child?JSON.stringify(result):"Parent complete"}:{kind:"call" as const,mode,name:"execute",callId:"browser-execute",arguments:{code:child
        ? "const navigate=await tools.call({name:'worker_browser_navigate',arguments:{origin:'https://vendor.com',url:'https://vendor.com/new-page'}});const click=await tools.call({name:'worker_browser_click',arguments:{origin:'https://vendor.com',selector:'#continue'}});return {navigate,click};"
        : "const catalog=await agents.models({});if(!catalog.browserOperations.includes('navigate'))throw Error('Browser operation catalogue missing');return await agents.run({text:'Open the new vendor page and click Continue after approval',scope:'browser',origins:['https://vendor.com'],browserOperations:['navigate','click'],placement:'independent'});"}});
    },
  });
  const config={mode:"demo" as const,port:4242,stateDir,operatorToken:"worker-browser-operator-12345678901234",persona:PERSONA,voiceEnabled:false,allowedUsers:new Set<string>(),codeMode:true,browser:{executablePath:"/fixture/browser",domains:["*"]}};
  const service=await createService(config,{
    model,
    browserFactory:async()=>({
      execute:async()=>{throw Error("Worker bypassed scoped driver");},
      executeScoped:async(action,policy)=>{
        expect(policy).toEqual({origin:"https://vendor.com",origins:["https://vendor.com"]});
        if(action.action==="navigate"){navigations++;return {url:action.url};}
        if(action.action==="url")return {url:"https://vendor.com/new-page"};
        if(action.action==="snapshot")return {text:"Continue button #continue"};
        if(action.action==="click"){clicks++;if(outcome==="uncertain")throw Error("Lost acknowledgement after dispatch");return {text:"WORKER_BROWSER_CLICKED_73142"};}
        throw Error("Unexpected scoped browser action");
      },
      authorizeInspection:async()=>true,
      close:async()=>{},
    }),
    registrySandbox:()=>({placement:"local",codeTransport:runCodeSegment,sandbox:{harnessEnvironment:async()=>`sha256:${"1".repeat(64)}`,harnessJob:async()=>{throw Error("Unexpected harness job");}}}),
  });cleanup.push(()=>service.close());
  await service.host.commitRoot(service.host.self("user-local"),{type:"MessageReceived",id:"browser-turn",text:"Delegate browser operation",at:1});
  const driving=service.host.drive();
  const headers={authorization:`Bearer ${config.operatorToken}`};
  let pending:any;
  for(let attempt=0;attempt<600&&!pending;attempt++){
    const state=await (await service.fetch(new Request("http://localhost/api/browser",{headers}))).json() as any;
    pending=state.pending?.[0];
    if(!pending)await new Promise(resolve=>setTimeout(resolve,5));
  }
  if (!pending) throw Error(JSON.stringify(await Promise.all((await service.host.threads()).map(async thread => ({ thread, events: await service.host.read(thread) })))));
  expect(pending).toMatchObject({name:"agent_browser_click",args:{selector:"#continue"}});
  expect(navigations).toBe(1);expect(clicks).toBe(0);
  expect((await service.host.read("user-local")).some(event=>event.type==="AikoBrowserApprovalRequested")).toBe(true);
  if (outcome === "cancelled") {
    const cancelled = await service.fetch(new Request("http://localhost/api/cancel", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: "browser-turn" }) }));
    expect(cancelled.status).toBe(202);
    await driving;
    await service.host.drive();
    const rows = await service.host.read("user-local"), claim = rows.find(event => event.type === "ChildCreated")!;
    expect(rows.find(event => event.type === "AikoWorkerGranted")).toMatchObject({ profile: BROWSER_ACTOR_PROFILE });
    expect((await service.host.read((claim.address as any).thread)).some(event => event.type === "TurnCancelled")).toBe(true);
    expect(clicks).toBe(0);
    await service.host.recover();
    expect(navigations).toBe(1); expect(clicks).toBe(0);
    return;
  }
  const response=await service.fetch(new Request("http://localhost/api/browser/approval",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({id:pending.id,approve:outcome!=="blocked"})}));
  expect(response.status).toBe(202);
  await driving;
  expect(clicks).toBe(outcome==="blocked"?0:1);
  const rows=await service.host.read("user-local"),claim=rows.find(event=>event.type==="ChildCreated")!;
  expect(rows.some(event=>event.type==="AikoBrowserApprovalGranted")).toBe(outcome!=="blocked");
  expect(rows.find(event=>event.type==="AikoWorkerGranted")).toMatchObject({profile:BROWSER_ACTOR_PROFILE,browserOperations:["navigate","click"]});
  const child=await service.host.read((claim.address as any).thread);
  if (outcome === "invalid") {
    expect(child.find(event => event.type === "TurnFailed")).toMatchObject({ cause: "output_validation_failed" });
    expect(child.some(event => event.type === "TurnCompleted")).toBe(false);
  } else expect(JSON.parse(String(child.find(event=>event.type==="TurnCompleted")?.output))).toEqual(result);
  expect(rows.find(event=>event.type==="TurnCompleted")?.output).toBe("Parent complete");
  expect(JSON.stringify([...rows,...child])).not.toContain("WORKER_BROWSER_CLICKED_73142");
  await service.host.recover();expect(navigations).toBe(1);expect(clicks).toBe(outcome==="blocked"?0:1);
});

test("the actual Bun service resolves worker owners from its native directory and resumes private child threads", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-worker-bun-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  let reads = 0,
    inspections = 0;
  const browserOwners: string[] = [];
  const pageMarker = "INHERITED_PARENT_PAGE_73912";
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
    react: (request) => {
      expect(request.system).toContain(
        "PROJECT_SCOPE_" + request.identity.thread,
      );
      const done = request.trajectory.some((e) => e.type === "ToolReturned");
      if (done && request.identity.thread.startsWith("ag."))
        expect(JSON.stringify(request.trajectory)).toContain(pageMarker);
      return Effect.succeed(
        done
          ? {
              kind: "complete" as const,
              output: request.identity.thread.startsWith("ag.")
                ? "Bun child evidence"
                : "Bun parent complete",
            }
          : {
              kind: "call" as const,
              name: "execute",
              callId: "exec",
              arguments: {
                code: request.identity.thread.startsWith("ag.")
                  ? "const fresh=await tools.call({name:'web_read',arguments:{url:'https://vendor.com/evidence'}});const page=await tools.call({name:'worker_browser_inspect',arguments:{origin:'https://vendor.com',publicOnly:true}});const mcp=await tools.call({name:'mcp_server_list',arguments:{}});if(!mcp.servers?.some(server=>server.id==='inventory'))throw Error('Configured MCP missing');return {fresh,page};"
                  : "await tools.call({name:'agent_browser_navigate',arguments:{url:'https://vendor.com/evidence'}});return await agents.run({text:'Read https://vendor.com/evidence and inspect the current parent page at https://vendor.com',scope:'research',placement:'independent',mcp:[{server:'inventory',tools:['list_projects']}]});",
              },
            },
      );
    },
  });
  const config = {
    mode: "demo" as const,
    port: 4242,
    stateDir,
    operatorToken: "worker-fixture-not-secret-123456789",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
    codeMode: true,
    publicWeb: true,
    browser: { executablePath: "/test/host-owned-browser", domains: ["*"] },
    mcpServers: Object.fromEntries(
      ["123", "456"].map((owner) => [
        owner,
        [
          {
            id: "inventory",
            revision: "fixture-1",
            description: "Configured inventory",
            tools: { list_projects: "read" as const },
            url: "https://mcp.vendor.com/api",
            headerRefs: { Authorization: "INVENTORY_MCP_TOKEN" },
          },
        ],
      ]),
    ),
    mcpSecrets: { INVENTORY_MCP_TOKEN: "Bearer PRIVATE_MCP_HEADER_73912" },
  };
  const overrides = {
    model,
    browserFactory: (async ({ owner }) => {
      browserOwners.push(owner!);
      let navigated = false;
      return {
        execute: async (action) => {
          if (action.action === "navigate") navigated = true;
          return action.action === "url"
            ? { url: "https://vendor.com/evidence" }
            : { text: "Parent page opened" };
        },
        inspectCurrentPage: async (policy) => {
          expect(navigated).toBe(true);
          expect(policy).toEqual({
            origin: "https://vendor.com",
            publicOnly: true,
          });
          inspections++;
          return {
            url: "https://vendor.com/evidence",
            title: "Vendor evidence",
            text: pageMarker,
            snapshot: pageMarker,
            links: ["https://vendor.com/source"],
            linksTruncated: false,
          };
        },
        close: async () => {},
      };
    }) satisfies BrowserDriverFactory,
    projectContext: (owner: string, thread: string) => ({
      owner,
      thread,
      redact,
      source: {
        read: async (path: string) =>
          path === "AGENTS.md" ? "PROJECT_SCOPE_" + thread : undefined,
        list: async () => [],
      },
    }),
    webRead: async (url: string) => {
      reads++;
      return {
        url,
        title: "Evidence",
        text: "Observed fixture content",
        truncated: false,
      };
    },
    registrySandbox: () => ({
      placement: "local" as const,
      codeTransport: runCodeSegment,
      sandbox: {
        harnessEnvironment: async () =>
          ("sha256:" + "1".repeat(64)) as `sha256:${string}`,
        harnessJob: async () => {
          throw Error("Unexpected harness job");
        },
      },
    }),
  };
  let service = await createService(config, overrides);
  cleanup.push(() => service.close());
  await service.host.commitRoot(service.host.self("user-123"), {
    type: "MessageReceived",
    id: "turn",
    text: "Read evidence",
    at: 1,
  });
  await service.host.drive();
  const parent = await service.host.read("user-123"),
    claim = parent.find((e) => e.type === "ChildCreated")!;
  expect(parent.find((e) => e.type === "TurnCompleted")?.output).toBe(
    "Bun parent complete",
  );
  expect(reads).toBe(1);
  expect(inspections).toBe(1);
  expect(browserOwners).toEqual(["123"]);
  expect(JSON.stringify(parent)).not.toContain(pageMarker);
  expect(JSON.stringify(parent)).not.toContain("PRIVATE_MCP_HEADER_73912");
  expect(claim.placement).toBe("independent");
  const child = String((claim.address as any).thread);
  expect((await service.host.actorThread(child))?.parentThread).toBe(
    "user-123",
  );
  await service.host.commitRoot(service.host.self("user-456"), {
    type: "MessageReceived",
    id: "turn",
    text: "Read evidence",
    at: 1,
  });
  await service.host.drive();
  const other = (await service.host.read("user-456")).find(
    (e) => e.type === "ChildCreated",
  )!;
  expect((other.address as any).thread).not.toBe(child);
  expect(reads).toBe(2);
  expect(inspections).toBe(2);
  expect(browserOwners).toEqual(["123", "456"]);
  expect(
    (await service.host.actorThread((other.address as any).thread))
      ?.parentThread,
  ).toBe("user-456");
  await service.close();
  service = await createService(config, overrides);
  await service.host.recover();
  expect(reads).toBe(2);
  expect(inspections).toBe(2);
  expect(browserOwners).toEqual(["123", "456"]);
  expect(
    (await service.host.read(child)).some((e) => e.type === "TurnCompleted"),
  ).toBe(true);
});
test.each([false, true])(
  "owner cancellation settles background worker cleanup even when cleanup fails (%s)",
  async (failedCleanup) => {
    const stateDir = await mkdtemp("/tmp/aiko-worker-cancel-");
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    let started = false,
      aborted = false,
      cancelled = 0;
    const model = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
      react: (request) =>
        Effect.succeed(
          request.trajectory.some((e) => e.type === "ToolReturned")
            ? { kind: "complete" as const, output: "Parent dispatched" }
            : {
                kind: "call" as const,
                name: "execute",
                callId: "exec",
                arguments: {
                  code: request.identity.thread.startsWith("ag.")
                    ? "return await tools.call({name:'sandbox_exec',arguments:{command:'wait'}});"
                    : "return await agents.run({text:'Wait for computation',scope:'compute',background:true});",
                },
              },
        ),
    });
    const workerTools = () => [
      {
        spec: {
          name: "sandbox_exec",
          description: "wait",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
            additionalProperties: false,
          },
        },
        run: (_input: unknown, ctx: { signal: AbortSignal }) =>
          Effect.promise(
            () =>
              new Promise((resolve) => {
                started = true;
                ctx.signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    resolve({ state: "unknown" });
                  },
                  { once: true },
                );
              }),
          ),
      },
      {
        spec: {
          name: "sandbox_job",
          description: "cancel owned process",
          inputSchema: { type: "object" },
        },
        run: (input: unknown) =>
          Effect.sync(() => {
            expect(input).toMatchObject({ cancel: true });
            cancelled++;
            if (failedCleanup) throw Error("private-cleanup-failure-sentinel");
            return { state: "cancelled" };
          }),
      },
    ];
    const config = {
      mode: "demo" as const,
      port: 4242,
      stateDir,
      operatorToken: "worker-cancel-fixture-123456789012345",
      persona: PERSONA,
      voiceEnabled: false,
      allowedUsers: new Set<string>(),
      codeMode: true,
    };
    const service = await createService(config, {
      model,
      workerTools,
      registrySandbox: () => ({
        placement: "local",
        codeTransport: runCodeSegment,
        sandbox: {
          harnessEnvironment: async () => `sha256:${"1".repeat(64)}`,
          harnessJob: async () => {
            throw Error("Unexpected harness job");
          },
        },
      }),
    });
    cleanup.push(() => service.close());
    await service.host.commitRoot(service.host.self("user-local"), {
      type: "MessageReceived",
      id: "turn",
      text: "Delegate computation",
      at: 1,
    });
    const driving = service.host.drive();
    for (
      let n = 0;
      n < 200 &&
      (!started ||
        !(await service.host.read("user-local")).some(
          (e) => e.type === "TurnCompleted",
        ));
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(true);
    expect(
      (await service.host.read("user-local")).some(
        (e) => e.type === "TurnCompleted",
      ),
    ).toBe(true);
    const response = await service.fetch(
      new Request("http://localhost/api/cancel", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "turn" }),
      }),
    );
    expect(response.status).toBe(202);
    await driving;
    await service.host.drive();
    expect(aborted).toBe(true);
    expect(cancelled).toBe(1);
    const child = (await service.host.threads()).find((t) =>
      t.startsWith("ag."),
    )!;
    const events = await service.host.read(child);
    expect(events.some((e) => e.type === "TurnCancelled")).toBe(true);
    expect(events.find((e) => e.type === "AikoWorkerJobCleanup")?.state).toBe(
      failedCleanup ? "unknown" : "cancelled",
    );
    expect(JSON.stringify(events)).not.toContain(
      "private-cleanup-failure-sentinel",
    );
    expect(
      events.findIndex((e) => e.type === "AikoWorkerJobCleanup"),
    ).toBeLessThan(events.findIndex((e) => e.type === "TurnCancelled"));
  },
  10000,
);

test("worker process cleanup ignores a cancellation from an older invocation epoch", () => {
  const f = grantFixture("compute"),
    harness = new CodeHarness(
      "123",
      childAddress.thread,
      runCodeSegment,
      (s) => s,
    );
  const definition = createCodeChildActor(
    harness,
    [
      {
        spec: {
          name: "sandbox_job",
          description: "stop",
          inputSchema: { type: "object" },
        },
        run: () => Effect.succeed({ state: "cancelled" }),
      },
    ],
    f.binding,
  );
  const cleanup = definition.components.find(
    (component) => component.name === "aiko.worker-jobs",
  )!;
  const rows: Event[] = [
    {
      type: "AikoWorkerJobObserved",
      owner: "123",
      thread: childAddress.thread,
      turn: "call",
      epoch: 1,
      callId: "command",
      jobId: "a".repeat(64),
      state: "running",
      at: 1,
    },
    cancellationRequested({
      request: "old",
      invocation: { method: "message", id: "call", epoch: 0 },
      cause: "requested",
      at: 2,
    }),
    { type: "TurnCancelled", turn: "call", epoch: 0, at: 3 },
  ];
  const state = rows.reduce(cleanup.machine.step, cleanup.machine.initial());
  expect(cleanup.machine.output(state).transitions).toHaveLength(0);
  expect(
    cancelComponent(cleanup, rows, {
      request: "old",
      invocation: { method: "message", id: "call", epoch: 0 },
      cause: "requested",
    }),
  ).toHaveLength(0);
  expect(
    cancelComponent(cleanup, rows, {
      request: "current",
      invocation: { method: "message", id: "call", epoch: 1 },
      cause: "requested",
    }),
  ).toHaveLength(1);
});

test("worker computation stays pending until an observed job terminal and coding cannot bypass workspace policy", async () => {
  const f = grantFixture("compute");
  let release!: () => void,
    polls = 0,
    settled = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tools = scopedWorkerTools(f.binding, [
    {
      spec: { name: "sandbox_exec", description: "launch", inputSchema: {} },
      run: () => Effect.succeed({ state: "running" }),
    },
    {
      spec: { name: "sandbox_job", description: "observe", inputSchema: {} },
      run: () =>
        Effect.promise(async () => {
          polls++;
          await waiting;
          return { state: "completed", exitCode: 0 };
        }),
    },
  ]);
  const running = runTool(tools[0]!, {}, f).then((value) => {
    settled = true;
    return value;
  });
  for (let n = 0; n < 100 && !polls; n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(polls).toBe(1);
  expect(settled).toBe(false);
  release();
  expect(await running).toMatchObject({ state: "completed" });
  expect(
    f.child.findLast((e) => e.type === "AikoWorkerJobObserved")?.state,
  ).toBe("completed");
  f.grant.scope = "coding";
  expect(await runTool(tools[0]!, {}, f)).toMatchObject({ status: "blocked" });
});

test("browser worker writes require exact parent consent, retain private sessions, and reject changed inputs", async () => {
  const f = grantFixture("browser");
  let sequence = 0,
    sends = 0;
  const learning = new BrowserLearning({
    threadId: "owned-trace",
    nextSequence: () => ++sequence,
    emit: async (e) => {
      f.parent.push(e);
    },
  });
  const entry = {
    startedDateTime: new Date(1100).toISOString(),
    time: 20,
    _observationComplete: true,
    request: {
      method: "POST",
      url: "https://api.vendor.com/items",
      headers: [{ name: "content-type", value: "application/json" }],
      cookies: [{ name: "sid", value: "SECRET_COOKIE" }],
      postData: { mimeType: "application/json", text: '{"title":"n"}' },
    },
    response: {
      status: 201,
      headers: [],
      cookies: [],
      content: { mimeType: "application/json", size: 11, text: '{"ok":true}' },
    },
  };
  await learning.observe(entry, 0, true);
  await learning.compile(
    [entry],
    [
      {
        callId: "observed",
        action: "click",
        startedAtMs: 1090,
        endedAtMs: 1150,
        direct: true,
        resultObserved: true,
      },
    ],
    "https://api.vendor.com",
  );
  const action = ownedObservedActions(f.parent)[0]!;
  expect(action?.effect).toBe("write");
  const input = {
    artifactDigest: action.artifactDigest,
    inputs: Object.fromEntries(
      action.artifact.actions[0]!.inputs.map((i) => [
        i.name,
        i.name.includes("title") ? "n" : "items",
      ]),
    ),
  };
  const session = {
    connectionId: "conn",
    revision: "1",
    domains: ["vendor.com"],
    cookies: [
      {
        name: "sid",
        value: "SECRET_COOKIE",
        domain: ".vendor.com",
        path: "/",
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: "Lax" as const,
        hostOnly: false,
      },
    ],
  };
  const tools = scopedWorkerTools(
    f.binding,
    createObservedNetworkTools({
      owner: "123",
      thread: childAddress.thread,
      redact: (text) => text.replaceAll("SECRET_COOKIE", "[redacted]"),
      readEvents: async () => f.parent,
      approvalJournal: {
        thread: "user-123",
        read: async () => f.parent,
        append: async (rows) => {
          f.parent.push(...rows);
        },
      },
      checkArcade: async () => true,
      session,
      send: async (request) => {
        sends++;
        expect(request.headers.cookie).toContain("SECRET_COOKIE");
        return {
          status: 201,
          headers: {},
          classification: "application",
          body: { ok: true },
        };
      },
    }),
  );
  const pending = (await runTool(tools[0]!, input, f)) as any;
  expect(pending.status).toBe("authorization_required");
  expect(sends).toBe(0);
  await Effect.runPromise(
    createActionApprovals({ owner: "123", thread: "user-123" })
      .decide(
        { owner: "123", subject: "account:123", authenticated: true },
        { id: pending.approvalId, hash: pending.hash, decision: "approve" },
      )
      .pipe(
        Effect.provideService(
          EventLog,
          withWatermark({
            read: Effect.sync(() => f.parent),
            append: (rows) =>
              Effect.sync(() => {
                f.parent.push(...rows);
              }),
          }),
        ),
      ),
  );
  const approved = {
    ...input,
    approvalId: pending.approvalId,
    hash: pending.hash,
  };
  const changed = {
    ...approved,
    inputs: { ...input.inputs, [Object.keys(input.inputs)[0]!]: "different" },
  };
  expect(await runTool(tools[0]!, changed, f)).toMatchObject({
    status: "rejected",
  });
  expect(sends).toBe(0);
  expect(await runTool(tools[0]!, approved, f)).toMatchObject({
    status: "completed",
    effect: "write",
    session: true,
  });
  expect(sends).toBe(1);
  expect(JSON.stringify(f.parent) + JSON.stringify(f.child)).not.toContain(
    "SECRET_COOKIE",
  );
  expect(await tools[0]!.authorizeRetained!(approved)).toBe(true);
  session.cookies = [];
  expect(await tools[0]!.authorizeRetained!(approved)).toBe(false);
});

test("worker MCP resources cannot inherit unlisted servers or tools", async () => {
  const f = grantFixture();
  f.grant.mcp = [{ server: "allowed", revision: "1", tools: ["read"] }];
  let revision = "1";
  f.binding.mcpCurrent = () => [
    { id: "allowed", revision, tools: { read: "read" } },
  ];
  let calls = 0;
  const tools = scopedWorkerTools(f.binding, [
    {
      spec: {
        name: "mcp_server_list",
        description: "servers",
        inputSchema: {},
      },
      run: () =>
        Effect.succeed({
          servers: [
            { id: "allowed", tools: [{ name: "read" }, { name: "write" }] },
            { id: "foreign", tools: [{ name: "read" }] },
          ],
        }),
    },
    {
      spec: { name: "mcp_server_call", description: "call", inputSchema: {} },
      run: () =>
        Effect.sync(() => {
          calls++;
          return { content: "observed" };
        }),
    },
  ]);
  expect(await runTool(tools[0]!, {}, f)).toEqual({
    servers: [{ id: "allowed", tools: [{ name: "read" }] }],
  });
  for (const args of [
    { server: "foreign", tool: "read" },
    { server: "allowed", tool: "write" },
  ])
    expect(await runTool(tools[1]!, args, f)).toMatchObject({
      status: "blocked",
    });
  expect(calls).toBe(0);
  const args = { server: "allowed", tool: "read" };
  expect(await runTool(tools[1]!, args, f)).toMatchObject({
    content: "observed",
  });
  expect(calls).toBe(1);
  expect(await tools[1]!.authorizeRetained!(args)).toBe(true);
  revision = "2";
  expect(await tools[1]!.authorizeRetained!(args)).toBe(false);
  revision = "1";
  f.grant.mcp = [];
  expect(await tools[1]!.authorizeRetained!(args)).toBe(false);
});

test("worker results reject unknown handles and ignore responses from a different native child", async () => {
  const f = grantFixture(),
    pkg = scopedAgentsPackage("123");
  f.parent.push(
    {
      type: "ResponseReceived",
      id: "call.reply",
      method: "message",
      call: "call",
      status: "completed",
      output: "foreign",
      from: formatThreadAddress({ ...childAddress, thread: "ag.1:other" }),
      at: 2,
    },
    {
      type: "ResponseReceived",
      id: "call.reply",
      method: "message",
      call: "call",
      status: "completed",
      output: "owned",
      from: formatThreadAddress(childAddress),
      at: 3,
    },
  );
  const invoke = (id: string) =>
    Effect.runPromise(
      pkg.methods.result!({ id }, { callId: "result" } as any).pipe(
        Effect.provideService(Self, parentAddress),
        Effect.provideService(
          EventLog,
          withWatermark({
            read: Effect.sync(() => f.parent),
            append: () => Effect.void,
          }),
        ),
        Effect.provideService(Router, {
          send: () => Effect.die(Error("No dispatch from result lookup")),
        }),
      ),
    );
  expect(await invoke("invented")).toMatchObject({ status: "blocked" });
  expect(await invoke("call")).toEqual({ output: "owned" });
});

test("Cloudflare independent lineage requires explicit opt-in and exact owned claim, then survives atomic import", async () => {
  const f = grantFixture();
  const options = {
    actorName: "aiko",
    actorInstance: "fixture",
    ownsThread: (thread: string) => thread === "user-123",
    allowChild: (parent: string, child: string) =>
      parent === "user-123" && child.startsWith("ag."),
    keyOf: workerEventKey,
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
  };
  const envelope = methodEnvelopeOf(
    linkOf(parentAddress, childAddress),
    { invocation: { method: "message", id: "call", epoch: 0 } },
    { type: "MessageReceived", id: "call", text: "brief", at: 1 },
    { parent: parentAddress, depth: 1, placement: "independent" },
  );
  const blocked = await createCloudflareAccountHost({
    ...options,
    storage: storage(),
  });
  cleanup.push(() => blocked.close());
  await blocked.seed("user-123", f.parent);
  await expect(blocked.commit(envelope)).rejects.toThrow(
    "owned durable parent claim",
  );
  expect(await blocked.threads()).toEqual(["user-123"]);
  const host = await createCloudflareAccountHost({
    ...options,
    storage: storage(),
    allowIndependentChildren: true,
  });
  cleanup.push(() => host.close());
  await host.seed("user-123", f.parent);
  await expect(
    host.commit({
      ...envelope,
      link: linkOf({ ...parentAddress, thread: "user-456" }, childAddress),
    }),
  ).rejects.toThrow("outside");
  await expect(
    host.commit({
      ...envelope,
      lineage: { ...envelope.lineage!, placement: "colocated" },
    }),
  ).rejects.toThrow("owned durable parent claim");
  await host.commit(envelope);
  expect((await host.read(childAddress.thread))[0]).toMatchObject({
    placement: "independent",
    parent: parentAddress,
  });
  const histories = host.exportHistory(),
    restored = await createCloudflareAccountHost({
      ...options,
      storage: storage(),
      allowIndependentChildren: true,
    });
  cleanup.push(() => restored.close());
  for (const side of ["source", "target"]) {
    const forged = structuredClone(histories);
    const brief = forged
      .find((history) => history.thread === childAddress.thread)!
      .events.find((event) => event.type === "MessageReceived")!;
    (brief.link as any)[side].instance = "foreign";
    await expect(restored.importHistory("forged", forged)).rejects.toThrow(
      "owned durable parent claim",
    );
  }
  await expect(
    restored.importHistory("worker-import", histories, {
      fingerprint: "fixture",
      import: () => {
        throw Error("sidecar failure");
      },
    }),
  ).rejects.toThrow("sidecar failure");
  expect(await restored.threads()).toEqual([]);
  expect(await restored.importHistory("worker-import", histories)).toBe(
    "imported",
  );
  expect(await restored.read(childAddress.thread)).toEqual(
    await host.read(childAddress.thread),
  );
  expect(
    workerGrantOf(
      f.binding,
      await restored.read("user-123"),
      await restored.read(childAddress.thread),
    ),
  ).toMatchObject({ placement: "independent" });
});

test("compute grant revocation cancels its launched process before failing the worker", async () => {
  const f = grantFixture("compute");
  let active = true,
    cancels = 0;
  f.binding.active = () => active;
  const tools = scopedWorkerTools(f.binding, [
    {
      spec: { name: "sandbox_exec", description: "launch", inputSchema: {} },
      run: () =>
        Effect.sync(() => {
          active = false;
          return { state: "running" };
        }),
    },
    {
      spec: { name: "sandbox_job", description: "observe", inputSchema: {} },
      run: (args: unknown) =>
        Effect.sync(() => {
          expect(args).toMatchObject({ cancel: true });
          cancels++;
          return { state: "cancelled" };
        }),
    },
  ]);
  expect(await runTool(tools[0]!, {}, f)).toMatchObject({ status: "blocked" });
  expect(cancels).toBe(1);
  expect(f.child.find((e) => e.type === "AikoWorkerJobCleanup")?.state).toBe(
    "cancelled",
  );
});

test("captured browser requests flow through a real pointer index and cited memory into native worker execution", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-worker-index-memory-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const captured: Event[] = [];
  let sequence = 0,
    indexedId = "",
    requests = 0,
    sawCitation = false,
    sawFresh = false;
  const pointerStorage = nodeStorage(join(stateDir, "pointers.sqlite"));
  cleanup.push(async () => pointerStorage.close());
  const pointer = new RequestMemory({
    owner: "123",
    storage: pointerStorage,
    readOwnedEvents: async () => captured,
    embedding: {
      model: "explicit-test-embedding-v1",
      dimensions: 3,
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    },
    transport: {
      send: async () => {
        throw Error("Worker execution must use its scoped observed adapter");
      },
    },
  });
  const learning = new BrowserLearning({
    threadId: "owner-capture",
    nextSequence: () => ++sequence,
    emit: async (event) => {
      captured.push(event);
    },
    onPrepared: async (event, responses) => {
      const indexed = await pointer.index(
        event.toolDigest,
        ["catalog"],
        responses,
      );
      indexedId = indexed.pointerId;
      captured.push({
        type: "AikoRequestMemoryIndexed",
        id: "capture-index",
        toolDigest: event.toolDigest,
        pointerId: indexed.pointerId,
        model: indexed.model,
        at: Date.now(),
      });
    },
  });
  const entry = {
    startedDateTime: new Date(1000).toISOString(),
    time: 20,
    _observationComplete: true,
    request: {
      method: "GET",
      url: "https://api.vendor.com/catalog",
      headers: [],
      cookies: [],
    },
    response: {
      status: 200,
      headers: [],
      cookies: [],
      content: {
        mimeType: "application/json",
        size: 17,
        text: '{"catalog":[]}',
      },
    },
  };
  await learning.observe(entry, 0, true);
  await learning.compile(
    [entry],
    [
      {
        callId: "capture",
        action: "navigate",
        startedAtMs: 999,
        endedAtMs: 1050,
        direct: true,
        resultObserved: true,
      },
    ],
    "https://api.vendor.com",
  );
  expect(indexedId).toMatch(/^obs_[a-f0-9]{64}$/);
  expect(
    (await new RequestMemory(pointer.binding).search("catalog")).items[0]
      ?.pointerId,
  ).toBe(indexedId);
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const harnesses = new Map<string, CodeHarness>();
  const harness = (thread: string) => {
    let found = harnesses.get(thread);
    if (!found) {
      found = new CodeHarness("123", thread, runCodeSegment, redact);
      harnesses.set(thread, found);
    }
    return found;
  };
  const memory = (thread: string): MemoryBinding => ({
    stateDir,
    owner: "123",
    thread,
    redact,
    readPage: (after, limit) => host.readPage(thread, after, limit),
  });
  const binding = (thread: string): WorkerBinding => ({
    owner: "123",
    thread,
    readParent: () => host.read("user-123"),
    readChild: () => host.read(thread),
  });
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
    react: (request) => {
      const child = request.identity.thread.startsWith("ag."),
        done = request.trajectory.some(
          (event) => event.type === "ToolReturned",
        );
      if (child && done) {
        const text = JSON.stringify(request.trajectory);
        sawCitation = text.includes('"citation":"obs_');
        sawFresh = text.includes("FRESH_CATALOG_VALUE");
      }
      return Effect.succeed(
        done
          ? {
              kind: "complete" as const,
              output: child
                ? JSON.stringify({ status: "completed", summary: "Observed catalog with a pinned memory citation.", sources: [{ url: "https://api.vendor.com/catalog", finding: "Catalog inspected through the recorded request." }], receipts: [], nextStep: "" })
                : "Worker returned observed evidence.",
              mode: { kind: "local" as const, name: "validate-once" as const },
            }
          : {
              kind: "call" as const,
              mode: { kind: "local" as const, name: "validate-once" as const },
              name: "execute",
              callId: "index-exec",
              arguments: {
                code: child
                  ? `const memory=await tools.call({name:'memory_recall',arguments:{search:'AikoRequestMemoryIndexed',limit:2}});
                    const citation=memory.result.items[0]?.observation.id;if(!citation)throw Error('Missing source citation');
                    const contract=await tools.describe({name:'worker_index_describe'});
                    if(!contract.inputSchema.properties.toolDigest)throw Error('Missing native graph contract');
                    let index=await tools.call({name:'worker_index_search',arguments:{query:'find catalog'}});
                    if(!index.definitions.length)index=await tools.call({name:'worker_index_search',arguments:{query:'vendor.com'}});
                    const d=index.definitions[0];if(!d?.pointerId)throw Error('Missing indexed pointer');
                    const graph=await tools.call({name:'worker_index_describe',arguments:{toolDigest:d.toolDigest}});
                    if(graph.graph.totalSteps!==1||graph.graph.steps[0].method!=='GET'||graph.graph.nextOffset!==null)throw Error('Incomplete graph');
                    const replay=await tools.call({name:d.executeWith,arguments:{toolDigest:d.toolDigest,inputs:Object.fromEntries(d.inputs.map(i=>[i.name,'catalog']))}});
                    if(replay.status!=='completed')throw Error('Replay failed');return {citation,pointerId:d.pointerId,digest:d.toolDigest,replay};`
                  : "return await agents.run({text:'Use cited memory and the recorded catalog request to inspect current catalog evidence',scope:'browser',origins:['https://api.vendor.com'],placement:'independent'});",
              },
            },
      );
    },
  });
  const definitions = new Map<
    string,
    ReturnType<typeof createCodeChildActor>
  >();
  host = await createCloudflareAccountHost({
    storage: storage(),
    actorName: "aiko",
    actorInstance: "fixture",
    ownsThread: (thread) => thread === "user-123",
    allowChild: (parent, thread) =>
      parent === "user-123" && thread.startsWith("ag."),
    allowIndependentChildren: true,
    keyOf: workerEventKey,
    actorFor: (thread) => {
      let definition = definitions.get(thread);
      if (!definition) {
        definition =
          thread === "user-123"
            ? actor({
                name: "aiko",
                methods: { message: agentMessageMethod },
                components: [
                  infer([
                    codeMode([
                      harness(thread).package([]),
                      scopedAgentsPackage("123", {
                        scopes: ["research", "browser"],
                        readChild: (child) => host.read(child),
                      }),
                    ]),
                    outputValidateOnce,
                  ]),
                  followLogMemory(memory(thread)),
                ],
              })
            : createCodeChildActor(
                harness(thread),
                [
                  ...memoryTools(memory(thread), { fixtures: false }),
                  ...createObservedNetworkTools({
                    owner: "123",
                    thread,
                    redact,
                    readEvents: () => host.read("user-123"),
                    checkArcade: async () => true,
                    send: async (request) => {
                      requests++;
                      expect(request.url).toBe(
                        "https://api.vendor.com/catalog",
                      );
                      return {
                        status: 200,
                        headers: {},
                        classification: "application",
                        body: { catalog: ["FRESH_CATALOG_VALUE"] },
                      };
                    },
                  }),
                ],
                binding(thread),
              );
        definitions.set(thread, definition);
      }
      return definition;
    },
    layersFor: (thread) =>
      Layer.merge(
        harness(thread).inference(
          thread === "user-123"
            ? model
            : workerInference(model, binding(thread)),
        ),
        harness(thread).sandboxLayer(),
      ),
  });
  cleanup.push(() => host.close());
  await host.seed("user-123", [
    ...captured,
    {
      type: "AikoReplyPrepared",
      turn: "capture",
      result: { text: "Catalog capture indexed" },
      at: Date.now(),
    },
  ]);
  await host.wake("user-123");
  const stored = openMemory(memory("user-123"));
  try {
    expect(
      stored.recall({ search: "AikoRequestMemoryIndexed" }).items.length,
    ).toBeGreaterThan(0);
  } finally {
    stored.close();
  }
  await host.commitRoot(host.self("user-123"), {
    type: "MessageReceived",
    id: "worker-run",
    text: "Inspect catalog evidence",
    at: 1300,
  });
  await host.drive();
  expect(requests).toBe(1);
  expect(sawCitation).toBe(true);
  expect(sawFresh).toBe(true);
  const child = (await host.threads()).find((thread) =>
    thread.startsWith("ag."),
  )!;
  expect(
    (await host.read(child)).some((event) => event.type === "TurnCompleted"),
  ).toBe(true);
  expect(JSON.stringify(host.exportHistory())).not.toContain(
    "FRESH_CATALOG_VALUE",
  );
  expect(JSON.stringify(pointer.memory.exportArchive())).not.toContain(
    "FRESH_CATALOG_VALUE",
  );
  await host.recover();
  expect(requests).toBe(1);
});
