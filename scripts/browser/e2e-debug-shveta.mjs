// One-off diagnostic — log every step's outcome instead of failing silently.
import { chromium } from "playwright";

const TOKEN = process.env.ADMIN_OWNER_TOKEN;
if (!TOKEN) { console.error("ADMIN_OWNER_TOKEN env required"); process.exit(2); }

const URL = "https://shveta-agent.pages.dev";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => console.log(`  [console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

async function step(label, fn) {
  const t0 = Date.now();
  try { await fn(); console.log(`  ✓ [${Date.now() - t0}ms] ${label}`); }
  catch (e) { console.log(`  ✗ [${Date.now() - t0}ms] ${label}: ${e.message?.split("\n")[0]}`); }
}

async function dumpText(label) {
  const t = (await page.evaluate(() => document.body.innerText)) || "";
  console.log(`  --- innerText (${label}, ${t.length} chars) ---`);
  console.log("  " + t.split("\n").slice(0, 18).map((s) => s.slice(0, 100)).join("\n  "));
  console.log("  ---");
}

await step("goto /admin", () => page.goto(`${URL}/admin`, { waitUntil: "domcontentloaded" }));
await page.waitForTimeout(2000);
await dumpText("loaded");

await step("fill password", () => page.fill("input[type=password]", TOKEN));
await step("click submit", () => page.click("button[type=submit]"));
await page.waitForTimeout(3500);
await dumpText("post-login");

await step("locate Chat button", () => page.waitForSelector("button:has-text('Chat')", { timeout: 8000 }));
await step("click Chat", () => page.click("button:has-text('Chat')"));
await page.waitForTimeout(1500);
await dumpText("chat-tab");

await step("fill chat input", () => page.fill("input[placeholder*='contract turn']", "make 2 hailuo variants for perfect-night"));
await step("submit chat", () => page.click("form button[type=submit]"));
await page.waitForTimeout(2500);
await dumpText("chat-fired");

console.log("\n--- waiting 180s for video URLs to land ---");
for (let i = 0; i < 18; i++) {
  await page.waitForTimeout(10000);
  const html = await page.content();
  const m = html.match(/(https?:\/\/[^"'<>\s]*?\.(mp4|m3u8|webm))/g);
  console.log(`  [${(i + 1) * 10}s] video urls in DOM: ${(m && m.length) || 0}${m ? " — " + m.slice(0, 2).join(", ") : ""}`);
  if (m && m.length >= 1) break;
}

await dumpText("final");

const html = await page.content();
const urls = (html.match(/https?:\/\/[^"'<>\s]*?\.(mp4|m3u8|webm)/g) || []);
console.log("\nVIDEO URLS:", urls);
await browser.close();
process.exit(urls.length > 0 ? 0 : 1);
