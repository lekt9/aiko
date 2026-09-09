import { expect, test } from "bun:test";
import { fixture, productionWorker } from "./registry-worker-host.test.ts";
import { connectorStorePrefix } from "../src/connectors.ts";

test("authenticated Worker connection reads stay responsive while account work is held", async () => {
  const f = await fixture();
  const module = await productionWorker();
  await f.request("/api/connectors/connections");
  const id = crypto.randomUUID(), other = crypto.randomUUID();
  const record = {id,owner:"123",provider:"browser",connectorId:"browser:service.net",status:"pending",createdAt:Date.now(),expiresAt:Date.now()+60000};
  await f.storage().put(`${connectorStorePrefix("123")}connection:${id}`, record);
  // Even a corrupt/foreign row under the owner's prefix must be omitted.
  await f.storage().put(`${connectorStorePrefix("123")}connection:${other}`, {...record,id:other,owner:"456"});
  const account = f.env.AIKO_ACCOUNTS.getByName(module.accountObjectName("123"));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = account.serialize(async () => { entered(); await gate; });
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const responses = await Promise.race([
      Promise.all([f.request("/api/connectors/connections"),f.request("/v1/connectors/connections")]),
      new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(Error("Account work blocked connection discovery")), 1000); }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.json() as any).connections).toMatchObject([{id,status:"pending"}]);
    }
    expect((await f.request("/api/connectors/connections",undefined,"invalid-token")).status).toBe(401);
  } finally { clearTimeout(timer); release(); await held; }
});
