#!/usr/bin/env bun
// Φ2 user-pov sandbox: snapshot N URLs at typical viewports so the agent can
// Read what a real user sees on first paint. The substrate enables — the
// agent judges KEY 2 from the screenshots.
//
// Usage:
//   bun user-pov-snap.mjs --out /tmp/pov/ <url> [<url>...]
//     [--viewport name:WxH] [--viewport ...]  (default: mobile + desktop)
//     [--wait <ms>]    (default: 2500ms after domcontentloaded)
//     [--fullpage]     (default: above-the-fold only)
//
// Output:
//   <out>/<slug>.<viewport>.jpg   one file per URL × viewport
//   stdout last line: MANIFEST=<path-to-manifest.txt>

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const out = { urls: [], viewports: [], wait: 2500, outDir: null, fullPage: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--viewport") out.viewports.push(argv[++i]);
    else if (a === "--wait") out.wait = parseInt(argv[++i], 10);
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--fullpage") out.fullPage = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else out.urls.push(a);
  }
  if (out.urls.length === 0) throw new Error("need at least one URL");
  if (!out.outDir) out.outDir = `/tmp/pov-${Date.now()}`;
  if (out.viewports.length === 0) {
    out.viewports = ["mobile:390x844", "desktop:1440x900"];
  }
  return out;
}

function parseViewport(spec) {
  const [name, dims] = spec.split(":");
  const [w, h] = (dims || "1280x800").split("x").map(n => parseInt(n, 10));
  return { name, width: w, height: h };
}

function slugify(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

const args = parseArgs(process.argv);
const viewports = args.viewports.map(parseViewport);
mkdirSync(args.outDir, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const records = [];
const errors = [];

for (const vp of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.name === "mobile" ? 2 : 1,
    userAgent: vp.name === "mobile"
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined,
  });
  for (const url of args.urls) {
    const page = await ctx.newPage();
    const slug = slugify(url) || "root";
    const filename = `${slug}.${vp.name}.jpg`;
    const filepath = join(args.outDir, filename);
    try {
      const t0 = Date.now();
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const httpStatus = resp ? resp.status() : 0;
      await page.waitForTimeout(args.wait);
      await page.screenshot({ path: filepath, type: "jpeg", quality: 85, fullPage: args.fullPage });
      const ms = Date.now() - t0;
      records.push({ url, viewport: `${vp.name} ${vp.width}x${vp.height}`, file: filepath, status: httpStatus, ms });
      console.log(`  ${httpStatus} ${vp.name.padEnd(8)} ${url}  -> ${filename}  (${ms}ms)`);
    } catch (e) {
      errors.push({ url, viewport: vp.name, error: String(e).slice(0, 200) });
      console.error(`  ERR ${vp.name} ${url}: ${String(e).slice(0, 160)}`);
    }
    await page.close();
  }
  await ctx.close();
}

await browser.close();

const manifestPath = join(args.outDir, "manifest.txt");
const lines = [
  "# Φ2 user-pov screenshots",
  `# captured: ${new Date().toISOString()}`,
  `# urls: ${args.urls.length}  viewports: ${viewports.map(v => v.name).join(",")}  wait_ms: ${args.wait}  fullpage: ${args.fullPage}`,
  "",
  ...records.map(r => `${r.status}  ${r.viewport.padEnd(20)}  ${r.file}  ${r.url}`),
];
if (errors.length) {
  lines.push("", "# ERRORS");
  for (const e of errors) lines.push(`# ${e.viewport}  ${e.url}  ${e.error}`);
}
writeFileSync(manifestPath, lines.join("\n") + "\n");

console.log(`\nMANIFEST=${manifestPath}`);
console.log(`captured ${records.length}/${args.urls.length * viewports.length}`);
process.exit(errors.length > 0 && records.length === 0 ? 1 : 0);
