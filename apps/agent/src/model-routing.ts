import { Infer, type InferRequest } from "tardie";
import { infer as modelInfer } from "tardie/model";
import { modelAdapters } from "tardie/model/adapter";
import { openAICompatibleAdapter } from "tardie/model/openai";
import { Effect, Layer } from "effect";
import { safeUserId, type HttpFetch } from "./security.ts";
import { sumUsage, type Usage } from "tardie/inference/usage";

export const MODEL_ROLES = ["conversation", "rag", "browser"] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export type ModelProvider = "codegraff" | "cerebras";
export type ModelRoutingEnv = Readonly<Record<string, string | undefined>>;
export const MODEL_PROVIDERS = Object.freeze({
  codegraff: Object.freeze({ baseUrl: "https://gateway.codegraff.com/v1", secretEnv: "CODEGRAFF_API_KEY" as const, defaultModel: "glm-5.3-flash" }),
  cerebras: Object.freeze({ baseUrl: "https://api.cerebras.ai/v1", secretEnv: "CEREBRAS_API_KEY" as const, defaultModel: "qwen-3.8-27b" }),
});
export type ModelRoute = {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly secretEnv: "CODEGRAFF_API_KEY" | "CEREBRAS_API_KEY";
};
export type ModelRoutingConfig = {
  readonly roles: Readonly<Record<ModelRole, ModelRoute>>;
  readonly fallbacks?: Partial<Readonly<Record<ModelRole, readonly ModelRoute[]>>>;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
};
export type ModelRoutingDefaults = { model?: string; contextWindowTokens?: number; maxOutputTokens?: number };
/** Existing ModelBudget-compatible middleware. Supply one shared owner/account ledger across every role. */
export interface ModelRoutingBudget { transport(owner: string, upstream?: HttpFetch): HttpFetch }
export type ModelRouteStatus = ModelRoute & { role: ModelRole; status: "configured" | "unavailable"; reason?: "missing_key" | "invalid_key" | "paid_inference_disabled" };
export class ModelRoutingUnavailable extends Error {
  constructor(readonly role: ModelRole, readonly provider: ModelProvider, readonly reason: string) {
    super(`Model route ${role} (${provider}) unavailable: ${reason}`);
    this.name = "ModelRoutingUnavailable";
  }
}
const roleOf = (role: ModelRole) => { if (!MODEL_ROLES.includes(role)) throw new Error("Invalid model role"); return role; };
const modelOf = (value: string) => {
  if (!/^[A-Za-z0-9_./-]{1,128}$/.test(value) || /^(?:sk-|csk-|aiko_|ghp_)/i.test(value)) throw new Error("Invalid model identifier");
  return value;
};
const integer = (value: number, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid model routing budget");
  return value;
};

/** Public configuration contains references only; no credentials, custom origins, inferred intent or provider fallback. */
export function parseModelRouting(env: ModelRoutingEnv, defaults: ModelRoutingDefaults = {}): ModelRoutingConfig {
  const model = modelOf(defaults.model ?? env.AIKO_MODEL ?? MODEL_PROVIDERS.codegraff.defaultModel);
  const contextWindowTokens = integer(defaults.contextWindowTokens ?? 32768, 1024, 2_000_000);
  const maxOutputTokens = integer(defaults.maxOutputTokens ?? 1024, 1, 65536);
  if (maxOutputTokens >= contextWindowTokens) throw new Error("Model output allowance exceeds context window");
  const roles = Object.fromEntries(MODEL_ROLES.map(role => {
    const prefix = `AIKO_${role.toUpperCase()}`;
    const provider = env[`${prefix}_PROVIDER`] ?? "codegraff";
    if (provider !== "codegraff" && provider !== "cerebras") throw new Error("Invalid model routing provider");
    const routeModel = modelOf(env[`${prefix}_MODEL`] ?? (provider === "codegraff" ? model : MODEL_PROVIDERS.cerebras.defaultModel));
    if (routeModel === env.CODEGRAFF_API_KEY || routeModel === env.CEREBRAS_API_KEY) throw new Error("Model identifier must not contain a credential");
    return [role, Object.freeze({ provider, model: routeModel, secretEnv: MODEL_PROVIDERS[provider].secretEnv })];
  })) as Record<ModelRole, ModelRoute>;
  const fallbacks: Partial<Record<ModelRole, readonly ModelRoute[]>> = {};
  for (const role of MODEL_ROLES) {
    const raw = env[`AIKO_${role.toUpperCase()}_FALLBACKS`];
    if (!raw) continue;
    const values = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 3) throw new Error("Invalid model fallbacks");
    const seen = new Set([`${roles[role].provider}/${roles[role].model}`]);
    fallbacks[role] = Object.freeze(values.map((value: any) => {
      if (!value || Object.keys(value).sort().join(",") !== "model,provider" ||
          !Object.hasOwn(MODEL_PROVIDERS, value.provider) || typeof value.model !== "string")
        throw new Error("Invalid fallback model route");
      const provider = value.provider as ModelProvider, model = modelOf(value.model);
      if (model === env.CODEGRAFF_API_KEY || model === env.CEREBRAS_API_KEY || seen.has(`${provider}/${model}`))
        throw new Error("Invalid or duplicate fallback model");
      seen.add(`${provider}/${model}`);
      return Object.freeze({ provider, model, secretEnv: MODEL_PROVIDERS[provider].secretEnv });
    }));
  }
  return Object.freeze({ roles: Object.freeze(roles), contextWindowTokens, maxOutputTokens,
    ...(Object.keys(fallbacks).length ? { fallbacks: Object.freeze(fallbacks) } : {}) });
}

/** Drop unsupported strict-decoder constraints only at wire schema nodes; native validators retain the original constraints. */
function strictWireSchema(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Model schema nesting limit");
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["minLength", "maxLength", "pattern", "minItems", "maxItems"].includes(key)).map(([key, entry]) => {
    if (["properties", "$defs", "definitions", "patternProperties"].includes(key) && entry && typeof entry === "object" && !Array.isArray(entry))
      return [key, Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, strictWireSchema(child, depth + 1)]))];
    if (["items", "additionalProperties", "not", "if", "then", "else", "contains"].includes(key)) return [key, strictWireSchema(entry, depth + 1)];
    if (["anyOf", "allOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(entry)) return [key, entry.map(child => strictWireSchema(child, depth + 1))];
    return [key, entry];
  }));
}
/** Strict decoding cannot represent arbitrary connector arguments. Never close an open schema just to satisfy the provider. */
function cerebrasStrictSchema(value: unknown, depth = 0): boolean {
  if (depth > 32 || !value || typeof value !== "object" || Array.isArray(value)) return value === false;
  const schema = value as Record<string, any>;
  if (!Object.keys(schema).length) return false;
  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object")) || schema.properties) {
    if (!schema.properties || schema.additionalProperties !== false) return false;
  }
  for (const key of ["properties", "$defs", "definitions", "patternProperties"])
    if (schema[key] && !Object.values(schema[key]).every(child => cerebrasStrictSchema(child, depth + 1))) return false;
  for (const key of ["items", "additionalProperties", "not", "if", "then", "else", "contains"])
    if (schema[key] !== undefined && !cerebrasStrictSchema(schema[key], depth + 1)) return false;
  for (const key of ["anyOf", "allOf", "oneOf", "prefixItems"])
    if (Array.isArray(schema[key]) && !schema[key].every((child: unknown) => cerebrasStrictSchema(child, depth + 1))) return false;
  return true;
}
function adaptCerebras(body: Record<string, any>) {
  const adapted: Record<string, any> = { ...body, parallel_tool_calls: false, temperature: 0, stream_options: { include_usage: true } };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error("Invalid model tools");
    if (!body.tools.length) delete adapted.tools;
    else adapted.tools = body.tools.map((tool: any) => {
      if (tool?.type !== "function" || !tool.function || typeof tool.function.name !== "string") throw new Error("Invalid model tool");
      const parameters = strictWireSchema(tool.function.parameters);
      return { ...tool, function: { ...tool.function, strict: cerebrasStrictSchema(parameters), parameters } };
    });
    // Cerebras requires a uniform strict setting across the entire tool list.
    // Open connector inputs retain their original wire schema and are checked
    // by the registered host validator before execution.
    if (adapted.tools?.some((tool: any) => !tool.function.strict))
      adapted.tools = adapted.tools.map((tool: any, index: number) => ({ ...tool,
        function: { ...tool.function, strict: false, parameters: body.tools[index].function.parameters },
      }));
  }
  // From unbrowse-playground's native provider adapter. No hidden output allowance expansion.
  if (body.model === "qwen-3.8-27b") { adapted.reasoning_effort = adapted.tools ? "high" : "none"; adapted.reasoning_format = "parsed"; }
  if (body.model === "gpt-oss-120b") { adapted.reasoning_effort = adapted.tools ? "medium" : "low"; adapted.reasoning_format = "hidden"; }
  if (body.model === "gemma-4-31b" && !adapted.tools) { adapted.reasoning_effort = "none"; adapted.reasoning_format = "parsed"; }
  return adapted;
}

/** Keep recorded tool replies adjacent on the wire when a queued user message arrived during tool I/O. */
export function orderedToolMessages(messages: readonly Record<string, any>[]) {
  const returns = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      if (returns.has(message.tool_call_id)) throw new Error("Duplicate tool response");
      returns.set(message.tool_call_id, index);
    }
  });
  const moved = new Set<number>();
  const ordered: Record<string, any>[] = [];
  messages.forEach((message, index) => {
    if (moved.has(index)) return;
    if (message.role === "tool") throw new Error("Unpaired tool response");
    ordered.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return;
    for (const call of message.tool_calls) {
      const result = returns.get(call.id);
      if (result === undefined || result <= index || moved.has(result))
        throw new Error("Unpaired tool call");
      ordered.push(messages[result]!);
      moved.add(result);
    }
  });
  return ordered;
}

export const DEFAULT_MODEL_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

export type ModelRoutingOptions = {
  owner: string;
  config: ModelRoutingConfig;
  env: ModelRoutingEnv;
  budget?: ModelRoutingBudget;
  fetch?: HttpFetch;
  /** Preserve host stream timing; the supplied budget transport may impose a stricter deadline. */
  stream?: { firstChunkMs: number; idleMs: number; totalMs: number };
  throttleRetryDelaysMs?: readonly number[];
};
/**
 * Root integration: routing.layer(role) replaces only modelInfer(...). Keep withSpokenHistory and actor/browser gates.
 * If supplied, all roles use the same budget object. Without one, dispatch directly to the pinned provider. The Codegraff URL below is the EXISTING local ledger's accounting entrypoint;
 * no request to that URL occurs for a Cerebras role. Only its injected dispatcher sends the selected provider request.
 * This retains reservations (including failed/uncertain calls and compaction), concurrency and stream release behavior.
 * Cerebras wire adaptations do not replace local argument validation: retain existing host tool validators.
 * No semantic retrieval, lexical-as-semantic approximation, training, tool execution or role inference is performed here.
 * Sources: ../unbrowse-playground/runtime/src/agent-browser-agent.ts; installed tardie/src/model/model.ts;
 * https://inference-docs.cerebras.ai/resources/openai and /api-reference/chat-completions.
 */
export function createModelRouting(options: ModelRoutingOptions) {
  if (!safeUserId(options.owner)) throw new Error("Invalid model routing owner");
  // Re-validate supplied structural config; it may have arrived as untrusted JSON at a host boundary.
  const configEnv: Record<string, string> = {};
  if (Object.keys(options.config).some(key => !["roles", "fallbacks", "contextWindowTokens", "maxOutputTokens"].includes(key))) throw new Error("Invalid model routing configuration");
  for (const role of MODEL_ROLES) {
    const route = options.config.roles[role];
    if (!route || !Object.hasOwn(MODEL_PROVIDERS, route.provider) || route.secretEnv !== MODEL_PROVIDERS[route.provider].secretEnv || Object.keys(route).some(k => !["provider", "model", "secretEnv"].includes(k))) throw new Error("Invalid model route configuration");
    configEnv[`AIKO_${role.toUpperCase()}_PROVIDER`] = route.provider;
    configEnv[`AIKO_${role.toUpperCase()}_MODEL`] = route.model;
    const fallbacks = options.config.fallbacks?.[role];
    if (fallbacks) {
      if (fallbacks.some(f => !Object.hasOwn(MODEL_PROVIDERS, f.provider) || f.secretEnv !== MODEL_PROVIDERS[f.provider].secretEnv || Object.keys(f).some(k => !["provider", "model", "secretEnv"].includes(k))))
        throw new Error("Invalid fallback model route");
      configEnv[`AIKO_${role.toUpperCase()}_FALLBACKS`] = JSON.stringify(fallbacks.map(({provider, model}) => ({provider, model})));
    }
  }
  const config = parseModelRouting(configEnv, { contextWindowTokens: options.config.contextWindowTokens, maxOutputTokens: options.config.maxOutputTokens });
  const status = (rawRole: ModelRole): ModelRouteStatus => {
    const role = roleOf(rawRole), route = config.roles[role], key = options.env[route.secretEnv];
    const reason = options.env.AIKO_ALLOW_PAID_INFERENCE !== "true" ? "paid_inference_disabled"
      : !key ? "missing_key"
      : key.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(key) ? "invalid_key" : undefined;
    return { role, ...route, status: reason ? "unavailable" : "configured", ...(reason ? { reason } : {}) };
  };
  const requireRoute = (role: ModelRole) => {
    const result = status(role);
    if (result.status === "unavailable") throw new ModelRoutingUnavailable(result.role, result.provider, result.reason!);
    return result;
  };
  const transport = (role: ModelRole): HttpFetch => {
    const route = requireRoute(role), endpoint = `${MODEL_PROVIDERS[route.provider].baseUrl}/chat/completions`;
    const accountingEndpoint = `${MODEL_PROVIDERS.codegraff.baseUrl}/chat/completions`;
    return async (input, init) => {
      requireRoute(role);
      if (String(input) !== endpoint || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 262144) throw new ModelRoutingUnavailable(role, route.provider, "request_rejected");
      init.signal?.throwIfAborted();
      let body: Record<string, any>;
      try {
        body = JSON.parse(init.body);
        if (!body || typeof body !== "object" || Array.isArray(body) || body.model !== route.model || !Array.isArray(body.messages) || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > config.maxOutputTokens) throw new Error("invalid model request");
        body.messages = orderedToolMessages(body.messages);
        if (route.provider === "cerebras") body = adaptCerebras(body);
        else if (Array.isArray(body.tools)) body = {...body,tools:body.tools.map((tool:any) =>
          tool?.function?.strict === true ? {...tool,function:{...tool.function,parameters:strictWireSchema(tool.function.parameters)}} : tool)};
      } catch { throw new ModelRoutingUnavailable(role, route.provider, "request_rejected"); }
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > 262144) throw new ModelRoutingUnavailable(role, route.provider, "request_rejected");
      const key = options.env[route.secretEnv]!;
      const dispatchInput = options.budget ? accountingEndpoint : endpoint;
      const dispatch: HttpFetch = async (accountingInput, chargedInit) => {
        if (String(accountingInput) !== dispatchInput) throw new Error("Invalid model dispatch endpoint");
        const response = await (options.fetch ?? fetch)(endpoint, {
          ...chargedInit, method: "POST", body: encoded, redirect: "manual",
          signal: options.budget ? chargedInit?.signal : AbortSignal.any([
            ...(chargedInit?.signal ? [chargedInit.signal] : []),
            AbortSignal.timeout(integer(options.stream?.totalMs ?? 60000, 1, 300000)),
          ]),
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          // Let the native adapter retain HTTP status and classify retries. Never retain the provider body.
          const status = response.ok ? 502 : response.status;
          const retryAfter = response.headers.get("retry-after");
          return Response.json({ error: { message: `Model provider HTTP ${status}` } }, {
            status: status >= 300 && status < 400 ? 400 : status,
            ...(retryAfter && /^(?:\d+(?:\.\d+)?|[A-Za-z]{3}, [\d A-Za-z:]+ GMT)$/.test(retryAfter)
              ? { headers: { "retry-after": retryAfter } } : {}),
          });
        }
        return response;
      };
      try {
        const send = options.budget ? options.budget.transport(options.owner, dispatch) : dispatch;
        // No credential is needed by the local accounting middleware. Dispatcher attaches it only at pinned egress.
        return await send(dispatchInput, { ...init, body: encoded, headers: { "Content-Type": "application/json" }, redirect: "manual" });
      } catch { throw new ModelRoutingUnavailable(role, route.provider, "transport_or_budget_unavailable"); }
    };
  };
  const layer = (role: ModelRole): Layer.Layer<Infer> => {
    const route = requireRoute(role);
    const stream = options.stream ?? { firstChunkMs: 20000, idleMs: 20000, totalMs: 60000 };
    for (const value of [stream.firstChunkMs, stream.idleMs, stream.totalMs]) integer(value, 1, 300000);
    const native = modelInfer({
      provider: route.provider, baseUrl: MODEL_PROVIDERS[route.provider].baseUrl, apiKey: options.env[route.secretEnv]!, model: route.model,
      protocol: "openai-chat-completions", contextWindowTokens: route.provider === "cerebras" ? Math.min(config.contextWindowTokens, 32768) : config.contextWindowTokens, maxOutputTokens: config.maxOutputTokens,
      maxTokensLadder: [config.maxOutputTokens],
      throttleRetryDelaysMs: options.throttleRetryDelaysMs ?? DEFAULT_MODEL_RETRY_DELAYS_MS,
      fetch: transport(role),
      stream,
    }, modelAdapters(openAICompatibleAdapter));
    // Reject model overrides from a request before I/O; choosing a role never grants another model/provider.
    return Layer.effect(Infer, Effect.gen(function* () {
      const binding = yield* Infer;
      return { ...binding, react: (request: InferRequest, key?: string, signal?: AbortSignal) => {
        if (request.model && (request.model.provider !== route.provider || request.model.model_id !== route.model))
          return Effect.succeed({ kind: "fail" as const, error: "Model request override is outside the configured role" });
        const current = status(role);
        if (current.status !== "configured") return Effect.succeed({ kind: "fail" as const, error: new ModelRoutingUnavailable(role, route.provider, current.reason!).message });
        return Effect.gen(function* () {
          let action = yield* binding.react(request, key, signal);
          const usage: Usage[] = [];
          let missingUsage = false, attemptedFallback = false;
          const remember = (part: Usage | undefined) => {
            if (part && Number.isFinite(part.promptTokens) && Number.isFinite(part.completionTokens)) usage.push(part);
            else missingUsage = true;
          };
          remember(action.usage);
          for (const fallback of config.fallbacks?.[role] ?? []) {
            // A fallback is another inference attempt, never a replay of a tool or a refusal bypass.
            if (signal?.aborted || action.kind !== "fail" ||
                !(action.failure?.cause === "inference_attempts_exhausted" ||
                  (action.failure?.cause === "inference_error" && /\b(?:404|408|429|5\d\d)\b/.test(action.error)))) break;
            const next = createModelRouting({ ...options,
              config: { ...config, fallbacks: undefined, roles: { ...config.roles, [role]: fallback } },
            });
            if (next.status(role).status !== "configured") continue;
            attemptedFallback = true;
            action = yield* Effect.gen(function* () {
              const infer = yield* Infer;
              return yield* infer.react({ ...request, model: { provider: fallback.provider, model_id: fallback.model } }, key, signal);
            }).pipe(Effect.provide(next.layer(role)));
            remember(action.usage);
          }
          if (!attemptedFallback || !usage.length) return action;
          const total = sumUsage(usage);
          if (missingUsage) {
            // Known token reports remain useful; an unreported attempt prevents a complete cost claim.
            const { costUsd, costSource, reportedCostUsd, estimatedCostUsd, ...known } = total;
            return { ...action, usage: known };
          }
          return { ...action, usage: total };
        });
      } };
    })).pipe(Layer.provide(native));
  };
  return { config, status, transport, layer };
}
