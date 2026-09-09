import { randomUUID } from "node:crypto";
import { Effect, type Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { z } from "zod";
import { LOGIN_UI_PROMPT, LOGIN_UI_VERSION, fallbackLoginSpec, loginFields, loginSpecSchema, validateLoginSpec, type LoginLayout } from "../../../packages/protocol/src/login-ui.ts";
import type { NativeLoginView } from "./native-login.ts";

export type NativeLoginRenderer = (view: Pick<NativeLoginView, "status" | "fields" | "requiresOrigin" | "pageError">, signal: AbortSignal) => Promise<LoginLayout | undefined>;

// Presentation must not hold a ready credential form behind model latency.
// A validated catalog fallback is fully usable when inference takes longer.
const LOGIN_LAYOUT_RESPONSE_MS = 250;

/** Metadata-only UI generation through the host's existing native Infer/budget.
 * Never pass a request body, browser view, history, domain or credential to Infer.
 * A layout is disposable presentation, not a durable login action/receipt. */
export function createNativeLoginRenderer(options: {
  owner: string;
  instance: string;
  layer: () => Layer.Layer<Infer> | undefined;
  /** Keep optional presentation work alive after the HTTP response on Workers. */
  defer?: (work: Promise<unknown>) => void;
}): NativeLoginRenderer {
  // At most seven nonempty shapes per owner/renderer version. Coalesce repeated
  // polls and cache failures as explicit fallback: no hidden model retry loop.
  const layouts = new Map<string, Promise<LoginLayout>>();
  return async (view, signal) => {
    signal.throwIfAborted();
    const fields = loginFields(view.fields);
    if (view.status !== "pending" || view.requiresOrigin || view.pageError || !fields?.length) return;
    const key = fields.join(",");
    const fallback: LoginLayout = { version: LOGIN_UI_VERSION, source: "fallback", spec: fallbackLoginSpec(fields)! };
    if (!layouts.has(key)) {
      const pending = (async (): Promise<LoginLayout> => {
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
      })();
      layouts.set(key, pending);
      options.defer?.(pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let layout: LoginLayout;
    try {
      layout = await Promise.race([
        layouts.get(key)!,
        new Promise<LoginLayout>(resolve => { timer = setTimeout(() => resolve(fallback), LOGIN_LAYOUT_RESPONSE_MS); }),
      ]);
    } finally { clearTimeout(timer); }
    signal.throwIfAborted();
    return structuredClone(layout);
  };
}
