import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { harnessBlobStore, harnessDigest } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";

// Live KV custody only. These checks do not attest forensic disk deletion,
// backups, actor-log migration or selection of a user's full erasure closure.
test("erasure removes live ciphertext and fences identical payload replay after SQLite reopen", async () => {
  const dir = await mkdtemp("/tmp/harness-erasure-");
  let db = new Database(join(dir, "custody.sqlite"));
  try {
    let blobs = harnessBlobStore(sqliteWorkflowKV(db));
    const value = { text: "CONTROLLED_PRIVATE_ERASURE_MARKER" }, ref = await blobs.putPrivate("123", value);
    const prior = db.query("SELECT key,value FROM workflow_records WHERE key LIKE ?").get(`%${ref}`) as { key: string; value: string };
    const ciphertext = JSON.parse(prior.value).ciphertext;
    const receipt = await blobs.erase!("123", ref, "private-erasure-operation");
    expect(receipt).toMatchObject({ version: 1, reference: ref, status: "erased" });
    const live = JSON.stringify(db.query("SELECT key,value FROM workflow_records").all());
    expect(live).not.toContain(ciphertext);
    expect(live).not.toContain(value.text);
    expect(live).not.toContain("private-erasure-operation");
    await expect(blobs.get("123", ref)).rejects.toThrow("unavailable");
    db.close(); db = new Database(join(dir, "custody.sqlite"));
    blobs = harnessBlobStore(sqliteWorkflowKV(db));
    expect(await blobs.erase!("123", ref, "private-erasure-operation")).toEqual(receipt);
    await expect(blobs.erase!("123", ref, "different-operation")).rejects.toThrow("conflict");
    await expect(blobs.get("123", ref)).rejects.toThrow("unavailable");
    await expect(blobs.putPrivate("123", value)).rejects.toThrow("unavailable");
    expect(JSON.stringify(db.query("SELECT value FROM workflow_records WHERE key=?").get(prior.key))).not.toContain(ciphertext);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("erasure preserves equal content in another owner and unrelated content in the same owner", async () => {
  const db = new Database(":memory:");
  try {
    const blobs = harnessBlobStore(sqliteWorkflowKV(db)), value = { code: "controlled equal bytes" };
    const a = await blobs.put("123", value), b = await blobs.put("456", value);
    expect(a).toBe(b);
    const untouched = await blobs.putPrivate("123", { text: "Unrelated" });
    await blobs.erase!("123", a, "erase-owner-123-only");
    await expect(blobs.get("123", a)).rejects.toThrow("unavailable");
    expect(await blobs.get("456", b)).toEqual(value);
    expect(await blobs.get("123", untouched)).toEqual({ text: "Unrelated" });
    expect(await blobs.put("456", value)).toBe(b);
  } finally { db.close(); }
});

test("missing or invalid erasure targets cannot reserve future blob identities", async () => {
  const db = new Database(":memory:");
  try {
    const blobs = harnessBlobStore(sqliteWorkflowKV(db)), value = { text: "Future valid content" }, ref = harnessDigest(value);
    await expect(blobs.erase!("123", ref, "unknown-reference")).rejects.toThrow("unavailable");
    expect(db.query("SELECT * FROM workflow_records").all()).toHaveLength(0);
    expect(await blobs.put("123", value)).toBe(ref);
    await expect(blobs.erase!("456", ref, "foreign-reference")).rejects.toThrow("unavailable");
    await expect(blobs.erase!("123", ref, "")).rejects.toThrow("Invalid");
    expect(await blobs.get("123", ref)).toEqual(value);
  } finally { db.close(); }
});

for (const operation of ["get", "put"] as const) test(`erasure fences ${operation} already waiting on a retained row`, async () => {
  const db = new Database(":memory:");
  let release!: () => void;
  try {
    const kv = sqliteWorkflowKV(db), owner = "123", value = { text: "Private in-flight value" };
    const writer = harnessBlobStore(kv), ref = await writer.putPrivate(owner, value);
    const row = db.query("SELECT key FROM workflow_records WHERE key LIKE ?").get(`%${ref}`) as { key: string };
    let entered!: () => void, held = false;
    const ready = new Promise<void>(r => { entered = r; }), resume = new Promise<void>(r => { release = r; });
    const reader = harnessBlobStore({ ...kv, get: async key => {
      const stored = await kv.get(key);
      if (key === row.key && !held) { held = true; entered(); await resume; }
      return stored;
    } });
    const pending = (operation === "get" ? reader.get(owner, ref) : reader.putPrivate(owner, value))
      .then(value => ({ value }), error => ({ error }));
    await ready;
    await writer.erase!(owner, ref, "concurrent-erase");
    release();
    const outcome = await pending;
    expect("error" in outcome).toBe(true);
    expect("value" in outcome).toBe(false);
    await expect(writer.get(owner, ref)).rejects.toThrow("unavailable");
    expect((await kv.get(row.key) as { kind: string }).kind).toBe("erased");
  } finally { release?.(); db.close(); }
});

test("observation retirement erases linked private copies and preserves independent equal content", async () => {
  const db = new Database(":memory:");
  try {
    const blobs = harnessBlobStore(sqliteWorkflowKV(db)), source = harnessDigest(["observation", "a"]);
    const value = { text: "DEPENDENT_PRIVATE_COPY" };
    const direct = await blobs.putPrivate("123", value, [source]);
    const derived = await blobs.putPrivate("123", { text: value.text.toLowerCase() }, [source]);
    const independent = await blobs.putPrivate("123", value);
    const otherOwner = await blobs.putPrivate("456", value, [source]);
    const before = db.query("SELECT value FROM workflow_records WHERE key LIKE ?").get(`%${direct}`) as { value: string };
    const ciphertext = JSON.parse(before.value).ciphertext;
    const receipt = await blobs.eraseDependencies!("123", [source], "erase-source");
    expect(receipt.references).toEqual([direct, derived].sort());
    await expect(blobs.get("123", direct)).rejects.toThrow("unavailable");
    await expect(blobs.get("123", derived)).rejects.toThrow("unavailable");
    await expect(blobs.putPrivate("123", { text: "new copy" }, [source])).rejects.toThrow("unavailable");
    expect(await blobs.get("123", independent)).toEqual(value);
    expect(await blobs.get("456", otherOwner)).toEqual(value);
    expect(JSON.stringify(db.query("SELECT value FROM workflow_records").all())).not.toContain(ciphertext);
    expect(await blobs.eraseDependencies!("123", [source], "erase-source")).toEqual(receipt);
  } finally { db.close(); }
});

test("interrupted dependency cleanup fences every linked read and resumes after custody reopen", async () => {
  const db = new Database(":memory:");
  try {
    const kv = sqliteWorkflowKV(db), source = harnessDigest("erased-evidence");
    let blobs = harnessBlobStore(kv);
    const refs = [await blobs.putPrivate("123", { value: 1 }, [source]), await blobs.putPrivate("123", { value: 2 }, [source])];
    let interrupted = false;
    const failing = harnessBlobStore({ ...kv, update: async (key, change) => {
      if (key.startsWith("harness-blobs:") && !interrupted) { interrupted = true; throw Error("controlled cleanup interruption"); }
      await kv.update(key, change);
    } });
    await expect(failing.eraseDependencies!("123", [source], "interrupted-erasure")).rejects.toThrow("interruption");
    blobs = harnessBlobStore(kv);
    for (const ref of refs) await expect(blobs.get("123", ref)).rejects.toThrow("unavailable");
    await expect(blobs.putPrivate("123", { value: 3 }, [source])).rejects.toThrow("unavailable");
    const completed = await blobs.eraseDependencies!("123", [source], "interrupted-erasure");
    expect(completed.references).toEqual(refs.sort());
    for (const ref of refs) {
      const row = db.query("SELECT value FROM workflow_records WHERE key LIKE ?").get(`%${ref}`) as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({ kind: "erased" });
      expect(JSON.parse(row.value).ciphertext).toBeUndefined();
    }
  } finally { db.close(); }
});

test("dependency retirement before a registered writer stores bytes prevents resurrection", async () => {
  const db = new Database(":memory:"); let release!: () => void;
  try {
    const kv = sqliteWorkflowKV(db), source = harnessDigest("registered-before-encryption");
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const writer = harnessBlobStore({ ...kv, update: async (key, change) => {
      if (key.startsWith("harness-blobs:")) { entered(); await resume; }
      await kv.update(key, change);
    } });
    const pending = writer.putPrivate("123", { text: "PRIVATE_LATE_COPY" }, [source]).then(value => ({ value }), error => ({ error }));
    await waiting;
    const receipt = await harnessBlobStore(kv).eraseDependencies!("123", [source], "concurrent-erasure");
    expect(receipt.references).toHaveLength(1);
    release();
    expect(await pending).toHaveProperty("error");
    await expect(writer.get("123", receipt.references[0]!)).rejects.toThrow("unavailable");
    const row = db.query("SELECT value FROM workflow_records WHERE key LIKE ?").get(`%${receipt.references[0]}`) as { value: string };
    expect(JSON.parse(row.value).ciphertext).toBeUndefined();
  } finally { release?.(); db.close(); }
});

test("dependency metadata is authenticated and missing evidence indices fail closed", async () => {
  const db = new Database(":memory:");
  try {
    const kv = sqliteWorkflowKV(db), blobs = harnessBlobStore(kv), source = harnessDigest("original-dependency"), other = harnessDigest("replacement-dependency");
    const ref = await blobs.putPrivate("123", { value: "PRIVATE_AUTHENTICATED_DEPENDENCY" }, [source]);
    await blobs.putPrivate("123", { value: "independent" }, [other]);
    const row = db.query("SELECT key,value FROM workflow_records WHERE key LIKE ?").get(`%${ref}`) as { key: string; value: string };
    await kv.put(row.key, { ...JSON.parse(row.value), dependencies: [other] });
    await expect(blobs.get("123", ref)).rejects.toThrow();
    await kv.put(row.key, JSON.parse(row.value));
    db.query("DELETE FROM workflow_records WHERE key LIKE ?").run(`harness-blob-dependencies:%:${source}`);
    await expect(blobs.get("123", ref)).rejects.toThrow("unavailable");
  } finally { db.close(); }
});

test("a whole erasure closure exceeds one result's dependency limit without widening operation replay", async () => {
  const db = new Database(":memory:");
  try {
    const blobs = harnessBlobStore(sqliteWorkflowKV(db));
    const dependencies = Array.from({ length: 1025 }, (_, index) => harnessDigest(["history", index]));
    const first = await blobs.putPrivate("123", { value: "first revision" }, [dependencies[0]!]);
    const last = await blobs.putPrivate("123", { value: "last revision" }, [dependencies.at(-1)!]);
    const extra = harnessDigest("unrelated-observation"), keep = await blobs.putPrivate("123", { value: "keep" }, [extra]);
    const receipt = await blobs.eraseDependencies!("123", dependencies, "long-subject-history");
    expect(receipt.references).toEqual([first, last].sort());
    expect(await blobs.eraseDependencies!("123", [...dependencies].reverse(), "long-subject-history")).toEqual(receipt);
    await expect(blobs.eraseDependencies!("123", [...dependencies, extra], "long-subject-history")).rejects.toThrow("conflict");
    expect(await blobs.get("123", keep)).toEqual({ value: "keep" });
    await expect(blobs.putPrivate("123", { value: "oversized read dependencies" }, dependencies)).rejects.toThrow("Invalid");
  } finally { db.close(); }
});
