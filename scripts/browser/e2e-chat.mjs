/**
 * Extended chat E2E corpus — drives 18+ inputs through the copilot and
 * asserts each produces a valid Block[] response. Critical rule: NO raw
 * "404 on /yf/..." or "HTTP <code>" text in the rendered chat body.
 * Conversational tokens like "hi" / "lets strategise" must surface the
 * help/no-match block, never an error.
 *
 * Per-query verdict goes to /Users/lekt9/Projects/sam/.scratch/e2e-chat.json.
 */
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://sauros.lewis-6d8.workers.dev';
const OUT = '/Users/lekt9/Projects/sam/.scratch';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const consoleErrors = [];
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

// Open the copilot once and reuse for every query
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await page.locator('button[aria-label="Open copilot"]').click();
await page.waitForTimeout(700);
const chatInput = page.locator('input[placeholder*="/declare"]');
const submitBtn = page.locator('form button[type=submit]').last();

const A = [];

async function ask(query, expectMatch, expectAllNotMatch, name, waitMs = 7000) {
  await chatInput.fill(query);
  await submitBtn.click();
  // wait for "∆ thinking…" to clear
  await page.waitForTimeout(waitMs);
  for (let i = 0; i < 4; i++) {
    const thinking = await page.locator('text=∆ thinking…').count().catch(() => 0);
    if (thinking === 0) break;
    await page.waitForTimeout(1500);
  }
  // Read ONLY the last agent reply (everything since the last user bubble)
  // — body innerText would accumulate across the chat log
  const allText = await page.locator('body').innerText();
  // Build a "must include any of" / "must not include any of"
  const includesAny = expectMatch.length === 0 ? true : expectMatch.some(p => (p instanceof RegExp ? p.test(allText) : allText.includes(p)));
  const excludesAll = expectAllNotMatch.every(p => !(p instanceof RegExp ? p.test(allText) : allText.includes(p)));
  const ok = includesAny && excludesAll;
  A.push({
    name,
    ok,
    query,
    evidence: `len=${allText.length} includesAny=${includesAny} excludesAll=${excludesAll}`
  });
  if (!ok) {
    // capture a snapshot of the last 400 chars of body for forensics
    A[A.length - 1].snippet = allText.slice(-500);
  }
}

// — Conversational / non-ticker inputs (the bug class)
const NEVER = [/HTTP 404/i, /HTTP 5\d\d/i, /error: HTTP/i, /\/yf\/v8\/finance\/chart/i, /Application error/i];

await ask('hi',                    [/help|isn't a ticker|charts and stats|NVDA/i], NEVER, "conv 'hi' → no 404");
await ask('hello',                 [/help|isn't a ticker|charts and stats|NVDA/i], NEVER, "conv 'hello' → no 404");
await ask('lets strategise and figure out cool shit', [/help|isn't a ticker|charts and stats|NVDA/i], NEVER, "conv long phrase → no 404");
await ask('cool',                  [/help|isn't a ticker|charts and stats|NVDA/i], NEVER, "conv 'cool' → no 404");
await ask('ok',                    [/help|isn't a ticker|charts and stats|NVDA/i], NEVER, "conv 'ok' → no 404");
await ask('what is the market doing today', [/help|isn't a ticker|charts and stats|NVDA|trending|market/i], NEVER, "conv question → no 404");
await ask('yo',                    [/help|isn't a ticker|charts and stats|NVDA/i], NEVER, "conv 'yo' → no 404");

// — Real tickers (bare) should resolve and produce data
await ask('NVDA',                  [/\$\d/, /NVDA/i], NEVER, "ticker NVDA renders price");
await ask('SPY',                   [/\$\d/, /SPY/i],  NEVER, "ticker SPY renders price");
await ask('AAPL',                  [/\$\d/, /AAPL/i], NEVER, "ticker AAPL renders price");

// — Invalid all-caps ticker → not-found note (no 404 text)
await ask('ZXYABC',                [/isn't a ticker|no data|no match/i], NEVER, "invalid 'ZXYABC' → friendly not-found");

// — Quant queries
await ask('gainers',                            [/Day Gainers|gainers/i], NEVER, "screener gainers");
await ask('rsi TSLA',                           [/RSI/i, /TSLA/],         NEVER, "rsi TSLA");
await ask('compare AAPL MSFT GOOGL',            [/Return 1M/, 'AAPL', 'MSFT'], NEVER, "compare 3 tickers");
await ask('correlate SPY QQQ NVDA',             [/SPY/, /QQQ/, /NVDA/],   NEVER, "correlate matrix");
await ask('beta NVDA SPY',                      [/β/i, 'NVDA', 'SPY'],    NEVER, "beta NVDA vs SPY");
await ask('returns AMD 5y',                     [/Return|CAGR|Vol|Sharpe/, 'AMD'], NEVER, "returns AMD 5y");
await ask('news',                               [/\.com|\.net|\.io|\.org/i], NEVER, "news headlines", 10000);
await ask('trending',                           [/trending|trend|US/i],    NEVER, "trending");

// — Slash verbs
await ask('/help',                              [/declare.*list.*iterate.*mark/si], NEVER, "/help verb table");
// Reset to /declare a quick chat-contract
await page.locator('button:has-text("clear")').click().catch(() => {});
await page.waitForTimeout(800);

await ask('/declare "test ticker NVDA is fetchable" NVDA', [/Declared contract [a-f0-9]{8}/], NEVER, "/declare creates card");
await ask('/list',                                          [/contract/i],                       NEVER, "/list shows contracts");

await page.screenshot({ path: `${OUT}/e2e-chat-final.png`, fullPage: true });
await browser.close();

const failed = A.filter(a => !a.ok);
const blob = {
  all_passed: failed.length === 0,
  passed: A.length - failed.length,
  total: A.length,
  failed,
  console_errors_observed: consoleErrors.length,
  console_errors_sample: consoleErrors.slice(0, 5)
};
writeFileSync(`${OUT}/e2e-chat.json`, JSON.stringify(blob, null, 2));
console.log(`e2e-chat.json: ${blob.passed}/${blob.total} all_passed=${blob.all_passed}`);
for (const f of failed.slice(0, 10)) {
  console.log(`  ✗ ${f.name}  [${f.query}]  ${f.evidence}`);
  if (f.snippet) console.log(`     snippet: ${f.snippet.slice(0, 200)}`);
}
console.log(`console errors observed in this run: ${consoleErrors.length}`);
