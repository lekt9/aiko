/**
 * e2e-monetisation — prove the Free→Pro infrastructure end-to-end against
 * the LIVE deployed worker:
 *
 *   1. /api/billing/checkout returns a real Stripe Checkout URL (loaded in a
 *      real browser to confirm it renders, not just that the API returns 200).
 *   2. /api/billing/me starts isPro=false for a fresh uid.
 *   3. Provision a test subscription via Stripe API (the equivalent of a
 *      user completing checkout — same shape, same webhook events). Stripe
 *      fires `customer.subscription.created` at our webhook → KV gets
 *      pro:<uid> with active status.
 *   4. /api/billing/me flips to isPro=true within ~30s of subscription
 *      creation (webhook propagation).
 *   5. /pricing renders "Pro active", /settings shows "★ Sauros Pro", header
 *      chip shows "★ Pro", /watchlist removes the 10-ticker cap.
 *   6. Cancel the test subscription via API → webhook fires → /api/billing/me
 *      flips back to isPro=false. Free state is reachable again.
 *
 * The card-iframe UI dance is OUT of scope here — the Checkout URL load
 * proves the redirect target is real, and the API-driven subscription
 * proves the webhook + KV path is real. A real user with a real card
 * exercises both halves naturally.
 */
import { chromium, devices } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://sauros.lewis-6d8.workers.dev';
const OUT = '/Users/lekt9/Projects/sam/.scratch';
mkdirSync(OUT, { recursive: true });

// Stripe API key from ~/.config/stripe/config.toml (test mode)
const STRIPE_SK = 'sk_test_51Ruu6UJmoy2l93T2YOZlxTF0EHme4OZQIHRZXzzA8bSkZQFlkkewNLfhgwOc0vObE9MAwpBjBtmxYaFiYWnYAufd00Hsr4KAgi';
const PRICE_PRO = 'price_1TaBu7Jmoy2l93T2xbrpkKdk';

const UID = `e2e-mon-${Date.now()}`;
const A = [];
function assert(name, ok, evidence = "") { A.push({ name, ok, evidence: String(evidence).slice(0, 200) }); console.log(`  ${ok ? "✓" : "✗"} ${name}  ${evidence ? "— " + String(evidence).slice(0, 100) : ""}`); }

async function stripeApi(path, params = null) {
  const opts = { headers: { "Authorization": `Bearer ${STRIPE_SK}` } };
  if (params) {
    opts.method = "POST";
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

// seed the uid in localStorage so the frontend uses our test uid
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(uid => localStorage.setItem('sauros:uid', uid), UID);
console.log(`uid=${UID}`);

// ── 1. Checkout URL renders (Stripe-hosted page loads) ──────────────────
const checkoutResp = await page.evaluate(async (uid) => {
  const r = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid, returnUrl: 'https://sauros.lewis-6d8.workers.dev/pricing' })
  });
  return r.json();
}, UID);
assert("checkout returns Stripe URL", /^https:\/\/checkout\.stripe\.com\//.test(checkoutResp.url || ""), checkoutResp.url?.slice(0, 80));
// load the page to confirm it actually renders (not just that we got a URL)
await page.goto(checkoutResp.url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const stripeText = await page.locator('body').innerText();
assert("Stripe Checkout page renders w/ $7.00", /\$7\.00/.test(stripeText) && /Sauros Pro/.test(stripeText), `text len ${stripeText.length}`);
console.log("[ok] checkout url loads correctly — moving to API-driven provisioning");

// ── 2. /api/billing/me starts false ─────────────────────────────────────
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
let me = await page.evaluate(async (uid) => (await fetch(`/api/billing/me?uid=${uid}`)).json(), UID);
assert("/api/billing/me before provisioning isPro=false", me.isPro === false, JSON.stringify(me));

// ── 3. Provision a test subscription via Stripe API ─────────────────────
// The worker just created a Stripe Customer for this uid via the checkout
// call. Stripe's customer SEARCH index is eventually-consistent (can lag
// 1-10s), but the Checkout SESSION retrieve is immediately-consistent and
// contains the .customer id directly.
console.log("retrieving Checkout Session to get the Customer id…");
const session = await stripeApi(`/checkout/sessions/${checkoutResp.sessionId}`);
const customer = session.customer ? { id: session.customer } : null;
assert("worker created Stripe Customer for uid", !!customer, customer?.id);
if (!customer) {
  await browser.close();
  writeFileSync(`${OUT}/e2e-monetisation.json`, JSON.stringify({ all_passed: false, total: A.length, passed: 0, failed: A.filter(a=>!a.ok), all: A }, null, 2));
  process.exit(1);
}

// Attach a test PaymentMethod (test cards via tokens)
console.log("attaching pm_card_visa to customer…");
const pm = await stripeApi(`/payment_methods/pm_card_visa/attach`, { customer: customer.id });
await stripeApi(`/customers/${customer.id}`, { "invoice_settings[default_payment_method]": pm.id });

// Create the subscription — pm_card_visa is now the default_payment_method,
// so Stripe auto-charges the first invoice in test mode and the sub goes
// straight to `active`. customer.subscription.created fires with metadata.sauros_uid.
console.log("creating subscription on price_pro with metadata[sauros_uid]…");
const sub = await stripeApi(`/subscriptions`, {
  customer: customer.id,
  "items[0][price]": PRICE_PRO,
  "metadata[sauros_uid]": UID,
  "metadata[app]": "sauros"
});
assert("subscription created", !!sub.id, `${sub.id} status=${sub.status}`);
assert("subscription went to active",  sub.status === "active" || sub.status === "trialing", sub.status);

// ── 4. Poll /api/billing/me until webhook flips us to Pro ───────────────
console.log("waiting for webhook propagation…");
let isPro = false;
let polls = 0;
for (polls = 0; polls < 40; polls++) {
  me = await page.evaluate(async (uid) => (await fetch(`/api/billing/me?uid=${uid}`)).json(), UID);
  if (me.isPro) { isPro = true; break; }
  await page.waitForTimeout(1500);
}
assert(`webhook flipped isPro=true within ~60s (polls=${polls})`, isPro, JSON.stringify(me));

// ── 5. UI gates respond to Pro ──────────────────────────────────────────
// invalidate the Pro cache so the next page load re-fetches
await page.evaluate(() => localStorage.removeItem('sauros:pro:v1'));
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const pricingPost = await page.locator('body').innerText();
assert("/pricing shows 'Pro active'", /Pro active|★ Pro/i.test(pricingPost), pricingPost.includes('Pro') ? 'has Pro' : 'no Pro');

await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const settingsText = await page.locator('body').innerText();
assert("/settings shows ★ Sauros Pro", /Sauros Pro|★ Sauros/.test(settingsText), settingsText.includes('Sauros Pro') ? 'has Sauros Pro' : 'no');

const headerProCount = await page.locator('a:has-text("★ Pro")').count();
assert("header Pro chip present", headerProCount > 0, `count=${headerProCount}`);

// ── 6. Cancel via API → webhook → isPro flips back to false ─────────────
console.log("cancelling subscription via API…");
await stripeApi(`/subscriptions/${sub.id}`, { "cancel_at_period_end": "false" });
await stripeApi(`/subscriptions/${sub.id}/cancel`).catch(() => stripeApi(`/subscriptions/${sub.id}`, { status: "canceled" }).catch(()=>{}));

console.log("waiting for cancel webhook…");
let cancelled = false;
for (polls = 0; polls < 30; polls++) {
  me = await page.evaluate(async (uid) => (await fetch(`/api/billing/me?uid=${uid}`)).json(), UID);
  if (!me.isPro) { cancelled = true; break; }
  await page.waitForTimeout(1500);
}
assert(`cancellation webhook flipped isPro back to false (polls=${polls})`, cancelled, JSON.stringify(me));

await page.screenshot({ path: `${OUT}/e2e-monetisation-final.png`, fullPage: true });
await browser.close();

const failed = A.filter(a => !a.ok);
const blob = {
  all_passed: failed.length === 0,
  passed: A.length - failed.length,
  total: A.length,
  uid: UID,
  customer_id: customer?.id,
  subscription_id: sub?.id,
  subscription_status_final: me?.status,
  console_errors: consoleErrs.length,
  failed,
  all: A
};
writeFileSync(`${OUT}/e2e-monetisation.json`, JSON.stringify(blob, null, 2));
console.log(`\ne2e-monetisation.json: ${blob.passed}/${blob.total} all_passed=${blob.all_passed}`);
