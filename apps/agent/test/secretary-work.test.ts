import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { handles } from "tardie/core/actor/contract";
import { createBunHost, type BunHost } from "tardie/bun/host";
import type { Event } from "tardie/core/event";
import { Database } from "bun:sqlite";
import { Layer, Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import { voiceAndOutbox } from "../src/actor.ts";
import { foregroundHooks, backgroundEventKey } from "../src/background.ts";
import {
  proactiveWaitMethod,
  proactiveEventKey,
  proactiveAppendAllowed,
} from "../src/proactive-policy.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  secretaryCoordination,
  coordinateWork,
  workWaitMethod,
} from "../src/secretary-coordination.ts";
import {
  secretaryWorkApi,
  applyWorkCommand,
  createSecretaryWorkBinding,
  secretaryWorkTools,
} from "../src/secretary-work.ts";
import { secretaryTelegram } from "../src/secretary-telegram.ts";
import {
  contactReplyAllowed,
  workAppendAllowed,
  workEventKey,
  workState,
  workView,
  workNoticeCurrent,
  workExternalEventAllowed,
  executionId,
  planDigest,
} from "../src/commitments.ts";
import type { SecretaryWorkBinding } from "../src/secretary-policy.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const owner = "123",
  chat = "456",
  connectionId = "business-fixture",
  hour = 3600000;
function fixture() {
  let now = Date.now();
  let rows: Event[] = [];
  const sends: Record<string, unknown>[] = [];
  let unknown = false,
    resolveHook: (() => Promise<void>) | undefined;
  const connection = {
    id: connectionId,
    owner,
    ownerChat: owner,
    enabled: true,
    canReply: true,
    canRead: true,
  };
  const incoming = (id: number, text: string, extra: object = {}) => ({
    connectionId,
    chat,
    chatType: "private",
    name: "Maya",
    messageId: id,
    sender: chat,
    text,
    date: Math.floor(now / 1000),
    viaBot: false,
    unsupported: false,
    ...extra,
  });
  const contacts: Event[] = [
    {
      type: "AikoSecretaryUpdate",
      id: "initial",
      updateId: 1,
      update: { kind: "message", connection, message: incoming(1, "Hello") },
    },
    {
      type: "AikoSecretaryGrant",
      id: "grant-1",
      connectionId,
      chat,
      enabled: true,
    },
  ];
  const telegram = secretaryTelegram("fixture", async (url, init) => {
    if (String(url).endsWith("getBusinessConnection")) {
      await resolveHook?.();
      return Response.json({
        ok: true,
        result: {
          id: connectionId,
          user: { id: 123 },
          user_chat_id: 123,
          is_enabled: connection.enabled,
          rights: { can_reply: connection.canReply, can_read_messages: true },
        },
      });
    }
    sends.push(JSON.parse(String(init?.body)));
    if (unknown) throw Error("Provider may have sent");
    return Response.json({
      ok: true,
      result: { message_id: 900 + sends.length },
    });
  });
  const binding: SecretaryWorkBinding = {
    owner,
    thread: "user-" + owner,
    now: () => now,
    telegram,
    read: async () => structuredClone(rows),
    append: async (batch) => {
      const filtered = batch.filter(
        (e) =>
          !rows.some(
            (p) => workEventKey(p) && workEventKey(p) === workEventKey(e),
          ),
      );
      if (!workAppendAllowed("user-" + owner, filtered, () => rows))
        throw Error("Stale append");
      rows.push(...structuredClone(filtered));
    },
    readSecretary: async () => structuredClone(contacts),
    memory: {
      owner,
      thread: "user-" + owner,
      stateDir: "/tmp/unused-secretary-memory",
      redact: (s) => s,
      readPage: async () => [],
    },
  };
  let ordinal = 0;
  const input = () => ({
    action: "capture",
    operationId: "capture",
    id: "agenda",
    outcome: "Prepare the review",
    successCondition: "Three numbered agenda items in my note",
    accountableParty: "Maya",
    nextAction: "Collect agenda items",
    dueAt: now + 4 * hour,
    timeZone: "Asia/Singapore",
    plan: {
      kind: "agenda",
      connectionId,
      chat,
      contactName: "Maya",
      count: 3,
      requestText: "Please send three agenda items as a numbered list.",
      reminderText:
        "Please send the three numbered agenda items before the review.",
      reminderAt: now + hour,
      escalateAt: now + 2 * hour,
    },
  });
  const command = (body: object, trusted = true) =>
    applyWorkCommand(binding, body, { trusted, ref: "owner:fixture" });
  const current = () => workState(rows, owner).commitments.get("agenda")!;
  const approve = () => {
    const w = current();
    return command({
      action: "decide",
      operationId: "approve-" + ordinal++,
      id: w.id,
      expectedVersion: w.version,
      decisionId: w.decision!.id,
      planDigest: w.decision!.planDigest,
      choice: "approve",
    });
  };
  const change = (change: string, extra: object = {}) =>
    command({
      action: "change",
      operationId: "change-" + ordinal++,
      id: "agenda",
      expectedVersion: current().version,
      change,
      ...extra,
    });
  const message = (id: number, text: string, extra: object = {}) =>
    contacts.push({
      type: "AikoSecretaryUpdate",
      id: "incoming-" + id,
      updateId: id + 10,
      update: {
        kind: "message",
        connection,
        message: incoming(id, text, extra),
      },
    });
  return {
    binding,
    command,
    input,
    current,
    approve,
    change,
    contacts,
    sends,
    message,
    rows: () => rows,
    advance: (ms: number) => {
      now += ms;
    },
    step: () => coordinateWork(binding, "agenda", new AbortController().signal),
    unknown: () => {
      unknown = true;
    },
    onResolve: (f: () => Promise<void>) => {
      resolveHook = f;
    },
    restore: () => {
      rows = JSON.parse(JSON.stringify(rows));
    },
  };
}

test("one approved agenda request follows through, reminds once, rejects incomplete evidence and prepares the note", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.step();
  expect(f.sends).toHaveLength(0);
  expect(f.current().status).toBe("candidate");
  await f.approve();
  await f.step();
  expect(f.sends).toHaveLength(1);
  expect(f.current().status).toBe("waiting");
  f.restore();
  f.message(2, "1. Launch status\n2. Budget");
  await f.step();
  expect(f.current().status).toBe("waiting");
  f.advance(hour);
  await f.step();
  await f.step();
  expect(f.sends).toHaveLength(2);
  f.message(3, "1. Launch status\n2. Budget approval\n3. Hiring plan");
  await f.step();
  expect(f.current().status).toBe("completed");
  expect(f.current().preparationNote).toContain("Hiring plan");
  expect(f.current().evidenceRefs).toHaveLength(1);
  f.advance(4 * hour);
  await f.step();
  expect(f.sends).toHaveLength(2);
});

test("early receipt cancels reminders; deleted evidence reopens the obligation", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  await f.step();
  f.message(2, "1. Launch status\n2. Budget approval\n3. Hiring plan");
  await f.step();
  const old = { workId: "agenda", version: f.current().version };
  expect(workNoticeCurrent(f.rows(), owner, old)).toBe(true);
  f.advance(hour);
  await f.step();
  expect(f.sends).toHaveLength(1);
  f.contacts.push({
    type: "AikoSecretaryUpdate",
    id: "deleted",
    updateId: 20,
    update: {
      kind: "delete",
      connection: (f.contacts[0].update as any).connection,
      chat,
      messageIds: [2],
    },
  });
  await f.step();
  expect(f.current().status).toBe("waiting");
  expect(f.current().decision?.status).toBe("pending");
  expect(f.current().preparationNote).toBeUndefined();
  expect(workNoticeCurrent(f.rows(), owner, old)).toBe(false);
});

test("unknown send remains open across replay and prevents the reminder", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  f.unknown();
  await f.step();
  expect(f.sends).toHaveLength(1);
  expect(f.current().decision?.issue).toContain("uncertain");
  f.restore();
  f.advance(hour);
  await f.step();
  expect(f.sends).toHaveLength(1);
  expect(f.current().status).not.toBe("completed");
});

test("pause during the last connection check prevents dispatch and takeover persists through new messages", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  f.onResolve(async () => {
    await f.change("pause");
  });
  await f.step();
  expect(f.sends).toHaveLength(0);
  await f.change("takeover");
  f.message(2, "Please go ahead");
  f.advance(hour);
  await f.step();
  expect(f.current().handling).toBe("owner");
  expect(contactReplyAllowed(f.rows(), owner, connectionId, chat)).toBe(false);
  expect(f.sends).toHaveLength(0);
});

test("contact takeover governs later commitments; stale handback and foreign connections are rejected", async () => {
  const f = fixture();
  await f.command({
    action: "contact",
    operationId: "takeover",
    connectionId,
    chat,
    handling: "owner",
    expectedRevision: null,
  });
  await f.command(f.input());
  await f.approve();
  await f.step();
  expect(f.sends).toHaveLength(0);
  expect(contactReplyAllowed(f.rows(), owner, connectionId, chat)).toBe(false);
  await expect(
    f.command({
      action: "contact",
      operationId: "resume",
      connectionId,
      chat,
      handling: "aiko",
      expectedRevision: null,
    }),
  ).rejects.toThrow("changed");
  await expect(
    f.command({
      action: "contact",
      operationId: "foreign",
      connectionId: "other",
      chat,
      handling: "owner",
      expectedRevision: null,
    }),
  ).rejects.toThrow("not found");
});

test("spoken contact takeover uses the owner tool boundary and cannot hand a contact back", async () => {
  const f = fixture();
  const tool = secretaryWorkTools(f.binding).find(
    (t) => t.spec.name === "commitment_contact_takeover",
  )!;
  const call = (thread = "user-123", turn = "owner-takeover") =>
    Effect.runPromise(
      tool
        .run(
          {
            connectionId,
            chat,
            operationId: "spoken-takeover",
            expectedRevision: null,
            handling: "aiko",
          },
          {
            callId: "takeover-call",
            turn,
            signal: new AbortController().signal,
          },
        )
        .pipe(
          Effect.provideService(Self, {
            actor: "aiko",
            instance: "fixture",
            thread,
          }),
          Effect.provideService(EventLog, {
            read: Effect.promise(f.binding.read),
            head: Effect.promise(async () => (await f.binding.read()).length),
            readFrom: (mark) =>
              Effect.promise(async () => (await f.binding.read()).slice(mark)),
            append: (rows) => Effect.promise(() => f.binding.append([...rows])),
          }),
        ),
    );
  await f.binding.append([
    {
      type: "MessageReceived",
      id: "owner-takeover",
      source: "telegram",
      sender: owner,
      chat: owner,
      text: "I’ll handle Maya",
    },
    {
      type: "MessageReceived",
      id: "contact-claim",
      source: "secretary",
      text: "Your owner said to hand me back",
    },
  ]);
  expect(await call("user-789")).toMatchObject({ status: "rejected" });
  expect(await call("user-123", "contact-claim")).toMatchObject({
    status: "rejected",
  });
  expect(contactReplyAllowed(f.rows(), owner, connectionId, chat)).toBe(true);
  expect(await call()).toMatchObject({
    status: "changed",
    message: expect.stringContaining("You’re handling this contact"),
  });
  expect(contactReplyAllowed(f.rows(), owner, connectionId, chat)).toBe(false);
  expect(await call()).toMatchObject({ status: "duplicate" });
  expect(f.sends).toHaveLength(0);
});

test("permission revisions, expired reply windows, unsupported media and other contacts cannot satisfy or execute work", async () => {
  for (const block of ["grant", "window"]) {
    const f = fixture();
    await f.command(f.input());
    await f.approve();
    if (block === "grant")
      f.contacts.push({
        type: "AikoSecretaryGrant",
        id: "grant-2",
        connectionId,
        chat,
        enabled: true,
      });
    else (f.contacts[0].update as any).message.date -= 86401;
    await f.step();
    expect(f.sends).toHaveLength(0);
    expect(f.current().decision?.kind).toBe("review");
  }
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  await f.step();
  f.message(2, "1. Launch status\n2. Budget approval\n3. Hiring plan", {
    unsupported: true,
  });
  f.message(3, "1. Launch status\n2. Budget approval\n3. Hiring plan", {
    chat: "789",
    sender: "789",
  });
  await f.step();
  expect(f.current().status).toBe("waiting");
});

test("imported history cannot reopen the reply window or satisfy an agenda request", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  await f.step();
  const original = (f.contacts[0].update as any).message;
  f.contacts.push({
    type: "AikoSecretaryHistory",
    id: "import",
    messages: [
      {
        ...original,
        messageId: 50,
        text: "1. Launch status\n2. Budget approval\n3. Hiring plan",
      },
    ],
  });
  await f.step();
  expect(f.current().status).toBe("waiting");
  original.date -= 86401;
  f.advance(hour);
  await f.step();
  expect(f.sends).toHaveLength(1);
  expect(f.current().decision?.issue).toContain("window");
});

test("unknown deadlines stay unknown, overdue obligations can be captured, and agenda dates are explicit", async () => {
  const f = fixture(),
    input = { ...f.input(), plan: null, dueAt: null };
  await f.command(input);
  expect(f.current().dueAt).toBeNull();
  expect(f.current().nextReviewAt).toBe(f.binding.now!() + 24 * hour);
  expect(
    workView(f.rows(), owner, f.binding.now!()).commitments[0].overdue,
  ).toBe(false);
  const g = fixture();
  await g.command({ ...g.input(), plan: null, dueAt: g.binding.now!() - hour });
  expect(
    workView(g.rows(), owner, g.binding.now!()).commitments[0].overdue,
  ).toBe(true);
  await g.step();
  expect(g.current().decision?.status).toBe("pending");
  const h = fixture();
  await expect(h.command({ ...h.input(), dueAt: null })).rejects.toThrow(
    "future times",
  );
});

test("paused proposals need resume before approval; expired proposals can be edited with fresh dates", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.change("pause");
  await expect(f.approve()).rejects.toThrow("paused");
  await f.change("resume");
  await f.approve();
  await f.step();
  await f.change("pause");
  await f.change("resume");
  await f.step();
  expect(f.current().nextReviewAt).toBe(f.current().plan!.reminderAt);
  expect(f.sends).toHaveLength(1);
  const g = fixture();
  await g.command(g.input());
  g.advance(2 * hour);
  await g.step();
  expect(g.current().decision?.status).toBe("expired");
  const revised = g.input();
  await g.change("edit", {
    outcome: revised.outcome,
    accountableParty: revised.accountableParty,
    successCondition: revised.successCondition,
    nextAction: revised.nextAction,
    dueAt: revised.dueAt,
    timeZone: revised.timeZone,
    plan: revised.plan,
  });
  await g.approve();
  await g.step();
  expect(g.sends).toHaveLength(1);
});

test("later review stays deferred and reopening requires fresh completion evidence", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  await f.step();
  f.advance(2 * hour);
  await f.step();
  await f.change("review", { nextReviewAt: f.binding.now!() + hour });
  await f.step();
  expect(f.current().decision?.status).toBe("superseded");
  expect(f.sends).toHaveLength(1);
  f.advance(hour);
  await f.step();
  expect(f.current().decision?.status).toBe("pending");
  f.message(3, "1. Launch status\n2. Budget approval\n3. Hiring plan");
  await f.step();
  expect(f.current().status).toBe("completed");
  await f.change("reopen", { nextReviewAt: f.binding.now!() + hour });
  await f.step();
  expect(f.current().status).toBe("waiting");
  expect(f.current().preparationNote).toBeUndefined();
  f.message(4, "1. Revised launch status\n2. Budget approval\n3. Hiring plan");
  await f.step();
  expect(f.current().status).toBe("completed");
});

test("command replay is idempotent, conflicts are explicit, and model preparation cannot mint authority", async () => {
  const f = fixture(),
    input = f.input();
  await f.command(input, false);
  expect((await f.command(input, false)).status).toBe("duplicate");
  await expect(
    f.command({ ...input, outcome: "Something else" }),
  ).rejects.toThrow("already used");
  const w = f.current();
  await expect(
    f.command(
      {
        action: "decide",
        operationId: "model",
        id: w.id,
        expectedVersion: w.version,
        decisionId: w.decision!.id,
        planDigest: w.decision!.planDigest,
        choice: "approve",
      },
      false,
    ),
  ).rejects.toThrow("Only the owner");
  await f.approve();
  await expect(
    f.command({
      action: "change",
      operationId: "stale",
      id: w.id,
      expectedVersion: w.version,
      change: "cancel",
    }),
  ).rejects.toThrow("changed");
  expect(workExternalEventAllowed({ type: "AikoWorkTransition" })).toBe(false);
  expect(workAppendAllowed("user-789", [f.rows()[0]], () => [])).toBe(false);
  const response = await secretaryWorkApi(
    new Request("http://test/api/secretary/work"),
    { ...f.binding, owner: "789", thread: "user-789" },
    () => {},
  );
  expect((await response.json()).commitments).toHaveLength(0);
});

test("missing agenda creates a timely decision, whose expiry leaves the obligation unresolved", async () => {
  const f = fixture();
  await f.command(f.input());
  await f.approve();
  await f.step();
  f.advance(2 * hour);
  await f.step();
  expect(f.current().decision?.issue).toContain("Still waiting");
  expect(f.sends).toHaveLength(1); // a missed reminder is not sent after escalation
  f.advance(3 * hour);
  await f.step();
  expect(f.current().decision?.status).toBe("expired");
  expect(f.current().status).toBe("waiting");
  expect(f.current().handling).toBe("owner");
  expect(
    workView(f.rows(), owner, f.binding.now!()).commitments[0].overdue,
  ).toBe(true);
});

test("review decisions cannot restart correspondence through the approval API", async () => {
  const f = fixture(); await f.command(f.input()); await f.approve(); await f.step();
  f.advance(2 * hour); await f.step();
  expect(f.current().decision?.kind).toBe("review");
  await expect(f.approve()).rejects.toThrow("does not authorize another message");
  expect(f.sends).toHaveLength(1);
  await f.change("takeover");
  const result = await f.change("review", { nextReviewAt: f.binding.now!() + hour });
  expect(result.message).toContain("hand it back");
  f.advance(hour); await f.step();
  expect(f.sends).toHaveLength(1);
  expect(f.current().handling).toBe("owner");
});

for (const backend of ["bun", "cloudflare"] as const)
  test(
    backend +
      ": native component retains deadlines, survives restart, and wakes for the reminder",
    async () => {
      const dir = await mkdtemp("/tmp/aiko-work-native-"),
        f = fixture();
      let host!:
          BunHost | Awaited<ReturnType<typeof createCloudflareAccountHost>>,
        db: Database | undefined;
      let binding!: SecretaryWorkBinding;
      const memory = {
        ...f.binding.memory,
        stateDir: dir,
        readPage: (after: number, limit: number) =>
          host.readPage("user-123", after, limit),
      };
      binding = {
        ...f.binding,
        memory,
        read: () => host.read("user-123"),
        append: async (rows) => {
          for (const e of rows) await host.commitRoot(host.self("user-123"), e);
        },
      };
      const open = async () => {
        const definition = () =>
          actor({
            name: "aiko",
            methods: { workWait: workWaitMethod },
            components: [
              handles(workWaitMethod, secretaryCoordination(binding)),
            ],
          });
        const options = {
          actorName: "aiko",
          actorInstance: "work-test",
          actorFor: definition,
          keyOf: workEventKey,
          canAppend: workAppendAllowed,
        };
        if (backend === "bun")
          host = await createBunHost({
            ...options,
            database: join(dir, "native.sqlite"),
          });
        else {
          db = new Database(join(dir, "native.sqlite"));
          const storage: AccountStorage = {
            sql: {
              exec: (q, ...args) => {
                const result = db!.query(q).all(...(args as any));
                return { toArray: () => result as never };
              },
            },
            transactionSync: (fn) => db!.transaction(fn)(),
            sync: async () => {},
            getAlarm: async () => null,
            setAlarm: async () => {},
            deleteAlarm: async () => {},
          };
          host = await createCloudflareAccountHost({
            ...options,
            storage,
            ownsThread: (t) => t === "user-123",
            layersFor: () => Layer.empty,
          });
        }
      };
      await open();
      cleanups.push(async () => {
        await host.close();
        db?.close();
        await rm(dir, { recursive: true, force: true });
      });
      await applyWorkCommand(binding!, f.input(), {
        trusted: true,
        ref: "owner:fixture",
      });
      let w = workState(await host!.read("user-123"), owner).commitments.get(
        "agenda",
      )!;
      await applyWorkCommand(
        binding!,
        {
          action: "decide",
          operationId: "grant",
          id: w.id,
          expectedVersion: w.version,
          decisionId: w.decision!.id,
          planDigest: w.decision!.planDigest,
          choice: "approve",
        },
        { trusted: true, ref: "owner:fixture" },
      );
      await host!.wake("user-123");
      expect(f.sends).toHaveLength(1);
      expect(
        (await host!.read("user-123")).some(
          (e) => e.type === "AikoWorkDeadline",
        ),
      ).toBe(true);
      await host!.close();
      db?.close();
      db = undefined;
      await open();
      f.advance(hour);
      await host!.seed("user-123", [
        { type: "AlarmFired", at: f.binding.now!() },
      ]);
      await host!.wake("user-123");
      expect(f.sends).toHaveLength(2);
      await host!.wake("user-123");
      expect(f.sends).toHaveLength(2);
      w = workState(await host!.read("user-123"), owner).commitments.get(
        "agenda",
      )!;
      expect(w.status).toBe("waiting");
      // Source recovery is bounded and alarm-driven, including across reconstruction.
      const readSecretary = binding.readSecretary;
      let sourceReads = 0;
      binding.readSecretary = async () => {
        sourceReads++;
        throw Error("Source unavailable");
      };
      await host!.seed("user-123", [
        {
          type: "AikoWorkContactObserved",
          owner,
          id: "failure-1",
          at: f.binding.now!(),
        },
      ]);
      await host!.wake("user-123");
      await host!.seed("user-123", [
        {
          type: "AikoWorkContactObserved",
          owner,
          id: "failure-2",
          at: f.binding.now!(),
        },
      ]);
      await host!.wake("user-123");
      const failed = await host!.read("user-123");
      expect(
        failed.filter((e) => e.type === "AikoWorkEvaluationFailed"),
      ).toHaveLength(1);
      expect(
        workView(failed, owner, f.binding.now!()).commitments[0].recoveryIssue,
      ).toContain("could not check");
      expect(f.sends).toHaveLength(2);
      const recoveryAt = workView(failed, owner, f.binding.now!()).commitments[0].recoveryAt!;
      expect(recoveryAt).toBe(f.binding.now!() + 30_000);
      const recoveryWait = failed.findLast(e => e.type === "AikoWorkDeadline" && e.recoveryVersion === 1)!;
      expect(recoveryWait).toBeDefined();
      const probe = actor({ name: "aiko", methods: { workWait: workWaitMethod }, components: [handles(workWaitMethod, secretaryCoordination(binding))] });
      expect(probe.methods.workWait.state(failed, (recoveryWait.call as any).invocation)?.status).toBe("pending");
      await host.close(); (db as Database | undefined)?.close(); db = undefined; await open();
      await host.wake("user-123");
      expect(sourceReads).toBe(1);
      binding.readSecretary = readSecretary;
      f.advance(30_000);
      await host.seed("user-123", [{ type: "AlarmFired", scheduledFor: recoveryAt, at: f.binding.now!() }]);
      await host.wake("user-123");
      expect(workView(await host.read("user-123"), owner, f.binding.now!()).commitments[0].recoveryIssue).toBeUndefined();
      expect(f.sends).toHaveLength(2);

      // A permanent outage stops after two additional reads; unrelated wakeups
      // cannot replenish the budget. The existing owner retry remains available.
      binding.readSecretary = async () => { sourceReads++; throw Error("Source unavailable"); };
      await host.seed("user-123", [{ type: "AikoWorkContactObserved", owner, id: "permanent", at: f.binding.now!() }]);
      await host.wake("user-123");
      for (const delay of [30_000, 60_000, 30_000]) {
        f.advance(delay);
        await host.seed("user-123", [{ type: "AlarmFired", scheduledFor: f.binding.now!(), at: f.binding.now!() }]);
        await host.wake("user-123");
      }
      expect(sourceReads).toBe(4);
      const exhausted = workView(await host.read("user-123"), owner, f.binding.now!()).commitments[0];
      expect(exhausted.recoveryAt).toBeUndefined();
      expect(exhausted.recoveryIssue).toContain("Review its evidence");
      expect(exhausted.lane).toBe("needs_you");
      binding.readSecretary = readSecretary;
      await applyWorkCommand(
        binding,
        {
          action: "change",
          operationId: "recover",
          id: w.id,
          expectedVersion: w.version,
          change: "retry",
        },
        { trusted: true, ref: "owner:fixture" },
      );
      await host!.wake("user-123");
      const recovered = workView(
        await host!.read("user-123"),
        owner,
        f.binding.now!(),
      ).commitments[0];
      expect(recovered.recoveryIssue).toBeUndefined();
      expect(recovered.nextReviewAt).toBe(w.plan!.escalateAt);
      expect(f.sends).toHaveLength(2);
      f.message(20, "1. Budget\n2. Hiring\n3. Roadmap");
      await host.seed("user-123", [{ type: "AikoWorkContactObserved", owner, id: "checked-result", at: f.binding.now!() }]);
      await host.wake("user-123");
      const completed = workState(await host.read("user-123"), owner).commitments.get("agenda")!;
      expect(completed.status).toBe("completed");
      expect(completed.successCondition).toBe(w.successCondition);
      expect(completed.evidenceRefs).toHaveLength(1);
    },
  );

async function workOutboxFixture() {
  const dir = await mkdtemp("/tmp/aiko-work-outbox-"),
    f = fixture();
  let host!: BunHost;
  const memory = {
    ...f.binding.memory,
    stateDir: dir,
    readPage: (after: number, limit: number) =>
      host.readPage("user-123", after, limit),
  };
  const binding = {
    ...f.binding,
    memory,
    read: () => host.read("user-123"),
    append: async (rows: Event[]) => {
      for (const e of rows) await host.commitRoot(host.self("user-123"), e);
    },
  };
  const sent: string[] = [];
  const outbox = voiceAndOutbox(
    owner,
    (input) =>
      Effect.succeed({
        text: input.kind === "task" ? input.receipt : input.kind === "answer" ? input.text : "Reply",
        source: "template" as const,
      }),
    async (_, text) => {
      sent.push(text);
      return { status: "delivered" };
    },
    { live: true, redact: (s) => s, memory },
  );
  const definition = actor({
    name: "aiko",
    methods: { workWait: workWaitMethod, proactiveWait: proactiveWaitMethod },
    components: [
      handles(workWaitMethod, secretaryCoordination(binding, true)),
      handles(proactiveWaitMethod, foregroundHooks(memory)),
      outbox,
    ],
  });
  const open = () => createBunHost({
    database: join(dir, "native.sqlite"),
    actorName: "aiko",
    actorInstance: "work-outbox",
    actorFor: () => definition,
    keyOf: (e) =>
      workEventKey(e) ??
      backgroundEventKey(e) ??
      proactiveEventKey(e) ??
      outbox.keys?.keyOf(e),
    canAppend: (thread, rows, read) =>
      workAppendAllowed(thread, rows, read) &&
      proactiveAppendAllowed(rows, read, thread),
  });
  host = await open();
  cleanups.push(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });
  await host.commitRoot(host.self("user-123"), {
    type: "AikoControlReply",
    id: "owner-seen",
    source: "telegram",
    chat: owner,
    controlLane: true,
    at: Date.now(),
  });
  return { f, binding, sent, get host() { return host; },
    restart: async () => { await host.close(); host = await open(); await host.recover(); },
  };
}

for (const boundary of ["late-alarm", "paused", "cancelled", "unknown-send"] as const)
test(`source recovery preserves ${boundary} across a native restart`, async () => {
  const h = await workOutboxFixture(), { f, binding } = h;
  await applyWorkCommand(binding, f.input(), { trusted: true, ref: "owner:fixture" });
  let work = workState(await binding.read(), owner).commitments.get("agenda")!;
  await applyWorkCommand(binding, { action: "decide", operationId: "grant", id: work.id,
    expectedVersion: work.version, decisionId: work.decision!.id, planDigest: work.decision!.planDigest,
    choice: "approve" }, { trusted: true, ref: "owner:fixture" });
  const source = binding.readSecretary;
  let reads = 0;
  binding.readSecretary = async () => { reads++; throw Error("private failure detail"); };
  await h.host.wake("user-123");
  expect(reads).toBe(1); expect(f.sends).toHaveLength(0);
  work = workState(await binding.read(), owner).commitments.get("agenda")!;
  if (boundary === "paused" || boundary === "cancelled") {
    await applyWorkCommand(binding, { action: "change", operationId: "stop", id: work.id,
      expectedVersion: work.version, change: boundary === "paused" ? "pause" : "cancel" }, { trusted: true, ref: "owner:fixture" });
  }
  if (boundary === "unknown-send") {
    // A durable action claim from before an interrupted acknowledgement must
    // remain authoritative even when a later source read can recover.
    const id = executionId(work, "request");
    await binding.append([{ type: "AikoWorkDispatch", owner, id, workVersion: work.version,
      receipt: { id, owner, workId: work.id, planDigest: planDigest(work), token: "lost-ack",
        action: "request", status: "started", at: f.binding.now!() }, at: f.binding.now!() }]);
  }
  binding.readSecretary = async () => { reads++; return source(); };
  await h.restart();
  const beforeAlarm = reads;
  f.advance(boundary === "late-alarm" ? 120_000 : 30_000);
  await h.host.seed("user-123", [{ type: "AlarmFired", scheduledFor: f.binding.now!(), at: f.binding.now!() }]);
  await h.host.wake("user-123");
  const events = await binding.read(), current = workState(events, owner).commitments.get(work.id)!;
  expect(f.sends).toHaveLength(0);
  expect(current.status).not.toBe("completed");
  expect(current.successCondition).toBe(work.successCondition);
  expect(JSON.stringify(events)).not.toContain("private failure detail");
  if (boundary === "late-alarm") {
    expect(reads).toBe(beforeAlarm);
    expect(workView(events, owner).commitments[0].recoveryAt).toBeUndefined();
  }
  if (boundary === "unknown-send") {
    expect([...workState(events, owner).receipts.values()][0].status).toBe("unknown");
    expect(current.decision?.kind).toBe("review");
  }
  await h.restart(); expect(f.sends).toHaveLength(0);
});

test("owner decision reaches the existing proactive outbox, obeys preferences and becomes stale after an edit", async () => {
  const { f, binding, sent, host } = await workOutboxFixture();
  await applyWorkCommand(binding, f.input(), {
    trusted: true,
    ref: "owner:fixture",
  });
  await host.wake("user-123");
  const rows = await host.read("user-123");
  expect(rows.some((e) => e.type === "AikoWorkNotice")).toBe(true);
  expect(rows.some((e) => e.type === "AikoProactiveAccepted" && e.work)).toBe(
    true,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("May I send this request");
  expect(sent[0]).toContain("I won’t start this request");
  const w = workState(rows, owner).commitments.get("agenda")!;
  const ref = { workId: w.id, version: w.version };
  await applyWorkCommand(
    binding,
    {
      action: "change",
      change: "pause",
      id: w.id,
      expectedVersion: w.version,
      operationId: "pause",
    },
    { trusted: true, ref: "owner:fixture" },
  );
  expect(workNoticeCurrent(await host.read("user-123"), owner, ref)).toBe(
    false,
  );
  const view = await (
    await secretaryWorkApi(
      new Request("http://test/api/secretary/work"),
      binding,
      () => {},
    )
  ).json();
  await applyWorkCommand(
    binding,
    {
      action: "attention",
      operationId: "quiet",
      expectedRevision: view.attention.revision,
      preferences: { ...view.attention.preferences, enabled: false },
    },
    { trusted: true, ref: "owner:fixture" },
  );
  await applyWorkCommand(
    binding,
    { ...f.input(), id: "second", operationId: "second" },
    { trusted: true, ref: "owner:fixture" },
  );
  await host.wake("user-123");
  expect(sent).toHaveLength(1);
  expect(
    (await host.read("user-123")).some(
      (e) => e.type === "AikoProactiveSuppressed",
    ),
  ).toBe(true);
});

for (const correction of ["none", "revise", "cancel", "prerequisite-reopened"] as const) test(`checked prerequisite readiness follows through after restart (${correction})`, async () => {
  const f = await workOutboxFixture(), source = { trusted: true, ref: "owner:fixture" };
  const command = (body: object) => applyWorkCommand(f.binding, body, source);
  const current = async (id: string) => workState(await f.host.read("user-123"), owner).commitments.get(id)!;
  await f.host.commitRoot(f.host.self("user-123"), { type: "MessageReceived", id: "preparing-review", epoch: 0, source: "telegram", chat: owner, text: "Help me finish another task first", at: Date.now() });
  await command(f.f.input()); await f.host.wake("user-123");
  const agenda = await current("agenda");
  await command({ action: "decide", operationId: "grant-agenda", id: agenda.id, expectedVersion: agenda.version, decisionId: agenda.decision!.id, planDigest: agenda.decision!.planDigest, choice: "approve" });
  await f.host.wake("user-123");
  expect((await current("agenda")).status).toBe("waiting");
  await command({ ...f.f.input(), id: "review", operationId: "capture-review", plan: null, dependencyRefs: ["agenda"], nextAction: "Prepare the review slides" });
  await command({ action: "change", change: "review", operationId: "wait-agenda", id: "review", expectedVersion: (await current("review")).version,
    waitingFor: "The checked agenda", nextReviewAt: Date.now() + hour, nextAction: "Prepare the review slides" });
  await f.host.wake("user-123");
  expect((await f.host.read("user-123")).some(e => e.type === "AikoProactiveDecision" && (e.work as any)?.readyDependencies)).toBe(false);
  f.f.message(3, "1. Launch status\n2. Budget approval\n3. Hiring plan");
  await f.host.commitRoot(f.host.self("user-123"), { type: "AikoWorkContactObserved", owner, id: "agenda-arrived", at: Date.now() });
  await f.host.wake("user-123");
  const checked = await current("agenda");
  expect(checked.status).toBe("completed"); expect(checked.evidenceRefs).toHaveLength(1);
  const original = (await f.host.read("user-123")).find(e => e.type === "AikoProactiveDecision" && (e.work as any)?.readyDependencies)!;
  expect(original?.work).toMatchObject({ workId: "review", readyDependencies: [{ workId: "agenda", version: checked.version }] });
  expect(original.text).toContain("Prepare the review slides"); expect(f.sent).toHaveLength(0);
  await f.restart(); expect(f.sent).toHaveLength(0);
  if (correction === "prerequisite-reopened") {
    f.f.contacts.push({ type: "AikoSecretaryUpdate", id: "withdrawn-agenda", updateId: 40,
      update: { kind: "delete", connection: (f.f.contacts[0]!.update as any).connection, chat, messageIds: [3] } });
    await f.host.commitRoot(f.host.self("user-123"), { type: "AikoWorkContactObserved", owner, id: "agenda-edited", at: Date.now() });
  } else if (correction !== "none") await command({ action: "change", change: correction === "cancel" ? "cancel" : "review", operationId: "correct-review", id: "review", expectedVersion: (await current("review")).version,
    waitingFor: "The checked agenda", nextReviewAt: Date.now() + hour, nextAction: "Prepare a one-page summary instead" });
  await f.host.wake("user-123");
  await f.host.seed("user-123", [{ type: "TurnCompleted", turn: "preparing-review", epoch: 0, output: "Your other task is finished.", at: Date.now() }]);
  await f.host.wake("user-123");
  const rows = await f.host.read("user-123");
  const notices = rows.filter(e => e.type === "AikoProactiveAccepted" && (e.work as any)?.workId === "review");
  expect(notices).toHaveLength(correction === "cancel" || correction === "prerequisite-reopened" ? 0 : 1);
  if (correction === "revise") expect(notices[0]!.text).toContain("one-page summary instead");
  if (correction !== "none") expect(rows.some(e => e.type === "AikoProactiveSuppressed" && e.id === original.id)).toBe(true);
  expect(f.sent.some(s => s.includes("Your other task is finished"))).toBe(true);
  const sent = f.sent.length; await f.restart(); expect(f.sent).toHaveLength(sent);
});

for (const changed of [false, true]) test(`pending work contribution survives a busy foreground restart${changed ? " and is invalidated by an owner correction" : " and is delivered once after the answer"}`, async () => {
  const f = await workOutboxFixture();
  await f.host.commitRoot(f.host.self("user-123"), {
    type: "MessageReceived", id: "busy-owner", epoch: 0, source: "telegram", chat: owner,
    text: "Help me finish this other task first", at: Date.now(),
  });
  await applyWorkCommand(f.binding, f.f.input(), { trusted: true, ref: "owner:fixture" });
  await f.host.wake("user-123");
  let rows = await f.host.read("user-123");
  const proposal = rows.find(e => e.type === "AikoProactiveDecision" && e.work)!;
  expect(proposal.contribution).toMatchObject({ version: 2, action: "notify" });
  expect(rows.some(e => e.type === "AikoProactiveDeferred" && e.reason === "foreground-busy")).toBe(true);
  expect(f.sent).toHaveLength(0);
  await f.restart();
  expect(f.sent).toHaveLength(0);
  if (changed) {
    const work = workState(await f.host.read("user-123"), owner).commitments.get("agenda")!;
    await applyWorkCommand(f.binding, { action: "change", change: "pause", id: work.id,
      expectedVersion: work.version, operationId: "owner-changed-plan" }, { trusted: true, ref: "owner:fixture" });
  }
  // Trusted fixture history supplies the foreground terminal; the coordinator,
  // native wait, admission and physical test sender are the production path.
  await f.host.seed("user-123", [{ type: "TurnCompleted", turn: "busy-owner", epoch: 0, output: "The other task is finished.", at: Date.now() }]);
  await f.host.wake("user-123");
  rows = await f.host.read("user-123");
  const accepted = rows.filter(e => e.type === "AikoProactiveAccepted" && e.id === proposal.id);
  expect(accepted).toHaveLength(changed ? 0 : 1);
  expect(f.sent.some(text => text.includes("The other task is finished"))).toBe(true);
  expect(rows.filter(e => e.type === "AikoDeliverySettled" && e.turn === `proactive:${proposal.id}` && (e.result as any)?.status === "delivered")).toHaveLength(changed ? 0 : 1);
  if (changed) expect(rows.some(e => e.type === "AikoProactiveSuppressed" && e.id === proposal.id)).toBe(true);
  const before = f.sent.length;
  await f.restart();
  expect(f.sent).toHaveLength(before);
});
