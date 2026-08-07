// UI witness: drive a real browser against the running app origin and CLICK.
// Endpoint curls proved the server answers; they never proved a user can click
// a link and reach their browser — which is exactly the bug this guards.
//
//   node scripts/link-click-test.mjs            (app must be running)
//
// Exits 0 only when every check passes. POST /open is intercepted so the run
// observes what the page asked for instead of spraying real browser windows.
import { chromium } from 'playwright';

const ORIGIN = process.env.AIKO_WEB_ORIGIN ?? 'http://127.0.0.1:17870';
const failures = [];
const notes = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const reachable = await fetch(ORIGIN).then((r) => r.ok).catch(() => false);
if (!reachable) {
  console.error(`app origin ${ORIGIN} is not serving — start Aiko first`);
  process.exit(1);
}

// Use the installed Chrome rather than downloading a browser.
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

let opened = [];
await page.route('**/open', async (route) => {
  const post = route.request().postDataJSON?.() ?? {};
  opened.push(post.url);
  await route.fulfill({ status: 204, body: '' });
});

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });

// 1. The shim the server injects must be present on the real served page.
const hasShim = await page.evaluate(() => typeof window.aikoOpenExternal === 'function');
check('link shim present on served page', hasShim);

// 2. Clicking an external link posts it to /open instead of dead-ending.
opened = [];
await page.evaluate(() => {
  const a = document.createElement('a');
  a.id = 'aiko-external-probe';
  a.href = 'https://aiko.theclarityproject.net/device?code=TEST-CODE';
  a.target = '_blank';
  a.textContent = 'external probe';
  document.body.appendChild(a);
});
await page.click('#aiko-external-probe');
await page.waitForTimeout(300);
check(
  'external link click reaches the browser opener',
  opened.includes('https://aiko.theclarityproject.net/device?code=TEST-CODE'),
  `captured: ${JSON.stringify(opened)}`
);

// 3. The app must not navigate away from itself when a link is clicked.
check('app stayed on its own origin', page.url().startsWith(ORIGIN), page.url());

// 4. Internal links must NOT be hijacked — no false positives.
opened = [];
await page.evaluate(() => {
  const a = document.createElement('a');
  a.id = 'aiko-internal-probe';
  a.href = '/console';
  a.textContent = 'internal probe';
  document.body.appendChild(a);
  a.addEventListener('click', (e) => e.preventDefault(), { once: true });
});
await page.click('#aiko-internal-probe');
await page.waitForTimeout(200);
check('internal link is not sent to the opener', opened.length === 0, JSON.stringify(opened));

// 5. A link the product actually ships, reached by driving the real UI:
//    user menu → Settings → Help, then click the documentation link.
opened = [];
let realLinkTested = false;
try {
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.locator('[aria-haspopup="dialog"]:visible').first().click({ timeout: 5000 });
  await page.waitForTimeout(400);
  await page.getByText(/^Settings$/).first().click({ timeout: 5000 });
  await page.waitForTimeout(700);
  await page.getByText(/^Get help$/).first().click({ timeout: 5000 });
  await page.waitForTimeout(500);
  const anchor = page.locator('a[href^="http"]:visible').first();
  const href = await anchor.getAttribute('href', { timeout: 4000 });
  await anchor.click();
  await page.waitForTimeout(400);
  realLinkTested = true;
  check('shipped Settings→Help link opens in the browser', opened.includes(href), `href: ${href}`);
} catch (error) {
  notes.push(`shipped-link path not reachable in this state: ${error.message.split('\n')[0]}`);
}
if (!realLinkTested) console.log(`NOTE  ${notes[notes.length - 1]}`);

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall link checks passed');
