import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  browserNetworkToolPreparedEventOf,
  browserToolCallEventOf,
  browserTraceNdjsonLineOf,
} from "@unbrowse/browser-runtime/trace";
import {
  networkToolDigest,
  validateNetworkToolDefinition,
} from "../../../packages/browser-runtime/src/network-tool-catalog.ts";
import {
  learningFromBrowserTrace,
  learningFromPendingBrowserTrace,
} from "../src/unbrowse-learning.ts";
import {
  BrowserLearning,
  type BrowserLearningPending,
} from "../src/browser-learning.ts";
import { canonicalStringify, sha256 } from "@unbrowse/browser-runtime/har";
import {
  indexLearning,
  memorySnapshot,
  validateLearningInput,
} from "../src/learning.ts";
import { openMemory } from "../src/memory.ts";
import { redactor } from "../src/security.ts";
import { createService } from "../src/server.ts";
import { accountDirectory, backgroundThread } from "../src/accounts.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import type { AikoEvent } from "../src/actor.ts";
import { createAikoClient } from "../../../packages/sdk/src/aiko.ts";
import { threadCreated } from "tardie/core/thread";
import { backgroundEventKey } from "../src/background.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const sha = (character: string) => `sha256:${character.repeat(64)}` as const;

// Same native compiled-tool fixture shape as unbrowse-playground/runtime/test/browser-trace.test.ts.
function preparedTool(
  options: {
    threadId?: string;
    sequence?: number;
    path?: string;
    siteId?: string;
    actionId?: string;
  } = {},
) {
  const definition = validateNetworkToolDefinition({
    schemaVersion: 1,
    compilerRevision: "network-tool-compiler/1",
    toolId: "list-items",
    siteId: options.siteId ?? "example",
    actionId: options.actionId ?? "list-items",
    sourceTraceDigest: sha("a"),
    sourceArtifactDigest: sha("b"),
    inputs: [],
    sessionRequirements: ["private-session-capability"],
    steps: [
      {
        id: "list",
        dependsOn: [],
        method: "GET",
        origin: "https://api.example.test",
        path: options.path ?? "/api/items",
        pathParameters: {},
        query: {},
        headers: {},
        expectedStatuses: [200],
      },
    ],
    dependencies: [],
    evidence: [
      {
        stepId: "list",
        requestId: "req-1",
        traceEventId: `har2:req:capture-1:${sha("a")}:req-1`,
      },
    ],
  });
  return browserNetworkToolPreparedEventOf({
    threadId: options.threadId ?? "browser-run-1",
    sequence: options.sequence ?? 3,
    tool: { definition, digest: networkToolDigest(definition) },
  });
}

test("native prepared trace and committed NDJSON map to bounded skill evidence without request or session details", () => {
  const event = preparedTool();
  const result = learningFromBrowserTrace(
    JSON.parse(browserTraceNdjsonLineOf(event)),
  );
  expect(result).toBeDefined();
  expect(validateLearningInput(result)).toEqual(result);
  expect(result).toMatchObject({
    kind: "skill",
    type: "browser-tool",
    title: "example / list-items",
    payload: {
      producer: "unbrowse/browser-runtime",
      toolDigest: event.toolDigest,
      sourceTraceDigest: event.sourceTraceDigest,
      sourceArtifactDigest: event.sourceArtifactDigest,
      summary: {
        siteId: "example",
        methods: ["GET"],
        stepCount: 1,
        sessionRequirementCount: 1,
      },
    },
  });
  const payload = JSON.stringify(result);
  for (const excluded of [
    "definition",
    "sessionRequirements",
    "private-session-capability",
    "api.example.test",
    "/api/items",
    "req-1",
    "browser-run-1",
  ])
    expect(payload).not.toContain(excluded);
  expect(Buffer.byteLength(payload)).toBeLessThan(2_000);
});

test("strict native decoding rejects altered digests, summary mismatches, raw payloads and other event types", () => {
  const event = preparedTool();
  for (const patch of [
    { toolDigest: sha("c") },
    { sourceTraceDigest: sha("d") },
    { sourceArtifactDigest: sha("e") },
    { actionId: "different-action" },
    { toolId: "different-tool" },
    { summary: { ...event.summary, stepCount: 2 } },
    {
      definition: {
        ...event.definition,
        steps: [{ ...event.definition.steps[0], path: "/changed" }],
      },
    },
    {
      definition: {
        ...event.definition,
        rawRequests: [{ authorization: "Bearer private" }],
      },
    },
    { owner: "other-account" },
    { runId: "made-up-envelope-field" },
    { text: "page-dump" },
  ])
    expect(learningFromBrowserTrace({ ...event, ...patch })).toBeUndefined();
  for (const malformed of [
    null,
    [],
    {},
    "{}",
    { type: "BrowserNetworkToolPrepared" },
    browserToolCallEventOf({
      threadId: "browser-run-1",
      sequence: 0,
      callId: "call-1",
      action: "title",
      params: {},
    }),
  ])
    expect(learningFromBrowserTrace(malformed)).toBeUndefined();
});

test("transport changes preserve hook identity while tool occurrences have distinct IDs and stable semantic payloads", () => {
  const event = preparedTool();
  const first = learningFromBrowserTrace(event)!;
  const transport = learningFromBrowserTrace({
    ...event,
    at: 1234,
    traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  })!;
  expect(transport).toEqual(first);
  const nextRun = learningFromBrowserTrace(
    preparedTool({ threadId: "browser-run-2" }),
  )!;
  const nextOccurrence = learningFromBrowserTrace(
    preparedTool({ sequence: 4 }),
  )!;
  expect(nextRun.id).not.toBe(first.id);
  expect(nextOccurrence.id).not.toBe(first.id);
  expect(nextRun.subject).toBe(first.subject);
  expect(nextRun.payload).toEqual(first.payload);
  expect(nextOccurrence.payload).toEqual(first.payload);
  const revised = learningFromBrowserTrace(
    preparedTool({ path: "/api/items-v2" }),
  )!;
  expect(revised.subject).toBe(first.subject);
  expect(revised.payload).not.toEqual(first.payload);
});

test("verified browser tools index natively, retain their root across runs and isolate owner memory", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-unbrowse-learning-");
  directories.push(stateDir);
  const binding = { stateDir, owner: "123" };
  const first = await indexLearning(
    binding,
    learningFromBrowserTrace(preparedTool())!,
    redactor(),
  );
  const before = memorySnapshot(binding);
  const repeat = await indexLearning(
    binding,
    learningFromBrowserTrace(preparedTool({ threadId: "browser-run-2" }))!,
    redactor(),
  );
  expect(repeat.changed).toBe(false);
  expect(memorySnapshot(binding).root).toBe(before.root);
  const revised = await indexLearning(
    binding,
    learningFromBrowserTrace(preparedTool({ path: "/api/items-v2" }))!,
    redactor(),
  );
  expect(revised.changed).toBe(true);
  expect(memorySnapshot(binding).root).not.toBe(before.root);
  expect(memorySnapshot(binding).leaves).toHaveLength(1);
  const foreign = openMemory({ stateDir, owner: "456" });
  try {
    expect(foreign.get(first.observation)).toBeNull();
  } finally {
    foreign.close();
  }
});

test("SDK Unbrowse hook reaches native background indexing and reflection once without storing raw definitions", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-unbrowse-hook-");
  directories.push(stateDir);
  const aliceToken = "aiko_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const bobToken = "aiko_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const config: AikoConfig = {
    stateDir,
    mode: "demo",
    instanceId: "unbrowse-hook-fixture",
    port: 4242,
    operatorToken: "unbrowse-hook-operator-fixture-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(aliceToken),
        scopes: ["read", "write"],
      },
      {
        account: "456",
        digest: credentialDigest(bobToken),
        scopes: ["read", "write"],
      },
    ],
  };
  const service = await createService(config);
  const client = (token: string) =>
    createAikoClient({
      baseUrl: "http://127.0.0.1:4242",
      token,
      fetch: (async (url: string | URL | Request, init?: RequestInit) =>
        service.fetch(new Request(url, init))) as typeof fetch,
    });
  const alice = client(aliceToken),
    bob = client(bobToken);
  try {
    const nativeEvent = preparedTool();
    await expect(
      alice.hooks.unbrowse({ ...nativeEvent, toolDigest: sha("f") }),
    ).rejects.toMatchObject({ status: 400 });
    const accepted = await alice.hooks.unbrowse(nativeEvent);
    expect(accepted).toEqual({
      status: "accepted",
      id: `hook:${learningFromBrowserTrace(nativeEvent)!.id}`,
    });
    await service.host.drive();
    const indexer = backgroundThread("123", "indexer");
    const reflection = backgroundThread("123", "reflection");
    const indexedLog = (await service.host.read(
      indexer,
    )) as readonly AikoEvent[];
    const indexed = indexedLog.filter(
      (event) => event.type === "AikoLearningIndexed",
    );
    expect(indexed).toHaveLength(1);
    const changed = indexedLog.find(
      (event) => event.type === "AikoKnowledgeChanged",
    );
    expect(changed?.root).toMatch(/^[a-f0-9]{64}$/);
    expect(changed?.complete).toBe(true);
    expect(
      indexedLog.some((event) => event.type === "AikoReflectionDispatched"),
    ).toBe(true);
    const reflected = (await service.host.read(
      reflection,
    )) as readonly AikoEvent[];
    const decisions = reflected.filter(
      (event) => event.type === "AikoDecisionRecorded",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].root).toBe(changed!.root);
    expect(decisions[0].decision).toMatch(/^(notify|silent)$/);
    const observation = String(indexed[0].observation);
    expect((await alice.memory.get(observation)).observation.id).toBe(
      observation,
    );
    expect(
      (await alice.memory.recall("list-items")).items.length,
    ).toBeGreaterThan(0);
    expect((await bob.memory.recall("list-items")).items).toHaveLength(0);
    await expect(bob.memory.get(observation)).rejects.toMatchObject({
      status: 404,
    });
    expect(await alice.hooks.unbrowse(nativeEvent)).toEqual({
      status: "duplicate",
      id: accepted.id,
    });
    await service.host.drive();
    expect(
      (await service.host.read(indexer)).filter(
        (event) => event.type === "AikoLearningIndexed",
      ),
    ).toHaveLength(1);
    expect(
      (await service.host.read(reflection)).filter(
        (event) => event.type === "AikoDecisionRecorded",
      ),
    ).toHaveLength(1);
    const stored = JSON.stringify([
      await service.host.read("user-123"),
      await service.host.read(indexer),
      await service.host.read(reflection),
    ]);
    for (const forbidden of [
      '"definition":',
      '"sessionRequirements":',
      "private-session-capability",
      "https://api.example.test",
      "/api/items",
    ])
      expect(stored).not.toContain(forbidden);
  } finally {
    await service.close();
  }
}, 30_000);

test("committed native browser preparations trigger scoped learning once, respecting activation and pause controls", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-native-browser-learning-");
  directories.push(stateDir);
  const service = await createService({
    stateDir,
    mode: "demo",
    instanceId: "native-browser-learning",
    port: 4242,
    operatorToken: "native-browser-fixture-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
  });
  const foreground = "user-123";
  const indexer = backgroundThread("123", "indexer");
  const reflection = backgroundThread("123", "reflection");
  const commit = async (event: { type: string; [field: string]: unknown }) => {
    // Browser-driver telemetry is appended within an actor, not delivered by
    // the keyed cross-thread ingress API. Seed uses that same native log store.
    await service.host.seed(foreground, [event]);
    await service.host.wake(foreground);
  };
  const events = async (thread: string, type: string) =>
    (await service.host.read(thread)).filter((event) => event.type === type);
  try {
    await service.host.seed(foreground, [
      threadCreated(
        {
          actor: "aiko",
          instance: "native-browser-learning",
          thread: foreground,
        },
        undefined,
        0,
      ),
    ]);
    await commit({ ...preparedTool({ sequence: 1 }), at: 1 });
    await service.host.drive();
    expect((await service.host.threads()).includes(indexer)).toBe(false);
    await commit({ type: "AikoHooksActivated", id: "background-v1", at: 2 });
    await commit({
      type: "AikoHooksConfigured",
      id: "pause-browser-learning",
      paused: true,
      at: 3,
    });
    const prepared = { ...preparedTool({ sequence: 2 }), at: 4 };
    await commit(prepared);
    await commit({
      ...preparedTool({ sequence: 3 }),
      toolDigest: sha("f"),
      at: 5,
    });
    await service.host.drive();
    expect(await events(indexer, "AikoHookReceived")).toHaveLength(0);
    expect(await events(indexer, "AikoLearningIndexed")).toHaveLength(0);
    await commit({
      type: "AikoHooksConfigured",
      id: "resume-browser-learning",
      paused: false,
      at: 6,
    });
    await service.host.drive();
    const hook = await events(indexer, "AikoHookReceived");
    expect(hook).toHaveLength(1);
    expect(hook[0]!.id).toBe(`hook:${learningFromBrowserTrace(prepared)!.id}`);
    expect(await events(foreground, "AikoHookDispatched")).toHaveLength(1);
    const indexed = await events(indexer, "AikoLearningIndexed");
    expect(indexed).toHaveLength(1);
    expect(await events(reflection, "AikoDecisionRecorded")).toHaveLength(1);
    const binding = {
      stateDir: accountDirectory(stateDir, "123"),
      owner: "123",
    };
    const snapshot = memorySnapshot(binding);
    expect(snapshot.leaves).toHaveLength(1);
    expect(snapshot.leaves[0]!.observation).toBe(
      String(indexed[0]!.observation),
    );
    await commit({ ...prepared, at: 7 });
    await service.host.drive();
    expect(await events(indexer, "AikoHookReceived")).toHaveLength(1);
    expect(await events(indexer, "AikoLearningIndexed")).toHaveLength(1);
    await commit({ ...preparedTool({ sequence: 4 }), at: 8 });
    await service.host.drive();
    expect(await events(indexer, "AikoLearningIndexed")).toHaveLength(2);
    expect(await events(indexer, "AikoKnowledgeUnchanged")).toHaveLength(1);
    expect(await events(reflection, "AikoDecisionRecorded")).toHaveLength(1);
    expect(memorySnapshot(binding).root).toBe(snapshot.root);
    const own = openMemory(binding);
    const foreign = openMemory({
      stateDir: accountDirectory(stateDir, "456"),
      owner: "456",
    });
    try {
      const observation = String(indexed[0]!.observation);
      expect(own.get(observation)).not.toBeNull();
      expect(foreign.get(observation)).toBeNull();
      const stored = JSON.stringify([
        await service.host.read(indexer),
        await service.host.read(reflection),
        own.exportArchive(),
      ]);
      for (const forbidden of [
        '"definition":',
        '"sessionRequirements":',
        "private-session-capability",
        "https://api.example.test",
        "/api/items",
      ])
        expect(stored).not.toContain(forbidden);
    } finally {
      own.close();
      foreign.close();
    }
  } finally {
    await service.close();
  }
}, 30_000);

async function pendingFixture(threadId = "native-pending-run-1") {
  const events: AikoEvent[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId,
    nextSequence: () => ++sequence,
    emit: async (event) => {
      events.push(event as AikoEvent);
    },
  });
  const entry = {
    startedDateTime: new Date(1_000).toISOString(),
    time: 20,
    _observationComplete: true,
    _resourceType: "Document",
    request: {
      method: "GET",
      url: "https://public.example.test/products/private-route-value?limit=private-query-value",
      headers: [
        { name: "user-agent", value: "private-browser-header-sentinel" },
        { name: "accept-language", value: "private-language-sentinel" },
      ],
      cookies: [],
    },
    response: {
      status: 200,
      headers: [],
      cookies: [],
      content: {
        mimeType: "application/json",
        size: 100,
        text: '{"items":[{"name":"private-response-value"}]}',
      },
    },
  };
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
  await learning.observe(entry, 0, true);
  expect(
    (await learning.compile([entry], windows, "https://public.example.test"))
      .prepared,
  ).toBe(0);
  const length = events.length;
  await learning.compile([entry], windows, "https://public.example.test");
  expect(events).toHaveLength(length);
  const pending = events.find(
    (event) => event.type === "AikoBrowserLearningPending",
  ) as unknown as BrowserLearningPending;
  expect(pending).toBeDefined();
  return { events, pending };
}

test("native blocked browser observations map to honest semantic facts, never prepared skills", async () => {
  const first = await pendingFixture();
  const second = await pendingFixture("native-pending-run-2");
  const input = learningFromPendingBrowserTrace(first.pending)!;
  const repeated = learningFromPendingBrowserTrace(second.pending)!;
  expect(input).toBeDefined();
  expect(validateLearningInput(input)).toEqual(input);
  expect(input.kind).toBe("fact");
  expect(input.type).toBe("browser-learning-pending");
  expect(input.payload).toMatchObject({
    ready: false,
    approved: false,
    executable: false,
    reason: "unresolved_finding",
    maskedPath: "/:segment/:segment",
  });
  expect(first.pending.requestEvidenceId).toContain(
    first.pending.sourceTraceDigest,
  );
  expect(first.pending.requestEvidenceId).toContain(first.pending.captureId);
  expect(backgroundEventKey({ ...first.pending, at: 1 })).toBe(
    `aiko-background:AikoBrowserLearningPending:${first.pending.id}`,
  );
  // A VM delivery accepted before its acknowledgement may be replayed with a new transport time.
  expect(backgroundEventKey({ ...first.pending, at: 2 })).toBe(
    backgroundEventKey({ ...first.pending, at: 1 }),
  );
  expect(backgroundEventKey({ ...second.pending })).not.toBe(
    backgroundEventKey({ ...first.pending }),
  );
  expect(repeated.id).not.toBe(input.id);
  expect(repeated.subject).toBe(input.subject);
  expect(repeated.payload).toEqual(input.payload);
  expect(learningFromBrowserTrace(first.pending)).toBeUndefined();
  expect(learningFromPendingBrowserTrace(preparedTool())).toBeUndefined();
  for (const secret of [
    "private-route-value",
    "private-query-value",
    "private-browser-header-sentinel",
    "private-language-sentinel",
    "private-response-value",
  ])
    expect(JSON.stringify(first.events) + JSON.stringify(input)).not.toContain(
      secret,
    );
  for (const occurrence of [
    first.pending.captureId,
    first.pending.threadId,
    first.pending.sourceTraceDigest,
  ])
    expect(JSON.stringify(input.payload)).not.toContain(occurrence);
  expect(
    first.events.some((event) => event.type === "BrowserNetworkToolPrepared"),
  ).toBe(false);
});

test("pending-learning envelope rejects malformed identities, readiness claims and raw values even with recomputed identity", async () => {
  const { pending } = await pendingFixture();
  const withIdentity = (value: Record<string, unknown>) => {
    const { id: _id, at: _at, ...fields } = value;
    return { ...value, id: `pending-${sha256(canonicalStringify(fields))}` };
  };
  for (const mutation of [
    { owner: "456" },
    { scope: "foreign" },
    { ready: true },
    { approved: true },
    { executable: true },
    { headers: { authorization: "private-header-value" } },
    { body: "private-response-body" },
    { path: "/products/private-user-value" },
    { path: "/:segment?token=private-query-value" },
    { origin: "https://user:password@public.example.test" },
    { origin: "https://public.example.test/private" },
    { requestEvidenceId: pending.requestEvidenceId + "foreign" },
    { requestId: "req-999" },
    { sourceTraceDigest: "sha256:bad" },
    { sourceNetworkSequence: -1 },
    { at: Infinity },
    { reason: "ready" },
    { findings: [{ ...pending.findings[0]!, value: "private-value" }] },
    { findings: [{ ...pending.findings[0]!, code: "ignore-approval" }] },
    {
      findings: [
        {
          ...pending.findings[0]!,
          location: "request.header.authorization: Bearer secret",
        },
      ],
    },
    { findings: Array(9).fill(pending.findings[0]) },
    { omittedFindings: 999_999 },
  ])
    expect(
      learningFromPendingBrowserTrace(
        withIdentity({ ...pending, ...mutation }),
      ),
    ).toBeUndefined();
  expect(
    learningFromPendingBrowserTrace({
      ...pending,
      id: "pending-" + "f".repeat(64),
    }),
  ).toBeUndefined();
  expect(
    learningFromPendingBrowserTrace({
      ...pending,
      reason: "session_requirement_missing",
    }),
  ).toBeUndefined();
  expect(
    learningFromPendingBrowserTrace({ ...pending, at: 1234 }),
  ).toBeDefined();
});

test("committed native pending observation drives isolated indexing and reflection without approving a route", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-native-pending-learning-");
  directories.push(stateDir);
  const service = await createService({
    stateDir,
    mode: "demo",
    instanceId: "pending-learning",
    port: 4242,
    operatorToken: "pending-browser-fixture-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
  });
  const foreground = "user-123",
    indexer = backgroundThread("123", "indexer"),
    reflection = backgroundThread("123", "reflection");
  const binding = { stateDir: accountDirectory(stateDir, "123"), owner: "123" };
  const rows = async (thread: string, type: string) =>
    (await service.host.read(thread)).filter((event) => event.type === type);
  const commit = async (events: readonly AikoEvent[]) => {
    await service.host.seed(foreground, events);
    await service.host.wake(foreground);
    await service.host.drive();
  };
  try {
    const first = await pendingFixture();
    await service.host.seed(foreground, [
      threadCreated(
        { actor: "aiko", instance: "pending-learning", thread: foreground },
        undefined,
        0,
      ),
    ]);
    await commit([
      { type: "AikoHooksActivated", id: "background-v1", at: 1 },
      { type: "AikoHooksConfigured", id: "pause-pending", paused: true, at: 2 },
      ...first.events,
    ]);
    expect(await rows(indexer, "AikoLearningIndexed")).toHaveLength(0);
    await commit([
      {
        type: "AikoHooksConfigured",
        id: "resume-pending",
        paused: false,
        at: 3,
      },
    ]);
    const indexed = await rows(indexer, "AikoLearningIndexed");
    expect(indexed).toHaveLength(1);
    expect(await rows(indexer, "AikoKnowledgeChanged")).toHaveLength(1);
    expect(await rows(reflection, "AikoDecisionRecorded")).toHaveLength(1);
    const before = memorySnapshot(binding);
    expect(before.complete).toBe(true);
    await commit([{ ...first.pending, at: 4 }]);
    expect(await rows(indexer, "AikoLearningIndexed")).toHaveLength(1);
    const second = await pendingFixture("native-pending-run-2");
    await commit(second.events);
    expect(await rows(indexer, "AikoLearningIndexed")).toHaveLength(2);
    expect(await rows(indexer, "AikoKnowledgeUnchanged")).toHaveLength(1);
    expect(await rows(reflection, "AikoDecisionRecorded")).toHaveLength(1);
    expect(memorySnapshot(binding).root).toBe(before.root);
    const own = openMemory(binding),
      foreign = openMemory({
        stateDir: accountDirectory(stateDir, "456"),
        owner: "456",
      });
    try {
      const observation = String(indexed[0]!.observation);
      const stored = own.get(observation)!.observation;
      expect(stored.kind).toBe("fact");
      expect(stored.type).toBe("browser-learning-pending");
      expect(JSON.stringify(stored.payload)).toContain('"executable":false');
      expect(foreign.get(observation)).toBeNull();
      expect(memorySnapshot(binding).leaves).toHaveLength(1);
    } finally {
      own.close();
      foreign.close();
    }
    expect(await rows(foreground, "BrowserNetworkToolPrepared")).toHaveLength(
      0,
    );
    expect(await rows(foreground, "AikoHookDispatched")).toHaveLength(2);
  } finally {
    await service.close();
  }
}, 30_000);
