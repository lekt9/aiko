import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openHostMemory } from "../src/memory-node.ts";
const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "fixture" } });

test("normal Bun host atomically retains authority, rolls back failure and restores after journal loss", () => {
  const dir = mkdtempSync("/tmp/bun-memory-authority-"); const path = `${dir}/memory.sqlite`;
  let memory = openHostMemory(path, "aiko:fixture", {});
  const db = new DatabaseSync(path);
  try {
    expect(() => memory.checkArchiveErasure({})).toThrow("authority");
    const a = memory.remember({ subject: "a", type: "note", title: "private", payload: "private" }, write("a"));
    const kept = memory.remember({ subject: "kept", type: "note", title: "kept", payload: "independent" }, write("kept"));
    const old = memory.exportArchive(), beforeAuthority = db.prepare("SELECT * FROM aiko_memory_erasure_authority").get();
    const input = { subject: a.subject, expectedHead: a.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "erase" };
    db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON aiko_memory_erasure_authority BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END");
    expect(() => memory.eraseSubject(input)).toThrow("fixture checkpoint failure");
    expect(memory.exportArchive()).toEqual(old);
    expect(db.prepare("SELECT * FROM aiko_memory_erasure_authority").get()).toEqual(beforeAuthority);
    db.exec("DROP TRIGGER reject_checkpoint");
    memory.eraseSubject(input); const current = memory.exportArchive(), fence = memory.erasureFence();
    expect(JSON.parse(String(db.prepare("SELECT fence FROM aiko_memory_erasure_authority").get()!.fence))).toEqual(fence);
    memory.close(); memory = openHostMemory(path, "aiko:fixture", {});
    memory.eraseSubject(input); expect(memory.erasureFence()).toEqual(fence);
    for (const table of ["journal", "artifacts", "observations", "heads", "sources"]) db.exec(`DELETE FROM ${table}`);
    memory.close(); memory = openHostMemory(path, "aiko:fixture", {});
    expect(() => memory.importArchive(old)).toThrow("fence");
    expect(() => memory.remember({ subject: "new", type: "note", title: "new", payload: "new" }, write("new"))).toThrow("restored before");
    memory.importArchive(current); expect(memory.get(a.id)).toBeNull(); expect(memory.get(kept.id)?.observation.payload).toBe("independent");
    memory.close(); memory = openHostMemory(path, "aiko:fixture", {}); expect(memory.erasureFence()).toEqual(fence);
  } finally { memory.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bun guarded memory preserves native approved file refresh and filesystem safety", async () => {
  const dir = mkdtempSync("/tmp/bun-memory-file-"); const path = `${dir}/memory.sqlite`;
  const file = `${dir}/source.json`; writeFileSync(file, JSON.stringify([{ id: "note", title: "Fixture", value: "file-source-data" }]));
  const memory = openHostMemory(path, "aiko:files", {});
  try {
    const source = memory.registerSource({ id: "file", namespace: "files", type: "note", resolver: "file", locator: file, format: "json", ttlSeconds: 1000 }, "register");
    memory.approveSource(source.id, source.revision, true, "approve");
    const result = await memory.refresh(source.id, { key: "read" });
    expect(result.observations).toHaveLength(1);
    expect(JSON.stringify(memory.get(result.observations[0]!)?.observation.payload)).toContain("file-source-data");
    expect(await memory.refresh(source.id, { key: "read" })).toEqual(result);
    chmodSync(path, 0o644); expect(() => openHostMemory(path, "aiko:files", {})).toThrow("Unsafe memory file"); chmodSync(path, 0o600);
    symlinkSync(path, `${dir}/linked.sqlite`); expect(() => openHostMemory(`${dir}/linked.sqlite`, "aiko:files", {})).toThrow("Unsafe memory file");
  } finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
