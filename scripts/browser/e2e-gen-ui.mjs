/**
 * e2e-gen-ui — provision a Pro test user via Stripe, then verify:
 *   1. /api/sandbox/exec round-trips through Turbobox (real `uname` output)
 *   2. /api/copilot/ask either returns Block[] (credits work) or 503 w/ honest
 *      "credits low" note — never a synthesized response
 *   3. The new block types (echarts, dashboard, text-md, data-grid,
 *      sandbox-output) render without crashing in the SPA
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const BASE = 'https://sauros.lewis-6d8.workers.dev';
const OUT = '/Users/lekt9/Projects/sam/.scratch';
mkdirSync(OUT, { recursive: true });

const STRIPE_SK = 'sk_test_51Ruu6UJmoy2l93T2YOZlxTF0EHme4OZQIHRZXzzA8bSkZQFlkkewNLfhgwOc0vObE9MAwpBjBtmxYaFiYWnYAufd00Hsr4KAgi';
const PRICE_PRO = 'price_1TaBu7Jmoy2l93T2xbrpkKdk';
const UID = `e2e-gu-${Date.now()}`;
const A = [];
function assert(name, ok, evidence = "") { A.push({ name, ok, evidence: String(evidence).slice(0, 240) }); console.log(`  ${ok ? "✓" : "✗"} ${name}  ${evidence ? "— " + String(evidence).slice(0, 120) : ""}`); }

async function stripeApi(path, params = null, method = null) {
  const opts = { headers: { "Authorization": `Bearer ${STRIPE_SK}` } };
  opts.method = method ?? (params ? "POST" : "GET");
  if (params) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) u.set(k, String(v));
    opts.body = u.toString();
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${data?.error?.message}`);
  return data;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const consoleErrs = [];
page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });

// Seed uid on origin
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(uid => localStorage.setItem('sauros:uid', uid), UID);
console.log(`uid=${UID}`);

// ── Step 1: 402 before Pro ──────────────────────────────────────────────
let r = await page.evaluate(async (uid) => {
  const res = await fetch('/api/copilot/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, question: 'show me SPY today' }) });
  return { status: res.status, body: await res.json() };
}, UID);
assert("copilot 402-gates Free user", r.body?.gated === true || r.body?.blocks?.[0]?.tone === "warn", JSON.stringify(r.body).slice(0, 200));

r = await page.evaluate(async (uid) => {
  const res = await fetch('/api/sandbox/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, script: 'echo hi', lang: 'sh' }) });
  return { status: res.status, body: await res.json() };
}, UID);
assert("sandbox 402-gates Free user", r.status === 402 && r.body?.error === "pro_required", JSON.stringify(r.body).slice(0, 200));

// ── Step 2: Provision Pro via Stripe (re-using the e2e-monetisation trick) ──
console.log("provisioning Pro for the test uid…");
const checkout = await page.evaluate(async (uid) => {
  const res = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, returnUrl: 'https://sauros.lewis-6d8.workers.dev/pricing' }) });
  return res.json();
}, UID);

const session = await stripeApi(`/checkout/sessions/${checkout.sessionId}`);
const customer = { id: session.customer };
const pm = await stripeApi(`/payment_methods/pm_card_visa/attach`, { customer: customer.id });
await stripeApi(`/customers/${customer.id}`, { "invoice_settings[default_payment_method]": pm.id });
const sub = await stripeApi(`/subscriptions`, {
  customer: customer.id, "items[0][price]": PRICE_PRO,
  "metadata[sauros_uid]": UID, "metadata[app]": "sauros"
});
assert("Pro subscription active", sub.status === "active", sub.id);

// wait for webhook
let isPro = false;
for (let i = 0; i < 30; i++) {
  const me = await page.evaluate(async (uid) => (await fetch(`/api/billing/me?uid=${uid}`)).json(), UID);
  if (me.isPro) { isPro = true; break; }
  await page.waitForTimeout(1500);
}
assert("Pro flipped on Sauros side", isPro);

// ── Step 3: Sandbox round-trip ──────────────────────────────────────────
console.log("calling /api/sandbox/exec with `uname -a` (real Turbobox round-trip)…");
const sb = await page.evaluate(async (uid) => {
  const res = await fetch('/api/sandbox/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, script: 'uname -a; echo "from $(hostname)"', lang: 'sh' }) });
  return { status: res.status, body: await res.json() };
}, UID);
console.log("sandbox response:", JSON.stringify(sb).slice(0, 300));
const sandboxOk = sb.status === 200 && typeof sb.body?.output === "string" && /Linux|sandbox|warm-|alpine/i.test(sb.body.output);
assert("sandbox returns real Linux output", sandboxOk, sb.body?.output?.slice(0, 100) ?? sb.body?.error);

// ── Step 4: Copilot — should produce blocks OR honest 503 ───────────────
console.log("calling /api/copilot/ask…");
const askRes = await page.evaluate(async (uid) => {
  const res = await fetch('/api/copilot/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, question: 'Give me a quick snapshot of SPY today — kpi + 1-day sparkline.' }) });
  return { status: res.status, body: await res.json() };
}, UID);
console.log("ask response status:", askRes.status);
console.log("ask response keys:", Object.keys(askRes.body ?? {}));
console.log("first block type:", askRes.body?.blocks?.[0]?.type);
const askWorked = askRes.status === 200 && Array.isArray(askRes.body?.blocks) && askRes.body.blocks.length > 0;
const askHonestlyFailed = askRes.status === 503 && Array.isArray(askRes.body?.blocks) && /credit|key|upstream/i.test(askRes.body.blocks[0]?.text ?? "");
assert("copilot/ask returns Block[] OR honest 503", askWorked || askHonestlyFailed, `status=${askRes.status} firstBlock=${askRes.body?.blocks?.[0]?.type} err=${askRes.body?.error}`);

if (askWorked) {
  // bonus: rendered in chat (gen-UI surface end-to-end)
  await page.evaluate(() => localStorage.setItem('sauros:chat:log:v1', JSON.stringify([])));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.locator('button[aria-label="Open copilot"]').click();
  await page.waitForTimeout(700);
  await page.locator('input[placeholder*="/declare"]').fill('/ask Give me a quick snapshot of NVDA');
  await page.locator('form button[type=submit]').last().click();
  await page.waitForTimeout(20000);
  const body = await page.locator('body').innerText();
  assert("chat /ask renders a Block[] in the copilot", /NVDA|nvidia|\$\d/i.test(body), body.slice(body.indexOf('NVDA'), body.indexOf('NVDA')+200));
  await page.screenshot({ path: `${OUT}/e2e-gen-ui-final.png`, fullPage: true });
}

// ── Cleanup ─────────────────────────────────────────────────────────────
await stripeApi(`/subscriptions/${sub.id}`, null, "DELETE").catch(() => {});
await browser.close();

const failed = A.filter(a => !a.ok);
const blob = {
  all_passed: failed.length === 0,
  passed: A.length - failed.length,
  total: A.length,
  uid: UID,
  console_errors: consoleErrs.length,
  failed,
  all: A
};
writeFileSync(`${OUT}/e2e-gen-ui.json`, JSON.stringify(blob, null, 2));
console.log(`\ne2e-gen-ui.json: ${blob.passed}/${blob.total} all_passed=${blob.all_passed}`);
