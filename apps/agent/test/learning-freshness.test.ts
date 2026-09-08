import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createBunHost } from "tardie/bun/host";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { createReflectionActor } from "../src/background.ts";
import { indexLearning, memorySnapshot } from "../src/learning.ts";
import { openMemory, type MemoryBinding } from "../src/memory.ts";

// Native reflection components and SQLite host recovery. The trusted fixture
// seeds a pending job; it does not attest source ingestion or live providers.
for (const backend of ["bun", "worker"] as const) {
  for (const change of ["revoke", "supersede", "forget", "mixed", "policy-current", "policy-revoke", "policy-ingestion", "policy-foreign", "policy-missing-change", "policy-owner", "policy-scope"] as const) {
    test(`${backend}: ${change} filters stale reflection input before inference and after restart`, async () => {
      const dir = await mkdtemp("/tmp/learning-freshness-"), thread = "background-123-reflection";
      const binding: MemoryBinding = { owner: "123", stateDir: dir, thread, redact: s => s, readPage: async () => [] };
      const original = { id: "freshness-source", subject: "controlled/source", title: "STALE_TITLE_MARKER",
        type: "fact", kind: "fact" as const, payload: { text: "STALE_PAYLOAD_MARKER" } };
      const first = await indexLearning(binding, original, s => s);
      const withIngestion = ["policy-ingestion", "policy-foreign", "policy-missing-change", "policy-owner", "policy-scope"].includes(change);
      if (withIngestion) {
        const m = openMemory(binding);
        try {
          for (let n = 0; n < 9; n++) m.remember({ subject: `unrelated/${n}`, title: "Concurrent change", type: "fact", payload: n },
            { key: `concurrent-${n}`, producer: { kind: "agent", reference: "controlled" } });
        } finally { m.close(); }
      }
      if (change === "mixed") {
        const m = openMemory(binding);
        try { m.remember({ subject: "controlled/current", title: "Current evidence", type: "fact", payload: "Current payload" },
          { key: "current-evidence", producer: { kind: "agent", reference: "controlled" } }); }
        finally { m.close(); }
      }
      const snapshot = memorySnapshot(binding), at = Date.now();
      const policyQuiet = change.startsWith("policy-");
      const checkedSupport = change === "policy-current" || change === "policy-ingestion";
      const changed = withIngestion ? [...snapshot.leaves.filter(l => l.observation !== first.observation),
        ...(change === "policy-missing-change" ? [] : snapshot.leaves.filter(l => l.observation === first.observation))] : snapshot.leaves;
      let calls = 0, db: Database | undefined;
      const model = () => Layer.succeed(Infer, {
        resolve: () => ({ model: { provider: "fixture", model_id: "freshness" } }),
        react: () => {
          calls++;
          return Effect.succeed({ kind: "complete" as const, mode: { kind: "local", name: "validate-once" },
            output: JSON.stringify({ decision: "silent", reason: "Controlled current evidence", text: "", supports: [] }) });
        },
      });
      const create = async () => {
        const definition = createReflectionActor(binding), inference = model();
        if (backend === "bun") return createBunHost({ database: join(dir, "native.sqlite"), actorName: "aiko",
          actorInstance: "freshness", actorFor: () => definition, layersFor: () => inference });
        db = new Database(join(dir, "native.sqlite"));
        const storage: AccountStorage = { sql: { exec: (query, ...args) => {
          const rows = db!.query(query).all(...args as any);
          return { toArray: () => rows as never };
        } }, transactionSync: f => db!.transaction(f)(), sync: async () => {},
          getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
        return createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "freshness",
          ownsThread: t => t === thread, actorFor: () => definition, layersFor: () => inference });
      };
      let host = await create(), closed = false;
      try {
        await host.commitRoot(host.self(thread), { type: "FixtureRoot", at });
        await host.seed(thread, [
          { type: "AikoHooksConfigured", paused: true, at },
          { type: "AikoReflectionRequested", id: "pending-change", owner: change === "policy-owner" ? "456" : "123", cause: "controlled-change", at,
            ...(change === "policy-scope" ? { scope: "aiko:456" } : {}),
            root: snapshot.root, changed, ...(withIngestion ? { ingestion: change === "policy-foreign" ? { ...first.ingestion, owner: "456" } : first.ingestion } : {}), notification: policyQuiet
              ? { decision: "silent", reason: "Controlled lifecycle policy" } : { decision: "consider" } },
        ]);
        const memory = openMemory(binding);
        try {
          if (change === "revoke" || change === "mixed" || change === "policy-revoke") {
            const source = memory.sources()[0]!;
            memory.approveSource(source.id, source.revision, false, "revoke-before-reflection");
          } else if (change === "forget") memory.forget(first.subject, first.observation, "forget-before-reflection");
          else if (!policyQuiet) await indexLearning(binding, { ...original, id: "replacement", payload: { text: "Current replacement" } }, s => s);
        } finally { memory.close(); }
        await host.seed(thread, [{ type: "AikoHooksConfigured", paused: false, at: at + 1 }]);
        await host.wake(thread);
        let rows = await host.read(thread) as readonly Event[];
        const decisions = rows.filter(e => e.type === "AikoDecisionRecorded");
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ decision: "silent", supports: checkedSupport ? [first.observation] : [] });
        if (policyQuiet) {
          expect(decisions[0]).toMatchObject({ owner: "123", cause: "controlled-change", root: snapshot.root,
            supportStatus: checkedSupport ? "current" : "unavailable", supportCoverage: "bounded", supportLimit: 8 });
          if (!["policy-foreign", "policy-missing-change", "policy-owner", "policy-scope"].includes(change)) expect(typeof decisions[0]!.supportScopeVersion).toBe("number");
          expect(rows.some(e => e.type === "AikoDecisionPublished")).toBe(false);
          if (withIngestion) {
            expect(changed.slice(0, 8).every(l => l.observation !== first.observation)).toBe(true);
            if (change === "policy-ingestion") expect(decisions[0]).toMatchObject({ ingestion: first.ingestion, supportSource: "ingestion" });
          }
        }
        const messages = rows.filter(e => e.type === "MessageReceived");
        expect(JSON.stringify(messages)).not.toContain("STALE_TITLE_MARKER");
        expect(JSON.stringify(messages)).not.toContain("STALE_PAYLOAD_MARKER");
        expect(calls).toBe(change === "mixed" ? 1 : 0);
        if (change === "mixed") {
          const context = JSON.parse(String(messages[0]!.text));
          expect(context.changed).toHaveLength(1);
          expect(context.evidence).toHaveLength(1);
          expect(context.changed[0].subject).toBe("controlled/current");
        } else {
          expect(messages).toHaveLength(0);
          expect(decisions[0]!.reason).toBe(policyQuiet ? "Controlled lifecycle policy" : "Changed evidence is no longer current or available");
        }
        closed = true; await host.close(); db?.close(); db = undefined;
        host = await create(); closed = false; await host.wake(thread);
        rows = await host.read(thread) as readonly Event[];
        expect(rows.filter(e => e.type === "AikoDecisionRecorded")).toHaveLength(1);
        expect(calls).toBe(change === "mixed" ? 1 : 0);
      } finally { if (!closed) await host.close(); db?.close(); await rm(dir, { recursive: true, force: true }); }
    });
  }
}
