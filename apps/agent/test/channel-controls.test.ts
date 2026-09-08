import { expect, test } from "bun:test";
import { fixture, compose } from "./provider-adapter-host.test.ts";
import {
  channelControlState,
  channelRuntimeNextWake,
} from "../src/channel-controls.ts";
for (const worker of [false, true])
  test(`automatic finite poll actual ${worker ? "Worker" : "Bun"} deadlines and restart preserve custody and stop after allowance`, async () => {
    const f = await fixture(worker, true, {});
    try {
      await f.run(compose);
      await f.drive();
      const b = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!;
      const schedule = {
        channel: b.channel,
        generation: 1,
        operation: "schedule",
        operationId: "finite-polls",
      };
      await f.run(
        `return await tools.call({name:'provider_adapter_control',arguments:{...${JSON.stringify(schedule)},plan:{action:'poll',maxRuns:2,intervalMs:150,backoffMs:150,expiresAt:Date.now()+5000,firstAt:Date.now()+300,leaseLeadMs:0}}});`,
        "schedule-polls",
      );
      expect(
        (await f.events()).filter((e) => e.type === "AikoChannelControlPlan"),
      ).toHaveLength(1);
      await f.restart();
      for (
        let i = 0;
        i < 6 && f.requests.filter((r) => r.operation === "poll").length < 2;
        i++
      ) {
        const due = channelRuntimeNextWake(await f.events(), "123");
        if (due !== undefined)
          await Bun.sleep(Math.max(1, due - Date.now() + 10));
        await f.drive();
      }
      expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(2);
      const rows = await f.events();
      expect(
        rows.filter((e) => e.type === "AikoChannelPollFetched"),
      ).toHaveLength(2);
      expect(
        rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
      ).toHaveLength(2);
      expect(channelControlState(rows, "123")[0]?.reason).toBe("exhausted");
      expect(rows.some((e) => e.type === "AlarmFired")).toBe(true);
      const jobs = f.jobs.length,
        models = f.models();
      await f.restart();
      await f.drive();
      expect(f.jobs.length).toBe(jobs);
      expect(f.models()).toBe(models);
      expect(f.requests.filter((r) => r.operation === "send")).toHaveLength(0);
      expect(JSON.stringify(await f.events())).not.toContain("PRIVATE_CURSOR");
    } finally {
      await f.close();
    }
  }, 15000);
for (const worker of [false, true])
  test(`automatic signed lease ${worker ? "Worker" : "Bun"} unknown renewal stops with original mutation identity`, async () => {
    const f = await fixture(worker, false, { lease: true });
    try {
      await f.run(compose);
      await f.drive();
      const b = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!;
      f.lost("/renew");
      await f.run(
        `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'lease-plan',plan:{action:'renew',maxRuns:2,intervalMs:100,backoffMs:150,expiresAt:Date.now()+5000,firstAt:Date.now()+200,leaseLeadMs:1500}}});`,
        "schedule-lease",
      );
      expect(
        (await f.events()).filter((e) => e.type === "AikoChannelControlPlan"),
      ).toHaveLength(1);
      const retained = await f.events(),
        registration = retained.findIndex(
          (e) => e.type === "AikoChannelControlPlan",
        );
      const due = channelRuntimeNextWake(
        retained.slice(0, registration + 1),
        "123",
      );
      expect(due).toBeDefined();
      await f.restart();
      await Bun.sleep(Math.max(1, due! - Date.now() + 10));
      await f.drive();
      expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(1);
      expect(channelControlState(await f.events(), "123")[0]?.reason).toBe(
        "unknown",
      );
      const count = f.jobs.length;
      await f.restart();
      await f.drive();
      expect(f.jobs.length).toBe(count);
      expect(channelRuntimeNextWake(await f.events(), "123")).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 15000);
for (const worker of [false, true])
  for (const stop of ["cancel", "revoke"] as const)
    test(`automatic poll ${worker ? "Worker" : "Bun"} ${stop} prevents scheduled physical work`, async () => {
      const f = await fixture(worker, true, {});
      try {
        await f.run(compose);
        await f.drive();
        const b = (await f.events()).find(
          (e) => e.type === "AikoChannelBindingIntent",
        )!;
        await f.run(
          `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'stop-plan',plan:{action:'poll',maxRuns:2,intervalMs:100,backoffMs:100,expiresAt:Date.now()+5000,firstAt:Date.now()+1000,leaseLeadMs:0}}});`,
          "register-stop",
        );
        const due = channelRuntimeNextWake(await f.events(), "123");
        expect(due).toBeDefined();
        if (stop === "cancel")
          await f.run(
            `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'cancel-schedule',operationId:'stop-control',planId:'stop-plan'}});`,
            "cancel-stop",
          );
        else f.policy.active = false;
        await f.restart();
        await Bun.sleep(Math.max(1, due! - Date.now() + 10));
        await f.drive();
        expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(
          0,
        );
        expect(
          (await f.events()).filter(
            (e) => e.type === "AikoChannelControlStopped",
          ),
        ).toHaveLength(1);
        expect(channelRuntimeNextWake(await f.events(), "123")).toBeUndefined();
      } finally {
        await f.close();
      }
    }, 15000);
test("automatic renewal rejects unsigned lease and missing standing allowance", async () => {
  for (const allowed of [false, true]) {
    const f = await fixture(false, false, allowed ? {} : undefined);
    try {
      await f.run(compose);
      await f.drive();
      const b = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!;
      await f.run(
        `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'unsigned',plan:{action:'renew',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+2000,firstAt:Date.now()+200,leaseLeadMs:100}}});`,
        "unsigned-lease",
      );
      expect(
        (await f.events()).filter((e) => e.type === "AikoChannelControlPlan"),
      ).toHaveLength(0);
      expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
}, 15000);
test("automatic Worker resumes retained fetched batch without a second physical GET", async () => {
  const f = await fixture(true, true, {});
  try {
    await f.run(compose);
    await f.drive();
    const b = (await f.events()).find(
      (e) => e.type === "AikoChannelBindingIntent",
    )!;
    await f.run(
      `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'batch-cut',plan:{action:'poll',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+5000,firstAt:Date.now()+200,leaseLeadMs:0}}});`,
      "batch-plan",
    );
    const due = channelRuntimeNextWake(await f.events(), "123")!;
    await Bun.sleep(Math.max(1, due - Date.now() + 10));
    await f.drive();
    expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(1);
    await f.restorePollCut();
    await f.drive();
    const rows = await f.events();
    expect(
      rows.filter((e) => e.type === "AikoChannelPollFetched"),
    ).toHaveLength(1);
    expect(
      rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
    ).toHaveLength(1);
    expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(1);
    expect(channelControlState(rows, "123")[0]?.reason).toBe("exhausted");
  } finally {
    await f.close();
  }
}, 15000);
for (const worker of [false, true])
  test(`automatic signed lease ${worker ? "Worker" : "Bun"} renews only from provider expiry and consumes finite budget`, async () => {
    const f = await fixture(worker, false, { lease: true });
    try {
      await f.run(compose);
      await f.drive();
      const b = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!;
      await f.run(
        `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'renew-success',plan:{action:'renew',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+5000,firstAt:Date.now()+200,leaseLeadMs:1000}}});`,
        "renew-success",
      );
      const rows = await f.events(),
        lease = (
          rows.find((e) => e.type === "AikoChannelSubscriptionSettled")
            ?.receipt as any
        ).leaseExpiresAt;
      const registration = rows.findIndex(
        (e) => e.type === "AikoChannelControlPlan",
      );
      expect(registration).toBeGreaterThanOrEqual(0);
      const due = channelRuntimeNextWake(
        rows.slice(0, registration + 1),
        "123",
      )!;
      expect(due).toBeGreaterThanOrEqual(lease - 1000);
      await f.restart();
      await Bun.sleep(Math.max(1, due - Date.now() + 10));
      await f.drive();
      expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(1);
      expect(
        Number(
          (await f.events()).find((e) => e.type === "AikoChannelRenewRequested")
            ?.at,
        ),
      ).toBeGreaterThanOrEqual(due);
      expect(
        (await f.events()).find((e) => e.type === "AikoChannelRenewSettled")
          ?.status,
      ).toBe("ready");
      expect(channelControlState(await f.events(), "123")[0]?.reason).toBe(
        "exhausted",
      );
      await f.restart();
      await f.drive();
      expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 15000);
test("automatic Worker pause/resume retains run allowance and rearms existing deadline method", async () => {
  const f = await fixture(true, true, {});
  try {
    await f.run(compose);
    await f.drive();
    const b = (await f.events()).find(
      (e) => e.type === "AikoChannelBindingIntent",
    )!;
    await f.run(
      `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'pause-plan',plan:{action:'poll',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+5000,firstAt:Date.now()+500,leaseLeadMs:0}}});`,
      "pause-plan",
    );
    const change = (status: string, operationId: string) =>
      f.request("/v1/channels/lifecycle", {
        id: b.channel,
        generation: 1,
        status,
        operationId,
        authorization: "provider-bind",
      });
    expect((await change("paused", "pause-auto")).status).toBe(202);
    await f.drive();
    await f.restart();
    await Bun.sleep(550);
    await f.drive();
    expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(0);
    expect((await change("active", "resume-auto")).status).toBe(202);
    await f.drive();
    const due = channelRuntimeNextWake(await f.events(), "123")!;
    await Bun.sleep(Math.max(1, due - Date.now() + 10));
    await f.drive();
    expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(1);
    expect(channelControlState(await f.events(), "123")[0]?.reason).toBe(
      "exhausted",
    );
  } finally {
    await f.close();
  }
}, 15000);
test("automatic Worker plan expiry stops renewal before its signed lease becomes due", async () => {
  const f = await fixture(true, false, { lease: true });
  try {
    await f.run(compose);
    await f.drive();
    const b = (await f.events()).find(
      (e) => e.type === "AikoChannelBindingIntent",
    )!;
    await f.run(
      `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'expires-first',plan:{action:'renew',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+600,firstAt:Date.now()+100,leaseLeadMs:0}}});`,
      "expiry-plan",
    );
    const state = channelControlState(await f.events(), "123")[0]!;
    expect(state).toBeDefined();
    expect(channelRuntimeNextWake(await f.events(), "123")).toBe(
      state.p.expiresAt,
    );
    await f.restart();
    await Bun.sleep(Math.max(1, state.p.expiresAt - Date.now() + 10));
    await f.drive();
    expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(0);
    expect(
      (await f.events()).find((e) => e.type === "AikoChannelControlStopped")
        ?.reason,
    ).toBe("expired");
  } finally {
    await f.close();
  }
}, 15000);

for (const worker of [false, true])
  for (const disposition of ["resume", "cancel"] as const)
    test(`automatic backpressure ${worker ? "Worker" : "Bun"} ${disposition} preserves retained poll after private consumer progress and restart`, async () => {
      const f = await fixture(worker, true, {});
      try {
        const full = compose
          .replace(
            'name:"generated-in",schema:',
            'name:"generated-in",backlog:1,schema:',
          )
          .replace(
            "const wire=await channels.connect",
            `await channels.emit({port:{channel:input.channel,generation:1},schema:"text.message.v1",value:{text:"PRIVATE_CAPACITY_BLOCKER"},occurrence:"capacity-blocker",correlation:"capacity-blocker",authorityRef});
const wire=await channels.connect`,
          );
        await f.run(full);
        await f.drive();
        const b = (await f.events()).find(
          (e) => e.type === "AikoChannelBindingIntent",
        )!;
        f.pollPage([
          {
            occurrence: "blocked-poll-item",
            conversation: "controlled-conversation",
            observation: {
              kind: "external",
              schemaVersion: "provider.text.v1",
              text: "PRIVATE_RETAINED_POLL",
            },
          },
        ]);
        await f.run(
          `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'backpressure-plan',plan:{action:'poll',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+9000,firstAt:Date.now()+100,leaseLeadMs:0}}});`,
          "backpressure-schedule",
        );
        await Bun.sleep(110);
        await f.drive();
        let rows = await f.events();
        expect(
          rows.filter((e) => e.type === "AikoChannelPollFetched"),
        ).toHaveLength(1);
        expect(
          rows.filter((e) => e.type === "AikoChannelPollAdmissionDeferred"),
        ).toHaveLength(1);
        expect(
          rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
        ).toHaveLength(0);
        const plan = channelControlState(rows, "123")[0]!;
        expect(plan.used).toBe(1);
        expect(plan.reason).toBe("pending");
        const fetched = rows.find((e) => e.type === "AikoChannelPollFetched")!;
        const change = (status: string, operationId: string) =>
          f.request("/v1/channels/lifecycle", {
            id: b.channel,
            generation: 1,
            status,
            operationId,
            authorization: "provider-bind",
          });
        expect((await change("paused", "pause-backpressure")).status).toBe(202);
        await f.drive();
        const jobs = f.jobs.length;
        await f.restart();
        await f.drive();
        expect(f.jobs.length).toBe(jobs);
        expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(
          1,
        );
        await f.run(
          `const l=await tools.call({name:'harness_list',arguments:{}});const echo=l.candidates.find(c=>c.name==='channel.text.echo');const input=await channels.bind({name:'generated-in',backlog:1,schema:'text.message.v1',directions:['inbox','outbox'],authorityRef:'registry-internal:123',operationId:'provider-in'});const output=await channels.bind({name:'drain-out',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef:'registry-internal:123',operationId:'drain-out'});return await channels.connect({name:'capacity-drain',generation:1,input:{channel:input.channel,generation:1},accepts:'text.message.v1',handler:{harness:echo.harnessDigest,contract:echo.contractDigest},output:{channel:output.channel,generation:1,mode:'port'},start:{from:1,through:1,authorityRef:'registry-internal:123'},authorityRef:'registry-internal:123',operationId:'capacity-drain'});`,
          "release-capacity",
        );
        await f.drive();
        rows = await f.events();
        expect(
          rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
        ).toHaveLength(0);
        expect(rows.some((e) => e.type === "AikoChannelWiringCursor")).toBe(
          true,
        );
        expect(channelControlState(rows, "123")[0]).toMatchObject({
          used: 1,
          reason: "paused",
          p: { expiresAt: plan.p.expiresAt, maxRuns: 1 },
        });
        if (disposition === "cancel") {
          // Owner cancellation does not need to consume another physical poll allowance.
          await f.run(
            `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'cancel-schedule',operationId:'cancel-backpressure',planId:'backpressure-plan'}});`,
            "cancel-backpressure",
          );
        }
        expect((await change("active", "resume-backpressure")).status).toBe(
          202,
        );
        await f.drive();
        rows = await f.events();
        expect(
          rows.filter((e) => e.type === "AikoChannelPollFetched"),
        ).toHaveLength(1);
        expect(
          rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
        ).toHaveLength(disposition === "resume" ? 1 : 0);
        expect(
          rows.find((e) => e.type === "AikoChannelPollSettled"),
        ).toMatchObject({
          id: fetched.id,
          status:
            disposition === "resume" ? "accepted" : "admission_unavailable",
        });
        expect(channelControlState(rows, "123")[0]).toMatchObject({
          used: 1,
          reason: disposition === "resume" ? "exhausted" : "stopped",
          p: { expiresAt: plan.p.expiresAt, maxRuns: 1 },
        });
        expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(
          1,
        );
        const settledJobs = f.jobs.length;
        await f.restart();
        await f.drive();
        expect(f.jobs.length).toBe(settledJobs);
        expect(JSON.stringify(await f.events())).not.toContain(
          "PRIVATE_RETAINED_POLL",
        );
        expect(await f.disk()).not.toContain("PRIVATE_CAPACITY_BLOCKER");
        expect(await f.disk()).not.toContain("PRIVATE_RETAINED_POLL");
      } finally {
        await f.close();
      }
    }, 15000);

for (const worker of [false, true])
  test(`automatic backpressure ${worker ? "Worker" : "Bun"} expiry uses original deadline without consumer progress or refetch`, async () => {
    const f = await fixture(worker, true, {});
    try {
      await f.run(
        compose
          .replace(
            'name:"generated-in",schema:',
            'name:"generated-in",backlog:1,schema:',
          )
          .replace(
            "const wire=await channels.connect",
            `await channels.emit({port:{channel:input.channel,generation:1},schema:"text.message.v1",value:{text:"PRIVATE_EXPIRY_BLOCKER"},occurrence:"expiry-blocker",correlation:"expiry-blocker",authorityRef});const wire=await channels.connect`,
          ),
      );
      const b = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!;
      f.pollPage([
        {
          occurrence: "expire-item",
          conversation: "controlled-conversation",
          observation: {
            kind: "external",
            schemaVersion: "provider.text.v1",
            text: "PRIVATE_EXPIRED_BATCH",
          },
        },
      ]);
      await f.run(
        `return await tools.call({name:'provider_adapter_control',arguments:{channel:${JSON.stringify(b.channel)},generation:1,operation:'schedule',operationId:'expire-pressure',plan:{action:'poll',maxRuns:1,intervalMs:100,backoffMs:100,expiresAt:Date.now()+2000,firstAt:Date.now()+100,leaseLeadMs:0}}});`,
        "expire-pressure",
      );
      await Bun.sleep(110);
      await f.drive();
      const before = await f.events(),
        plan = channelControlState(before, "123")[0]!;
      expect(
        before.filter((e) => e.type === "AikoChannelPollAdmissionDeferred"),
      ).toHaveLength(1);
      expect(channelRuntimeNextWake(before, "123")).toBe(plan.p.expiresAt);
      const jobs = f.jobs.length,
        models = f.models();
      await f.restart();
      await Bun.sleep(Math.max(1, plan.p.expiresAt - Date.now() + 10));
      await f.drive();
      const rows = await f.events();
      expect(rows.some((e) => e.type === "AlarmFired")).toBe(true);
      expect(
        rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
      ).toHaveLength(0);
      expect(
        rows.find((e) => e.type === "AikoChannelPollSettled"),
      ).toMatchObject({ status: "admission_unavailable" });
      expect(channelControlState(rows, "123")[0]).toMatchObject({
        used: 1,
        p: { expiresAt: plan.p.expiresAt, maxRuns: 1 },
      });
      expect(channelRuntimeNextWake(rows, "123")).toBeUndefined();
      expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(1);
      expect(f.jobs.length).toBe(jobs);
      expect(f.models()).toBe(models);
      await f.restart();
      await f.drive();
      expect(f.jobs.length).toBe(jobs);
      expect(await f.disk()).not.toContain("PRIVATE_EXPIRED_BATCH");
    } finally {
      await f.close();
    }
  }, 15000);
