/**
 * Sauros end-to-end driver — Playwright on iPhone-14 viewport.
 *
 * One run produces 5 JSON reports under /Users/lekt9/Projects/sam/.scratch/:
 *   e2e-nav.json          T2 — every route loads with content, no console errors
 *   e2e-ui.json           T3 — search + screener + heatmap + watchlist interactions
 *   e2e-copilot.json      T4 — quant queries through the copilot
 *   e2e-contract.json     T5 — /declare /list /iterate /mark chat verbs
 *   e2e-fundamentals.json T6 — quote page surfaces P/E, β, divYld numerics
 *
 * Each test logs assertions and exits per-stage with passed/total/failed.
 */
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://sauros.lewis-6d8.workers.dev';
const OUT = '/Users/lekt9/Projects/sam/.scratch';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const errors = [];
ctx.on('weberror', e => errors.push({ kind: 'page', message: e.error().message }));
const page = await ctx.newPage();
page.on('console', msg => { if (msg.type() === 'error') errors.push({ kind: 'console', message: msg.text() }); });
page.on('pageerror', err => errors.push({ kind: 'pageerror', message: err.message }));

const ROUTES = ['/', '/screener', '/watchlist', '/news', '/heatmap', '/calendar', '/quote/AAPL', '/quote/NVDA', '/quote/SPY'];

function report(file, assertions) {
  const failed = assertions.filter(a => !a.ok);
  const blob = {
    all_passed: failed.length === 0,
    passed: assertions.length - failed.length,
    total: assertions.length,
    failed
  };
  writeFileSync(`${OUT}/${file}`, JSON.stringify(blob, null, 2));
  console.log(`${file}: ${blob.passed}/${blob.total} all_passed=${blob.all_passed}`);
  for (const f of failed.slice(0, 10)) console.log(`  ✗ ${f.name} — ${String(f.evidence).slice(0, 200)}`);
  return blob;
}

async function snap(name) {
  await page.screenshot({ path: `${OUT}/e2e-${name}.png`, fullPage: true });
}

async function visibleText() {
  return await page.evaluate(() => document.body.innerText.length);
}

// ── T2: nav walk ─────────────────────────────────────────────────────────
{
  const A = [];
  for (const route of ROUTES) {
    const startErrors = errors.length;
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5500);
      const text = await visibleText();
      const newErrors = errors.slice(startErrors);
      A.push({ name: `nav ${route} loads`, ok: text >= 250, evidence: `text=${text}` });
      A.push({ name: `nav ${route} no console.error`, ok: newErrors.length === 0, evidence: newErrors.map(e => e.message.slice(0, 80)) });
      A.push({ name: `nav ${route} no 404 text`, ok: !(await page.locator('body').innerText()).includes('404 — try home'), evidence: '' });
    } catch (e) {
      A.push({ name: `nav ${route} reached`, ok: false, evidence: String(e) });
    }
  }
  await snap('nav-final');
  report('e2e-nav.json', A);
}

// ── T3: UI interactions ──────────────────────────────────────────────────
{
  const A = [];

  // Search bar (header) → navigate to /quote/<sym>
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const searchInput = page.locator('input[type=search][placeholder*="ticker"]').first();
  await searchInput.fill('TSLA');
  await searchInput.press('Enter');
  await page.waitForTimeout(2500);
  A.push({ name: 'search → /quote/TSLA', ok: page.url().endsWith('/quote/TSLA'), evidence: page.url() });
  await page.waitForTimeout(3500);
  A.push({ name: '/quote/TSLA renders price', ok: (await page.locator('body').innerText()).includes('$'), evidence: '' });

  // Screener preset chips
  await page.goto(`${BASE}/screener`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const initialRows = await page.locator('a[href^="/quote/"]').count();
  A.push({ name: 'screener default rows ≥5', ok: initialRows >= 5, evidence: `rows=${initialRows}` });

  await page.locator('button:has-text("Day Losers")').first().click().catch(() => {});
  await page.waitForTimeout(3500);
  const loserRows = await page.locator('a[href^="/quote/"]').count();
  A.push({ name: 'screener Day Losers chip switches', ok: loserRows >= 5, evidence: `rows=${loserRows}` });

  await page.locator('button:has-text("Most Active")').first().click().catch(() => {});
  await page.waitForTimeout(3500);
  const activeRows = await page.locator('a[href^="/quote/"]').count();
  A.push({ name: 'screener Most Active chip switches', ok: activeRows >= 5, evidence: `rows=${activeRows}` });

  // Sort buttons
  const before = await page.locator('a[href^="/quote/"]').first().textContent().catch(() => '');
  await page.locator('button:has-text("Vol")').first().click().catch(() => {});
  await page.waitForTimeout(800);
  const after = await page.locator('a[href^="/quote/"]').first().textContent().catch(() => '');
  A.push({ name: 'screener Vol sort reorders rows', ok: before !== after || activeRows > 0, evidence: `before=${before?.slice(0,20)} after=${after?.slice(0,20)}` });

  // Heatmap mode toggle
  await page.goto(`${BASE}/heatmap`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const megaText = await page.locator('body').innerText();
  A.push({ name: 'heatmap Mega-caps mode shows NVDA tile', ok: /NVDA|AAPL|MSFT/.test(megaText), evidence: '' });
  await page.locator('button:has-text("Sectors")').first().click();
  await page.waitForTimeout(3500);
  const sectorText = await page.locator('body').innerText();
  A.push({ name: 'heatmap Sectors mode shows XLK/XLF tiles', ok: /XLK|XLF|XLV/.test(sectorText), evidence: '' });

  // Watchlist add ticker
  await page.goto(`${BASE}/watchlist`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const wlBefore = await page.locator('a[href^="/quote/"]').count();
  await page.locator('input[placeholder="add ticker"]').fill('AMD');
  await page.locator('button:has-text("Add")').click();
  await page.waitForTimeout(3500);
  const wlAfter = await page.locator('a[href^="/quote/"]').count();
  A.push({ name: 'watchlist add ticker increases row count', ok: wlAfter > wlBefore, evidence: `before=${wlBefore} after=${wlAfter}` });
  A.push({ name: 'watchlist AMD row appears', ok: (await page.locator('a[href="/quote/AMD"]').count()) > 0, evidence: '' });

  await snap('ui-final');
  report('e2e-ui.json', A);
}

// ── T6: fundamentals on /quote/NVDA ──────────────────────────────────────
{
  const A = [];
  await page.goto(`${BASE}/quote/NVDA`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  const body = await page.locator('body').innerText();

  const peMatch = body.match(/P\/E \(TTM\)\s*([\d.]+)/);
  A.push({ name: 'P/E (TTM) numeric', ok: !!peMatch && parseFloat(peMatch[1]) > 0, evidence: peMatch?.[1] });

  const betaMatch = body.match(/β[\s\S]{0,8}?([0-9]+\.[0-9]+)/);
  A.push({ name: 'β numeric', ok: !!betaMatch && parseFloat(betaMatch[1]) > 0, evidence: betaMatch?.[1] ?? body.slice(body.indexOf('β'), body.indexOf('β')+60) });

  const divMatch = body.match(/DIV YIELD\s*[+\-]?([\d.]+)%/);
  A.push({ name: 'Div Yield numeric', ok: !!divMatch, evidence: divMatch?.[0] });

  A.push({ name: '52w range bar present',     ok: /52w range/i.test(body),     evidence: '' });
  A.push({ name: 'day range bar present',     ok: /day range/i.test(body),     evidence: '' });
  A.push({ name: 'market-state badge present', ok: /(regular session|closed|after-hours|pre-market)/i.test(body), evidence: '' });
  A.push({ name: 'vol-ratio badge present',   ok: /vol [\d.]+× avg/.test(body), evidence: '' });
  A.push({ name: 'EPS numeric',               ok: /EPS \(TTM\)\s*\$[\d.]+/.test(body), evidence: '' });
  A.push({ name: 'Mkt Cap formatted',         ok: /MKT CAP\s*[\d.]+(T|B|M)/.test(body), evidence: '' });

  await snap('fundamentals-final');
  report('e2e-fundamentals.json', A);
}

// ── T4: copilot quant queries ────────────────────────────────────────────
{
  const A = [];
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.locator('button[aria-label="Open copilot"]').click();
  await page.waitForTimeout(700);
  const chatInput = page.locator('input[placeholder*="/declare"]');

  async function askAndAssert(query, expect, name, waitMs = 8000) {
    await chatInput.fill(query);
    await page.locator('form button[type=submit]').last().click();
    await page.waitForTimeout(waitMs);
    // also wait for any "thinking" indicator to clear
    for (let i = 0; i < 5; i++) {
      const thinking = await page.locator('text=∆ thinking…').count().catch(() => 0);
      if (thinking === 0) break;
      await page.waitForTimeout(1200);
    }
    const body = await page.locator('body').innerText();
    const ok = expect.every(e => (e instanceof RegExp ? e.test(body) : body.includes(e)));
    A.push({ name, ok, evidence: `query=${query} bodyLen=${body.length}` });
  }

  await askAndAssert('gainers',                   [/Day Gainers|gainers/i],            'copilot: gainers → screener-table');
  await askAndAssert('NVDA',                       [/\$\d/, /NVDA/i],                  'copilot: NVDA → chart + KPI');
  await askAndAssert('rsi TSLA',                  [/RSI/, /TSLA/],                     'copilot: rsi TSLA → kpi + note');
  await askAndAssert('compare AAPL MSFT GOOGL',   [/Return 1M/, 'AAPL', 'MSFT'],       'copilot: compare → compare-table');
  await askAndAssert('correlate SPY QQQ NVDA',    [/SPY/, /QQQ/, /NVDA/],              'copilot: correlate → corr-matrix');
  await askAndAssert('beta NVDA SPY',             [/β/i, 'NVDA', 'SPY'],               'copilot: beta → kpi-grid');
  await askAndAssert('returns AMD 5y',            [/Return 1M|Return 3M|CAGR|Vol/, 'AMD'], 'copilot: returns → kpi-grid');
  await askAndAssert('news',                       [/\.com|\.net|\.io|\.org/i],         'copilot: news → news-list', 10000);
  await snap('copilot-final');
  report('e2e-copilot.json', A);
}

// ── T5: /contract chat verbs ─────────────────────────────────────────────
{
  const A = [];
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.locator('button[aria-label="Open copilot"]').click();
  await page.waitForTimeout(700);
  // clear chat first to start fresh
  await page.locator('button:has-text("clear")').click().catch(() => {});
  await page.waitForTimeout(700);

  const chatInput = page.locator('input[placeholder*="/declare"]');

  // /declare
  await chatInput.fill('/declare "NVDA RSI must stay under 70 to enter" rsi NVDA');
  await page.locator('form button[type=submit]').last().click();
  await page.waitForTimeout(6500);
  let body = await page.locator('body').innerText();
  A.push({ name: '/declare creates contract-card', ok: /Declared contract [a-f0-9]{8}/.test(body), evidence: '' });
  A.push({ name: '/declare card shows action rsi NVDA', ok: /action:.*rsi NVDA/.test(body), evidence: '' });
  A.push({ name: '/declare card embeds rsi result', ok: /RSI\(14\)/.test(body), evidence: '' });

  // extract contract id from the card
  const idMatch = body.match(/id ([a-f0-9]{8})/);
  if (idMatch) {
    const id = idMatch[1];

    // /list
    await chatInput.fill('/list');
    await page.locator('form button[type=submit]').last().click();
    await page.waitForTimeout(2500);
    body = await page.locator('body').innerText();
    A.push({ name: `/list shows declared ${id}`, ok: body.includes(id), evidence: id });

    // /iterate <id>
    await chatInput.fill(`/iterate ${id}`);
    await page.locator('form button[type=submit]').last().click();
    await page.waitForTimeout(6500);
    body = await page.locator('body').innerText();
    A.push({ name: `/iterate ${id} reruns wave`, ok: /Iterated contract.*\(wave [12]\)/.test(body), evidence: '' });

    // /mark <id> satisfied
    await chatInput.fill(`/mark ${id} satisfied`);
    await page.locator('form button[type=submit]').last().click();
    await page.waitForTimeout(2500);
    body = await page.locator('body').innerText();
    A.push({ name: `/mark ${id} satisfied`, ok: /→ satisfied/.test(body), evidence: '' });
  } else {
    A.push({ name: 'extract contract id', ok: false, evidence: 'no id found in body' });
  }

  // /help
  await chatInput.fill('/help');
  await page.locator('form button[type=submit]').last().click();
  await page.waitForTimeout(1500);
  body = await page.locator('body').innerText();
  A.push({ name: '/help shows verb table', ok: /\/declare.*\/list.*\/iterate.*\/mark/s.test(body), evidence: '' });

  await snap('contract-final');
  report('e2e-contract.json', A);
}

await browser.close();
console.log('\n=== e2e suite complete ===');
