import { randomUUID } from "node:crypto";
import { Effect, type Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { z } from "zod";
import { LOGIN_UI_PROMPT, LOGIN_UI_VERSION, fallbackLoginSpec, loginFields, loginSpecSchema, validateLoginSpec, type LoginLayout } from "../../../packages/protocol/src/login-ui.ts";
import type { NativeLoginView } from "./native-login.ts";

export type NativeLoginRenderer = (view: Pick<NativeLoginView, "status" | "fields" | "requiresOrigin" | "pageError">, signal: AbortSignal) => Promise<LoginLayout | undefined>;

/** Metadata-only UI generation through the host's existing native Infer/budget.
 * Never pass a request body, browser view, history, domain or credential to Infer.
 * A layout is disposable presentation, not a durable login action/receipt. */
export function createNativeLoginRenderer(options: {
  owner: string;
  instance: string;
  layer: () => Layer.Layer<Infer> | undefined;
}): NativeLoginRenderer {
  // At most seven nonempty shapes per owner/renderer version. Coalesce repeated
  // polls and cache failures as explicit fallback: no hidden model retry loop.
  const layouts = new Map<string, Promise<LoginLayout>>();
  return async (view, signal) => {
    signal.throwIfAborted();
    const fields = loginFields(view.fields);
    if (view.status !== "pending" || view.requiresOrigin || view.pageError || !fields?.length) return;
    const key = fields.join(",");
    if (!layouts.has(key)) layouts.set(key, (async (): Promise<LoginLayout> => {
      const fallback: LoginLayout = { version: LOGIN_UI_VERSION, source: "fallback", spec: fallbackLoginSpec(fields)! };
      try {
        const layer = options.layer();
        if (!layer) return fallback;
        const abort = AbortSignal.any([signal, AbortSignal.timeout(12_000)]), id = randomUUID();
        const request: InferRequest = {
          identity: { actor: "aiko", instance: options.instance, thread: `login-ui-${options.owner}`, turn: id },
          // Flat keyed specs are outside the native strict-output wire profile.
          // Generate JSON text with the catalog, then validate the whole tree
          // locally; never weaken the spec to make a provider schema accept it.
          system: `${LOGIN_UI_PROMPT}\nJSON Schema (validated locally): ${JSON.stringify(z.toJSONSchema(loginSpecSchema))}`,
          tools: [],
          trajectory: [{ type: "MessageReceived", id, at: Date.now(), text: JSON.stringify({ fields }) }],
        };
        const result = await Effect.runPromise(Effect.gen(function* () {
          const infer = yield* Infer;
          return yield* infer.react(request, id, abort);
        }).pipe(Effect.provide(layer)), { signal: abort });
        if (result.kind !== "complete" || typeof result.output !== "string" || result.output.length > 32_768) return fallback;
        const spec = validateLoginSpec(JSON.parse(result.output), fields);
        return spec ? { version: LOGIN_UI_VERSION, source: "generated", spec } : fallback;
      } catch {
        // Raw model errors/output never reach the owner, logs or another model.
        return fallback;
      }
    })());
    const layout = await layouts.get(key)!;
    signal.throwIfAborted();
    return structuredClone(layout);
  };
}
