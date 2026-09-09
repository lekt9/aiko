import type {Event} from "tardie/core/event";
import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { ActorConnectorBinding } from "./capability-builder-connectors.ts";
import { connectionMiniAppUrl } from "./telegram-mini-app.ts";

export function connectorLoginEventKey(e:Event):string|undefined {
  return ["AikoLoginProgress","AikoLoginSubmitted","AikoLoginAttemptFailed"].includes(e.type)&&typeof e.owner==="string"&&typeof e.id==="string"?`aiko-login:observation:${e.owner}:${e.type}:${e.id}`:undefined;
}

/** Login prompts are native durable effects, separate from the model's final reply. */
export function connectorLoginNotifications(binding: ActorConnectorBinding) {
  return component({
    name: "aiko.connector-login",
    keys: {
      prefixes: ["aiko-login:"],
      keyOf: (e) => connectorLoginEventKey(e) ?? (
        ["AikoLoginNoticeStarted", "AikoLoginNoticeSettled"].includes(e.type) &&
        e.owner === binding.owner &&
        typeof e.connectionId === "string"
          ? `aiko-login:${e.type}:${e.noticeId ?? e.connectionId}`
          : undefined),
    },
    initial: () => ({
      telegram: false,
      pending: new Set<string>(),
      settled: new Set<string>(),
      activeAttempts: new Map<string,string>(),
      terminalAttempts: new Set<string>(),
      notices: new Map<string,{connectionId:string;attemptId:string;challengeId?:string;kind:"challenge"|"complete"}>(),
    }),
    step: (s, e) => {
      const n = {
        ...s,
        pending: new Set(s.pending),
        settled: new Set(s.settled),
        notices: new Map(s.notices),
        activeAttempts: new Map(s.activeAttempts),
        terminalAttempts: new Set(s.terminalAttempts),
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
      if(typeof e.attemptId === "string") {
        if(e.type === "AikoLoginOperationRequested" || e.type === "AikoPrivateLoginObserved" && e.kind === "opening") {
          if(n.terminalAttempts.has(e.attemptId))return n;
          const previous=n.activeAttempts.get(e.connectionId);
          if(previous && previous!==e.attemptId)n.terminalAttempts.add(previous);
          n.activeAttempts.set(e.connectionId,e.attemptId);
        }
        if(e.type === "AikoLoginOperationCancelled" || e.type === "AikoLoginOperationCleanupSettled" || e.type === "AikoPrivateLoginObserved" && e.kind === "disconnected") {
          n.terminalAttempts.add(e.attemptId);
          for(const [id,notice] of n.notices)if(notice.attemptId===e.attemptId)n.pending.delete(id);
        }
        if(e.type === "AikoPrivateLoginObserved" && e.kind === "challenge") {
          if(n.terminalAttempts.has(e.attemptId) || n.activeAttempts.has(e.connectionId) && n.activeAttempts.get(e.connectionId)!==e.attemptId)return n;
          n.activeAttempts.set(e.connectionId,e.attemptId);
        }
        if(e.type === "AikoLoginOperationVerified")n.terminalAttempts.add(e.attemptId);
      }
      if (e.type === "AikoConnectionChanged") {
        if (e.status === "pending") n.pending.add(e.connectionId);
        else n.pending.delete(e.connectionId);
      }
      if (e.type === "AikoLoginRequested") n.pending.add(e.connectionId);
      if ((e.type === "AikoPrivateLoginObserved" && e.kind === "challenge" || e.type === "AikoLoginOperationVerified") && typeof e.attemptId === "string") {
        const kind=e.type === "AikoLoginOperationVerified" ? "complete" as const : "challenge" as const;
        const noticeId=`${e.connectionId}:${e.attemptId}:${kind === "challenge" ? e.challengeId : "complete"}`;
        n.pending.delete(e.connectionId);
        for(const [id,notice] of n.notices)if(notice.connectionId===e.connectionId)n.pending.delete(id);
        n.notices.set(noticeId,{connectionId:e.connectionId,attemptId:e.attemptId,...(typeof e.challengeId === "string" ? {challengeId:e.challengeId} : {}),kind});
        n.pending.add(noticeId);
      }
      if (e.type === "AikoLoginNoticeSettled") {
        n.settled.add(String(e.noticeId ?? e.connectionId));
        n.pending.delete(String(e.noticeId ?? e.connectionId));
      }
      return n;
    },
    output: (s) => {
      const connectionId = [...s.pending].find((id) => !s.settled.has(id));
      if (!s.telegram || !/^[1-9][0-9]*$/.test(binding.owner) || !connectionId)
        return { view: undefined, transitions: [] };
      const notice=s.notices.get(connectionId);
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
                    connectionId: notice?.connectionId ?? id,
                    ...(notice ? {noticeId:id,attemptId:notice.attemptId,...(notice.challengeId ? {challengeId:notice.challengeId} : {})} : {}),
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
                      (e.noticeId ?? e.connectionId) === id,
                  )
                )
                  return receipt("unknown");
                yield* log.append([
                  {
                    type: "AikoLoginNoticeStarted",
                    owner: binding.owner,
                    connectionId: notice?.connectionId ?? id,
                    ...(notice ? {noticeId:id,attemptId:notice.attemptId,...(notice.challengeId ? {challengeId:notice.challengeId} : {})} : {}),
                    at: Date.now(),
                  },
                ]);
                const status = yield* Effect.tryPromise(async () => {
                  const connection = (await (binding.engine.connectionSnapshot?.() ?? binding.engine.connections())).find(
                    (c) => c.id === (notice?.connectionId ?? id),
                  );
                  if (connection?.status !== (notice?.kind === "complete" ? "connected" : "pending")) return "superseded";
                  const webAppUrl = connectionMiniAppUrl(
                    notice?.connectionId ?? id,
                    binding.miniAppUrl,
                  );
                  const name =
                    connection.appName ??
                    connection.connectorId.replace(/^(browser|arcade):/, "");
                  const result = await binding.deliverConnection(
                    {
                      owner: binding.owner,
                      text: notice?.kind === "challenge" ? `${name} needs a verification code. Open the sign-in panel to continue.` : notice?.kind === "complete" ? `Sign-in to ${name} is verified.` : `Sign in to ${name} to continue with Aiko.`,
                      buttons: [[{ text: notice?.kind === "complete" ? "Open connection" : "Sign in", webAppUrl }]],
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
