#!/usr/bin/env node
/**
 * harness-watch.mjs — live view of the production Aiko account DOs.
 *
 * Shows, per account: resting/busy (import or turn in flight), journal size,
 * and the newest events. This is the window the admin panel doesn't give you.
 *
 * Usage: node scripts/harness-watch.mjs [--interval 10] [--once]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {}
  return out;
}

const BASE = (
  flag("url", "") ||
  process.env.AIKO_EXPORT_URL ||
  process.env.AIKO_CLOUDFLARE_URL ||
  "https://aiko-agent.lewis-6d8.workers.dev"
).replace(/\/$/, "");
const TOKEN =
  flag("token", "") ||
  process.env.AIKO_OPERATOR_TOKEN ||
  readEnvFile(path.join(os.homedir(), ".config/unbrowse/aiko-operator.env"))
    .AIKO_OPERATOR_TOKEN ||
  "";
if (!TOKEN) {
  console.error("no operator token (AIKO_OPERATOR_TOKEN or aiko-operator.env)");
  process.exit(1);
}

const api = async (p) => {
  const res = await fetch(`${BASE}${p}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  try {
    return { status: res.status, body: JSON.parse(body) };
  } catch {
    return { status: res.status, body };
  }
};

const rel = (at) =>
  at ? `${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago` : "?";

async function accounts() {
  const { status, body } = await api("/api/control/accounts");
  if (status !== 200) return [];
  return (body.accounts ?? []).map((a) => a.account);
}

async function accountState(account) {
  // busy probe: export refuses with 409 while a turn/import holds the DO
  const probe = await api(
    `/api/control/export?account=${encodeURIComponent(account)}`,
  );
  const busy =
    probe.status === 409 ||
    (probe.status === 503 && probe.body?.error === "service_unavailable");
  // newest journal events
  const { body } = await api(
    `/api/control/events?thread=user-${encodeURIComponent(
      account,
    )}&account=${encodeURIComponent(account)}`,
  );
  const rows = body?.events ?? [];
  const parse = (raw) => {
    let e = raw;
    for (let i = 0; i < 2 && typeof e === "string"; i++) {
      try {
        e = JSON.parse(e);
      } catch {
        return null;
      }
    }
    return e?.type ? e : null;
  };
  const events = rows.map((r) => parse(r.event ?? r)).filter(Boolean);
  const recent = events.slice(-3).map((e) => `${e.type} (${rel(e.at)})`);
  return { busy, journal: body?.hasMore ? `${rows.length}+` : `${rows.length}`, recent };
}

async function tick() {
  const stamp = new Date().toISOString().slice(11, 19);
  const list = await accounts();
  console.log(`\n[${stamp}] ${BASE.replace("https://", "")} — ${list.length} account(s)`);
  for (const account of list) {
    try {
      const { busy, journal, recent } = await accountState(account);
      const tag = busy ? "BUSY (import/turn in flight — messages refused)" : "resting";
      console.log(`  ${account}: ${tag} | journal ${journal}`);
      for (const r of recent) console.log(`     · ${r}`);
    } catch (err) {
      console.log(`  ${account}: probe failed — ${err.message}`);
    }
  }
}

if (process.argv.includes("--once")) {
  await tick();
} else {
  const interval = Number(flag("interval", "10")) * 1000;
  for (;;) {
    await tick().catch((e) => console.log(`tick failed: ${e.message}`));
    await new Promise((r) => setTimeout(r, interval));
  }
}
