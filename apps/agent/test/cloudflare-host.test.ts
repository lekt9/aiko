import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { Effect, Layer } from "effect";
import { actor } from "tardie";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Router } from "tardie/core/communication/router";
import { Self } from "tardie/core/runtime";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { childLineageOf, threadCreatedOf } from "tardie/core/thread";
import { createControlActor, telegramControl } from "../src/telegram-control.ts";
import { createVoice } from "../src/voice.ts";
import { threadBinding } from "../src/account-binding.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";

const databases: Database[] = [];

test("Cloudflare control lane responds while another native effect is blocked", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const replies: string[] = [];
  const foreground = actor({ name: "aiko", methods: {}, components: [component({
    name: "blocked-browser", initial: () => false,
    step: (done, e) => done || e.type === "WorkDone",
    output: done => ({ view: undefined, transitions: done ? [] : [effect({
      key: "browser", input: null, act: () => Effect.promise(async () => { started = true; await pending; return [{type:"WorkDone", at:Date.now()}]; }),
    })] }),
  })] });
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const control = createControlActor({ owner:"123", live:true, redact:text=>text,
    voice:createVoice({enabled:true,persona:"fixture",required:true,compose:async text=>({status:"ready",text,persona:"fixture"})}),
    send:async (_owner,text)=>{replies.push(text);return {status:"delivered"};},
    publish:rows=>host.seed("user-123",rows),
  });
  host = await createCloudflareAccountHost({ storage:storage(),actorName:"aiko",actorInstance:"demo",
    ownsThread:t=>threadBinding(t)?.owner==="123",actorFor:t=>t==="control-123"?control:foreground,layersFor:()=>Layer.empty,
  });
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"work",at:Date.now()});
  const driving = host.drive();
  try {
    for(let i=0;!started&&i<100;i++)await Bun.sleep(5);
    expect(started).toBe(true);
    await telegramControl(host,"123","status","what's happening?",true,true,undefined,{separateLane:true});
    for(let i=0;!replies.length&&i<100;i++)await Bun.sleep(5);
    expect(replies[0]).toContain("unfinished request");
    expect((await host.read("user-123")).some(e=>e.type==="WorkDone")).toBe(false);
  } finally {release();await driving;}
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function storage(): AccountStorage {
  const db = new Database(":memory:");
  databases.push(db);
  let alarm: number | null = null;
  return {
    sql: {
      exec: (query, ...bindings) => {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          );
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
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

const keyOf = (e: { type: string; [name: string]: unknown }) =>
  typeof e.id === "string" ? `${e.type}:${e.id}` : undefined;

test("scoped native threads route durably, preserve identity, and recover without duplicate effects", async () => {
  const durable = storage();
  let actions = 0;
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [
      component({
        name: "test-routing",
        keys: {
          prefixes: ["Done:"],
          keyOf: (e) => (e.type === "Done" ? `Done:${e.id}` : undefined),
        },
        initial: () => ({ events: [] as Record<string, unknown>[] }),
        step: (state, e) => ({ events: [...state.events, e] }),
        output: (state) => ({
          view: undefined,
          transitions: state.events
            .filter(
              (e) =>
                e.type === "Input" &&
                !state.events.some((d) => d.type === "Done" && d.id === e.id),
            )
            .map((e) =>
              effect({
                key: `Done:${e.id}`,
                input: e,
                act: (input) =>
                  Effect.gen(function* () {
                    actions++;
                    const self = yield* Self;
                    if (self.thread === "user-123") {
                      const router = yield* Router;
                      const target = {
                        ...self,
                        thread: "background-123-indexer",
                      };
                      const created = threadCreatedOf(state.events as never)!;
                      yield* router.send(
                        envelopeOf(
                          linkOf(self, target),
                          { type: "Input", id: input.id, at: 10 },
                          childLineageOf(created, "colocated"),
                        ),
                      );
                    }
                    return [{ type: "Done", id: input.id, at: 20 }];
                  }),
              }),
            ),
        }),
      }),
    ],
  });
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) =>
      ["user-123", "background-123-indexer"].includes(t),
    actorFor: () => definition,
    layersFor: () => Layer.empty,
    keyOf,
  };
  let host = await createCloudflareAccountHost(options);
  await host.commitRoot(host.self("user-123"), {
    type: "Input",
    id: "same",
    at: 1,
  });
  expect(await durable.getAlarm()).not.toBeNull();
  await host.drive();
  expect(actions).toBe(2);
  expect(await host.threads()).toEqual(["background-123-indexer", "user-123"]);
  expect((await host.read("background-123-indexer"))[0]).toMatchObject({
    type: "ThreadCreated",
    parent: { thread: "user-123" },
    depth: 1,
  });
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.recover();
  await host.commitRoot(host.self("user-123"), {
    type: "Input",
    id: "same",
    at: 99,
  });
  await host.drive();
  expect(actions).toBe(2);
  expect((await host.readPage("user-123", 0, 2)).map((e) => e.seq)).toEqual([
    1, 2,
  ]);
  await expect(host.read("user-456")).rejects.toThrow("outside");
  await expect(
    host.commit(
      envelopeOf(
        linkOf(
          { actor: "aiko", instance: "demo", thread: "user-456" },
          { actor: "aiko", instance: "demo", thread: "user-123" },
        ),
        { type: "Input", id: "foreign", at: 1 },
      ),
    ),
  ).rejects.toThrow("outside");
  await expect(
    createCloudflareAccountHost({ ...options, actorInstance: "other" }),
  ).rejects.toThrow("identity");
  await host.close();
});

test("history seed is no-drive, pending input survives host eviction and alarm recovery", async () => {
  const durable = storage();
  let calls = 0;
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [
      component({
        name: "test-count",
        keys: {
          prefixes: ["Done:"],
          keyOf: (e) => (e.type === "Done" ? `Done:${e.id}` : undefined),
        },
        initial: () => ({ pending: [] as string[] }),
        step: (state, e) => ({
          pending:
            e.type === "Input"
              ? [...state.pending, String(e.id)]
              : e.type === "Done"
                ? state.pending.filter((id) => id !== e.id)
                : state.pending,
        }),
        output: (state) => ({
          view: undefined,
          transitions: state.pending.map((id) =>
            effect({
              key: `Done:${id}`,
              input: id,
              act: (id) =>
                Effect.sync(() => {
                  calls++;
                  return [{ type: "Done", id, at: 2 }];
                }),
            }),
          ),
        }),
      }),
    ],
  });
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => t === "user-123",
    actorFor: () => definition,
    layersFor: () => Layer.empty,
    keyOf,
  };
  let host = await createCloudflareAccountHost(options);
  await host.seed("user-123", [
    { type: "Input", id: "history", at: 1 },
    { type: "Done", id: "history", at: 2 },
  ]);
  expect(calls).toBe(0);
  expect(await durable.getAlarm()).toBeNull();
  await host.commitRoot(host.self("user-123"), {
    type: "Input",
    id: "new",
    at: 3,
  });
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.alarm();
  expect(calls).toBe(1);
  expect(
    (await host.read("user-123")).filter((e) => e.type === "Done"),
  ).toHaveLength(2);
  expect(await host.resting()).toBe(true);
  await host.close();
});

test("fresh-account history and native memory sidecar import atomically without driving or replay", async () => {
  const durable = storage();
  durable.sql.exec("CREATE TABLE native_memory(value TEXT)");
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => t === "user-123",
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
    keyOf,
  };
  const source = await createCloudflareAccountHost({
    ...options,
    storage: storage(),
  });
  await source.seed("user-123", [{ type: "Archived", id: "original", at: 1 }]);
  const histories = source.exportHistory();
  let host = await createCloudflareAccountHost(options);
  await expect(
    host.importHistory("migration-1", histories, {
      fingerprint: "original-memory",
      import: () => {
        durable.transactionSync(() =>
          durable.sql.exec(
            "INSERT INTO native_memory VALUES(?)",
            "rolled-back",
          ),
        );
        throw new Error("Memory archive is invalid");
      },
    }),
  ).rejects.toThrow("invalid");
  expect(await host.threads()).toEqual([]);
  expect(durable.sql.exec("SELECT * FROM native_memory").toArray()).toEqual([]);
  expect(await durable.getAlarm()).toBeNull();
  let imports = 0;
  const sidecar = {
    fingerprint: "original-memory",
    import: () => {
      imports++;
      durable.transactionSync(() =>
        durable.sql.exec("INSERT INTO native_memory VALUES(?)", "restored"),
      );
    },
  };
  expect(await host.importHistory("migration-1", histories, sidecar)).toBe(
    "imported",
  );
  expect(host.exportHistory()).toEqual(histories);
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
  host = await createCloudflareAccountHost(options);
  expect(await host.importHistory("migration-1", histories, sidecar)).toBe(
    "duplicate",
  );
  expect(imports).toBe(1);
  expect(durable.sql.exec("SELECT * FROM native_memory").toArray()).toEqual([
    { value: "restored" },
  ]);
  await expect(
    host.importHistory("migration-1", histories, {
      ...sidecar,
      fingerprint: "different-memory",
    }),
  ).rejects.toThrow("conflict");
  expect(imports).toBe(1);
  await host.close();
  await source.close();
});

test("native recovery preserves an external durable idle deadline across eviction", async () => {
  const durable = storage();
  let nextWake: number | undefined = Date.now() + 240_000;
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => t === "user-123",
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
    keyOf,
    nextWake: async () => nextWake,
  };
  let host = await createCloudflareAccountHost(options);
  await host.commitRoot(host.self("user-123"), {
    type: "Archived",
    id: "wake",
    at: 1,
  });
  await host.drive();
  expect(await durable.getAlarm()).toBe(nextWake!);
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.recover();
  expect(await durable.getAlarm()).toBe(nextWake!);
  nextWake = undefined;
  await host.alarm();
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
});

test("concurrent first child deliveries validate persisted lineage after arming recovery", async () => {
  const durable = storage();
  const host = await createCloudflareAccountHost({
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) =>
      [
        "user-123",
        "background-123-indexer",
        "background-123-reflection",
      ].includes(t),
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
    keyOf,
  });
  const foreground = { actor: "aiko", instance: "demo", thread: "user-123" },
    indexer = { ...foreground, thread: "background-123-indexer" },
    reflection = { ...foreground, thread: "background-123-reflection" };
  await host.commitRoot(host.self(foreground.thread), {
    type: "Archived",
    id: "parent",
    at: 1,
  });
  await host.commitRoot(host.self(reflection.thread), {
    type: "Archived",
    id: "other-parent",
    at: 1,
  });
  const results = await Promise.allSettled([
    host.commit(
      envelopeOf(
        linkOf(foreground, indexer),
        { type: "Archived", id: "first", at: 2 },
        { parent: foreground, depth: 1, placement: "colocated" },
      ),
    ),
    host.commit(
      envelopeOf(
        linkOf(reflection, indexer),
        { type: "Archived", id: "second", at: 2 },
        { parent: reflection, depth: 1, placement: "colocated" },
      ),
    ),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    (await host.read(indexer.thread)).filter((e) => e.type === "Archived"),
  ).toHaveLength(1);
  await host.close();
});

// Exercise the real Worker router in Bun without constructing workerd objects.
// Platform, browser trace handlers and VM assembly are traps; actual routing,
// configuration, operator authentication and WebCrypto remain unchanged.
let attestationWorker:
  | Promise<{
      fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
    }>
  | undefined;
function workerForAttestation() {
  return (attestationWorker ??= (async () => {
    const built = await Bun.build({
      entrypoints: [new URL("../src/cloudflare.ts", import.meta.url).pathname],
      target: "bun",
      format: "esm",
      conditions: ["workerd"],
      external: ["node:*"],
      plugins: [
        {
          name: "attestation-platform-traps",
          setup(builder) {
            builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "workers",
              namespace: "attestation-trap",
            }));
            builder.onResolve(
              { filter: /cloudflare-capabilities\.ts$/ },
              () => ({ path: "capabilities", namespace: "attestation-trap" }),
            );
            builder.onResolve(
              {
                filter: /^@unbrowse\/browser-runtime\/(?:trace|network-facts)$/,
              },
              () => ({ path: "trace", namespace: "attestation-trap" }),
            );
            builder.onLoad(
              { filter: /.*/, namespace: "attestation-trap" },
              ({ path }) => ({
                loader: "js",
                contents:
                  path === "workers"
                    ? 'export class DurableObject { constructor() { throw new Error("Attestation must not construct a Durable Object"); } }'
                    : path === "trace"
                      ? 'const fail=()=>{throw new Error("Attestation must not use browser traces");}; export const browserTraceKeys={keyOf:fail}; export const harKeys={keyOf:fail}; export const decodeBrowserTraceEvent=fail; export const browserRequestEvidenceIdOf=fail; export const assertNetworkSnapshotBackedByLog=fail; export const networkGraphCheckpointOf=fail; export const validatedHarCaptureFactsOf=fail;'
                      : 'export function createCloudflareCapabilities() { throw new Error("Attestation must not allocate a VM or call a provider"); }',
              }),
            );
          },
        },
      ],
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const moduleUrl = URL.createObjectURL(
      new Blob([await built.outputs[0]!.text()], {
        type: "application/javascript",
      }),
    );
    try {
      return (await import(moduleUrl)).default;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  })());
}
function attestationFixture() {
  let namespaceAccesses = 0;
  const namespace = {
    getByName() {
      namespaceAccesses++;
      throw new Error("Attestation must not access account storage");
    },
  };
  const operator = "private-operator-attestation-fixture-1234567890";
  const account = "private-account-attestation-fixture-1234567890";
  const env: Record<string, unknown> = {
    AIKO_ACCOUNTS: namespace,
    AIKO_REGISTRY: namespace,
    AIKO_MODE: "live",
    AIKO_INSTANCE_ID: "demo",
    CODEGRAFF_API_KEY: "private-provider-attestation-fixture",
    AIKO_OPERATOR_TOKEN: operator,
    AIKO_BOT_TOKEN: "987654321:private_bot_attestation_fixture_1234567890",
    AIKO_WEBHOOK_SECRET: "private_webhook_attestation_fixture_1234567890",
    AIKO_ALLOWED_USERS: "123",
    AIKO_PLANE_CREDENTIALS: JSON.stringify([
      {
        account: "123",
        digest: createHash("sha256").update(account).digest("hex"),
        scopes: ["read", "write"],
      },
    ]),
  };
  const request = async (
    body: unknown,
    options: {
      token?: string;
      method?: string;
      raw?: string;
      headers?: Record<string, string>;
      query?: string;
    } = {},
  ) => {
    const method = options.method ?? "POST";
    return (await workerForAttestation()).fetch(
      new Request(
        "https://aiko-agent.fixture.workers.dev/api/control/telegram-attest" +
          (options.query ?? ""),
        {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.token ?? operator}`,
            ...options.headers,
          },
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: options.raw ?? JSON.stringify(body) }),
        },
      ),
      env,
    );
  };
  return {
    env,
    operator,
    account,
    request,
    get namespaceAccesses() {
      return namespaceAccesses;
    },
  };
}

test("operator-only Worker attestation proves both deployed Telegram secrets without driving a namespace", async () => {
  const f = attestationFixture(),
    nonce = "ab".repeat(32);
  const response = await f.request({ nonce });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text(),
    parsed = JSON.parse(body);
  const expected = createHmac("sha256", String(f.env.AIKO_WEBHOOK_SECRET))
    .update(
      JSON.stringify(["aiko.telegram-cutover/v1", nonce, f.env.AIKO_BOT_TOKEN]),
    )
    .digest("hex");
  expect(parsed).toEqual({ botId: "987654321", proof: expected });
  for (const secret of [
    f.env.AIKO_BOT_TOKEN,
    f.env.AIKO_WEBHOOK_SECRET,
    f.env.AIKO_OPERATOR_TOKEN,
    f.env.CODEGRAFF_API_KEY,
  ])
    expect(body).not.toContain(String(secret));
  expect(body).not.toContain(nonce);
  const next = await (await f.request({ nonce: "cd".repeat(32) })).json();
  expect(next.proof).not.toBe(expected);
  f.env.AIKO_BOT_TOKEN = "987654321:rotated_bot_attestation_fixture_1234567890";
  const rotatedBot = (await (await f.request({ nonce })).json()).proof;
  expect(rotatedBot).not.toBe(expected);
  f.env.AIKO_WEBHOOK_SECRET = "rotated_webhook_attestation_fixture_1234567890";
  expect((await (await f.request({ nonce })).json()).proof).not.toBe(
    rotatedBot,
  );
  expect(f.namespaceAccesses).toBe(0);
}, 30_000);

test("Worker attestation denies account credentials, absent auth, wrong origins and unsafe request bodies", async () => {
  const f = attestationFixture(),
    nonce = "ab".repeat(32);
  expect((await f.request({ nonce }, { token: "invalid" })).status).toBe(401);
  expect(
    (await f.request({ nonce }, { headers: { authorization: "" } })).status,
  ).toBe(401);
  expect((await f.request({ nonce }, { token: f.account })).status).toBe(403);
  expect(
    (
      await f.request(
        { nonce },
        { headers: { origin: "https://evil.invalid" } },
      )
    ).status,
  ).toBe(403);
  const method = await f.request(undefined, { method: "GET" });
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("POST");
  for (const body of [
    null,
    [],
    {},
    { nonce: "AB".repeat(32) },
    { nonce: "a".repeat(63) },
    { nonce: "g".repeat(64) },
    { nonce: 1 },
    { nonce, account: "123" },
  ]) {
    const rejected = await f.request(body);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "invalid_body" });
  }
  expect((await f.request({ nonce }, { raw: '{"nonce":' })).status).toBe(400);
  expect((await f.request({ nonce }, { raw: " ".repeat(257) })).status).toBe(
    400,
  );
  expect(
    (await f.request({ nonce }, { headers: { "content-type": "text/plain" } }))
      .status,
  ).toBe(400);
  expect((await f.request({ nonce }, { query: "?account=123" })).status).toBe(
    400,
  );
  expect(f.namespaceAccesses).toBe(0);
});

test("Worker attestation fails closed with sanitized output for absent or malformed deployed Telegram configuration", async () => {
  for (const overrides of [
    { AIKO_BOT_TOKEN: undefined, AIKO_WEBHOOK_SECRET: undefined },
    { AIKO_WEBHOOK_SECRET: undefined },
    { AIKO_BOT_TOKEN: "bad-token-private-value" },
    { AIKO_WEBHOOK_SECRET: "short-private" },
    { AIKO_BOT_TOKEN: "987654321:credential-with-url-https://evil.invalid" },
  ]) {
    const f = attestationFixture();
    Object.assign(f.env, overrides);
    const response = await f.request({ nonce: "ab".repeat(32) });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("private");
    expect(body).not.toContain("proof");
    expect(f.namespaceAccesses).toBe(0);
  }
});
