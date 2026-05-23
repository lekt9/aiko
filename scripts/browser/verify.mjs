#!/usr/bin/env node
// verify.mjs — served-surface + empathy gate.
//
// Two layers in one script:
//
//   1. SERVED-SURFACE (original): a fresh headless Chromium loads each URL.
//      Fails on console.error, uncaught pageerror, or 4xx/5xx on a
//      same-origin asset. Cross-origin CORS noise + extension chatter +
//      console.warn are ignored.
//
//   2. EMPATHY (added 2026-05-23): a real user is patient and reads the
//      page. The server returning 200 doesn't mean a user can use the
//      thing. After the load wait, the gate ALSO checks:
//        - document.body.innerText is at least --min-text chars
//          (skeleton markup with no visible text doesn't count)
//        - every --expect <substr> appears in innerText
//        - no --expect-not <substr> appears in innerText
//      Defaults for --expect-not include "Application error",
//      "__next_error__", "something went wrong" — the boundary copy Next.js
//      paints when a page crashes. These exist as load-bearing guard
//      strings unless --no-default-expect-not is passed.
//
// Usage:
//   verify.mjs <url> [<url>...]
//     [--allow <substr>]              repeatable; allowlist a message
//     [--report <path>]               write JSON report
//     [--timeout <ms>]                navigation timeout (default 30000)
//     [--wait-after-load <ms>]        hydration pause (default 1500)
//     [--wait-until <evt>]            playwright waitUntil (default
//                                     'domcontentloaded'; use 'networkidle'
//                                     only for sites without 3rd-party
//                                     poll loops — they hang networkidle)
//     [--expect <substr>]             repeatable; assert innerText contains
//     [--expect-not <substr>]         repeatable; assert innerText omits
//     [--min-text <N>]                assert innerText length >= N chars
//                                     (default 0 = off)
//     [--no-default-expect-not]       drop the built-in error-boundary guards
//     [--walk]                        WALK layer: after each URL, harvest
//                                     every same-origin <a href> on the
//                                     page and verify each link too. Catches
//                                     stale internal links (a deleted route
//                                     still referenced by a nav item).
//                                     Walk is one level deep; the harvested
//                                     URLs are NOT walked further.
//     [--walk-include <regex>]        only walk URLs whose path matches
//     [--walk-exclude <regex>]        skip URLs whose path matches
//     [--keep-html]                   include html_len in the report
//
// Exit 0 → every URL clean.  1 → at least one URL had errors.  2 → env fault.
//
// Substrate principle (contract C-G01): this is evidence. The agent reads
// the printed report and decides KEY 2. The exit code is the first
// machine-side signal, not the verdict.

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.error(
    "Usage: verify.mjs <url> [<url>...] [--allow <substr>...] [--report <path>] [--timeout <ms>] [--wait-after-load <ms>] [--wait-until <evt>] [--expect <substr>...] [--expect-not <substr>...] [--min-text <N>] [--no-default-expect-not] [--keep-html]",
  );
  process.exit(2);
}

const urls = [];
const allow = [];
const expect = [];
const expectNot = [];
let report = null;
let timeoutMs = 30000;
let waitAfterLoadMs = 1500;
let waitUntil = "domcontentloaded";
let minText = 0;
let useDefaultExpectNot = true;
let keepHtml = false;
let walk = false;
let walkInclude = null;
let walkExclude = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--allow") allow.push(args[++i]);
  else if (a === "--report") report = args[++i];
  else if (a === "--timeout") timeoutMs = parseInt(args[++i], 10);
  else if (a === "--wait-after-load") waitAfterLoadMs = parseInt(args[++i], 10);
  else if (a === "--wait-until") waitUntil = args[++i];
  else if (a === "--expect") expect.push(args[++i]);
  else if (a === "--expect-not") expectNot.push(args[++i]);
  else if (a === "--min-text") minText = parseInt(args[++i], 10);
  else if (a === "--no-default-expect-not") useDefaultExpectNot = false;
  else if (a === "--keep-html") keepHtml = true;
  else if (a === "--walk") walk = true;
  else if (a === "--walk-include") walkInclude = new RegExp(args[++i]);
  else if (a === "--walk-exclude") walkExclude = new RegExp(args[++i]);
  else urls.push(a);
}

if (urls.length === 0) {
  console.error("no URL given");
  process.exit(2);
}

const DEFAULT_EXPECT_NOT = [
  "Application error: a client-side exception",
  "__next_error__",
  "something went wrong",
];
const expectNotEffective = useDefaultExpectNot
  ? [...DEFAULT_EXPECT_NOT, ...expectNot]
  : [...expectNot];

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

const out = { urls: [], ok: true, errors: 0, walked: 0 };

// queue of URLs to verify; walk adds harvested children to it
const queue = [...urls.map((u) => ({ url: u, walked: false }))];
const seen = new Set(urls.map((u) => u));

try {
  while (queue.length) {
    const job = queue.shift();
    const url = job.url;
    const target = new URL(url);
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
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
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      await page.waitForTimeout(waitAfterLoadMs);
    } catch (e) {
      loadErr = (e && e.message) || String(e);
      errors.push({ kind: "navigation", message: loadErr, source: "playwright" });
    }
    const ms = Date.now() - t0;

    // Empathy: pull the visible text the same way a sighted user would
    // "read the page". innerText respects layout — hidden / display:none
    // doesn't count. The page's skeleton markup with no visible copy
    // yields a near-empty string, which the --min-text gate catches.
    let innerText = "";
    let html = null;
    try {
      innerText = (await page.evaluate(() => document.body && document.body.innerText)) || "";
    } catch {
      /* page may be navigation-errored already; treat as empty */
    }
    if (keepHtml) {
      try { html = await page.content(); } catch { /* ignore */ }
    }

    if (minText > 0 && innerText.length < minText) {
      errors.push({
        kind: "empathy.min-text",
        message: `visible text ${innerText.length} chars < required ${minText}`,
        source: "render",
      });
    }
    for (const s of expect) {
      if (!innerText.includes(s)) {
        errors.push({
          kind: "empathy.expect",
          message: `expected substring not visible: ${JSON.stringify(s)}`,
          source: "render",
        });
      }
    }
    for (const s of expectNotEffective) {
      if (innerText.includes(s)) {
        errors.push({
          kind: "empathy.expect-not",
          message: `forbidden substring visible: ${JSON.stringify(s)}`,
          source: "render",
        });
      }
    }

    const urlReport = {
      url,
      ok: errors.length === 0,
      ms,
      text_len: innerText.length,
      walked: job.walked,
      errors,
    };
    if (html) urlReport.html_len = html.length;
    out.urls.push(urlReport);
    if (errors.length > 0) {
      out.ok = false;
      out.errors += errors.length;
    }

    // WALK: collect same-origin <a href> from this page, enqueue each
    if (walk && !job.walked) {
      let hrefs = [];
      try {
        hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]")).map((a) => a.href),
        );
      } catch { /* page may be navigation-errored */ }
      for (const h of hrefs) {
        let u;
        try { u = new URL(h); } catch { continue; }
        if (u.host !== target.host) continue;
        if (u.pathname.match(/\.(svg|png|jpe?g|gif|webp|ico|css|js|woff2?|map)$/i)) continue;
        const norm = u.origin + u.pathname;  // strip query+hash; the gate is per-route
        if (seen.has(norm)) continue;
        if (walkInclude && !walkInclude.test(u.pathname)) continue;
        if (walkExclude && walkExclude.test(u.pathname)) continue;
        seen.add(norm);
        queue.push({ url: norm, walked: true });
        out.walked++;
      }
    }

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(
  `served-surface+empathy${walk ? "+walk" : ""} · urls=${out.urls.length}` +
  (walk ? ` (incl ${out.walked} walked)` : "") +
  ` · total_errors=${out.errors}`,
);
for (const u of out.urls) {
  const tag = u.ok ? "✓" : "✗";
  const walkedTag = u.walked ? " [walked]" : "";
  console.log(
    `  ${tag} ${u.url}${walkedTag}  (${u.ms}ms, text=${u.text_len}${u.errors.length ? `, ${u.errors.length} err` : ""})`,
  );
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
