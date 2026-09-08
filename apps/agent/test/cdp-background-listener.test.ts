import { expect, test } from "bun:test"
import { CdpBackgroundListener, type BackgroundObservation, type BackgroundHealth } from "../src/cdp-background-listener"
import type { NetworkSocket } from "@unbrowse/browser-harness/network-listener"
const endpoint = "ws://127.0.0.1:12345/devtools/browser/owned-browser"
class Socket implements NetworkSocket {
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()
  calls: any[] = []
  closed = false
  context = "context-1"
  recorded = true
  reject = ""
  replay: any[] = []
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]) }
  emit(type: string, data?: unknown) { for (const fn of this.listeners.get(type) ?? []) fn({ data }) }
  event(method: string, params: unknown, sessionId = "observer-session") { this.emit("message", JSON.stringify({ method, params, sessionId })) }
  send(raw: string) {
    const call = JSON.parse(raw); this.calls.push(call)
    queueMicrotask(() => {
      let result: object = {}
      if (call.method === "Target.createTarget") result = { targetId: "observer-target" }
      if (call.method === "Target.attachToTarget") {
        this.event("Target.attachedToTarget", { sessionId: "observer-session", targetInfo: { targetId: "observer-target", type: "page", browserContextId: this.context } })
        result = { sessionId: "observer-session" }
      }
      if (call.method === "BackgroundService.startObserving") for (const entry of this.replay.filter(e => e.service === call.params.service)) this.observation(entry)
      if (call.method === "BackgroundService.setRecording" && this.recorded) this.event("BackgroundService.recordingStateChanged", { service: call.params.service, isRecording: true })
      if (call.method === "Target.closeTarget") result = { success: true }
      this.emit("message", JSON.stringify({ id: call.id, ...(call.sessionId ? { sessionId: call.sessionId } : {}), ...(this.reject === call.method ? { error: { message: "private error" } } : { result }) }))
    })
  }
  close() { if (!this.closed) { this.closed = true; this.emit("close") } }
  factory = () => { queueMicrotask(() => this.emit("open")); return this }
  observation(extra: Record<string, unknown> = {}, sessionId = "observer-session") {
    this.event("BackgroundService.backgroundServiceEventReceived", { backgroundServiceEvent: {
      timestamp: 10, origin: "https://example.com", service: "pushMessaging", serviceWorkerRegistrationId: "reg-1", storageKey: "https://example.com/", instanceId: "same-group", eventName: "Push message received", eventMetadata: [{ key: "Payload", value: "private-body" }], ...extra,
    } }, sessionId)
  }
}
const setup = (socket: Socket, events: BackgroundObservation[] = [], health: BackgroundHealth[] = []) => new CdpBackgroundListener({ origins: ["https://example.com"], registeredAtMs: 10_000, now: () => 20_000, makeSocket: socket.factory, onEvent: async e => { events.push(e) }, onHealth: h => { health.push(h) } })

test("owned blank observer captures live and historic events privately with exact scope and no browser action methods", async () => {
  const socket = new Socket(), events: BackgroundObservation[] = []
  socket.replay = [{ service: "pushMessaging", timestamp: 9 }]
  const collector = setup(socket, events)
  await collector.connect(endpoint)
  expect(collector.health.state).toBe("watching")
  socket.observation({ origin: "https://example.com/" }); socket.observation({ origin: "https://example.com.evil.test" }); socket.observation({}, "unowned-session")
  socket.observation({ timestamp: 11 }) // Related instance IDs are NOT unique occurrence IDs.
  await collector.flush()
  expect(events.map(e => e.historical)).toEqual([true, false, false])
  expect(events[1]?.eventMetadata).toEqual([{ key: "Payload", value: "private-body" }])
  expect(events[1]?.observedAtMs).toBe(20_000)
  expect(events[1]?.origin).toBe("https://example.com")
  const create = socket.calls.find(c => c.method === "Target.createTarget")
  expect(create.params).toEqual({ url: "about:blank", background: true })
  expect(socket.calls.every(c => ["Target.createTarget", "Target.attachToTarget", "BackgroundService.startObserving", "BackgroundService.setRecording"].includes(c.method))).toBe(true)
  await collector.close()
  expect(socket.calls.at(-1).params).toEqual({ targetId: "observer-target" })
  expect(collector.observerTargetId).toBeUndefined()
  expect(collector.health.state).toBe("stopped")
  socket.observation(); expect(events).toHaveLength(3)
})

test("recording expiry is degraded until explicit renewal receives recording evidence", async () => {
  const socket = new Socket(), health: BackgroundHealth[] = [], collector = setup(socket, [], health)
  await collector.connect(endpoint)
  socket.event("BackgroundService.recordingStateChanged", { service: "pushMessaging", isRecording: false })
  expect(collector.health).toMatchObject({ state: "degraded", reason: "recording-stopped" })
  socket.recorded = false; await collector.renewRecording()
  expect(collector.health.state).toBe("degraded") // Successful RPC is not recording evidence.
  socket.recorded = true; await collector.renewRecording()
  expect(collector.health.state).toBe("watching")
  expect(health.some(h => h.reason === "recording-stopped")).toBe(true)
  await collector.close()
})

test("observer target loss and transport disconnect expose coverage gaps; reconnect retains registration cut", async () => {
  const socket = new Socket(), collector = setup(socket)
  await collector.connect(endpoint)
  socket.event("Target.detachedFromTarget", { sessionId: "other-page" })
  expect(collector.health.state).toBe("watching")
  socket.event("Target.detachedFromTarget", { sessionId: "observer-session" })
  expect(collector.health).toMatchObject({ state: "degraded", reason: "no-observer-target" })
  socket.close()
  expect(collector.health.reason).toBe("disconnected")
  expect(() => collector.assertHealthy()).toThrow("reconcile coverage")
  expect(collector.observerTargetId).toBe("observer-target")
  const again = new Socket(), events: BackgroundObservation[] = [], replacement = setup(again, events)
  again.replay = [{ service: "pushMessaging", timestamp: 11 }]
  await replacement.connect(endpoint)
  expect(events[0]?.historical).toBe(false) // Recover a subscribed occurrence; host deduplicates it durably.
  await collector.close(); await replacement.close()
})

test.each(["oversize", "invalid", "callback", "backlog"])("capture %s failure is explicit and stops admission", async failure => {
  const socket = new Socket(), events: BackgroundObservation[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const collector = new CdpBackgroundListener({ origins: ["https://example.com"], registeredAtMs: 0, makeSocket: socket.factory, onEvent: async e => {
    if (failure === "callback") throw new Error("private host error")
    if (failure === "backlog") await held
    events.push(e)
  } })
  await collector.connect(endpoint)
  if (failure === "oversize") socket.emit("message", " ".repeat(65_537))
  if (failure === "invalid") socket.observation({ eventMetadata: [{ key: "Payload", value: 1 }] })
  if (failure === "callback") socket.observation()
  if (failure === "backlog") for (let i = 0; i < 130; i++) socket.observation()
  release()
  await expect(collector.flush()).rejects.toThrow()
  expect(collector.health).toMatchObject({ state: "degraded", reason: "capture-failed" })
  expect(JSON.stringify(collector.health)).not.toContain("private")
  const prior = events.length; socket.observation(); await collector.close(); expect(events.length).toBe(prior)
})

test("configured context is enforced and observer setup failure never reports watching", async () => {
  const socket = new Socket()
  const collector = new CdpBackgroundListener({ origins: ["https://example.com"], registeredAtMs: 0, browserContextId: "other-context", makeSocket: socket.factory, onEvent: async () => {} })
  await expect(collector.connect(endpoint)).rejects.toThrow()
  expect(socket.calls[0].params.browserContextId).toBe("other-context")
  expect(collector.health.state).toBe("degraded")
  await collector.close()
  const rejected = new Socket(); rejected.reject = "BackgroundService.startObserving"
  const failing = setup(rejected)
  await expect(failing.connect(endpoint)).rejects.toThrow()
  expect(failing.health.state).toBe("degraded")
  await failing.close()
})

test("abort settles an in-flight callback, prevents queued callbacks and closes only its owned target", async () => {
  const socket = new Socket(), controller = new AbortController(); let release!: () => void, calls = 0
  const hold = new Promise<void>(resolve => { release = resolve })
  const collector = new CdpBackgroundListener({ origins: ["https://example.com"], registeredAtMs: 0, makeSocket: socket.factory, signal: controller.signal, onEvent: async () => { calls++; await hold } })
  await collector.connect(endpoint)
  socket.observation(); await Promise.resolve(); socket.observation()
  controller.abort(); release(); await collector.close()
  expect(calls).toBe(1)
  expect(collector.health.state).toBe("stopped")
  expect(socket.calls.filter(c => c.method === "Target.closeTarget").every(c => c.params.targetId === "observer-target")).toBe(true)
})
