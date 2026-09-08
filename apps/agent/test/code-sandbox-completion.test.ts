import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SandboxCallOutcome } from "tardie/code/sandbox/service";
import { codegraffSandboxService } from "../src/code-sandbox.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { CODE_SEGMENT_MAX_BYTES, type CodeCall, type CodeSegment } from "../src/code-sandbox-protocol.ts";

const ambient = { at: 1234, seed: "completion-tests" };
const sandbox = codegraffSandboxService(runCodeSegment);
const deferred = <T>() => Promise.withResolvers<T>();
const returned = (result: unknown, completionOrder?: number): SandboxCallOutcome => ({ _tag: "Returned", result, completionOrder });
const branches = `
  const slow = tools.read({id:"slow"}).then(id => tools.follow({id}));
  const fast = tools.read({id:"fast"}).then(id => tools.follow({id}));
  return await Promise.all([slow, fast]);
`;
const within = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Expected branch did not make independent progress")), 1000);
    })]);
  } finally { clearTimeout(timer!); }
};

test("a fast continuation executes before a slow sibling settles; calls retain native ordinals", async () => {
  const slow = deferred<void>(), followedFast = deferred<void>();
  const calls: unknown[] = [];
  let slowSettled = false;
  const run = Effect.runPromise(sandbox.run(branches, { tools: {
    read: async (args: any, ordinal: number) => {
      calls.push(["read", args.id, ordinal]);
      if (args.id === "slow") { await slow.promise; slowSettled = true; }
      return returned(args.id);
    },
    follow: async (args: any, ordinal: number) => {
      calls.push(["follow", args.id, ordinal]);
      if (args.id === "fast") followedFast.resolve();
      return returned(`${args.id} followed`);
    },
  } }, ambient));
  try {
    await within(followedFast.promise);
    expect(slowSettled).toBe(false);
    expect(calls).toEqual([["read", "slow", 0], ["read", "fast", 1], ["follow", "fast", 2]]);
  } finally { slow.resolve(); }
  expect(await run).toMatchObject({ result: ["slow followed", "fast followed"] });
  expect(calls.at(-1)).toEqual(["follow", "slow", 3]);
});

test("recorded native completion ranks restore branch identities when replay promises arrive in invocation order", async () => {
  const journal = new Map<number, { name: string; id: string; result: unknown; rank: number }>([
    [0, { name: "read", id: "slow", result: "slow", rank: 2 }],
    [1, { name: "read", id: "fast", result: "fast", rank: 0 }],
    [2, { name: "follow", id: "fast", result: "fast followed", rank: 1 }],
    [3, { name: "follow", id: "slow", result: "slow followed", rank: 3 }],
  ]);
  const observed: number[] = [];
  const binding = (name: string) => async (args: any, ordinal: number) => {
    const prior = journal.get(ordinal)!;
    expect([name, args.id]).toEqual([prior.name, prior.id]);
    observed.push(ordinal);
    return returned(prior.result, prior.rank);
  };
  const result = await Effect.runPromise(sandbox.run(branches, { tools: { read: binding("read"), follow: binding("follow") } }, ambient));
  expect(result.error).toBeUndefined();
  expect(result.result).toEqual(["slow followed", "fast followed"]);
  expect(observed).toEqual([0, 1, 2, 3]);
});

test("an old execution retains original batch delivery and continuation identities across upgrade", async () => {
  const recorded = new Map<number, { name: string; id: string; rank: number }>([
    [0, { name: "read", id: "slow", rank: 1 }],
    [1, { name: "read", id: "fast", rank: 0 }],
    [2, { name: "follow", id: "slow", rank: 2 }],
    [3, { name: "follow", id: "fast", rank: 3 }],
  ]);
  const invoke = (name: string) => async (args: any, ordinal: number) => {
    const prior = recorded.get(ordinal)!;
    expect([name, args.id]).toEqual([prior.name, prior.id]);
    return returned(name === "read" ? args.id : `${args.id} followed`, prior.rank);
  };
  const result = await Effect.runPromise(sandbox.run(branches, { tools: { read: invoke("read"), follow: invoke("follow") } }, { ...ambient, replayVersion: "aiko-code/1" }));
  expect(result.error).toBeUndefined();
  expect(result.result).toEqual(["slow followed", "fast followed"]);
});

test("isolated segment replays noncontiguous completions without changing branch IDs or Promise.race", async () => {
  const read = (ordinal: number, id: string): CodeCall => ({ ordinal, packageName: "tools", method: "read", args: { id } });
  const calls = [read(0, "slow"), read(1, "fast")];
  const input: CodeSegment = {
    version: 1, ambient, packages: { tools: ["read", "follow"] }, values: {},
    code: `const a=tools.read({id:"slow"}),b=tools.read({id:"fast"}); const first=await Promise.race([a,b]); await Promise.all([a,b]); return first;`,
    issued: calls, history: [{ call: calls[1]!, result: "fast" }, { call: calls[0]!, result: "slow" }],
  };
  expect(await runCodeSegment(input)).toMatchObject({ result: "fast", settled: true, calls: [] });
  const partial = await runCodeSegment({ ...input, history: input.history.slice(0, 1) });
  expect(partial).toMatchObject({ settled: false, calls: [calls[0]] });
  expect((await runCodeSegment({ ...input, history: [input.history[0]!, input.history[0]!] })).error).toContain("Nondeterministic");
});

test("a parked sibling does not suppress a fast continuation before the attempt parks", async () => {
  const followed: string[] = [];
  const result = await Effect.runPromise(sandbox.run(branches, { tools: {
    read: async (args: any) => args.id === "slow" ? { _tag: "Parked" as const } : returned(args.id, 0),
    follow: async (args: any) => { followed.push(args.id); return returned("followed", 1); },
  } }, ambient));
  expect(followed).toEqual(["fast"]);
  expect(result).toEqual({});
  expect(sandbox.managesParking).toBe(true);
});

test("host failure cancels running siblings and prevents dependent effects", async () => {
  const started = deferred<void>(), cancelled = deferred<void>();
  let follow = false;
  const result = await Effect.runPromise(sandbox.run(branches, { tools: {
    read: async (args: any, _ordinal: number, signal?: AbortSignal) => {
      if (args.id === "fast") { await started.promise; throw Error("host unavailable"); }
      return await new Promise<SandboxCallOutcome>((_, reject) => {
        signal!.addEventListener("abort", () => { cancelled.resolve(); reject(signal!.reason); }, { once: true });
        started.resolve();
      });
    },
    follow: async () => { follow = true; return returned("wrong"); },
  } }, ambient));
  expect(result.error).toBe("host unavailable");
  await within(cancelled.promise);
  expect(follow).toBe(false);
});

test("external cancellation reaches every native call without launching continuations", async () => {
  const controller = new AbortController(), started = deferred<void>();
  const signals: AbortSignal[] = [];
  let follow = 0;
  const run = Effect.runPromise(sandbox.run(branches, { tools: {
    read: async (_args: unknown, _ordinal: number, signal?: AbortSignal) => {
      signals.push(signal!);
      if (signals.length === 2) started.resolve();
      return await new Promise<SandboxCallOutcome>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    },
    follow: async () => { follow++; return returned(null); },
  } }, ambient), { signal: controller.signal });
  const stopped = run.catch(() => "cancelled");
  await within(started.promise);
  controller.abort();
  expect(await within(stopped)).toBe("cancelled");
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(follow).toBe(0);
});

test("returning with a running sibling refuses settlement and aborts its native call", async () => {
  let slowSignal: AbortSignal | undefined;
  const result = await Effect.runPromise(sandbox.run(`tools.read({id:"slow"}); return await tools.read({id:"fast"});`, { tools: {
    read: async (args: any, _ordinal: number, signal?: AbortSignal) => {
      if (args.id === "fast") return returned("fast");
      slowSignal = signal;
      return await new Promise<SandboxCallOutcome>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    },
  } }, ambient));
  expect(result.error).toContain("Await every");
  expect(slowSignal?.aborted).toBe(true);
});

test("pending and data limits refuse a batch before any native effects", async () => {
  let effects = 0;
  const bindings = { tools: { read: async () => { effects++; return returned(null); } } };
  const excessive = await Effect.runPromise(sandbox.run(`return await Promise.all(Array.from({length:33},()=>tools.read({})));`, bindings, ambient));
  expect(excessive.error).toContain("32 package");
  const oversized = await Effect.runPromise(sandbox.run(`return await tools.read({value:"x".repeat(131073)});`, bindings, ambient));
  expect(oversized.error).toContain("128 KiB");
  const data = await Effect.runPromise(sandbox.run(`return await tools.read({});`, { ...bindings, input: "x".repeat(CODE_SEGMENT_MAX_BYTES) }, ambient));
  expect(data.error).toContain("2 MiB");
  expect(effects).toBe(0);
});

test("transport batches are validated in full and cannot hide or change a dispatched call", async () => {
  let effects = 0;
  const call: CodeCall = { ordinal: 0, packageName: "tools", method: "read", args: {} };
  const invalid = codegraffSandboxService(async () => ({ settled: false, calls: [call, { ...call, ordinal: 2 }] }));
  expect((await Effect.runPromise(invalid.run("", { tools: { read: async () => { effects++; return returned(null); } } }, ambient))).error).toContain("Invalid");
  expect(effects).toBe(0);
  const invalidRank = await Effect.runPromise(sandbox.run(`return await tools.read({});`, { tools: { read: async () => returned("wrong", 2) } }, ambient));
  expect(invalidRank.error).toContain("completion order");
});

test("the bundled VM evaluator accepts a JSON round trip with issued calls and out-of-order completions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiko-code-bundle-"));
  try {
    const build = await Bun.build({ entrypoints: [new URL("../src/code-sandbox-runner.ts", import.meta.url).pathname], target: "bun", minify: true });
    expect(build.success).toBe(true);
    const path = join(dir, "runner.mjs");
    await writeFile(path, await build.outputs[0]!.text());
    const evaluator = (await import(pathToFileURL(path).href)).runCodeSegment as typeof runCodeSegment;
    const first: CodeCall = { ordinal: 0, packageName: "tools", method: "read", args: { id: "slow" } };
    const second: CodeCall = { ...first, ordinal: 1, args: { id: "fast" } };
    const segment: CodeSegment = { version: 1, code: branches, packages: { tools: ["read", "follow"] }, values: {}, ambient,
      issued: [first, second], history: [{ call: second, result: "fast" }] };
    const response = await evaluator(JSON.parse(JSON.stringify(segment)));
    expect(response).toMatchObject({ settled: false, calls: [first, { ordinal: 2, packageName: "tools", method: "follow", args: { id: "fast" } }] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
