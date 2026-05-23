import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
await page.goto('https://sauros.lewis-6d8.workers.dev/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.screenshot({ path: '/Users/lekt9/Projects/sam/.scratch/sauros-home.png', fullPage: true });
console.log('home ok');

await page.goto('https://sauros.lewis-6d8.workers.dev/screener', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.screenshot({ path: '/Users/lekt9/Projects/sam/.scratch/sauros-screener.png', fullPage: true });
console.log('screener ok');

await page.goto('https://sauros.lewis-6d8.workers.dev/quote/NVDA', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.screenshot({ path: '/Users/lekt9/Projects/sam/.scratch/sauros-quote.png', fullPage: true });
console.log('quote ok');

await browser.close();
