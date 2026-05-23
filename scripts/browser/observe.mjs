#!/usr/bin/env node
// observe.mjs — drive an original site through a scripted "tour" and record:
//   - the network requests fired per screen (verb, path, headers, payload, status,
//     response sample)
//   - per-screen screenshots
//   - the eventual UX flow as a markdown report
//
// Usage:
//   observe.mjs --tour <tour.json> [--out <dir>] [--env-from <file>]
//               [--timeout <ms>] [--headed]
//
// Tour format:
//   {
//     "name": "buyer.zeemart.co",
//     "base_url": "https://buyer.zeemart.co",
//     "match_hosts": ["zm-", "buyer.zeemart.co"],   // capture endpoints matching
//     "steps": [
//       { "label": "login", "goto": "/login" },
//       { "fill": "input[type=email]", "value": "${ZEEMART_USER}" },
//       { "fill": "input[type=password]", "value": "${ZEEMART_PASS}" },
//       { "click": "button[type=submit]" },
//       { "wait_idle": 3000 },
//       { "label": "outlets-list", "screenshot": "01-outlets" },
//       { "click": "text=Orders" },
//       { "wait_idle": 3000 },
//       { "label": "orders-list", "screenshot": "02-orders" }
//     ]
//   }
//
// Step verbs: goto, click, fill, wait_for_url, wait_for_selector, wait_idle,
//             screenshot, label, eval, sleep.
//
// Substrate principle (C-G01): the script emits evidence (the report + raw JSON);
// the agent reads the report and decides what the rebuild should mirror.

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

function parseArgs(argv) {
  const args = { tour: null, out: "./.observe", envFrom: null, timeout: 30000, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tour") args.tour = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--env-from") args.envFrom = argv[++i];
    else if (a === "--timeout") args.timeout = parseInt(argv[++i], 10);
    else if (a === "--headed") args.headed = true;
    else if (a === "--help" || a === "-h") {
      console.error("Usage: observe.mjs --tour <tour.json> [--out <dir>] [--env-from <file>] [--timeout <ms>] [--headed]");
      process.exit(2);
    }
  }
  if (!args.tour) {
    console.error("error: --tour required");
    process.exit(2);
  }
  return args;
}

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

function expand(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
    const v = process.env[k];
    if (v === undefined) {
      throw new Error(`tour requires env var ${k} but it is not set (use --env-from)`);
    }
    return v;
  });
}

function shouldCapture(url, matchHosts) {
  if (!matchHosts || matchHosts.length === 0) return true;
  try {
    const h = new URL(url).host;
    return matchHosts.some((m) => h.includes(m));
  } catch { return false; }
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lk = k.toLowerCase();
    if (lk === "mudra" || lk === "authorization" || lk === "cookie" || lk === "ztoken" || lk === "accesstoken") {
      out[k] = "<redacted>";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function clipBody(s, limit = 600) {
  if (!s) return "";
  if (s.length <= limit) return s;
  return s.slice(0, limit) + ` …(${s.length - limit} more chars)`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.envFrom) loadEnvFile(args.envFrom);
  const tourPath = resolve(args.tour);
  if (!existsSync(tourPath)) {
    console.error(`tour file not found: ${tourPath}`);
    process.exit(2);
  }
  const tour = JSON.parse(readFileSync(tourPath, "utf8"));
  const outDir = resolve(args.out);
  mkdirSync(join(outDir, "screenshots"), { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: !args.headed });
  } catch (e) {
    console.error("could not launch chromium:", e?.message ?? e);
    console.error("hint: cd " + dirname(new URL(import.meta.url).pathname) + " && bun install && bunx playwright install chromium");
    process.exit(2);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  /** @type {string} */
  let currentLabel = "(unlabelled)";
  /** @type {Array<{label:string, ts:number, method:string, url:string, host:string, path:string, status:number|null, reqHeaders:object, reqBody:string|null, respHeaders:object, respBody:string, type:string, error:string|null}>} */
  const captured = [];

  page.on("request", (req) => {
    const url = req.url();
    if (!shouldCapture(url, tour.match_hosts)) return;
    const u = new URL(url);
    let bodyText = null;
    try { bodyText = req.postData(); } catch { /* ignore */ }
    captured.push({
      label: currentLabel,
      ts: Date.now(),
      method: req.method(),
      url,
      host: u.host,
      path: u.pathname + (u.search || ""),
      status: null,
      reqHeaders: redactHeaders(req.headers()),
      reqBody: bodyText ? clipBody(bodyText, 1200) : null,
      respHeaders: {},
      respBody: "",
      type: req.resourceType(),
      error: null,
    });
  });

  page.on("response", async (resp) => {
    const url = resp.url();
    if (!shouldCapture(url, tour.match_hosts)) return;
    const rec = [...captured].reverse().find((r) => r.url === url && r.status === null);
    if (!rec) return;
    rec.status = resp.status();
    rec.respHeaders = redactHeaders(resp.headers());
    try {
      const buf = await resp.body();
      const ct = (rec.respHeaders["content-type"] || rec.respHeaders["Content-Type"] || "").toLowerCase();
      if (ct.includes("json") || ct.includes("text") || ct.includes("xml") || ct.includes("javascript")) {
        rec.respBody = clipBody(buf.toString("utf8"), 1200);
      } else {
        rec.respBody = `<binary ${buf.length}B ${ct || "unknown"}>`;
      }
    } catch (e) {
      rec.error = e?.message ?? String(e);
    }
  });

  page.on("requestfailed", (req) => {
    const url = req.url();
    if (!shouldCapture(url, tour.match_hosts)) return;
    const rec = [...captured].reverse().find((r) => r.url === url && r.status === null);
    if (!rec) return;
    rec.error = req.failure()?.errorText ?? "request failed";
  });

  // Per-screen index for the markdown report
  /** @type {Array<{label:string, ts:number, url:string, screenshot:string|null}>} */
  const screens = [];

  for (const stepRaw of tour.steps) {
    const step = stepRaw;
    if (step.label) {
      currentLabel = step.label;
      screens.push({ label: step.label, ts: Date.now(), url: page.url(), screenshot: null });
    }
    if (step.sleep) await page.waitForTimeout(parseInt(step.sleep, 10));

    if (step.goto) {
      const target = step.goto.startsWith("http") ? step.goto : (tour.base_url || "") + step.goto;
      try {
        await page.goto(expand(target), { waitUntil: "networkidle", timeout: args.timeout });
      } catch (e) {
        console.error(`[step goto ${target}] ${e?.message ?? e}`);
      }
    }
    if (step.click) {
      try {
        await page.click(step.click, { timeout: args.timeout });
      } catch (e) {
        console.error(`[step click ${step.click}] ${e?.message ?? e}`);
      }
    }
    if (step.fill && step.value !== undefined) {
      try {
        await page.fill(step.fill, expand(step.value));
      } catch (e) {
        console.error(`[step fill ${step.fill}] ${e?.message ?? e}`);
      }
    }
    if (step.wait_for_url) {
      try { await page.waitForURL(step.wait_for_url, { timeout: args.timeout }); }
      catch (e) { console.error(`[wait_for_url] ${e?.message ?? e}`); }
    }
    if (step.wait_for_selector) {
      try { await page.waitForSelector(step.wait_for_selector, { timeout: args.timeout }); }
      catch (e) { console.error(`[wait_for_selector] ${e?.message ?? e}`); }
    }
    if (step.wait_idle) await page.waitForTimeout(parseInt(step.wait_idle, 10));
    if (step.eval) {
      try {
        await page.evaluate(step.eval);
      } catch (e) {
        console.error(`[eval] ${e?.message ?? e}`);
      }
    }
    if (step.screenshot) {
      const name = `${step.screenshot}.png`;
      const path = join(outDir, "screenshots", name);
      try {
        await page.screenshot({ path, fullPage: true });
        const last = [...screens].reverse().find((s) => s.label === currentLabel && !s.screenshot);
        if (last) last.screenshot = `screenshots/${name}`;
      } catch (e) {
        console.error(`[screenshot ${name}] ${e?.message ?? e}`);
      }
    }
  }

  // give late XHRs a moment
  await page.waitForTimeout(1000);

  await ctx.close();
  await browser.close();

  // -- emit raw JSON --
  writeFileSync(join(outDir, "events.json"), JSON.stringify({ tour: tour.name, captured }, null, 2));

  // -- emit grouped endpoints summary --
  /** @type {Record<string, Record<string, {count:number, status:Set<number>, methods:Set<string>, labels:Set<string>}>>} */
  const endpoints = {};
  for (const r of captured) {
    if (r.type === "image" || r.type === "stylesheet" || r.type === "font") continue;
    const key = `${r.host}${r.path.split("?")[0]}`;
    const slot = (endpoints[r.host] ??= {});
    const e = (slot[r.path.split("?")[0]] ??= { count: 0, status: new Set(), methods: new Set(), labels: new Set() });
    e.count++;
    if (r.status) e.status.add(r.status);
    e.methods.add(r.method);
    e.labels.add(r.label);
  }
  const endpointsJson = {};
  for (const [host, paths] of Object.entries(endpoints)) {
    endpointsJson[host] = {};
    for (const [p, m] of Object.entries(paths)) {
      endpointsJson[host][p] = {
        count: m.count,
        methods: [...m.methods],
        status: [...m.status],
        labels: [...m.labels],
      };
    }
  }
  writeFileSync(join(outDir, "endpoints.json"), JSON.stringify(endpointsJson, null, 2));

  // -- emit markdown screen-flow report --
  const md = [];
  md.push(`# ${tour.name} — observed screen-flow`);
  md.push("");
  md.push(`Captured ${new Date().toISOString()} via /contract observe-original.`);
  md.push("");
  md.push(`**Base URL:** ${tour.base_url ?? "(none)"}`);
  md.push(`**Match hosts:** ${(tour.match_hosts ?? ["(all)"]).join(", ")}`);
  md.push(`**Total captured requests:** ${captured.length}`);
  md.push("");
  md.push("> Auth tokens (mudra/authorization/cookie/ZToken/accessToken) are redacted in this report.");
  md.push("");

  // group by label
  const labels = [...new Set(screens.map((s) => s.label))];
  if (labels.length === 0) labels.push("(unlabelled)");
  for (const lbl of labels) {
    md.push(`## Screen: \`${lbl}\``);
    md.push("");
    const screen = screens.find((s) => s.label === lbl);
    if (screen?.screenshot) {
      md.push(`![${lbl}](${screen.screenshot})`);
      md.push("");
    }
    if (screen?.url) {
      md.push(`URL: \`${screen.url}\``);
      md.push("");
    }
    const rows = captured.filter((r) => r.label === lbl && r.type !== "image" && r.type !== "stylesheet" && r.type !== "font");
    if (rows.length === 0) {
      md.push("_no API calls captured on this screen._");
      md.push("");
      continue;
    }
    md.push(`### Endpoints fired (${rows.length})`);
    md.push("");
    for (const r of rows) {
      md.push(`#### \`${r.method} ${r.host}${r.path}\` → \`${r.status ?? "?"}\``);
      md.push("");
      md.push("**Request headers:**");
      md.push("```json");
      md.push(JSON.stringify(r.reqHeaders, null, 2));
      md.push("```");
      if (r.reqBody) {
        md.push("**Request body:**");
        md.push("```");
        md.push(r.reqBody);
        md.push("```");
      }
      md.push("**Response headers:**");
      md.push("```json");
      md.push(JSON.stringify(r.respHeaders, null, 2));
      md.push("```");
      md.push("**Response body (clipped):**");
      md.push("```");
      md.push(r.respBody || "(empty)");
      md.push("```");
      if (r.error) {
        md.push(`> ⚠ ${r.error}`);
      }
      md.push("");
    }
  }

  // distinct endpoint summary at the end
  md.push("## Distinct endpoint summary");
  md.push("");
  md.push("| Host | Path | Methods | Statuses | Hits | Screens |");
  md.push("|---|---|---|---|---|---|");
  for (const [host, paths] of Object.entries(endpointsJson)) {
    for (const [p, m] of Object.entries(paths)) {
      md.push(`| \`${host}\` | \`${p}\` | ${m.methods.join(", ")} | ${m.status.join(", ")} | ${m.count} | ${m.labels.join(", ")} |`);
    }
  }

  writeFileSync(join(outDir, "screen-flow.md"), md.join("\n"));

  // -- console summary --
  console.log(`observe-original · ${tour.name} · screens=${labels.length} · requests=${captured.length}`);
  console.log(`  out: ${outDir}`);
  console.log(`    screen-flow.md   ← human-readable report`);
  console.log(`    endpoints.json   ← distinct endpoint map`);
  console.log(`    events.json      ← raw per-request rows`);
  console.log(`    screenshots/     ← one per labelled screen`);
}

main().catch((e) => {
  console.error("observe-original error:", e?.stack ?? e);
  process.exit(2);
});
