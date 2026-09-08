/** Observation-only connection to the browser launched by agent-browser.
 * No navigation, evaluation, interception, replay or filesystem writes. */
export interface NetworkSocket {
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

export type NetworkSocketFactory = (url: string) => NetworkSocket
export type NetworkEntry = Record<string, unknown>
const MAX_INGRESS = 64 * 1024 * 1024
const MAX_FRAME = 2 * 1024 * 1024
const MAX_ENTRIES = 5_000
const RPC_TIMEOUT_MS = 10_000
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string => typeof value === "string" ? value : ""
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0
const headers = (value: unknown) => Object.entries(obj(value)).map(([name, value]) => ({ name, value: String(value) }))

export const validateObserverEndpoint = (value: string): string => {
  const url = new URL(value)
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
      url.search || url.hash || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(url.pathname)) {
    throw new Error("Invalid isolated browser observation endpoint")
  }
  return url.href
}

interface TrackedRequest {
  entry: NetworkEntry; index: number; started: number; session: string; id: string
  finished?: boolean; bodyAvailable?: boolean; expectedExtra?: boolean | undefined; requestExtra?: Record<string, unknown>; responseExtra?: Record<string, unknown>
}

export class CdpNetworkListener {
  private socket?: NetworkSocket
  private ordinal = 0
  private ingress = 0
  private closed = false
  private stopping = false
  private failure?: Error
  private tail: Promise<void> = Promise.resolve()
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly active = new Map<string, TrackedRequest>()
  private readonly chains = new Map<string, TrackedRequest[]>()
  private readonly extras = new Map<string, { request: Record<string, unknown>[]; response: Record<string, unknown>[] }>()
  private readonly sessions = new Set<string>()
  private readonly ready = new Set<Promise<void>>()
  private readonly entries: NetworkEntry[] = []

  constructor(private readonly onExchange: (entry: NetworkEntry, index: number, complete: boolean) => Promise<void>,
    private readonly makeSocket: NetworkSocketFactory = (url) => new WebSocket(url) as unknown as NetworkSocket, private readonly signal?: AbortSignal) {
    signal?.addEventListener("abort", this.shutdown, { once: true })
    if (signal?.aborted) this.shutdown()
  }

  get requestCount(): number { return this.entries.length }
  assertHealthy(): void { if (this.failure) throw this.failure; if (this.closed) throw new Error("Network observation is closed") }

  private fail(): void {
    if (this.failure) return
    this.failure ??= new Error("Passive browser network observation failed")
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure) }
    this.pending.clear()
    try { this.socket?.close() } catch {}
  }

  // This private dispatcher has no caller/model-selected method surface.
  private rpc(method: "Target.setAutoAttach" | "Network.enable" | "Network.getResponseBody", params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    this.assertHealthy()
    const id = ++this.ordinal
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Network observation RPC unavailable")) }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Network observation disconnected")) }
    })
  }

  async connect(endpoint: string): Promise<void> {
    this.assertHealthy()
    if (this.socket) throw new Error("Network observation already connected")
    this.socket = this.makeSocket(validateObserverEndpoint(endpoint))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); reject(new Error("Network observation connection unavailable")) }, RPC_TIMEOUT_MS)
      const failed = () => { clearTimeout(timer); if (!this.closed) this.fail(); reject(new Error("Network observation disconnected")) }
      this.socket!.addEventListener("open", () => { clearTimeout(timer); resolve() })
      this.socket!.addEventListener("error", failed)
      this.socket!.addEventListener("close", failed)
      this.socket!.addEventListener("message", (event) => this.receive(event.data))
    })
    await this.rpc("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: "page" }, { type: "iframe" }, { type: "worker" }, { type: "service_worker" }] })
    await this.flush()
    if (this.sessions.size === 0) { this.fail(); throw this.failure }
  }

  private receive(raw: unknown): void {
    if (this.closed || this.failure) return
    if (typeof raw !== "string" || raw.length > MAX_FRAME) { this.fail(); return }
    const size = Buffer.byteLength(raw, "utf8")
    if (size > MAX_FRAME) { this.fail(); return }
    this.ingress += size
    if (this.ingress > MAX_INGRESS) { this.fail(); return }
    let message: Record<string, unknown>
    try { message = obj(JSON.parse(raw)) } catch { this.fail(); return }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error("Network observation RPC rejected"))
      else pending.resolve(obj(message.result))
      return
    }
    if (this.stopping) return // Settle existing body RPCs, but admit no new notifications.
    const params = obj(message.params)
    if (message.method === "Target.attachedToTarget") {
      const session = str(params.sessionId)
      const type = str(obj(params.targetInfo).type)
      if (!session || !["page", "iframe", "worker", "service_worker"].includes(type) || this.sessions.has(session)) return
      if (this.sessions.size >= 64) { this.fail(); return }
      this.sessions.add(session)
      const setup = (async () => {
        await this.rpc("Network.enable", { maxTotalBufferSize: 8_388_608, maxResourceBufferSize: 1_048_576, maxPostDataSize: 65_536 }, session)
        if (type === "page" || type === "iframe") await this.rpc("Target.setAutoAttach", {
          autoAttach: true, waitForDebuggerOnStart: false, flatten: true
        }, session)
      })()
      this.ready.add(setup)
      void setup.catch(() => this.fail()).finally(() => this.ready.delete(setup))
      return
    }
    if (!["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed",
      "Network.requestWillBeSentExtraInfo", "Network.responseReceivedExtraInfo"].includes(str(message.method))) return
    const session = str(message.sessionId)
    if (!this.sessions.has(session)) return
    this.tail = this.tail.then(() => this.observe(str(message.method), params, session))
    void this.tail.catch(() => this.fail())
  }

  private async observe(method: string, params: Record<string, unknown>, session: string): Promise<void> {
    if (this.closed || this.failure) return
    const id = str(params.requestId)
    if (!id || id.length > 256) throw new Error("Invalid observed network identity")
    const key = `${session}\0${id}`
    if (method.endsWith("ExtraInfo")) {
      const extra = this.extras.get(key) ?? { request: [], response: [] }
      this.extras.set(key, extra)
      extra[method === "Network.requestWillBeSentExtraInfo" ? "request" : "response"].push(params)
      await this.applyExtras(key)
      return
    }
    if (method === "Network.requestWillBeSent") {
      const previous = this.active.get(key)
      if (previous) {
        if (!params.redirectResponse) throw new Error("Ambiguous observed network identity")
        this.response(previous, obj(params.redirectResponse))
        previous.expectedExtra = typeof params.redirectHasExtraInfo === "boolean" ? params.redirectHasExtraInfo : undefined
        previous.entry.time = Math.max(0, Math.round((number(params.timestamp) - previous.started) * 1_000))
        previous.finished = true
        await this.applyExtras(key)
        await this.publishExchange(previous)
        this.active.delete(key)
      }
      const request = obj(params.request)
      const url = str(request.url)
      if (/^(?:data|blob|about):/iu.test(url)) return
      if (!/^https?:\/\//iu.test(url)) return
      if (this.entries.length >= MAX_ENTRIES) throw new Error("Network observation exceeded its request bound")
      const entry: NetworkEntry = { startedDateTime: new Date(Math.round(number(params.wallTime) * 1_000)).toISOString(), time: 0,
        _resourceType: str(params.type), _initiator: params.initiator,
        request: { method: str(request.method), url, headers: headers(request.headers), cookies: [],
          ...(typeof request.postData === "string" || request.hasPostData === true ? { postData: {
            mimeType: str(Object.entries(obj(request.headers)).find(([key]) => key.toLowerCase() === "content-type")?.[1]),
            text: typeof request.postData === "string" ? request.postData : "[unavailable]"
          } } : {}) },
        response: { status: 0, headers: [], cookies: [], content: { mimeType: "", size: 0 } } }
      const tracked: TrackedRequest = { entry, index: this.entries.length, started: number(params.timestamp), session, id }
      this.entries.push(entry); this.active.set(key, tracked)
      this.chains.set(key, [...this.chains.get(key) ?? [], tracked])
      await this.onExchange(entry, tracked.index, false)
      return
    }
    const tracked = this.active.get(key)
    if (!tracked) return // Early worker/attachment traffic is not fabricated.
    if (method === "Network.responseReceived") {
      this.response(tracked, obj(params.response))
      tracked.expectedExtra = typeof params.hasExtraInfo === "boolean" ? params.hasExtraInfo : undefined
      await this.applyExtras(key)
      return
    }
    tracked.entry.time = Math.max(0, Math.round((number(params.timestamp) - tracked.started) * 1_000))
    const response = obj(tracked.entry.response)
    const content = obj(response.content)
    if (method === "Network.loadingFailed") response.status = 0
    else if (obj(tracked.entry.request).method !== "HEAD" && ![204, 205, 304].includes(number(response.status)) && /json|text|javascript|xml/iu.test(str(content.mimeType))) {
      tracked.bodyAvailable = false
      try {
        const body = await this.rpc("Network.getResponseBody", { requestId: id }, session)
        if (typeof body.body === "string" && Buffer.byteLength(body.body, "utf8") <= 1_048_576) {
          content.text = body.body
          if (body.base64Encoded === true) content.encoding = "base64"
          content.size = number(params.encodedDataLength)
          tracked.bodyAvailable = true
        }
      } catch { /* An unavailable body is unknown, not an empty successful payload. */ }
    }
    if (this.closed || this.failure) return
    tracked.finished = true
    await this.publishExchange(tracked)
    this.active.delete(key)
  }

  private async publishExchange(tracked: TrackedRequest): Promise<void> {
    if (this.closed || this.failure) return
    const complete = tracked.finished === true && (tracked.expectedExtra === false ||
      (tracked.expectedExtra === true && tracked.requestExtra !== undefined && tracked.responseExtra !== undefined))
    // Metadata is an observation even when the payload is unavailable. Do not
    // admit that exchange into dependency reconstruction as complete evidence.
    tracked.entry._observationComplete = complete && tracked.bodyAvailable !== false
    await this.onExchange(tracked.entry, tracked.index, complete)
  }

  private async applyExtras(key: string): Promise<void> {
    const extra = this.extras.get(key)
    if (!extra) return
    // CDP preserves each extra-info stream's redirect order, but either stream
    // can arrive before/after its base event. Never guess across an unknown flag.
    for (const tracked of this.chains.get(key) ?? []) {
      if (tracked.expectedExtra === undefined) break
      if (!tracked.expectedExtra) continue
      if (!tracked.requestExtra && extra.request.length) {
        tracked.requestExtra = extra.request.shift()!
        const request = obj(tracked.entry.request)
        request.headers = headers(tracked.requestExtra.headers)
        if (request.postData) obj(request.postData).mimeType = str(Object.entries(obj(tracked.requestExtra.headers)).find(([name]) => name.toLowerCase() === "content-type")?.[1])
        request.cookies = (Array.isArray(tracked.requestExtra.associatedCookies) ? tracked.requestExtra.associatedCookies : [])
          .filter((item) => Array.isArray(obj(item).blockedReasons) && (obj(item).blockedReasons as unknown[]).length === 0)
          .map((item) => obj(obj(item).cookie)).map((cookie) => ({ name: str(cookie.name), value: str(cookie.value) }))
      }
      if (!tracked.responseExtra && extra.response.length) {
        tracked.responseExtra = extra.response.shift()!
        const response = obj(tracked.entry.response)
        response.headers = headers(tracked.responseExtra.headers)
        response.status = number(tracked.responseExtra.statusCode)
        response.redirectURL = str(Object.entries(obj(tracked.responseExtra.headers)).find(([name]) => name.toLowerCase() === "location")?.[1])
      }
      await this.publishExchange(tracked)
      if (!tracked.requestExtra || !tracked.responseExtra) break
    }
  }

  private response(tracked: TrackedRequest, response: Record<string, unknown>): void {
    tracked.entry.response = { status: number(response.status), statusText: str(response.statusText),
      redirectURL: str(Object.entries(obj(response.headers)).find(([key]) => key.toLowerCase() === "location")?.[1]),
      headers: headers(response.headers), cookies: [],
      content: { mimeType: str(response.mimeType), size: number(response.encodedDataLength) } }
  }

  async flush(): Promise<void> {
    this.assertHealthy()
    while (this.ready.size > 0) await Promise.all([...this.ready])
    await this.tail
    this.assertHealthy()
  }

  /** Snapshot memory only; capture continues. The caller must flush its durable writer. */
  async snapshot(onSnapshot?: () => void): Promise<ReadonlyArray<NetworkEntry>> {
    await this.flush()
    const snapshot = this.tail.then(() => {
      const entries = structuredClone(this.entries)
      onSnapshot?.()
      return entries
    })
    this.tail = snapshot.then(() => {})
    return snapshot
  }

  private shutdown = (): void => {
    if (this.closed) return
    this.closed = true
    this.signal?.removeEventListener("abort", this.shutdown)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Network observation closed")) }
    this.pending.clear()
    try { this.socket?.close() } catch {}
    this.entries.length = 0; this.active.clear(); this.sessions.clear(); this.chains.clear(); this.extras.clear()
  }

  async stopAndSnapshot(onSnapshot?: () => void): Promise<ReadonlyArray<NetworkEntry>> {
    this.stopping = true
    try { return await this.snapshot(onSnapshot) } finally { await this.close() }
  }

  async close(): Promise<void> {
    this.stopping = true
    try { if (!this.closed) await this.flush(); else await this.tail } finally { this.shutdown() }
  }
}
