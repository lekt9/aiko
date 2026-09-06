import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { NativeTool } from "tardie/component/tool";
import { publicTarget } from "./browser-proxy.ts";
import type { TelegramButton } from "./telegram-outbound.ts";
import type { ConnectorEngine, Connection } from "./connectors.ts";

export interface ActorConnectorBinding {
  owner: string;
  thread: string;
  engine: Pick<ConnectorEngine, "search" | "connect" | "connectBrowser" | "connections" | "execute"> & Partial<Pick<ConnectorEngine, "apps">>;
  miniAppUrl?: string;
  /** Host-only native Mini App buttons; no credential-bearing URL enters the log. */
  deliverConnection: (input: { owner: string; text: string; buttons: TelegramButton[][] }, signal: AbortSignal) => Promise<{ status: "delivered" | "unknown" | "rejected" }>;
}
export function createActorConnectorTools(binding: ActorConnectorBinding): NativeTool<Self | EventLog>[] {
  const definitions = [
    ["connector_search", "Search all Arcade connector catalog entries before recommending a connection or browser fallback. Unavailable does not mean absent.", { query: { type: "string" } }, ["query"]],
    ["connector_recommend", "Queue a sign-in prompt that opens the selected connection in the native Telegram Mini App. Searches Arcade first. Pass exact connectorId from search; for password sign-in pass the explicit domain. Never supply credentials.", { query: { type: "string" }, connectorId: { type: "string" }, domain: { type: "string" } }, ["query"]],
    ["connector_connections", "List this owner's connections without authorization URLs.", {}, []],
    ["connector_execute", "Execute the exact connected Arcade tool for the user's authorized task. Do not repeat uncertain outcomes.", { connectionId: { type: "string" }, toolId: { type: "string", description: "Exact tool ID from the app connection; required for app connections" }, input: { type: "object" } }, ["connectionId", "input"]],
  ] as const;
  return definitions.map(([name, description, properties, required]) => ({
    spec: { name, description, inputSchema: { type: "object", properties, required: [...required], additionalProperties: false } },
    run: (input, context) => Effect.gen(function* () {
      const self = yield* Self;
      const log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread) return { status: "rejected", reason: "owner_binding_mismatch" };
      const events = yield* log.read;
      const current = [...events].reverse().find(e => e.type === "MessageReceived");
      if (name === "connector_recommend" && (!current || current.id !== context.turn || current.source !== "telegram" || String(current.chat) !== binding.owner)) return { status: "rejected", message: "Connection proposals require the current owned Telegram request; use the authenticated Connections UI for this channel" };
      const key = `${context.turn}:${context.callId}`;
      if (name === "connector_recommend" || name === "connector_execute") {
        if (events.some(e => e.type === "AikoConnectorToolStarted" && e.owner === binding.owner && e.key === key)) return { status: "unknown", message: "Prior attempt may have completed; inspect connections or external state before retrying" };
        yield* log.append([{ type: "AikoConnectorToolStarted", owner: binding.owner, key, operation: name, at: Date.now() }]);
      }
      const result = yield* Effect.tryPromise(async () => {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(properties, k))) throw new Error("Invalid arguments");
        const args = input as Record<string, unknown>;
        if (required.some(k => args[k] === undefined)) throw new Error("Missing argument");
        if (name === "connector_connections") return { connections: (await binding.engine.connections()).map(({ authorizationUrl: _secret, ...connection }) => connection) };
        if (name === "connector_execute") {
          if (typeof args.connectionId !== "string" || !args.input || typeof args.input !== "object" || Array.isArray(args.input)) throw new Error("Invalid execute arguments");
          const connection = (await binding.engine.connections()).find(c => c.id === args.connectionId);
          const result = await binding.engine.execute(args.connectionId, args.input as Record<string, unknown>, typeof args.toolId === "string" ? args.toolId : undefined);
          return { ...result, executionEvidence: { toolId: args.toolId ?? connection?.connectorId, status: result.status } };
        }
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 256) throw new Error("Invalid query");
        const requestLogin = (connection: Connection) => {
          if (!connection.authorizationUrl || connection.status !== "pending") return { status: connection.status, connectionId: connection.id };
          const url = publicTarget(connection.authorizationUrl);
          if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid secure authorization URL");
          return { status: connection.status, connectionId: connection.id, loginRequested: true };
        };
        // An explicit host OAuth switch is configuration, not an outage or catalog absence.
        if (name === "connector_recommend" && binding.engine.apps) {
          const apps = await binding.engine.apps(typeof args.domain === "string" ? args.domain : args.query);
          if (apps.oauthEnabled === false) {
            if (!apps.nativeAvailable || !apps.nativeInline || typeof args.domain !== "string")
              return { status: "rejected", message: "OAuth is disabled here. Supply the website domain for the available private sign-in screen." };
            return requestLogin(await binding.engine.connectBrowser(args.domain));
          }
        }
        const search = await binding.engine.search(args.query);
        if (name === "connector_search") return search;
        if (search.status === "unavailable") return search;
        const match = search.connectors.find(c => c.id === args.connectorId);
        const connection = search.status === "available"
          ? match ? await binding.engine.connect(match.id) : undefined
          : search.fallbackAllowed && typeof args.domain === "string" ? await binding.engine.connectBrowser(args.domain) : undefined;
        if (!connection) return { status: "rejected", message: "Choose a discovered Arcade connector; browser fallback requires confirmed absence" };
        return requestLogin(connection);
      }).pipe(Effect.catch(() => Effect.succeed({ status: "unknown", message: "Connector operation could not be confirmed; inspect connection state before retrying" })));
      if ("loginRequested" in result) {
        yield* log.append([{ type: "AikoLoginRequested", owner: binding.owner, connectionId: result.connectionId, at: Date.now() }]);
        return { status: result.status, connectionId: result.connectionId, delivery: "queued", message: "Sign-in prompt queued for the native Telegram Mini App. This is not proof of delivery or authorization." };
      }
      if ("executionEvidence" in result) {
        const evidence = result.executionEvidence;
        if (evidence.toolId) yield* log.append([{ type: "AikoConnectorExecutionSettled", owner: binding.owner, toolId: evidence.toolId, status: evidence.status === "authorization_required" ? "failed" : evidence.status, callId: context.callId, turn: context.turn, at: Date.now() }]);
        const { executionEvidence: _evidence, ...receipt } = result;
        return receipt;
      }
      return result;
    }),
  }));
}
