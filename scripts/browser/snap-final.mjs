import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const R = '/Users/lekt9/Projects/sam/.scratch';
async function snap(path, name, w = 6500) {
  await page.goto(`https://sauros.lewis-6d8.workers.dev${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(w);
  await page.screenshot({ path: `${R}/sauros-v5-${name}.png`, fullPage: true });
}
await snap('/',           'home');
await snap('/quote/NVDA', 'quote-nvda');
await snap('/quote/SPY',  'quote-spy');
await snap('/heatmap',    'heatmap');
await snap('/news',       'news');
// copilot showcase
await page.goto('https://sauros.lewis-6d8.workers.dev/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.locator('button[aria-label="Open copilot"]').click();
await page.waitForTimeout(700);
const input = page.locator('input[placeholder*="/declare"]');
await input.fill('/declare "NVDA RSI stays under 70 to enter" rsi NVDA');
await page.locator('form button[type=submit]').last().click();
await page.waitForTimeout(7000);
await page.screenshot({ path: `${R}/sauros-v5-copilot-contract.png`, fullPage: true });
await browser.close();
