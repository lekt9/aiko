#!/usr/bin/env bun
// CHECK B / C / D analyzer for e2e/telegram-selfwire-gate.sh.
//
// Everything asserted here comes from state that outlives the process that
// produced it: rows in the run's own SQLite store, and the Bot API fixture's
// recorded HTTP requests. Nothing reads a log line, and nothing trusts the
// bridge's own report of what it sent — the `dispatch` row's `method` field
// is written from TELEGRAM_REPLY_VERBS while the bytes go out through a
// separate `senders` table (packages/integrations/src/telegram/reply.js:198-205),
// so a router that reports one verb and calls another is a real defect shape.
// CHECK C therefore reads the WIRE, and the gate's second falsification leg
// is exactly that mutation.
//
//   assert-arc.js --db <path> --run-id <id> --chat-id <id> --plan <plan.json>
//                 --expect-status <finished|waiting-event> [--expect-verbs-from-wire]
//
// plan.json: [{ turn, kind, verb, filename?, requests }] in turn order, where
// `requests` is that turn's own /requests capture (the gate resets the fixture
// recorder between turns, so each window contains one turn and nothing else).
//
// Exits 0 printing EVIDENCE lines; on failure prints "CHECK_<X> FAIL: ..." and
// exits 1, so a red leg names the check that owns the claim.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const SEND_VERBS = ["sendMessage", "sendPhoto", "sendVideo", "sendAudio", "sendVoice", "sendDocument"];

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
/**
 * @param {string} check
 * @param {string} message
 * @returns {never}
 */
function fail(check, message) {
  console.log(`CHECK_${check} FAIL: ${message}`);
  process.exit(1);
}

for (const required of ["db", "run-id", "chat-id", "plan", "expect-status"]) {
  if (!flags[required]) fail("B", `missing --${required}`);
}
const runId = flags["run-id"];
const chatId = flags["chat-id"];
const plan = JSON.parse(readFileSync(flags.plan, "utf8"));
const db = new Database(flags.db, { readonly: true });

// ---------------------------------------------------------------------------
// CHECK B — the wire is DURABLE: a run row plus one typed union per turn.
// ---------------------------------------------------------------------------
const run = db.query("SELECT run_id, workflow_name, status FROM _smithers_runs WHERE run_id = ?").get(runId);
if (!run) fail("B", `no _smithers_runs row for ${runId} — nothing durable survived the run`);
if (run.workflow_name !== "telegram-aiko-bridge") fail("B", `run row workflow_name=${JSON.stringify(run.workflow_name)}`);
if (run.status !== flags["expect-status"]) {
  fail("B", `run row status=${JSON.stringify(run.status)}, expected ${JSON.stringify(flags["expect-status"])}`);
}
console.log(`EVIDENCE[CHECK_B/run]: durable run row ${JSON.stringify(run)}`);

const replyRows = db.query("SELECT * FROM reply WHERE run_id = ? ORDER BY iteration").all(runId);
if (replyRows.length !== plan.length) {
  fail("B", `expected ${plan.length} typed worker-output row(s) in table \`reply\`, found ${replyRows.length}`);
}
for (const [index, row] of replyRows.entries()) {
  const step = plan[index];
  const replies = JSON.parse(row.replies);
  if (!Array.isArray(replies) || replies.length !== 1) {
    fail("B", `turn ${step.turn}: worker output is not a one-element union: ${row.replies}`);
  }
  if (replies[0].kind !== step.kind) {
    fail("B", `turn ${step.turn}: typed union carries kind=${JSON.stringify(replies[0].kind)}, expected ${step.kind}`);
  }
  if (String(row.chat_id) !== chatId) fail("B", `turn ${step.turn}: reply row chat_id=${row.chat_id}, expected ${chatId}`);
  if (row.node_id !== "worker") fail("B", `turn ${step.turn}: reply row came from node ${JSON.stringify(row.node_id)}`);
}
console.log(
  `EVIDENCE[CHECK_B/union]: ${replyRows.length} durable typed union row(s), kinds=` +
    JSON.stringify(replyRows.map((row) => JSON.parse(row.replies)[0].kind)),
);

const dispatchRows = db.query("SELECT * FROM dispatch WHERE run_id = ? ORDER BY iteration").all(runId);
if (dispatchRows.length !== plan.length) {
  fail("B", `expected ${plan.length} router row(s) in table \`dispatch\`, found ${dispatchRows.length}`);
}
console.log(
  `EVIDENCE[CHECK_B/router-rows]: ${dispatchRows.length} durable dispatch row(s), reported methods=` +
    JSON.stringify(dispatchRows.map((row) => JSON.parse(row.dispatched)[0]?.method)),
);

// ---------------------------------------------------------------------------
// CHECK C — CAPABILITY COMPLETENESS, read off the wire, one window per turn.
// ---------------------------------------------------------------------------
const wireSummary = [];
for (const [index, step] of plan.entries()) {
  const recorded = JSON.parse(readFileSync(step.requests, "utf8"));
  const order = recorded.order.filter((method) => method !== "getUpdates");
  const sends = order.filter((method) => SEND_VERBS.includes(method));
  const actions = recorded.requests.filter((entry) => entry.method === "sendChatAction");
  if (sends.length !== 1) {
    fail("C", `turn ${step.turn} (${step.kind}): expected exactly one send verb on the wire, saw ${JSON.stringify(order)}`);
  }
  if (sends[0] !== step.verb) {
    fail(
      "C",
      `turn ${step.turn}: kind ${step.kind} put ${sends[0]} on the wire, expected ${step.verb}` +
        ` (durable row reported ${JSON.parse(dispatchRows[index].dispatched)[0]?.method}) — wire order ${JSON.stringify(order)}`,
    );
  }
  const firstAction = order.indexOf("sendChatAction");
  const firstSend = order.findIndex((method) => SEND_VERBS.includes(method));
  if (firstAction === -1) fail("C", `turn ${step.turn} (${step.kind}): no typing indicator was sent at all`);
  if (firstAction > firstSend) {
    fail("C", `turn ${step.turn}: typing did not precede the send; order=${JSON.stringify(order)}`);
  }
  if (actions.length < 2) {
    fail(
      "C",
      `turn ${step.turn}: ${actions.length} chat action(s) — the indicator was sent but never REFRESHED, ` +
        `so a turn longer than Telegram's ~5s expiry would go silent`,
    );
  }
  if (!actions.every((entry) => entry.body?.action === "typing" && String(entry.body?.chat_id) === chatId)) {
    fail("C", `turn ${step.turn}: a chat action carried the wrong action/chat: ${JSON.stringify(actions.map((e) => e.body))}`);
  }
  const sent = recorded.requests.find((entry) => entry.method === step.verb);
  if (String(sent?.body?.chat_id) !== chatId) {
    fail("C", `turn ${step.turn}: ${step.verb} addressed chat ${JSON.stringify(sent?.body?.chat_id)}, expected ${chatId}`);
  }
  if (step.kind === "text") {
    if (typeof sent?.body?.text !== "string" || sent.body.text.length === 0) {
      fail("C", `turn ${step.turn}: sendMessage carried no text`);
    }
  } else {
    const attachment = sent?.body?.[step.kind];
    if (!(sent?.contentType ?? "").includes("multipart/form-data")) {
      fail("C", `turn ${step.turn}: ${step.verb} was not a multipart upload (contentType=${sent?.contentType})`);
    }
    if (!attachment || attachment.filename !== step.filename || !(attachment.size > 0)) {
      fail(
        "C",
        `turn ${step.turn}: multipart field "${step.kind}" is ${JSON.stringify(attachment)}, expected filename ${step.filename} with bytes`,
      );
    }
  }
  wireSummary.push(`${step.kind}->${sends[0]}(${actions.length} typing)`);
  console.log(
    `EVIDENCE[CHECK_C/turn${step.turn}]: ${step.kind} → ${sends[0]}, wire order ${JSON.stringify(order)}` +
      (step.kind === "text" ? "" : `, multipart ${step.kind}=${sent.body[step.kind].filename} (${sent.body[step.kind].size}B)`),
  );
}
const covered = new Set(plan.map((step) => step.kind));
console.log(
  `EVIDENCE[CHECK_C]: ${covered.size} reply kind(s) covered end to end — ${wireSummary.join(", ")}` +
    ` — every verb read off the fixture's recorded requests, not from a row or a log`,
);

// ---------------------------------------------------------------------------
// CHECK D — RIGHT LAYER: the Aiko worker node actually executed, per turn.
// ---------------------------------------------------------------------------
const workerNodes = db
  .query("SELECT node_id, iteration, state FROM _smithers_nodes WHERE run_id = ? AND node_id = ? ORDER BY iteration")
  .all(runId, "worker");
const finished = workerNodes.filter((node) => node.state === "finished");
if (finished.length !== plan.length) {
  fail(
    "D",
    `expected ${plan.length} finished \`worker\` node row(s) (the Aiko task), found ${finished.length} of ` +
      `${workerNodes.length}: ${JSON.stringify(workerNodes)}`,
  );
}
const typingNodes = db
  .query("SELECT COUNT(*) AS n FROM _smithers_nodes WHERE run_id = ? AND node_id = 'typing' AND state = 'finished'")
  .get(runId);
console.log(
  `EVIDENCE[CHECK_D/nodes]: ${finished.length} finished \`worker\` node row(s) (iterations ` +
    `${finished.map((node) => node.iteration).join(",")}) and ${typingNodes.n} finished \`typing\` node row(s)`,
);

const typingRows = db.query("SELECT * FROM typing WHERE run_id = ? ORDER BY iteration").all(runId);
if (typingRows.length !== plan.length) fail("D", `expected ${plan.length} typing row(s), found ${typingRows.length}`);
for (const row of typingRows) {
  if (row.sent < 2 || row.refreshes < 1) fail("D", `typing row shows no refresh: ${JSON.stringify(row)}`);
}
console.log(
  `EVIDENCE[CHECK_D/typing]: durable typing rows ` +
    JSON.stringify(typingRows.map((row) => ({ it: row.iteration, sent: row.sent, refreshes: row.refreshes }))),
);
