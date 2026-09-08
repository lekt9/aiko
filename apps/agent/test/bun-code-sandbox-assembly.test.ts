import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  codeMode,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import { createBunHost } from "tardie/bun/host";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import { CodeHarness, codeHarnessEventKey } from "../src/code-harness.ts";
import { privateCodeSandbox } from "../src/code-agents.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";

for (const scoped of [false, true])
  test(`bare Bun native code requires effect-scoped private Sandbox: ${scoped}`, async () => {
    const directory = await mkdtemp("/tmp/bun-code-assembly-");
    const harness = new CodeHarness(
      "123",
      "user-123",
      runCodeSegment,
      (s) => s,
    );
    let calls = 0;
    const native = {
      spec: {
        name: "fixture_read",
        description: "Read controlled host context",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
      run: () =>
        Effect.gen(function* () {
          const self = yield* Self,
            log = yield* EventLog;
          expect(self).toEqual({
            actor: "aiko",
            instance: "assembly",
            thread: "user-123",
          });
          expect(
            (yield* log.read).some(
              (e) => e.type === "MessageReceived" && e.id === "assembly",
            ),
          ).toBe(true);
          calls++;
          return { status: "read" };
        }),
    };
    const code = codeMode([harness.package([native])]);
    const definition = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [
        infer([
          scoped ? privateCodeSandbox(code, harness) : code,
          outputValidateOnce,
        ]),
      ],
    });
    let attempts = 0;
    const model = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "assembly" } }),
      react: () =>
        Effect.succeed(
          attempts++ === 0
            ? {
                kind: "call" as const,
                name: "execute",
                callId: "code-assembly",
                arguments: {
                  code: 'return await tools.call({name:"fixture_read",arguments:{value:"controlled"}});',
                },
              }
            : { kind: "complete" as const, output: "finished" },
        ),
    });
    const host = await createBunHost({
      database: join(directory, "host.sqlite"),
      actorName: "aiko",
      actorInstance: "assembly",
      actorFor: () => definition,
      keyOf: codeHarnessEventKey,
      workspaceSql: false,
      layersFor: () =>
        Layer.merge(harness.inference(model), harness.sandboxLayer()),
    });
    try {
      await host.commitRoot(host.self("user-123"), {
        type: "MessageReceived",
        id: "assembly",
        text: "Read controlled fixture",
        at: Date.now(),
      });
      await host.drive();
      const rows = await host.read("user-123");
      expect(calls).toBe(scoped ? 1 : 0);
      expect(rows.some((e) => e.type === "AikoCodeToolStarted")).toBe(scoped);
      const returned = rows.find((e) => e.type === "PackageReturned");
      if (!scoped)
        expect(returned?.result).toEqual({
          error: "Private code input expired or invalid",
        });
      else {
        expect(
          JSON.stringify(rows.filter((e) => e.type === "PackageCalled")),
        ).not.toContain('"value":"controlled"');
        expect(JSON.stringify(returned?.result)).not.toContain(
          "Private code input expired",
        );
      }
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
