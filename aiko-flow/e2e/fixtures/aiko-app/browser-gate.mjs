#!/usr/bin/env node
// browser-gate.mjs — the headless-browser arm of aiko-app-native-gate.sh.
//
// green mode: drives the real SPA at <origin>/start with Playwright Chromium
//   (a) the page renders without proxy-failure console errors;
//   (b) step 2 shows the real signed-in identity from /native/v1/auth in the
//       DOM, and no grok-branded login UI exists;
//   (c) /native/v1/manifest and /native/v1/auth round-trip FROM PAGE CONTEXT;
//   (d) the browser itself completes an aiko.acp.v1 JSON-RPC initialize over
//       the agent-mail WebSocket obtained via GET /native/ws-url;
//   and records every same-origin served module URL for the hygiene scan.
//
// red mode: with the hermetic native serve dead, the app must fail CLOSED:
//   the capability rows read "Not queried"/"Not available", the identity is
//   absent, and /native/v1/manifest from page context returns the 503
//   native_unavailable taxonomy.
//
// Playwright resolves through ../../node_modules (the aiko-flow e2e install).
// Every wait is bounded; a global hard timer guarantees termination.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const [mode, origin, expectIdent, moduleListOut] = process.argv.slice(2)
if (!['green', 'red'].includes(mode || '') || !origin) {
  console.error('usage: browser-gate.mjs <green|red> <origin> [expected-ident] [module-list-out]')
  process.exit(2)
}

const evidence = (s) => console.log(`EVIDENCE: ${s}`)
class GateFail extends Error {}
const fail = (s) => { throw new GateFail(s) }

const hardTimer = setTimeout(() => {
  console.error('EVIDENCE: FAIL(browser): global 210s budget exhausted')
  process.exit(1)
}, 210_000)
hardTimer.unref?.()

const BANNED_HOSTS = /auth\.x\.ai|accounts\.x\.ai/i // pinned from crates auth/config.rs: GROK_OAUTH2_ISSUER + PROD_ACCOUNTS_APP_ORIGINS
const PROXY_FAILURE = /native_unavailable|\/native\//i

async function toCapabilitiesStep(page) {
  await page.goto(`${origin}/start`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.step-label').waitFor({ timeout: 60_000 })
  await page.getByRole('heading', { name: 'Workspace readiness' }).waitFor({ timeout: 60_000 })
  // Continue is disabled until the workspace config read-back lands; Playwright
  // click auto-waits for enabled within the bound.
  await page.locator('button.primary').click({ timeout: 60_000 })
  await page.getByRole('heading', { name: 'Workspace identity' }).waitFor({ timeout: 60_000 })
  await page.locator('button.primary').click({ timeout: 60_000 })
  await page.getByRole('heading', { name: 'Capabilities, read back live' }).waitFor({ timeout: 60_000 })
}

const browser = await chromium.launch({ headless: true })
let exitCode = 0
try {
  const page = await browser.newPage()
  const consoleErrors = []
  const pageErrors = []
  const moduleUrls = new Set()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('response', (res) => {
    const url = res.url()
    if (!url.startsWith(origin)) return
    const ct = res.headers()['content-type'] || ''
    if (/javascript|typescript/.test(ct) || /\.(m?js|ts|vue)(\?|$)/.test(url)) moduleUrls.add(url)
  })

  if (mode === 'green') {
    if (!expectIdent) fail('green mode needs the expected identity (email/label from /native/v1/auth)')
    await toCapabilitiesStep(page)
    evidence(`(a) SPA loaded: ${origin}/start rendered StartPage and stepped to "Capabilities, read back live"`)

    // (b) the surface consuming getCliAuth()/getAuthState() shows the session.
    await page.waitForFunction((ident) => document.body.textContent?.includes(ident), expectIdent, { timeout: 60_000 })
      .catch(async () => fail(`signed-in identity ${JSON.stringify(expectIdent)} never appeared in the DOM; body: ${(await page.locator('body').innerText().catch(() => '?')).slice(0, 500)}`))
    const bodyText = await page.locator('body').innerText()
    const bodyHtml = await page.content()
    if (/\bgrok\b/i.test(bodyText)) fail(`grok-branded text rendered in the DOM: ${bodyText.match(/.{0,40}grok.{0,40}/i)?.[0]}`)
    if (BANNED_HOSTS.test(bodyHtml)) fail('grok issuer/OAuth host present in the rendered page HTML')
    const signInButtons = await page.getByRole('button', { name: /sign in/i }).count()
    if (signInButtons !== 0) fail(`a sign-in button is rendered although /native/v1/auth reports signed_in — ${signInButtons} found`)
    evidence(`(b) signed-in identity ${JSON.stringify(expectIdent)} visible in the DOM; no grok-branded text/hosts; no sign-in button rendered`)

    // (c) the native round-trip from INSIDE the page context.
    const native = await page.evaluate(async () => {
      const m = await fetch('/native/v1/manifest'); const mb = await m.json().catch(() => null)
      const a = await fetch('/native/v1/auth'); const ab = await a.json().catch(() => null)
      return {
        mStatus: m.status, mSchema: mb?.schema, mInterfaces: Array.isArray(mb?.interfaces) ? mb.interfaces.length : -1,
        aStatus: a.status, aSchema: ab?.schema, signedIn: ab?.signed_in, accounts: Array.isArray(ab?.accounts) ? ab.accounts.length : -1,
      }
    })
    if (native.mStatus !== 200 || native.mSchema !== 'aiko.native.v1' || native.mInterfaces < 0) {
      fail(`page-context /native/v1/manifest: ${JSON.stringify(native)}`)
    }
    if (native.aStatus !== 200 || native.aSchema !== 'aiko.native.v1' || native.signedIn !== true) {
      fail(`page-context /native/v1/auth: ${JSON.stringify(native)}`)
    }
    evidence(`(c) page-context fetch: /native/v1/manifest -> 200 aiko.native.v1 (${native.mInterfaces} interfaces); /native/v1/auth -> 200 signed_in:true (${native.accounts} account)`)

    // (d) the ACP primitive: the BROWSER opens the agent-mail WebSocket via
    // the app's own mechanism and completes a JSON-RPC initialize.
    const ws = await page.evaluate(async () => {
      const r = await fetch('/native/ws-url')
      if (!r.ok) return { ok: false, why: `GET /native/ws-url -> HTTP ${r.status}` }
      const ep = await r.json().catch(() => null)
      if (!ep?.url) return { ok: false, why: 'ws-url response carries no url' }
      return await new Promise((resolve) => {
        const sock = new WebSocket(ep.url, ep.subprotocol || 'aiko.acp.v1')
        const timer = setTimeout(() => { try { sock.close() } catch {} resolve({ ok: false, why: '30s ws timeout' }) }, 30_000)
        sock.onopen = () => sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }))
        sock.onmessage = (event) => {
          let msg; try { msg = JSON.parse(String(event.data)) } catch { return }
          if (msg.id === 1 && msg.jsonrpc === '2.0' && (msg.result !== undefined || msg.error !== undefined)) {
            clearTimeout(timer)
            const proto = sock.protocol
            try { sock.close() } catch {}
            resolve({ ok: msg.result !== undefined, proto, sample: JSON.stringify(msg).slice(0, 220), why: msg.error ? `json-rpc error: ${JSON.stringify(msg.error).slice(0, 160)}` : undefined })
          }
        }
        sock.onerror = () => { clearTimeout(timer); resolve({ ok: false, why: 'ws error event' }) }
        sock.onclose = (event) => { clearTimeout(timer); resolve({ ok: false, why: `ws closed code=${event.code} before a response` }) }
      })
    })
    if (!ws.ok) fail(`browser agent-mail handshake failed: ${ws.why}`)
    if (ws.proto !== 'aiko.acp.v1') fail(`agent-mail negotiated subprotocol ${JSON.stringify(ws.proto)}, expected aiko.acp.v1`)
    evidence(`(d) browser WebSocket via /native/ws-url: subprotocol aiko.acp.v1, initialize -> JSON-RPC result ${ws.sample}`)

    // (a, closing) no uncaught exceptions; no proxy-failure console errors.
    if (pageErrors.length) fail(`uncaught page errors: ${pageErrors.join(' | ').slice(0, 400)}`)
    const proxyErrors = consoleErrors.filter((t) => PROXY_FAILURE.test(t))
    if (proxyErrors.length) fail(`proxy-failure console errors: ${proxyErrors.join(' | ').slice(0, 400)}`)
    evidence(`(a) console clean: 0 uncaught errors, 0 proxy-failure console errors (${consoleErrors.length} other console-error lines)`)

    if (moduleListOut) {
      writeFileSync(moduleListOut, [...moduleUrls].join('\n') + '\n')
      evidence(`(e) recorded ${moduleUrls.size} served same-origin module URLs for the hygiene scan`)
    }
  } else {
    // RED: hermetic native serve is dead — the app must fail CLOSED.
    await toCapabilitiesStep(page)
    await page.waitForFunction(() => document.body.textContent?.includes('Not queried'), undefined, { timeout: 60_000 })
      .catch(async () => fail(`fail-closed label "Not queried" never appeared; body: ${(await page.locator('body').innerText().catch(() => '?')).slice(0, 500)}`))
    await page.waitForFunction(() => document.body.textContent?.includes('Some desktop capabilities did not answer.'), undefined, { timeout: 60_000 })
      .catch(() => fail('the capability error banner never appeared with the native serve dead'))
    const bodyText = await page.locator('body').innerText()
    if (expectIdent && bodyText.includes(expectIdent)) fail('the signed-in identity is still rendered although the native serve is dead — a fabricated status')
    if (!bodyText.includes('Not available')) fail('runtime interfaces row does not read "Not available" with the native serve dead')
    const red = await page.evaluate(async () => {
      const r = await fetch('/native/v1/manifest')
      let b = null; try { b = await r.json() } catch {}
      return { status: r.status, schema: b?.schema, code: b?.error?.code, message: String(b?.error?.message || '').slice(0, 160) }
    })
    if (red.status < 500) fail(`page-context /native/v1/manifest returned HTTP ${red.status} with the serve dead — not fail-closed`)
    if (red.code !== 'native_unavailable') fail(`5xx without the native_unavailable taxonomy: ${JSON.stringify(red)}`)
    evidence(`RED: rows read "Not queried"/"Not available", identity absent, banner shown; page-context /native/v1/manifest -> HTTP ${red.status} ${red.code}: ${red.message}`)
  }
} catch (error) {
  exitCode = 1
  const message = error instanceof GateFail ? error.message : `unexpected: ${error?.stack || error}`
  console.error(`EVIDENCE: FAIL(browser/${mode}): ${message}`)
} finally {
  clearTimeout(hardTimer)
  await browser.close().catch(() => {})
}
process.exit(exitCode)
