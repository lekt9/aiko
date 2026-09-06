export type AikoRequestOptions = { signal?: AbortSignal };
export type AikoAdmission = { status: "accepted" | "duplicate"; id: string };
export type AikoLearningHook = {
  id: string;
  subject: string;
  title: string;
  kind: "entity" | "fact" | "episode" | "skill";
  type: string;
  payload: unknown;
};
export type AikoMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  turn?: string;
  source?: "model" | "template" | "thinkfeel";
};
export type AikoMessages = {
  messages: AikoMessage[];
  pending: string[];
  deliveries: {
    turn: string;
    result: {
      status: "delivered" | "unknown" | "rejected";
      providerId?: string;
    };
  }[];
};
export type AikoObservation = {
  id: string;
  scope: string;
  subject: string;
  title: string;
  type: string;
  payload: unknown;
  producer: { kind: string; reference: string };
};
export type AikoMemoryHit = {
  observation: AikoObservation;
  freshness: string;
  state: string;
};
export type AikoRecall = {
  items: AikoMemoryHit[];
  coverage: "complete" | "partial";
  reasons: string[];
};
export type AikoKnowledgeView = {
  page: { hit: AikoMemoryHit; claims: { text: string; basis: "stated" | "inferred";
    citations: { observation: string; path: (string | number)[]; quote: string }[] }[];
    verification: "quote-presence-only" };
  /** Static escaped snapshot. Embed in an empty-sandbox iframe, never inject model-authored markup into the app DOM. */
  html: string;
};
export class AikoPlaneError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Aiko plane request failed (${status}: ${code})`);
    this.name = "AikoPlaneError";
  }
}

/** Channel-independent, account-bound client. No Telegram SDK, Bun or custody credentials required. */
export function createAikoClient(options: {
  baseUrl: string;
  token: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}) {
  const base = new URL(options.baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  )
    throw new Error(
      "Aiko requires HTTPS or loopback HTTP without URL credentials",
    );
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  const request = async <T>(
    path: string,
    method = "GET",
    body?: object,
    opts?: AikoRequestOptions,
  ): Promise<T> => {
    const token =
      typeof options.token === "function"
        ? await options.token()
        : options.token;
    const response = await (options.fetch ?? globalThis.fetch)(
      new URL(path, base),
      {
        method,
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? 15_000),
          ...(opts?.signal ? [opts.signal] : []),
        ]),
      },
    );
    const value = await response.json();
    if (!response.ok)
      throw new AikoPlaneError(
        response.status,
        /^[a-z_]+$/.test(value?.error ?? value?.status ?? "")
          ? (value.error ?? value.status)
          : "request_failed",
      );
    return value as T;
  };
  return {
    discover: (opts?: AikoRequestOptions) =>
      request<{
        protocol: string;
        methods: { method: string; path: string }[];
      }>("v1", "GET", undefined, opts),
    status: (opts?: AikoRequestOptions) =>
      request<{
        protocol: string;
        account: string;
        mode: "demo" | "live";
        isolation: string;
        model?: string;
        fixtures?: boolean;
        publicWeb?: boolean;
        inferenceUsage?: {
          day: string;
          globalCalls: number;
          accountCalls: number;
          active: number;
          limits: {
            globalPerDay: number;
            accountPerDay: number;
            maxConcurrent: number;
          };
        } | null;
        memory?: {
          logFollower: {
            status: "current" | "partial" | "error" | "not_started";
            after?: number;
          };
        };
      }>("v1/status", "GET", undefined, opts),
    messages: {
      send: (input: { id: string; text: string }, opts?: AikoRequestOptions) =>
        request<AikoAdmission>("v1/messages", "POST", input, opts),
      list: (opts?: AikoRequestOptions) =>
        request<AikoMessages>("v1/messages", "GET", undefined, opts),
      cancel: (id: string, opts?: AikoRequestOptions) =>
        request<{ status: "cancelling" }>("v1/cancel", "POST", { id }, opts),
    },
    hooks: {
      /** Stable producer event ID; account identity comes exclusively from this client's credential. */
      publish: (input: AikoLearningHook, opts?: AikoRequestOptions) =>
        request<AikoAdmission>("v1/hooks", "POST", input, opts),
      /** Forward only an already-committed native BrowserNetworkToolPrepared event. */
      unbrowse: (event: Record<string, unknown>, opts?: AikoRequestOptions) =>
        request<AikoAdmission>("v1/hooks/unbrowse", "POST", event, opts),
    },
    memory: {
      page: (observation: string, opts?: AikoRequestOptions) =>
        request<AikoKnowledgeView>(`v1/memory/knowledge/${encodeURIComponent(observation)}`, "GET", undefined, opts),
      recall: (search: string, opts?: AikoRequestOptions) =>
        request<AikoRecall>(
          `v1/memory/recall?search=${encodeURIComponent(search)}`,
          "GET",
          undefined,
          opts,
        ),
      get: (observation: string, opts?: AikoRequestOptions) =>
        request<AikoMemoryHit>(
          `v1/memory/observations/${encodeURIComponent(observation)}`,
          "GET",
          undefined,
          opts,
        ),
    },
    browser: {
      status: (opts?: AikoRequestOptions) =>
        request<{
          enabled: boolean;
          pending: unknown[];
          observations: unknown[];
        }>("v1/browser", "GET", undefined, opts),
      approve: (id: string, approve: boolean, opts?: AikoRequestOptions) =>
        request<{ status: string }>(
          "v1/browser/approval",
          "POST",
          { id, approve },
          opts,
        ),
    },
  };
}
