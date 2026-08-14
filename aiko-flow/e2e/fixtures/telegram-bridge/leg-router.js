#!/usr/bin/env bun
// TIER 1, leg A/B: the capability router and the refreshable typing
// indicator, against the REAL Bot API fixture over real HTTP. No token, no
// network beyond loopback.
//
// Every check prints "CHECK <NAME>: ..." and the process exits nonzero
// NAMING the first failed check, so the witness's falsification legs can
// assert which check caught a mutation.
//
// --router / --typing accept a module path so the falsification legs can
// point the IDENTICAL checks at a deliberately broken copy of the router or
// the keepalive. Same assertions, mutated subject: that is what makes the
// green run mean something.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { startTelegramFixture } from "../../../packages/integrations/tests/telegram-fixture.js";
import { makeTelegramClient } from "../../../packages/integrations/src/telegram/TelegramClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const telegramSrc = join(here, "..", "..", "..", "packages", "integrations", "src", "telegram");

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=");
    flags[name] = inline ?? argv[++index] ?? "";
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const routerPath = flags.router ?? join(telegramSrc, "reply.js");
const typingPath = flags.typing ?? join(telegramSrc, "typing.js");
const { dispatchTelegramReplies, TELEGRAM_REPLY_VERBS } = await import(routerPath);
const { withTypingIndicator } = await import(typingPath);

let failed = null;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function check(name, ok, detail) {
  console.log(`CHECK ${name}: ${ok ? "ok" : "FAIL"} — ${detail}`);
  if (!ok && !failed) {
    failed = name;
  }
}

const fixture = startTelegramFixture();
const client = makeTelegramClient({ botToken: fixture.token, apiBaseUrl: fixture.apiBaseUrl });
const assets = join(here, "assets");
const CHAT_ID = "9911";
const SEND_VERBS = ["sendMessage", "sendPhoto", "sendVideo", "sendAudio", "sendVoice", "sendDocument"];

/** kind → [verb, asset, expected content type] */
const EXPECTED = {
  text: ["sendMessage", null, null],
  photo: ["sendPhoto", join(assets, "reply.png"), "image/png"],
  video: ["sendVideo", join(assets, "reply.mp4"), "video/mp4"],
  audio: ["sendAudio", join(assets, "reply.mp3"), "audio/mpeg"],
  voice: ["sendVoice", join(assets, "reply.ogg"), "audio/ogg"],
};

try {
  // --- A. one kind → one verb, with the right multipart field ------------
  for (const [kind, [verb, assetPath, contentType]] of Object.entries(EXPECTED)) {
    const before = fixture.requests.length;
    const reply =
      kind === "text"
        ? { kind, text: `hello from ${kind}`, parseMode: "none" }
        : { kind, path: assetPath, caption: kind === "photo" ? "fixture caption" : null };
    const result = await dispatchTelegramReplies(client, CHAT_ID, [reply]);
    const emitted = fixture.requests.slice(before);
    const sends = emitted.filter((entry) => SEND_VERBS.includes(entry.method));
    check(
      `ROUTER_VERB[${kind}]`,
      sends.length === 1 && sends[0].method === verb,
      `expected exactly one ${verb}; got ${JSON.stringify(sends.map((entry) => entry.method))}`,
    );
    check(
      `ROUTER_METHOD_REPORTED[${kind}]`,
      result.dispatched[0]?.method === verb && result.kinds[0] === kind,
      `dispatch row says ${JSON.stringify({ kind: result.kinds[0], method: result.dispatched[0]?.method })}`,
    );
    const body = sends[0]?.body ?? {};
    if (kind === "text") {
      check(
        "FIELD_SHAPE[text]",
        body.text === "hello from text" && !(sends[0]?.contentType ?? "").includes("multipart"),
        `sendMessage body=${JSON.stringify(body).slice(0, 120)}`,
      );
    } else {
      const attachment = body[kind];
      const expectedName = assetPath.split("/").pop();
      check(
        `FIELD_SHAPE[${kind}]`,
        (sends[0]?.contentType ?? "").includes("multipart/form-data") &&
          attachment != null &&
          attachment.filename === expectedName &&
          attachment.type === contentType &&
          attachment.size > 0 &&
          String(body.chat_id) === CHAT_ID,
        `field "${kind}"=${JSON.stringify(attachment)} chat_id=${JSON.stringify(body.chat_id)} ct=${sends[0]?.contentType}`,
      );
    }
    check(
      `VERB_TABLE[${kind}]`,
      TELEGRAM_REPLY_VERBS[kind] === verb,
      `TELEGRAM_REPLY_VERBS.${kind}=${TELEGRAM_REPLY_VERBS[kind]}`,
    );
  }

  // --- B. the bridge owns the destination --------------------------------
  {
    const before = fixture.requests.length;
    await dispatchTelegramReplies(client, CHAT_ID, {
      // A worker naming a chat it was never talking to must not be obeyed.
      chatId: "1000000001",
      replies: [{ kind: "text", text: "who am I talking to", parseMode: "none" }],
    });
    const sent = fixture.requests.slice(before).find((entry) => entry.method === "sendMessage");
    check(
      "CHAT_ID_FROM_BRIDGE",
      String(sent?.body?.chat_id) === CHAT_ID,
      `sent to chat_id=${JSON.stringify(sent?.body?.chat_id)}, worker asked for 1000000001`,
    );
  }

  // --- C. typing: sent BEFORE the turn, refreshed DURING it ---------------
  {
    const before = fixture.requests.length;
    const turnMs = Number(flags["turn-ms"] ?? 1100);
    const intervalMs = Number(flags["typing-interval-ms"] ?? 300);
    const started = Date.now();
    const { typing } = await withTypingIndicator(
      client,
      CHAT_ID,
      async () => {
        // A simulated long agent turn: longer than Telegram's ~5s action
        // expiry scaled down, so a single action provably cannot cover it.
        await new Promise((resolve) => setTimeout(resolve, turnMs));
        return "turn done";
      },
      { intervalMs, maxMs: turnMs * 4 },
    );
    await dispatchTelegramReplies(client, CHAT_ID, [{ kind: "text", text: "reply after turn", parseMode: "none" }]);
    const window = fixture.requests.slice(before);
    const order = window.map((entry) => entry.method);
    const actions = window.filter((entry) => entry.method === "sendChatAction");
    const firstAction = order.indexOf("sendChatAction");
    const firstSend = order.findIndex((method) => SEND_VERBS.includes(method));
    const expectedRefreshes = Math.floor(turnMs / intervalMs) - 1;
    check(
      "TYPING_BEFORE_TURN",
      firstAction === 0 && firstAction < firstSend,
      `arrival order=${JSON.stringify(order)}`,
    );
    check(
      "TYPING_REFRESHED_DURING_TURN",
      actions.length >= Math.max(2, expectedRefreshes) && typing.refreshes >= 1,
      `${actions.length} chat actions in ${typing.elapsedMs}ms (refreshes=${typing.refreshes}, need >= ${Math.max(2, expectedRefreshes)} over a ${turnMs}ms turn at ${intervalMs}ms)`,
    );
    check(
      "TYPING_ACTION_BODY",
      actions.every((entry) => entry.body?.action === "typing" && String(entry.body?.chat_id) === CHAT_ID),
      `bodies=${JSON.stringify(actions.map((entry) => entry.body)).slice(0, 160)}`,
    );
    check(
      "TYPING_STOPS_WITH_TURN",
      typing.elapsedMs < turnMs * 2,
      `indicator held ${typing.elapsedMs}ms for a ${turnMs}ms turn (must not outlive it)`,
    );
    check("TYPING_TURN_ELAPSED", Date.now() - started >= turnMs, `turn ran ${Date.now() - started}ms`);
  }

  // --- D. inbound media download (getFile → bytes) ------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), "tg-witness-"));
    const localPath = join(dir, "inbound.png");
    const original = readFileSync(join(assets, "reply.png"));
    writeFileSync(localPath, original);
    try {
      const sent = /** @type {any} */ (
        await Effect.runPromise(
          client.sendPhoto(CHAT_ID, {
            filename: "inbound.png",
            content: new Uint8Array(readFileSync(localPath)),
            contentType: "image/png",
          }),
        )
      );
      const fileId = sent?.photo?.file_id;
      const file = await Effect.runPromise(client.getFile(String(fileId)));
      const bytes = await Effect.runPromise(client.downloadFile(String(fileId)));
      check(
        "MEDIA_DOWNLOAD",
        typeof file.file_path === "string" && file.file_path.length > 0 && bytes.byteLength > 0,
        `getFile(${fileId})→${file.file_path}, downloaded ${bytes.byteLength} bytes`,
      );
      check(
        "MEDIA_DOWNLOAD_ROUTE",
        fixture.calls("downloadFile").some((entry) => entry.body.file_path === file.file_path),
        `fixture saw GET /file/bot<token>/${file.file_path}`,
      );
    } catch (error) {
      check("MEDIA_DOWNLOAD", false, `threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- E. an unknown kind is refused, not silently dropped ----------------
  {
    let refused = false;
    try {
      await dispatchTelegramReplies(client, CHAT_ID, [{ kind: "hologram", path: "/nope" }]);
    } catch {
      refused = true;
    }
    check("UNKNOWN_KIND_REFUSED", refused, "a kind outside the union must throw, never no-op");
  }
} finally {
  fixture.stop();
}

if (failed) {
  console.error(`LEG FAIL: ${failed}`);
  process.exit(1);
}
console.log("LEG PASS: router + typing");
process.exit(0);
