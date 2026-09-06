import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { boundedText, type HttpFetch } from "./security.ts";
import type { AikoConfig } from "./config.ts";
import type { createService } from "./server.ts";
import {
  serializeTelegramInbound,
  TELEGRAM_ALLOWED_UPDATES,
  type TelegramInbound,
} from "./telegram-normalize.ts";
import { privateDatabaseFile } from "./accounts.ts";

export async function telegramApi(
  token: string,
  method: string,
  body: object,
  signal: AbortSignal,
  transport: HttpFetch = fetch,
) {
  try {
    const response = await transport(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      },
    );
    const value = JSON.parse(await boundedText(response, 512_000));
    if (!response.ok || value?.ok !== true) throw new Error("Rejected");
    return value.result;
  } catch {
    throw new Error(`Telegram ${method} failed`);
  }
}
type Pending = {
  update_id: number;
  owner: string;
  payload: string;
  attempts: number;
  received: number;
};

/** Durable, redacted transport inbox. Tardie still owns all agent execution and effect recovery. */
export function createTelegramPoller(
  config: AikoConfig,
  service: Pick<
    Awaited<ReturnType<typeof createService>>,
    "acceptTelegram" | "prepareTelegram"
  >,
  transport: HttpFetch = fetch,
) {
  if (!config.botToken || !config.webhookSecret)
    throw new Error("Telegram credentials required");
  const token = config.botToken;
  const bot = createHash("sha256")
    .update(token.split(":")[0])
    .digest("hex")
    .slice(0, 24);
  const db = new Database(
    privateDatabaseFile(join(config.stateDir, `telegram-${bot}.sqlite`)),
  );
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), next INTEGER NOT NULL); INSERT OR IGNORE INTO cursor VALUES (1,0); CREATE TABLE IF NOT EXISTS rejected (update_id INTEGER PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS inbox (update_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0)",
  );
  if (
    !(db.query("PRAGMA table_info(inbox)").all() as { name: string }[]).some(
      (column) => column.name === "priority",
    )
  )
    db.exec("ALTER TABLE inbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let errors = 0,
    consecutiveErrors = 0;
  let lastPollAt: number | undefined;
  let inFlight = false,
    flushing = false;
  const request = (body: string) =>
    new Request("http://127.0.0.1/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": config.webhookSecret! },
      body,
    });
  const payload = serializeTelegramInbound;
  const notice = async (owner: string) => {
    try {
      await telegramApi(
        token,
        "sendMessage",
        {
          chat_id: owner,
          text: "This request was not accepted because an account or service limit was reached. Please try later. Use /cancel to stop pending work.",
        },
        controller.signal,
        transport,
      );
    } catch {
      /* A committed rejection is not resent after an uncertain notification. */
    }
  };
  const reject = (id: number, reason: string) =>
    db
      .transaction(() => {
        const result = db
          .query("INSERT OR IGNORE INTO rejected VALUES (?, ?, ?)")
          .run(id, reason, Date.now());
        db.query("DELETE FROM inbox WHERE update_id=?").run(id);
        return result.changes > 0;
      })
      .immediate();
  const flush = async () => {
    if (flushing || controller.signal.aborted) return;
    flushing = true;
    try {
      // One oldest item per account: a busy user cannot block another user's inbox.
      const rows = db
        .query(
          "SELECT * FROM inbox WHERE (priority=1 OR update_id IN (SELECT min(update_id) FROM inbox GROUP BY owner)) AND next_attempt<=? ORDER BY priority DESC, update_id LIMIT 25",
        )
        .all(Date.now()) as Pending[];
      for (const item of rows) {
        controller.signal.throwIfAborted();
        if (
          !db.query("SELECT 1 FROM inbox WHERE update_id=?").get(item.update_id)
        )
          continue;
        try {
          const outcome = await service.acceptTelegram(request(item.payload));
          if (outcome === "busy") {
            db.query(
              "UPDATE inbox SET attempts=attempts+1,next_attempt=? WHERE update_id=?",
            ).run(Date.now() + 1000, item.update_id);
          } else if (outcome === "limited" || outcome === "conflict") {
            if (reject(item.update_id, outcome)) await notice(item.owner);
          } else
            db.transaction(() => {
              if (
                (() => {
                  const update = JSON.parse(item.payload);
                  return (
                    /^\/cancel(?:\s|$)/.test(update.message?.text ?? "") ||
                    update.callback_query?.data === "aiko:cancel"
                  );
                })() &&
                (outcome === "accepted" || outcome === "duplicate")
              ) {
                db.query(
                  "INSERT OR IGNORE INTO rejected SELECT update_id, 'owner_cancelled', ? FROM inbox WHERE owner=? AND update_id<?",
                ).run(Date.now(), item.owner, item.update_id);
                db.query("DELETE FROM inbox WHERE owner=? AND update_id<?").run(
                  item.owner,
                  item.update_id,
                );
              }
              db.query("DELETE FROM inbox WHERE update_id=?").run(
                item.update_id,
              );
            }).immediate();
        } catch {
          errors++;
          db.query(
            "UPDATE inbox SET attempts=attempts+1,next_attempt=? WHERE update_id=?",
          ).run(Date.now() + 5000, item.update_id);
        }
      }
    } finally {
      flushing = false;
    }
  };
  const pollOnce = async () => {
    if (inFlight) throw new Error("Poll already in flight");
    inFlight = true;
    try {
      const offset = (
        db.query("SELECT next FROM cursor WHERE id=1").get() as { next: number }
      ).next;
      const updates: unknown = await telegramApi(
        token,
        "getUpdates",
        {
          offset,
          timeout: 25,
          limit: 25,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        },
        controller.signal,
        transport,
      );
      if (
        !Array.isArray(updates) ||
        updates.length > 25 ||
        updates.some(
          (u) =>
            !Number.isSafeInteger(u?.update_id) ||
            u.update_id < offset ||
            u.update_id >= Number.MAX_SAFE_INTEGER,
        )
      )
        throw new Error("Invalid Telegram batch");
      const prepared: { id: number; inbound?: TelegramInbound }[] = [];
      for (const update of updates)
        prepared.push({
          id: update.update_id,
          inbound: await service.prepareTelegram(
            request(JSON.stringify(update)),
          ),
        });
      const rejectedOwners = db
        .transaction(() => {
          const notify: string[] = [];
          let pending = (
            db.query("SELECT count(*) AS count FROM inbox").get() as {
              count: number;
            }
          ).count;
          for (const item of prepared) {
            if (
              !item.inbound ||
              db
                .query("SELECT 1 FROM rejected WHERE update_id=?")
                .get(item.id) ||
              db.query("SELECT 1 FROM inbox WHERE update_id=?").get(item.id)
            )
              continue;
            const priority =
              !item.inbound.media?.length &&
              /^\/cancel(?:\s|$)/.test(item.inbound.text)
                ? 1
                : 0;
            if (pending >= (priority ? 1100 : 1000)) {
              if (
                db
                  .query(
                    "INSERT OR IGNORE INTO rejected VALUES (?, 'inbox_full', ?)",
                  )
                  .run(item.id, Date.now()).changes
              )
                notify.push(item.inbound.user);
            } else {
              db.query(
                "INSERT INTO inbox (update_id,owner,payload,received,priority) VALUES (?, ?, ?, ?, ?)",
              ).run(
                item.id,
                item.inbound.user,
                payload(item.inbound),
                Date.now(),
                priority,
              );
              pending++;
            }
          }
          if (prepared.length)
            db.query("UPDATE cursor SET next=? WHERE id=1").run(
              Math.max(offset, ...prepared.map((item) => item.id + 1)),
            );
          return notify;
        })
        .immediate();
      // Telegram's next request acknowledges only already-durable inbox items or explicit rejections.
      for (const owner of rejectedOwners) await notice(owner);
      lastPollAt = Date.now();
      consecutiveErrors = 0;
      await flush();
    } finally {
      inFlight = false;
    }
  };
  return {
    pollOnce,
    flush,
    status: () => {
      const queue = db
        .query("SELECT count(*) AS pending, min(received) AS oldest FROM inbox")
        .get() as { pending: number; oldest: number | null };
      return {
        errors,
        consecutiveErrors,
        lastPollAt,
        running: !!running && !controller.signal.aborted,
        pending: queue.pending,
        oldestPendingAt: queue.oldest,
      };
    },
    start: async () => {
      if (running) throw new Error("Poller already running");
      const webhook = await telegramApi(
        token,
        "getWebhookInfo",
        {},
        controller.signal,
        transport,
      );
      if (typeof webhook?.url !== "string" || webhook.url)
        throw new Error("Remove the active webhook explicitly before polling");
      const sleep = (ms: number) =>
        delay(ms, undefined, { signal: controller.signal }).catch(
          () => undefined,
        );
      running = Promise.all([
        (async () => {
          while (!controller.signal.aborted) {
            try {
              await pollOnce();
            } catch {
              if (!controller.signal.aborted) {
                errors++;
                consecutiveErrors++;
              }
            }
            await sleep(
              Math.min(30000, 1000 * 2 ** Math.min(consecutiveErrors, 5)),
            );
          }
        })(),
        (async () => {
          while (!controller.signal.aborted) {
            try {
              await flush();
            } catch {
              if (!controller.signal.aborted) errors++;
            }
            await sleep(500);
          }
        })(),
      ]).then(() => undefined);
    },
    close: async () => {
      controller.abort();
      await running;
      db.close();
    },
  };
}
