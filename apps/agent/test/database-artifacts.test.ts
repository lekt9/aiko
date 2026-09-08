import { expect, test } from "bun:test";
import { nodeStorage } from "entity-learn";
import { StructuredStore } from "../../../packages/structured-data/src/index.ts";
import { artifactReferences, replyArtifacts, reauthorizeReplyResult } from "../src/database-artifacts.ts";
import type { DatabaseBinding } from "../src/database-component.ts";
import { createTelegram } from "../src/telegram.ts";
import { AIKO_MINI_APP_URL, artifactMiniAppUrl, trustedMiniAppUrl } from "../src/telegram-mini-app.ts";

test("reply artifacts reauthorize current field access and reject injected payloads", async () => {
  const storage = nodeStorage(":memory:"); let allowed = true;
  try {
    const store = new StructuredStore(storage, "local", { canRead: () => allowed });
    let n = 0; const execute = (command: Parameters<StructuredStore["execute"]>[1]) => store.execute(`op${++n}`, command, { producer: "fixture", at: 1000 });
    execute({ kind: "database.create", database: { id: "work", name: "Work", lifecycle: "visible" } });
    execute({ kind: "table.define", expectedRevision: 0, table: { id: "items", databaseId: "work", name: "Items", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }] } });
    execute({ kind: "rows.upsert", tableId: "items", rows: [{ id: "one", expectedRevision: 0, values: { name: "PRIVATE_ARTIFACT_VALUE" } }] });
    execute({ kind: "view.save", expectedRevision: 0, view: { id: "view", title: "Items", layout: "table", query: { tableId: "items" } } });
    execute({ kind: "artifact.create", artifactId: "snapshot", title: "Snapshot", viewId: "view", viewRevision: 1, dataMode: "snapshot" });
    const binding: DatabaseBinding = { owner: "local", thread: "user-local", store, authorize: async () => true, custody: { put: async () => "unused", get: async () => undefined } };
    const refs = [{ artifactId: "snapshot" }], signal = new AbortController().signal;
    const attached = await replyArtifacts(binding, refs, signal);
    expect(attached[0]?.state).toBe("available"); expect(JSON.stringify(attached)).not.toContain("PRIVATE_ARTIFACT_VALUE");
    allowed = false;
    expect((await replyArtifacts(binding, refs, signal))[0]?.state).toBe("unavailable");
    expect((await reauthorizeReplyResult(binding, { text: "Saved table", artifacts: attached }, signal) as any).artifacts[0].state).toBe("unavailable");
    expect(() => artifactReferences([{ artifactId: "snapshot", rows: ["injected"] }])).toThrow();
    expect(() => artifactReferences([...refs, ...refs])).toThrow();
    expect(() => artifactReferences([{ artifactId: "../other-account" }])).toThrow();
  } finally { storage.close(); }
});

test("Telegram carries trusted artifact selectors and unavailable attachments have a text fallback", async () => {
  const sent: any[] = [];
  const telegram = createTelegram({ token: "synthetic-token", secret: "fixture-secret", allowedUsers: new Set(["123"]), fetch: async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true, result: { message_id: 123 } });
  } });
  const signal = new AbortController().signal;
  await telegram.send("123", "Your table", signal, { artifacts: [{ artifactId: "projects", kind: "database", state: "available" }] });
  expect(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${AIKO_MINI_APP_URL}?artifact=projects`);
  expect(trustedMiniAppUrl(artifactMiniAppUrl("projects"), AIKO_MINI_APP_URL)).toBe(true);
  expect(trustedMiniAppUrl(`${AIKO_MINI_APP_URL}?artifact=projects&token=secret`, AIKO_MINI_APP_URL)).toBe(false);
  await telegram.send("123", "Your table", signal, { artifacts: [{ artifactId: "projects", kind: "database", state: "unavailable" }] });
  expect(sent.at(-1).text).toContain("no longer available");
  expect(sent.at(-1).reply_markup).toBeUndefined();
});
