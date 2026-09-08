import { channelHydrate } from "../src/channel-custody.ts";
import type { HarnessJsonValue } from "@unbrowse/browser-harness/harness-runtime";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import {
  HarnessLibrary,
  harnessBlobStore,
  harnessDigest,
  type HarnessContract,
  type HarnessLibraryBinding,
} from "../src/harness-library.ts";
import { createHarnessSandboxBinding } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { sandboxSourceTransport } from "../src/harness-source-sandbox.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import {
  registryExternalEventAllowed,
  checkedRegistryBinding,
  registryReadiness,
} from "../src/registry-host.ts";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const token = "aiko_registry_test_123456789012345678901234567890";
export async function fixture(
  configured = true,
  settings: {
    text?: boolean;
    defaults?: boolean;
    config?: Partial<AikoConfig>;
    beforeJob?: (
      job: import("../src/sandbox-job.ts").SandboxJob,
    ) => Promise<void>;
    overrides?: NonNullable<Parameters<typeof createService>[1]>;
  } = {},
) {
  const dir = await mkdtemp("/tmp/registry-host-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, "sandbox.sqlite"));
  cleanup.push(async () => db.close());
  const revision = "1".repeat(40),
    files: Record<string, string> = {
      "index.js": settings.text
        ? "export default input => ({text:input.value.text+input.value.text});"
        : "export default input => ({n:input.value.n*2});",
      LICENSE: "MIT fixture license",
    };
  let requests = 0;
  const environment = await sandboxEnvironment("host-registry-fixture");
  const sandbox = localHarnessSandbox({
    owner: "123",
    environmentDigest: environment,
    journal: await sandboxJobJournal(db, join(dir, "sandbox-key")),
    send: async (request) => {
      requests++;
      const url = new URL(request.url);
      let body: HarnessJsonValue;
      if (url.pathname === "/repos/fixture/double")
        body = { full_name: "fixture/double" };
      else if (url.pathname.includes("/commits/")) body = { sha: revision };
      else {
        const path = url.pathname.includes("/contents/")
            ? url.pathname.split("/contents/")[1]!
            : "LICENSE",
          value = files[path];
        if (value === undefined) throw Error("fixture source absent");
        const b = Buffer.from(value);
        body = {
          type: "file",
          path,
          encoding: "base64",
          content: b.toString("base64"),
          size: b.length,
          sha: createHash("sha1")
            .update(`blob ${b.length}\0`)
            .update(b)
            .digest("hex"),
          license: { spdx_id: "MIT" },
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
        classification: "application",
      };
    },
  });
  const runJob = sandbox.harnessJob;
  sandbox.harnessJob = async (job, signal) => {
    await settings.beforeJob?.(job);
    return runJob(job, signal);
  };
  const options = {
    owner: "123",
    thread: "user-123",
    placement: "local" as const,
    sandbox,
    current: async () => ({
      owner: "123",
      active: true,
      runtimeDigest: environment,
      contextRef: "fixture-context",
      authorityRef: "source-grant",
      sessionRevision: null,
      effects: ["read" as const],
      origins: ["https://api.github.com"],
      methods: ["GET"],
      budget: { requests: 8, wallMs: 5000, outputBytes: 262144 },
    }),
  };
  const verifier: import("../src/harness-library.ts").HarnessVerifier = {
    digest: harnessDigest("host-double-verifier"),
    evaluatorDigest: harnessDigest("host-double-cases"),
    cases: [
      {
        id: "positive",
        input: {
          value: settings.text ? { text: "four" } : { n: 4 },
          schema: "number.input",
          correlation: "fixture",
        },
        split: "development" as const,
      },
      {
        id: "negative",
        input: {
          value: settings.text ? { text: "negative" } : { n: -7 },
          schema: "number.input",
          correlation: "fixture",
        },
        split: "held-out" as const,
      },
    ],
    verify: async ({ input, output }: any) => ({
      passed: settings.text
        ? output?.text === input.value.text + input.value.text
        : output?.n === input.value.n * 2,
      evidence: ["independent-double-check"],
      quality: 1,
    }),
  };
  const skillStores: import("tardie/core/event").Event[][] = [];
  let binding!: HarnessLibraryBinding,
    code = "",
    models = 0;
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
    react: (request) => {
      models++;
      if (
        !request.trajectory.some(
          (e) => e.type === "ToolReturned" && e.turn === request.identity.turn,
        )
      )
        return Effect.succeed({
          kind: "call" as const,
          name: "execute",
          callId: `host-program:${request.identity.turn}`,
          arguments: { code },
        });
      return Effect.succeed({
        kind: "complete" as const,
        output: "Fixture completed",
      });
    },
  });
  const config: AikoConfig = {
    mode: "demo",
    codeMode: true,
    port: 4242,
    stateDir: dir,
    operatorToken: "private-registry-fixture-12345678901234",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123"]),
    ...settings.config,
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(token),
        scopes: ["read", "write"],
      },
    ],
  };
  const ownedCredentials = config.planeCredentials, ownedAllowedUsers = config.allowedUsers;
  const overrides = {
    model,
    ...settings.overrides,
    ...(settings.defaults
      ? {
          registrySandbox: () => ({
            sandbox,
            codeTransport: runCodeSegment,
            placement: "local" as const,
          }),
        }
      : configured
        ? {
            registry: ({ owner, thread, kv }: any) => {
              const blobs = harnessBlobStore(kv),
                put = blobs.put;
              blobs.put = async (owner, value) => {
                if (
                  typeof value === "string" &&
                  value.includes("Callable method:") &&
                  value.includes("harness_run")
                )
                  skillStores.push([...(await service.host.read(thread))]);
                return put(owner, value);
              };
              binding = {
                owner,
                thread,
                blobs,
                verifiers: new Map([[verifier.digest, verifier]]),
                guard: () => {},
                ...createHarnessSandboxBinding(options),
              };
              return {
                library: binding, // Legacy fallback must not duplicate source registry tools.
                sources: {
                  library: binding,
                  transport: sandboxSourceTransport(options),
                  authorize: async (repo: string) => repo === "fixture/double",
                },
                codeTransport: runCodeSegment,
                authorizeReceiving: async (bound: string, grant: string) =>
                  bound === "123" && grant === "receiving-fixture",
              };
            },
          }
        : {}),
  };
  let service = await createService(config, overrides);
  cleanup.push(() => service.close());
  const request = (path: string, body?: unknown) =>
    service.fetch(
      new Request("http://127.0.0.1:4242" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const readiness = await (await request("/api/harness/readiness")).json();
  return {
    nativeHost: () => service.host,
    stateDir: dir,
    setOwnerAuthorized: (active: boolean) => {
      config.planeCredentials = active ? ownedCredentials : [];
      config.allowedUsers = active ? ownedAllowedUsers : new Set([...ownedAllowedUsers].filter(owner => owner !== "123"));
    },
    request,
    skillStores,
    readThread: (thread: string) => service.host.read(thread),
    driveBackground: async () => {
      await service.host.wake("background-123-indexer");
      await service.host.wake("user-123");
      await service.host.wake("background-123-indexer");
    },
    raw: (request: Request) => service.fetch(request),
    readiness,
    requests: () => requests,
    models: () => models,
    events: () => service.host.read("user-123"),
    binding: () => binding,
    trace: async () => ({
      threads: await Promise.all(
        (await service.host.threads()).map(async (thread) => ({
          thread,
          events: await service.host.read(thread),
        })),
      ),
      actor: await service.host.readActorPage(0, 100000),
    }),
    append: async (events: import("tardie/core/event").Event[]) => {
      await service.host.seed("user-123", events);
    },
    erasePrivate: (ref: string) => {
      const storage = new Database(join(dir, "workflows.sqlite"));
      try {
        storage
          .query("DELETE FROM workflow_records WHERE key=?")
          .run(`harness-blobs:${harnessDigest("123")}:${ref}`);
      } finally {
        storage.close();
      }
    },
    disk: async () => {
      const chunks: Buffer[] = [];
      const visit = async (path: string) => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (/\.(sqlite|db)(-wal|-shm)?$/.test(entry.name))
            chunks.push(await readFile(file));
        }
      };
      await visit(dir);
      return Buffer.concat(chunks).toString("utf8");
    },
    seed: async () => {
      await service.host.commitRoot(service.host.self("user-123"), {
        type: "AikoAccountOpened",
        id: "account",
        at: Date.now(),
      });
      const valueSchema: Record<
        string,
        import("../src/harness-library.ts").HarnessJson
      > = {
        type: "object",
        properties: settings.text
          ? { text: { type: "string" } }
          : { n: { type: "number" } },
        required: [settings.text ? "text" : "n"],
        additionalProperties: false,
      };
      const contract: HarnessContract = {
        version: 1,
        outcome: "Double the typed input",
        inputSchema: {
          type: "object",
          properties: {
            value: valueSchema,
            schema: { type: "string" },
            correlation: { type: "string" },
          },
          required: ["value", "schema", "correlation"],
          additionalProperties: false,
        },
        outputSchema: valueSchema,
        effect: "read",
        verifierDigest: verifier.digest,
        evaluatorDigest: verifier.evaluatorDigest,
        applicability: {
          hook: {
            accepts: "number.input",
            emits: "number.output",
            inputSchema: valueSchema,
            effects: ["pure"],
          },
        },
        timeoutMs: 5000,
      };
      return new HarnessLibrary(binding, {
        read: () => service.host.read("user-123"),
        append: (events) => service.host.seed("user-123", events),
      }).registerContract(contract);
    },
    run: async (program: string, id = "registry_fixture_turn") => {
      code = program;
      expect(
        (
          await request("/api/messages", {
            id,
            text: "Run the controlled registry fixture.",
          })
        ).status,
      ).toBe(202);
      await service.host.wake("user-123");
    },
    restart: async () => {
      await service.close();
      service = await createService(config, overrides);
      await service.host.wake("user-123");
    },
    drive: () => service.host.wake("user-123"),
  };
}

export function registryProgram(
  contract: string,
  suffix = 'return "emitted";',
) {
  return `
 const s=await tools.call({name:"harness_source_ingest",arguments:{repository:"fixture/double",ref:"main",paths:["index.js"],licensePath:"LICENSE",operationId:"host-source",expectedGeneration:0}});
 if(!s.snapshotDigest)throw Error(JSON.stringify(s));
 const c=await tools.call({name:"harness_source_derive",arguments:{snapshotDigest:s.snapshotDigest,options:{name:"host.double",description:"fixture handler",contractDigest:"${contract}",kind:"code",entrypoint:"index.js"}}});
 await tools.call({name:"harness_evaluate",arguments:{digest:c.harnessDigest,evaluationId:"host-evaluation"}});
 await tools.call({name:"harness_promote",arguments:{digest:c.harnessDigest,evaluationId:"host-evaluation",expectedGeneration:0}});
 const inlet=await channels.bind({name:"fixture-input",schema:"number.input",directions:["inbox","outbox"],authorityRef:"receiving-fixture",operationId:"input"});
 const outlet=await channels.bind({name:"fixture-output",schema:"number.output",directions:["inbox","outbox"],authorityRef:"receiving-fixture",operationId:"output"});
 if(!c.harnessDigest)throw Error(JSON.stringify(c));
 const wire=await channels.connect({name:"double-handler",generation:1,input:{channel:inlet.channel,generation:inlet.generation},accepts:"number.input",handler:{harness:c.harnessDigest,contract:"${contract}"},output:{channel:outlet.channel,generation:outlet.generation,mode:"port"},authorityRef:"receiving-fixture",start:"after-registration",operationId:"connect"});
 if(wire.status!=="active")throw Error(JSON.stringify(wire));
 await channels.emit({port:{channel:inlet.channel,generation:inlet.generation},schema:"number.input",value:{n:9},occurrence:"fixture-9",correlation:"task-9",authorityRef:"receiving-fixture"});
 ${suffix}`;
}

test("actual account codeMode ingests source, verifies registry handler and connects typed ports", async () => {
  const f = await fixture();
  expect(f.readiness).toMatchObject({
    registry: true,
    sources: true,
    trustedVerifiers: true,
    internalChannels: true,
    codeMode: true,
  });
  const contract = await f.seed();
  await f.run(registryProgram(contract));
  const events = await f.events();
  expect(events.some((e) => e.type === "AikoHarnessSourceIngested")).toBe(true);
  expect(events.some((e) => e.type === "AikoChannelWiringConnected")).toBe(
    true,
  );
  const output = events.find(
    (e) => e.type === "AikoChannelWiringAccepted" && e.replyTo,
  );
  expect(output).toBeDefined();
  expect(
    await channelHydrate(f.binding().blobs, "123", output!.valueRef),
  ).toEqual({ n: 18 });
  expect(JSON.stringify(events)).not.toContain('"n":18');
  expect(JSON.stringify(events)).not.toContain("export default input");
  expect(JSON.stringify(events)).not.toContain(token);
  const count = f.requests(),
    models = f.models();
  await f.restart();
  expect(f.requests()).toBe(count);
  expect(f.models()).toBe(models);
});

test("unconfigured hosts report unavailable registry and internal channels without a fabricated provider", async () => {
  const f = await fixture(false);
  expect(f.readiness).toMatchObject({
    registry: false,
    sources: false,
    trustedVerifiers: false,
    internalChannels: false,
    codeMode: false,
    reason: "sandbox_transport_not_configured",
  });
  for (const e of [
    { type: "AikoChannelWiringConnected" },
    { type: "AikoChannelBridgeBound" },
    { type: "AikoChannelReceived" },
    { type: "BlockedOn" },
    { type: "AikoHarnessChecked" },
    { type: "MessageReceived", source: "channel-waiter" },
  ])
    expect(registryExternalEventAllowed(e)).toBe(false);
});

test("trusted registry configuration rejects foreign custody and reports missing verifiers", async () => {
  const f = await fixture();
  const library = f.binding();
  expect(() => checkedRegistryBinding("other", { library })).toThrow(
    "Registry owner binding mismatch",
  );
  expect(() =>
    checkedRegistryBinding("123", {
      library: { ...library, thread: "user-other" },
    }),
  ).toThrow("Registry owner binding mismatch");
  expect(
    registryReadiness(
      {
        library: { ...library, verifiers: new Map() },
        authorizeReceiving: async () => true,
      },
      true,
    ),
  ).toMatchObject({
    trustedVerifiers: false,
    internalChannels: false,
    reason: "trusted_verifiers_not_configured",
  });
});

test("actual account native alarm settles a parked channel waiter after host reopen", async () => {
  const f = await fixture(),
    contract = await f.seed();
  await f.run(
    registryProgram(
      contract,
      `return await channels.wait({port:{channel:outlet.channel,generation:outlet.generation},handler:{harness:c.harnessDigest,contract:"${contract}"},schema:"number.output",correlation:"never-emitted",deadline:Date.now()+1200,authorityRef:"receiving-fixture"});`,
    ),
  );
  expect((await f.events()).some((e) => e.type === "BlockedOn")).toBe(true);
  expect(
    (await f.events()).some((e) => e.type === "AikoHostedChannelDeadline"),
  ).toBe(true);
  const count = f.requests();
  await f.restart();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await f.drive();
  const events = await f.events();
  expect(
    events.filter((e) => e.type === "AikoChannelWiringWaitReady"),
  ).toHaveLength(1);
  expect(
    events.filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(1);
  expect(f.requests()).toBe(count);
});

test("actual foreground response gates passive SKILL derivation and indexes structural evidence once", async () => {
  const f = await fixture(),
    contract = await f.seed();
  await f.run(
    registryProgram(
      contract,
      `const early=await tools.call({name:"harness_skill",arguments:{digest:c.harnessDigest}});if(early.status!=="pending")throw Error("SKILL was compiled before foreground response");return "completed";`,
    ),
  );
  await f.driveBackground();
  const foreground = await f.events(),
    background = await f.readThread("background-123-indexer");
  const available = foreground.filter(
    (e) => e.type === "AikoHarnessSkillAvailable",
  );
  expect(available).toHaveLength(1);
  expect(f.skillStores).toHaveLength(1);
  for (const atStore of f.skillStores)
    expect(
      atStore.some(
        (e) =>
          ["TurnCompleted", "AikoReplyPrepared"].includes(e.type) &&
          e.turn === "local:registry_fixture_turn",
      ),
    ).toBe(true);
  expect(
    background.filter((e) => e.type === "AikoHarnessSkillDerived"),
  ).toHaveLength(1);
  const library = new HarnessLibrary(f.binding(), {
    read: f.events,
    append: async () => {
      throw Error("read only");
    },
  });
  const document = await library.skill(available[0]!.harnessDigest as any);
  expect(document).toMatchObject({
    status: "evaluated",
    visibility: "private",
  });
  expect((await library.list()).skills).toHaveLength(1);
  expect(JSON.stringify(document)).not.toContain("export default input");
  const indexed = background.filter(
    (e) => e.type === "AikoLearningIndexed" && String(e.id).includes("skill:"),
  );
  expect(indexed).toHaveLength(1);
  const snapshots = background.filter(
    (e) => e.type === "AikoKnowledgeChanged" && e.id === indexed[0]!.id,
  );
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]!.root).toMatch(/^[a-f0-9]{64}$/);
  expect(
    foreground.some(
      (e) =>
        e.type === "ToolReturned" &&
        String(e.callId).startsWith("host-program:") &&
        (e.result as any)?.error,
    ),
  ).toBe(false);
  const replies = foreground.filter(
      (e) => e.type === "AikoReplyPrepared",
    ).length,
    models = f.models();
  await f.restart();
  await f.driveBackground();
  expect(
    (await f.readThread("background-123-indexer")).filter(
      (e) =>
        e.type === "AikoLearningIndexed" && String(e.id).includes("skill:"),
    ),
  ).toHaveLength(1);
  expect(
    (await f.events()).filter((e) => e.type === "AikoReplyPrepared"),
  ).toHaveLength(replies);
  expect(f.models()).toBe(models);
  expect(f.skillStores).toHaveLength(1);
});
