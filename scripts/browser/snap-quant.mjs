import { chromium, devices } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const ROOT = '/Users/lekt9/Projects/sam/.scratch';

// 1. Open copilot, type "compare AAPL MSFT GOOGL", capture
await page.goto('https://sauros.lewis-6d8.workers.dev/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.locator('button[aria-label="Open copilot"]').click();
await page.waitForTimeout(500);
const input = page.locator('input[placeholder*="/declare"]');
await input.fill('compare AAPL MSFT GOOGL');
await page.locator('button[type=submit]').click();
await page.waitForTimeout(5000);
await page.screenshot({ path: `${ROOT}/sauros-quant-compare.png`, fullPage: true });
console.log('compare ok');

// 2. RSI TSLA
await input.fill('rsi TSLA');
await page.locator('button[type=submit]').click();
await page.waitForTimeout(4500);
await page.screenshot({ path: `${ROOT}/sauros-quant-rsi.png`, fullPage: true });
console.log('rsi ok');

// 3. /declare and the contract-card surface
await input.fill('/declare "NVDA RSI must stay under 70 to enter" rsi NVDA');
await page.locator('button[type=submit]').click();
await page.waitForTimeout(5000);
await page.screenshot({ path: `${ROOT}/sauros-quant-contract.png`, fullPage: true });
console.log('contract ok');

// 4. Correlate
await input.fill('correlate SPY QQQ NVDA AMD BTC-USD');
await page.locator('button[type=submit]').click();
await page.waitForTimeout(7000);
await page.screenshot({ path: `${ROOT}/sauros-quant-corr.png`, fullPage: true });
console.log('correlate ok');

await browser.close();
