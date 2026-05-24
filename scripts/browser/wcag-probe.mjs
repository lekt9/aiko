#!/usr/bin/env node
// WCAG-AA contrast probe + screenshots.
// Usage: node wcag-probe.mjs <base-url> [path1 path2 ...]
// Default paths: /, /install, /papers, /about
// Output:
//   /tmp/wcag-report.json   structured findings
//   /tmp/wcag-shot-*.png    one screenshot per path
// Exit 0 only when every visible text element clears WCAG AA on real
// computed colors (background walked up the ancestor chain).
import { chromium } from "playwright";
import fs from "node:fs";

const base = process.argv[2];
if (!base) { console.error("usage: wcag-probe.mjs <base-url> [paths...]"); process.exit(2); }
const paths = process.argv.slice(3);
if (paths.length === 0) paths.push("/", "/install", "/papers", "/about", "/what-is-unbrowse");

const out = { base, paths: {}, summary: { total_violations: 0, total_text_nodes: 0 } };

function rel(r) {
  // sRGB → linear
  r /= 255;
  return r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
}
function lum(c) { return 0.2126 * rel(c.r) + 0.7152 * rel(c.g) + 0.0722 * rel(c.b); }
function ratio(a, b) { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
function parseColor(s) {
  // matches rgb(a) and oklch fallback won't fire here because playwright
  // returns computed style as rgba() always.
  const m = s.match(/rgba?\(\s*(\d+(?:\.\d+)?)[ ,]\s*(\d+(?:\.\d+)?)[ ,]\s*(\d+(?:\.\d+)?)(?:[ ,/]+\s*(\d+(?:\.\d+)?))?\s*\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
let exitCode = 0;

for (const p of paths) {
  const url = base.replace(/\/$/, "") + p;
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  } catch (e) {
    console.error(`${p}: goto failed - ${e.message}`);
    out.paths[p] = { url, error: e.message };
    exitCode = 1;
    await page.close();
    continue;
  }
  // Let scroll-reveal trigger by scrolling through the page so every
  // chapter actually paints in its revealed state.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.6;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
  const findings = await page.evaluate(() => {
    // Use a 1x1 canvas to normalize ANY CSS color (rgb, rgba, oklch, lab,
    // hex, named) into rgba — Chromium's computed style now serializes
    // OKLCH as the literal "oklch(...)" string which a regex on rgba()
    // would miss. Canvas always returns the actual rendered pixel.
    const _normCanvas = document.createElement("canvas");
    _normCanvas.width = 1; _normCanvas.height = 1;
    const _normCtx = _normCanvas.getContext("2d", { willReadFrequently: true });
    function rgbaOf(s) {
      if (!s) return null;
      try {
        _normCtx.clearRect(0, 0, 1, 1);
        _normCtx.fillStyle = "rgba(0,0,0,0)";
        _normCtx.fillStyle = s;
        // If canvas refused to parse, fillStyle reverts to last value;
        // sanity-check by reading it back.
        const set = _normCtx.fillStyle;
        if (!set || set === "rgba(0, 0, 0, 0)") {
          // Could legitimately be transparent; try a fresh canvas fill
          // and inspect pixel.
        }
        _normCtx.fillRect(0, 0, 1, 1);
        const [r, g, b, a8] = _normCtx.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a8 / 255 };
      } catch { return null; }
    }
    function blend(fg, bg) {
      const a = fg.a;
      return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
    }
    function effectiveBg(el) {
      let cur = el;
      while (cur && cur !== document.documentElement.parentNode) {
        const cs = getComputedStyle(cur);
        const c = rgbaOf(cs.backgroundColor);
        if (c && c.a > 0) {
          if (c.a >= 0.99) return c;
          // semi-transparent — blend over deeper ancestor
          const deeper = effectiveBg(cur.parentElement || document.documentElement);
          return blend(c, deeper);
        }
        cur = cur.parentElement;
      }
      // page bg fallback — white
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    function rel(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function lum(c) { return 0.2126 * rel(c.r) + 0.7152 * rel(c.g) + 0.0722 * rel(c.b); }
    function ratio(a, b) { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
    const els = Array.from(document.querySelectorAll("body *"));
    const violations = [];
    let total = 0;
    for (const el of els) {
      // visible + has direct text
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity < 0.1) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      const fg = rgbaOf(cs.color);
      if (!fg) continue;
      const bg = effectiveBg(el);
      const composedFg = fg.a < 0.99 ? blend(fg, bg) : fg;
      const r = ratio(composedFg, bg);
      total++;
      const sizePx = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10);
      const isLarge = sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);
      const threshold = isLarge ? 3.0 : 4.5;
      if (r < threshold) {
        violations.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className && typeof el.className === "string" ? el.className.slice(0, 80) : "",
          text: (el.textContent || "").trim().slice(0, 60),
          fg: `rgb(${Math.round(composedFg.r)},${Math.round(composedFg.g)},${Math.round(composedFg.b)})`,
          bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
          ratio: +r.toFixed(2),
          threshold,
          size: sizePx,
          weight,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      }
    }
    return { total, violations };
  });

  const slug = p.replace(/[\/]/g, "_").replace(/^_/, "") || "root";
  const shotPath = `/tmp/wcag-shot-${slug}.png`;
  await page.screenshot({ path: shotPath, fullPage: true });
  out.paths[p] = { url, total_text_nodes: findings.total, violations: findings.violations, console_errors: consoleErrors, screenshot: shotPath };
  out.summary.total_violations += findings.violations.length;
  out.summary.total_text_nodes += findings.total;
  console.log(`${p}: ${findings.total} text nodes, ${findings.violations.length} contrast violations, ${consoleErrors.length} console errors → ${shotPath}`);
  if (findings.violations.length > 0 || consoleErrors.length > 0) exitCode = 1;
  await page.close();
}

await browser.close();
fs.writeFileSync("/tmp/wcag-report.json", JSON.stringify(out, null, 2));
console.log(`\nreport: /tmp/wcag-report.json   summary: ${out.summary.total_violations} violations across ${out.summary.total_text_nodes} text nodes`);
process.exit(exitCode);
