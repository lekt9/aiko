#!/usr/bin/env node
/**
 * harness-learn.mjs — mine .graff agent logs for failure signals and distill
 * evidence-backed "lessons" for the self-learning harness loop.
 *
 * Sources (all under --logs, default `.graff`):
 *   sessions/*.transcript.jsonl  message-level transcript (OpenAI-style roles)
 *   sessions/*.session.json      session title + todo checklist states
 *   traces/*.jsonl               structured events (api/tool latency, retries)
 *   behavior/*.jsonl             codegraff.behavior.v1 turn lifecycle
 *
 * Signals mined:
 *   tool_error    `[error] ...` tool receipts (classified by tool name)
 *   retry_loop    identical tool name+args called repeatedly in one run
 *   harness_retry trace `retry` / `subagent_retry` events
 *   stuck_todo    todos still in_progress/pending when a session ended
 *   turn_stall    behavior turns separated by a long gap
 *
 * Output (under --out, default `artifacts/harness-learn`):
 *   lessons-<stamp>.json  machine-readable, feeds the graff fixer agent
 *   lessons-<stamp>.md    human-readable summary
 *   state.json            fingerprints of lessons already fixed (dedup gate)
 *
 * Subcommand:
 *   mark --pr <url> [--state <file>] [--lessons <file>]
 *       Record the fingerprints of a lessons file as fixed (with PR link) so
 *       future mining runs stop re-reporting them.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const ANSI = /\[[0-9;]*m/g;
const SENSITIVE =
  /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|authorization\s*:\s*\S+)/gi;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const LOGS = path.resolve(flag("logs", ".graff"));
const OUT = path.resolve(flag("out", "artifacts/harness-learn"));
const SINCE_DAYS = Number(flag("since-days", "14"));
const SINCE_MS = Date.now() - SINCE_DAYS * 86400_000;

// ---------- helpers ----------

const sha16 = (s) =>
  createHash("sha1").update(s).digest("hex").slice(0, 16);

function clean(text) {
  return String(text ?? "")
    .replace(ANSI, "")
    .replace(SENSITIVE, "[redacted]");
}

function normalize(text) {
  return clean(text)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "H")
    .replace(/\d+/g, "N")
    .replace(/(?:[^\s/]+\/)+[^\s/]*/g, "P")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function excerpt(text, max = 280) {
  const t = clean(text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function readJsonl(file, visitor) {
  const lines = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  return new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        visitor(JSON.parse(line));
      } catch {
        /* tolerate corrupt lines — logs are append-only */
      }
    });
    lines.on("close", resolve);
    lines.on("error", reject);
  });
}

const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => c?.text ?? "").join("\n")
      : "";

// ---------- signal extraction ----------

const signals = [];
const runsSeen = new Set();
const push = (s) => signals.push({ run: s.run, ...s });

function classifyError(message) {
  // `[error] tool_name: message` for native tool receipts
  const m = /^\[error\]\s*([a-z_][a-z0-9_]{1,40}):\s*([\s\S]+)/i.exec(message);
  if (m) return { tool: m[1], detail: m[2] };
  // bash receipts embed exit codes / stderr instead of a tool name
  if (/\[exit code \d+\]|\[stderr\]/.test(message))
    return { tool: "bash", detail: message };
  return { tool: "unknown", detail: message };
}

async function mineTranscript(file) {
  const run = path.basename(file).replace(/\.transcript\.jsonl$/, "");
  runsSeen.add(run);
  const calls = []; // {name, argsRaw, idx}
  let consecutiveErrors = 0;

  await readJsonl(file, (d) => {
    const role = d.role;
    if (role === "assistant" && Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        calls.push({
          name: tc?.function?.name ?? "?",
          argsRaw: String(tc?.function?.arguments ?? ""),
        });
      }
      consecutiveErrors = 0;
    }
    if (role === "tool") {
      const text = contentText(d.content);
      if (/^\[error\]/.test(text.trim()) || /\[exit code \d+\]/.test(text)) {
        consecutiveErrors += 1;
        const { tool, detail } = classifyError(text.trim());
        push({
          kind: "tool_error",
          tool,
          run,
          file,
          detail: excerpt(detail),
          fingerprintInput: `${tool}::${normalize(detail)}`,
          consecutive: consecutiveErrors,
        });
      } else {
        consecutiveErrors = 0;
      }
    }
  });

  // retry loops: same tool + identical args called more than once
  const byCall = new Map();
  for (const c of calls) {
    const key = `${c.name}::${sha16(c.argsRaw)}`;
    byCall.set(key, [...(byCall.get(key) ?? []), c]);
  }
  for (const [key, group] of byCall) {
    if (group.length >= 2)
      push({
        kind: "retry_loop",
        tool: group[0].name,
        run,
        file,
        detail: `same call repeated ${group.length}×`,
        fingerprintInput: `retry::${key}`,
        count: group.length,
      });
  }
}

async function mineSessionMeta(file) {
  const run = path.basename(file).replace(/\.session\.json$/, "");
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    const open = (meta.todos ?? []).filter((t) => t.status !== "completed");
    if (open.length)
      push({
        kind: "stuck_todo",
        tool: "session",
        run,
        file,
        detail: `${open.length}/${meta.todos.length} todos unfinished: ${excerpt(
          open.map((t) => t.content).join("; "),
          200,
        )}`,
        fingerprintInput: `todo::${run}`,
        count: open.length,
      });
  } catch {
    /* unreadable meta is not a harness signal */
  }
}

async function mineTrace(file) {
  const run = path.basename(file, ".jsonl");
  await readJsonl(file, (d) => {
    if (
      (d.ev === "retry" || d.ev === "subagent_retry") &&
      !/pattern/i.test(String(d.reason ?? ""))
    )
      push({
        kind: "harness_retry",
        tool: d.ev,
        run,
        file,
        detail: excerpt(
          `${d.reason || d.error || ""} attempt=${d.attempt ?? "?"}`.trim(),
        ),
        fingerprintInput: `${d.ev}::${normalize(
          `${d.reason || ""}${d.error || ""}`,
        )}`,
      });
  });
}

async function mineBehavior(file) {
  const run = path.basename(file, ".jsonl");
  let last = null;
  await readJsonl(file, (d) => {
    if (d.kind === "turn_started") {
      if (last && d.ts - last.ts > 900) // >15 min between turns
        push({
          kind: "turn_stall",
          tool: "behavior",
          run,
          file,
          detail: `${Math.round((d.ts - last.ts) / 60)} min gap between turns`,
          fingerprintInput: `stall::${run}::${last.turn}->${d.turn}`,
        });
      last = d;
    }
  });
}

// ---------- tardigrade server-side event logs ----------

const TARDIGRADE_DEFAULT = path.join(
  os.homedir(),
  ".local/share/unbrowse/aiko",
);

function walkSqlite(dir, depth, out) {
  if (depth > 5 || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory (permissions) — skip silently
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // entity-learn memory stores are a separate domain (own docs); the
      // telegram cursor db and host locks carry no agent-turn outcomes.
      if (entry.name === "memory" || entry.name === "node_modules") continue;
      walkSqlite(full, depth + 1, out);
    } else if (
      entry.name.endsWith(".sqlite") &&
      !/^(host-lock|model-budget)\.sqlite$/.test(entry.name)
    )
      out.push(full);
  }
}

/**
 * Mine Tardigrade per-thread event logs (actor.sqlite, thread.sqlite,
 * background role dbs, cutover exports). Events are JSON rows in an
 * `events` / legacy `actor_events` table. Privacy: user message content is
 * never mined — only failure outcomes and receipt statuses.
 */
let DatabaseSync = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SQLITE_TRANSIENT =
  /SQLITE_(BUSY|LOCKED)|database is locked|database table is locked/i;

/**
 * Read a tardigrade event store without giving up on transient locks. A live
 * actor holding the WAL is routine, not an error: wait on busy_timeout, then
 * retry with backoff before conceding. Returns {table, rows} or {table:null}.
 */
async function readEventRows(file, attempts) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 3000");
      } catch {}
      const has = (t) =>
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(t);
      const table = has("events") ? "events" : has("actor_events") ? "actor_events" : null;
      if (!table) return { table: null };
      const rows = db.prepare(`SELECT event FROM "${table}" LIMIT 50000`).all();
      return { table, rows };
    } catch (err) {
      lastErr = err;
      err.attempts = attempt;
      if (!SQLITE_TRANSIENT.test(String(err.message)) || attempt === attempts)
        break;
      await sleep(150 * 4 ** (attempt - 1)); // 150ms → 600ms → 2.4s → 9.6s
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  throw lastErr;
}

async function mineTardigrade(root) {
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    process.stderr.write("harness-learn: node:sqlite unavailable — skipping tardigrade logs\n");
    return { events: 0, skipped: [] };
  }
  const attempts = Math.max(1, Number(flag("tardigrade-retries", "4")));
  const dbs = [];
  walkSqlite(root, 0, dbs);
  let mined = 0;
  const skipped = [];
  for (const file of dbs) {
    const run = path.relative(root, file);
    let result;
    try {
      result = await readEventRows(file, attempts);
    } catch (err) {
      // retries exhausted — keep this visible instead of dropping it silently
      skipped.push({ db: run, error: String(err.message), attempts: err.attempts ?? attempts });
      process.stderr.write(
        `harness-learn: gave up on ${run} after ${attempts} attempts: ${err.message}\n`,
      );
      continue;
    }
    if (!result.table) continue;
    const { rows } = result;
    for (const row of rows) {
        let e = row.event;
        if (typeof e === "string") {
          try {
            e = JSON.parse(e);
          } catch {
            continue;
          }
        }
        if (typeof e === "string") {
          try {
            e = JSON.parse(e);
          } catch {
            continue;
          }
        }
        if (!e || typeof e !== "object" || !e.type) continue;
        mined += 1;
        const t = String(e.type);
        if (t === "TurnFailed")
          push({
            kind: "turn_failed",
            tool: "tardigrade",
            run,
            file,
            detail: excerpt(String(e.output ?? e.error ?? "(no output)")),
            fingerprintInput: `turn_failed::${normalize(
              String(e.output ?? e.error ?? ""),
            )}`,
          });
        else if (t === "TurnCancelled")
          push({
            kind: "turn_cancelled",
            tool: "tardigrade",
            run,
            file,
            detail: excerpt(String(e.output ?? e.reason ?? "")) || "(cancelled)",
            fingerprintInput: `turn_cancelled::${run}`,
          });
        else if (t === "AikoDeliverySettled") {
          const status = e.result?.status;
          if (status && status !== "delivered")
            push({
              kind: `delivery_${status}`,
              tool: "tardigrade",
              run,
              file,
              detail: excerpt(
                `${e.result.providerId ?? "(no provider)"} ${e.result.error ?? ""}`.trim(),
              ),
              fingerprintInput: `delivery_${status}::${normalize(
                String(e.result.error ?? e.result.providerId ?? ""),
              )}`,
            });
        } else if (t === "ToolReturned") {
          const r = e.result;
          if (r && typeof r === "object" && typeof r.status === "string") {
            if (r.status === "unknown")
              push({
                kind: "receipt_unknown",
                tool: r.kind ?? "tool",
                run,
                file,
                detail: excerpt(String(r.error ?? "effect completed, outcome unverified")),
                fingerprintInput: `receipt_unknown::${normalize(
                  `${r.kind ?? ""}${r.error ?? ""}`,
                )}`,
              });
            else if (!"ok,delivered".includes(r.status))
              push({
                kind: `receipt_${r.status}`,
                tool: r.kind ?? "tool",
                run,
                file,
                detail: excerpt(String(r.error ?? r.detail ?? r.status)),
                fingerprintInput: `receipt_${r.status}::${normalize(
                  `${r.kind ?? ""}${r.error ?? r.detail ?? ""}`,
                )}`,
              });
          }
        }
        if (
          e.error &&
          !("AikoDeliverySettled,ToolReturned,TurnFailed".includes(t) && signals.at(-1)?.run === run)
        )
          push({
            kind: "event_error",
            tool: t,
            run,
            file,
            detail: excerpt(String(e.error)),
            fingerprintInput: `event_error::${t}::${normalize(String(e.error))}`,
          });
      }
  }
  return { events: mined, skipped };
}

// ---------- distillation ----------

function distill() {
  const lessons = new Map();
  for (const s of signals) {
    const fp = sha16(s.fingerprintInput);
    const l = lessons.get(fp) ?? {
      fingerprint: fp,
      kind: s.kind,
      tool: s.tool,
      count: 0,
      runs: new Set(),
      evidence: [],
      detail: s.detail,
    };
    l.count += s.count ?? 1;
    l.runs.add(s.run);
    if (l.evidence.length < 3)
      l.evidence.push({ run: s.run, detail: s.detail });
    lessons.set(fp, l);
  }
  return [...lessons.values()]
    .map((l) => ({ ...l, runs: [...l.runs] }))
    .sort((a, b) => b.count - a.count || b.runs.length - a.runs.length);
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { schema: "unlock.harness-learn.state.v1", fixed: {} };
  }
}

// ---------- subcommand: mark ----------

if (args[0] === "mark") {
  const stateFile = path.resolve(flag("state", path.join(OUT, "state.json")));
  const lessonsFile = path.resolve(flag("lessons", ""));
  const pr = flag("pr", "unknown");
  const state = loadState(stateFile);
  let marked = 0;
  if (lessonsFile) {
    const lessons = JSON.parse(fs.readFileSync(lessonsFile, "utf8"));
    for (const fp of lessons.new_lesson_fingerprints ?? []) {
      state.fixed[fp] = { pr, fixedAt: new Date().toISOString() };
      marked += 1;
    }
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`marked ${marked} lesson(s) fixed via ${pr}\n`);
  process.exit(0);
}

// ---------- main ----------

const sources = { transcripts: [], traces: [], behavior: [] };
const listDir = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")) : [];

for (const f of listDir(path.join(LOGS, "sessions")))
  if (f.endsWith(".transcript.jsonl"))
    sources.transcripts.push(path.join(LOGS, "sessions", f));
for (const f of listDir(path.join(LOGS, "traces")))
  if (f.endsWith(".jsonl")) sources.traces.push(path.join(LOGS, "traces", f));
for (const f of listDir(path.join(LOGS, "behavior")))
  if (f.endsWith(".jsonl"))
    sources.behavior.push(path.join(LOGS, "behavior", f));

const fresh = (f) => fs.statSync(f).mtimeMs >= SINCE_MS;

for (const f of sources.transcripts) {
  if (!fresh(f)) continue;
  await mineTranscript(f);
  await mineSessionMeta(f.replace(/\.transcript\.jsonl$/, ".session.json"));
}
for (const f of sources.traces) if (fresh(f)) await mineTrace(f);
for (const f of sources.behavior) if (fresh(f)) await mineBehavior(f);

// Tardigrade server-side event logs (Aiko runtime: TurnFailed, delivery and
// receipt outcomes). Pass --tardigrade none to disable, or a path to an
// exported/migrated state dir (e.g. cloudflare-cutover exports).
const tardigradeRoot = path.resolve(flag("tardigrade", TARDIGRADE_DEFAULT));
let tardigrade = { root: tardigradeRoot, events: 0, skipped: [] };
if (tardigradeRoot !== "none")
  tardigrade = { ...tardigrade, ...(await mineTardigrade(tardigradeRoot)) };

const state = loadState(path.join(OUT, "state.json"));
const all = distill();
const lessons = all.filter((l) => !state.fixed[l.fingerprint]);
const fixedAlready = all.length - lessons.length;

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
fs.mkdirSync(OUT, { recursive: true });

const report = {
  schema: "unlock.harness-learn.lessons.v1",
  generated: new Date().toISOString(),
  logs: LOGS,
  window_days: SINCE_DAYS,
  runs_seen: [...runsSeen].sort(),
  sources: Object.fromEntries(
    Object.entries(sources).map(([k, v]) => [k, v.length]),
  ),
  tardigrade,
  totals: {
    signals: signals.length,
    distinct_lessons: all.length,
    already_fixed: fixedAlready,
    new_lessons: lessons.length,
  },
  lessons: all.map(({ fingerprint, kind, tool, count, runs, evidence, detail }) => ({
    fingerprint,
    kind,
    tool,
    count,
    runs,
    detail,
    evidence,
    new: !state.fixed[fingerprint],
  })),
  new_lesson_fingerprints: lessons.map((l) => l.fingerprint),
};
const jsonFile = path.join(OUT, `lessons-${stamp}.json`);
fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);

const md = [
  `# Harness lessons — ${stamp}`,
  "",
  `Mined from \`${LOGS}\` (window: ${SINCE_DAYS}d, runs: ${report.runs_seen.length}).`,
  `Signals: ${signals.length} → distinct lessons: ${all.length} (${
    lessons.length
  } new, ${fixedAlready} already fixed).`,
  "",
  "| kind | tool | count | runs | detail | new |",
  "|---|---|---|---|---|---|",
  ...all
    .slice(0, 25)
    .map(
      (l) =>
        `| ${l.kind} | ${l.tool} | ${l.count} | ${l.runs.length} | ${l.detail.replace(/\|/g, "\\|").slice(0, 120)} | ${state.fixed[l.fingerprint] ? `[fixed](${state.fixed[l.fingerprint].pr})` : "**yes**"} |`,
    ),
  "",
  "Machine-readable: `" + path.relative(process.cwd(), jsonFile) + "`.",
].join("\n");
const mdFile = path.join(OUT, `lessons-${stamp}.md`);
fs.writeFileSync(mdFile, `${md}\n`);

process.stdout.write(
  [
    `harness-learn: ${signals.length} signals → ${all.length} lessons (${lessons.length} new)`,
    `report: ${jsonFile}`,
    `NEW_LESSONS=${lessons.length}`,
    `LESSONS_FILE=${jsonFile}`,
    `LESSONS_MD=${mdFile}`,
    "",
  ].join("\n"),
);
