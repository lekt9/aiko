import { fixture as workerFixture } from "./registry-worker-host.test.ts";
import { test, expect } from "bun:test";
import { fixture } from "./registry-host.test.ts";
import { builtinHarnessDefinitions } from "../src/harness-builtins.ts";
import {
  harnessDigest,
  type HarnessArtifact,
  type HarnessContract,
  type HarnessVerifier,
} from "../src/harness-library.ts";
import type { RegistryManagementPolicy } from "../src/registry-management.ts";

for (const platform of ["bun", "worker"] as const)
  for (const scenario of [
    "success",
    "revoked",
    "cancelled",
    "wrong-final",
    "adopted",
    "adoption-denied",
  ] as const)
    test(`default actual ${platform} host pinned management has native verification and recovery: ${scenario}`, async () => {
      const child = builtinHarnessDefinitions().find(
          (d) => d.artifact.name === "channel.text.echo",
        )!,
        pin = {
          harness: harnessDigest(child.artifact),
          contract: harnessDigest(child.contract),
        };
      const verifier: HarnessVerifier = {
        digest: harnessDigest("trusted-parent-check-v1"),
        evaluatorDigest: harnessDigest("trusted-parent-preflight-v1"),
        cases: [
          {
            id: "dev",
            split: "development",
            input: {
              value: { text: "dev", preflight: true },
              schema: "text.message.v1",
              correlation: "dev",
            },
          },
          {
            id: "held",
            split: "held-out",
            input: {
              value: { text: "held", preflight: true },
              schema: "text.message.v1",
              correlation: "held",
            },
          },
        ],
        verify: async ({ input, output }) => ({
          passed:
            (output as any)?.text === "parent:" + (input as any).value.text,
          quality:
            (output as any)?.text === "parent:" + (input as any).value.text
              ? 1
              : 0,
          evidence: ["independent-exact-parent-output"],
        }),
      };
      const contract: HarnessContract = {
        ...child.contract,
        outcome: "Produce parent: followed by the checked child echo",
        inputSchema: { type: "object" },
        verifierDigest: verifier.digest,
        evaluatorDigest: verifier.evaluatorDigest,
        timeoutMs: 60000,
        applicability: {
          hook: {
            accepts: "text.message.v1",
            emits: "text.message.v1",
            inputSchema: { type: "object" },
            effects: ["channel.manage"],
          },
        },
      };
      const artifact: HarnessArtifact = {
        version: 1,
        name: "trusted.parent",
        description: "Trusted staged internal continuation",
        runtime: "javascript",
        entrypoint: "main.js",
        files: {
          "main.js": `if(input.value.preflight)return {text:'parent:'+input.value.text};
 if(typeof tools!=='undefined'||typeof fetch!=='undefined')throw Error('Ambient provider authority');
 const a=await channels.bind({schema:'text.message.v1',directions:['inbox','outbox']});
 const b=await channels.bind({schema:'text.message.v1',directions:['inbox','outbox']});
 await channels.connect({generation:1,input:{channel:a.channel,generation:1},accepts:'text.message.v1',handler:${JSON.stringify(pin)},output:{channel:b.channel,generation:1,mode:'port'},start:'after-registration'});
 const result=await channels.request({send:{port:{channel:a.channel,generation:1},schema:'text.message.v1',value:{text:input.value.text},correlation:input.correlation},reply:{port:{channel:b.channel,generation:1},handler:${JSON.stringify(pin)},schema:'text.message.v1',correlation:input.correlation,deadline:input.value.deadline}});
 return {text:${scenario === "wrong-final" ? JSON.stringify("forged:") : JSON.stringify("parent:")}+result.value.text};`,
        },
        dependencies: [],
        sources: [],
        contractDigest: harnessDigest(contract),
      };
      let policy: RegistryManagementPolicy | undefined = {
        revision: "trusted-registration-v1",
        ...(scenario === "adopted"
          ? { standingHooks: { maxLifetimeMs: 60000, handlers: [pin] } }
          : {}),
        parents: [
          { definition: { artifact, contract, verifier }, children: [pin] },
          { definition: child, children: [pin] },
        ],
        maxCalls: 8,
        maxBytes: 4096,
        wallMs: 60000,
      };
      const jobs: any[] = [];
      let f: Awaited<ReturnType<typeof fixture>>;
      const beforeJob = async (j: any) => {
        jobs.push(j);
        if (
          (j.input as any)?.value?.value?.text === "PRIVATE_MANAGEMENT_PAYLOAD"
        ) {
          if (scenario === "revoked") policy = undefined;
          if (scenario === "cancelled") {
            const row = (await f.events()).find(
              (e) => e.type === "AikoChannelWiringHandlerDispatched",
            );
            await f.append([
              {
                type: "TurnCancelled",
                turn: String(row!.id),
                epoch: 0,
                at: Date.now(),
              },
            ]);
          }
        }
      };
      if (platform === "bun")
        f = await fixture(true, {
          defaults: true,
          overrides: { registryManagement: () => policy },
          beforeJob,
        });
      else {
        const w = await workerFixture({ program: "return 'ready'" });
        w.env.AIKO_REGISTRY_MANAGEMENT = () => policy;
        w.onJob(beforeJob);
        let modelEdge: () => Promise<Response> = async () => new Response();
        w.env.AIKO_MODEL_FETCH = () => modelEdge();
        const readiness = await (
          await w.request("/api/harness/readiness")
        ).json();
        f = {
          readiness,
          events: async () => w.events(),
          drive: w.drive,
          restart: w.restart,
          append: async (events: any[]) => {
            await (await w.nativeHost()).seed("user-123", events);
          },
          run: async (program: string, id = "registry_fixture_turn") => {
            let sent = false;
            modelEdge = async () => {
              const call = !sent;
              sent = true;
              return new Response(
                `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${id}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code: program }) } }] } : { role: "assistant", content: "Controlled task complete." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0001 } })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              );
            };
            expect(
              (
                await w.request("/api/messages", {
                  id,
                  text: "Execute controlled code.",
                })
              ).status,
            ).toBe(202);
            for (let i = 0; i < 8; i++) await w.drive();
          },
        } as unknown as Awaited<ReturnType<typeof fixture>>;
      }
      expect(f.readiness.channelManagement).toBe(true);
      if (platform === "worker")
        await f.run(
          "return 'mount trusted seed registrations';",
          "management-bootstrap",
        );
      await f.run(`const r=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'acquire-echo'}});if(r.status!=='ready')throw Error('child acquisition failed');const childChecked=await tools.call({name:'harness_evaluate',arguments:{digest:'${pin.harness}',evaluationId:'exact-policy-child'}});if(!childChecked.eligible)throw Error('Exact pinned child unavailable');const p=await tools.call({name:'harness_evaluate',arguments:{digest:'${harnessDigest(artifact)}',evaluationId:'trusted-parent-preflight'}});if(!p.eligible)throw Error('parent preflight failed '+JSON.stringify(p));
 const a=await channels.bind({name:'parent-in',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef:'registry-internal:123',operationId:'parent-in'});
 const b=await channels.bind({name:'parent-out',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef:'registry-internal:123',operationId:'parent-out'});
 await channels.connect({name:'parent-wire',generation:1,input:{channel:a.channel,generation:1},accepts:'text.message.v1',handler:${JSON.stringify({ harness: harnessDigest(artifact), contract: harnessDigest(contract) })},output:{channel:b.channel,generation:1,mode:'port'},start:'after-registration',authorityRef:'registry-internal:123',operationId:'parent-wire'});
 return 'registered';`);
      // Registration is durable before a fresh host invokes the parent; no custom actor/factory.
      await f.restart();
      await f.run(
        `const list=await tools.call({name:'harness_list',arguments:{}});return 'current host';`,
        "management-current",
      );
      // Native owner API only emits into the already registered typed inlet.
      const rows = await f.events(),
        port = rows.find(
          (e) =>
            e.type === "AikoChannelWiringBound" &&
            (e.port as any).name === "parent-in",
        )?.port as any;
      expect(port).toBeDefined();
      await f.run(
        `await channels.emit({port:{channel:'${port.channel}',generation:1},schema:'text.message.v1',value:{text:String.fromCharCode(${Array.from(
          "PRIVATE_MANAGEMENT_PAYLOAD",
        )
          .map((c) => c.charCodeAt(0))
          .join(
            ",",
          )}),deadline:Date.now()+20000},occurrence:'parent-one',correlation:'parent-one',authorityRef:'registry-internal:123'});return 'admitted';`,
        "managed-request",
      );
      await f.drive();
      if (scenario === "adopted" || scenario === "adoption-denied") {
        await f.restart();
        await f.run(
          `const hooks=await channels.hooks({authorityRef:'registry-internal:123'});const h=hooks[0];if(!h||h.reason!=='parent_completed')throw Error('Missing recovered task hook');
        let adopted=false;try{await channels.adopt({execution:h.execution,authorityRef:'registry-internal:123',operationId:'standing-decision',expiresAt:Date.now()+40000});adopted=true;}catch{}
        if(adopted!==${scenario === "adopted"})throw Error('Incorrect standing policy');
        return 'decision retained';`,
          "adopt-standing",
        );
        await f.drive();
      }
      const after = await f.events();
      if (["success", "adopted", "adoption-denied"].includes(scenario))
        expect(
          after.find((e) => e.type === "AikoChannelWiringHandlerChecked")
            ?.status,
        ).toBe("satisfied");
      else if (scenario === "wrong-final")
        expect(
          after.find((e) => e.type === "AikoChannelWiringHandlerChecked")
            ?.status,
        ).toBe("violated");
      else {
        expect(
          after.some((e) => e.type === "AikoChannelWiringHandlerDispatched"),
        ).toBe(true);
        expect(
          after.some(
            (e) =>
              e.type === "AikoChannelWiringHandlerChecked" &&
              e.status === "satisfied",
          ),
        ).toBe(false);
      }
      const cleanup = after.filter(
        (e) => e.type === "AikoChannelWiringHookCleaned",
      );
      if (scenario !== "revoked" && scenario !== "adopted")
        expect(cleanup).toHaveLength(1);
      if (scenario === "adoption-denied")
        expect(
          after.filter((e) => e.type === "AikoChannelWiringHookAdopted"),
        ).toHaveLength(0);
      if (scenario === "adopted") {
        expect(cleanup).toHaveLength(1);
        expect(
          after.filter((e) => e.type === "AikoChannelWiringHookAdopted"),
        ).toHaveLength(1);
      }
      for (const row of cleanup) {
        expect(row.execution).toBe(
          after.find((e) => e.type === "AikoChannelWiringHandlerDispatched")
            ?.id,
        );
        expect(Array.isArray(row.pending)).toBe(true);
      }
      const childPort = after.find(
        (e) =>
          e.type === "AikoChannelWiringBound" &&
          String(e.operationId).startsWith("child:"),
      );
      if (childPort && cleanup.length && scenario !== "adopted") {
        await f.run(
          `let denied=false;try{await channels.emit({port:${JSON.stringify({ channel: (childPort.port as any).channel, generation: 1 })},schema:'text.message.v1',value:{text:'late'},occurrence:'after-parent',correlation:'late',authorityRef:'registry-internal:123'});}catch{denied=true;}if(!denied)throw Error('Task admission survived cleanup');return 'closed';`,
          "late-child-input",
        );
        expect(
          (await f.events()).filter(
            (e) => e.type === "AikoChannelWiringAccepted",
          ),
        ).toHaveLength(
          after.filter((e) => e.type === "AikoChannelWiringAccepted").length,
        );
      }
      const n = jobs.length;
      await f.restart();
      await f.drive();
      expect(jobs.length).toBe(n);
      expect(
        (await f.events()).filter(
          (e) => e.type === "AikoChannelWiringHookCleaned",
        ),
      ).toHaveLength(cleanup.length);
      if (scenario === "adopted") {
        const beforeReuse = jobs.length;
        await f.run(
          `const [h]=await channels.hooks({authorityRef:'registry-internal:123'});if(h.lifetime!=='standing'||h.reason!=='active')throw Error('Standing hook lost');await channels.emit({port:{channel:h.ports[0].channel,generation:1},schema:'text.message.v1',value:{text:'later-authorized-input'},occurrence:'later-standing',correlation:'later',authorityRef:'registry-internal:123'});return 'reuse';`,
          "standing-reuse",
        );
        await f.drive();
        expect(jobs.length).toBe(beforeReuse + 1);
        const acceptedBeforeRevocation = (await f.events()).filter(
          (e) => e.type === "AikoChannelWiringAccepted",
        ).length;
        policy = undefined;
        await f.run(
          `const [h]=await channels.hooks({authorityRef:'registry-internal:123'});let denied=false;try{await channels.emit({port:{channel:h.ports[0].channel,generation:1},schema:'text.message.v1',value:{text:'revoked'},occurrence:'revoked',correlation:'revoked',authorityRef:'registry-internal:123'});}catch{denied=true;}await channels.retireHook({execution:h.execution,authorityRef:'registry-internal:123',operationId:'owner-retire'});return 'revoked';`,
          "standing-revoked",
        );
        await f.drive();
        expect(jobs.length).toBe(beforeReuse + 1);
        expect(
          (await f.events()).filter(
            (e) => e.type === "AikoChannelWiringAccepted",
          ),
        ).toHaveLength(acceptedBeforeRevocation);
        expect(
          (await f.events()).filter(
            (e) => e.type === "AikoChannelWiringHookCleaned",
          ),
        ).toHaveLength(2);
      }
      expect(
        jobs.every(
          (j) => !j.authority.origins.length && !j.authority.methods.length,
        ),
      ).toBe(true);
      expect(JSON.stringify(await f.events())).not.toContain(
        "PRIVATE_MANAGEMENT_PAYLOAD",
      );
    }, 120000);
