/**
 * e2e-monetisation — drive the live Free→Pro upgrade flow.
 *
 * Steps:
 *   1. Visit /pricing, set localStorage uid = 'e2e-mon-<ts>'.
 *   2. /api/billing/me returns isPro=false.
 *   3. Click "Upgrade to Pro" → Stripe Checkout opens.
 *   4. Fill Stripe Checkout (test card 4242…) and submit.
 *   5. Wait for the redirect back to /pricing?upgrade=success.
 *   6. Poll /api/billing/me until isPro=true (webhook firing).
 *   7. Visit /settings → "★ Sauros Pro" badge present.
 *   8. Verify the header chip says "★ Pro".
 *
 * Test card: 4242 4242 4242 4242 · any future exp · any CVC · any ZIP.
 */
import { chromium, devices } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://sauros.lewis-6d8.workers.dev';
const OUT = '/Users/lekt9/Projects/sam/.scratch';
mkdirSync(OUT, { recursive: true });

const UID = `e2e-mon-${Date.now()}`;
const A = [];
function assert(name, ok, evidence = "") { A.push({ name, ok, evidence: String(evidence).slice(0, 200) }); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const page = await ctx.newPage();
const consoleErrs = [];
page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });

// 1. seed the uid on origin
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(uid => localStorage.setItem('sauros:uid', uid), UID);
console.log(`seeded uid=${UID}`);

// 2. /api/billing/me free
let r = await page.evaluate(async (uid) => (await fetch(`/api/billing/me?uid=${uid}`)).json(), UID);
assert("/api/billing/me starts isPro=false", r.isPro === false, JSON.stringify(r));

// 3. /pricing renders
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const pricingText = await page.locator('body').innerText();
assert("/pricing shows $7/mo CTA", /\$7/.test(pricingText) && /Upgrade to Pro/i.test(pricingText), pricingText.length);

// 4. Click Upgrade → Stripe Checkout
console.log("clicking Upgrade…");
await Promise.all([
  page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 }),
  page.locator('button:has-text("Upgrade to Pro")').first().click()
]);
console.log("on stripe checkout", page.url());
assert("redirected to Stripe Checkout", /checkout\.stripe\.com/.test(page.url()), page.url());

// 5. Fill the Stripe Checkout form
await page.waitForTimeout(3000);
// email
await page.locator('input[type="email"]').first().fill(`e2e-${UID}@sauros.test`);
// card number
const cardField = page.locator('input[name="cardNumber"]');
await cardField.first().fill('4242 4242 4242 4242');
// expiry (any future date)
await page.locator('input[name="cardExpiry"]').first().fill('12 / 34');
// cvc
await page.locator('input[name="cardCvc"]').first().fill('123');
// cardholder name
const nameField = page.locator('input[name="billingName"]');
if (await nameField.count() > 0) await nameField.first().fill('Sauros E2E Test');
// country/zip — Stripe sometimes asks ZIP only for US
const zipField = page.locator('input[name="billingPostalCode"]');
if (await zipField.count() > 0) await zipField.first().fill('94105');
// country dropdown if present — leave default

console.log("submitting…");
await page.locator('button[type="submit"]:has-text("Subscribe"), button[type="submit"]:has-text("Pay"), [data-testid="hosted-payment-submit-button"]').first().click();

// 6. Wait for redirect back
console.log("waiting for redirect back…");
await page.waitForURL(/upgrade=success/, { timeout: 60000 }).catch(() => {});
console.log("after checkout:", page.url());
assert("redirected back with ?upgrade=success", /upgrade=success/.test(page.url()), page.url());

// 7. Poll /api/billing/me until isPro=true (webhook flips it)
let isPro = false;
let polls = 0;
for (polls = 0; polls < 30; polls++) {
  const me = await page.evaluate(async (uid) => (await fetch(`/api/billing/me?uid=${uid}`)).json(), UID);
  if (me.isPro) { isPro = true; r = me; break; }
  await page.waitForTimeout(1500);
}
assert(`webhook flipped isPro=true within ~45s`, isPro, `polls=${polls} status=${r?.status}`);
console.log("billing/me after upgrade:", r);

// 8. /pricing now says "Pro active"
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const pricingPost = await page.locator('body').innerText();
assert("/pricing shows 'Pro active'", /Pro active|★ Pro/.test(pricingPost), pricingPost.includes('Pro') ? 'has Pro' : 'no Pro');

// 9. /settings shows ★ Sauros Pro
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const settingsText = await page.locator('body').innerText();
assert("/settings shows Sauros Pro", /Sauros Pro|★ Pro/.test(settingsText), settingsText.includes('Pro') ? 'has Pro' : 'no Pro');

// 10. Header "★ Pro" chip
const headerPro = await page.locator('a:has-text("★ Pro")').count();
assert("header shows ★ Pro chip", headerPro > 0, `count=${headerPro}`);

// 11. /watchlist no longer caps
await page.goto(`${BASE}/watchlist`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const wlText = await page.locator('body').innerText();
assert("/watchlist removes Free-cap copy", !/Watchlist full \(10\/10\)/.test(wlText), wlText.slice(0, 100));

await page.screenshot({ path: `${OUT}/e2e-monetisation-final.png`, fullPage: true });
await browser.close();

const failed = A.filter(a => !a.ok);
const blob = {
  all_passed: failed.length === 0,
  passed: A.length - failed.length,
  total: A.length,
  uid: UID,
  customerId: r?.customerId,
  subscription_status: r?.status,
  console_errors: consoleErrs.length,
  failed,
  all: A
};
writeFileSync(`${OUT}/e2e-monetisation.json`, JSON.stringify(blob, null, 2));
console.log(`\ne2e-monetisation.json: ${blob.passed}/${blob.total} all_passed=${blob.all_passed}`);
for (const f of failed) console.log(`  ✗ ${f.name} — ${f.evidence}`);
