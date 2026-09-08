import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { fixture, registryProgram } from "./registry-host.test.ts";
import type { ChannelSourceGrant } from "../src/channel-ingress.ts";
const sign = (body: string) =>
  createHmac("sha256", "fixture-private-key").update(body).digest("hex");
async function providerFixture() {
  let grant: ChannelSourceGrant | undefined,
    unknown = false;
  const sends: any[] = [];
  const f = await fixture(true, {
    text: true,
    overrides: {
      channels: () => ({
        authorize: async (owner, authority) =>
          owner === "123" && ["bind-grant", "send-grant"].includes(authority),
        artifactAllowed: async () => true,
        authenticate: async () => undefined,
        validateReceipt: async () => true,
        execute: async (_binding, op, input, key) => {
          if (op === "decode")
            return {
              kind: "external",
              schemaVersion: "provider.v1",
              text: JSON.parse((input as any).body).text,
            };
          if (op === "send") {
            sends.push({ input, key });
            if (unknown) throw Error("controlled lost ack");
            return {
              status: "delivered",
              providerId: "fixture-sent",
              evidence: "fixture-receipt",
            };
          }
          throw Error("No subscriptions");
        },
      }),
      channelBridge: (owner) => ({
        authorize: async (bound, _op, spec) =>
          bound === owner &&
          spec.authorityRef === "bridge-grant" &&
          spec.sendAuthorityRef === "send-grant",
      }),
      channelIngress: async (route, token) =>
        route === "fixture-route" && token === "receive-only-secret"
          ? grant
          : undefined,
    },
  });
  const contract = await f.seed();
  await f.run(
    registryProgram(contract).replace(/ await channels.emit\([^\n]+\n/, ""),
  );
  const rows = await f.events(),
    ports = rows
      .filter((e) => e.type === "AikoChannelWiringBound")
      .map((e) => e.port as any),
    wire = rows.find((e) => e.type === "AikoChannelWiringConnected")
      ?.wire as any;
  expect(wire).toBeDefined();
  const inlet = ports.find((e) => e.name === "fixture-input") as any,
    outlet = ports.find((e) => e.name === "fixture-output") as any;
  const result = (await (
    await f.request("/api/channels/bind", {
      name: "fixture-provider",
      generation: 1,
      artifact: {
        digest: "fixture-adapter",
        contractDigest: "fixture-contract",
        directions: ["inbox", "outbox"],
        operations: ["decode", "send"],
      },
      account: "fixture-account",
      source: "fixture-source",
      destination: "configured-destination",
      credentialRefs: [],
      authorization: "bind-grant",
      backlog: 8,
      maxBytes: 4096,
      maxHops: 8,
      retentionMs: 10000,
      queuedWork: "cancel",
    })
  ).json()) as any;
  await f.drive();
  const external = (await f.events()).find(
    (e) => e.type === "AikoChannelBindingIntent",
  ) as any;
  const ref = (p: any) => ({ channel: p.channel, generation: p.generation });
  const response = await f.request("/api/provider-bridge", {
    operation: "bind",
    spec: {
      operationId: "bridge",
      external: { channel: result.id, generation: 1 },
      input: ref(inlet),
      output: ref(outlet),
      wiring: { id: wire.id, generation: wire.generation },
      decodeSchema: "provider.v1",
      authorityRef: "bridge-grant",
      sendAuthorityRef: "send-grant",
      expiresAt: Date.now() + 60000,
    },
  });
  expect(await response.clone().text()).not.toContain("rejected");
  expect(response.status).toBe(200);
  const bridge = ((await response.json()) as any).result;
  grant = {
    owner: "123",
    channel: result.id,
    generation: 1,
    bridge: bridge.id,
    capabilityRef: "receive-fixture",
    scope: "receive",
    expiresAt: Date.now() + 60000,
    verify: async (binding, request, body) =>
      request.headers.get("x-signature") === sign(body)
        ? {
            principal: binding.source,
            occurrence: JSON.parse(body).id,
            conversation: "fixture-conversation",
            partition: "fixture-partition",
            ancestry: [],
            evidence: "fixture-signature",
          }
        : undefined,
  } as ChannelSourceGrant;
  return {
    ...f,
    sends,
    unknown: () => {
      unknown = true;
    },
    setGrant: (patch: Partial<ChannelSourceGrant>) => {
      grant = { ...grant!, ...patch };
    },
    bridge,
    receive: (id = "source-one", headers: Record<string, string> = {}) => {
      const body = JSON.stringify({ id, text: "private-provider-text" });
      return f.raw(
        new Request("http://127.0.0.1:4242/v1/channel-ingress/fixture-route", {
          method: "POST",
          headers: {
            "x-channel-receive-capability": "receive-only-secret",
            "x-signature": sign(body),
            ...headers,
          },
          body,
        }),
      );
    },
  };
}
test("actual public route reaches typed handler and provider outbox without inference or duplicate send", async () => {
  const f = await providerFixture(),
    models = f.models();
  expect((await f.receive()).status).toBe(202);
  await f.drive();
  expect(f.sends).toHaveLength(1);
  expect(JSON.stringify(f.sends)).toContain(
    "private-provider-textprivate-provider-text",
  );
  expect(f.models()).toBe(models);
  expect(JSON.stringify(await f.events())).not.toContain(
    "private-provider-text",
  );
  expect((await f.receive()).status).toBe(202);
  await f.restart();
  expect(f.sends).toHaveLength(1);
  expect(f.models()).toBe(models);
});
test("receive capability, signature, owner, expiry and revoke fences reject input", async () => {
  const f = await providerFixture();
  expect((await f.receive("bad", { "x-signature": "invalid" })).status).toBe(
    403,
  );
  expect(
    (
      await f.receive("bearer", {
        "x-channel-receive-capability": "",
        authorization: "Bearer broad-owner-key",
      })
    ).status,
  ).toBe(401);
  f.setGrant({ owner: "456" });
  expect((await f.receive()).status).not.toBe(202);
  f.setGrant({ owner: "123", expiresAt: 1 });
  expect((await f.receive()).status).toBe(403);
  f.setGrant({ expiresAt: Date.now() + 60000 });
  expect(
    (
      await f.request("/api/provider-bridge", {
        operation: "revoke",
        id: f.bridge.id,
      })
    ).status,
  ).toBe(200);
  expect((await f.receive()).status).toBe(409);
  expect(f.sends).toHaveLength(0);
});
test("unknown provider send is not retried after duplicate ingress and reopening", async () => {
  const f = await providerFixture();
  f.unknown();
  expect((await f.receive()).status).toBe(202);
  await f.drive();
  expect(f.sends).toHaveLength(1);
  await f.restart();
  await f.receive();
  await f.drive();
  expect(f.sends).toHaveLength(1);
});
test("unconfigured bridge and ingress readiness stays false", async () => {
  const f = await fixture(false);
  expect(
    await (await f.request("/api/provider-bridge/readiness")).json(),
  ).toEqual({ providerBridge: false, providerIngress: false });
  expect(
    (await f.request("/api/provider-bridge", { operation: "bind", spec: {} }))
      .status,
  ).toBe(503);
});

test("custody failure never acknowledges or dispatches public input", async () => {
  const f = await providerFixture(),
    models = f.models(),
    blobs = f.binding().blobs,
    put = blobs.putPrivate;
  blobs.putPrivate = async () => {
    throw Error("controlled storage unavailable");
  };
  expect((await f.receive()).status).toBe(503);
  blobs.putPrivate = put;
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelReceived"),
  ).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
  expect(f.models()).toBe(models);
});

test("native codeMode can bind and revoke the same explicit bridge without invoking provider sends", async () => {
  const f = await providerFixture();
  const {id,owner,artifact,...spec}=f.bridge;
  await f.run(
    `const bound=await tools.call({name:"provider_bridge_bind",arguments:${JSON.stringify(spec)}}); if(!bound.bridge?.id)throw Error("Missing retained bridge ID"); return await tools.call({name:"provider_bridge_revoke",arguments:{id:bound.bridge.id}});`,
    "revoke_provider_bridge",
  );
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelBridgeRevoked"),
  ).toHaveLength(1);
  expect((await f.receive()).status).toBe(409);
  expect(f.sends).toHaveLength(0);
});
