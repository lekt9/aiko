import { expect, test } from "bun:test";
import { Codegraff } from "../src/codegraff.ts";
import {
  CodegraffComputeHarness,
  dispatchHarnessSandbox,
} from "../src/compute-harness.ts";
import {
  sandboxArtifactDependencies,
  sandboxDigest,
  verifySandboxReceipt,
  type SandboxJob,
} from "../src/sandbox-job.ts";
import type { WorkflowKV } from "../src/workflow-host.ts";
async function fixture() {
  const rows = new Map<string, unknown>(),
    files = new Map<string, string>();
  const kv: WorkflowKV = {
    get: async (k) => structuredClone(rows.get(k)),
    put: async (k, v) => {
      rows.set(k, structuredClone(v));
    },
    claim: async (k, v) => {
      if (rows.has(k)) return false;
      rows.set(k, structuredClone(v));
      return true;
    },
    update: async (k, fn) => {
      rows.set(k, fn(rows.get(k)));
    },
    list: async (prefix) =>
      [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
  };
  const config = {
    runnerBundle: "trusted fixture bundle",
    runtimeLockDigest: await sandboxDigest("python-runtime"),
    environmentDigest: await sandboxDigest("compute-runtime"),
  };
  let launches = 0,
    loseAck = false,
    omitOutput = false,
    corrupt = false, omitResources = false;
  const gateway = new Codegraff("private-control-key", async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/v1/sandboxes")
      return Response.json({ id: "isolated-compute" });
    if (path.endsWith("/upload")) {
      files.set(
        body.path,
        Buffer.from(body.contentBase64, "base64").toString(),
      );
      return Response.json({});
    }
    if (path.endsWith("/download")) {
      const value = files.get(body.path);
      return value === undefined
        ? new Response("", { status: 404 })
        : Response.json({
            contentBase64: Buffer.from(value).toString("base64"),
          });
    }
    if (path.endsWith("/exec") && body.command.startsWith("bash /tmp/aiko-compute-cloak-")) return Response.json({execId:"cloak-setup"});
    if (path.includes("/exec/cloak-setup")) return Response.json({state:"completed",exitCode:0});
    if (path.endsWith("/exec")) {
      const args = body.command.split(" ");
      expect(body.async).toBe(true);
      if (args[2] === "environment") files.set(args[3], JSON.stringify(config));
      else {
        launches++;
        const job = JSON.parse(files.get(args[3])!) as SandboxJob;
        const output = { text: "x".repeat(80000) };
        const receipt = {
          operationId: job.operationId,
          jobDigest: await sandboxDigest(job),
          harnessDigest: job.harnessDigest,
          environmentDigest: job.environmentDigest,
          status: "completed",
          requests: 0,
          browserStarts: 0,
          output,
          outputDigest: await sandboxDigest(output),
          resources: {version:1,backend:"cgroup-v2",memoryPeakBytes:1024,cpuUsec:100,processPeak:1,memoryLimitBytes:job.budget.memoryBytes??536870912,processLimit:job.budget.processes??32,scratchLimitBytes:job.budget.scratchBytes??67108864,oomKills:0,processLimitHits:0,cleaned:true},
        };
        if (omitResources) delete (receipt as {resources?:unknown}).resources;
        if (corrupt) receipt.outputDigest = await sandboxDigest("wrong");
        if (!omitOutput) files.set(args[4], JSON.stringify(receipt));
        if (loseAck) throw Error("lost provider acknowledgement");
      }
      return Response.json({ execId: `exec-${launches}` });
    }
    if (path.includes("/exec/"))
      return Response.json({
        state: "completed",
        exitCode: 0,
        output: "not the retained output",
      });
    return Response.json({ state: "running" });
  });
  const client = () => new CodegraffComputeHarness("123", gateway, kv, config);
  const artifact = {
    kind: "python" as const,
    entry: "main.py",
    modules: {
      "main.py": {
        source: "def run(value): return value",
        digest: await sandboxDigest("def run(value): return value"),
      },
    },
    runtimeLockDigest: config.runtimeLockDigest,
  };
  const lock = sandboxArtifactDependencies(artifact);
  const job: SandboxJob = {
    version: 1,
    owner: "123",
    operationId: "native-compute-1",
    contextRef: "context",
    authorityRef: "pure",
    artifact,
    harnessDigest: await sandboxDigest(artifact),
    dependencyLock: lock,
    dependencyLockDigest: await sandboxDigest(lock),
    environmentDigest: config.environmentDigest,
    input: { value: {} },
    authority: { origins: [], methods: [] },
    budget: { wallMs: 1000, requests: 0, outputBytes: 100000 },
  };
  return {
    client,
    job,
    rows,
    files,
    config,
    kv,
    gateway,
    count: () => launches,
    set: (s: {
      loseAck?: boolean;
      omitOutput?: boolean;
      corrupt?: boolean;
      omitResources?: boolean;
    }) => {
      loseAck = s.loseAck ?? loseAck;
      omitOutput = s.omitOutput ?? omitOutput;
      corrupt = s.corrupt ?? corrupt;
      omitResources = s.omitResources ?? omitResources;
    },
  };
}
test("compute retains complete output beyond exec tail and reopens without dispatch", async () => {
  const f = await fixture();
  expect(f.rows.size).toBe(0);
  const receipt = await f.client().harnessJob(f.job);
  expect(receipt.status).toBe("completed");
  expect((receipt.output as any).text.length).toBe(80000);
  await verifySandboxReceipt(f.job, receipt);
  f.files.clear();
  expect(await f.client().harnessJob(f.job)).toEqual(receipt);
  expect(f.count()).toBe(1);
  await expect(
    f.client().harnessJob({ ...f.job, input: { changed: true } }),
  ).rejects.toThrow("identity conflict");
  expect(
    [...f.rows.keys()]
      .filter((k) => k.includes("codegraff:"))
      .every((k) => k.startsWith("compute-harness:123:")),
  ).toBe(true);
  expect(JSON.stringify([...f.rows])).not.toContain("x".repeat(64));
});
test("lost acknowledgement recovers exact output; missing output remains unknown without redo", async () => {
  const f = await fixture();
  f.set({ loseAck: true });
  expect((await f.client().harnessJob(f.job)).status).toBe("completed");
  expect(f.count()).toBe(1);
  const missing = await fixture();
  missing.set({ omitOutput: true });
  expect((await missing.client().harnessJob(missing.job)).status).toBe(
    "unknown",
  );
  expect((await missing.client().harnessJob(missing.job)).status).toBe(
    "unknown",
  );
  expect(missing.count()).toBe(1);
});
test("compute rejects corruption, network authority and foreign owner", async () => {
  const f = await fixture();
  f.set({ corrupt: true });
  await expect(f.client().harnessJob(f.job)).rejects.toThrow(
    "integrity mismatch",
  );
  await expect(
    f.client().harnessJob({ ...f.job, owner: "456" }),
  ).rejects.toThrow("denied");
  await expect(
    f.client().harnessJob({
      ...f.job,
      authority: { origins: ["https://example.com"], methods: ["GET"] },
    }),
  ).rejects.toThrow("denied");
  expect(f.count()).toBe(1);
});
test("dispatcher binds both physical runtimes and preserves logical receipt identity", async () => {
  const f = await fixture(),
    py = f.client();
  let jsCalls = 0,
    jsProbes = 0,
    jsEnvironment = await sandboxDigest("js-runtime");
  const standard = {
    harnessEnvironment: async () => {
      jsProbes++;
      return jsEnvironment;
    },
    harnessJob: async () => {
      jsCalls++;
      throw Error("wrong dispatcher");
    },
  };
  const client = dispatchHarnessSandbox(standard, py, jsEnvironment),
    logical = {
      ...f.job,
      environmentDigest: await client.harnessEnvironment(),
    };
  const receipt = await client.harnessJob(logical);
  await verifySandboxReceipt(logical, receipt);
  expect(jsCalls).toBe(0);
  expect(jsProbes).toBe(0);
  jsEnvironment = await sandboxDigest("changed-runtime");
  const artifact = { kind: "code" as const, code: "return 1" };
  await expect(
    client.harnessJob({
      ...logical,
      artifact,
      harnessDigest: await sandboxDigest(artifact),
    }),
  ).rejects.toThrow("runtime pin changed");
  expect(f.count()).toBe(1);
});

test("controlled gateway executes the actual isolated Python runner and recovers its disk receipt", async () => {
  const { createPythonSandboxRuntime } =
    await import("../src/sandbox-python.ts");
  const { writeFile, readFile, rm, mkdtemp } = await import("node:fs/promises");
  const { Database } = await import("bun:sqlite");
  const { sqliteWorkflowKV } = await import("../src/workflow-store.ts");
  const directory = await mkdtemp("/tmp/compute-host-fixture-");
  const owner = `controlled-python-${crypto.randomUUID()}`;
  const paths = new Set<string>();
  const children = new Map<string, ReturnType<typeof Bun.spawn>>();
  let db = new Database(`${directory}/custody.sqlite`),
    dispatches = 0;
  const failures: string[] = [];
  try {
    const runtime = await createPythonSandboxRuntime();
    const { computeRunnerEnvironment } =
      await import("../src/compute-runner-entry.ts");
    const entry = `${directory}/entry.ts`;
    await writeFile(
      entry,
      `import {pythonComputeRunner} from ${JSON.stringify(new URL("../src/compute-runner-entry.ts", import.meta.url).pathname)};await pythonComputeRunner(${JSON.stringify({ runtimeLockDigest: runtime.lockDigest })});`,
    );
    const built = await Bun.build({ entrypoints: [entry], target: "bun" });
    if (!built.success) throw Error(built.logs.map(String).join("\n"));
    expect(built.outputs).toHaveLength(1);
    const runnerBundle = await built.outputs[0]!.text();
    runtime.dispose();
    const environmentDigest = await computeRunnerEnvironment(
      runnerBundle,
      runtime.lockDigest,
      Bun.version,
    );
    const config = {
      runtimeLockDigest: runtime.lockDigest,
      environmentDigest,
      runnerBundle,
    };
    const gateway = new Codegraff("fixture-only", async (url, init) => {
      const route = new URL(String(url)).pathname,
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (route === "/v1/sandboxes")
        return Response.json({ id: "local-controlled-compute" });
      if (route.endsWith("/upload")) {
        paths.add(body.path);
        await writeFile(body.path, Buffer.from(body.contentBase64, "base64"), {
          mode: 0o600,
        });
        return Response.json({});
      }
      if (route.endsWith("/download")) {
        try {
          return Response.json({
            contentBase64: (await readFile(body.path)).toString("base64"),
          });
        } catch (e) {
          if ((e as any).code === "ENOENT")
            return new Response("", { status: 404 });
          throw e;
        }
      }
      // Browser installation is a controlled provider fixture; Python execution below is physical.
      if (route.endsWith("/exec") && body.command.startsWith("bash /tmp/aiko-compute-cloak-")) return Response.json({execId:"cloak-setup"});
      if (route.includes("/exec/cloak-setup")) return Response.json({state:"completed",exitCode:0});
      if (route.endsWith("/exec")) {
        const args = body.command.split(" ");
        expect(args[0]).toBe("bun");
        expect(body.async).toBe(true);
        paths.add(args.at(-1)!);
        if (args[2] === "job") dispatches++;
        const id = `local-${children.size}`,
          child = Bun.spawn([process.execPath, ...args.slice(1)], {
            stdout: "ignore",
            stderr: "pipe",
            env: { ...process.env, TMPDIR: "/tmp" },
          });
        children.set(id, child);
        return Response.json({ execId: id });
      }
      if (route.includes("/exec/")) {
        const child = children.get(route.split("/").at(-1)!)!;
        if (child.exitCode === null) return Response.json({ state: "running" });
        const output = await new Response(
          child.stderr as ReadableStream<Uint8Array>,
        ).text();
        if (child.exitCode !== 0) failures.push(output);
        return Response.json({
          state: "completed",
          exitCode: child.exitCode,
          output,
        });
      }
      return Response.json({ state: "running" });
    });
    const client = () =>
      new CodegraffComputeHarness(owner, gateway, sqliteWorkflowKV(db), config);
    const source =
      'import socket\ndef run(value):\n    try:\n        socket.create_connection(("127.0.0.1", 443), timeout=0.1)\n        raise RuntimeError("network escape")\n    except OSError:\n        pass\n    with open(value["_files"]["input.bin"], "rb") as f:\n        data = f.read()\n    return {"bytes":len(data),"text":"z" * 70000}\n';
    const artifact = {
      kind: "python" as const,
      entry: "main.py",
      modules: { "main.py": { source, digest: await sandboxDigest(source) } },
      runtimeLockDigest: runtime.lockDigest,
    };
    const lock = sandboxArtifactDependencies(artifact),
      data = Buffer.from([0, 255, 128, 7]).toString("base64");
    const job: SandboxJob = {
      version: 1,
      owner,
      operationId: `fixture-${crypto.randomUUID()}`,
      contextRef: "owned-context",
      authorityRef: "pure-read",
      artifact,
      harnessDigest: await sandboxDigest(artifact),
      dependencyLock: lock,
      dependencyLockDigest: await sandboxDigest(lock),
      environmentDigest,
      input: {},
      assets: {
        "input.bin": { data, digest: await sandboxDigest(data), bytes: 4 },
      },
      authority: { origins: [], methods: [] },
      budget: { wallMs: 30000, requests: 0, outputBytes: 100000 },
    };
    const receipt = await client().harnessJob(job, AbortSignal.timeout(90000));
    expect(failures).toEqual([]);
    expect(receipt).toMatchObject({ status: "completed" });
    expect((receipt.output as any)?.bytes).toBe(4);
    expect((receipt.output as any)?.text.length).toBe(70000);
    expect(
      JSON.stringify(db.query("SELECT * FROM workflow_records").all()),
    ).not.toContain("z".repeat(64));
    db.close();
    db = new Database(`${directory}/custody.sqlite`);
    for (const path of paths) await rm(path, { force: true });
    expect(await client().harnessJob(job)).toEqual(receipt);
    expect(dispatches).toBe(1);
  } finally {
    for (const child of children.values()) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    for (const path of paths) await rm(path, { force: true });
    db.close();
    await rm(directory, { recursive: true, force: true });
    await rm(
      `/tmp/aiko-compute-journal/${(await sandboxDigest(owner)).slice(7)}`,
      { recursive: true, force: true },
    );
  }
}, 120000);

test("compute never accepts successful Python output without retained aggregate resource evidence",async()=>{const f=await fixture();f.set({omitResources:true});await expect(f.client().harnessJob(f.job)).rejects.toThrow("Sandbox resource evidence unavailable");expect(f.count()).toBe(1);});
