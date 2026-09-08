import { expect, test } from "bun:test";
import { fixture, registryProgram } from "./registry-host.test.ts";
import { HarnessLibrary, harnessDigest } from "../src/harness-library.ts";
import { channelHydrate } from "../src/channel-custody.ts";
for (const missing of [false, true])
  test(`actual account private emit/wait custody across restart; missing package bytes=${missing}`, async () => {
    const secret = `private-channel-${crypto.randomUUID()}@private.invalid`;
    let release!: () => void,
      entered!: () => void,
      calls = 0;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve));
    const f = await fixture(true, {
      text: true,
      beforeJob: async (job) => {
        if ((job.input as any)?.value?.value?.text === secret + secret) {
          calls++;
          entered();
          await gate;
        }
      },
    });
    const contract = await f.seed();
    await f.run(
      registryProgram(contract).replace(/ await channels.emit\([^\n]+\n/, ""),
    );
    const rows = await f.events(),
      wire = rows.find((e) => e.type === "AikoChannelWiringConnected")!
        .wire as any;
    const library = new HarnessLibrary(f.binding(), {
      read: f.events,
      append: f.append,
    });
    expect(
      (
        await library.run(
          wire.handler.harness,
          {
            value: { text: secret },
            schema: "number.input",
            correlation: "private-seed",
          },
          "private-seed",
          new AbortController().signal,
        )
      ).status,
    ).toBe("satisfied");
    const running = f.run(
      `const retained=await tools.call({name:"harness_output",arguments:{operationId:"private-seed"}});await channels.emit({port:${JSON.stringify(wire.input)},schema:"number.input",value:retained.output,occurrence:"private-occurrence",correlation:"private-task",authorityRef:"receiving-fixture"});const result=await channels.wait({port:${JSON.stringify({ channel: wire.output.channel, generation: wire.output.generation })},handler:${JSON.stringify(wire.handler)},schema:"number.output",correlation:"private-task",deadline:Date.now()+60000,authorityRef:"receiving-fixture"});return result;`,
      "private_channel_turn",
    );
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("Handler never started")), 5000),
      ),
    ]);
    try {
      const parked = await f.events();
      expect(
        parked.some(
          (e) =>
            e.type === "BlockedOn" && e.turn === "local:private_channel_turn",
        ),
      ).toBe(true);
      const returned = parked.find(
        (e) =>
          e.type === "PackageReturned" &&
          String(e.callId).includes("private_channel_turn") &&
          (e.result as any)?.privateResult,
      );
      expect(returned).toBeDefined();
      if (missing) f.erasePrivate((returned!.result as any).privateResult.ref);
    } finally {
      release();
    }
    await running;
    await f.drive();
    expect(calls).toBe(1);
    const completion = (await f.events()).find(
      (e) =>
        e.type === "ToolReturned" &&
        String(e.callId).includes("private_channel_turn"),
    );
    expect(completion).toBeDefined();
    if (missing) expect((completion!.result as any).error).toBeDefined();
    else expect((completion!.result as any).error).toBeUndefined();
    const output = (await f.events()).find(
      (e) =>
        e.type === "AikoChannelWiringAccepted" && e.replyTo && e.correlationRef,
    );
    expect(output).toBeDefined();
    expect(
      await channelHydrate(f.binding().blobs, "123", output!.valueRef),
    ).toEqual({ text: secret.repeat(4) });
    await f.restart();
    await f.driveBackground();
    expect(calls).toBe(1);
    expect(
      await channelHydrate(f.binding().blobs, "123", output!.valueRef),
    ).toEqual({ text: secret.repeat(4) });
    const native = await f.trace(),
      all = native.threads.flatMap((t) => t.events),
      trace = JSON.stringify(native),
      disk = await f.disk();
    for (const marker of [
      secret,
      harnessDigest({ text: secret + secret }),
      harnessDigest({ text: secret.repeat(4) }),
    ]) {
      expect(trace).not.toContain(marker);
      expect(disk).not.toContain(marker);
    }
    const packageCalls = all.filter((e) => e.type === "PackageCalled");
    expect(packageCalls.length).toBeGreaterThan(0);
    expect(packageCalls.every((e) => (e.arguments as any)?.privateInput)).toBe(
      true,
    );
    await f.restart();
    expect(calls).toBe(1);
  }, 15000);
