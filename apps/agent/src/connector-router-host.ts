import { createHash } from "node:crypto";
import type { BunHost } from "tardie/bun/host";
import { createToolRouterActor, routerThread, type RouterMethod, type ToolRouterBinding } from "./tool-router.ts";

/** Reject credential material before native request events are persisted. */
export function validateRouterInput(value: unknown, depth = 0, numericBudgetKeys: readonly string[] = []): void {
  if (depth > 16) throw new Error("Router input nesting limit");
  if (Array.isArray(value)) { for (const item of value) validateRouterInput(item, depth + 1, numericBudgetKeys); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // Only a trusted caller may identify a schema's numeric budget quantity.
      // Token strings, nested objects and ordinary credential keys still fail.
      const quantity = numericBudgetKeys.includes(key) && typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
      if (!quantity && /(?:password|passwd|secret|token|cookie|authorization|api[_-]?key|credential|headers|session[_-]?id)/i.test(key)) throw new Error("Credentials do not belong in routing arguments");
      validateRouterInput(item, depth + 1, numericBudgetKeys);
    }
  } else if (typeof value === "string") {
    if (/(?:password|passwd|secret|token|cookie|authorization|api[_ -]?key)["']?\s*[:=]\s*["']?\S+/i.test(value)) throw new Error("Credential text in routing input");
    for (const raw of value.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
      const url = new URL(raw);
      if (url.username || url.password || /(?:^|\/)(?:auth|oauth|authorize|callback|login)(?:\/|$)/i.test(url.pathname) || [...url.searchParams.keys()].some(key => /token|secret|password|key|state|code|session|signature/i.test(key)) || url.hash) throw new Error("Authorization URL in routing input");
    }
  }
}

/** Invokes the real mounted native actor, persisting request and terminal result in its account log. */
export function routerCaller(binding: ToolRouterBinding, host: () => Pick<BunHost, "read" | "self" | "commitRoot" | "wake">) {
  const definition = createToolRouterActor(binding);
  return async (method: RouterMethod, input: unknown, context: { callId: string; turn?: string; signal: AbortSignal }) => {
    context.signal.throwIfAborted();
    validateRouterInput(input);
    const serialized = JSON.stringify(input);
    if (!serialized || serialized.length > 16384 || (binding.redact && binding.redact(serialized) !== serialized)) throw new Error("Invalid router input");
    const id = createHash("sha256").update(`${context.turn}:${context.callId}`).digest("hex");
    const thread = routerThread(binding.owner), native = definition.methods[method], invocation = { method, id, epoch: 0 };
    if (!native) throw new Error("Unknown router method");
    const service = host();
    const before = await service.read(thread);
    const prior = before.find(e => e.type === "AikoRouterRequested" && e.id === `${method}:${id}:0`);
    if (prior && JSON.stringify(prior.input) !== serialized) throw new Error("Router invocation conflict");
    await service.commitRoot(service.self(thread), native.eventOf({ input, invocation, at: Date.now() }));
    try { await service.wake(thread); }
    catch (error) {
      // Draining also settles other threads and alarm maintenance. A failure
      // there cannot undo this invocation's already committed terminal receipt.
      // Read custody once; never re-dispatch or infer success from a failed read.
      const settled = native.state(await service.read(thread), invocation);
      if (settled?.status === "completed") return settled.output;
      throw error;
    }
    context.signal.throwIfAborted();
    const state = native.state(await service.read(thread), invocation);
    if (state?.status !== "completed") return { state: "pending", invocationId: id };
    return state.output;
  };
}
