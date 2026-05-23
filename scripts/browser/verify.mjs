#!/usr/bin/env node
// verify.mjs — headless console-error / pageerror / 4xx-asset gate.
//
// Usage:
//   verify.mjs <url> [<url>...] [--allow <substr>] [--report <path>]
//                              [--timeout <ms>]    [--wait-after-load <ms>]
//                              [--keep-html]
//
// Exit 0 → every URL loaded cleanly under our criteria.
// Exit 1 → at least one URL had a real error.
// Exit 2 → environmental fault (no chromium, bad arg, etc).
//
// CRITERIA (intentionally narrow to avoid false positives from user
// browser extensions that real headless never has):
//   - console.error events the page emits         → FAIL
//   - uncaught page errors (window.onerror)       → FAIL
//   - 4xx / 5xx responses for SAME-ORIGIN assets  → FAIL
//   - third-party CORS, console.warn,
//     extension chatter                           → IGNORED
//
// --allow accepts a substring that, if found in the failure message or
// URL, downgrades that single hit. Repeatable.
//
// Report shape (always written when --report is given):
//   {
//     "urls":   [{ "url", "ok", "ms", "errors":[{kind,message,source}] }, ... ],
//     "ok":     true|false,
//     "errors": <total real errors across URLs>
//   }
//
// Substrate principle (contract C-G01): this is evidence. The agent reads
// the printed report and decides KEY 2. The exit code is just the first
// machine-side signal.

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.error(
    "Usage: verify.mjs <url> [<url>...] [--allow <substr>...] [--report <path>] [--timeout <ms>] [--wait-after-load <ms>]",
  );
  process.exit(2);
}

const urls = [];
const allow = [];
let report = null;
let timeoutMs = 30000;
let waitAfterLoadMs = 1500;
let keepHtml = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--allow") allow.push(args[++i]);
  else if (a === "--report") report = args[++i];
  else if (a === "--timeout") timeoutMs = parseInt(args[++i], 10);
  else if (a === "--wait-after-load") waitAfterLoadMs = parseInt(args[++i], 10);
  else if (a === "--keep-html") keepHtml = true;
  else urls.push(a);
}

if (urls.length === 0) {
  console.error("no URL given");
  process.exit(2);
}

function allowed(msg) {
  return allow.some((a) => msg.includes(a));
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (e) {
  console.error(
    "could not launch chromium — install with:\n  cd " +
      dirname(new URL(import.meta.url).pathname) +
      " && bun install\n  bunx playwright install chromium\n\nunderlying error: " +
      (e && e.message ? e.message : String(e)),
  );
  process.exit(2);
}

const out = { urls: [], ok: true, errors: 0 };

try {
  for (const url of urls) {
    const target = new URL(url);
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      // a real user-agent — some hosts misbehave on the headless one
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    const errors = [];

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (allowed(text)) return;
      errors.push({ kind: "console.error", message: text, source: "page" });
    });
    page.on("pageerror", (err) => {
      const m = (err && err.message) || String(err);
      if (allowed(m)) return;
      errors.push({ kind: "pageerror", message: m, source: "uncaught" });
    });
    page.on("response", async (res) => {
      try {
        const status = res.status();
        if (status < 400) return;
        const reqUrl = res.url();
        const reqHost = new URL(reqUrl).host;
        if (reqHost !== target.host) return; // same-origin only
        if (allowed(reqUrl)) return;
        errors.push({
          kind: "http",
          message: `${status} ${reqUrl}`,
          source: "network",
        });
      } catch {
        /* ignore URL parse errors on data: blobs */
      }
    });

    const t0 = Date.now();
    let loadErr = null;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
      await page.waitForTimeout(waitAfterLoadMs);
    } catch (e) {
      loadErr = (e && e.message) || String(e);
      errors.push({ kind: "navigation", message: loadErr, source: "playwright" });
    }
    const ms = Date.now() - t0;

    let html = null;
    if (keepHtml) {
      try { html = await page.content(); } catch { /* ignore */ }
    }

    const urlReport = { url, ok: errors.length === 0, ms, errors };
    if (html) urlReport.html_len = html.length;
    out.urls.push(urlReport);
    if (errors.length > 0) {
      out.ok = false;
      out.errors += errors.length;
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

// Always print a compact, human-readable summary to stdout (L2 surface);
// the JSON report goes to --report (L0).
console.log(`served-surface verify · urls=${out.urls.length} · total_errors=${out.errors}`);
for (const u of out.urls) {
  const tag = u.ok ? "✓" : "✗";
  console.log(`  ${tag} ${u.url}  (${u.ms}ms${u.errors.length ? `, ${u.errors.length} err` : ""})`);
  for (const e of u.errors.slice(0, 12)) {
    const msg = e.message.length > 240 ? e.message.slice(0, 240) + " …" : e.message;
    console.log(`      [${e.kind}] ${msg}`);
  }
  if (u.errors.length > 12) console.log(`      … ${u.errors.length - 12} more`);
}

if (report) {
  const p = resolve(report);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`report → ${p}`);
}

process.exit(out.ok ? 0 : 1);
