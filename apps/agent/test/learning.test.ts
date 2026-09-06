import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Memory, tardigradeLogSource } from "entity-learn";
import {
  indexLearning,
  memorySnapshot,
  validateLearningInput,
  type LearningInput,
} from "../src/learning.ts";
import { openMemory } from "../src/memory.ts";
import { redactor } from "../src/security.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const stateDir = await mkdtemp("/tmp/aiko-learning-");
  directories.push(stateDir);
  return { stateDir, owner: "123" };
}
const input: LearningInput = {
  id: "learn-event-001",
  subject: "github/example/issue/42",
  title: "Fix index cursor",
  type: "issue",
  kind: "entity",
  payload: { status: "open", owner: "Sam" },
};

async function interruptBeforeApproval(
  binding: Awaited<ReturnType<typeof fixture>>,
) {
  const memory = new Memory({ path: ":memory:", scope: "test" });
  const prototype = Object.getPrototypeOf(memory.journal) as Memory["journal"];
  const commit = prototype.commit;
  const interrupted = spyOn(prototype, "commit").mockImplementation(function (
    this: Memory["journal"],
    ...args: Parameters<Memory["journal"]["commit"]>
  ) {
    if (args[1].startsWith("learning-approve:"))
      throw new Error("crash before native approval");
    return commit.apply(this, args);
  });
  try {
    await expect(indexLearning(binding, input, redactor())).rejects.toThrow(
      "crash before native approval",
    );
  } finally {
    interrupted.mockRestore();
    memory.close();
  }
}

test("learning validates the envelope and delegates credential and JSON admission to native memory", () => {
  expect(validateLearningInput(input)).toEqual(input);
  for (const field of ["owner", "scope", "path", "producer", "command"])
    expect(
      validateLearningInput({ ...input, [field]: "injected" }),
    ).toBeUndefined();
  for (const payload of [
    { password: "do-not-store" },
    { token: "ghp_abcdefghijklmnopqrstuvwxyz" },
    { value: Number.NaN },
    { value: undefined },
    { text: "x".repeat(24_000) },
  ])
    expect(validateLearningInput({ ...input, payload })).toBeUndefined();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(validateLearningInput({ ...input, payload: cycle })).toBeUndefined();
  expect(validateLearningInput({ ...input, id: "../bad" })).toBeUndefined();
  expect(validateLearningInput({ ...input, subject: "x\ny" })).toBeUndefined();
});

test("native hook observations are replay-stable, citeable, corrected and isolated by owner", async () => {
  const binding = await fixture();
  const first = await indexLearning(binding, input, redactor());
  expect(first.changed).toBe(true);
  expect(first.subject).toBe("learning/issue/github%2Fexample%2Fissue%2F42");
  expect(await indexLearning(binding, input, redactor())).toEqual(first);
  const second = await indexLearning(
    binding,
    {
      ...input,
      id: "learn-event-002",
      payload: { status: "closed", owner: "Sam" },
    },
    redactor(),
  );
  expect(second.changed).toBe(true);
  expect(second.observation).not.toBe(first.observation);
  const memory = openMemory(binding);
  try {
    expect(memory.history(first.subject)).toHaveLength(2);
    expect(memory.get(second.observation)?.observation.supersedes).toBe(
      first.observation,
    );
    expect(
      memory.get(second.observation)?.observation.producer.evidenceReference,
    ).toBe(`aiko-learning:learn-event-002#previous=${first.observation}`);
    expect(
      memory.remember(
        {
          subject: "decision/next-step",
          title: "Next step",
          type: "decision",
          payload: { action: "announce" },
          supports: [second.observation],
        },
        {
          key: "decision-001",
          producer: { kind: "agent", reference: "reflection" },
        },
      ).supports,
    ).toEqual([second.observation]);
  } finally {
    memory.close();
  }
  expect(memorySnapshot({ ...binding, owner: "456" }).leaves).toHaveLength(0);
  const foreign = openMemory({ ...binding, owner: "456" });
  try {
    expect(foreign.get(first.observation)).toBeNull();
  } finally {
    foreign.close();
  }
});

test("redaction precedes persistent admission and identical evidence does not move the Merkle root", async () => {
  const binding = await fixture();
  const evidence = {
    ...input,
    payload: { text: "Known private marker: alpha-secret-value" },
  };
  const redact = redactor(["alpha-secret-value"]);
  const first = await indexLearning(binding, evidence, redact);
  const initial = memorySnapshot(binding);
  const second = await indexLearning(
    binding,
    { ...evidence, id: "learn-event-003" },
    redact,
  );
  expect(second.changed).toBe(false);
  expect(second.digest).toBe(first.digest);
  expect(second.observation).not.toBe(first.observation);
  expect(memorySnapshot(binding).root).toBe(initial.root);
  const memory = openMemory(binding);
  try {
    expect(JSON.stringify(memory.get(first.observation))).not.toContain(
      "alpha-secret-value",
    );
    expect(JSON.stringify(memory.get(first.observation))).toContain(
      "[redacted]",
    );
  } finally {
    memory.close();
  }
  await indexLearning(
    binding,
    { ...input, id: "learn-event-004", title: "Cursor fixed" },
    redact,
  );
  expect(memorySnapshot(binding).root).not.toBe(initial.root);
});

test("disabled sources stay disabled and forgotten evidence cannot return to snapshots or ingestion", async () => {
  const binding = await fixture();
  const first = await indexLearning(binding, input, redactor());
  const memory = openMemory(binding);
  try {
    const source = memory.sources()[0];
    memory.approveSource(source.id, source.revision, false, "disable-source");
  } finally {
    memory.close();
  }
  await expect(
    indexLearning(binding, { ...input, id: "learn-event-005" }, redactor()),
  ).rejects.toMatchObject({ code: "source_disabled" });
  const second = openMemory(binding);
  try {
    second.forget(first.subject, first.observation, "forget-entity");
  } finally {
    second.close();
  }
  expect(memorySnapshot(binding)).toMatchObject({ leaves: [], complete: true });
});

test("an interrupted native registration resumes its exact approval and ingestion after reopening", async () => {
  const binding = await fixture();
  await interruptBeforeApproval(binding);
  const pending = openMemory(binding);
  try {
    expect(pending.sources()[0].enabled).toBe(false);
  } finally {
    pending.close();
  }
  const result = await indexLearning(binding, input, redactor());
  expect(await indexLearning(binding, input, redactor())).toEqual(result);
  const recovered = openMemory(binding);
  try {
    expect(recovered.sources()[0].enabled).toBe(true);
    expect(recovered.history(result.subject)).toHaveLength(1);
    expect(
      recovered.journal
        .events(recovered.scope)
        .filter(({ event }) => event.key.startsWith("learning-approve:")),
    ).toHaveLength(1);
    expect(recovered.rebuild().observations).toBe(1);
  } finally {
    recovered.close();
  }
});

test("a revocation between new registration and approval invalidates the optimistic version witness", async () => {
  const binding = await fixture();
  const probe = new Memory({ path: ":memory:", scope: "test" });
  const prototype = Object.getPrototypeOf(probe.journal) as Memory["journal"];
  const commit = prototype.commit;
  let revoked = false;
  const interleave = spyOn(prototype, "commit").mockImplementation(function (
    this: Memory["journal"],
    ...args: Parameters<Memory["journal"]["commit"]>
  ) {
    if (!revoked && args[1].startsWith("learning-approve:")) {
      revoked = true;
      const operator = openMemory(binding);
      try {
        const source = operator.sources()[0];
        operator.approveSource(
          source.id,
          source.revision,
          false,
          "operator-interleaved-revoke",
        );
      } finally {
        operator.close();
      }
    }
    return commit.apply(this, args);
  });
  try {
    await expect(
      indexLearning(binding, input, redactor()),
    ).rejects.toMatchObject({ code: "source_disabled" });
  } finally {
    interleave.mockRestore();
    probe.close();
  }
  const after = openMemory(binding);
  try {
    expect(after.sources()[0].enabled).toBe(false);
  } finally {
    after.close();
  }
});

test("recovery refuses a disabled pending registration even when revocation changed no source fields", async () => {
  const binding = await fixture();
  await interruptBeforeApproval(binding);
  const memory = openMemory(binding);
  try {
    const source = memory.sources()[0];
    const revoked = memory.approveSource(
      source.id,
      source.revision,
      false,
      "operator-revoked-pending",
    );
    expect(revoked).toEqual(source); // Only the native journal receipt distinguishes these states.
  } finally {
    memory.close();
  }
  await expect(indexLearning(binding, input, redactor())).rejects.toMatchObject(
    { code: "source_disabled" },
  );
  const after = openMemory(binding);
  try {
    expect(after.sources()[0].enabled).toBe(false);
    expect(
      after.journal
        .events(after.scope)
        .filter(({ event }) => event.key.startsWith("learning-approve:")),
    ).toHaveLength(0);
  } finally {
    after.close();
  }
});

test("prior approval receipts and failed refresh quarantine never revive an explicitly disabled source", async () => {
  const binding = await fixture();
  await indexLearning(binding, input, redactor());
  const memory = openMemory(binding);
  try {
    const source = memory.sources()[0];
    // No adapter is mounted in this handle: three real native refresh failures quarantine it.
    for (let attempt = 0; attempt < 3; attempt++)
      expect(
        (await memory.refresh(source.id, { key: `quarantine-${attempt}` }))
          .error,
      ).toBe("adapter_unavailable");
    expect(memory.sources()[0]).toMatchObject({ enabled: false, failures: 3 });
  } finally {
    memory.close();
  }
  await expect(indexLearning(binding, input, redactor())).rejects.toMatchObject(
    { code: "source_disabled" },
  );
  await expect(
    indexLearning(
      binding,
      { ...input, id: "learn-quarantine-002" },
      redactor(),
    ),
  ).rejects.toMatchObject({ code: "source_disabled" });
  const after = openMemory(binding);
  try {
    expect(after.sources()[0]).toMatchObject({ enabled: false, failures: 3 });
  } finally {
    after.close();
  }
});

test("source classification revisions can return to a previous recipe without reviving old heads", async () => {
  const binding = await fixture();
  await indexLearning(binding, input, redactor());
  const revised = await indexLearning(
    binding,
    { ...input, id: "learn-reclass-002", type: "decision", kind: "fact" },
    redactor(),
  );
  expect(memorySnapshot(binding).leaves.map((leaf) => leaf.subject)).toEqual([
    revised.subject,
  ]);
  const restored = await indexLearning(
    binding,
    { ...input, id: "learn-reclass-003" },
    redactor(),
  );
  expect(memorySnapshot(binding).leaves.map((leaf) => leaf.subject)).toEqual([
    restored.subject,
  ]);
  expect(restored.subject).toBe("learning/issue/github%2Fexample%2Fissue%2F42");
  expect(restored.changed).toBe(true);
  expect(
    await indexLearning(
      binding,
      { ...input, id: "learn-reclass-003" },
      redactor(),
    ),
  ).toEqual(restored);
});

test("forgotten source evidence and cited derivations disappear without being restored by later hooks", async () => {
  const binding = await fixture();
  const evidence = await indexLearning(binding, input, redactor());
  const memory = openMemory(binding);
  try {
    memory.remember(
      {
        subject: "derived/decision",
        title: "Derived decision",
        type: "decision",
        payload: { action: "notify" },
        supports: [evidence.observation],
      },
      {
        key: "derived-decision",
        producer: { kind: "agent", reference: "reflection" },
      },
    );
    memory.forget(
      evidence.subject,
      evidence.observation,
      "forget-source-evidence",
    );
  } finally {
    memory.close();
  }
  expect(memorySnapshot(binding)).toMatchObject({ leaves: [], complete: true });
  await expect(
    indexLearning(binding, { ...input, id: "learn-forgotten-002" }, redactor()),
  ).rejects.toMatchObject({ code: "evidence_unavailable" });
  expect(memorySnapshot(binding).leaves).toHaveLength(0);
});

test("snapshots hash sorted content with a truthful 256-head bound", async () => {
  const binding = await fixture();
  const memory = openMemory(binding);
  try {
    for (let index = 0; index < 257; index++)
      memory.remember(
        {
          subject: `entity/${index}`,
          title: `Entity ${index}`,
          type: "entity",
          payload: { index },
        },
        {
          key: `seed-${index}`,
          producer: { kind: "tool", reference: "fixture" },
        },
      );
  } finally {
    memory.close();
  }
  const snapshot = memorySnapshot(binding);
  expect(snapshot.complete).toBe(false);
  expect(snapshot.leaves).toHaveLength(256);
  expect(snapshot.leaves.map((leaf) => leaf.subject)).toEqual(
    snapshot.leaves.map((leaf) => leaf.subject).sort(),
  );
  expect(memorySnapshot(binding).root).toBe(snapshot.root);
  const second = openMemory(binding);
  try {
    const forgotten = second.recall({ subject: "entity/0" }).items[0]
      .observation;
    second.forget(forgotten.subject, forgotten.id, "forget-zero");
  } finally {
    second.close();
  }
  expect(memorySnapshot(binding).complete).toBe(true);
  expect(
    memorySnapshot(binding).leaves.some((leaf) => leaf.subject === "entity/0"),
  ).toBe(false);
});

test("hundreds of native log episodes preserve a complete semantic root and remain recallable context", async () => {
  const binding = await fixture();
  const evidence = await indexLearning(binding, input, redactor());
  const notes = openMemory(binding);
  try {
    notes.remember(
      {
        subject: "notes/launch",
        title: "Launch note",
        type: "note",
        kind: "episode",
        payload: { text: "Prepare the release" },
      },
      {
        key: "saved-note",
        producer: { kind: "agent", reference: "reflection" },
      },
    );
  } finally {
    notes.close();
  }
  const initial = memorySnapshot(binding);
  for (let page = 0; page < 24; page++) {
    const after = page * 25;
    const source = tardigradeLogSource({
      id: `raw-log-page-${page}`,
      actor: "aiko@test:user-messages-v1",
      thread: "user-123",
      after,
      maxEvents: 25,
      read: async () =>
        Array.from({ length: 25 }, (_, offset) => ({
          seq: after + offset + 1,
          event: {
            type: "MessageReceived",
            text: "violetmongoose user memory",
            at: 1,
          },
        })),
      project: ({ event }) => ({ text: String(event.text) }),
      policyVersion: "test-user-message-v1",
    });
    const memory = openMemory(binding, { [source.source.locator]: source.run });
    try {
      const registered = memory.registerSource(
        source.source,
        `log-register-${page}`,
      );
      memory.approveSource(
        registered.id,
        registered.revision,
        true,
        `log-approve-${page}`,
      );
      expect(
        (await memory.refresh(registered.id, { key: `log-refresh-${page}` }))
          .error,
      ).toBeNull();
    } finally {
      memory.close();
    }
  }
  const snapshot = memorySnapshot(binding);
  expect(snapshot.complete).toBe(true);
  expect(snapshot.root).toBe(initial.root);
  expect(snapshot.leaves.map((leaf) => leaf.subject)).toEqual(
    [evidence.subject, "notes/launch"].sort(),
  );
  const context = openMemory(binding);
  try {
    expect(
      context.recall({ search: "violetmongoose" }).items.length,
    ).toBeGreaterThan(0);
  } finally {
    context.close();
  }
});
