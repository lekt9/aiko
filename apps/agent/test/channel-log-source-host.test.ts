import { fixture as workerFixture } from "./registry-worker-host.test.ts";
import { expect, test } from "bun:test";
import { fixture } from "./registry-host.test.ts";
import {
  channelLogSourceHarnessDefinitions,
  channelLogSourceSchema,
  normalizeChannelLogSource,
  type ChannelLogSourceGrant,
  type ChannelLogSourceKind,
} from "../src/channel-log-source.ts";
import { browserToolResultEventOf } from "@unbrowse/browser-harness/trace";
import { harnessDigest } from "../src/harness-library.ts";
import {
  loginObservationEvent,
  nativeLoginObservation,
} from "../src/native-login-observation.ts";
const expiresAt = Date.now() + 600_000;
const grants: ChannelLogSourceGrant[] = (
  ["browser-result", "knowledge-change", "private-login"] as const
).map((kind) => ({
  owner: "123",
  id: `source:${kind}`,
  kind,
  receivingAuthority: "registry-internal:123",
  active: true,
  expiresAt,
  maxBindings: 8,
}));
function program(
  kind: ChannelLogSourceKind,
  hook = true,
  backlog = 8,
  backfill = false,
) {
  const d = channelLogSourceHarnessDefinitions().find(
    (d) => d.artifact.name === `channel.source.${kind}.ack`,
  )!;
  return `
 const inlet=await channels.bind({name:"source-${kind}",schema:${JSON.stringify(channelLogSourceSchema(kind))},directions:["inbox","outbox"],authorityRef:"registry-internal:123",operationId:"in-${kind}",backlog:${backlog}});
 const outlet=await channels.bind({name:"result-${kind}",schema:"text.message.v1",directions:["inbox","outbox"],authorityRef:"registry-internal:123",operationId:"out-${kind}"});
 ${
   hook
     ? `await tools.call({name:"harness_evaluate",arguments:{digest:"${harnessDigest(d.artifact)}",evaluationId:"eval-${kind}"}});
 await tools.call({name:"harness_promote",arguments:{digest:"${harnessDigest(d.artifact)}",evaluationId:"eval-${kind}",expectedGeneration:0}});
 await channels.connect({name:"source-${kind}-handler",generation:1,input:{channel:inlet.channel,generation:inlet.generation},accepts:${JSON.stringify(channelLogSourceSchema(kind))},handler:{harness:"${harnessDigest(d.artifact)}",contract:"${harnessDigest(d.contract)}"},output:{channel:outlet.channel,generation:outlet.generation,mode:"port"},authorityRef:"registry-internal:123",start:${backfill ? '{from:1,through:1,authorityRef:"registry-internal:123"}' : '"after-registration"'},operationId:"wire-${kind}"});`
     : ""
 }
 const source=await tools.call({name:"channel_source_bind",arguments:{operationId:"source-${kind}",source:"${kind}",sourceAuthority:"source:${kind}",receivingAuthority:"registry-internal:123",port:{channel:inlet.channel,generation:inlet.generation},expiresAt:${expiresAt}}});
 if(source.status!=="active")throw Error(JSON.stringify(source));
 return source;`;
}
const browser = (sequence: number) =>
  browserToolResultEventOf({
    threadId: "user-123",
    sequence,
    callId: `call-${sequence}`,
    action: "read",
    success: true,
    data: {
      url: "https://private.invalid/secret-url",
      password: "secret-password-source",
      code: "991234",
      text: "private-browser-text",
    },
  });

test("actual Bun defaults: native code binds browser source, checked sandbox output and disk restart without inference", async () => {
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  expect(f.readiness).toMatchObject({ logSources: true });
  await f.run(program("browser-result"));
  let rows = await f.events();
  expect(
    rows.filter((e) => e.type === "AikoChannelLogSourceBound"),
  ).toHaveLength(1);
  const models = f.models();
  await f.append([browser(1)]);
  await f.drive();
  rows = await f.events();
  expect(
    rows.filter(
      (e) =>
        e.type === "AikoChannelLogSourceProgress" &&
        e.disposition === "accepted",
    ),
  ).toHaveLength(1);
  expect(
    rows.some((e) => e.type === "AikoChannelWiringAccepted" && e.replyTo),
  ).toBe(true);
  expect(
    rows.some(
      (e) =>
        e.type === "AikoHarnessChecked" &&
        (e.witness as any)?.status === "satisfied",
    ),
  ).toBe(true);
  const before = rows.filter((e) => e.type === "AikoHarnessRunStarted").length;
  await f.restart();
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoHarnessRunStarted"),
  ).toHaveLength(before);
  expect(f.models()).toBe(models);
  await f.append([browser(2)]);
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(2);
  for (const secret of [
    "secret-url",
    "secret-password-source",
    "991234",
    "private-browser-text",
  ]) {
    expect(JSON.stringify(await f.trace())).not.toContain(secret);
    expect(await f.disk()).not.toContain(secret);
  }
});

test("native backpressure retains pending source, drain resumes once; revoked grant stops admission", async () => {
  const current = grants.map((g) => ({ ...g }));
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => current },
  });
  await f.run(program("browser-result", false, 1));
  await f.append([browser(1), browser(2)]);
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
  expect(
    (await f.events()).some((e) => e.type === "AikoChannelLogSourceBlocked"),
  ).toBe(true);
  await f.restart();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
  await f.run(
    program("browser-result", true, 1, true),
    "connect-after-pressure",
  );
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(2);
  current[0]!.active = false;
  await f.append([browser(3)]);
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(2);
});

test("private-login producer metadata is observation only and foreign owner is explicitly rejected", async () => {
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  await f.run(program("private-login"));
  const state = {
    connectionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    revision: 1,
    expiresAt,
    challenge: { id: crypto.randomUUID(), revision: 1, expiresAt },
  };
  const observation = nativeLoginObservation(state, "verified")!;
  await f.append([
    loginObservationEvent("123", observation),
    loginObservationEvent("456", {
      ...observation,
      attemptId: crypto.randomUUID(),
    }),
  ]);
  await f.drive();
  const progress = (await f.events()).filter(
    (e) => e.type === "AikoChannelLogSourceProgress",
  );
  expect(progress.map((e) => e.disposition)).toEqual(["accepted", "rejected"]);
  expect((await f.events()).some((e) => e.type === "SessionVerified")).toBe(
    false,
  );
});

test("source grant missing is unavailable and normalization never exposes arbitrary browser values", async () => {
  const f = await fixture(true, { defaults: true });
  expect(f.readiness).toMatchObject({ logSources: false });
  const normalized = normalizeChannelLogSource(
    "browser-result",
    { ...browser(1), action: "OTP:991234", url: "https://private" },
    "123",
    1,
    "a".repeat(64),
  );
  expect(normalized).toMatchObject({ action: "other", category: "other" });
  expect(JSON.stringify(normalized)).not.toContain("991234");
});

test("actual indexer producer crosses native Router with payload-free wake and exact stream admission", async () => {
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  await f.run(program("knowledge-change"));
  await f.driveBackground();
  await f.drive();
  const indexer = await f.readThread("background-123-indexer"),
    foreground = await f.events();
  expect(indexer.some((e) => e.type === "AikoKnowledgeChanged")).toBe(true);
  expect(indexer.some((e) => e.type === "AikoChannelLogSourceRelayed")).toBe(
    true,
  );
  expect(foreground.some((e) => e.type === "AikoChannelLogSourceWake")).toBe(
    true,
  );
  expect(
    foreground.some(
      (e) =>
        e.type === "AikoChannelLogSourceProgress" &&
        e.disposition === "accepted",
    ),
  ).toBe(true);
  expect(
    foreground.some((e) => e.type === "AikoChannelWiringAccepted" && e.replyTo),
  ).toBe(true);
  expect(
    foreground
      .filter((e) => e.type === "AikoChannelLogSourceWake")
      .every((e) => !("changed" in e) && !("root" in e)),
  ).toBe(true);
  const before = foreground.filter(
    (e) => e.type === "AikoChannelLogSourceProgress",
  ).length;
  await f.restart();
  await f.driveBackground();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(before);
});

test("registration races retain the first cut; unavailable private anchor halts instead of replaying", async () => {
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  const host = f.nativeHost(),
    seed = host.seed.bind(host);
  let injected = false;
  (host as any).seed = async (
    thread: string,
    events: readonly import("tardie/core/event").Event[],
  ) => {
    await seed(thread, events);
    if (!injected && events.some((e) => e.type === "AikoChannelLogSourceCut")) {
      injected = true;
      // Fact appears after the retained source read, before activation.
      await seed("user-123", [browser(1)]);
    }
  };
  await f.run(program("browser-result"));
  await f.drive();
  expect(injected).toBe(true);
  expect(
    (await f.events()).find((e) => e.type === "AikoChannelLogSourceCut")
      ?.cursor,
  ).toBe(0);
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
  const progress = (await f.events()).find(
    (e) => e.type === "AikoChannelLogSourceProgress",
  )!;
  f.erasePrivate((progress.anchorRef as any).ref);
  await f.restart();
  await f.append([browser(2)]);
  await f.drive();
  expect(
    (await f.events()).some((e) => e.type === "AikoChannelLogSourceGap"),
  ).toBe(true);
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
});

test("actual Worker entry default source tools, private login producer, native checked handler and storage reopen", async () => {
  const current = grants.map((g) => ({ ...g }));
  const f = await workerFixture({
    program: program("private-login"),
    logSources: () => current,
  });
  expect(
    await (await f.request("/api/harness/readiness")).json(),
  ).toMatchObject({ logSources: true });
  expect(
    (
      await f.request("/api/messages", {
        id: "source-worker",
        text: "Set up the controlled metadata hook.",
      })
    ).status,
  ).toBe(202);
  for (
    let n = 0;
    n < 8 &&
    !f.events().some((e: any) => e.type === "AikoChannelLogSourceBound");
    n++
  )
    await f.drive();
  expect(
    f.events().some((e: any) => e.type === "AikoChannelLogSourceBound"),
  ).toBe(true);
  const state = {
    connectionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    revision: 1,
    expiresAt,
  };
  const event = loginObservationEvent(
    "123",
    nativeLoginObservation(state, "opening")!,
  );
  await (await f.nativeHost()).seed("user-123", [event]);
  for (
    let n = 0;
    n < 8 &&
    !f
      .events()
      .some((e: any) => e.type === "AikoChannelWiringAccepted" && e.replyTo);
    n++
  )
    await f.drive();
  expect(
    f.events().filter((e: any) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
  expect(
    f
      .events()
      .some((e: any) => e.type === "AikoChannelWiringAccepted" && e.replyTo),
  ).toBe(true);
  const jobs = f.jobs.length,
    calls = f.requests.length;
  await f.restart();
  await f.drive();
  await f.drive();
  expect(f.jobs).toHaveLength(jobs);
  expect(f.requests).toHaveLength(calls);
  current[2]!.active = false;
  await (
    await f.nativeHost()
  ).seed("user-123", [
    loginObservationEvent("123", nativeLoginObservation(state, "verified")!),
  ]);
  await f.drive();
  expect(
    f.events().filter((e: any) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
  expect(
    (
      await f.request(
        "/api/messages",
        { id: "forged", text: "x", events: [event] },
        "foreign-token",
      )
    ).status,
  ).toBe(401);
  expect(f.jobs).toHaveLength(jobs);
});

test("retained cut recovers activation after a lost native registration acknowledgment", async () => {
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  const host = f.nativeHost(),
    seed = host.seed.bind(host);
  let interrupted = false;
  (host as any).seed = async (
    thread: string,
    events: readonly import("tardie/core/event").Event[],
  ) => {
    await seed(thread, events);
    if (
      !interrupted &&
      events.some((e) => e.type === "AikoChannelLogSourceCut")
    ) {
      interrupted = true;
      await seed("user-123", [browser(1)]);
      throw Error(
        "Controlled cut persisted but registration acknowledgment lost",
      );
    }
  };
  await f.run(program("browser-result")).catch(() => undefined);
  await f.restart();
  await f.drive();
  expect(interrupted).toBe(true);
  const rows = await f.events();
  expect(rows.filter((e) => e.type === "AikoChannelLogSourceCut")).toHaveLength(
    1,
  );
  expect(
    rows.filter((e) => e.type === "AikoChannelLogSourceBound"),
  ).toHaveLength(1);
  expect(
    rows.filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
});

test("truncated source history and forged wake hints cannot reset the retained cursor", async () => {
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  await f.run(program("browser-result"));
  await f.append([browser(1)]);
  await f.drive();
  const host = f.nativeHost(),
    read = host.read.bind(host);
  (host as any).read = async (thread: string) =>
    (await read(thread)).filter(
      (e) => thread !== "user-123" || e.type !== "BrowserToolResultObserved",
    );
  // A native wake remains merely a hint. Even this privileged fixture cannot
  // make the source consume the metadata carried in the wake as an observation.
  await f.append([
    {
      type: "AikoChannelLogSourceWake",
      provenance: "aiko.channel.host.v1",
      owner: "123",
      id: "fixture-forged-hint",
      source: "browser-result",
      success: true,
      sourceThread: "user-456",
    },
  ]);
  await f.drive();
  const rows = await read("user-123");
  expect(rows.some((e) => e.type === "AikoChannelLogSourceGap")).toBe(true);
  expect(
    rows.filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(1);
});

test("current receiving scope is independent; explicit native revoke stops future admission", async () => {
  const denied = await fixture(true, {
    defaults: true,
    overrides: {
      logSources: () =>
        grants.map((g) => ({ ...g, receivingAuthority: "foreign-receiving" })),
    },
  });
  expect(denied.readiness).toMatchObject({ logSources: false });
  await denied.run(program("browser-result"));
  expect(
    (await denied.events()).some((e) => e.type === "AikoChannelLogSourceCut"),
  ).toBe(false);
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => grants },
  });
  await f.run(program("browser-result"));
  const bound = (await f.events()).find(
    (e) => e.type === "AikoChannelLogSourceBound",
  )!;
  await f.run(
    `return await tools.call({name:"channel_source_revoke",arguments:{id:${JSON.stringify(bound.id)}}});`,
    "revoke-source",
  );
  await f.append([browser(1)]);
  await f.drive();
  expect(
    (await f.events()).some((e) => e.type === "AikoChannelLogSourceRevoked"),
  ).toBe(true);
  expect(
    (await f.events()).some((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toBe(false);
});

test("native source lifetime budget is finite across batches and restart; expiry admits nothing new", async () => {
  const current = grants.map((g) => ({ ...g }));
  const f = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => current },
  });
  await f.run(program("browser-result", false, 128));
  await f.append(Array.from({ length: 129 }, (_, i) => browser(i + 1)));
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(128);
  expect(
    (await f.events()).filter(
      (e) => e.type === "AikoChannelLogSourceExhausted",
    ),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(
    (await f.events()).filter((e) => e.type === "AikoChannelLogSourceProgress"),
  ).toHaveLength(128);
  const other = await fixture(true, {
    defaults: true,
    overrides: { logSources: () => current },
  });
  await other.run(program("private-login"));
  current[2]!.expiresAt = Date.now() - 1;
  const state = {
    connectionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    revision: 1,
    expiresAt,
  };
  await other.append([
    loginObservationEvent("123", nativeLoginObservation(state, "opening")!),
  ]);
  await other.drive();
  expect(
    (await other.events()).some(
      (e) => e.type === "AikoChannelLogSourceProgress",
    ),
  ).toBe(false);
}, 20000);
