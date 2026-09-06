import { turnEpochOf, turnTerminalOf } from "tardie/code/execution/turns";
import { randomUUID } from "node:crypto";
import { memoryGraph } from "entity-learn/cloudflare";
import { browserMemoryGraph, browserGraphEvent } from "./browser-memory-graph.ts";
import type { Event } from "tardie/core/event";
import type { BunHost } from "tardie/bun/host";
import type { AikoConfig } from "./config.ts";
import { backgroundThread, threadBinding } from "./account-binding.ts";
import { memorySnapshot } from "./learning.ts";
import { openMemory, type MemoryBinding } from "./memory.ts";
import { boundedText } from "./security.ts";
import type { AikoEvent } from "./actor.ts";

type Context = {
  host: Pick<
    BunHost,
    "threads" | "read" | "readPage" | "commitRoot" | "self" | "wake"
  >;
  config: AikoConfig;
  principal: { owner: string; scopes: readonly string[]; operator: boolean };
  request: Request;
  url: URL;
  redact: (value: string) => string;
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  validOwner: (id: string) => boolean;
  memoryBindingFor: (owner: string) => MemoryBinding;
};
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

/** Operator inspection is explicit and separate from the account plane. Account grants never select another owner. */
export async function controlApi(c: Context): Promise<Response> {
  const { host, principal, url, request, config } = c;
  const registered = (await host.threads()).filter((t) => threadBinding(t));
  const allowed = (owner: string) =>
    c.validOwner(owner) && (principal.operator || owner === principal.owner);
  if (url.pathname === "/api/control/accounts" && request.method === "GET") {
    const accounts = [
      ...new Set(registered.map((t) => threadBinding(t)!.owner)),
    ].filter(allowed);
    if (!accounts.includes(principal.owner)) accounts.unshift(principal.owner);
    return json({
      operator: principal.operator,
      writable: principal.scopes.includes("write"),
      accounts: accounts.sort().map((account) => ({
        account,
        foreground: `user-${account}`,
        threads: registered.filter((t) => threadBinding(t)!.owner === account)
          .length,
      })),
    });
  }
  if (url.pathname === "/api/control/hooks" && request.method === "POST") {
    let body: any;
    try {
      body = JSON.parse(await boundedText(new Response(request.body), 512));
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (
      !body ||
      Object.keys(body).sort().join(",") !== "account,paused" ||
      typeof body.account !== "string" ||
      typeof body.paused !== "boolean"
    )
      return json({ error: "invalid_body" }, 400);
    if (!allowed(body.account)) return json({ error: "forbidden" }, 403);
    if (!registered.includes(`user-${body.account}`))
      return json({ error: "not_found" }, 404);
    return c.serialize(async () => {
      const thread = `user-${body.account}`;
      await host.commitRoot(host.self(thread), {
        type: "AikoHooksConfigured",
        id: randomUUID(),
        paused: body.paused,
        at: Date.now(),
      });
      void host.wake(thread).catch(() => undefined);
      return json({ status: "accepted" }, 202);
    });
  }
  if (request.method !== "GET") return json({ error: "not_found" }, 404);
  if (url.pathname === "/api/control/events") {
    const thread = url.searchParams.get("thread") ?? "";
    const bound = threadBinding(thread);
    if (!bound || !allowed(bound.owner))
      return json({ error: "forbidden" }, 403);
    if (!registered.includes(thread)) return json({ error: "not_found" }, 404);
    const after = Number(url.searchParams.get("after") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 100);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return json({ error: "invalid_query" }, 400);
    const rows = await host.readPage(thread, after, limit + 1);
    // Thread logs are already redacted at ingress; reapply current credentials to older history at this boundary.
    const events = rows.slice(0, limit).map((row) => ({
      seq: row.seq,
      event: JSON.parse(c.redact(JSON.stringify(row.event))),
    }));
    return json({
      thread,
      events,
      nextAfter: events.at(-1)?.seq ?? after,
      hasMore: rows.length > limit,
    });
  }
  const account = url.searchParams.get("account") ?? principal.owner;
  if (!allowed(account)) return json({ error: "forbidden" }, 403);
  if (url.pathname === "/api/control/memory-graph") {
    const after = url.searchParams.get("after") ?? undefined;
    const browserAfterText = url.searchParams.get("browserAfter") ?? "0";
    const browserAfter = Number(browserAfterText);
    if ([...url.searchParams.keys()].some(key => !["account", "after", "browserAfter"].includes(key)) ||
      (after !== undefined && !/^obs_[a-f0-9]{64}$/.test(after)) || !/^\d+$/.test(browserAfterText) || !Number.isSafeInteger(browserAfter))
      return json({ error: "invalid_query" }, 400);
    let knowledge: unknown, browser: unknown;
    try {
      const memory = openMemory(c.memoryBindingFor(account));
      try { knowledge = { status: "available", ...memoryGraph(memory, { after, limit: 32 }) }; }
      finally { memory.close(); }
    } catch { knowledge = { status: "unavailable", coverage: "partial", reasons: ["memory_read_failed"] }; }
    try {
      const rows: { seq: number; event: Event }[] = [];
      const reasons = new Set<string>(browserAfter ? ["page_window"] : []);
      let cursor = browserAfter, scanned = 0, bytes = 2, more = false;
      if (registered.includes(`user-${account}`)) do {
        const limit = Math.min(128, 1024 - scanned);
        const page = await host.readPage(`user-${account}`, cursor, limit + 1);
        more = page.length > limit;
        for (const row of page.slice(0, limit)) {
          scanned++; cursor = row.seq;
          if (!browserGraphEvent(row.event)) continue;
          const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
          if (bytes + size > 4 * 1024 * 1024) { reasons.add("event_byte_budget"); continue; }
          rows.push(row); bytes += size;
        }
      } while (more && scanned < 1024);
      if (more) reasons.add("event_window");
      const graph = browserMemoryGraph(rows);
      graph.reasons = [...new Set([...graph.reasons, ...reasons])];
      graph.coverage = graph.reasons.length ? "partial" : "complete";
      browser = { status: "available", ...graph, scanned, after: browserAfter, through: cursor, nextAfter: more ? cursor : null };
    } catch { browser = { status: "unavailable", coverage: "partial", reasons: ["browser_log_read_failed"] }; }
    // Current credential redaction also covers older labels. No source recipes, bodies, inputs or vectors are exposed.
    return json(JSON.parse(c.redact(JSON.stringify({ account, knowledge, browser, readOnly: true, consistency: "independent-snapshots" }))));
  }
  if (url.pathname === "/api/control/memory") {
    const binding = c.memoryBindingFor(account);
    const memory = openMemory(binding);
    try {
      const search = url.searchParams.get("search") ?? "";
      if (search.length > 512) return json({ error: "invalid_query" }, 400);
      const recalled = memory.recall({
        search,
        limit: 30,
        maxBytes: 40_000,
        maxCandidates: 2000,
        depth: 0,
      });
      const snapshot = memorySnapshot(binding);
      return json(
        JSON.parse(
          c.redact(
            JSON.stringify({
              ...recalled,
              sources: memory.sources(),
              root: snapshot.root,
              complete: snapshot.complete,
            }),
          ),
        ),
      );
    } finally {
      memory.close();
    }
  }
  if (url.pathname === "/api/control/threads") {
    const ids = registered.filter((t) => threadBinding(t)!.owner === account);
    const logs = await Promise.all(
      ids.map(async (id) => ({
        id,
        log: (await host.read(id)) as readonly AikoEvent[],
      })),
    );
    const foreground = `user-${account}`;
    const main = logs.find((item) => item.id === foreground)?.log ?? [];
    const paused =
      main.findLast((e) => e.type === "AikoHooksConfigured")?.paused === true;
    const threads = logs.map(({ id, log }) => {
      const role = threadBinding(id)!.role;
      const last = log.at(-1);
      const latestMessage = log.findLast((e) => e.type === "MessageReceived");
      const latestJob =
        role === "foreground"
          ? latestMessage
          : log.findLast((e) =>
              role === "indexer"
                ? ["AikoHookReceived", "AikoIndexRequested", "AikoConnectionIndexRequested"].includes(e.type)
                : e.type === "AikoReflectionRequested",
            );
      const latestTurn =
        role === "reflection" && latestJob
          ? `reflect:${latestJob.id}`
          : latestMessage?.id;
      const error = log.findLast(
        (e) =>
          (e.type === "AikoBackgroundFailed" && e.id === latestJob?.id) ||
          (e.type === "TurnFailed" && e === turnTerminalOf(log, String(latestTurn))),
      );
      const unknown = log.some(
        (e) =>
          e.turn === latestTurn &&
          (e.type === "AikoDeliverySettled" ||
            (e.type === "AikoTelegramActionSettled" &&
              (e.result as any)?.final === true)) &&
          (e.result as any)?.status === "unknown",
      );
      const turns = new Set(),
        indexed = new Set(),
        reflected = new Set(),
        dispatched = new Set();
      for (const e of log) {
        if (e.type === "MessageReceived" && turnTerminalOf(log, String(e.id)))
          turns.add(e.id);
        if (
          [
            "AikoKnowledgeChanged",
            "AikoKnowledgeUnchanged",
            "AikoBackgroundFailed",
          ].includes(e.type)
        )
          indexed.add(e.id);
        if (e.type === "AikoDecisionRecorded") reflected.add(e.id);
        if (e.type === "AikoHookDispatched") dispatched.add(e.id);
      }
      const pending = log.some(
        (e) =>
          (e === latestMessage && e.id === latestTurn && !turns.has(e.id)) ||
          (["AikoHookReceived", "AikoIndexRequested", "AikoConnectionIndexRequested"].includes(e.type) &&
            !(role === "foreground" ? dispatched : indexed).has(e.id)) ||
          (e.type === "AikoReflectionRequested" && !reflected.has(e.id)),
      );
      const failure = !!error && !pending;
      const root = log.findLast(
        (e) =>
          e.type === "AikoKnowledgeChanged" ||
          e.type === "AikoKnowledgeUnchanged" ||
          e.type === "AikoDecisionRecorded",
      )?.root;
      const status =
        paused && role !== "foreground"
          ? "blocked"
          : failure
            ? "failed"
            : pending
              ? "running"
              : unknown
                ? "blocked"
                : "idle";
      return {
        id,
        role,
        visibility: role === "foreground" ? "foreground" : "background",
        status,
        eventCount: log.length,
        updatedAt: typeof last?.at === "number" ? last.at : null,
        summary:
          paused && role !== "foreground"
            ? "Proactive hooks paused"
            : failure
              ? role === "foreground"
                ? "Latest conversation turn failed; inspect its recorded error"
                : "Latest background work failed; inspect its recorded error"
              : unknown
                ? "Telegram delivery outcome unknown"
                : pending
                  ? "Processing durable events"
                  : role === "foreground"
                    ? "One conversation shared by Telegram and the account plane"
                    : role === "indexer"
                      ? "Native entity-learn observations and Merkle changes"
                      : "Private reflection; only validated decisions reach the conversation",
        ...(root ? { root } : {}),
      };
    });
    return json({
      account,
      foreground,
      threads,
      hooks: { paused },
      background: [
        backgroundThread(account, "indexer"),
        backgroundThread(account, "reflection"),
      ],
    });
  }
  return json({ error: "not_found" }, 404);
}
