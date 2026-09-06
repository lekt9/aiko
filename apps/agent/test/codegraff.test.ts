import { test, expect, spyOn } from "bun:test";
import {
  Codegraff,
  CodegraffSandbox,
  searchTool,
  type SandboxStore,
} from "../src/codegraff.ts";
import { Memory } from "entity-learn";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import type { MemoryBinding } from "../src/memory.ts";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function store(): SandboxStore {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) =>
      structuredClone(values.get(key)) as T | undefined,
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}
function fixture(state = store()) {
  const calls: { path: string; body: any }[] = [];
  let vmState = "started",
    serial = 0;
  const gateway = new Codegraff("fixture-key", async function (
    this: undefined,
    input,
    init,
  ) {
    // Native workerd fetch rejects a Codegraff object as its receiver.
    expect(this).toBeUndefined();
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.endsWith("/stop")) vmState = "stopped";
    if (path.endsWith("/start")) vmState = "started";
    const output =
      path === "/v1/sandboxes"
        ? { id: "vm-fixture" }
        : path.endsWith("/exec")
          ? { execId: `exec-${++serial}` }
          : path.includes("/exec/")
            ? { state: "completed", exitCode: 0, output: '{"ready":true}' }
            : { state: vmState };
    return Response.json(output);
  });
  const options = {
    owner: "acct_fixture",
    gateway,
    store: state,
    emit: async () => {},
    runnerBundle: "fixture-runner",
    bootstrap: "fixture-bootstrap",
  };
  return { sandbox: new CodegraffSandbox(options), options, calls, state };
}

test("query-only search uses a fixed gateway and unbound fetch receiver", async () => {
  let captured: any;
  const gateway = new Codegraff("private-fixture", async function (
    this: undefined,
    input,
    init,
  ) {
    expect(this).toBeUndefined();
    expect(String(input)).toBe("https://gateway.codegraff.com/v1/search");
    expect(init?.redirect).toBe("manual");
    captured = JSON.parse(String(init?.body));
    return Response.json({ results: [] });
  });
  await gateway.search("restaurants near Orchard");
  expect(captured.query).toBe("restaurants near Orchard");
  expect(captured.url).toBeUndefined();
  await expect(gateway.request("https://evil.test/v1/search")).rejects.toThrow(
    "Invalid gateway route",
  );
});

test("concurrent wake and reconstructed host reuse exactly one tenant VM and disk", async () => {
  const f = fixture();
  expect(await Promise.all([f.sandbox.ensure(), f.sandbox.ensure()])).toEqual([
    "vm-fixture",
    "vm-fixture",
  ]);
  expect(f.calls.filter((c) => c.path === "/v1/sandboxes")).toHaveLength(1);
  await f.sandbox.stop();
  const stopped = await f.sandbox.status();
  expect("stoppedAt" in stopped ? stopped.stoppedAt : undefined).toBeNumber();
  const restarted = new CodegraffSandbox(f.options);
  expect(await restarted.ensure()).toBe("vm-fixture");
  const awake = await restarted.status();
  expect("stoppedAt" in awake ? awake.stoppedAt : undefined).toBeUndefined();
  expect(f.calls.filter((c) => c.path === "/v1/sandboxes")).toHaveLength(1);
  expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(true);
  expect(f.calls.some((c) => c.path.includes("delete"))).toBe(false);
});

test("unknown allocation never automatically allocates another VM", async () => {
  const state = store();
  let calls = 0;
  const sandbox = new CodegraffSandbox({
    owner: "acct_fixture",
    store: state,
    gateway: new Codegraff("fixture", async () => {
      calls++;
      throw new Error("ambiguous transport");
    }),
    emit: async () => {},
    runnerBundle: "x",
    bootstrap: "x",
  });
  await expect(sandbox.ensure()).rejects.toThrow();
  expect((await sandbox.status()).phase).toBe("unknown");
  await expect(sandbox.ensure()).rejects.toThrow("reconciliation");
  expect(calls).toBe(1);
});

test("foreign owner VM and media handles fail before provider calls", async () => {
  const f = fixture();
  await f.state.put("codegraff:sandbox", {
    owner: "acct_other",
    phase: "available",
    id: "other-vm",
    startedAt: 1,
  });
  await expect(f.sandbox.ensure()).rejects.toThrow("owner mismatch");
  await expect(
    f.sandbox.processMedia({
      owner: "acct_other",
      media: { owner: "acct_other", kind: "photo", fileId: "foreign" },
      bytes: new Uint8Array(),
      mimeType: "image/png",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("owner mismatch");
  expect(f.calls).toHaveLength(0);
  expect(f.sandbox.busy).toBe(false);
});

test("native search stores source evidence in the owner's entity-learn journal", async () => {
  const binding: MemoryBinding = {
    owner: "acct_fixture",
    thread: "user-acct_fixture",
    stateDir: "unused",
    redact: (s) => s,
    readPage: async () => [],
    openMemory: (adapters) => {
      return new Memory({
        path: ":memory:",
        scope: "aiko:acct_fixture",
        adapters,
      });
    },
  };
  const gateway = new Codegraff("fixture", async () =>
    Response.json({
      results: [
        {
          title: "Eatigo Singapore",
          url: "https://eatigo.com/en/regions/27",
          text: "Restaurant time slots",
        },
      ],
    }),
  );
  const tool = searchTool(binding, gateway);
  const result = (await Effect.runPromise(
    tool
      .run({ query: "Eatigo Singapore" }, {
        callId: "search-1",
        turn: "turn-1",
        signal: new AbortController().signal,
      } as any)
      .pipe(
        Effect.provideService(Self, {
          actor: "aiko",
          instance: "demo",
          thread: "user-acct_fixture",
        } as any),
      ) as any,
  )) as any;
  expect(result.capability).toBe("web.search");
  expect(result.entities[0].fields.url).toBe(
    "https://eatigo.com/en/regions/27",
  );
  expect(result.observations[0].id).toMatch(/^obs_/);
});

function screenshotFixture(corrupt = false, rejectEvent = false) {
  const commands: string[] = [],
    downloads: string[] = [],
    jobs = new Map<string, string>();
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from([255, 254, 128, 0, 1]),
  ]);
  const armor = png.toString("base64");
  const gateway = new Codegraff("fixture", async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith("/download")) {
      downloads.push(body.path);
      // Reproduce the live provider's UTF-8 conversion. ASCII armor survives it.
      const bytes = Buffer.from(corrupt ? armor.replace(/^./, "A") : armor);
      return Response.json({
        contentBase64: Buffer.from(bytes.toString("utf8")).toString("base64"),
      });
    }
    if (path === "/v1/sandboxes") return Response.json({ id: "vm-screenshot" });
    if (path.endsWith("/exec")) {
      commands.push(body.command);
      const id = `exec-${commands.length}`;
      jobs.set(id, body.command);
      return Response.json({ execId: id });
    }
    if (path.includes("/exec/")) {
      const command = jobs.get(path.split("/").at(-1)!)!;
      const reply = /runner\.js screenshot /.test(command)
        ? {
            mimeType: "image/png",
            size: png.length,
            sha256: createHash("sha256").update(png).digest("hex"),
            events: [{ type: "NetworkFactObserved" }],
            through: 1,
            hasMore: false,
          }
        : { ready: true };
      return Response.json({
        state: "completed",
        exitCode: 0,
        output: JSON.stringify(reply),
      });
    }
    return Response.json({ state: "started" });
  });
  const sandbox = new CodegraffSandbox({
    owner: "acct_fixture",
    store: store(),
    gateway,
    emit: async (event) => {
      if (rejectEvent && event.type === "NetworkFactObserved")
        throw new Error("durable commit failed");
    },
    runnerBundle: "fixture-runner",
    bootstrap: "fixture-bootstrap",
  });
  return { sandbox, commands, downloads, png };
}

test("screenshot binary survives provider UTF-8 download through verified ASCII armor", async () => {
  const f = screenshotFixture();
  const result = await f.sandbox.captureScreenshot(
    new AbortController().signal,
  );
  expect(result.owner).toBe("acct_fixture");
  expect(Buffer.from(result.bytes)).toEqual(f.png);
  expect(f.downloads).toHaveLength(1);
  expect(f.downloads[0]).toMatch(
    /^\/home\/daytona\/aiko\/operations\/[a-f0-9-]{36}\.screenshot\.png\.b64$/,
  );
  expect(f.commands.some((c) => /acknowledge 1$/.test(c))).toBe(true);
  expect(f.commands.some((c) => /discard-screenshot /.test(c))).toBe(true);
  expect(f.sandbox.busy).toBe(false);
});

test("screenshot corrupt transfer is rejected and private files cleaned", async () => {
  const f = screenshotFixture(true);
  await expect(
    f.sandbox.captureScreenshot(new AbortController().signal),
  ).rejects.toThrow("Screenshot integrity mismatch");
  expect(f.commands.some((c) => /discard-screenshot /.test(c))).toBe(true);
  expect(f.sandbox.busy).toBe(false);
});

test("browser events are never acknowledged when the foreground durable commit fails", async () => {
  const f = screenshotFixture(false, true);
  await expect(
    f.sandbox.captureScreenshot(new AbortController().signal),
  ).rejects.toThrow("durable commit failed");
  expect(f.commands.some((c) => /acknowledge /.test(c))).toBe(false);
  expect(f.downloads).toHaveLength(0);
  expect(f.commands.some((c) => /discard-screenshot /.test(c))).toBe(true);
});

function mediaFixture(
  result: unknown,
  options: {
    corrupt?: boolean;
    oversized?: boolean;
    failConfig?: boolean;
    cancelConfig?: AbortController;
    cancelExec?: AbortController;
    hangCleanup?: boolean;
  } = {},
) {
  const files = new Map<string, Buffer>();
  const commands: string[] = [],
    downloads: string[] = [],
    events: Record<string, unknown>[] = [];
  const jobs = new Map<string, string>();
  const bytes = Buffer.from(
    JSON.stringify(result).replace(
      /[\u007f-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
  let cleanupSignal: AbortSignal | undefined;
  const gateway = new Codegraff("fixture", async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith("/upload")) {
      files.set(body.path, Buffer.from(body.contentBase64, "base64"));
      if (body.path.endsWith(".media.json")) {
        options.cancelConfig?.abort();
        if (options.failConfig || options.cancelConfig)
          throw new Error("fixture upload interrupted");
      }
      return Response.json({});
    }
    if (path.endsWith("/download")) {
      downloads.push(body.path);
      const value = files.get(body.path)!;
      const transferred = options.corrupt
        ? Buffer.from("x".repeat(value.length))
        : value;
      // Exactly the provider behavior that corrupts raw binary but preserves ASCII JSON.
      return Response.json({
        contentBase64: Buffer.from(transferred.toString("utf8")).toString(
          "base64",
        ),
      });
    }
    if (path === "/v1/sandboxes") return Response.json({ id: "vm-media" });
    if (path.endsWith("/exec")) {
      commands.push(body.command);
      if (body.async === false) {
        cleanupSignal = init?.signal ?? undefined;
        if (options.hangCleanup)
          return await new Promise<Response>((_, reject) => {
            cleanupSignal!.addEventListener(
              "abort",
              () => reject(new Error("cleanup disconnected")),
              { once: true },
            );
          });
        const operation = body.command.match(/[a-f0-9-]{36}/)?.[0];
        expect(operation).toBeDefined();
        expect(body.command).not.toContain("*");
        for (const name of files.keys())
          if (name.includes(`/operations/${operation}.`)) files.delete(name);
        return Response.json({ exitCode: 0, result: "" });
      }
      const job = `job-${commands.length}`;
      jobs.set(job, body.command);
      return Response.json({ execId: job });
    }
    if (path.includes("/exec/")) {
      if (init?.method === "DELETE") return Response.json({});
      const command = jobs.get(path.split("/").at(-1)!)!;
      const operation = command.match(/media\.py ([a-f0-9-]{36})$/)?.[1];
      if (operation) {
        if (options.cancelExec) {
          options.cancelExec.abort();
          throw new Error("fixture execution cancelled");
        }
        files.set(
          `/home/daytona/aiko/operations/${operation}.media.result.json`,
          bytes,
        );
        return Response.json({
          state: "completed",
          exitCode: 0,
          output:
            "provider stderr warning\n" +
            JSON.stringify({
              version: 1,
              size: options.oversized ? 24 * 1024 * 1024 + 1 : bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            }),
        });
      }
      return Response.json({
        state: "completed",
        exitCode: 0,
        output: '{"ready":true}',
      });
    }
    return Response.json({ state: "started" });
  });
  const sandbox = new CodegraffSandbox({
    owner: "acct_fixture",
    store: store(),
    gateway,
    emit: async (event) => {
      events.push(event);
    },
    runnerBundle: "fixture",
    bootstrap: "fixture",
    mediaScript: "fixture",
  });
  const input = (signal = new AbortController().signal) => ({
    owner: "acct_fixture",
    media: {
      owner: "acct_fixture",
      kind: "video" as const,
      fileId: "private-fixture",
    },
    mimeType: "video/mp4",
    bytes: new Uint8Array([1, 2, 3]),
    signal,
  });
  return {
    sandbox,
    bytes,
    files,
    commands,
    downloads,
    events,
    input,
    cleanupSignal: () => cleanupSignal,
  };
}

test("media results larger than the exec tail retain all frames and Unicode text", async () => {
  const frame = Buffer.alloc(200_000, 123);
  frame.set([255, 216, 255]);
  const f = mediaFixture({
    status: "processed",
    text: "Learned café 世界",
    sampledVideo: true,
    images: Array.from({ length: 6 }, (_, i) => ({
      mimeType: "image/jpeg",
      data: frame.toString("base64"),
      atSeconds: i,
    })),
  });
  expect(f.bytes.length).toBeGreaterThan(1_000_000);
  const result = await f.sandbox.processMedia(f.input());
  expect(result.images).toHaveLength(6);
  expect(Buffer.from(result.images![5]!.data)).toEqual(frame);
  expect(result.text).toBe("Learned café 世界");
  expect(f.downloads).toHaveLength(1);
  expect(
    [...f.files.keys()].filter((name) => name.includes("/operations/")),
  ).toEqual([]);
  expect(f.sandbox.busy).toBe(false);
});

test("large voice output transfers losslessly without stdout base64", async () => {
  const voice = Buffer.alloc(800_000, 221);
  voice.write("OggS");
  const f = mediaFixture({
    status: "processed",
    mimeType: "audio/ogg",
    data: voice.toString("base64"),
  });
  expect(f.bytes.length).toBeGreaterThan(1_000_000);
  expect(
    Buffer.from(
      await f.sandbox.speak("Synthetic fixture", new AbortController().signal),
    ),
  ).toEqual(voice);
  expect(f.downloads).toHaveLength(1);
  expect(
    [...f.files.keys()].filter((name) => name.includes("/operations/")),
  ).toEqual([]);
});

test("media integrity and metadata bounds reject corrupted or oversized downloads with cleanup", async () => {
  for (const options of [{ corrupt: true }, { oversized: true }]) {
    const f = mediaFixture(
      { status: "processed", text: "private text" },
      options,
    );
    await expect(f.sandbox.processMedia(f.input())).rejects.toThrow();
    expect(f.downloads.length).toBe("oversized" in options ? 0 : 1);
    expect(
      [...f.files.keys()].filter((name) => name.includes("/operations/")),
    ).toEqual([]);
    expect(f.sandbox.busy).toBe(false);
  }
});

test("media upload failure and caller cancellation clean fixed private paths before Python can finish", async () => {
  for (const mode of [
    "failed-upload",
    "cancelled-upload",
    "cancelled-exec",
  ] as const) {
    const cancellation = new AbortController();
    const f = mediaFixture(
      {},
      mode === "failed-upload"
        ? { failConfig: true }
        : mode === "cancelled-upload"
          ? { cancelConfig: cancellation }
          : { cancelExec: cancellation },
    );
    await expect(
      f.sandbox.processMedia(f.input(cancellation.signal)),
    ).rejects.toThrow();
    expect(f.cleanupSignal()).toBeDefined();
    expect(f.cleanupSignal()!.aborted).toBe(false);
    expect(f.cleanupSignal()).not.toBe(cancellation.signal);
    expect(
      [...f.files.keys()].filter((name) => name.includes("/operations/")),
    ).toEqual([]);
    expect(f.sandbox.busy).toBe(false);
  }
});

test("speech upload cancellation also cleans config and temporary paths", async () => {
  const cancellation = new AbortController();
  const f = mediaFixture({}, { cancelConfig: cancellation });
  await expect(
    f.sandbox.speak("Private synthetic fixture", cancellation.signal),
  ).rejects.toThrow();
  expect(
    [...f.files.keys()].filter((name) => name.includes("/operations/")),
  ).toEqual([]);
  expect(f.cleanupSignal()!.aborted).toBe(false);
  expect(f.sandbox.busy).toBe(false);
});

test("disconnected cleanup has a finite independent deadline and emits only content-free evidence", async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const durations: number[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(
    (milliseconds) => {
      durations.push(milliseconds);
      return original(milliseconds === 15_000 ? 5 : milliseconds);
    },
  );
  try {
    const f = mediaFixture(
      { status: "processed", text: "private transcript" },
      { hangCleanup: true },
    );
    expect((await f.sandbox.processMedia(f.input())).text).toBe(
      "private transcript",
    );
    expect(durations).toContain(15_000);
    expect(f.cleanupSignal()!.aborted).toBe(true);
    expect(
      f.events.filter((event) => event.type === "AikoMediaCleanupUnconfirmed"),
    ).toHaveLength(1);
    expect(JSON.stringify(f.events)).not.toContain("private transcript");
    expect(JSON.stringify(f.events)).not.toContain("private-fixture");
    expect(f.sandbox.busy).toBe(false);
  } finally {
    timeout.mockRestore();
  }
});

test("native Python emits private ASCII result metadata and fixed-path cleanup preserves neighboring files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiko-native-media-"));
  const operation = crypto.randomUUID();
  try {
    const source = readFileSync(
      new URL("../assets/media.py", import.meta.url),
      "utf8",
    ).replace(
      'pathlib.Path("/home/daytona/aiko/operations")',
      `pathlib.Path(${JSON.stringify(directory)})`,
    );
    writeFileSync(join(directory, "media.py"), source);
    writeFileSync(
      join(directory, `${operation}.media.json`),
      JSON.stringify({
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    const makeDocument = Bun.spawn(
      [
        "/usr/bin/python3",
        "-c",
        'import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1],"w"); archive.writestr("word/document.xml","<document><t>café 世界</t></document>"); archive.close()',
        join(directory, `${operation}.media`),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await makeDocument.exited).toBe(0);
    const native = Bun.spawn(
      ["/usr/bin/python3", join(directory, "media.py"), operation],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(native.stdout).text();
    expect(await native.exited).toBe(0);
    const metadata = JSON.parse(stdout);
    const output = readFileSync(
      join(directory, `${operation}.media.result.json`),
    );
    expect(stdout.length).toBeLessThan(160);
    expect(metadata.size).toBe(output.length);
    expect(metadata.sha256).toBe(
      createHash("sha256").update(output).digest("hex"),
    );
    expect(output.every((byte) => byte < 128)).toBe(true);
    expect(JSON.parse(output.toString()).text).toBe("café 世界");
    expect(
      statSync(join(directory, `${operation}.media.result.json`)).mode & 0o777,
    ).toBe(0o600);
    expect(existsSync(join(directory, `${operation}.media`))).toBe(false);
    expect(existsSync(join(directory, `${operation}.media.json`))).toBe(false);

    const f = mediaFixture({ status: "processed", text: "fixture" });
    await f.sandbox.processMedia(f.input());
    const cleanup = f.commands.find((command) =>
      command.includes("unlink(missing_ok=True)"),
    )!;
    const target = cleanup.match(/[a-f0-9-]{36}/)![0];
    const suffixes = [
      ".media",
      ".media.json",
      ".media.result.json",
      ".media.result.tmp",
      ".extracted.txt",
      ".wav",
      ".ogg",
      ...Array.from({ length: 6 }, (_, i) => `.${i}.jpg`),
    ];
    for (const suffix of suffixes)
      writeFileSync(join(directory, target + suffix), "private fixture");
    const neighbor = `${crypto.randomUUID()}.media`;
    writeFileSync(join(directory, neighbor), "neighbor fixture");
    writeFileSync(join(directory, target + ".unrelated"), "unrelated fixture");
    const cleaned = Bun.spawn(
      [
        "bash",
        "-c",
        cleanup.replace("/home/daytona/aiko/operations", directory),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await cleaned.exited).toBe(0);
    for (const suffix of suffixes)
      expect(existsSync(join(directory, target + suffix))).toBe(false);
    expect(existsSync(join(directory, neighbor))).toBe(true);
    expect(existsSync(join(directory, target + ".unrelated"))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser pointer binding rejects foreign owner before any VM operation", async () => {
  const f = fixture();
  await expect(
    f.sandbox.browserFactory()({
      domains: ["*"],
      emit: async () => {},
      owner: "foreign",
    }),
  ).rejects.toThrow("owner mismatch");
  expect(f.calls).toHaveLength(0);
});

test("VM browser replay encrypts uploads and output before gateway journals", async () => {
  const { replayKeys, unwrapReplay, sealReplay } =
    await import("../src/codegraff.ts");
  const keys = replayKeys(),
    f = fixture();
  const driver = await f.sandbox.browserFactory()({
    domains: ["*"],
    emit: async () => {},
  });
  const uploads: string[] = [],
    commands: string[] = [];
  const upload = spyOn(f.sandbox, "upload").mockImplementation(
    async (_id, _path, text) => {
      uploads.push(text);
    },
  );
  const exec = spyOn(f.sandbox, "exec").mockImplementation(async (_id, cmd) => {
    commands.push(cmd);
    if (cmd.endsWith(" health"))
      return JSON.stringify({ replayPublicKey: keys.publicKey });
    const { key, value } = unwrapReplay(
      JSON.parse(uploads[0]!),
      keys.privateKey,
    );
    expect(value.request.url).toContain("PRIVATE_DYNAMIC_INPUT");
    return JSON.stringify(
      sealReplay(
        {
          output: {
            status: 200,
            headers: {},
            classification: "application",
            body: { name: "TRANSIENT_RESPONSE" },
          },
        },
        key,
      ),
    );
  });
  try {
    const result = await driver.requestTransport!.send({
      stepId: "one",
      attempt: 1,
      method: "GET",
      url: "https://api.vendor.com/items?id=PRIVATE_DYNAMIC_INPUT",
      headers: {},
      redirect: "manual",
    });
    expect(result.body).toEqual({ name: "TRANSIENT_RESPONSE" });
    expect(uploads.join()).not.toContain("PRIVATE_DYNAMIC_INPUT");
    expect(commands.join()).not.toMatch(
      /PRIVATE_DYNAMIC_INPUT|TRANSIENT_RESPONSE|api.vendor/,
    );
    expect(commands[1]).toMatch(/runner.js request-replay [a-f0-9-]{36}$/);
  } finally {
    upload.mockRestore();
    exec.mockRestore();
  }
});
