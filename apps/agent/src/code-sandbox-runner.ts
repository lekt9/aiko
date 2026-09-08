import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { CODE_SEGMENT_MAX_BYTES, codeCallKey, type CodeCall, type CodeSegment, type CodeSegmentResult } from "./code-sandbox-protocol.ts";

// Imported only by the trusted Codegraff runner. Each segment gets a fresh WASM
// runtime: guest JavaScript has no Bun, process, filesystem, network or browser.
const moduleReady = newQuickJSWASMModuleFromVariant(variant);
export async function runCodeSegment(input: CodeSegment, signal?: AbortSignal, limits: { cpuMs?: number } = {}): Promise<CodeSegmentResult> {
  signal?.throwIfAborted();
  if (input?.version !== 1 || typeof input.code !== "string" || input.code.length > 65536 ||
      JSON.stringify(input).length > CODE_SEGMENT_MAX_BYTES || !Number.isFinite(input.ambient?.at))
    return { calls: [], settled: true, error: "Invalid or oversized code segment" };
  const module = await moduleReady;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const cpuMs = limits.cpuMs ?? 1000;
  if (!Number.isFinite(cpuMs) || cpuMs < 1 || cpuMs > 1000) { runtime.dispose(); throw Error("Invalid code CPU budget"); }
  const deadline = performance.now() + cpuMs;
  runtime.setInterruptHandler(() => signal?.aborted === true || performance.now() > deadline);
  const context = runtime.newContext();
  const calls: CodeCall[] = [], logs: string[] = [];
  const batch = input.scheduling === "batch";
  const known = new Map((input.issued ?? input.history.map(entry => entry.call)).map(call => [call.ordinal, call]));
  const completed = new Set<number>();
  let ordinal = 0, logBytes = 0, refused: string | undefined;
  const bind = (name: string, fn: (...args: any[]) => any) => {
    const handle = context.newFunction(name, fn);
    context.setProp(context.global, name, handle);
    handle.dispose();
  };
  try {
    bind("__aikoCall", raw => {
      const request = JSON.parse(context.getString(raw));
      const call: CodeCall = { ordinal: ordinal++, packageName: request.packageName, method: request.method, args: request.args ?? null };
      if (!Object.hasOwn(input.packages, call.packageName) || !input.packages[call.packageName]!.includes(call.method))
        throw new Error("Unknown package method");
      if (JSON.stringify(call).length > 131072) throw new Error("Package arguments exceed 128 KiB");
      const prior = known.get(call.ordinal);
      if (prior) {
        if (codeCallKey(prior) !== codeCallKey(call)) {
          refused = "Nondeterministic package call during replay";
          return context.undefined;
        }
        if (batch) return context.newString(JSON.stringify({ value: input.history[call.ordinal]?.result ?? null }));
      }
      if (calls.length - completed.size >= 32) {
        refused = "At most 32 package calls may be pending in one segment; await a batch before starting another";
        return context.undefined;
      }
      calls.push(call);
      return batch ? context.undefined : context.newNumber(call.ordinal);
    });
    bind("__aikoLog", raw => {
      const line = context.getString(raw);
      if (logBytes < 8192) {
        logs.push(line.slice(0, 8192 - logBytes));
        logBytes += line.length;
        if (logBytes >= 8192) logs.push("[console output capped at 8192 characters]");
      }
      return context.undefined;
    });
    // The bootstrap captures bridge functions in closures before removing globals.
    // JSON round trips prevent host object/prototype or exception handles escaping.
    const bootstrap = `(() => {
      const invoke = __aikoCall, log = __aikoLog, NativePromise = Promise, parse = JSON.parse, stringify = JSON.stringify;
      const resolvers = Object.create(null);
      delete globalThis.__aikoCall; delete globalThis.__aikoLog;
      const packages = ${JSON.stringify(input.packages)}, values = ${JSON.stringify(input.values)};
      for (const [name, methods] of Object.entries(packages)) {
        const target = Object.create(null);
        for (const method of methods) target[method] = ${batch} ? async args => {
          const result = invoke(stringify({packageName:name,method,args:args ?? null}));
          return result === undefined ? new NativePromise(() => {}) : parse(result).value;
        } : args => new NativePromise(resolve => {
          const position = invoke(stringify({packageName:name,method,args:args ?? null}));
          if (position !== undefined) resolvers[position] = resolve;
        });
        Object.defineProperty(globalThis, name, {value:Object.freeze(target)});
      }
      for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis,name,{value});
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { if(args.length) super(...args); else super(${JSON.stringify(input.ambient.at)}); }
        static now() { return ${JSON.stringify(input.ambient.at)}; }
      };
      let h=0x811c9dc5;
      for(const c of ${JSON.stringify(input.ambient.seed)}) { h ^= c.charCodeAt(0); h=Math.imul(h,0x01000193); }
      Math.random=()=>{h=(h+0x6d2b79f5)>>>0; let t=h;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
      globalThis.console=Object.freeze(Object.fromEntries(['log','info','warn','error','debug'].map(k=>[k,(...args)=>log(args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '))])));
      return (position, raw) => { const resolve = resolvers[position]; delete resolvers[position]; resolve(parse(raw)); };
    })();`;
    const setup = context.evalCode(bootstrap);
    if (setup.error) { const error = context.dump(setup.error); setup.dispose(); throw new Error(String(error)); }
    const evaluated = context.evalCode(`(async () => {\n${input.code}\n})()`, "aiko-workflow.js");
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.dispose();
      setup.dispose();
      return { calls: [], settled: true, error: String(error?.message ?? error), logs };
    }
    try {
      const drain = () => {
        while (runtime.hasPendingJob()) {
          const jobs = runtime.executePendingJobs(100);
          if (jobs.error) { const error = context.dump(jobs.error); jobs.dispose(); throw new Error(String(error?.message ?? error)); }
          jobs.dispose();
          if (signal?.aborted || performance.now() > deadline) throw new Error("Code segment CPU limit exceeded or cancelled");
        }
      };
      drain();
      // Resolve one recorded completion and drain its continuations before delivering
      // the next. Immediately resolving calls by ordinal changes Promise.race and
      // continuation call identities when a faster sibling finished first.
      for (const entry of batch ? [] : input.history) {
        const call = calls[entry.call.ordinal];
        if (!call || completed.has(call.ordinal) || codeCallKey(call) !== codeCallKey(entry.call)) {
          refused = "Nondeterministic package completion during replay";
          break;
        }
        completed.add(call.ordinal);
        const position = context.newNumber(call.ordinal), raw = context.newString(JSON.stringify(entry.result ?? null));
        const delivered = context.callFunction(setup.value, context.undefined, position, raw);
        position.dispose(); raw.dispose();
        if (delivered.error) { const error = context.dump(delivered.error); delivered.dispose(); throw new Error(String(error?.message ?? error)); }
        delivered.dispose();
        drain();
      }
      if (input.issued?.some(call => !calls[call.ordinal] || codeCallKey(call) !== codeCallKey(calls[call.ordinal]!)))
        refused = "Nondeterministic package call during replay";
      if (refused) return { calls: [], settled: true, error: refused, logs };
      const pending = calls.filter(call => !completed.has(call.ordinal));
      const state = context.getPromiseState(evaluated.value);
      if (state.type === "fulfilled") {
        const result = context.dump(state.value); state.value.dispose();
        const output = { calls: pending, settled: true, result, logs };
        if (JSON.stringify(output).length > CODE_SEGMENT_MAX_BYTES) throw new Error("Code output exceeds 2 MiB");
        // Unawaited calls are refused; no effects run after the program has returned.
        if (pending.length) return { calls: [], settled: true, error: "Await every package call before returning", logs };
        return output;
      }
      if (state.type === "rejected") {
        const error = context.dump(state.error); state.error.dispose();
        return { calls: [], settled: true, error: String(error?.message ?? error), logs };
      }
      return pending.length ? { calls: pending, settled: false, logs }
        : { calls: [], settled: true, error: "Code is waiting without a package call; timers and external I/O are unavailable", logs };
    } finally { evaluated.dispose(); setup.dispose(); }
  } catch (error) {
    return { calls: [], settled: true, error: String(error instanceof Error ? error.message : error).slice(0, 2000), logs };
  } finally { context.dispose(); runtime.dispose(); }
}
