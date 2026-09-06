import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { ActorConnectorBinding } from "./capability-builder-connectors.ts";
import { connectionMiniAppUrl } from "./telegram-mini-app.ts";

/** Login prompts are native durable effects, separate from the model's final reply. */
export function connectorLoginNotifications(binding: ActorConnectorBinding) {
  return component({
    name: "aiko.connector-login",
    keys: {
      prefixes: ["aiko-login:"],
      keyOf: (e) =>
        ["AikoLoginNoticeStarted", "AikoLoginNoticeSettled"].includes(e.type) &&
        e.owner === binding.owner &&
        typeof e.connectionId === "string"
          ? `aiko-login:${e.type}:${e.connectionId}`
          : undefined,
    },
    initial: () => ({
      telegram: false,
      pending: new Set<string>(),
      settled: new Set<string>(),
    }),
    step: (s, e) => {
      const n = {
        ...s,
        pending: new Set(s.pending),
        settled: new Set(s.settled),
      };
      if (
        e.type === "MessageReceived" &&
        e.source === "telegram" &&
        String(e.chat) === binding.owner &&
        String(e.sender) === binding.owner
      )
        n.telegram = true;
      if (e.owner !== binding.owner || typeof e.connectionId !== "string")
        return n;
      if (e.type === "AikoConnectionChanged") {
        if (e.status === "pending") n.pending.add(e.connectionId);
        else n.pending.delete(e.connectionId);
      }
      if (e.type === "AikoLoginRequested") n.pending.add(e.connectionId);
      if (e.type === "AikoLoginNoticeSettled") {
        n.settled.add(e.connectionId);
        n.pending.delete(e.connectionId);
      }
      return n;
    },
    output: (s) => {
      const connectionId = [...s.pending].find((id) => !s.settled.has(id));
      if (!s.telegram || !/^[1-9][0-9]*$/.test(binding.owner) || !connectionId)
        return { view: undefined, transitions: [] };
      return {
        view: undefined,
        transitions: [
          effect({
            key: `aiko-login:AikoLoginNoticeSettled:${connectionId}`,
            input: connectionId,
            act: (id, signal) =>
              Effect.gen(function* () {
                const self = yield* Self,
                  log = yield* EventLog;
                const receipt = (status: string) => [
                  {
                    type: "AikoLoginNoticeSettled",
                    owner: binding.owner,
                    connectionId: id,
                    status,
                    at: Date.now(),
                  },
                ];
                if (self.actor !== "aiko" || self.thread !== binding.thread)
                  return receipt("rejected");
                const events = yield* log.read;
                // A send without a receipt may already be visible in Telegram. Never resend it.
                if (
                  events.some(
                    (e) =>
                      e.type === "AikoLoginNoticeStarted" &&
                      e.owner === binding.owner &&
                      e.connectionId === id,
                  )
                )
                  return receipt("unknown");
                yield* log.append([
                  {
                    type: "AikoLoginNoticeStarted",
                    owner: binding.owner,
                    connectionId: id,
                    at: Date.now(),
                  },
                ]);
                const status = yield* Effect.tryPromise(async () => {
                  const connection = (await binding.engine.connections()).find(
                    (c) => c.id === id,
                  );
                  if (connection?.status !== "pending") return "superseded";
                  const webAppUrl = connectionMiniAppUrl(
                    id,
                    binding.miniAppUrl,
                  );
                  const name =
                    connection.appName ??
                    connection.connectorId.replace(/^(browser|arcade):/, "");
                  const result = await binding.deliverConnection(
                    {
                      owner: binding.owner,
                      text: `Sign in to ${name} to continue with Aiko.`,
                      buttons: [[{ text: "Sign in", webAppUrl }]],
                    },
                    signal,
                  );
                  return result.status;
                }).pipe(Effect.catch(() => Effect.succeed("unknown")));
                return receipt(status);
              }),
          }),
        ],
      };
    },
  });
}
