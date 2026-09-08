import { expect, test } from "bun:test";
import { webhookActionFixture } from "./browser-watch-webhook-actions.test.ts";
import type { ChannelDispatchPermitIdentity, ChannelDispatchPermitResult } from "../src/channel-runtime.ts";
import { channelDigest } from "../src/channel-bindings.ts";
import { sandboxDigest } from "../src/sandbox-job.ts";
import { browserWatchWebhookPermitAppendAllowed } from "../src/browser-watch-webhook-actions.ts";

type Fixture = Awaited<ReturnType<typeof webhookActionFixture>>;
async function prepare(f: Fixture, options: { before?: () => void; policyCurrent?: () => boolean; expiresAt?: number; loseAck?: boolean } = {}) {
  let result!: ChannelDispatchPermitResult, identity!: ChannelDispatchPermitIdentity;
  let retry!: (change?: Partial<ChannelDispatchPermitIdentity>) => Promise<ChannelDispatchPermitResult>;
  f.permitHook(async (channel, operation, input, key, _identity, signal) => {
    identity = { owner: channel.owner, operationId: key, jobDigest: await sandboxDigest({ fixture: "exact-private-job" }),
      requestDigest: await sandboxDigest({ fixture: "exact-prepared-request" }), nonce: crypto.randomUUID(),
      expiresAt: options.expiresAt ?? f.now + 10_000, policyDigest: channelDigest("fixed-destination-policy") };
    retry = change => f.adapter.permit(channel, operation, input, key, { ...identity, ...change }, AbortSignal.timeout(5000), options.policyCurrent ?? (() => true));
    options.before?.();
    if (options.loseAck) f.losePermitAck();
    result = await f.adapter.permit(channel, operation, input, key, identity, signal, options.policyCurrent ?? (() => true));
    if (result.status !== "permitted") throw Error(`permit_${result.status}`);
  });
  expect((await f.adapter.execute(f.intent, AbortSignal.timeout(5000))).status).toBe("pending");
  await f.drive();
  return { result, identity, retry };
}

test("native SQLite permit records exact fixed pins once; duplicate is read-only and conflicting nonce never grants resend", async () => {
  const f = await webhookActionFixture();
  const first = await prepare(f);
  expect(first.result).toEqual({ status: "permitted" }); expect(f.counts().sends).toBe(1);
  const rows = await f.read(), permits = rows.filter(e => e.type === "AikoBrowserWatchWebhookPermitted");
  expect(permits).toHaveLength(1);
  expect(permits[0]).toMatchObject({ ...first.identity, watchOperationId: f.intent.operationId, channel: f.channelId, operation: "send" });
  expect(JSON.stringify(permits)).not.toContain("private-body");
  expect(JSON.stringify(permits)).not.toContain("https:");
  expect(JSON.stringify(permits)).not.toContain("headers");
  expect(await first.retry()).toEqual({ status: "permitted" });
  for (const change of [{ nonce: crypto.randomUUID() }, { jobDigest: await sandboxDigest("different-job") },
    { requestDigest: await sandboxDigest("different-request") }, { policyDigest: channelDigest("different-policy") }])
    expect(await first.retry(change)).toEqual({ status: "denied" });
  await f.restart();
  expect(await first.retry()).toEqual({ status: "permitted" }); expect(f.counts().sends).toBe(1);
  expect((await f.read()).filter(e => e.type === permits[0]!.type)).toHaveLength(1);
  expect(f.adapter.admissionAllowed([{ ...permits[0]!, id: "forged", nonce: crypto.randomUUID() }], () => rows)).toBe(false);
});

test("revocation inside the actual native commit transaction stops permission after async preparation", async () => {
  const f = await webhookActionFixture();
  const result = await prepare(f, { before: () => f.beforePermitCommit(() => f.revoke()) });
  expect(result.result.status).not.toBe("permitted");
  expect(f.counts().sends).toBe(0);
  expect((await f.read()).some(e => e.type === "AikoBrowserWatchWebhookPermitted")).toBe(false);
  await f.restart(); expect(f.counts().sends).toBe(0);
});

test("destination policy revocation is read synchronously at commit, separately from watch authority", async () => {
  const f = await webhookActionFixture(); let policyCurrent = true;
  const result = await prepare(f, { before: () => f.beforePermitCommit(() => { policyCurrent = false; }), policyCurrent: () => policyCurrent });
  expect(result.result.status).not.toBe("permitted"); expect(f.counts().sends).toBe(0);
  expect((await f.read()).some(e => e.type === "AikoBrowserWatchWebhookPermitted")).toBe(false);
});

test("lost native commit acknowledgement stays unknown with one retained permission and no fresh nonce", async () => {
  const f = await webhookActionFixture(); const first = await prepare(f, { loseAck: true });
  expect(first.result).toEqual({ status: "unknown" }); expect(f.counts().sends).toBe(0);
  expect((await f.read()).filter(e => e.type === "AikoBrowserWatchWebhookPermitted")).toHaveLength(1);
  await f.restart();
  expect(await first.retry({ nonce: crypto.randomUUID() })).toEqual({ status: "denied" });
  expect(await first.retry()).toEqual({ status: "permitted" }); expect(f.counts().sends).toBe(0);
});

for (const unavailable of ["expired", "paused", "capability"] as const) test(`remote permission fails closed when ${unavailable}`, async () => {
  const f = await webhookActionFixture();
  const result = await prepare(f, { ...(unavailable === "expired" ? { expiresAt: f.now - 1 } : {}),
    before: () => { if (unavailable === "paused") f.pause(); if (unavailable === "capability") f.removeCommitCapability(); } });
  expect(result.result).toEqual({ status: "denied" }); expect(f.counts().sends).toBe(0);
  expect((await f.read()).some(e => e.type === "AikoBrowserWatchWebhookPermitted")).toBe(false);
});

test("permit structural guard refuses secret fields, changed identity, or a new permission without native OutputStarted", async () => {
  const f = await webhookActionFixture(); await prepare(f);
  const rows = await f.read(), fact = rows.find(e => e.type === "AikoBrowserWatchWebhookPermitted")!;
  const prior = rows.filter(e => e.type !== fact.type && e.type !== "AikoChannelOutputSettled");
  expect(browserWatchWebhookPermitAppendAllowed([fact], () => prior)).toBe(true);
  expect(browserWatchWebhookPermitAppendAllowed([{ ...fact, prepared: { headers: { authorization: "secret" } } }], () => prior)).toBe(false);
  expect(browserWatchWebhookPermitAppendAllowed([{ ...fact, nonce: crypto.randomUUID() }], () => rows)).toBe(false);
  expect(browserWatchWebhookPermitAppendAllowed([fact], () => prior.filter(e => e.type !== "AikoChannelOutputStarted"))).toBe(false);
  expect(f.adapter.admissionAllowed([fact], () => prior)).toBe(false); // No live commit intent cache after completion/restart.
});
