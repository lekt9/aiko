import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createBunHost } from "tardie/bun/host";
import { createToolRouterActor, routerEventKey, type ToolRouterBinding } from "../src/tool-router.ts";
import { routerCaller } from "../src/connector-router-host.ts";

for (const stage of ["after-completion", "before-completion", "unreadable-receipt"] as const) {
  test(`HTTP routing reconciles native custody when wake fails ${stage}`, async () => {
    const directory = await mkdtemp("/tmp/router-receipt-");
    let discoveries = 0, unavailable = false;
    const binding: ToolRouterBinding = { owner: "123", engine: {
      listCatalog: async () => { discoveries++; return []; },
      connections: async () => [],
      describe: async () => { throw Error("unused"); },
      search: async () => ({ status: "unavailable", connectors: [], fallbackAllowed: false, message: "unavailable" }),
    } };
    const definition = createToolRouterActor(binding);
    const host = await createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "test",
      keyOf: routerEventKey, actorFor: () => definition });
    const wakeError = Error("Alarm maintenance failed after draining native work");
    const call = routerCaller(binding, () => ({ ...host,
      read: async thread => { if (unavailable) throw Error("Storage receipt unavailable"); return host.read(thread); },
      wake: async thread => {
        if (stage !== "before-completion") await host.wake(thread);
        unavailable = stage === "unreadable-receipt";
        throw wakeError;
      },
    }));
    const context = { callId: "same-http-operation", turn: "http", signal: new AbortController().signal };
    const input = { tasks: [{ id: "mail", query: "Find mail" }] };
    try {
      if (stage === "after-completion") {
        const result = await call("route", input, context);
        expect(result).toMatchObject({ state: "catalog_unavailable", tasks: [] });
        expect(discoveries).toBe(1);
        expect(await call("route", input, context)).toEqual(result);
        expect(discoveries).toBe(1);
        expect((await host.read("router-123")).filter(event => event.type === "AikoRouterDecisionRecorded")).toHaveLength(1);
        await expect(call("route", { tasks: [{ id: "different", query: "Changed" }] }, context)).rejects.toThrow("Router invocation conflict");
      } else {
        await expect(call("route", input, context)).rejects.toThrow(stage === "before-completion" ? wakeError.message : "Storage receipt unavailable");
        expect(discoveries).toBe(stage === "before-completion" ? 0 : 1);
      }
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
