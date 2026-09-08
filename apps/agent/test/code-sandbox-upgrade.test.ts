import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { definePackage } from "tardie/code/package/definition";
import { Sandbox } from "tardie/code/sandbox/service";
import { codegraffSandboxService } from "../src/code-sandbox.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

test("native cold restore of pre-upgrade calls pins v1 and preserves old branch effects", async () => {
  const databases: Database[] = [], hosts: Awaited<ReturnType<typeof createCloudflareAccountHost>>[] = [];
  const seen: string[] = [];
  const fast = Promise.withResolvers<void>();
  const pkg = definePackage({ name: "fixture", description: "Upgrade fixture", methods: {
    read: (args: any) => Effect.promise(async () => {
      seen.push(`read:${args.id}`);
      if (args.id === "slow") { await fast.promise; await new Promise(resolve => setTimeout(resolve, 5)); }
      else fast.resolve();
      return args.id;
    }),
    follow: (args: any) => Effect.sync(() => { seen.push(`follow:${args.id}`); return args.id; }),
  } });
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([pkg]), outputValidateOnce])] });
  const sandbox = codegraffSandboxService(runCodeSegment);
  const make = async (legacy: boolean) => {
    const db = new Database(":memory:"); databases.push(db);
    const storage: AccountStorage = {
      sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as never[]); return { toArray: () => rows as never }; } },
      transactionSync: fn => db.transaction(fn)(), sync: async () => {},
      getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    };
    const service = legacy ? { ...sandbox, replayVersion: undefined,
      run: (code: string, bindings: Parameters<typeof sandbox.run>[1], ambient?: Parameters<typeof sandbox.run>[2]) => sandbox.run(code, bindings, { at: 0, seed: "upgrade", ...ambient, replayVersion: "aiko-code/1" }),
    } : sandbox;
    const host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "upgrade", ownsThread: thread => thread === "user-upgrade", actorFor: () => definition,
      layersFor: () => Layer.merge(Layer.succeed(Sandbox)(service), Layer.succeed(Infer, {
        resolve: () => ({ model: { provider: "fixture", model_id: "upgrade" } }),
        react: request => Effect.succeed(request.trajectory.some(event => event.type === "ToolReturned")
          ? { kind: "complete" as const, output: "Restored" }
          : { kind: "call" as const, callId: "upgrade", name: "execute", arguments: { code: `return await Promise.all(["slow","fast"].map(id=>fixture.read({id}).then(id=>fixture.follow({id}))));` } }),
      })),
    });
    hosts.push(host); return host;
  };
  try {
    const old = await make(true);
    await old.commitRoot(old.self("user-upgrade"), { type: "MessageReceived", id: "upgrade-turn", text: "Continue", at: 1 });
    await old.drive();
    const events = await old.read("user-upgrade");
    expect(events.some(event => event.type === "CodeExecutionStarted")).toBe(false);
    expect(seen).toEqual(["read:slow", "read:fast", "follow:slow", "follow:fast"]);
    expect(events.filter(event => event.type === "PackageReturned").slice(0, 2).map(event => event.callId)).toEqual(["upgrade.1", "upgrade.0"]);
    const restored = await make(false);
    const last = events.findLastIndex(event => event.type === "PackageReturned");
    for (const event of events.slice(0, last + 1)) await restored.commitRoot(restored.self("user-upgrade"), event);
    await restored.drive();
    const replay = await restored.read("user-upgrade");
    expect(seen).toHaveLength(4);
    expect(replay.find(event => event.type === "CodeExecutionStarted")?.replayVersion).toBe("aiko-code/1");
    expect(replay.find(event => event.type === "CodeSettled")?.result).toEqual(["slow", "fast"]);
    expect(replay.find(event => event.type === "TurnCompleted")?.output).toBe("Restored");
  } finally {
    for (const host of hosts) await host.close();
    for (const db of databases) db.close();
  }
});
