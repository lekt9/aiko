import { turnEpochOf, turnTerminalOf } from "tardie/code/execution/turns";
import type { BunHost } from "tardie/bun/host";
import { cancellationRequested } from "tardie/core/method/cancellation";
import { event, voiceAndOutbox, type AikoEvent, type Sender } from "./actor.ts";
import { actor } from "tardie";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Effect } from "effect";
import type { Voice } from "./voice.ts";
import type { ConnectorEngine } from "./connectors.ts";
import type { ModelBudget } from "./model-budget.ts";

export const controlCommand = (text: string) => {
  const value = text.trim();
  if (value.length > 240) return;
  // Exact status-only questions bypass admission to the busy conversation turn.
  if (/^(?:what(?:'|’)?s happening|what is happening|what are you doing|any updates|status update|are you still working)[?!.]*$/i.test(value)) return "status";
  return (
    /^\/(secretary)(?:\s+[^\r\n]+)?$/.exec(value)?.[1] ??
    /^\/(start|help|status|cancel)(?:\s+[A-Za-z0-9_-]+)?$/.exec(value)?.[1] ??
    /^\/(apps|connect|connections|disconnect|discover)(?:\s+[^\r\n]+)?$/.exec(
      value,
    )?.[1]
  );
};

export type TelegramConnectorControls = Pick<
  ConnectorEngine,
  "search" | "connections" | "disconnect" | "discover"
>;

/** Owner-scoped committed facts, not an invented progress estimate. */
export function workStatus(log: readonly AikoEvent[], now = Date.now()): string {
  const pending = log.filter(e => e.type === "MessageReceived" && !turnTerminalOf(log, String(e.id)));
  if (!pending.length) return "Work: no unfinished foreground request is recorded.";
  const active = new Set(pending.map(e => e.id));
  const browser = log.findLast(e => e.type === "AikoBrowserActionStarted" && active.has(e.turn) && !log.some(done => done.type === "AikoBrowserActionFinished" && done.id === e.id));
  const latest = log.findLast(e => active.has(e.turn) && ["ToolCalled", "ToolReturned", "AikoBrowserActionStarted", "AikoBrowserActionFinished"].includes(e.type));
  const age = latest && typeof latest.at === "number" ? ` Last recorded activity: ${Math.max(0, Math.floor((now - latest.at) / 1000))} seconds ago.` : " No tool activity is recorded yet.";
  return `Work: ${pending.length} unfinished request(s). ${browser ? "A browser action is in progress; its result is not confirmed yet." : "The request is still pending or running."}${age} This is a log snapshot, not an estimated completion time. Your work has not been interrupted.`;
}

/** A separate native lane: no inference or browser tools can block control replies. */
export function createControlActor(options: {
  owner: string; voice: Voice; send?: Sender; live: boolean;
  redact: (text: string) => string;
  publish: (events: readonly AikoEvent[]) => Promise<void>;
}) {
  return actor({ name: "aiko", methods: {}, components: [
    voiceAndOutbox(options.owner, options.voice, options.send, { live: options.live, redact: options.redact, requireThinkFeel: options.live }),
    component({
      name: "aiko.control-history",
      initial: () => [] as AikoEvent[],
      step: (events, raw) => [...events, raw as AikoEvent],
      output: events => ({ view: undefined, transitions: events.filter(e => e.type === "AikoDeliverySettled" && !events.some(done => done.type === "AikoControlMirrored" && done.turn === e.turn)).map(settled => effect({
        key: `control-history:${settled.turn}`,
        input: events.filter(e => (e.type === "AikoControlReply" && e.id === settled.turn) || (["AikoReplyPrepared", "AikoDeliverySettled"].includes(e.type) && e.turn === settled.turn)),
        act: rows => Effect.promise(async () => {
          await options.publish(rows.map(e => ({ ...e, controlLane: true })));
          return [event("AikoControlMirrored", { turn: settled.turn })];
        }),
      })) }),
    }),
  ] });
}

/** Do not put ephemeral authorization URLs into persistent control reply events. */
async function connectorControlReply(
  command: string,
  text: string,
  connectors?: TelegramConnectorControls,
  appUrl?: string,
) {
  const argument = text.trim().replace(/^\/\w+\s*/, "");
  let destination =
    "Tap Connect apps in this chat’s menu to open Aiko with your Telegram account.";
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        destination += ` If you have an Aiko account credential, you can also sign in in your browser: ${url.href}`;
    } catch {
      /* Only a public entry URL belongs in a durable reply. */
    }
  }
  if (command === "connect")
    return `${destination} Search for an app, choose Connect and review its authorization page. Never send passwords or API keys in chat. Browser sign-in is offered only after confirmed catalog absence; it does not guarantee a working integration.`;
  if (command === "apps" && !argument)
    return "Which app or website would you like to connect? Send /apps followed by its name or domain, for example /apps github.com. I check Arcade first. Websites outside the catalog may need discovery or a connector built. Never send passwords or tokens.";
  if (!connectors)
    return `Connector search is not configured for this account yet. ${destination} No private apps have been connected by this command.`;
  try {
    if (command === "apps") {
      const result = await connectors.search(argument);
      if (result.status === "unavailable")
        return "The connector catalog could not be checked. Try /apps again later. Browser sign-in is not offered until catalog absence is confirmed.";
      if (result.status === "absent" && result.fallbackAllowed)
        return `No provider was found in the checked catalog. This website needs discovery or a connector built before it can work. Send /discover followed by its domain to request discovery. ${destination} Secure browser sign-in, when configured, happens there. Never send passwords in chat.`;
      if (result.status !== "available" || !result.connectors.length)
        return "No confirmed provider match yet. Try another app name; no connection has been created.";
      return `Available through Arcade:\n${result.connectors
        .slice(0, 8)
        .map((connector) => `• ${connector.name}`)
        .join(
          "\n",
        )}\n\n${destination} Search for the provider and authorize only the access you want. Listing a provider does not connect it.`;
    }
    if (command === "connections") {
      const connections = await connectors.connections();
      return connections.length
        ? `Your connections:\n${connections
            .slice(0, 12)
            .map(
              (connection) =>
                `${connection.connectorId}: ${connection.status}\nID: ${connection.id}`,
            )
            .join(
              "\n",
            )}\n\nUse /disconnect followed by a connection ID to stop Aiko access.`
        : "No connected apps yet. Use /apps followed by an app name or website to check availability.";
    }
    if (command === "disconnect") {
      if (!argument)
        return "Send /disconnect followed by a connection ID from /connections.";
      await connectors.disconnect(argument);
      return "Aiko access disconnected. To revoke the provider’s authorization too, use the provider’s account settings.";
    }
    if (!argument)
      return "Send /discover followed by a website domain. I check Arcade before looking for connector evidence.";
    const discovery = await connectors.discover(argument);
    return discovery.status === "arcade"
      ? `An Arcade provider is available. ${destination} Use first-party authorization to connect.`
      : discovery.status === "unavailable"
        ? "The catalog could not be checked. Discovery is paused; try again later."
        : discovery.status === "discovered"
          ? "Found a candidate connector from available evidence. It needs review before it can execute. The website is not connected yet."
          : "This website needs more evidence or a connector built. The request does not create a working integration.";
  } catch {
    return "The connector request could not be completed. Try again from /apps or refresh the app. No fallback connection is assumed.";
  }
}

/** Authenticated host controls never invoke a model and never accept a caller-selected owner. */
export async function telegramControl(
  host: Pick<BunHost, "read" | "seed" | "commitRoot" | "self">,
  owner: string,
  id: string,
  text: string,
  live: boolean,
  publicWeb: boolean,
  usage?: ReturnType<ModelBudget["status"]>,
  capabilities?: {
    stoppedDraftId?: number;
    messageThreadId?: number;
    sandbox?: boolean;
    media?: boolean;
    voice?: boolean;
    connectors?: TelegramConnectorControls;
    connectorsUrl?: string;
    separateLane?: boolean;
    secretary?: (text: string) => Promise<string>;
  },
) {
  const command = controlCommand(text)!;
  const log = (await host.read(`user-${owner}`)) as AikoEvent[];
  const controlLog = capabilities?.separateLane ? await host.read(`control-${owner}`) as AikoEvent[] : log;
  if ([...log, ...controlLog].some((e) => e.type === "AikoControlReply" && e.id === id))
    return "duplicate" as const;
  const controls = controlLog.filter((e) => e.type === "AikoControlReply");
  if (
    controls.filter((e) => Number(e.at) > Date.now() - 60000).length >= 10 ||
    (command !== "cancel" && controls.length >= 1000)
  )
    return "limited" as const;
  let reply: string;
  if ((command === "secretary" || /^\/start bizChat/.test(text)) && capabilities?.secretary) {
    reply = await capabilities.secretary(text);
  } else if (
    ["apps", "connect", "connections", "disconnect", "discover"].includes(
      command,
    )
  ) {
    reply = await connectorControlReply(
      command,
      text,
      capabilities?.connectors,
      capabilities?.connectorsUrl,
    );
  } else if (command === "cancel") {
    const draft = capabilities?.stoppedDraftId === undefined ? undefined : log.findLast(e =>
      (e.type === "AikoTelegramTypingStarted" || e.type === "AikoTelegramDraftStarted") && e.owner === owner && e.draftId === capabilities.stoppedDraftId &&
      (e.messageThreadId ?? undefined) === capabilities.messageThreadId);
    if (capabilities?.stoppedDraftId !== undefined && (!draft || Number(draft.epoch ?? 0) !== turnEpochOf(log, String(draft.turn)))) return "duplicate" as const;
    const pending = log.filter(e => e.type === "MessageReceived" && !turnTerminalOf(log, String(e.id)) && (!draft || e.id === draft.turn));
    for (const turn of pending) {
      const epoch = turnEpochOf(log, String(turn.id));
      await host.commitRoot(host.self(`user-${owner}`), cancellationRequested({
        invocation: { method: "message", id: String(turn.id), epoch },
        request: `telegram-control:${id}:${turn.id}:${epoch}`,
        cause: "requested", reason: "Cancelled by the owner", at: Date.now(),
      }));
    }
    reply = capabilities?.stoppedDraftId !== undefined ? "Stopped this reply. Completed actions cannot be undone." :
      "Cancellation requested. Earlier requests still in the Telegram queue will be dropped, and active work will be asked to stop. Completed effects cannot be undone.";
  } else if (command === "status") {
    const memory = log.findLast((e) => e.type === "AikoLogMemoryFollowed");
    reply = `Account: ${owner}\nInference: ${live ? "live" : "demo"}${usage ? `\nModel requests today: ${usage.accountCalls}/${usage.limits.accountPerDay} (UTC)` : ""}\nMemory: entity-learn; log sync ${memory?.status ?? "not started"}\n${capabilities?.sandbox ? "Web: query-based search and browser in your own persistent sandbox (created on demand)" : `Public URL reading: ${publicWeb ? "enabled" : "disabled"}`}\nTelegram media: ${capabilities?.media ? "private inspection enabled; format and model limits apply" : "attachments accepted; advanced processing is not configured"}\nVoice replies: ${capabilities?.voice ? "synthetic speech enabled" : "not configured"}\nConnected apps: ${capabilities?.connectors ? "use /apps to search, /connections to check access" : "not configured"}${capabilities?.sandbox ? "" : "\nArbitrary-code VMs: unavailable"}`;
  } else {
    reply = `Hi! I’m Aiko. Your account is ${owner}. ${live ? "I can answer questions and keep cited memory." : "This assistant is in demo mode."} ${capabilities?.sandbox ? "Ask a question to start live web search; you don't need a starting URL. Browser work runs in your own persistent sandbox, created when needed." : publicWeb ? "Send an exact public page URL for me to read." : "Public page reading is disabled."}\n\nYou can send photos, voice/audio, videos, documents, stickers and albums with captions or replies. ${capabilities?.media ? "I inspect supported content and flag any unprocessed or sampled parts." : "Advanced media interpretation is not configured; I won't pretend to see or hear unprocessed files."}${capabilities?.voice ? " Voice replies use synthetic speech." : ""}\n\nYour conversation and memory are separate from other accounts. Use /secretary to connect your Telegram account and enable automatic replies per contact. Use /status for capabilities and /cancel to stop pending work. Never send passwords or tokens. To connect an app, send /apps followed by its name or website (for example /apps github.com). I check Arcade first; websites outside the catalog may need discovery or a connector built. Use /connect for secure onboarding and /connections to check access. ${capabilities?.connectors ? "" : "Connector access is not configured for this account yet."}`;
  }
  if (command === "status") {
    const workers = await Promise.all(([
      ["Learning", `background-${owner}-indexer`, ["AikoHookReceived", "AikoIndexRequested", "AikoConnectionIndexRequested"], ["AikoKnowledgeChanged", "AikoKnowledgeUnchanged", "AikoBackgroundFailed"]],
      ["Reflection", `background-${owner}-reflection`, ["AikoReflectionRequested"], ["AikoDecisionRecorded", "AikoBackgroundFailed"]],
    ] as const).map(async ([label, thread, starts, finishes]) => {
      const events = await host.read(thread) as AikoEvent[];
      const completed = new Set(events.filter(e => (finishes as readonly string[]).includes(e.type)).map(e => e.id));
      const pending = new Set(events.filter(e => (starts as readonly string[]).includes(e.type) && !completed.has(e.id)).map(e => e.id));
      return `${label}: ${pending.size ? `${pending.size} pending job(s)` : "no pending job recorded"}.`;
    }));
    reply = `${workStatus(log)}\n${workers.join("\n")}\n\n${reply}`;
  }
  await host.commitRoot(
    host.self(capabilities?.separateLane ? `control-${owner}` : `user-${owner}`),
    event("AikoControlReply", {
      id,
      text,
      reply,
      source: "telegram",
      chat: owner,
      sender: owner,
      ...(capabilities?.messageThreadId ? { telegram: { messageThreadId: capabilities.messageThreadId } } : {}),
    }),
  );
  return "accepted" as const;
}
