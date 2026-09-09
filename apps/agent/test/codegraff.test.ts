import { test, expect, spyOn } from "bun:test";
import {
  Codegraff,
  CodegraffSandbox,
  searchTool,
  type SandboxStore,
} from "../src/codegraff.ts";
import { Memory } from "entity-learn";
import { AgentBrowserClientError, agentBrowserAgentActionOf } from "@unbrowse/browser-harness/client";
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
import { browserWatchRestorePrefixDigest } from "../src/browser-watch-restore.ts";

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
  const commands = f.calls.filter(c => c.path.endsWith("/exec"));
  expect(commands.filter(c => c.body.command === "bash /tmp/aiko-bootstrap.sh")).toHaveLength(1);
  expect(commands.filter(c => c.body.command.endsWith("runner.js install"))).toHaveLength(1);
  expect(commands.every(c => c.body.async === true)).toBe(true);
});

test("browser setup publishes only trusted bootstrap output markers and records failures", async () => {
  const f = fixture();
  const events: any[] = [];
  const sandbox = new CodegraffSandbox({...f.options, emit: async e => { events.push(e); }});
  const exec = spyOn(sandbox, "exec").mockImplementation(async (_id, command, _signal, onOutput) => {
    if (command === "bash /tmp/aiko-bootstrap.sh") {
      await onOutput?.("secret-output-must-stay-private\n[aiko-setup] runtime-ready\n[aiko-setup] chromium-ready\n[aiko-setup] dependencies-ready\n");
    }
    return '{"ready":true}';
  });
  try {
    await sandbox.ensure();
    expect((await sandbox.progress()).map(e => e.stage)).toContain("chromium-ready");
    expect(JSON.stringify(events)).not.toContain("secret-output");
    expect((await sandbox.progress()).at(-1)?.stage).toBe("ready");
    exec.mockRejectedValueOnce(Error("private-provider-failure"));
    await expect(sandbox.ensure()).rejects.toThrow("private-provider-failure");
    expect((await sandbox.progress()).at(-1)?.stage).toBe("failed");
    expect(JSON.stringify(events)).not.toContain("private-provider-failure");
  } finally { exec.mockRestore(); }
});

test("a cancelled login stops waiting for an existing wake without cancelling its owner", async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const exec = spyOn(f.sandbox, "exec").mockImplementation(async () => { await blocked; return '{"ready":true}'; });
  const first = f.sandbox.ensure();
  const caller = new AbortController();
  const joined = f.sandbox.ensure(caller.signal);
  caller.abort(Error("login-cancelled"));
  try {
    await expect(joined).rejects.toThrow("login-cancelled");
    release();
    expect(await first).toBe("vm-fixture");
  } finally { release(); exec.mockRestore(); }
});

for (const stage of ["bootstrap", "install", "health"]) {
  test(`first-use ${stage} failure cannot publish readiness; retry reuses the allocated VM`, async () => {
    const f = fixture();
    const events: Record<string, unknown>[] = [];
    const sandbox = new CodegraffSandbox({ ...f.options, emit: async event => { events.push(event); } });
    const request = f.options.gateway.request.bind(f.options.gateway);
    let fail = true;
    const spy = spyOn(f.options.gateway, "request").mockImplementation(async (path, body: any, ...rest) => {
      const command = body?.command;
      if (fail && typeof command === "string" &&
        (stage === "bootstrap" ? command === "bash /tmp/aiko-bootstrap.sh" : command.endsWith(`runner.js ${stage}`))) {
        fail = false;
        throw new Error("interrupted_installation");
      }
      return request(path, body, ...rest);
    });
    try {
      await expect(sandbox.ensure()).rejects.toThrow("interrupted_installation");
      expect(await f.state.get("codegraff:sandbox")).toMatchObject({ owner: f.options.owner, id: "vm-fixture" });
      expect((await f.state.get<any>("codegraff:sandbox")).runnerVersion).toBeUndefined();
      expect(events.some(e => e.type === "AikoSandboxReady")).toBe(false);
      expect(sandbox.busy).toBe(false);
      expect(await sandbox.ensure()).toBe("vm-fixture");
      expect(f.calls.filter(c => c.path === "/v1/sandboxes")).toHaveLength(1);
      expect(events.filter(e => e.type === "AikoSandboxReady")).toHaveLength(1);
      expect((await f.state.get<any>("codegraff:sandbox")).runnerVersion).toBeString();
    } finally { spy.mockRestore(); }
  });
}

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
    if (cmd.endsWith(" drain")) return JSON.stringify({events:[]});
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

test("inherited VM inspection carries trusted public policy and transient results through encrypted transport",async()=>{
 const {replayKeys,unwrapReplay,sealReplay}=await import("../src/codegraff.ts");
 const keys=replayKeys(),f=fixture(),uploads:string[]=[],commands:string[]=[],seen:any[]=[];
 const driver=await f.sandbox.browserFactory()({domains:["*"],emit:async()=>{}});
 const upload=spyOn(f.sandbox,"upload").mockImplementation(async(_id,_path,text)=>{uploads.push(text);});
 const exec=spyOn(f.sandbox,"exec").mockImplementation(async(_id,cmd)=>{
  commands.push(cmd);
  if(cmd.endsWith(" health"))return JSON.stringify({replayPublicKey:keys.publicKey});
  if(cmd.endsWith(" drain"))return JSON.stringify({events:[]});
  const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);seen.push(value);
  const output=value.operation==="authorize-inspection"?false:{url:"https://example.com/",title:"PRIVATE_TITLE",text:"PRIVATE_BODY",snapshot:"PRIVATE_SNAPSHOT",links:[],linksTruncated:false};
  return JSON.stringify(sealReplay({output},key));
 });
 try {
  const policy={origin:"https://example.com",publicOnly:true};
  expect(await driver.inspectCurrentPage!(policy)).toMatchObject({text:"PRIVATE_BODY"});
  expect(await driver.authorizeInspection!({...policy,publicOnly:false})).toBe(false);
  expect(seen).toMatchObject([{operation:"inspect-current-page",policy},{operation:"authorize-inspection",policy:{...policy,publicOnly:false}}]);
  expect(uploads.join()).not.toMatch(/example.com|PRIVATE_BODY|publicOnly/);
  expect(commands.join()).not.toMatch(/example.com|PRIVATE_BODY|publicOnly/);
 }finally{upload.mockRestore();exec.mockRestore();}
});

test("VM backups use encrypted chunks and exclude concurrent browser operations until close",async()=>{
 const {replayKeys,unwrapReplay,sealReplay}=await import("../src/codegraff.ts");
 const f=fixture(), keys=replayKeys(), uploads:string[]=[], commands:string[]=[];
 const driver=await f.sandbox.browserFactory()({domains:["*"],emit:async()=>{}});
 const ensure=spyOn(f.sandbox,"ensure").mockResolvedValue("vm-fixture");
 const upload=spyOn(f.sandbox,"upload").mockImplementation(async(_id,_path,text)=>{uploads.push(text);});
 const exec=spyOn(f.sandbox,"exec").mockImplementation(async(_id,command)=>{
  commands.push(command);
  if(command.endsWith(" health"))return JSON.stringify({replayPublicKey:keys.publicKey});
  if(command.endsWith(" drain"))return JSON.stringify({events:[]});
  if(command.endsWith(" close"))return '{}';
  const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);
  expect(value.operation).toBe("backup");
  const output=value.action === "prepare"?{version:1,owner:"acct_fixture",files:[{path:"owner.json",bytes:6,sha256:"0".repeat(64)}]}:value.action === "read"?Buffer.from("secret").toString("base64"):{discarded:true};
  return JSON.stringify(sealReplay({output},key));
 });
 try {
  expect(await f.sandbox.backup(async source=>{
   expect(f.sandbox.busy).toBe(true);
   await expect(driver.execute({action:"url"})).rejects.toThrow("maintenance");
   expect(Buffer.from(await source.read("owner.json",0,6)).toString()).toBe("secret");
   return "stored";
  })).toBe("stored");
  expect(f.sandbox.busy).toBe(false);
  expect(commands.at(-1)).toMatch(/runner.js close$/);
  expect(uploads.join()).not.toContain("secret");
  expect(commands.join()).not.toContain("secret");
 } finally {ensure.mockRestore();upload.mockRestore();exec.mockRestore();}
});

for (const failure of ["settled-read", "unknown", "commit-failed"] as const) {
  test(`remote selector wait preserves typed failure after durable trace: ${failure}`, async () => {
    const f = fixture();
    const order: string[] = [];
    const driver = await f.sandbox.browserFactory()({ domains: ["*"], emit: async () => {
      order.push("commit");
      if (failure === "commit-failed") throw new Error("durable commit failed");
    } });
    let action: any;
    const upload = spyOn(f.sandbox, "upload").mockImplementation(async (_id, _path, text) => {
      action = agentBrowserAgentActionOf(JSON.parse(text).action, ["*"]);
    });
    const exec = spyOn(f.sandbox, "exec").mockImplementation(async (_id, command) => {
      if (command.includes(" acknowledge ")) { order.push("acknowledge"); return "{}"; }
      expect(action).toEqual({ action: "wait", selector: "#missing" });
      return JSON.stringify({ status: failure === "unknown" ? "unknown" : "failed", reason: "element_not_found", events: [{type: "BrowserToolResultObserved", success: false}], through: 1, hasMore: false });
    });
    try {
      let caught: unknown;
      try { await driver.execute({ action: "wait", selector: "#missing" }); } catch (error) { caught = error; order.push("throw"); }
      if (failure === "settled-read") {
        expect(caught).toBeInstanceOf(AgentBrowserClientError);
        expect(caught).toMatchObject({code: "element_not_found"});
      } else {
        expect(caught).not.toBeInstanceOf(AgentBrowserClientError);
        expect(String(caught)).toContain(failure === "unknown" ? "outcome_unknown" : "durable commit failed");
      }
      expect(order).toEqual(failure === "commit-failed" ? ["commit", "throw"] : ["commit", "acknowledge", "throw"]);
      expect(f.sandbox.busy).toBe(false);
    } finally { upload.mockRestore(); exec.mockRestore(); }
  });
}

for (const started of [false, true]) {
  test(`transient restart failure reconciles the same VM (start already succeeded: ${started})`, async () => {
    const f = fixture();
    await f.sandbox.ensure();
    await f.sandbox.stop();
    const request = f.options.gateway.request.bind(f.options.gateway);
    let starts = 0;
    const intercepted = spyOn(f.options.gateway, "request").mockImplementation(async (path, body, signal, method, maxBytes) => {
      if (path.endsWith("/start") && ++starts === 1) {
        if (started) await request(path, body, signal, method, maxBytes);
        throw new Error("codegraff_http_502");
      }
      return request(path, body, signal, method, maxBytes);
    });
    try {
      expect(await f.sandbox.ensure()).toBe("vm-fixture");
      expect(starts).toBe(started ? 1 : 2);
      expect(f.calls.filter(c => c.path === "/v1/sandboxes")).toHaveLength(1);
      expect((await f.sandbox.status() as {stoppedAt?: number}).stoppedAt).toBeUndefined();
    } finally { intercepted.mockRestore(); }
  });
}

test("repeated restart failures stop without replacing the known VM or advancing readiness", async () => {
  const f = fixture();
  await f.sandbox.ensure();
  await f.sandbox.stop();
  const before = await f.sandbox.status();
  const request = f.options.gateway.request.bind(f.options.gateway);
  let starts = 0;
  const intercepted = spyOn(f.options.gateway, "request").mockImplementation(async (path, body, signal, method, maxBytes) => {
    if (path.endsWith("/start")) { starts++; throw new Error("codegraff_http_502"); }
    return request(path, body, signal, method, maxBytes);
  });
  try {
    await expect(f.sandbox.ensure()).rejects.toThrow("codegraff_http_502");
    expect(starts).toBe(3);
    expect(await f.sandbox.status()).toEqual(before);
    expect(f.calls.filter(c => c.path === "/v1/sandboxes")).toHaveLength(1);
  } finally { intercepted.mockRestore(); }
});

for (const confirmation of ["settled", "unconfirmed", "deadline"] as const) {
  test(`browser cancellation waits for independent bounded remote settlement: ${confirmation}`, async () => {
    const f = fixture();
    const events: object[] = [];
    const driver = await f.sandbox.browserFactory()({ domains: ["*"], emit: async event => { events.push(event); } });
    const caller = new AbortController();
    const durations: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      durations.push(ms);
      return originalTimeout(ms === 35_000 && confirmation === "deadline" ? 10 : ms);
    });
    let settle!: () => void;
    let cleanupSignal: AbortSignal | undefined;
    const upload = spyOn(f.sandbox, "upload").mockResolvedValue(undefined);
    const exec = spyOn(f.sandbox, "exec").mockImplementation(async (_id, command, signal) => {
      if (command.includes(" execute ")) { caller.abort(); throw new Error("caller_cancelled"); }
      if (command.includes(" acknowledge ")) return "{}";
      expect(command).toMatch(/runner.js cancel [a-f0-9-]{36}$/);
      cleanupSignal = signal;
      expect(signal).toBeDefined();
      expect(signal).not.toBe(caller.signal);
      expect(signal!.aborted).toBe(false);
      await new Promise<void>((resolve, reject) => {
        settle = resolve;
        signal!.addEventListener("abort", () => reject(new Error("cleanup_deadline")), { once: true });
      });
      return JSON.stringify({ cancellationRequested: true, settled: confirmation === "settled", events: [{type: "BrowserToolResultObserved", success: false}], through: 1, hasMore: false });
    });
    try {
      const work = driver.execute({action: "wait", milliseconds: 30_000}, caller.signal).catch(error => error);
      await Bun.sleep(0);
      expect(cleanupSignal).toBeDefined();
      expect(f.sandbox.busy).toBe(true);
      expect(events).toHaveLength(0);
      if (confirmation !== "deadline") settle();
      const error = await work;
      expect(String(error)).toContain(confirmation === "settled" ? "caller_cancelled" : confirmation === "deadline" ? "cleanup_deadline" : "cancellation_unconfirmed");
      expect(events).toHaveLength(confirmation === "settled" ? 1 : 0);
      expect(durations).toContain(35_000);
      expect(f.sandbox.busy).toBe(false);
    } finally { exec.mockRestore(); upload.mockRestore(); timeout.mockRestore(); }
  });
}

test("actual sandbox exec bounds provider DELETE after cancellation with its own signal", async () => {
  const caller = new AbortController();
  const durations: number[] = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    durations.push(ms);
    return originalTimeout(ms === 5000 ? 10 : ms);
  });
  let deleting = false, deleteSignal: AbortSignal | undefined;
  const f = fixture();
  const sandbox = new CodegraffSandbox({ ...f.options, gateway: new Codegraff("fixture", async (_input, init) => {
    if (init?.method === "POST") return Response.json({execId: "cancelled-job"});
    if (init?.method === "DELETE") {
      deleting = true;
      deleteSignal = init.signal ?? undefined;
      expect(deleteSignal?.aborted).toBe(false);
      return await new Promise<Response>((_resolve, reject) => {
        deleteSignal!.addEventListener("abort", () => reject(new Error("delete timed out")), {once: true});
      });
    }
    caller.abort();
    throw new Error("original cancellation");
  }) });
  try {
    await expect(sandbox.exec("vm-fixture", "trusted-command", caller.signal)).rejects.toThrow("original cancellation");
    expect(deleting).toBe(true);
    expect(deleteSignal?.aborted).toBe(true);
    expect(deleteSignal).not.toBe(caller.signal);
    expect(durations).toContain(5000);
  } finally { timeout.mockRestore(); }
});

test("an interrupted upgrade keeps the previous runner until staged assets verify", async () => {
  const f = fixture();
  await f.sandbox.ensure();
  const previous = (await f.state.get<any>("codegraff:sandbox")).runnerVersion;
  const upgraded = new CodegraffSandbox({ ...f.options, runnerBundle: "updated-runner" });
  const request = f.options.gateway.request.bind(f.options.gateway);
  let fail = true;
  const spy = spyOn(f.options.gateway, "request").mockImplementation(async (path, body: any, ...rest) => {
    if (fail && body?.command?.endsWith("install/runner.js install")) {
      throw new Error("interrupted_download");
    }
    return request(path, body, ...rest);
  });
  try {
    f.calls.length = 0;
    await expect(upgraded.ensure()).rejects.toThrow("interrupted_download");
    expect((await f.state.get<any>("codegraff:sandbox")).runnerVersion).toBe(previous);
    expect(f.calls.some(c => c.body?.path === "/home/daytona/aiko/runner.js")).toBe(false);
    expect(f.calls.some(c => c.body?.command?.includes("runner.js close"))).toBe(false);
    expect(f.calls.some(c => c.body?.command?.startsWith("mv "))).toBe(false);
    fail = false;
    f.calls.length = 0;
    expect(await upgraded.ensure()).toBe("vm-fixture");
    const commands = f.calls.map(c => c.body?.command).filter(Boolean) as string[];
    const install = commands.findIndex(c => c.endsWith("install/runner.js install"));
    const close = commands.findIndex(c => c.includes("runner.js close"));
    const publish = commands.findIndex(c => c.startsWith("mv "));
    expect(install).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(install);
    expect(publish).toBeGreaterThan(close);
    expect((await f.state.get<any>("codegraff:sandbox")).runnerVersion).not.toBe(previous);
  } finally { spy.mockRestore(); }
});

for(const reason of ["private_sign_in_pending","private_sign_in_cleanup_failed","unexpected-private-value"])test(`remote pre-dispatch browser blocker propagation: ${reason}`,async()=>{
 const f=fixture();const driver=await f.sandbox.browserFactory()({domains:["*"],emit:async()=>{}});
 const upload=spyOn(f.sandbox,"upload").mockResolvedValue(undefined);
 const exec=spyOn(f.sandbox,"exec").mockResolvedValue(JSON.stringify({status:"blocked",reason,events:[],hasMore:false}));
 try {
  let error:unknown;try{await driver.execute({action:"url"});}catch(caught){error=caught;}
  if(reason.startsWith("private_sign_in_"))expect(error).toMatchObject({code:reason});
  else {expect(String(error)).toContain("outcome_unknown");expect(String(error)).not.toContain(reason);}
 }finally{upload.mockRestore();exec.mockRestore();}
});

test('scoped VM interactions keep policy encrypted, preserve private gates and wait for confirmed cancellation',async()=>{
 const {replayKeys,unwrapReplay,sealReplay}=await import('../src/codegraff.ts');
 const f=fixture(),keys=replayKeys(),uploads:string[]=[],commands:string[]=[],seen:any[]=[];
 const driver=await f.sandbox.browserFactory()({domains:['*'],emit:async()=>{}});
 let mode:'private'|'cancel'='private',settled=false,cancelSignal:AbortSignal|undefined;
 let caller=new AbortController();
 const upload=spyOn(f.sandbox,'upload').mockImplementation(async(_id,_path,text)=>{uploads.push(text);});
 const exec=spyOn(f.sandbox,'exec').mockImplementation(async(_id,command,signal)=>{
  commands.push(command);
  if(command.endsWith(' health'))return JSON.stringify({replayPublicKey:keys.publicKey});
  if(command.endsWith(' drain'))return JSON.stringify({events:[]});
  if(command.includes(' runner.js cancel ')){cancelSignal=signal;return JSON.stringify({settled,events:[]});}
  const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);seen.push(value);
  if(mode==='private')return JSON.stringify(sealReplay({error:'private_sign_in_pending'},key));
  caller.abort();throw Error('execution cancelled');
 });
 try{
  const policy={origin:'https://example.com',origins:['https://example.com']};
  await expect(driver.executeScoped!({action:'click',selector:'#PRIVATE_TARGET'},policy)).rejects.toMatchObject({code:'private_sign_in_pending'});
  mode='cancel';await expect(driver.executeScoped!({action:'click',selector:'#PRIVATE_TARGET'},policy,caller.signal)).rejects.toThrow('sandbox_browser_cancellation_unconfirmed');
  expect(cancelSignal).toBeDefined();expect(cancelSignal!.aborted).toBe(false);
  settled=true;caller=new AbortController();await expect(driver.executeScoped!({action:'click',selector:'#PRIVATE_TARGET'},policy,caller.signal)).rejects.toThrow('execution cancelled');
  expect(seen).toMatchObject([{operation:'execute-scoped',policy},{operation:'execute-scoped',policy},{operation:'execute-scoped',policy}]);
  expect(commands.filter(command=>command.includes(' runner.js request-replay '))).toHaveLength(3);
  expect(commands.filter(command=>command.includes(' runner.js cancel '))).toHaveLength(2);
  expect(commands.join()+uploads.join()).not.toMatch(/PRIVATE_TARGET|example.com/);
 }finally{upload.mockRestore();exec.mockRestore();}
});

async function watchTransport(sandbox:CodegraffSandbox) {
  const {replayKeys,unwrapReplay,sealReplay} = await import("../src/codegraff.ts");
  const keys=replayKeys(),uploads:string[]=[],commands:string[]=[],requests:any[]=[];
  const states=new Map<string,import("../src/browser-watch-runner.ts").BrowserWatchRunnerStatus>();
  let failure:string|undefined, paused=false;
  let reply:(output:any,request:any)=>unknown = output=>output;
  const upload=spyOn(sandbox,"upload").mockImplementation(async(_id,_path,text)=>{uploads.push(text);});
  const exec=spyOn(sandbox,"exec").mockImplementation(async(_id,command)=>{
    commands.push(command);
    if(command.endsWith(" health")||command.endsWith(" peek-health"))return JSON.stringify({replayPublicKey:keys.publicKey});
    if(command.endsWith(" close"))return '{"closed":true}';
    const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);
    requests.push(value);
    let output:unknown;
    if(value.operation==="watch-context")output={owner:sandbox.options.owner,profile:"profile-fixture"};
    else if(value.operation==="watch-configure"){
      const g=value.lease.grant,revision=value.lease.lifecycleRevision??0,leaseRevision=value.lease.leaseRevision??0,prior=states.get(g.producer);
      if(prior && (prior.generation!==g.generation || revision<(prior.lifecycleRevision??0) ||
        revision===(prior.lifecycleRevision??0) && prior.state==="paused" && !value.lease.renewalFrom ||
        revision>(prior.lifecycleRevision??0) && (prior.state!=="paused" || value.lease.resumeFrom?.lifecycleRevision!==prior.lifecycleRevision || value.lease.resumeFrom?.pausedThrough!==prior.pausedThrough)))
        return JSON.stringify(sealReplay({error:"browser_replay_unavailable"},key));
      const preservePause=prior?.state==="paused"&&revision===(prior.lifecycleRevision??0);
      const status={producer:g.producer,generation:g.generation,lifecycleRevision:revision,leaseRevision,
        state:preservePause?"paused" as const:"watching" as const,reason:preservePause?"paused":"recording",expiresAt:g.expiresAt,...(g.deliveryEpoch?{deliveryEpoch:g.deliveryEpoch}:{}),...(preservePause?{pausedThrough:prior.pausedThrough}:{})};
      states.set(g.producer,status);output=status;
    }else if(value.operation==="watch-pause"){
      const prior=states.get(value.producer)!;
      if(!prior || value.lifecycleRevision!==(prior.lifecycleRevision??0))
        return JSON.stringify(sealReplay({error:"browser_replay_unavailable"},key));
      output={...prior,state:"paused",reason:"paused",pausedThrough:prior.pausedThrough??prior.acknowledged??0};
      if(!failure)states.set(value.producer,output as typeof prior);
    }else if(value.operation==="watch-acknowledge-gap"){
      const prior=states.get(value.producer);
      if(!prior||prior.generation!==value.generation||!prior.coverageGap||prior.coverageGap.missed!==value.missed)
        return JSON.stringify(sealReplay({error:"browser_replay_unavailable"},key));
      output={...prior,coverageGap:{...prior.coverageGap,acknowledged:value.missed}};
      states.set(value.producer,output as typeof prior);
    }else if(value.operation==="watch-restore-proof")output=undefined;
    else if(value.operation==="watch-reauthorize"){
      const prior=states.get(value.producer)!;
      const {restore:_,...clean}=prior;
      output={...clean,state:"watching",reason:"recording",deliveryEpoch:value.request.deliveryEpoch,acknowledged:value.request.hostThrough};
      states.set(value.producer,output as typeof prior);
    }else if(value.operation==="watch-status")output=[...states.values()].map(s=>paused?{...s,state:"paused",reason:"connection_revoked",pausedThrough:s.acknowledged??0}:s);
    else throw Error("Unexpected private operation");
    if(failure===value.operation)throw Error("lost_reply");
    return JSON.stringify(sealReplay({output:reply(output,value)},key));
  });
  return {uploads,commands,requests,states,reply:(transform:typeof reply)=>{reply=transform;},fail:(operation?:string)=>{failure=operation;},revoke:()=>{paused=true;},restore:()=>{upload.mockRestore();exec.mockRestore();}};
}
function watchLease(owner="acct_fixture"):import("../src/browser-watch-runner.ts").BrowserWatchLease {
  return {grant:{owner,producer:"producer-fixture",epoch:"epoch-fixture",profile:"profile-fixture",generation:1,
    connectionId:"connection-fixture",connectionRevision:"revision-1",origins:["https://private.example"],kinds:["push"],active:true,
    registeredAt:Date.now(),expiresAt:Date.now()+60_000,secret:"PRIVATE_WATCH_SECRET_NOT_IN_HOST_STORE"},
    ingestUrl:`https://trusted.example/v1/browser-events/${owner}`};
}
function renewedWatchLease(prior:import("../src/browser-watch-runner.ts").BrowserWatchLease){
  return {...prior,grant:{...prior.grant,expiresAt:prior.grant.expiresAt+60000},leaseRevision:(prior.leaseRevision??0)+1,
    renewalFrom:{leaseRevision:prior.leaseRevision??0,expiresAt:prior.grant.expiresAt}};
}

test("renewal writeahead survives lost acknowledgement and idle cleanup without admitting stale or changed configuration",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),initial=watchLease(),renewed=renewedWatchLease(initial);
  try{
    await f.sandbox.watchConfigure(initial);remote.fail("watch-configure");
    await expect(f.sandbox.watchConfigure(renewed)).rejects.toThrow("lost_reply");
    expect(await f.state.get("codegraff:browser-watch-configurations")).toMatchObject([{leaseRevision:1,declaredExpiresAt:renewed.grant.expiresAt}]);
    expect(JSON.stringify(await f.state.get("codegraff:browser-watch-configurations"))).not.toContain(initial.grant.secret);
    // Idle records may be removed on confirmed pause or expiry. CAS receipts must survive.
    await f.state.put("codegraff:browser-watch-leases",[]);
    const rebuilt=new CodegraffSandbox(f.options),restored=await watchTransport(rebuilt);
    restored.states.set(initial.grant.producer,remote.states.get(initial.grant.producer)!);
    try{
      await expect(rebuilt.watchConfigure(initial)).rejects.toThrow("lease stale");
      await expect(rebuilt.watchConfigure({...renewed,grant:{...renewed.grant,expiresAt:renewed.grant.expiresAt+1}})).rejects.toThrow("lease conflict");
      await expect(rebuilt.watchConfigure({...renewed,leaseRevision:3})).rejects.toThrow("lease stale");
      expect(restored.requests).toHaveLength(0);
      expect(await rebuilt.watchConfigure(renewed)).toMatchObject({leaseRevision:1,expiresAt:renewed.grant.expiresAt});
      expect(await rebuilt.watchPause(initial.grant.producer,undefined,0)).toMatchObject({leaseRevision:1,state:"paused"});
      expect(restored.requests.at(-1)).toMatchObject({operation:"watch-pause",lifecycleRevision:0});
      expect(await f.state.get<unknown>("codegraff:browser-watch-leases")).toEqual([]);
      expect(await f.state.get("codegraff:browser-watch-configurations")).toMatchObject([{leaseRevision:1}]);
      const next=renewedWatchLease(renewed);
      expect(await rebuilt.watchConfigure(next)).toMatchObject({leaseRevision:2,state:"paused",pausedThrough:0});
      expect(await rebuilt.watchConfigure({...next,lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:0}})).toMatchObject({state:"watching",leaseRevision:2,lifecycleRevision:1});
      expect(restored.uploads.join()+restored.commands.join()).not.toContain(initial.grant.secret);
    }finally{restored.restore();}
  }finally{remote.restore();}
});

test("renewal status requires exact revision and bounds lapse proof without leaking extra metadata",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),initial=watchLease(),renewed=renewedWatchLease(initial);
  try{
    await f.sandbox.watchConfigure(initial);
    remote.reply(output=>({...output,leaseRevision:0}));
    await expect(f.sandbox.watchConfigure(renewed)).rejects.toThrow("configure unconfirmed");
    remote.reply(output=>output);await f.sandbox.watchConfigure(renewed);
    const original=remote.states.get(initial.grant.producer)!,lapse={from:1,to:2,leaseRevision:1};
    remote.states.set(initial.grant.producer,{...original,observationFloor:2,coverageLapse:{...lapse,secret:"PRIVATE_LAPSE"} as typeof lapse});
    expect((await f.sandbox.watchStatus())[0]!.coverageLapse).toEqual(lapse);
    for(const patch of [{leaseRevision:-1},{leaseRevision:0.5},{observationFloor:-1},{observationFloor:3,coverageLapse:lapse},
      {observationFloor:2,coverageLapse:{...lapse,leaseRevision:2}},{observationFloor:2,coverageLapse:{...lapse,from:3}}]){
      remote.states.set(initial.grant.producer,{...original,...patch});
      await expect(f.sandbox.watchStatus()).rejects.toThrow("renewal status invalid");
    }
  }finally{remote.restore();}
});

test("watch controls use encrypted operations and durable idle fences survive host reconstruction",async()=>{
  const {Database}=await import("bun:sqlite");
  const directory=mkdtempSync(join(tmpdir(),"watch-host-store-")),path=join(directory,"store.sqlite");
  let db=new Database(path);
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const state:SandboxStore={get:async<T>(key:string)=>{const row=db.query("SELECT value FROM kv WHERE key=?").get(key) as {value:string}|null;return row?JSON.parse(row.value) as T:undefined;},
    put:async(key,value)=>{db.query("INSERT OR REPLACE INTO kv VALUES(?,?)").run(key,JSON.stringify(value));}};
  const f=fixture(state);await f.sandbox.ensure();
  const transport=await watchTransport(f.sandbox),lease=watchLease();
  try {
    const driver=await f.sandbox.browserFactory()({domains:["*"],owner:lease.grant.owner,emit:async()=>{}});
    expect(await driver.watchContext!()).toEqual({owner:lease.grant.owner,profile:lease.grant.profile});
    expect(await driver.watchConfigure!(lease)).toMatchObject({state:"watching",generation:1});
    expect(await driver.watchStatus!()).toHaveLength(1);
    expect(await driver.hasActiveWatchLease!()).toBe(true);
    await driver.close();
    expect(f.calls.some(c=>c.path.endsWith("/stop"))).toBe(false);
    expect(JSON.stringify(await state.get("codegraff:browser-watch-leases"))).not.toMatch(/PRIVATE_WATCH_SECRET|private.example|trusted.example/);
    expect(transport.uploads.join()).not.toMatch(/PRIVATE_WATCH_SECRET|private.example|watch-configure/);
    expect(transport.commands.join()).not.toMatch(/PRIVATE_WATCH_SECRET|private.example|watch-configure/);
    db.close();db=new Database(path);
    const reconstructed=new CodegraffSandbox(f.options),remote=await watchTransport(reconstructed);
    remote.states.set(lease.grant.producer,transport.states.get(lease.grant.producer)!);
    try {
      expect(await reconstructed.stop()).toBe(false);
      remote.fail("watch-status");
      expect(await reconstructed.stop()).toBe(false);
      remote.fail();remote.revoke();
      expect(await reconstructed.stop()).toBe(true);
      expect(f.calls.filter(c=>c.path.endsWith("/stop"))).toHaveLength(1);
    }finally{remote.restore();}
  }finally{transport.restore();db.close();rmSync(directory,{recursive:true,force:true});}
},30000);

test("lost watch configure and pause replies hold only the retained deadline, confirmed pause releases it",async()=>{
  const f=fixture();await f.sandbox.ensure();
  const transport=await watchTransport(f.sandbox),lease=watchLease();
  try {
    transport.fail("watch-configure");
    await expect(f.sandbox.watchConfigure(lease)).rejects.toThrow("lost_reply");
    // The remote accepted before the response vanished; restarting cannot erase the fence.
    const restarted=new CodegraffSandbox(f.options),remote=await watchTransport(restarted);
    try {
      remote.fail("watch-status");
      expect(await restarted.stop()).toBe(false);
      remote.fail(); // Empty status is not proof an uncertain configure did not happen.
      expect(await restarted.stop()).toBe(false);
      remote.states.set(lease.grant.producer,transport.states.get(lease.grant.producer)!);
      remote.fail("watch-pause");
      await expect(restarted.watchPause(lease.grant.producer)).rejects.toThrow("lost_reply");
      expect(await restarted.hasActiveWatchLease()).toBe(true);
      remote.fail();
      expect(await restarted.watchPause(lease.grant.producer)).toMatchObject({state:"paused"});
      expect(await restarted.hasActiveWatchLease()).toBe(false);
      expect(await restarted.stop()).toBe(true);
    }finally{remote.restore();}
    await f.state.put("codegraff:browser-watch-leases",[{owner:lease.grant.owner,producer:lease.grant.producer,generation:1,expiresAt:Date.now()-1}]);
    transport.fail("watch-status");
    expect(await f.sandbox.hasActiveWatchLease()).toBe(false);
    await expect(f.sandbox.watchConfigure({...lease,grant:{...lease.grant,owner:"another-owner"}})).rejects.toThrow("lease invalid");
    await expect(f.sandbox.watchConfigure({...lease,grant:{...lease.grant,expiresAt:Date.now()+86_401_000}})).rejects.toThrow("lease invalid");
  }finally{transport.restore();}
},30000);

test("configure arriving during idle stop prevents physical VM stop and then installs its lease",async()=>{
  const f=fixture();await f.sandbox.ensure();
  const transport=await watchTransport(f.sandbox),lease=watchLease();
  let entered!:()=>void,release!:()=>void;
  const pending=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const request=f.options.gateway.request.bind(f.options.gateway);
  let intercept=true;
  const gateway=spyOn(f.options.gateway,"request").mockImplementation(async(...args)=>{
    if(intercept&&args[0]==="/v1/sandboxes/vm-fixture"){intercept=false;entered();await hold;}
    return request(...args);
  });
  try {
    const stopping=f.sandbox.stop();await pending;
    const configuring=f.sandbox.watchConfigure(lease);release();
    expect(await stopping).toBe(false);
    expect(await configuring).toMatchObject({state:"watching"});
    expect(f.calls.some(c=>c.path.endsWith("/stop"))).toBe(false);
    expect(transport.commands.some(c=>c.endsWith(" close"))).toBe(false);
  }finally{gateway.mockRestore();transport.restore();}
});

test("a conflicting shorter replacement cannot erase the previous watch deadline",async()=>{
  const f=fixture();await f.sandbox.ensure();
  const transport=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    transport.fail("watch-configure");
    const shorter={...lease,grant:{...lease.grant,expiresAt:lease.grant.expiresAt-30_000}};
    await expect(f.sandbox.watchConfigure(shorter)).rejects.toThrow("lease conflict");
    const retained=await f.state.get<any[]>("codegraff:browser-watch-leases");
    expect(retained).toMatchObject([{generation:1,lifecycleRevision:0,expiresAt:lease.grant.expiresAt}]);
    transport.fail("watch-status");
    expect(await f.sandbox.hasActiveWatchLease()).toBe(true);
    transport.fail();
    transport.states.set(lease.grant.producer,{...transport.states.get(lease.grant.producer)!,state:"needs-attention",reason:"private-sign-in"});
    expect(await f.sandbox.watchStatus()).toMatchObject([{state:"needs-attention",reason:"private-sign-in"}]);
    expect(await f.sandbox.hasActiveWatchLease()).toBe(true);
    const requests=transport.requests.length;
    await expect(f.sandbox.watchConfigure({...lease,grant:{...lease.grant,generation:2}})).rejects.toThrow("source immutable");
    expect(transport.requests).toHaveLength(requests);
  }finally{transport.restore();}
});

test("durable watch maintenance refreshes external activity within provider idle window and stops at expiry",async()=>{
  const start=Date.now();let now=start;
  const clock=spyOn(Date,"now").mockImplementation(()=>now);
  const f=fixture();await f.sandbox.ensure();
  const first=await watchTransport(f.sandbox),lease=watchLease();lease.grant.expiresAt=start+3_600_000;
  try {
    await f.sandbox.watchConfigure(lease);
    expect(await f.sandbox.watchMaintenanceDeadline()).toBe(start+600_000);
    const restarted=new CodegraffSandbox(f.options),remote=await watchTransport(restarted);
    remote.states.set(lease.grant.producer,first.states.get(lease.grant.producer)!);
    try {
      now=start+599_000;
      expect(await restarted.maintainWatchLease()).toMatchObject({reason:"scheduled",nextAt:start+600_000});
      expect(remote.requests).toHaveLength(0);
      for(let minute=10;minute<=50;minute+=10){
        now=start+minute*60_000;
        const result=await restarted.maintainWatchLease();
        expect(result).toMatchObject({state:"watching",reason:"ready",lastConfirmedAt:now,nextAt:now+600_000});
      }
      expect(remote.requests.filter(r=>r.operation==="watch-status")).toHaveLength(5);
      expect(f.calls.some(c=>c.path.endsWith("/stop"))).toBe(false);
      expect(f.calls.find(c=>c.path==="/v1/sandboxes")?.body.autoStopMinutes).toBe(30);
      now=start+3_600_000;
      expect(await restarted.maintainWatchLease()).toMatchObject({state:"paused",reason:"expired"});
      expect(await restarted.watchMaintenanceDeadline()).toBeUndefined();
      expect(remote.requests.filter(r=>r.operation==="watch-status")).toHaveLength(5);
      expect(f.calls.filter(c=>c.path.endsWith("/stop"))).toHaveLength(0);
      // The host retains browser-retire -> VM-stop ownership after maintenance expires.
      expect(await restarted.stop()).toBe(true);
      expect(f.calls.filter(c=>c.path.endsWith("/stop"))).toHaveLength(1);
      expect(JSON.stringify(await f.state.get("codegraff:browser-watch-maintenance"))).not.toMatch(/PRIVATE_WATCH_SECRET|private.example/);
    }finally{remote.restore();}
  }finally{first.restore();clock.mockRestore();}
});

test("watch maintenance failure retains a bounded retry deadline and never claims successful readiness",async()=>{
  const start=Date.now();let now=start;
  const clock=spyOn(Date,"now").mockImplementation(()=>now);
  const f=fixture();await f.sandbox.ensure();const transport=await watchTransport(f.sandbox),lease=watchLease();
  lease.grant.expiresAt=start+1_800_000;
  try {
    await f.sandbox.watchConfigure(lease);now=start+600_000;
    transport.fail("watch-status");
    const result=await f.sandbox.maintainWatchLease();
    expect(result).toMatchObject({state:"needs-attention",reason:"watch-unavailable",nextAt:now+60_000,lastAttemptAt:now});
    expect(result.lastConfirmedAt).toBeUndefined();
    const reconstructed=new CodegraffSandbox(f.options);
    expect(await reconstructed.watchMaintenanceDeadline()).toBe(now+60_000);
    transport.fail();now+=60_000;
    expect(await f.sandbox.maintainWatchLease()).toMatchObject({state:"watching",lastConfirmedAt:now});
    transport.revoke();now+=600_000;
    expect(await f.sandbox.maintainWatchLease()).toMatchObject({state:"paused",reason:"paused"});
    expect(await f.sandbox.watchMaintenanceDeadline()).toBeUndefined();
    expect(f.calls.filter(c=>c.path.endsWith("/stop"))).toHaveLength(0);
    expect(await f.sandbox.stop()).toBe(true);
    expect(f.calls.filter(c=>c.path.endsWith("/stop"))).toHaveLength(1);
  }finally{transport.restore();clock.mockRestore();}
});

test("watch maintenance resumes the same provider VM and reports the observed interruption",async()=>{
  const start=Date.now();let now=start;
  const clock=spyOn(Date,"now").mockImplementation(()=>now);
  const f=fixture();await f.sandbox.ensure();const transport=await watchTransport(f.sandbox),lease=watchLease();
  lease.grant.expiresAt=start+1_800_000;
  try {
    await f.sandbox.watchConfigure(lease);
    await f.options.gateway.request("/v1/sandboxes/vm-fixture/stop",{});
    now=start+600_000;
    expect(await f.sandbox.maintainWatchLease()).toMatchObject({state:"needs-attention",reason:"browser-restarted",lastConfirmedAt:now,nextAt:now+600_000});
    expect(f.calls.filter(c=>c.path==="/v1/sandboxes")).toHaveLength(1);
    expect(f.calls.filter(c=>c.path.endsWith("/start"))).toHaveLength(1);
    now+=600_000;
    expect(await f.sandbox.maintainWatchLease()).toMatchObject({state:"watching",reason:"ready"});
  }finally{transport.restore();clock.mockRestore();}
});

test("owner retirement pauses resident watches without waking capture, preserving uncertain pause until bounded retry",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    const before=remote.commands.length;
    remote.fail("watch-pause");
    const unknown=await f.sandbox.revokeWatchLeases();
    expect(unknown).toMatchObject({state:"needs-attention",reason:"watch-unavailable"});
    expect(unknown.nextAt).toBeLessThanOrEqual(lease.grant.expiresAt);
    expect(await f.sandbox.hasActiveWatchLease()).toBe(true);
    remote.fail();
    const last=remote.commands.length;
    expect(await f.sandbox.revokeWatchLeases()).toMatchObject({state:"paused"});
    expect(await f.sandbox.watchMaintenanceDeadline()).toBeUndefined();
    expect(remote.commands.slice(last).some(command=>command.endsWith(" peek-health"))).toBe(true);
    expect(remote.commands.slice(last).some(command=>command.endsWith(" health"))).toBe(false);
    expect(remote.requests.slice(-1)).toMatchObject([{operation:"watch-pause"}]);
    expect(remote.commands.length).toBeGreaterThan(before);
  }finally{remote.restore();}
});

test("owner retirement never starts a stopped VM or invents a successful remote revocation",async()=>{
  const start=Date.now();let now=start;
  const clock=spyOn(Date,"now").mockImplementation(()=>now);
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    await f.options.gateway.request("/v1/sandboxes/vm-fixture/stop",{});
    const calls=remote.requests.length;
    expect(await f.sandbox.revokeWatchLeases()).toMatchObject({state:"needs-attention",nextAt:lease.grant.expiresAt});
    expect(remote.requests).toHaveLength(calls);
    expect(f.calls.some(c=>c.path.endsWith("/start"))).toBe(false);
    now=lease.grant.expiresAt;
    expect(await f.sandbox.revokeWatchLeases()).toMatchObject({state:"paused"});
    expect(await f.sandbox.watchMaintenanceDeadline()).toBeUndefined();
    expect(remote.requests).toHaveLength(calls);
  }finally{remote.restore();clock.mockRestore();}
});

test("coverage gap acknowledgement is encrypted, owner-bound and fenced by current generation/count without replay",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    const driver=await f.sandbox.browserFactory()({domains:["*"],owner:lease.grant.owner,emit:async()=>{}});
    await driver.watchConfigure!(lease);
    const gap={generation:1,missed:3,countUncertain:false,acknowledged:0,firstAt:Date.now()-100,lastAt:Date.now(),reason:"observation-backlog" as const};
    remote.states.set(lease.grant.producer,{...remote.states.get(lease.grant.producer)!,state:"needs-attention",reason:"observation-gap",excludedBefore:gap.firstAt,coverageGap:gap});
    expect(await driver.watchStatus!()).toMatchObject([{excludedBefore:gap.firstAt,coverageGap:gap}]);
    const storeBefore=JSON.stringify(await f.state.get("codegraff:browser-watch-leases"));
    const commands=remote.commands.length,requests=remote.requests.length;
    const status=await driver.watchAcknowledgeGap!(lease.grant.producer,1,3);
    expect(status).toMatchObject({state:"needs-attention",coverageGap:{...gap,acknowledged:3}});
    expect(remote.commands.slice(commands).some(command=>command.endsWith(" health"))).toBe(false);
    expect(remote.commands.slice(commands).some(command=>command.endsWith(" peek-health"))).toBe(true);
    expect(remote.requests.slice(requests)).toMatchObject([{operation:"watch-acknowledge-gap",producer:lease.grant.producer,generation:1,missed:3}]);
    expect(remote.uploads.join()).not.toMatch(/watch-acknowledge-gap|observation-backlog/);
    expect(remote.commands.join()).not.toMatch(/watch-acknowledge-gap|observation-backlog/);
    expect(JSON.stringify(await f.state.get("codegraff:browser-watch-leases"))).toBe(storeBefore);
    await expect(driver.watchAcknowledgeGap!(lease.grant.producer,2,3)).rejects.toThrow("generation stale");
    await expect(driver.watchAcknowledgeGap!(lease.grant.producer,1,2)).rejects.toThrow("Transient browser replay unavailable");
    await expect(f.sandbox.browserFactory()({domains:["*"],owner:"another-owner",emit:async()=>{}})).rejects.toThrow("owner mismatch");
    const foreign=new CodegraffSandbox({...f.options,owner:"another-owner"});
    await expect(foreign.watchAcknowledgeGap(lease.grant.producer,1,3)).rejects.toThrow("lease store invalid");
    expect(remote.states.get(lease.grant.producer)!.coverageGap).toEqual({...gap,acknowledged:3});
  }finally{remote.restore();}
});

test("coverage gap status rejects malformed counters and strips nonstructural fields",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    const original=remote.states.get(lease.grant.producer)!;
    const gap={generation:1,missed:4,countUncertain:true,acknowledged:2,firstAt:1,lastAt:2,reason:"observation-unavailable" as const};
    remote.states.set(lease.grant.producer,{...original,coverageGap:{...gap,privatePayload:"PRIVATE_LOSS_BODY"} as typeof gap});
    const status=await f.sandbox.watchStatus();
    expect(status[0]!.coverageGap).toEqual(gap);
    expect(JSON.stringify(status)).not.toContain("PRIVATE_LOSS_BODY");
    for(const invalid of [{...gap,missed:-1},{...gap,acknowledged:5},{...gap,generation:2},{...gap,lastAt:0},{...gap,countUncertain:"yes"},null,0,false]){
      remote.states.set(lease.grant.producer,{...original,coverageGap:invalid as unknown as typeof gap});
      await expect(f.sandbox.watchStatus()).rejects.toThrow("coverage gap invalid");
    }
  }finally{remote.restore();}
});

test("watch inspection and release never allocate or resume a missing VM",async()=>{
  const absent=fixture();
  await expect(absent.sandbox.watchStatus()).rejects.toThrow("runner unavailable");
  await expect(absent.sandbox.watchPause("producer-fixture")).rejects.toThrow("runner unavailable");
  expect(absent.calls).toHaveLength(0);
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    const commands=remote.commands.length;
    expect(await f.sandbox.watchStatus()).toHaveLength(1);
    expect(remote.commands.slice(commands).some(command=>command.endsWith(" peek-health"))).toBe(true);
    expect(remote.commands.slice(commands).some(command=>command.endsWith(" health"))).toBe(false);
    await f.options.gateway.request("/v1/sandboxes/vm-fixture/stop",{});
    const calls=f.calls.length,requests=remote.requests.length;
    const retained=await f.state.get("codegraff:browser-watch-leases");
    const rebuilt=new CodegraffSandbox(f.options);
    await expect(rebuilt.watchStatus()).rejects.toThrow("runner unavailable");
    await expect(rebuilt.watchPause(lease.grant.producer)).rejects.toThrow("runner unavailable");
    expect(await rebuilt.hasActiveWatchLease()).toBe(true);
    expect(await f.state.get<unknown>("codegraff:browser-watch-leases")).toEqual(retained);
    expect(remote.requests).toHaveLength(requests);
    expect(f.calls.slice(calls).every(call=>call.path==="/v1/sandboxes/vm-fixture"&&call.body===undefined)).toBe(true);
  }finally{remote.restore();}
});

test("lost gap acknowledgement reply remains uncertain without retries or erasing loss history",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    const gap={generation:1,missed:2,countUncertain:true,acknowledged:0,firstAt:1,lastAt:2,reason:"observation-unavailable" as const};
    remote.states.set(lease.grant.producer,{...remote.states.get(lease.grant.producer)!,coverageGap:gap});
    const before=remote.requests.length;remote.fail("watch-acknowledge-gap");
    await expect(f.sandbox.watchAcknowledgeGap(lease.grant.producer,1,2)).rejects.toThrow("lost_reply");
    expect(remote.requests.slice(before)).toHaveLength(1);
    expect(remote.states.get(lease.grant.producer)!.coverageGap).toEqual({...gap,acknowledged:2});
    remote.fail();
    expect((await f.sandbox.watchStatus())[0]!.coverageGap).toEqual({...gap,acknowledged:2});
    await expect(f.sandbox.watchAcknowledgeGap(lease.grant.producer,1,-1)).rejects.toThrow("acknowledgement invalid");
    await f.options.gateway.request("/v1/sandboxes/vm-fixture/stop",{});
    const stopped=remote.requests.length;
    await expect(f.sandbox.watchAcknowledgeGap(lease.grant.producer,1,2)).rejects.toThrow("runner unavailable");
    expect(remote.requests).toHaveLength(stopped);
    expect(f.calls.some(call=>call.path.endsWith("/start"))).toBe(false);
  }finally{remote.restore();}
});

test("encrypted resume writeahead survives reconstruction and rejects delayed old pause and configure",async()=>{
  const f=fixture();await f.sandbox.ensure();
  const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    remote.states.set(lease.grant.producer,{...remote.states.get(lease.grant.producer)!,acknowledged:4});
    const paused=await f.sandbox.watchPause(lease.grant.producer);
    expect(paused).toMatchObject({lifecycleRevision:0,pausedThrough:4,state:"paused"});
    const resumed={...lease,lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:4}};
    remote.fail("watch-configure");
    await expect(f.sandbox.watchConfigure(resumed)).rejects.toThrow("lost_reply");
    expect(await f.state.get("codegraff:browser-watch-leases")).toMatchObject([{lifecycleRevision:1,generation:1}]);
    expect(remote.requests.slice(-1)).toMatchObject([{operation:"watch-configure",lease:{lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:4}}}]);
    const rebuilt=new CodegraffSandbox(f.options),restored=await watchTransport(rebuilt);
    restored.states.set(lease.grant.producer,remote.states.get(lease.grant.producer)!);
    try {
      const driver=await rebuilt.browserFactory()({domains:["*"],owner:lease.grant.owner,emit:async()=>{}});
      await expect(driver.watchPause!(lease.grant.producer)).rejects.toThrow("lifecycle stale");
      await expect(rebuilt.watchConfigure(lease)).rejects.toThrow("lifecycle stale");
      expect(restored.requests).toHaveLength(0);
      // An old paused status cannot release a newer retained incarnation.
      restored.reply((output,request)=>request.operation==="watch-status" ? output.map((status:any)=>({...status,lifecycleRevision:0,state:"paused",pausedThrough:4})) : output);
      expect(await rebuilt.hasActiveWatchLease()).toBe(true);
      restored.reply(output=>output);
      expect(await driver.watchPause!(lease.grant.producer,undefined,1)).toMatchObject({lifecycleRevision:1,state:"paused",pausedThrough:0});
      expect(restored.requests.at(-1)).toMatchObject({operation:"watch-pause",lifecycleRevision:1});
      expect(await rebuilt.hasActiveWatchLease()).toBe(false);
      expect(restored.uploads.join()+restored.commands.join()).not.toMatch(/lifecycleRevision|resumeFrom|pausedThrough|PRIVATE_WATCH_SECRET/);
    }finally{restored.restore();}
  }finally{remote.restore();}
});

test("legacy and mismatched pause replies never attest a safe release, while owner revoke sends retained revision",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    remote.reply((output,request)=>{
      const legacy=(status:any)=>{const {lifecycleRevision,pausedThrough,...rest}=status;return rest;};
      return request.operation==="watch-status" ? output.map(legacy) : legacy(output);
    });
    await expect(f.sandbox.watchPause(lease.grant.producer)).rejects.toThrow("pause unconfirmed");
    expect(await f.sandbox.watchStatus()).toMatchObject([{state:"paused"}]);
    expect(await f.sandbox.hasActiveWatchLease()).toBe(true);
    expect(await f.sandbox.revokeWatchLeases()).toMatchObject({state:"needs-attention"});
    remote.reply(output=>output);
    const proof=await f.sandbox.watchPause(lease.grant.producer);
    await f.sandbox.watchConfigure({...lease,lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:proof.pausedThrough!}});
    remote.reply((output,request)=>request.operation==="watch-pause" ? {...output,lifecycleRevision:0} : output);
    expect(await f.sandbox.revokeWatchLeases()).toMatchObject({state:"needs-attention"});
    expect(await f.state.get("codegraff:browser-watch-leases")).toMatchObject([{lifecycleRevision:1}]);
    expect(remote.requests.at(-1)).toMatchObject({operation:"watch-pause",lifecycleRevision:1});
    remote.reply(output=>output);
    expect(await f.sandbox.revokeWatchLeases()).toMatchObject({state:"paused"});
  }finally{remote.restore();}
});

test("private lifecycle metadata rejects unsafe counters and configure cannot confirm another incarnation",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);
    const original=remote.states.get(lease.grant.producer)!;
    for(const invalid of [{lifecycleRevision:-1},{lifecycleRevision:0.5},{lifecycleRevision:Number.POSITIVE_INFINITY},
      {state:"paused",lifecycleRevision:0,pausedThrough:-1},{state:"paused",lifecycleRevision:0,pausedThrough:1.5},
      {state:"paused",lifecycleRevision:0,pausedThrough:Number.MAX_SAFE_INTEGER+1},
      {state:"paused",lifecycleRevision:undefined,pausedThrough:0},{pausedThrough:0}]){
      remote.states.set(lease.grant.producer,{...original,...invalid} as typeof original);
      await expect(f.sandbox.watchStatus()).rejects.toThrow("lifecycle status invalid");
    }
    remote.states.set(lease.grant.producer,original);
    remote.reply(output=>({...output,lifecycleRevision:1}));
    await expect(f.sandbox.watchConfigure(lease)).rejects.toThrow("configure unconfirmed");
    expect(await f.state.get("codegraff:browser-watch-leases")).toMatchObject([{lifecycleRevision:0}]);
    const requests=remote.requests.length;
    await expect(f.sandbox.watchConfigure({...lease,lifecycleRevision:-1})).rejects.toThrow("lifecycle invalid");
    await expect(f.sandbox.watchConfigure({...lease,lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:-1}})).rejects.toThrow("lifecycle invalid");
    await expect(f.sandbox.watchPause(lease.grant.producer,undefined,Number.POSITIVE_INFINITY)).rejects.toThrow("lifecycle invalid");
    expect(remote.requests).toHaveLength(requests);
  }finally{remote.restore();}
});

async function guardedTransport() {
  const {replayKeys,unwrapReplay,sealReplay}=await import("../src/codegraff.ts");
  const {sandboxDigest}=await import("../src/sandbox-job.ts");
  const f=fixture(),keys=replayKeys(),uploads:string[]=[],commands:string[]=[],requests:any[]=[];
  const artifact:any={kind:"network",actionId:"write",graph:{schemaVersion:2,executorAbi:"site-harness/1",siteId:"fixture",version:"1",
    sourceCaptureDigest:await sandboxDigest("fixture"),allowedOrigins:["https://private.example"],actions:[{id:"write",inputs:[],steps:[{id:"send",dependsOn:[],
      method:"POST",origin:"https://private.example",path:"/tasks",pathParameters:{},query:{},headers:{},expectedStatuses:[200]}]}]}};
  const job:import("../src/sandbox-job.ts").SandboxJob={version:1,operationId:crypto.randomUUID(),owner:f.options.owner,contextRef:"context",authorityRef:"authority",
    artifact,harnessDigest:await sandboxDigest(artifact),dependencyLock:{},dependencyLockDigest:await sandboxDigest({}),environmentDigest:await sandboxDigest("runtime"),input:{},
    dispatch:{protocol:"host-request/v1"},authority:{origins:["https://private.example"],methods:["POST"]},budget:{wallMs:5000,requests:2,outputBytes:32768}};
  const prepared={url:"https://private.example/tasks",method:"POST",address:"93.184.216.34",headers:{"content-type":"application/json"},body:'{"text":"PRIVATE_REQUEST_BODY"}'};
  const challenge=async():Promise<import("../src/sandbox-dispatch.ts").SandboxDispatchChallenge>=>({status:"awaiting-dispatch",protocol:"host-request/v1",owner:job.owner,
    operationId:job.operationId,jobDigest:await sandboxDigest(job),requestDigest:await sandboxDigest(prepared),stepId:"send",attempt:1,
    nonce:crypto.randomUUID(),expiresAt:Date.now()+job.budget.wallMs-50,prepared:structuredClone(prepared)});
  const receipt=async(status:"completed"|"failed"="completed"):Promise<import("../src/sandbox-dispatch.ts").SandboxDispatchReply>=>({status:"receipt",receipt:{operationId:job.operationId,
    jobDigest:await sandboxDigest(job),harnessDigest:job.harnessDigest,environmentDigest:job.environmentDigest,status,requests:1,browserStarts:0,
    ...(status==="completed"?{output:{ok:true},outputDigest:await sandboxDigest({ok:true})}:{reason:"sandbox_execution_failed"})}});
  let respond:(request:any)=>Promise<unknown>=async request=>request.operation==="guarded-start"?challenge():receipt();
  const ensure=spyOn(f.sandbox,"ensure").mockResolvedValue("vm-fixture");
  const upload=spyOn(f.sandbox,"upload").mockImplementation(async(_id,_path,bytes)=>{uploads.push(bytes);});
  const exec=spyOn(f.sandbox,"exec").mockImplementation(async(_id,command)=>{
    commands.push(command);
    if(command.endsWith(" health"))return JSON.stringify({replayPublicKey:keys.publicKey});
    if(command.includes(" runner.js cancel "))return '{"settled":true}';
    const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);requests.push(value);
    return JSON.stringify(sealReplay({output:await respond(value)},key));
  });
  return {...f,job,challenge,receipt,uploads,commands,requests,respond:(next:typeof respond)=>{respond=next;},restore:()=>{ensure.mockRestore();upload.mockRestore();exec.mockRestore();}};
}

test("guarded sandbox waits for host authority while busy, encrypts prepared bytes, and isolates callback mutation",async()=>{
  const f=await guardedTransport();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  let expected:import("../src/sandbox-dispatch.ts").SandboxDispatchChallenge|undefined;
  f.respond(async request=>{if(request.operation==="guarded-start")return expected=await f.challenge();return f.receipt();});
  try {
    const running=f.sandbox.harnessGuardedJob(f.job,async challenge=>{
      expect(f.sandbox.busy).toBe(true);entered();await gate;
      challenge.nonce="mutated";challenge.requestDigest="sha256:mutated";challenge.prepared.body="mutated";return true;
    });
    await ready;expect(await f.sandbox.stop()).toBe(false);
    expect(f.requests.map(value=>value.operation)).toEqual(["guarded-start"]);
    release();expect((await running).status).toBe("completed");expect(f.sandbox.busy).toBe(false);
    expect(f.requests[1].input).toEqual({owner:f.job.owner,operationId:f.job.operationId,jobDigest:expected!.jobDigest,
      requestDigest:expected!.requestDigest,nonce:expected!.nonce,allow:true});
    expect(f.uploads.join()+f.commands.join()).not.toMatch(/PRIVATE_REQUEST_BODY|private.example|guarded-start|guarded-continue/);
  } finally {release?.();f.restore();}
});

test("guarded retained receipts do not request host permission; refusal sends only a denial",async()=>{
  const f=await guardedTransport();let callbacks=0;
  try {
    f.respond(async()=>f.receipt());
    expect((await f.sandbox.harnessGuardedJob(f.job,()=>{callbacks++;return true;})).status).toBe("completed");
    expect(callbacks).toBe(0);expect(f.requests).toHaveLength(1);
    f.respond(async request=>request.operation==="guarded-start"?f.challenge():f.receipt("failed"));
    expect((await f.sandbox.harnessGuardedJob(f.job,()=>{callbacks++;return false;})).status).toBe("failed");
    expect(callbacks).toBe(1);expect(f.requests.filter(value=>value.operation==="guarded-continue").map(value=>value.input.allow)).toEqual([false]);
  } finally {f.restore();}
});

test("guarded transport rejects malformed or expired challenges before calling host authority",async()=>{
  const f=await guardedTransport();let callbacks=0;
  const corruptions=[{owner:"other"},{operationId:"other"},{jobDigest:"sha256:bad"},{requestDigest:"sha256:bad"},{nonce:"bad"},{expiresAt:0},
    {expiresAt:Number.MAX_SAFE_INTEGER},{stepId:"absent"},{attempt:0},{attempt:100},{prepared:null}];
  try {
    for(const change of corruptions){
      f.respond(async()=>({...await f.challenge(),...change}));
      await expect(f.sandbox.harnessGuardedJob(f.job,()=>{callbacks++;return true;})).rejects.toThrow("Sandbox dispatch");
    }
    expect(callbacks).toBe(0);expect(f.requests.every(value=>value.operation==="guarded-start")).toBe(true);expect(f.sandbox.busy).toBe(false);
  } finally {f.restore();}
});

test("guarded continuation loss is not retried and receipt recovery never authorizes another send",async()=>{
  const f=await guardedTransport();let callbacks=0;
  try {
    f.respond(async request=>{if(request.operation==="guarded-start")return f.challenge();throw Error("lost_after_continuation");});
    await expect(f.sandbox.harnessGuardedJob(f.job,()=>{callbacks++;return true;})).rejects.toThrow("lost_after_continuation");
    expect(f.requests.map(value=>value.operation)).toEqual(["guarded-start","guarded-continue"]);expect(callbacks).toBe(1);expect(f.sandbox.busy).toBe(false);
    f.respond(async()=>{const result=await f.receipt();return result.status==="receipt"?result.receipt:undefined;});
    expect((await f.sandbox.harnessReceipt(f.job)).status).toBe("completed");
    expect(callbacks).toBe(1);expect(f.requests.at(-1).operation).toBe("harness-receipt");
  } finally {f.restore();}
});

test("guarded callback cancellation sends no continuation and releases the whole-operation idle fence",async()=>{
  const f=await guardedTransport(),controller=new AbortController();let entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  try {
    const running=f.sandbox.harnessGuardedJob(f.job,()=>{entered();return new Promise<boolean>(()=>{});},controller.signal);
    await ready;expect(f.sandbox.busy).toBe(true);controller.abort(Error("host_cancelled"));
    await expect(running).rejects.toThrow("host_cancelled");expect(f.sandbox.busy).toBe(false);
    expect(f.requests.map(value=>value.operation)).toEqual(["guarded-start"]);
  } finally {f.restore();}
});

test("guarded multi-request jobs preserve one deadline and reject a reused nonce before a second authorization",async()=>{
  const f=await guardedTransport();let callbacks=0;
  try {
    for(const mutation of ["nonce","deadline","valid"]){
      let original:import("../src/sandbox-dispatch.ts").SandboxDispatchChallenge|undefined,continues=0;
      f.respond(async request=>{
        if(request.operation==="guarded-start")return original=await f.challenge();
        if(++continues===2)return f.receipt();
        return {...original!,nonce:mutation==="nonce"?original!.nonce:crypto.randomUUID(),expiresAt:original!.expiresAt+(mutation==="deadline"?1:0)};
      });
      const before=callbacks;
      const run=f.sandbox.harnessGuardedJob(f.job,()=>{callbacks++;return true;});
      if(mutation==="valid"){expect((await run).status).toBe("completed");expect(callbacks-before).toBe(2);}
      else {await expect(run).rejects.toThrow("challenge mismatch");expect(callbacks-before).toBe(1);}
    }
  } finally {f.restore();}
});

test("guarded host decisions arriving after the private deadline never release a request",async()=>{
  const f=await guardedTransport();let callbacks=0;
  f.respond(async()=>({...await f.challenge(),expiresAt:Date.now()+250}));
  try {
    await expect(f.sandbox.harnessGuardedJob(f.job,async()=>{
      callbacks++;await new Promise(resolve=>setTimeout(resolve,300));return true;
    })).rejects.toThrow("expired");
    expect(callbacks).toBe(1);expect(f.requests.map(value=>value.operation)).toEqual(["guarded-start"]);
    expect(f.sandbox.busy).toBe(false);
  } finally {f.restore();}
});

test("restore holds survive encrypted status reconstruction without waking the VM or clearing authority",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  const restore={challenge:crypto.randomUUID(),at:Date.now(),queue:{head:8,acknowledged:3,offered:6}};
  try {
    await f.sandbox.watchConfigure(lease);
    const held={...remote.states.get(lease.grant.producer)!,state:"needs-attention" as const,reason:"restore-authorization-required",restore};
    remote.states.set(lease.grant.producer,held);
    const requests=remote.requests.length,commands=remote.commands.length,calls=f.calls.length;
    expect(await f.sandbox.watchStatus()).toEqual([held]);
    expect(remote.requests.slice(requests).map(value=>value.operation)).toEqual(["watch-status"]);
    expect(remote.commands.slice(commands).some(command=>command.endsWith(" peek-health"))).toBe(true);
    expect(remote.commands.slice(commands).some(command=>command.endsWith(" health"))).toBe(false);
    expect(f.calls.slice(calls).every(call=>call.path==="/v1/sandboxes/vm-fixture"&&call.body===undefined)).toBe(true);
    const rebuilt=new CodegraffSandbox(f.options),transport=await watchTransport(rebuilt);
    transport.states.set(lease.grant.producer,held);
    try {
      expect((await rebuilt.watchStatus())[0]!.restore).toEqual(restore);
      expect(await rebuilt.hasActiveWatchLease()).toBe(true);
      expect(transport.requests.every(value=>value.operation==="watch-status")).toBe(true);
      await f.options.gateway.request("/v1/sandboxes/vm-fixture/stop",{});
      const before=transport.requests.length,provider=f.calls.length;
      await expect(rebuilt.watchStatus()).rejects.toThrow("runner unavailable");
      expect(transport.requests).toHaveLength(before);
      expect(f.calls.slice(provider).every(call=>call.path==="/v1/sandboxes/vm-fixture"&&call.body===undefined)).toBe(true);
    }finally{transport.restore();}
    expect(remote.uploads.join()+remote.commands.join()).not.toContain(restore.challenge);
    expect(await f.state.get("codegraff:browser-watch-leases")).toMatchObject([{producer:lease.grant.producer,generation:1,lifecycleRevision:0}]);
  }finally{remote.restore();}
},30000);

test("restore metadata validates exact challenge and ordered queue cursors, including explicit paused holds",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try {
    await f.sandbox.watchConfigure(lease);const original=remote.states.get(lease.grant.producer)!;
    const restore={challenge:crypto.randomUUID(),at:Date.now(),queue:{head:8,acknowledged:3,offered:6}};
    const held={...original,state:"needs-attention" as const,reason:"restore-authorization-required",restore};
    remote.states.set(lease.grant.producer,held);
    expect((await f.sandbox.watchStatus())[0]!.restore).toEqual(restore);
    remote.states.set(lease.grant.producer,{...held,state:"paused",reason:"paused",pausedThrough:8});
    expect((await f.sandbox.watchStatus())[0]).toMatchObject({state:"paused",pausedThrough:8,restore});
    remote.states.set(lease.grant.producer,{...held,restore:{challenge:restore.challenge,at:restore.at}});
    expect((await f.sandbox.watchStatus())[0]!.restore).toEqual({challenge:restore.challenge,at:restore.at});
    for(const invalid of [null,[],false,{...restore,challenge:"-".repeat(36)},{...restore,challenge:restore.challenge.toUpperCase()},
      {...restore,at:0},{...restore,at:-1},{...restore,at:1.1},{...restore,at:Number.MAX_SAFE_INTEGER+1},{...restore,payload:"PRIVATE_RESTORE_PAYLOAD"}]){
      remote.states.set(lease.grant.producer,{...held,restore:invalid as typeof restore});
      await expect(f.sandbox.watchStatus()).rejects.toThrow("restore status invalid");
    }
    for(const queue of [null,[],false,{head:8,acknowledged:-1,offered:6},{head:8,acknowledged:7,offered:6},
      {head:5,acknowledged:3,offered:6},{head:8.5,acknowledged:3,offered:6},{head:Number.MAX_SAFE_INTEGER+1,acknowledged:3,offered:6},
      {head:8,acknowledged:3},{head:8,acknowledged:3,offered:6,payload:"PRIVATE_QUEUE_PAYLOAD"}]){
      remote.states.set(lease.grant.producer,{...held,restore:{...restore,queue:queue as typeof restore.queue}});
      await expect(f.sandbox.watchStatus()).rejects.toThrow("restore queue invalid");
    }
    for(const state of ["watching","catching-up"] as const){
      remote.states.set(lease.grant.producer,{...held,state});await expect(f.sandbox.watchStatus()).rejects.toThrow("restore status invalid");
    }
    remote.states.set(lease.grant.producer,{...held,reason:"recording"});await expect(f.sandbox.watchStatus()).rejects.toThrow("restore status invalid");
  }finally{remote.restore();}
},30000);

test("restore holds do not bypass exact producer generation or lifecycle confirmation",async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  const restore={challenge:crypto.randomUUID(),at:Date.now(),queue:{head:0,acknowledged:0,offered:0}};
  try {
    await f.sandbox.watchConfigure(lease);
    for(const change of [{producer:"another-producer"},{generation:2},{lifecycleRevision:1},{leaseRevision:1}]){
      remote.reply((output,request)=>request.operation==="watch-configure"?{...output,...change,state:"needs-attention",reason:"restore-authorization-required",restore}:output);
      await expect(f.sandbox.watchConfigure(lease)).rejects.toThrow("configure unconfirmed");
    }
    remote.reply((output,request)=>request.operation==="watch-configure"?{...output,state:"needs-attention",reason:"restore-authorization-required",restore}:output);
    expect((await f.sandbox.watchConfigure(lease)).restore).toEqual(restore);
    expect(remote.requests.every(value=>["watch-configure"].includes(value.operation))).toBe(true);
  }finally{remote.restore();}
},30000);

function restoreProofFor(lease:ReturnType<typeof watchLease>):import('../src/browser-watch-restore.ts').BrowserWatchRestoreProof {
  const g=lease.grant;
  return {owner:g.owner,producer:g.producer,profile:g.profile,epoch:g.epoch,generation:g.generation,connectionId:g.connectionId,
    connectionRevision:g.connectionRevision,lifecycleRevision:lease.lifecycleRevision??0,leaseRevision:lease.leaseRevision??0,
    ...(g.deliveryEpoch?{deliveryEpoch:g.deliveryEpoch}:{}),expiresAt:g.expiresAt,challenge:crypto.randomUUID(),at:Date.now(),
    queue:{head:8,acknowledged:3,offered:6},hostThrough:5,
    prefixDigest:browserWatchRestorePrefixDigest(g,Array.from({length:5},(_,index)=>[index+1,String(index+1).repeat(64)] as const))};
}
function restoreRequestFor(proof:ReturnType<typeof restoreProofFor>):import('../src/browser-watch-restore.ts').BrowserWatchReauthorizeRequest {
  const {deliveryEpoch,...scope}=proof;return {...scope,previousDeliveryEpoch:deliveryEpoch??null,deliveryEpoch:crypto.randomUUID()};
}

test('restore proof is an exact passive encrypted read with no source identity drift or private extras',async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try{
    await f.sandbox.watchConfigure(lease);const proof=restoreProofFor(lease);
    const before=JSON.stringify(await f.state.get('codegraff:browser-watch-configurations'));
    remote.reply((output,request)=>request.operation==='watch-restore-proof'?proof:output);
    expect(await f.sandbox.watchRestoreProof(proof.producer,proof.challenge,proof.hostThrough)).toEqual(proof);
    expect(JSON.stringify(await f.state.get('codegraff:browser-watch-configurations'))).toBe(before);
    for(const patch of [{owner:'foreign'},{profile:'foreign'},{epoch:'foreign'},{producer:'foreign'},{generation:2},
      {connectionId:'foreign'},{connectionRevision:'foreign'},{lifecycleRevision:1},{leaseRevision:1},{deliveryEpoch:'other'},
      {expiresAt:proof.expiresAt+1},{challenge:crypto.randomUUID()},{hostThrough:4},{privatePayload:'PRIVATE_RESTORE'},
      {queue:{head:8,acknowledged:7,offered:6}},{prefixDigest:'bad'},{prefixDigest:`sha256:${proof.prefixDigest}`},
      {prefixDigest:proof.prefixDigest.toUpperCase()},{at:0}]){
      remote.reply((output,request)=>request.operation==='watch-restore-proof'?{...proof,...patch}:output);
      await expect(f.sandbox.watchRestoreProof(proof.producer,proof.challenge,proof.hostThrough)).rejects.toThrow('Browser watch restore proof');
    }
    const count=remote.requests.length;
    await expect(f.sandbox.watchRestoreProof(proof.producer,'invalid',5)).rejects.toThrow('request invalid');
    await expect(f.sandbox.watchRestoreProof(proof.producer,proof.challenge,-1)).rejects.toThrow('request invalid');
    expect(remote.requests).toHaveLength(count);
    await f.options.gateway.request('/v1/sandboxes/vm-fixture/stop',{});const calls=f.calls.length;
    await expect(f.sandbox.watchRestoreProof(proof.producer,proof.challenge,5)).rejects.toThrow('runner unavailable');
    expect(remote.requests).toHaveLength(count);
    expect(f.calls.slice(calls).every(call=>call.path==='/v1/sandboxes/vm-fixture'&&call.body===undefined)).toBe(true);
    expect(remote.uploads.join()+remote.commands.join()).not.toContain(proof.challenge);
  }finally{remote.restore();}
},30000);

test('restore reauthorization retains exact request across lost acknowledgement and reconstruction, fencing stale delivery epoch',async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try{
    await f.sandbox.watchConfigure(lease);const proof=restoreProofFor(lease),request=restoreRequestFor(proof);
    remote.states.set(proof.producer,{...remote.states.get(proof.producer)!,state:'needs-attention',reason:'restore-authorization-required',
      restore:{challenge:proof.challenge,at:proof.at,queue:proof.queue}});
    remote.fail('watch-reauthorize');
    await expect(f.sandbox.watchReauthorize(proof.producer,request)).rejects.toThrow('lost_reply');
    const pending=await f.state.get<any[]>('codegraff:browser-watch-configurations');
    expect(pending![0].deliveryEpoch).toBeUndefined();
    expect(pending![0].restorePending.deliveryEpoch).toBe(request.deliveryEpoch);
    expect(JSON.stringify(pending)).not.toContain(lease.grant.secret);
    expect(JSON.stringify(pending)).not.toContain(proof.challenge);
    const rebuilt=new CodegraffSandbox(f.options),restored=await watchTransport(rebuilt);
    restored.states.set(proof.producer,remote.states.get(proof.producer)!);
    try{
      await expect(rebuilt.watchConfigure(lease)).rejects.toThrow('restore unresolved');
      await expect(rebuilt.watchReauthorize(proof.producer,{...request,deliveryEpoch:crypto.randomUUID()})).rejects.toThrow('request conflict');
      await expect(rebuilt.watchReauthorize(proof.producer,{...request,prefixDigest:'b'.repeat(64)})).rejects.toThrow('request conflict');
      expect(restored.requests).toHaveLength(0);
      expect((await rebuilt.watchReauthorize(proof.producer,request)).deliveryEpoch).toBe(request.deliveryEpoch);
      expect((await f.state.get<any[]>('codegraff:browser-watch-configurations'))![0]).toMatchObject({deliveryEpoch:request.deliveryEpoch});
      await expect(rebuilt.watchConfigure(lease)).rejects.toThrow('delivery epoch stale');
      const updated={...lease,grant:{...lease.grant,deliveryEpoch:request.deliveryEpoch}};
      expect((await rebuilt.watchConfigure(updated)).deliveryEpoch).toBe(request.deliveryEpoch);
      const renewed=renewedWatchLease(updated);
      expect((await rebuilt.watchConfigure(renewed)).leaseRevision).toBe(1);
      expect((await rebuilt.watchPause(proof.producer,undefined,0)).state).toBe('paused');
      expect(restored.requests.filter(r=>r.operation==='watch-reauthorize')).toHaveLength(1);
      expect(restored.uploads.join()+restored.commands.join()).not.toContain(request.deliveryEpoch);
    }finally{restored.restore();}
  }finally{remote.restore();}
},30000);

test('restore control rejects mismatched scopes and malformed replies without promoting authority',async()=>{
  const f=fixture();await f.sandbox.ensure();const remote=await watchTransport(f.sandbox),lease=watchLease();
  try{
    await f.sandbox.watchConfigure(lease);const proof=restoreProofFor(lease),request=restoreRequestFor(proof);
    for(const patch of [{owner:'foreign'},{profile:'foreign'},{epoch:'foreign'},{generation:2},{connectionId:'foreign'},
      {connectionRevision:'foreign'},{lifecycleRevision:1},{leaseRevision:1},{expiresAt:proof.expiresAt+1},
      {previousDeliveryEpoch:'foreign'},{deliveryEpoch:''},{deliveryEpoch:null},{previousDeliveryEpoch:undefined},
      {prefixDigest:'bad'},{queue:{head:1,acknowledged:0,offered:2}},{payload:'PRIVATE_RESTORE'}]){
      await expect(f.sandbox.watchReauthorize(proof.producer,{...request,...patch} as typeof request)).rejects.toThrow('Browser watch restore');
    }
    expect(remote.requests.map(r=>r.operation)).toEqual(['watch-configure']);
    for(const patch of [{generation:2},{lifecycleRevision:1},{leaseRevision:1},{deliveryEpoch:'wrong'},
      {expiresAt:proof.expiresAt+1},{acknowledged:4},{acknowledged:-1},{acknowledged:undefined},
      {state:'needs-attention',reason:'restore-authorization-required',restore:{challenge:proof.challenge,at:proof.at,queue:proof.queue}}]){
      remote.reply((output,req)=>req.operation==='watch-reauthorize'?{...output,...patch}:output);
      await expect(f.sandbox.watchReauthorize(proof.producer,request)).rejects.toThrow('reauthorization unconfirmed');
      expect((await f.state.get<any[]>('codegraff:browser-watch-configurations'))![0].deliveryEpoch).toBeUndefined();
    }
    remote.reply((output,req)=>req.operation==='watch-reauthorize'?{...output,acknowledged:8}:output);
    expect((await f.sandbox.watchReauthorize(proof.producer,request)).acknowledged).toBe(8);
    expect((await f.sandbox.watchReauthorize(proof.producer,request)).deliveryEpoch).toBe(request.deliveryEpoch);
    const count=remote.requests.length;
    await expect(f.sandbox.watchReauthorize(proof.producer,{...request,challenge:crypto.randomUUID()})).rejects.toThrow('request conflict');
    expect(remote.requests).toHaveLength(count);
  }finally{remote.restore();}
},30000);

for(const restartFails of [false,true])test(`explicit VM restore reopens held runner without republishing when startup ${restartFails?'fails':'succeeds'}`,async()=>{
  const {replayKeys,unwrapReplay,sealReplay}=await import('../src/codegraff.ts');
  const f=fixture();await f.sandbox.ensure();const keys=replayKeys(),commands:string[]=[],uploads:string[]=[],requests:any[]=[];
  const lease=watchLease(),proof=restoreProofFor(lease);let running=true,published=0,restoreHealth=0;
  const held={producer:proof.producer,generation:1,lifecycleRevision:0,leaseRevision:0,expiresAt:lease.grant.expiresAt,
    state:'needs-attention' as const,reason:'restore-authorization-required',restore:{challenge:proof.challenge,at:proof.at,queue:proof.queue}};
  const upload=spyOn(f.sandbox,'upload').mockImplementation(async(_id,_path,text)=>{uploads.push(text);});
  const exec=spyOn(f.sandbox,'exec').mockImplementation(async(id,command)=>{
    expect(id).toBe('vm-fixture');commands.push(command);
    if(command.endsWith(' close')){running=false;return '{"closed":true}';}
    if(command.includes(' runner.js restore ')){expect(running).toBe(false);published++;return '{"restored":true}';}
    if(command.endsWith(' health')){
      if(published){restoreHealth++;if(restartFails)throw Error('controlled startup failure');}
      running=true;return JSON.stringify({replayPublicKey:keys.publicKey});
    }
    if(command.endsWith(' peek-health')){if(!running)throw Error('runner unavailable');return JSON.stringify({replayPublicKey:keys.publicKey});}
    const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);requests.push(value);
    if(value.operation==='backup')return JSON.stringify(sealReplay({output:{verified:true,paused:true,written:true}},key));
    if(value.operation==='watch-status')return JSON.stringify(sealReplay({output:[held]},key));
    throw Error('unexpected fixture operation');
  });
  try{
    const provider=f.calls.length;
    expect(await f.sandbox.restore(async sink=>{
      expect(f.sandbox.busy).toBe(true);
      await sink.write('owner.json',0,new Uint8Array([1]));
      await sink.commit({version:1,id:crypto.randomUUID(),at:Date.now(),owner:lease.grant.owner,files:[]});
      return {restored:true};
    },[])).toEqual({restored:true});
    expect(published).toBe(1);expect(restoreHealth).toBe(1);expect(f.sandbox.busy).toBe(false);
    const calls=commands.length;
    if(restartFails){
      await expect(f.sandbox.watchStatus()).rejects.toThrow('runner unavailable');
      expect(await f.state.get('codegraff:browser-watch-maintenance')).toMatchObject({state:'needs-attention',reason:'watch-unavailable'});
    }else expect(await f.sandbox.watchStatus()).toEqual([held]);
    expect(commands.slice(calls).some(c=>c.endsWith(' health'))).toBe(false);
    expect(restoreHealth).toBe(1);expect(published).toBe(1);
    expect(f.calls.slice(provider).every(call=>call.path==='/v1/sandboxes/vm-fixture'&&call.body===undefined)).toBe(true);
    expect(requests.every(request=>['backup','watch-status'].includes(request.operation))).toBe(true);
    expect(uploads.join()+commands.join()).not.toContain(proof.challenge);
  }finally{upload.mockRestore();exec.mockRestore();}
},30000);
