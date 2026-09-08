import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AgentBrowserClient,
  AgentBrowserClientError,
  PINNED_AGENT_BROWSER_ASSETS,
  agentBrowserHostAllowed,
  isolatedAgentBrowserEnvironment,
  normalizeAgentBrowserAllowedDomains,
  pinnedAgentBrowserAssetFor,
  pinnedAgentBrowserExecutablePath,
  validateAgentBrowserTarget,
  verifyPinnedAgentBrowserExecutable,
  type AgentBrowserSpawn,
  type AgentBrowserSpawnOptions,
  type AgentBrowserSubprocess,
  type AgentBrowserWebSocket,
  type AgentBrowserWebSocketEvent,
  type AgentBrowserWritable
} from "../src/agent-browser-client"
import {
  MAX_BROWSER_RAW_RECORD_CHARS,
  MAX_BROWSER_TRACE_CALLS,
  type BrowserTraceEvent
} from "../src/browser-trace"

const encoder = new TextEncoder()

const byteStream = (text: string): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    if (text.length > 0) controller.enqueue(encoder.encode(text))
    controller.close()
  }
})

interface SpawnCall {
  readonly argv: ReadonlyArray<string>
  readonly options: AgentBrowserSpawnOptions
  readonly stdin: string[]
}

const completedProcess = (
  stdout: string,
  call: SpawnCall,
  exitCode = 0
): AgentBrowserSubprocess => {
  const writable: AgentBrowserWritable = {
    write(bytes) { call.stdin.push(new TextDecoder().decode(bytes)) },
    end() {}
  }
  return {
    stdout: byteStream(stdout),
    stderr: byteStream(""),
    ...(call.options.stdin === "pipe" ? { stdin: writable } : {}),
    exited: Promise.resolve(exitCode),
    kill() {}
  }
}

class FakeWebSocket implements AgentBrowserWebSocket {
  private readonly listeners = new Map<string, Array<(event: AgentBrowserWebSocketEvent) => void>>()
  closed = false
  closeCode: number | undefined
  closeReason: string | undefined

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: AgentBrowserWebSocketEvent) => void): void {
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  emit(type: "open" | "message" | "error" | "close", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data })
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
    this.emit("close")
  }
}

class ThrowingCloseWebSocket extends FakeWebSocket {
  override close(): void {
    throw new Error("injected WebSocket close failure")
  }
}

const baseIsolation = {
  configPath: "/tmp/agent-browser-test/config.json",
  actionPolicyPath: "/tmp/agent-browser-test/action-policy.json",
  socketDirectory: "/tmp/agent-browser-test/sockets",
  temporaryDirectory: "/tmp/agent-browser-test/browser-temp",
  session: "session-001",
  namespace: "namespace-001",
  allowedDomains: ["example.com", "*.static.example.com"]
} as const

const traceTarget = (events: BrowserTraceEvent[]) => {
  let sequence = 0
  let call = 0
  return {
    threadId: "browser-thread-001",
    nextSequence: () => sequence++,
    nextCallId: () => `call-${String(++call).padStart(6, "0")}`,
    publish: (event: BrowserTraceEvent) => { events.push(event) }
  }
}

describe("agent-browser client isolation", () => {
  test("pins and verifies the exact native v0.36.0 release asset", async () => {
    expect(Object.keys(PINNED_AGENT_BROWSER_ASSETS).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-musl-arm64",
      "linux-musl-x64",
      "linux-x64",
      "win32-x64"
    ])
    expect(pinnedAgentBrowserAssetFor("linux", "x64", "musl")).toMatchObject({
      name: "agent-browser-linux-musl-x64",
      sha256: "a20cc2a5202a48f5820372803dedbcd5f556dff7a89421f1b0f2612962b10718"
    })
    expect(pinnedAgentBrowserAssetFor("win32", "arm64")).toMatchObject({
      name: "agent-browser-win32-x64.exe",
      sha256: "412ff72737a109e93f5304b0ff76c988fb6f1f451d0fc7e010577922bcc20ff3"
    })
    expect(() => pinnedAgentBrowserAssetFor("freebsd", "x64")).toThrow(AgentBrowserClientError)

    const current = pinnedAgentBrowserAssetFor()
    await expect(verifyPinnedAgentBrowserExecutable(
      pinnedAgentBrowserExecutablePath(current),
      current
    )).resolves.toBeUndefined()
  })

  test("rejects pinned executable size and digest mismatches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-browser-integrity-test-"))
    const path = join(directory, "agent-browser-test")
    const asset = {
      platformKey: "test-x64",
      name: "agent-browser-test",
      sizeBytes: 3,
      // SHA-256 of `abc`; the fixture deliberately writes different bytes.
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    }
    try {
      await writeFile(path, "ab")
      await expect(verifyPinnedAgentBrowserExecutable(path, asset)).rejects.toBeInstanceOf(AgentBrowserClientError)
      await writeFile(path, "abd")
      await expect(verifyPinnedAgentBrowserExecutable(path, asset)).rejects.toBeInstanceOf(AgentBrowserClientError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a detached sandbox asset directory retains production integrity verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-browser-detached-test-"))
    const asset = pinnedAgentBrowserAssetFor()
    try {
      expect(pinnedAgentBrowserExecutablePath(asset, directory)).toBe(join(directory, asset.name))
      expect(() => pinnedAgentBrowserExecutablePath(asset, "relative/native")).toThrow(AgentBrowserClientError)
      const client = new AgentBrowserClient({
        isolation: baseIsolation,
        trace: traceTarget([]),
        nativeAssetDirectory: directory
      })
      // A missing sandbox asset must not fall back to the installed workspace binary.
      await expect(client.streamStatus()).rejects.toBeInstanceOf(AgentBrowserClientError)
      await writeFile(join(directory, asset.name), "corrupt native asset")
      const corrupt = new AgentBrowserClient({
        isolation: baseIsolation,
        trace: traceTarget([]),
        nativeAssetDirectory: directory
      })
      await expect(corrupt.streamStatus()).rejects.toBeInstanceOf(AgentBrowserClientError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("hosts can require a validated filtering proxy without changing the default isolation", () => {
    expect(isolatedAgentBrowserEnvironment({}, baseIsolation).AGENT_BROWSER_PROXY).toBeUndefined()
    for (const publicProxy of [undefined, "http://localhost:8080", "http://127.0.0.1:65536", "http://127.0.0.1:8080/path"]) {
      expect(() => isolatedAgentBrowserEnvironment({}, {
        ...baseIsolation, requirePublicProxy: true, ...(publicProxy === undefined ? {} : { publicProxy })
      })).toThrow(AgentBrowserClientError)
    }
    const env = isolatedAgentBrowserEnvironment({}, { ...baseIsolation, requirePublicProxy: true, publicProxy: "http://127.0.0.1:8080" })
    expect(env.AGENT_BROWSER_PROXY).toBe("http://127.0.0.1:8080")
    expect(env.AGENT_BROWSER_PROXY_BYPASS).toBe("<-loopback>")
    expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBe("*.static.example.com,example.com")
  })

  test("scrubs inherited agent-browser state and builds exact argv without a shell", async () => {
    const calls: SpawnCall[] = []
    const spawn: AgentBrowserSpawn = (argv, options) => {
      const call = { argv: [...argv], options, stdin: [] }
      calls.push(call)
      return completedProcess(JSON.stringify({
        success: true,
        data: { enabled: true, connected: false, screencasting: false, port: 43123 },
        error: null
      }), call)
    }
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      executablePath: "/runtime/node_modules/agent-browser/bin/agent-browser.js",
      nodeExecutable: "/usr/bin/node",
      env: {
        PATH: "/usr/bin",
        HOME: "/tmp/browser-home",
        AI_GATEWAY_API_KEY: "provider-secret",
        TARDIGRADE_TOKEN: "control-plane-secret",
        CEREBRAS_API_KEY: "unrelated-provider-secret",
        UNRELATED_SECRET: "must-not-survive",
        AGENT_BROWSER_PROFILE: "must-not-survive",
        AGENT_BROWSER_EXECUTABLE_PATH: "/tmp/unverified-chrome",
        AGENT_BROWSER_ARGS: "--disable-web-security",
        AGENT_BROWSER_CDP: "9222",
        CLOAKBROWSER_BINARY_PATH: "/tmp/unverified-cloak",
        CLOAKBROWSER_LICENSE_KEY: "license-secret",
        AGENT_BROWSER_ALLOWED_DOMAINS: "evil.example",
        HTTPS_PROXY: "http://proxy.invalid",
        no_proxy: "example.com"
      },
      spawn
    })

    await expect(client.streamStatus()).resolves.toEqual({
      enabled: true,
      connected: false,
      screencasting: false,
      port: 43123
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual([
      "/usr/bin/node",
      "/runtime/node_modules/agent-browser/bin/agent-browser.js",
      "--json",
      "--session",
      "session-001",
      "--namespace",
      "namespace-001",
      "--no-webmcp",
      "stream",
      "status"
    ])
    expect(calls[0]?.options.stdin).toBe("ignore")
    expect(calls[0]?.options.env.AGENT_BROWSER_PROFILE).toBeUndefined()
    expect(calls[0]?.options.env.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined()
    expect(calls[0]?.options.env.AGENT_BROWSER_ARGS).toBeUndefined()
    expect(calls[0]?.options.env.AGENT_BROWSER_CDP).toBeUndefined()
    expect(calls[0]?.options.env.CLOAKBROWSER_BINARY_PATH).toBeUndefined()
    expect(calls[0]?.options.env.CLOAKBROWSER_LICENSE_KEY).toBeUndefined()
    expect(calls[0]?.options.env.AGENT_BROWSER_ALLOWED_DOMAINS).toBe("*.static.example.com,example.com")
    expect(calls[0]?.options.env.AGENT_BROWSER_CONFIG).toBe("/tmp/agent-browser-test/config.json")
    expect(calls[0]?.options.env.AGENT_BROWSER_ACTION_POLICY).toBe("/tmp/agent-browser-test/action-policy.json")
    expect(calls[0]?.options.env.AGENT_BROWSER_SOCKET_DIR).toBe("/tmp/agent-browser-test/sockets")
    expect(calls[0]?.options.env.TEMP).toBe("/tmp/agent-browser-test/browser-temp")
    expect(calls[0]?.options.env.TMP).toBe("/tmp/agent-browser-test/browser-temp")
    expect(calls[0]?.options.env.TMPDIR).toBe("/tmp/agent-browser-test/browser-temp")
    expect(calls[0]?.options.env.AGENT_BROWSER_CONTENT_BOUNDARIES).toBe("1")
    expect(calls[0]?.options.env.AGENT_BROWSER_MAX_OUTPUT).toBe("65536")
    expect(calls[0]?.options.env.HTTPS_PROXY).toBeUndefined()
    expect(calls[0]?.options.env.no_proxy).toBeUndefined()
    expect(calls[0]?.options.env.TARDIGRADE_TOKEN).toBeUndefined()
    expect(calls[0]?.options.env.CEREBRAS_API_KEY).toBeUndefined()
    expect(calls[0]?.options.env.UNRELATED_SECRET).toBeUndefined()
    expect(calls[0]?.options.env.HOME).toBe("/tmp/browser-home")
    expect(calls[0]?.options.env.AI_GATEWAY_API_KEY).toBeUndefined()
  })

  test("validates explicit exact and wildcard target hosts", () => {
    const domains = normalizeAgentBrowserAllowedDomains(["Example.COM", "*.cdn.example.com"])
    expect(domains).toEqual(["*.cdn.example.com", "example.com"])
    expect(agentBrowserHostAllowed("cdn.example.com", domains)).toBe(true)
    expect(agentBrowserHostAllowed("a.cdn.example.com", domains)).toBe(true)
    expect(agentBrowserHostAllowed("notexample.com", domains)).toBe(false)
    expect(validateAgentBrowserTarget("https://example.com/a?token=private", domains)).toBe("https://example.com/a?token=private")
    expect(() => validateAgentBrowserTarget("https://user:pass@example.com/", domains)).toThrow(AgentBrowserClientError)
    expect(() => validateAgentBrowserTarget("https://elsewhere.example/", domains)).toThrow(AgentBrowserClientError)
    expect(() => isolatedAgentBrowserEnvironment({}, { ...baseIsolation, allowedDomains: [] })).toThrow(AgentBrowserClientError)
    expect(() => isolatedAgentBrowserEnvironment({}, { ...baseIsolation, configPath: "relative.json" })).toThrow(AgentBrowserClientError)
    expect(() => isolatedAgentBrowserEnvironment({}, { ...baseIsolation, actionPolicyPath: "relative.json" })).toThrow(AgentBrowserClientError)
    expect(() => new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      executablePath: "/tmp/unverified-agent-browser"
    })).toThrow(AgentBrowserClientError)
  })

  test("unrestricted domain policy permits public destinations without a native domain filter", () => {
    const domains = normalizeAgentBrowserAllowedDomains(["*"])
    for (const url of ["https://example.com/", "https://www.iana.org/domains/reserved"]) {
      expect(validateAgentBrowserTarget(url, domains)).toBe(url)
    }
    for (const url of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://2130706433/", "http://metadata.internal/", "https://x.local./", "file:///etc/passwd", "https://user:secret@example.com/"]) {
      expect(() => validateAgentBrowserTarget(url, domains)).toThrow(AgentBrowserClientError)
    }
    expect(() => normalizeAgentBrowserAllowedDomains(["*", "example.com"])).toThrow(AgentBrowserClientError)
    const env = isolatedAgentBrowserEnvironment({ AGENT_BROWSER_ALLOWED_DOMAINS: "stale.example", AI_GATEWAY_API_KEY: "secret" }, { ...baseIsolation, allowedDomains: domains })
    expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBeUndefined()
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined()
    expect(env.AGENT_BROWSER_ACTION_POLICY).toBe(baseIsolation.actionPolicyPath)
    expect(isolatedAgentBrowserEnvironment({}, baseIsolation).AGENT_BROWSER_ALLOWED_DOMAINS).toBe(normalizeAgentBrowserAllowedDomains(baseIsolation.allowedDomains).join(","))
  })
})

describe("agent-browser telemetry and process settlement", () => {
  test("only settled native read lookup failures are recoverable; raw errors never escape", async () => {
    for (const fixture of [
      { action: "get_attribute", daemon: "getattribute", error: "Element not found: RAW_SECRET", exit: 1, code: "element_not_found" },
      { action: "get_attribute", daemon: "getattribute", error: "Unknown ref: RAW_SECRET", exit: 1, code: "element_not_found" },
      { action: "wait", daemon: "wait", error: "Wait timed out after 25000ms", exit: 1, code: "element_not_found" },
      { action: "wait", daemon: "wait", error: "Wait timed out after 25000ms RAW_SECRET", exit: 1, code: "process_failed" },
      { action: "wait", daemon: "wait", error: "Wait timed out after 25000ms", exit: 2, code: "process_failed" },
      { action: "wait", daemon: "wait", error: "Wait timed out after 25000ms", exit: 1, code: "telemetry_incomplete", disconnect: true },
      { action: "click", daemon: "click", error: "Wait timed out after 25000ms", exit: 1, code: "process_failed" },
      { action: "get_attribute", daemon: "getattribute", error: "Browser crashed RAW_SECRET", exit: 1, code: "process_failed" },
      { action: "get_attribute", daemon: "getattribute", error: "Element not found: RAW_SECRET", exit: 2, code: "process_failed" },
      { action: "click", daemon: "click", error: "Element not found: RAW_SECRET", exit: 1, code: "process_failed" },
      { action: "get_attribute", daemon: "getattribute", error: "Element not found: RAW_SECRET", exit: 1, code: "telemetry_incomplete", disconnect: true }
    ]) {
      const events: BrowserTraceEvent[] = []
      const socket = new FakeWebSocket()
      const client = new AgentBrowserClient({ isolation: baseIsolation, trace: traceTarget(events),
        spawn: (argv, options) => {
          queueMicrotask(() => {
            socket.emit("message", JSON.stringify({ type: "command", id: "lookup", action: fixture.daemon, params: {}, timestamp: 1000 }))
            socket.emit("message", JSON.stringify({ type: "result", id: "lookup", action: fixture.daemon, success: true, data: {}, timestamp: 1001 }))
            if (fixture.disconnect) socket.emit("close")
          })
          return completedProcess(JSON.stringify({ success: false, error: fixture.error }), { argv, options, stdin: [] }, fixture.exit)
        },
        webSocketFactory: () => {
          queueMicrotask(() => { socket.emit("open"); socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false })) })
          return socket
        }
      })
      await client.connectTelemetry(43123)
      const action = fixture.action === "click" || fixture.action === "wait" ? { action: fixture.action, selector: "#missing" } : { action: "get_attribute", selector: "#missing", name: "href" }
      await expect(client.executeAgentAction(action)).rejects.toMatchObject({ code: fixture.code, message: expect.not.stringContaining("RAW_SECRET") })
      if (!fixture.disconnect) expect(events.some((event) => event.type === "BrowserToolResultObserved" && event.success === false)).toBe(true)
      expect(JSON.stringify(events)).not.toContain("RAW_SECRET")
      client.disconnectTelemetry()
    }
  })

  test("executes reviewed argv actions and emits only controller-owned, value-free trace events", async () => {
    const sentinel = "RAW_SENTINEL_DO_NOT_LOG"
    const calls: SpawnCall[] = []
    const events: BrowserTraceEvent[] = []
    const socket = new FakeWebSocket()

    const emitExchange = (id: string, action: string, params: unknown, data: unknown, timestamp: number): void => {
      queueMicrotask(() => {
        socket.emit("message", JSON.stringify({ type: "command", id, action, params, timestamp }))
        socket.emit("message", JSON.stringify({
          type: "result",
          id,
          action,
          success: false,
          data,
          duration_ms: 7,
          timestamp: timestamp + 7
        }))
      })
    }

    const spawn: AgentBrowserSpawn = (argv, options) => {
      const call = { argv: [...argv], options, stdin: [] }
      calls.push(call)
      const command = argv.slice(8)
      if (command.join(" ") === "get cdp-url") {
        emitExchange("r1", "cdp_url", {}, { cdpUrl: sentinel }, 1_000)
        return completedProcess(JSON.stringify({ success: true, data: { cdpUrl: "ws://127.0.0.1:1234/devtools/browser/isolated" } }), call)
      }
      if (command[0] === "open") {
        emitExchange("r1", "navigate", { url: `${command[1]}${sentinel}` }, { url: sentinel }, 2_000)
        return completedProcess(JSON.stringify({ success: true, data: { url: sentinel } }), call)
      }
      if (command[0] === "click") {
        emitExchange("r1", "click", { selector: command[1], text: sentinel }, { text: sentinel }, 3_000)
        return completedProcess(JSON.stringify({ success: true, data: { text: sentinel } }), call)
      }
      if (command.join(" ") === "snapshot -i") {
        emitExchange("r1", "snapshot", { interactive: true, secret: sentinel }, { content: sentinel }, 4_000)
        return completedProcess(JSON.stringify({ success: true, data: { content: sentinel } }), call)
      }
      throw new Error(`unexpected fake command: ${command.join(" ")}`)
    }

    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget(events),
      spawn,
      webSocketFactory: (url) => {
        expect(url).toBe("ws://127.0.0.1:43123/?pacing=ack&maxFps=1")
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    await client.networkObservationEndpoint()
    await client.open("https://example.com/start")
    const click = await client.executeAgentAction({ action: "click", selector: "#safe-target" })
    const snapshot = await client.executeAgentAction({ action: "snapshot" })
    client.disconnectTelemetry()

    expect(click).toEqual({ action: "click", output: { text: sentinel } })
    expect(snapshot).toEqual({ action: "snapshot", output: { content: sentinel } })
    expect(calls.at(-2)?.argv.slice(8)).toEqual(["click", "#safe-target"])
    expect(calls.at(-1)?.argv.slice(8)).toEqual(["snapshot", "-i"])
    expect(calls.at(-1)?.options.env.AGENT_BROWSER_ACTION_POLICY).toBe(baseIsolation.actionPolicyPath)
    expect(calls.every((call) => call.options.stdin === "ignore")).toBe(true)
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(events.filter((event) => event.type === "BrowserToolCallObserved").map((event) => event.callId)).toEqual([
      "call-000001",
      "call-000002",
      "call-000003",
      "call-000004"
    ])
    expect(events.filter((event) => event.type === "BrowserToolResultObserved").map((event) => event.success)).toEqual([
      true,
      true,
      true,
      true
    ])
    expect(JSON.stringify(events)).not.toContain(sentinel)
    expect(client.telemetryComplete).toBe(true)
    expect(socket.closed).toBe(true)
  })

  test("settles a delayed command exactly once before returning and ignores its late WebSocket result", async () => {
    const events: BrowserTraceEvent[] = []
    const socket = new FakeWebSocket()
    const spawn: AgentBrowserSpawn = (argv, options) => {
      const call = { argv: [...argv], options, stdin: [] }
      return completedProcess(JSON.stringify({ success: true, data: { text: "TRANSIENT_MODEL_VALUE" } }), call)
    }
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget(events),
      spawn,
      controlTimeoutMs: 100,
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    const action = client.executeAgentAction({ action: "click", selector: "#safe-target" })
    // Let the direct subprocess settle first. The client must remain boundedly
    // pending until the corresponding telemetry command has been observed.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(events).toHaveLength(0)
    socket.emit("message", JSON.stringify({
      type: "command",
      id: "delayed-upstream",
      action: "click",
      params: { selector: "#safe-target" },
      timestamp: 10
    }))

    await expect(action).resolves.toEqual({ action: "click", output: { text: "TRANSIENT_MODEL_VALUE" } })
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.type)).toEqual([
      "BrowserToolCallObserved",
      "BrowserToolResultObserved"
    ])
    expect(events[1]).toMatchObject({ action: "click", success: true })
    expect(JSON.stringify(events)).not.toContain("TRANSIENT_MODEL_VALUE")
    expect(client.telemetryComplete).toBe(true)

    socket.emit("message", JSON.stringify({
      type: "result",
      id: "delayed-upstream",
      action: "click",
      success: false,
      data: { text: "LATE_TRANSIENT_VALUE" },
      duration_ms: 7,
      timestamp: 17
    }))
    expect(events).toHaveLength(2)
    expect(client.telemetryComplete).toBe(true)
    expect(JSON.stringify(events)).not.toContain("LATE_TRANSIENT_VALUE")
    client.disconnectTelemetry()
  })

  test("fails closed when a direct subprocess has no telemetry command", async () => {
    const socket = new FakeWebSocket()
    const spawn: AgentBrowserSpawn = (argv, options) => {
      const call = { argv: [...argv], options, stdin: [] }
      return {
        ...completedProcess(JSON.stringify({ success: true, data: { clicked: true } }), call),
        // Consume most of the command budget. Telemetry settlement must use
        // only the remainder rather than starting a second full deadline.
        exited: new Promise<number>((resolveExit) => setTimeout(() => resolveExit(0), 150))
      }
    }
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      spawn,
      controlTimeoutMs: 200,
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    const startedAt = performance.now()
    await expect(client.executeAgentAction({ action: "click", selector: "#safe-target" }, 200))
      .rejects.toMatchObject({ code: "telemetry_incomplete" })
    expect(performance.now() - startedAt).toBeLessThan(300)
    expect(client.telemetryComplete).toBe(false)
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(1009)
  })

  test("terminates then kills a process that exceeds its deadline", async () => {
    const signals: string[] = []
    const exited = new Promise<number>(() => {})
    const spawn: AgentBrowserSpawn = () => ({
      stdout: new ReadableStream({ start() {} }),
      stderr: new ReadableStream({ start() {} }),
      exited,
      kill(signal) {
        signals.push(signal)
      }
    })
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      spawn,
      controlTimeoutMs: 20,
      killGraceMs: 1
    })

    await expect(client.streamStatus()).rejects.toMatchObject({ code: "process_timeout" })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("actions outlive the control timeout; finite opt-ins and Stop await process settlement", async () => {
    for (const navigation of [false, true]) for (const mode of ["complete", "timeout", "cancel"] as const) {
      const socket = new FakeWebSocket()
      const abort = new AbortController()
      const events: BrowserTraceEvent[] = []
      const kills: string[] = []
      let settled = false
      const action = navigation ? "navigate" : "click"
      const client = new AgentBrowserClient({ isolation: baseIsolation, trace: traceTarget(events),
        controlTimeoutMs: 10, killGraceMs: 100,
        webSocketFactory: () => { queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        }); return socket },
        spawn: (argv, options) => {
          queueMicrotask(() => socket.emit("message", JSON.stringify({ type: "command", id: "slow-action", action, params: {}, timestamp: Date.now() })))
          let finish!: (code: number) => void
          const exited = new Promise<number>((resolveExit) => { finish = resolveExit })
          const timer = setTimeout(() => { settled = true; finish(0) }, 60)
          if (mode === "cancel") setTimeout(() => abort.abort(), 20)
          return { ...completedProcess(JSON.stringify({ success: true, data: { done: true } }), { argv, options, stdin: [] }),
            exited, kill(signal) { kills.push(signal); clearTimeout(timer)
              setTimeout(() => { settled = true; finish(1) }, 5)
            } }
        }
      })
      await client.connectTelemetry(43123)
      const timeout = mode === "timeout" ? 20 : null
      const startedAt = performance.now()
      const run = navigation ? client.open("https://example.com", timeout, abort.signal)
        : client.executeAgentAction({ action: "click", selector: "#details" }, timeout, abort.signal)
      if (mode === "complete") {
        await run
        expect(performance.now() - startedAt).toBeGreaterThan(40)
        expect(kills).toEqual([])
      } else {
        await expect(run).rejects.toMatchObject({ code: mode === "timeout" ? "process_timeout" : "cancelled" })
        expect(kills).toEqual(["SIGTERM"])
      }
      expect(settled).toBe(true)
      expect(events.filter((event) => event.type === "BrowserToolResultObserved"))
        .toMatchObject([{ success: mode === "complete" }])
      client.disconnectTelemetry()
    }
  })

  test("Stop before command telemetry stays cancellation, including an already-aborted signal", async () => {
    for (const preAborted of [true, false]) {
      const socket = new FakeWebSocket(), abort = new AbortController()
      const events: BrowserTraceEvent[] = []
      let spawned = false, settled = false
      const client = new AgentBrowserClient({ isolation: baseIsolation, trace: traceTarget(events), killGraceMs: 100,
        webSocketFactory: () => { queueMicrotask(() => { socket.emit("open"); socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false })) }); return socket },
        spawn: (argv, options) => {
          spawned = true
          let finish!: (code: number) => void
          const exited = new Promise<number>((resolve) => { finish = resolve })
          queueMicrotask(() => { abort.abort(); socket.emit("close") })
          return { ...completedProcess(JSON.stringify({ success: true, data: {} }), { argv, options, stdin: [] }), exited,
            kill() { settled = true; finish(1) } }
        } })
      await client.connectTelemetry(43123)
      if (preAborted) abort.abort()
      await expect(client.executeAgentAction({ action: "click", selector: "#details" }, null, abort.signal)).rejects.toMatchObject({ code: "cancelled" })
      expect(spawned).toBe(!preAborted)
      expect(settled).toBe(!preAborted)
      expect(events).toHaveLength(0)
      client.disconnectTelemetry()
    }
  })

  test("rejects oversized output and never includes it in an error", async () => {
    const sentinel = "OVERSIZED_RAW_SENTINEL"
    const calls: SpawnCall[] = []
    const spawn: AgentBrowserSpawn = (argv, options) => {
      const call = { argv: [...argv], options, stdin: [] }
      calls.push(call)
      return completedProcess(`${sentinel}${"x".repeat(100)}`, call)
    }
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      spawn,
      stdoutLimitBytes: 16,
      killGraceMs: 1
    })

    let caught: unknown
    try { await client.streamStatus() } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AgentBrowserClientError)
    expect((caught as Error).message).not.toContain(sentinel)
    expect((caught as AgentBrowserClientError).code).toBe("output_limit")
  })

  test("rejects model-authored control actions, paths, flags, and extra fields before spawning", async () => {
    let spawnCount = 0
    const spawn: AgentBrowserSpawn = () => {
      spawnCount += 1
      throw new Error("must not spawn")
    }
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      spawn
    })

    for (const action of [
      { action: "har_stop", path: "/tmp/stolen.har" },
      { action: "click", selector: "--session", session: "attacker" },
      { action: "fill", selector: "#name", value: "--config=/tmp/evil" },
      { action: "navigate", url: "https://outside.example/" },
      { action: "click", selector: "#safe\u0000--global" }
    ]) {
      await expect(client.executeAgentAction(action)).rejects.toBeInstanceOf(AgentBrowserClientError)
    }
    expect(spawnCount).toBe(0)
  })

  test("successful process and telemetry handshakes leave no live deadline timers", async () => {
    const moduleUrl = new URL("../src/agent-browser-client.ts", import.meta.url).href
    const script = `
      import { AgentBrowserClient } from ${JSON.stringify(moduleUrl)}
      const encoder = new TextEncoder()
      const stream = (text) => new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text))
          controller.close()
        }
      })
      const trace = {
        threadId: "lifetime-thread",
        nextSequence: () => 0,
        nextCallId: () => "lifetime-call",
        publish() {}
      }
      class Socket {
        listeners = new Map()
        addEventListener(type, listener) {
          const current = this.listeners.get(type) ?? []
          current.push(listener)
          this.listeners.set(type, current)
        }
        emit(type, data) {
          for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data })
        }
        close() { this.emit("close") }
      }
      const client = new AgentBrowserClient({
        isolation: {
          configPath: "/tmp/lifetime/config.json",
          actionPolicyPath: "/tmp/lifetime/action-policy.json",
          socketDirectory: "/tmp/lifetime/sockets",
          temporaryDirectory: "/tmp/lifetime/browser-temp",
          session: "lifetime-session",
          namespace: "lifetime-namespace",
          allowedDomains: ["example.com"]
        },
        trace,
        spawn() {
          return {
            stdout: stream(JSON.stringify({
              success: true,
              data: { enabled: true, connected: false, screencasting: false, port: 43123 }
            })),
            stderr: stream(""),
            exited: Promise.resolve(0),
            kill() {}
          }
        },
        webSocketFactory() {
          const socket = new Socket()
          queueMicrotask(() => {
            socket.emit("open")
            socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
          })
          return socket
        }
      })
      await client.streamStatus()
      await client.connectTelemetry(43123)
      client.disconnectTelemetry()
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe"
    })
    let exceededLifetime = false
    const lifetimeLimit = setTimeout(() => {
      exceededLifetime = true
      child.kill("SIGKILL")
    }, 1_500)
    const exitCode = await child.exited
    clearTimeout(lifetimeLimit)
    const stderr = await new Response(child.stderr).text()

    expect(exceededLifetime).toBe(false)
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
  })

  test("a throwing WebSocket close cannot prevent close-all cleanup", async () => {
    const socket = new ThrowingCloseWebSocket()
    const commands: string[] = []
    const spawn: AgentBrowserSpawn = (argv, options) => {
      const call = { argv: [...argv], options, stdin: [] }
      commands.push(argv.slice(8).join(" "))
      return completedProcess(JSON.stringify({ success: true, data: { closed: 1, failed: [], sessions: [] } }), call)
    }
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      spawn,
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    expect(() => { client.disconnectTelemetry() }).not.toThrow()
    await expect(client.closeAll()).resolves.toBeUndefined()

    expect(commands).toEqual(["close --all"])
    expect(client.telemetryComplete).toBe(false)
  })

  test("tears down telemetry before an over-limit command can grow trace state", async () => {
    const events: BrowserTraceEvent[] = []
    const socket = new FakeWebSocket()
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget(events),
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    for (let index = 0; index <= MAX_BROWSER_TRACE_CALLS; index += 1) {
      socket.emit("message", JSON.stringify({
        type: "command",
        id: `upstream-${index}`,
        action: "click",
        params: { selector: "[data-private]" },
        timestamp: index
      }))
    }

    expect(events).toHaveLength(MAX_BROWSER_TRACE_CALLS)
    expect(client.callWindows).toHaveLength(MAX_BROWSER_TRACE_CALLS)
    expect(client.telemetryComplete).toBe(false)
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(1009)
  })

  test("contains a controller trace-allocation failure inside the telemetry callback", async () => {
    const socket = new FakeWebSocket()
    const events: BrowserTraceEvent[] = []
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: {
        threadId: "full-prefix-thread",
        nextSequence: () => 0,
        nextCallId: () => { throw new Error("cumulative trace call limit") },
        publish: (event) => { events.push(event) }
      },
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    expect(() => {
      socket.emit("message", JSON.stringify({
        type: "command",
        id: "upstream-after-full-prefix",
        action: "click",
        params: { selector: "#safe" },
        timestamp: 1
      }))
    }).not.toThrow()

    expect(events).toHaveLength(0)
    expect(client.telemetryComplete).toBe(false)
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(1009)
    expect(socket.closeReason).toBe("telemetry publication")
  })

  test("rejects an oversized frame-shaped record before parsing or retaining it", async () => {
    const events: BrowserTraceEvent[] = []
    const socket = new FakeWebSocket()
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget(events),
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    socket.emit("message", `{"type":"frame","data":"${"x".repeat(MAX_BROWSER_RAW_RECORD_CHARS)}"}`)

    expect(events).toHaveLength(0)
    expect(client.callWindows).toHaveLength(0)
    expect(client.telemetryComplete).toBe(false)
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(1009)
    expect(socket.closeReason).toBe("telemetry limit")
  })

  test("closes when individually bounded frame records exhaust the cumulative byte budget", async () => {
    const socket = new FakeWebSocket()
    const client = new AgentBrowserClient({
      isolation: baseIsolation,
      trace: traceTarget([]),
      telemetryLimitBytes: 512,
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open")
          socket.emit("message", JSON.stringify({ type: "status", connected: false, screencasting: false }))
        })
        return socket
      }
    })

    await client.connectTelemetry(43123)
    const frame = JSON.stringify({ type: "frame", data: "x".repeat(180) })
    socket.emit("message", frame)
    expect(socket.closed).toBe(false)
    socket.emit("message", frame)
    socket.emit("message", frame)

    expect(client.telemetryComplete).toBe(false)
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(1009)
  })
})
