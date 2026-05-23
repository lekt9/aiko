import { chromium, devices } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const ROOT = '/Users/lekt9/Projects/sam/.scratch';

async function snap(path, name, wait = 6000) {
  await page.goto(`https://sauros.lewis-6d8.workers.dev${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${ROOT}/sauros-uiux-${name}.png`, fullPage: true });
  console.log(`${name} ok`);
}

await snap('/',          'home');
await snap('/heatmap',   'heatmap');
await snap('/quote/NVDA','quote');
await snap('/screener',  'screener');
await snap('/watchlist', 'watchlist');

await browser.close();
