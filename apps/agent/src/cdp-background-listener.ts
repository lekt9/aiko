/** Private CDP capture adapter with an owned blank observer target. The host owns the browser, durable
 * deduplication, payload custody and reconnect policy. Never mount as a tool. */
import { validateObserverEndpoint, type NetworkSocket, type NetworkSocketFactory } from "@unbrowse/browser-harness/network-listener"

export type BackgroundService = "pushMessaging" | "notifications"
export interface BackgroundObservation {
  service: BackgroundService
  origin: string
  serviceWorkerRegistrationId: string
  storageKey: string
  timestamp: number
  eventName: string
  instanceId: string
  eventMetadata: Array<{ key: string; value: string }>
  observedAtMs: number
  /** Relative to the host's retained subscription cut, not each reconnect. */
  historical: boolean
}
export interface BackgroundHealth {
  state: "attaching" | "watching" | "degraded" | "stopped"
  reason: "attaching" | "ready" | "no-observer-target" | "recording-stopped" | "disconnected" | "capture-failed" | "stopped"
  targets: number
  atMs: number
}
export interface BackgroundListenerOptions {
  /** Exact HTTP(S) origins belonging to the authorized connection. */
  origins: readonly string[]
  registeredAtMs: number
  /** Trusted host browser context. Omit only for the owned default profile. */
  browserContextId?: string
  /** Raw private values: seal/journal here, never append directly to general logs. */
  onEvent: (event: BackgroundObservation) => Promise<void>
  onHealth?: (health: BackgroundHealth) => void
  signal?: AbortSignal
  makeSocket?: NetworkSocketFactory
  now?: () => number
}
const services: readonly BackgroundService[] = ["pushMessaging", "notifications"]
const MAX_FRAME = 65_536, MAX_QUEUED = 128, MAX_TARGETS = 64, RPC_TIMEOUT_MS = 10_000
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
const boundedString = (v: unknown, limit: number): string => {
  if (typeof v !== "string" || v.length > limit) throw new Error("Invalid background observation field")
  return v
}
const serviceOf = (v: unknown): BackgroundService | undefined => services.includes(v as BackgroundService) ? v as BackgroundService : undefined
const originOf = (v: unknown): string => {
  const origin = boundedString(v, 2048), url = new URL(origin)
  if (!["http:", "https:"].includes(url.protocol) || (url.origin !== origin && `${url.origin}/` !== origin) || url.username || url.password) throw new Error("Invalid background observation origin")
  return url.origin
}
type Session = { recording: Set<BackgroundService>; initialized: boolean }
type Method = "Target.createTarget" | "Target.attachToTarget" | "Target.closeTarget" | "BackgroundService.startObserving" | "BackgroundService.setRecording"

export class CdpBackgroundListener {
  private readonly origins: Set<string>
  private readonly now: () => number
  private socket?: NetworkSocket
  private targetId: string | undefined
  private closed = false
  private stopping = false
  private closing: Promise<void> | undefined
  private failure?: Error
  private ordinal = 0
  private queued = 0
  private tail = Promise.resolve()
  private readonly sessions = new Map<string, Session>()
  private readonly setup = new Set<Promise<void>>()
  private readonly pending = new Map<number, { sessionId?: string; resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private currentHealth: BackgroundHealth

  constructor(private readonly options: BackgroundListenerOptions) {
    if (!options.origins.length || options.origins.length > 64 || !Number.isFinite(options.registeredAtMs) || options.registeredAtMs < 0) throw new Error("Invalid background observation scope")
    if (options.browserContextId !== undefined && !/^[A-Za-z0-9-]{1,256}$/.test(options.browserContextId)) throw new Error("Invalid observer browser context")
    this.origins = new Set(options.origins.map(originOf))
    this.now = options.now ?? Date.now
    this.currentHealth = { state: "attaching", reason: "attaching", targets: 0, atMs: this.now() }
    options.signal?.addEventListener("abort", this.stop, { once: true })
    if (options.signal?.aborted) this.abort()
  }

  /** Retain for host cleanup if transport loss prevents closing this target. */
  get observerTargetId(): string | undefined { return this.targetId }
  get health(): BackgroundHealth { return { ...this.currentHealth } }
  assertHealthy(): void {
    if (this.failure) throw this.failure
    if (this.closed) throw new Error("Background observation is stopped")
  }
  private publish(reason?: BackgroundHealth["reason"]): void {
    const recording = [...this.sessions.values()].some(s => s.initialized && services.every(service => s.recording.has(service)))
    const state = this.closed ? "stopped" : this.failure || !recording ? "degraded" : "watching"
    const next: BackgroundHealth = { state, reason: reason ?? (recording ? "ready" : this.sessions.size ? "recording-stopped" : "no-observer-target"), targets: this.sessions.size, atMs: this.now() }
    if (this.currentHealth.state === next.state && this.currentHealth.reason === next.reason && this.currentHealth.targets === next.targets) return
    this.currentHealth = next
    // Diagnostics cannot change ingestion or leak protocol/private error strings.
    try { this.options.onHealth?.({ ...next }) } catch {}
  }
  private fail(reason: "disconnected" | "capture-failed" = "capture-failed"): void {
    if (this.closed || this.failure) return
    this.failure = new Error(reason === "disconnected" ? "Background observation disconnected; reconnect and reconcile coverage" : "Background observation failed; reconcile coverage")
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure) }
    this.pending.clear()
    this.publish(reason)
    try { this.socket?.close() } catch {}
  }
  private rpc(method: Method, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    if (method !== "Target.closeTarget") this.assertHealthy()
    const id = ++this.ordinal
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Background observation RPC unavailable")) }, RPC_TIMEOUT_MS)
      this.pending.set(id, { ...(sessionId ? { sessionId } : {}), resolve, reject, timer })
      try { this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Background observation disconnected")) }
    })
  }
  async connect(endpoint: string): Promise<void> {
    this.assertHealthy()
    if (this.socket) throw new Error("Background observation already connected")
    const socket = this.socket = (this.options.makeSocket ?? (url => new WebSocket(url) as unknown as NetworkSocket))(validateObserverEndpoint(endpoint))
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.fail(); reject(new Error("Background observation connection unavailable")) }, RPC_TIMEOUT_MS)
        const failed = () => { clearTimeout(timer); this.fail("disconnected"); reject(new Error("Background observation disconnected")) }
        socket.addEventListener("open", () => { clearTimeout(timer); resolve() })
        socket.addEventListener("error", failed)
        socket.addEventListener("close", failed)
        socket.addEventListener("message", event => this.receive(event.data))
      })
      // A page session observes its storage partition, including closed-site-tab
      // service worker activity. The host retains an owned observer page while watching.
      const created = await this.rpc("Target.createTarget", { url: "about:blank", background: true,
        ...(this.options.browserContextId ? { browserContextId: this.options.browserContextId } : {}) })
      this.targetId = boundedString(created.targetId, 256)
      if (!this.targetId) throw new Error("Observer target unavailable")
      await this.rpc("Target.attachToTarget", { targetId: this.targetId, flatten: true })
      await this.flush()
      this.publish()
    } catch (error) { this.fail(); throw error }
  }
  private receive(raw: unknown): void {
    if (this.closed || this.failure) return
    try {
      if (typeof raw !== "string" || raw.length > MAX_FRAME || Buffer.byteLength(raw, "utf8") > MAX_FRAME) throw new Error("Background frame limit")
      const message = object(JSON.parse(raw))
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id)
        if (!pending) return
        if (pending.sessionId !== message.sessionId) throw new Error("Background response session mismatch")
        clearTimeout(pending.timer); this.pending.delete(message.id)
        if (message.error) pending.reject(new Error("Background observation RPC rejected")); else pending.resolve(object(message.result))
        return
      }
      const params = object(message.params)
      if (message.method === "Target.attachedToTarget") {
        const target = object(params.targetInfo)
        if (target.targetId !== this.targetId) return
        if (target.type !== "page" || (this.options.browserContextId && target.browserContextId !== this.options.browserContextId)) throw new Error("Observer browser context mismatch")
        const id = boundedString(params.sessionId, 256)
        if (!id || this.sessions.has(id)) return
        if (this.sessions.size >= MAX_TARGETS) throw new Error("Background target limit")
        const session: Session = { recording: new Set(), initialized: false }
        this.sessions.set(id, session)
        const setup = (async () => {
          for (const service of services) {
            await this.rpc("BackgroundService.startObserving", { service }, id)
            await this.rpc("BackgroundService.setRecording", { service, shouldRecord: true }, id)
          }
          if (this.sessions.has(id)) { session.initialized = true; this.publish() }
        })()
        this.setup.add(setup)
        void setup.catch(() => { if (this.sessions.has(id)) this.fail() }).finally(() => this.setup.delete(setup))
        return
      }
      if (message.method === "Target.detachedFromTarget") {
        const id = boundedString(params.sessionId, 256)
        this.sessions.delete(id)
        for (const [key, pending] of this.pending) if (pending.sessionId === id) { clearTimeout(pending.timer); this.pending.delete(key); pending.reject(new Error("Background target detached")) }
        this.publish(); return
      }
      const session = this.sessions.get(typeof message.sessionId === "string" ? message.sessionId : "")
      if (!session) return
      if (message.method === "BackgroundService.recordingStateChanged") {
        const service = serviceOf(params.service)
        if (!service || typeof params.isRecording !== "boolean") throw new Error("Invalid recording state")
        if (params.isRecording) session.recording.add(service); else session.recording.delete(service)
        if (session.initialized) this.publish()
        return
      }
      if (this.stopping || message.method !== "BackgroundService.backgroundServiceEventReceived") return
      const event = object(params.backgroundServiceEvent), service = serviceOf(event.service)
      if (!service) return
      const origin = originOf(event.origin)
      if (!this.origins.has(origin)) return
      if (typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp) || event.timestamp < 0 || !Array.isArray(event.eventMetadata) || event.eventMetadata.length > 64) throw new Error("Invalid background observation")
      const observation: BackgroundObservation = {
        service, origin, timestamp: event.timestamp,
        serviceWorkerRegistrationId: boundedString(event.serviceWorkerRegistrationId, 256),
        storageKey: boundedString(event.storageKey, 4096),
        eventName: boundedString(event.eventName, 512), instanceId: boundedString(event.instanceId, 512),
        eventMetadata: event.eventMetadata.map(raw => { const pair = object(raw); return { key: boundedString(pair.key, 256), value: boundedString(pair.value, 32_768) } }),
        observedAtMs: this.now(), historical: event.timestamp * 1000 < this.options.registeredAtMs,
      }
      if (++this.queued > MAX_QUEUED) throw new Error("Background capture backlog limit")
      this.tail = this.tail.then(async () => {
        try { if (!this.closed && !this.stopping && !this.failure) await this.options.onEvent(observation) }
        finally { this.queued-- }
      })
      void this.tail.catch(() => this.fail())
    } catch { this.fail() }
  }
  /** Host alarms renew the diagnostic recording window; never infer readiness
   * from RPC acceptance without recordingStateChanged evidence. */
  async renewRecording(): Promise<void> {
    this.assertHealthy()
    try {
      for (const [id, session] of this.sessions) if (session.initialized) for (const service of services) await this.rpc("BackgroundService.setRecording", { service, shouldRecord: true }, id)
      this.publish()
    } catch (error) { this.fail(); throw error }
  }
  async flush(): Promise<void> {
    while (this.setup.size) await Promise.allSettled([...this.setup])
    await this.tail
    this.assertHealthy()
  }
  private stop = (): void => { void this.close() }
  private abort = (): void => {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Background observation stopped")) }
    this.pending.clear(); this.sessions.clear()
    try { this.socket?.close() } catch {}
    this.publish("stopped")
  }
  /** Does not disable profile recording or notifications used by other watchers. */
  close(): Promise<void> { return this.closing ??= this.finishClose() }
  private async finishClose(): Promise<void> {
    this.stopping = true
    if (!this.closed && this.targetId && !this.failure) {
      try {
        const result = await this.rpc("Target.closeTarget", { targetId: this.targetId })
        if (result.success === true) this.targetId = undefined
      } catch { /* Host sees retained target ID and owns final browser cleanup. */ }
    }
    this.abort()
    this.options.signal?.removeEventListener("abort", this.stop)
    await Promise.allSettled([...this.setup, this.tail])
  }
}
