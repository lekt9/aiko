import { expect, test } from "bun:test";
import { fixture } from "./registry-host.test.ts";
import {
  defaultRegistryBinding,
  defaultReceivingAuthority,
} from "../src/registry-defaults.ts";
import { browserWatchHarnessDefinitions } from "../src/browser-watches.ts";
import { builtinHarnessDefinitions } from "../src/harness-builtins.ts";
import { harnessDigest } from "../src/harness-library.ts";
import { registryReadiness } from "../src/registry-host.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import type { WorkflowKV } from "../src/workflow-host.ts";
function kv(): WorkflowKV {
  const rows = new Map<string, unknown>();
  return {
    get: async (k) => rows.get(k),
    put: async (k, v) => {
      rows.set(k, v);
    },
    list: async (prefix) =>
      [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
    claim: async (k, v) => {
      if (rows.has(k)) return false;
      rows.set(k, v);
      return true;
    },
    update: async (k, change) => {
      rows.set(k, change(rows.get(k)));
    },
  };
}

test("actual account defaults register native seeds, execute, evaluate and use internal channels without custom registry factory", async () => {
  const jobs: any[] = [];
  const f = await fixture(true, {
    defaults: true,
    beforeJob: async (job) => {
      jobs.push(job);
    },
  });
  expect(f.readiness).toMatchObject({
    registry: true,
    experiments: false,
    optimizationReason: "shared_model_budget_or_trial_host_not_configured",
    sources: true,
    trustedVerifiers: true,
    internalChannels: true,
    codeMode: true,
    internalAuthorityRef: defaultReceivingAuthority("123"),
  });
  expect(
    (await f.events()).filter((e) => e.type.startsWith("AikoHarness")),
  ).toHaveLength(0);
  expect(jobs).toHaveLength(0);
  await f.run(`const catalog=await tools.call({name:"harness_list",arguments:{}});const echo=catalog.candidates.find(c=>c.name==="channel.text.echo");if(!echo)throw Error("Default seed missing");
 const checked=await tools.call({name:"harness_acquire",arguments:{name:"channel.text.echo",operationId:"default-acquire"}});if(checked.status!=="ready")throw Error("Default acquisition failed");
 const inputPort=await channels.bind({name:"default-in",schema:"text.message.v1",directions:["inbox","outbox"],authorityRef:"registry-internal:123",operationId:"default-in"});const outputPort=await channels.bind({name:"default-out",schema:"text.message.v1",directions:["inbox","outbox"],authorityRef:"registry-internal:123",operationId:"default-out"});
 const wire=await channels.connect({name:"default-wire",generation:1,input:{channel:inputPort.channel,generation:1},accepts:"text.message.v1",handler:{harness:echo.harnessDigest,contract:echo.contractDigest},output:{channel:outputPort.channel,generation:1,mode:"port"},authorityRef:"registry-internal:123",start:"after-registration",operationId:"default-wire"});if(wire.status!=="active")throw Error("Default handler unavailable");
 await channels.emit({port:{channel:inputPort.channel,generation:1},schema:"text.message.v1",value:{text:"controlled default input"},occurrence:"default-input",correlation:"default-task",authorityRef:"registry-internal:123"});
 const source=await tools.call({name:"harness_source_ingest",arguments:{repository:"fixture/double",ref:"main",paths:["index.js"],licensePath:"LICENSE",operationId:"default-source",expectedGeneration:0}});if(!source.snapshotDigest)throw Error("Default source unavailable");return "Default flow completed";`);
  let events = await f.events();
  expect(
    events.filter((e) => e.type === "AikoHarnessCandidateRecorded"),
  ).toHaveLength(builtinHarnessDefinitions().length);
  expect(events.some((e) => e.type === "AikoChannelWiringConnected")).toBe(
    true,
  );
  expect(
    events.some((e) => e.type === "AikoChannelWiringAccepted" && e.replyTo),
  ).toBe(true);
  expect(events.some((e) => e.type === "AikoHarnessSourceIngested")).toBe(true);
  expect(
    events.some((e) => e.type === "ToolReturned" && (e.result as any)?.error),
  ).toBe(false);
  expect(
    jobs
      .filter((j) => j.artifact.kind !== "network")
      .every(
        (j) =>
          j.authority.origins.length === 0 && j.authority.methods.length === 0,
      ),
  ).toBe(true);
  const count = jobs.length;
  await f.restart();
  await f.driveBackground();
  await f.run(`const existing=await tools.call({name:"harness_acquire",arguments:{name:"channel.text.echo",operationId:"default-after-reopen"}});if(existing.status!=="ready")throw Error("Recovered route unavailable");return "Recovered default route";`,"default_recovery_turn");
  events = await f.events();
  expect(events.some(e=>e.type==="AikoHarnessAcquisitionSettled"&&e.id==="default-after-reopen"&&e.status==="verified")).toBe(true);
  expect(events.some(e=>e.type==="AikoHarnessAcquisitionSettled"&&e.status==="ready")).toBe(false);
  expect(events.some(e=>e.type==="ToolReturned"&&(e.result as any)?.error)).toBe(false);
  expect(jobs).toHaveLength(count);
  expect(
    events.filter((e) => e.type === "AikoHarnessCandidateRecorded"),
  ).toHaveLength(builtinHarnessDefinitions().length);
});

test("default assembly denies missing transport, foreign tenant, changed grant and network artifacts", async () => {
  const storage = kv();
  let active = true,
    revision = "one",
    runtime = harnessDigest("runtime-one"),
    calls = 0;
  const options = {
    owner: "123",
    thread: "user-123",
    kv: storage,
    guard: () => {},
    policy: () => ({ owner: "123", active, revision }),
  };
  expect(
    registryReadiness(defaultRegistryBinding(options), false),
  ).toMatchObject({
    registry: false,
    internalChannels: false,
    reason: "sandbox_transport_not_configured",
  });
  const selected = defaultRegistryBinding({
    ...options,
    transport: {
      placement: "local",
      codeTransport: runCodeSegment,
      sandbox: {
        harnessEnvironment: async () => runtime,
        harnessJob: async () => {
          calls++;
          throw Error("unexpected dispatch");
        },
      },
    },
  });
  const signal = new AbortController().signal,
    library = selected.library!,
    context = await library.context(signal);
  revision = "two";
  expect(harnessDigest(await library.context(signal))).not.toBe(
    harnessDigest(context),
  );
  runtime = harnessDigest("runtime-two");
  expect((await library.context(signal)).runtimeDigest).toBe(runtime);
  expect(
    await selected.authorizeReceiving!(
      "other",
      defaultReceivingAuthority("123"),
      "emit",
      {},
    ),
  ).toBe(false);
  expect(
    await selected.authorizeReceiving!(
      "123",
      "candidate-origin-grant",
      "emit",
      {},
    ),
  ).toBe(false);
  active = false;
  expect(registryReadiness(selected, true).internalChannels).toBe(false);
  await expect(library.context(signal)).rejects.toThrow();
  active = true;
  const builtin = builtinHarnessDefinitions()[0]!;
  await expect(
    library.authorize(
      { ...builtin.artifact, runtime: "network" },
      builtin.contract,
      await library.context(signal),
      {},
      signal,
    ),
  ).rejects.toThrow("pure JavaScript");
  const evaluationContext = await library.context(signal);
  expect(await library.authorizeEvaluation!(builtin.artifact,builtin.contract,evaluationContext,builtin.verifier.cases[0]!,signal)).toBe(true);
  expect(await library.authorizeEvaluation!(builtin.artifact,builtin.contract,evaluationContext,{...builtin.verifier.cases[0]!,input:{candidate:"self-chosen"}},signal)).toBe(false);
  expect(await library.authorizeEvaluation!(builtin.artifact,{...builtin.contract,effect:"write"},evaluationContext,builtin.verifier.cases[0]!,signal)).toBe(false);
  active=false;
  await expect(library.authorizeEvaluation!(builtin.artifact,builtin.contract,evaluationContext,builtin.verifier.cases[0]!,signal)).rejects.toThrow();
  active=true;
  expect(calls).toBe(0);
  const ref = await library.blobs.putPrivate("123", { text: "private" });
  await expect(library.blobs.get("456", ref)).rejects.toThrow();
  expect(() =>
    defaultRegistryBinding({ ...options, thread: "user-456" }),
  ).toThrow();
});
test("custom registry override can explicitly disable defaults even with an available sandbox", async () => {
  let custom = 0;
  const f = await fixture(true, {
    defaults: true,
    overrides: {
      registry: () => {
        custom++;
        return undefined;
      },
    },
  });
  expect(custom).toBe(1);
  expect(f.readiness).toMatchObject({
    registry: false,
    sources: false,
    internalChannels: false,
  });
  expect((await f.events()).some((e) => e.type.startsWith("AikoHarness"))).toBe(
    false,
  );
});

test("configured live Bun key selects a lazy default adapter; disabled codeMode performs no registry work", async () => {
  const f = await fixture(false, {
    config: { mode: "live", modelKey: "controlled-key-no-provider-call" },
  });
  expect(f.readiness).toMatchObject({
    registry: true,
    sources: true,
    trustedVerifiers: true,
    codeMode: true,
  });
  expect(await f.events()).toHaveLength(0);
  const disabled = await fixture(false, {
    config: {
      mode: "live",
      modelKey: "controlled-key-no-provider-call",
      codeMode: false,
    },
  });
  expect(disabled.readiness).toMatchObject({
    registry: false,
    internalChannels: false,
    reason: "code_mode_disabled",
  });
  expect(await disabled.events()).toHaveLength(0);
});


test("watch mapper evaluation needs an enabled host bridge and fixed fixtures; registering it grants no browser source", async () => {
  let active = true, calls = 0;
  const options = {
    owner:"123", thread:"user-123", kv:kv(), guard:()=>{},
    policy:()=>({owner:"123",active,revision:"watch-fixture"}),
    transport:{placement:"local" as const,codeTransport:runCodeSegment,sandbox:{
      harnessEnvironment:async()=>harnessDigest("watch-runtime"),
      harnessJob:async()=>{calls++;throw Error("unexpected dispatch");},
    }},
  };
  const disabled=defaultRegistryBinding(options), enabled=defaultRegistryBinding({...options,browserWatches:true});
  const definition=browserWatchHarnessDefinitions()[0]!, signal=AbortSignal.timeout(1000);
  const context=await enabled.library!.context(signal);
  expect(await disabled.library!.authorizeEvaluation!(definition.artifact,definition.contract,context,definition.verifier.cases[0]!,signal)).toBe(false);
  expect(await enabled.library!.authorizeEvaluation!(definition.artifact,definition.contract,context,definition.verifier.cases[0]!,signal)).toBe(true);
  expect(await enabled.library!.authorizeEvaluation!(definition.artifact,definition.contract,context,{...definition.verifier.cases[0]!,input:{forged:"fixture"}},signal)).toBe(false);
  expect(enabled.logSources!.grants()).toEqual([]);
  expect(enabled.logSources!.current()).toBe(true);
  active=false;
  expect(enabled.logSources!.current()).toBe(false);
  await expect(enabled.library!.authorizeEvaluation!(definition.artifact,definition.contract,context,definition.verifier.cases[0]!,signal)).rejects.toThrow();
  expect(calls).toBe(0);
});
