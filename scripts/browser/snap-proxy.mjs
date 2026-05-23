import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const ROOT = '/Users/lekt9/Projects/sam/.scratch';
async function snap(path, name, wait = 7000) {
  await page.goto(`https://sauros.lewis-6d8.workers.dev${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${ROOT}/sauros-proxy-${name}.png`, fullPage: true });
  console.log(`${name} ok`);
}
await snap('/',          'home');
await snap('/quote/NVDA','quote-nvda');
await snap('/quote/AAPL','quote-aapl');
await snap('/watchlist', 'watchlist');
await snap('/heatmap',   'heatmap');
await browser.close();
