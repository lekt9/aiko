import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const R = '/Users/lekt9/Projects/sam/.scratch';
async function snap(path, name, w = 6000) {
  await page.goto(`https://sauros.lewis-6d8.workers.dev${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(w);
  await page.screenshot({ path: `${R}/sauros-money-${name}.png`, fullPage: true });
  console.log(name, 'ok');
}
await snap('/pricing',     'pricing');
await snap('/settings',    'settings');
await snap('/quote/NVDA',  'quote-with-affiliate');
await snap('/watchlist',   'watchlist');
await browser.close();
