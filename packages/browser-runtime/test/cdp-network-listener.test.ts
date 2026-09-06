import { expect, test } from "bun:test"
import { CdpNetworkListener, validateObserverEndpoint, type NetworkSocket, type NetworkEntry } from "../src/cdp-network-listener"
import { prepareTrustedNetworkEntries } from "../src/trusted-network"
import { planHarImport, networkFactObservedEventOf, networkFactOf, networkGraphCheckpointOf, assertNetworkSnapshotBackedByLog, harKeys } from "../src/har-component"
import type { Event } from "tardie/core/log/event"

class ObserverSocket implements NetworkSocket {
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()
  calls: Array<{ id: number; method: string; sessionId?: string; params: Record<string, unknown> }> = []
  attached = false
  closed = false
  holdBody = false
  missingBody = false
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data }) }
  notification(method: string, params: Record<string, unknown>, sessionId = "page-1") {
    this.emit("message", JSON.stringify({ method, params, sessionId }))
  }
  send(raw: string) {
    const message = JSON.parse(raw); this.calls.push(message)
    queueMicrotask(() => {
      if (message.method === "Target.setAutoAttach" && !this.attached) {
        this.attached = true
        this.notification("Target.attachedToTarget", { sessionId: "page-1", targetInfo: { type: "page" } })
      }
      if (message.method === "Network.getResponseBody" && this.holdBody) return
      if (message.method === "Network.getResponseBody" && this.missingBody) {
        this.emit("message", JSON.stringify({ id: message.id, error: { code: -32000, message: "Resource unavailable" } })); return
      }
      this.emit("message", JSON.stringify({ id: message.id, result: message.method === "Network.getResponseBody"
        ? { body: '{"restaurant":"PRIVATE_RESPONSE_SENTINEL","discount":50}', base64Encoded: false } : {} }))
    })
  }
  close() { if (!this.closed) { this.closed = true; this.emit("close") } }
  factory = () => { queueMicrotask(() => this.emit("open")); return this }
  request(id = "request-1", session = "page-1", method = "GET", extra: Record<string, unknown> = {}) {
    this.notification("Network.requestWillBeSent", { requestId: id, timestamp: 2, wallTime: 2,
      type: "Fetch", request: { url: "https://example.com/api/details?item=PRIVATE_INPUT_SENTINEL", method, headers: {}, ...extra } }, session)
  }
  response(id = "request-1", session = "page-1", status = 200) {
    this.notification("Network.responseReceived", { requestId: id, hasExtraInfo: false, response: { status, mimeType: "application/json", headers: {} } }, session)
    this.notification("Network.loadingFinished", { requestId: id, timestamp: 2.123, encodedDataLength: 50 }, session)
  }
}

test("passive observation is immediate, value-free in the log, and graph derivation requires acknowledged facts", async () => {
  const socket = new ObserverSocket(), log: Event[] = []
  const listener = new CdpNetworkListener(async (entry, _index, complete) => {
    const events = planHarImport(prepareTrustedNetworkEntries([entry]).trace).events("live")
    for (const fact of events.filter((event) => event.type === "HarRequestObserved" || (complete && event.type === "HarResponseObserved"))) {
      log.push(networkFactObservedEventOf("run-1", log.length, fact))
    }
  }, socket.factory)
  await listener.connect("ws://127.0.0.1:12345/devtools/browser/owned-browser")
  socket.request()
  await listener.flush()
  expect(log).toHaveLength(1) // no agent tool or snapshot required
  expect(log[0]!.fact).toMatchObject({ type: "HarRequestObserved", request: { method: "GET" } })
  expect(prepareTrustedNetworkEntries(await listener.snapshot()).trace.entries[0]!.response.status).toBe(0)
  socket.response(); await listener.flush()
  const entries = await listener.snapshot()
  const plan = planHarImport(prepareTrustedNetworkEntries(entries).trace)
  expect(() => assertNetworkSnapshotBackedByLog(log, "run-1", plan.events("snapshot"))).not.toThrow()
  expect(() => assertNetworkSnapshotBackedByLog(log.slice(0, 1), "run-1", plan.events("snapshot"))).toThrow()
  expect(() => assertNetworkSnapshotBackedByLog(log, "run-1", plan.events("snapshot"), [])).toThrow()
  expect(() => assertNetworkSnapshotBackedByLog(log, "run-1", plan.events("snapshot"), ["req-0001"], log.length + 1)).toThrow()
  expect(JSON.stringify(log)).not.toContain("PRIVATE_")
  expect(JSON.stringify(entries)).toContain("PRIVATE_RESPONSE_SENTINEL") // memory only, not durable
  expect(log.every((event) => harKeys.keyOf(event)?.startsWith("net1:"))).toBe(true)
  expect(networkFactOf({ ...log[0]!, fact: { ...(log[0]!.fact as object), body: "private" } })).toBeUndefined()
  expect(networkFactOf({ ...log[0]!, fact: { ...(log[0]!.fact as object), captureId: "injected" } })).toBeUndefined()
  expect(new Set(socket.calls.map((call) => call.method))).toEqual(new Set(["Target.setAutoAttach", "Network.enable", "Network.getResponseBody"]))
  await listener.close(); expect(listener.requestCount).toBe(0)
})

test("redirects and per-target identities preserve ordering; POST and failed/background requests are also observed", async () => {
  const socket = new ObserverSocket(), observed: Array<{ index: number; complete: boolean }> = []
  const listener = new CdpNetworkListener(async (_entry, index, complete) => { observed.push({ index, complete }) }, socket.factory)
  await listener.connect("ws://127.0.0.1:12345/devtools/browser/owned-browser")
  socket.notification("Target.attachedToTarget", { sessionId: "iframe-1", targetInfo: { type: "iframe" } })
  await listener.flush()
  socket.request("same", "page-1")
  socket.notification("Network.requestWillBeSent", { requestId: "same", timestamp: 2.1, wallTime: 2.1,
    redirectHasExtraInfo: false, redirectResponse: { status: 302, headers: { location: "https://example.com/api/new" } },
    request: { url: "https://example.com/api/new", method: "GET", headers: {} } })
  socket.response("same")
  socket.request("same", "iframe-1", "POST", { hasPostData: true })
  socket.notification("Network.loadingFailed", { requestId: "same", timestamp: 3 }, "iframe-1")
  await listener.flush()
  const preparation = prepareTrustedNetworkEntries(await listener.snapshot())
  expect(preparation.trace.entries.map((entry) => entry.response.status)).toEqual([302, 200, 0])
  expect(preparation.trace.entries.map((entry) => entry.request.method)).toEqual(["GET", "GET", "POST"])
  expect([...new Set(observed.filter((entry) => !entry.complete).map((entry) => entry.index))]).toEqual([0, 1, 2])
  expect(preparation.authorFacts.dependencies.some((edge) => edge.reason === "redirect")).toBe(true)
  await listener.close()
})

test.each(["malformed", "oversized", "disconnect"])("listener fails closed on %s instead of inventing a usable capture", async (failure) => {
  const socket = new ObserverSocket()
  const listener = new CdpNetworkListener(async () => {}, socket.factory)
  await listener.connect("ws://127.0.0.1:12345/devtools/browser/owned-browser")
  if (failure === "disconnect") socket.close()
  else socket.emit("message", failure === "malformed" ? "{" : "x".repeat(2_097_153))
  await expect(listener.snapshot()).rejects.toThrow()
  await expect(listener.close()).rejects.toThrow()
  expect(listener.requestCount).toBe(0)
})

test("out-of-order wire metadata joins before graph eligibility and keeps session values out of durable facts", async () => {
  const socket = new ObserverSocket(), log: Event[] = []
  const listener = new CdpNetworkListener(async (entry, _index, complete) => {
    for (const fact of planHarImport(prepareTrustedNetworkEntries([entry]).trace).events("live")
      .filter((event) => event.type === "HarRequestObserved" || (complete && event.type === "HarResponseObserved"))) {
      log.push(networkFactObservedEventOf("extra-run", log.length, fact))
    }
  }, socket.factory)
  await listener.connect("ws://127.0.0.1:12345/devtools/browser/owned-browser")
  socket.notification("Network.requestWillBeSentExtraInfo", { requestId: "request-1",
    headers: { Cookie: "sid=SECRET_COOKIE", Authorization: "Bearer SECRET_AUTH" },
    associatedCookies: [{ blockedReasons: [], cookie: { name: "sid", value: "SECRET_COOKIE" } }] })
  socket.request()
  socket.notification("Network.responseReceived", { requestId: "request-1", hasExtraInfo: true,
    response: { status: 200, mimeType: "application/json", headers: {} } })
  socket.notification("Network.loadingFinished", { requestId: "request-1", timestamp: 2.1 })
  await listener.flush()
  expect((await listener.snapshot())[0]!._observationComplete).toBe(false)
  expect(log.some((event) => (event.fact as Event).type === "HarResponseObserved")).toBe(false)
  socket.notification("Network.responseReceivedExtraInfo", { requestId: "request-1", statusCode: 304,
    headers: { "Set-Cookie": "sid=SECRET_ROTATED; Path=/" } })
  await listener.flush()
  const snapshot = await listener.snapshot()
  expect(snapshot[0]!._observationComplete).toBe(true)
  const preparation = prepareTrustedNetworkEntries(snapshot)
  expect(preparation.trace.entries[0]!.response.status).toBe(304)
  expect(preparation.valueProfile.sessionMaterial.credentialHeaderFields).toBeGreaterThan(0)
  expect(preparation.valueProfile.sessionMaterial.cookieFields).toBeGreaterThan(0)
  expect(JSON.stringify(log)).not.toContain("SECRET_")
  expect(() => assertNetworkSnapshotBackedByLog(log, "extra-run", planHarImport(preparation.trace).events("checkpoint"))).not.toThrow()
  const final = await listener.stopAndSnapshot()
  socket.request("late")
  expect(final).toHaveLength(1)
  expect(listener.requestCount).toBe(0)
})

test("Stop releases pending response-body work and no completion is published afterward", async () => {
  const socket = new ObserverSocket(), abort = new AbortController()
  const completed: NetworkEntry[] = []
  const listener = new CdpNetworkListener(async (entry, _index, complete) => { if (complete) completed.push(entry) }, socket.factory, abort.signal)
  await listener.connect("ws://127.0.0.1:12345/devtools/browser/owned-browser")
  socket.holdBody = true; socket.request(); socket.response()
  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort(); await listener.close()
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(completed).toHaveLength(0)
  expect(listener.requestCount).toBe(0)
  expect(socket.closed).toBe(true)
})

test("an unavailable JSON body preserves observed metadata but cannot enter a reusable graph", async () => {
  const socket = new ObserverSocket(), completed: NetworkEntry[] = []
  const listener = new CdpNetworkListener(async (entry, _index, complete) => { if (complete) completed.push(structuredClone(entry)) }, socket.factory)
  await listener.connect("ws://127.0.0.1:12345/devtools/browser/owned-browser")
  socket.missingBody = true; socket.request(); socket.response(); await listener.flush()
  expect(completed).toHaveLength(1)
  expect(completed[0]!._observationComplete).toBe(false)
  expect(prepareTrustedNetworkEntries(completed).trace.entries[0]!.response.status).toBe(200)
  expect((await listener.snapshot()).filter((entry) => entry._observationComplete)).toHaveLength(0)
  await listener.close()
})

test("the observer accepts only the exact loopback browser endpoint, never another host or page endpoint", () => {
  for (const endpoint of ["wss://example.com/devtools/browser/abc", "ws://localhost:1234/devtools/browser/abc",
    "ws://127.0.0.1:1234/devtools/page/abc", "ws://user:pass@127.0.0.1:1234/devtools/browser/abc",
    "ws://127.0.0.1:1234/devtools/browser/abc?token=secret"]) expect(() => validateObserverEndpoint(endpoint)).toThrow()
})


