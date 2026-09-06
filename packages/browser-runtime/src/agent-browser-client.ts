import { createHash } from "node:crypto"
import { open as openFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import {
  BROWSER_TRACE_REDACTION_REVISION,
  BROWSER_TRACE_SCHEMA_VERSION,
  MAX_BROWSER_RAW_RECORD_CHARS,
  MAX_BROWSER_TRACE_CALLS,
  MAX_BROWSER_TRACE_EVENTS,
  MAX_BROWSER_TOOL_DURATION_MS,
  browserPayloadShapeOf,
  browserToolActionOf,
  browserToolCallEventOf,
  browserToolCategoryOf,
  browserToolResultShapeOf,
  decodeBrowserTraceEvent,
  type BrowserPayloadShape,
  type BrowserToolAction,
  type BrowserTraceEvent
} from "./browser-trace"

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u
const DEFAULT_CONTROL_TIMEOUT_MS = 10_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_STDOUT_LIMIT = MAX_BROWSER_RAW_RECORD_CHARS
const DEFAULT_STDERR_LIMIT = 262_144
const ISOLATED_MAX_OUTPUT_CHARS = 65_536
const DEFAULT_TELEMETRY_LIMIT_BYTES = MAX_BROWSER_RAW_RECORD_CHARS * 32
const MAX_TELEMETRY_LIMIT_BYTES = MAX_BROWSER_RAW_RECORD_CHARS * 64
const MAX_DIRECT_TELEMETRY_SETTLEMENT_MS = 1_000
const EXECUTABLE_HASH_BUFFER_BYTES = 64 * 1024
/**
 * The browser subprocess receives only a small host runtime surface. Model
 * credentials remain in the trusted outer agent loop and never enter this
 * third-party child (nor do Tardigrade, Capture Lab, shell, or cloud secrets).
 */
const PASSTHROUGH_ENV = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR"
])

export type AgentBrowserClientErrorCode =
  | "invalid_configuration"
  | "invalid_target"
  | "process_failed"
  | "process_timeout"
  | "cancelled"
  | "output_limit"
  | "invalid_json"
  | "invalid_response"
  | "stream_failed"
  | "telemetry_incomplete"
  | "element_not_found"

export class AgentBrowserClientError extends Error {
  readonly code: AgentBrowserClientErrorCode

  constructor(code: AgentBrowserClientErrorCode, message: string) {
    super(message)
    this.name = "AgentBrowserClientError"
    this.code = code
  }
}

/** Reduce native errors without forwarding their possibly value-bearing message. */
export const agentBrowserClientStopReason = (code: AgentBrowserClientErrorCode): import("./browse-harness-contract").BrowseHarnessStopReason => {
  switch (code) {
    case "stream_failed": case "telemetry_incomplete": return "telemetry_incomplete"
    case "invalid_json": case "invalid_response": case "process_failed": case "element_not_found": return "action_failed"
    default: return code
  }
}

export const AGENT_BROWSER_PINNED_VERSION = "0.36.0"
export const AGENT_BROWSER_PINNED_COMMIT = "eb05921bad874cd2a1b4fa5d1149f1ed26576cae"

export interface PinnedAgentBrowserAsset {
  readonly platformKey: string
  readonly name: string
  readonly sizeBytes: number
  readonly sha256: string
}

/**
 * Exact release-asset metadata published by GitHub for v0.36.0. The upstream
 * postinstall does not verify these values, so it is never trusted here.
 */
export const PINNED_AGENT_BROWSER_ASSETS: Readonly<Record<string, PinnedAgentBrowserAsset>> = Object.freeze({
  "darwin-arm64": Object.freeze({
    platformKey: "darwin-arm64",
    name: "agent-browser-darwin-arm64",
    sizeBytes: 12_363_200,
    sha256: "b2106ab39db0838e7b1772f7f26f760518de56d09053150c56f9dddf15af997d"
  }),
  "darwin-x64": Object.freeze({
    platformKey: "darwin-x64",
    name: "agent-browser-darwin-x64",
    sizeBytes: 13_510_280,
    sha256: "45d9ac061a7d72e61eaff905326e2e19365f4dadb12142ea2f2d76d84689c708"
  }),
  "linux-arm64": Object.freeze({
    platformKey: "linux-arm64",
    name: "agent-browser-linux-arm64",
    sizeBytes: 12_442_720,
    sha256: "aeb556addca3903601a433de1acad3ace1c9c61d170084bf58d875884599a990"
  }),
  "linux-musl-arm64": Object.freeze({
    platformKey: "linux-musl-arm64",
    name: "agent-browser-linux-musl-arm64",
    sizeBytes: 12_297_000,
    sha256: "1ca7e003c9cb185f174fc81e51a609db27c77e3bfe00a0edff60688f8cd14f88"
  }),
  "linux-musl-x64": Object.freeze({
    platformKey: "linux-musl-x64",
    name: "agent-browser-linux-musl-x64",
    sizeBytes: 13_995_728,
    sha256: "a20cc2a5202a48f5820372803dedbcd5f556dff7a89421f1b0f2612962b10718"
  }),
  "linux-x64": Object.freeze({
    platformKey: "linux-x64",
    name: "agent-browser-linux-x64",
    sizeBytes: 14_156_776,
    sha256: "56d15181e51e00213f907fcf39707cfc76bfa804ff20f5a9373661c73f96de5e"
  }),
  "win32-x64": Object.freeze({
    platformKey: "win32-x64",
    name: "agent-browser-win32-x64.exe",
    sizeBytes: 13_837_312,
    sha256: "412ff72737a109e93f5304b0ff76c988fb6f1f451d0fc7e010577922bcc20ff3"
  })
})

const runtimeLinuxLibc = (): "glibc" | "musl" => {
  try {
    const report = process.report?.getReport()
    if (typeof report === "object" && report !== null && "header" in report) {
      const header = report.header as { readonly glibcVersionRuntime?: unknown }
      return typeof header.glibcVersionRuntime === "string" && header.glibcVersionRuntime.length > 0
        ? "glibc"
        : "musl"
    }
  } catch {}
  throw new AgentBrowserClientError("invalid_configuration", "The Linux libc variant could not be established")
}

export const pinnedAgentBrowserAssetFor = (
  platform: string = process.platform,
  architecture: string = process.arch,
  linuxLibc?: "glibc" | "musl"
): PinnedAgentBrowserAsset => {
  const normalizedArchitecture = architecture === "x86_64" ? "x64"
    : architecture === "aarch64" ? "arm64"
      : architecture
  let platformKey: string
  if (platform === "darwin" && (normalizedArchitecture === "x64" || normalizedArchitecture === "arm64")) {
    platformKey = `darwin-${normalizedArchitecture}`
  } else if (platform === "linux" && (normalizedArchitecture === "x64" || normalizedArchitecture === "arm64")) {
    const libc = linuxLibc ?? runtimeLinuxLibc()
    platformKey = libc === "musl" ? `linux-musl-${normalizedArchitecture}` : `linux-${normalizedArchitecture}`
  } else if (platform === "win32" && (normalizedArchitecture === "x64" || normalizedArchitecture === "arm64")) {
    // Upstream v0.36.0 publishes no Windows arm64 build and explicitly uses x64 emulation.
    platformKey = "win32-x64"
  } else {
    throw new AgentBrowserClientError("invalid_configuration", "This platform has no pinned agent-browser executable")
  }
  const asset = PINNED_AGENT_BROWSER_ASSETS[platformKey]
  if (asset === undefined) {
    throw new AgentBrowserClientError("invalid_configuration", "This platform has no pinned agent-browser executable")
  }
  return asset
}

export const pinnedAgentBrowserExecutablePath = (asset = pinnedAgentBrowserAssetFor()): string =>
  resolve(import.meta.dir, "..", "node_modules", "agent-browser", "bin", asset.name)

export const verifyPinnedAgentBrowserExecutable = async (
  executablePath: string,
  asset: PinnedAgentBrowserAsset
): Promise<void> => {
  if (!isAbsolute(executablePath)) {
    throw new AgentBrowserClientError("invalid_configuration", "The pinned agent-browser executable path must be absolute")
  }
  let handle
  try {
    handle = await openFile(executablePath, "r")
  } catch {
    throw new AgentBrowserClientError("invalid_configuration", "The pinned agent-browser executable is missing")
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size !== asset.sizeBytes) {
      throw new AgentBrowserClientError("invalid_configuration", "The pinned agent-browser executable failed integrity verification")
    }
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(EXECUTABLE_HASH_BUFFER_BYTES)
    let total = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > asset.sizeBytes) {
        throw new AgentBrowserClientError("invalid_configuration", "The pinned agent-browser executable failed integrity verification")
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    if (total !== asset.sizeBytes || hash.digest("hex") !== asset.sha256) {
      throw new AgentBrowserClientError("invalid_configuration", "The pinned agent-browser executable failed integrity verification")
    }
  } finally {
    await handle.close()
  }
}

export interface AgentBrowserWritable {
  write(bytes: Uint8Array): number | void | Promise<number | void>
  end(): number | void | Promise<number | void>
}

export interface AgentBrowserSubprocess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdin?: AgentBrowserWritable
  readonly exited: Promise<number>
  kill(signal: "SIGTERM" | "SIGKILL"): void
}

export interface AgentBrowserSpawnOptions {
  readonly env: Readonly<Record<string, string>>
  readonly stdin: "ignore" | "pipe"
}

export type AgentBrowserSpawn = (
  argv: ReadonlyArray<string>,
  options: AgentBrowserSpawnOptions
) => AgentBrowserSubprocess

export interface AgentBrowserWebSocketEvent {
  readonly data?: unknown
}

export interface AgentBrowserWebSocket {
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: AgentBrowserWebSocketEvent) => void): void
  close(code?: number, reason?: string): void
}

export type AgentBrowserWebSocketFactory = (url: string) => AgentBrowserWebSocket

export interface AgentBrowserTraceTarget {
  readonly threadId: string
  nextSequence(): number
  nextCallId(): string
  publish(event: BrowserTraceEvent): void
}

export interface AgentBrowserIsolation {
  readonly configPath: string
  readonly actionPolicyPath: string
  readonly socketDirectory: string
  readonly temporaryDirectory: string
  readonly session: string
  readonly namespace: string
  readonly allowedDomains: ReadonlyArray<string>
  /** Aiko adaptation: wildcard public browsing requires this host-owned filtering proxy. */
  readonly publicProxy?: string
  readonly idleTimeoutMs?: number
}

export interface AgentBrowserClientOptions {
  readonly isolation: AgentBrowserIsolation
  readonly trace: AgentBrowserTraceTarget
  readonly executablePath?: string
  readonly nodeExecutable?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawn?: AgentBrowserSpawn
  readonly webSocketFactory?: AgentBrowserWebSocketFactory
  readonly now?: () => number
  readonly controlTimeoutMs?: number
  readonly killGraceMs?: number
  readonly stdoutLimitBytes?: number
  readonly stderrLimitBytes?: number
  readonly telemetryLimitBytes?: number
  /** Aiko streaming mode: retain in-flight correlation, not the entire session in RAM.
   * The host must persist published trace events before issuing its next command. */
  readonly rollingTrace?: boolean
}

export interface AgentBrowserStreamStatus {
  readonly enabled: boolean
  readonly connected: boolean
  readonly screencasting: boolean
  readonly port: number | null
}

export interface AgentBrowserHarStopResult {
  readonly path: string
  readonly requestCount: number
}

type AgentBrowserToolParameterKind =
  | "target_url"
  | "selector"
  | "wait_selector"
  | "value"
  | "key"
  | "direction"
  | "pixels"
  | "milliseconds"
  | "attribute_name"
  | "tab_id"

interface AgentBrowserToolParameterSpec {
  readonly kind: AgentBrowserToolParameterKind
  readonly schema: Readonly<Record<string, unknown>>
}

type AgentBrowserCommandToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string }

interface AgentBrowserAgentToolRegistryEntry {
  readonly name: string
  readonly description: string
  readonly action: string
  readonly traceAction: BrowserToolAction
  /** Exact v0.36 daemon action used by the private default-deny policy. */
  readonly daemonAction: string
  readonly parameters: Readonly<Record<string, AgentBrowserToolParameterSpec>>
  /** Trusted static template. Model values can fill parameter slots only. */
  readonly command: ReadonlyArray<AgentBrowserCommandToken>
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

const literal = (value: string): AgentBrowserCommandToken => Object.freeze({ kind: "literal", value })
const parameter = (name: string): AgentBrowserCommandToken => Object.freeze({ kind: "parameter", name })

const TARGET_URL_PARAMETER = deepFreeze({
  kind: "target_url",
  schema: { type: "string", minLength: 1, maxLength: 8_192 }
} as const)
const SELECTOR_PARAMETER = deepFreeze({
  kind: "selector",
  schema: { type: "string", minLength: 1, maxLength: 2_048, pattern: "^(?!-)[^\\u0000-\\u001f\\u007f]+$" }
} as const)
const WAIT_SELECTOR_PARAMETER = deepFreeze({
  kind: "wait_selector",
  // v0.36 parses a decimal-looking first `wait` operand as milliseconds.
  schema: { type: "string", minLength: 1, maxLength: 2_048, pattern: "^(?!\\+?[0-9]+$)(?!-)[^\\u0000-\\u001f\\u007f]+$" }
} as const)
const VALUE_PARAMETER = deepFreeze({
  kind: "value",
  schema: { type: "string", minLength: 1, maxLength: 8_192, pattern: "^(?!-)[^\\u0000-\\u001f\\u007f]+$" }
} as const)
const KEY_PARAMETER = deepFreeze({
  kind: "key",
  schema: { type: "string", pattern: "^[A-Za-z0-9+]{1,128}$" }
} as const)
const DIRECTION_PARAMETER = deepFreeze({
  kind: "direction",
  schema: { type: "string", enum: ["up", "down", "left", "right"] }
} as const)
const PIXELS_PARAMETER = deepFreeze({
  kind: "pixels",
  schema: { type: "integer", minimum: 1, maximum: 10_000 }
} as const)
const MILLISECONDS_PARAMETER = deepFreeze({
  kind: "milliseconds",
  schema: { type: "integer", minimum: 1, maximum: 30_000 }
} as const)
const ATTRIBUTE_NAME_PARAMETER = deepFreeze({
  kind: "attribute_name",
  schema: { type: "string", pattern: "^[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$" }
} as const)
const TAB_ID_PARAMETER = deepFreeze({
  kind: "tab_id",
  schema: { type: "string", pattern: "^t[1-9][0-9]{0,5}$" }
} as const)

/**
 * The single reviewed source of truth for model discovery, strict decoding,
 * fixed argv rendering, trace aliases, and the private daemon allowlist.
 * `wait` is deliberately split into two tools so every offered function has
 * one exact parameter object rather than an optional/ambiguous overload.
 */
const AGENT_BROWSER_AGENT_TOOL_REGISTRY = deepFreeze([
  {
    name: "agent_browser_navigate",
    description: "Navigate the current tab to an allowlisted HTTP or HTTPS URL.",
    action: "navigate", traceAction: "navigate", daemonAction: "navigate",
    parameters: { url: TARGET_URL_PARAMETER },
    command: [literal("open"), parameter("url")]
  },
  {
    name: "agent_browser_snapshot",
    description: "Return an interactive accessibility snapshot of the current page.",
    action: "snapshot", traceAction: "snapshot", daemonAction: "snapshot",
    parameters: {}, command: [literal("snapshot"), literal("-i")]
  },
  {
    name: "agent_browser_click", description: "Click one element selected by a bounded selector.",
    action: "click", traceAction: "click", daemonAction: "click",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("click"), parameter("selector")]
  },
  {
    name: "agent_browser_dblclick", description: "Double-click one element selected by a bounded selector.",
    action: "dblclick", traceAction: "dblclick", daemonAction: "dblclick",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("dblclick"), parameter("selector")]
  },
  {
    name: "agent_browser_hover", description: "Hover over one element selected by a bounded selector.",
    action: "hover", traceAction: "hover", daemonAction: "hover",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("hover"), parameter("selector")]
  },
  {
    name: "agent_browser_check", description: "Check one checkbox selected by a bounded selector.",
    action: "check", traceAction: "check", daemonAction: "check",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("check"), parameter("selector")]
  },
  {
    name: "agent_browser_uncheck", description: "Uncheck one checkbox selected by a bounded selector.",
    action: "uncheck", traceAction: "uncheck", daemonAction: "uncheck",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("uncheck"), parameter("selector")]
  },
  {
    name: "agent_browser_scrollintoview", description: "Scroll one selected element into view.",
    action: "scrollintoview", traceAction: "scrollintoview", daemonAction: "scrollintoview",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("scrollintoview"), parameter("selector")]
  },
  {
    name: "agent_browser_fill", description: "Replace the contents of one selected form control.",
    action: "fill", traceAction: "fill", daemonAction: "fill",
    parameters: { selector: SELECTOR_PARAMETER, value: VALUE_PARAMETER },
    command: [literal("fill"), parameter("selector"), parameter("value")]
  },
  {
    name: "agent_browser_type", description: "Type bounded text into one selected form control.",
    action: "type", traceAction: "type", daemonAction: "type",
    parameters: { selector: SELECTOR_PARAMETER, value: VALUE_PARAMETER },
    command: [literal("type"), parameter("selector"), parameter("value")]
  },
  {
    name: "agent_browser_select", description: "Select one option value in a selected control.",
    action: "select", traceAction: "select", daemonAction: "select",
    parameters: { selector: SELECTOR_PARAMETER, value: VALUE_PARAMETER },
    command: [literal("select"), parameter("selector"), parameter("value")]
  },
  {
    name: "agent_browser_press", description: "Press one bounded key or key combination.",
    action: "press", traceAction: "press", daemonAction: "press",
    parameters: { key: KEY_PARAMETER }, command: [literal("press"), parameter("key")]
  },
  {
    name: "agent_browser_scroll", description: "Scroll the page in one direction by a bounded pixel count.",
    action: "scroll", traceAction: "scroll", daemonAction: "scroll",
    parameters: { direction: DIRECTION_PARAMETER, pixels: PIXELS_PARAMETER },
    command: [literal("scroll"), parameter("direction"), parameter("pixels")]
  },
  {
    name: "agent_browser_wait_for_selector", description: "Wait for one bounded selector.",
    action: "wait", traceAction: "wait", daemonAction: "wait",
    parameters: { selector: WAIT_SELECTOR_PARAMETER }, command: [literal("wait"), parameter("selector")]
  },
  {
    name: "agent_browser_wait_milliseconds", description: "Wait for a bounded number of milliseconds.",
    action: "wait", traceAction: "wait", daemonAction: "wait",
    parameters: { milliseconds: MILLISECONDS_PARAMETER }, command: [literal("wait"), parameter("milliseconds")]
  },
  {
    name: "agent_browser_get_text", description: "Read the text of one selected element.",
    action: "get_text", traceAction: "gettext", daemonAction: "gettext",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("get"), literal("text"), parameter("selector")]
  },
  {
    name: "agent_browser_get_value", description: "Read the current value of one selected form control.",
    action: "get_value", traceAction: "inputvalue", daemonAction: "inputvalue",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("get"), literal("value"), parameter("selector")]
  },
  {
    name: "agent_browser_get_count", description: "Count elements matching one bounded selector.",
    action: "get_count", traceAction: "count", daemonAction: "count",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("get"), literal("count"), parameter("selector")]
  },
  {
    name: "agent_browser_is_visible", description: "Check whether one selected element is visible.",
    action: "is_visible", traceAction: "isvisible", daemonAction: "isvisible",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("is"), literal("visible"), parameter("selector")]
  },
  {
    name: "agent_browser_is_enabled", description: "Check whether one selected element is enabled.",
    action: "is_enabled", traceAction: "isenabled", daemonAction: "isenabled",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("is"), literal("enabled"), parameter("selector")]
  },
  {
    name: "agent_browser_is_checked", description: "Check whether one selected checkbox is checked.",
    action: "is_checked", traceAction: "ischecked", daemonAction: "ischecked",
    parameters: { selector: SELECTOR_PARAMETER }, command: [literal("is"), literal("checked"), parameter("selector")]
  },
  {
    name: "agent_browser_get_attribute", description: "Read one named attribute from a selected element.",
    action: "get_attribute", traceAction: "getattribute", daemonAction: "getattribute",
    parameters: { selector: SELECTOR_PARAMETER, name: ATTRIBUTE_NAME_PARAMETER },
    command: [literal("get"), literal("attr"), parameter("selector"), parameter("name")]
  },
  {
    name: "agent_browser_title", description: "Read the current page title.",
    action: "title", traceAction: "title", daemonAction: "title", parameters: {},
    command: [literal("get"), literal("title")]
  },
  {
    name: "agent_browser_url", description: "Read the current page URL.",
    action: "url", traceAction: "url", daemonAction: "url", parameters: {},
    command: [literal("get"), literal("url")]
  },
  {
    name: "agent_browser_back", description: "Navigate the current tab backward once.",
    action: "back", traceAction: "back", daemonAction: "back", parameters: {}, command: [literal("back")]
  },
  {
    name: "agent_browser_forward", description: "Navigate the current tab forward once.",
    action: "forward", traceAction: "forward", daemonAction: "forward", parameters: {}, command: [literal("forward")]
  },
  {
    name: "agent_browser_reload", description: "Reload the current page.",
    action: "reload", traceAction: "reload", daemonAction: "reload", parameters: {}, command: [literal("reload")]
  },
  {
    name: "agent_browser_tab_list", description: "List the tabs in the isolated browser session.",
    action: "tab_list", traceAction: "tab_list", daemonAction: "tab_list", parameters: {}, command: [literal("tab")]
  },
  {
    name: "agent_browser_tab_switch", description: "Switch to one tab returned by the tab-list tool.",
    action: "tab_switch", traceAction: "tab_switch", daemonAction: "tab_switch",
    parameters: { tabId: TAB_ID_PARAMETER }, command: [literal("tab"), parameter("tabId")]
  }
] as const satisfies ReadonlyArray<AgentBrowserAgentToolRegistryEntry>)

type AgentBrowserParameterValue<P> = P extends { readonly kind: "pixels" | "milliseconds" } ? number : string
type AgentBrowserActionForDescriptor<D> = D extends { readonly action: infer A extends string; readonly parameters: infer P }
  ? { readonly action: A } & { readonly [K in keyof P]: AgentBrowserParameterValue<P[K]> }
  : never

export type AgentBrowserAgentAction = AgentBrowserActionForDescriptor<(typeof AGENT_BROWSER_AGENT_TOOL_REGISTRY)[number]>

export const AGENT_BROWSER_AGENT_TOOL_SCHEMA_VERSION = "agent-browser-agent-tools/1" as const

export interface AgentBrowserAgentToolDescriptor {
  readonly name: string
  readonly description: string
  readonly action: AgentBrowserAgentAction["action"]
  readonly traceAction: BrowserToolAction
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface AgentBrowserAgentToolDefinition {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description: string
    readonly strict: true
    readonly parameters: Readonly<Record<string, unknown>>
  }
}

const modelParametersOf = (entry: AgentBrowserAgentToolRegistryEntry): Readonly<Record<string, unknown>> => deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(Object.entries(entry.parameters).map(([name, spec]) => [name, spec.schema])),
  required: Object.keys(entry.parameters)
})

/** Safe discovery projection; fixed argv templates and policy internals stay private. */
export const AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS: ReadonlyArray<AgentBrowserAgentToolDescriptor> = deepFreeze(
  AGENT_BROWSER_AGENT_TOOL_REGISTRY.map((entry) => ({
    name: entry.name,
    description: entry.description,
    action: entry.action,
    traceAction: entry.traceAction,
    parameters: modelParametersOf(entry)
  }))
)

export const AGENT_BROWSER_AGENT_TOOL_DEFINITIONS: ReadonlyArray<AgentBrowserAgentToolDefinition> = deepFreeze(
  AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS.map((descriptor) => ({
    type: "function" as const,
    function: {
      name: descriptor.name,
      description: descriptor.description,
      strict: true as const,
      parameters: descriptor.parameters
    }
  }))
)

/** Legacy direct-action schema retained for typed programmatic callers, not offered to the model. */
export const AGENT_BROWSER_AGENT_ACTION_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze({
  oneOf: AGENT_BROWSER_AGENT_TOOL_REGISTRY.map((entry) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      action: { const: entry.action },
      ...Object.fromEntries(Object.entries(entry.parameters).map(([name, spec]) => [name, spec.schema]))
    },
    required: ["action", ...Object.keys(entry.parameters)]
  }))
})

export const AGENT_BROWSER_AGENT_DAEMON_ACTIONS: ReadonlyArray<string> = deepFreeze(
  [...new Set(AGENT_BROWSER_AGENT_TOOL_REGISTRY.map((entry) => entry.daemonAction))].sort()
)

export interface AgentBrowserAgentActionResult {
  readonly action: BrowserToolAction
  /** Transient model context. Callers must never append this value to a log. */
  readonly output: unknown
}

export interface AgentBrowserCallWindow {
  readonly callId: string
  readonly action: BrowserToolAction
  readonly startedAtMs: number
  readonly endedAtMs?: number
  readonly direct: boolean
  readonly resultObserved: boolean
}

interface JsonEnvelope {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: unknown
}

interface ProcessOutcome {
  readonly exitCode: number
  readonly value?: Record<string, unknown>
  readonly failure?: AgentBrowserClientError
}

interface DirectAttempt {
  readonly action: BrowserToolAction
  readonly commandObserved: Promise<void>
  readonly resolveCommandObserved: () => void
  callId?: string
  settled?: boolean
  trustedSuccess?: boolean
  pendingResult?: PendingResult
}

interface PendingResult {
  readonly action: BrowserToolAction
  readonly shape: BrowserPayloadShape
  readonly durationMs?: number
  readonly endedAtMs: number
}

interface MutableCallWindow {
  readonly callId: string
  readonly action: BrowserToolAction
  readonly startedAtMs: number
  readonly direct: boolean
  readonly receiptOrder: number
  endedAtMs?: number
  resultObserved: boolean
}

interface PairedCall {
  readonly callId: string
  readonly action: BrowserToolAction
}

interface CancellableDeadline {
  readonly elapsed: Promise<void>
  cancel(): void
}

const cancellableDeadline = (milliseconds: number): CancellableDeadline => {
  let handle: ReturnType<typeof setTimeout> | undefined
  const elapsed = new Promise<void>((resolveElapsed) => {
    handle = setTimeout(() => {
      handle = undefined
      resolveElapsed()
    }, milliseconds)
  })
  return {
    elapsed,
    cancel() {
      if (handle === undefined) return
      clearTimeout(handle)
      handle = undefined
    }
  }
}

type DeadlineOutcome<T> =
  | { readonly timedOut: false; readonly value: T }
  | { readonly timedOut: true }

const withDeadline = async <T>(work: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<DeadlineOutcome<T>> => {
  const deadline = Number.isFinite(milliseconds) ? cancellableDeadline(milliseconds) : undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false, value }) as const),
      ...(deadline ? [deadline.elapsed.then(() => ({ timedOut: true }) as const)] : []),
      ...(signal ? [new Promise<never>((_, reject) => {
        onAbort = () => reject(new AgentBrowserClientError("cancelled", "The browser action was cancelled"))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      })] : [])
    ])
  } finally {
    deadline?.cancel()
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

const defaultSpawn: AgentBrowserSpawn = (argv, options) => {
  const subprocess = Bun.spawn([...argv], {
    env: { ...options.env },
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe"
  })
  return {
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    ...(options.stdin === "pipe" ? { stdin: subprocess.stdin as AgentBrowserWritable } : {}),
    exited: subprocess.exited,
    kill: (signal) => { subprocess.kill(signal) }
  }
}

const defaultWebSocketFactory: AgentBrowserWebSocketFactory = (url) => new WebSocket(url) as AgentBrowserWebSocket

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const positiveBoundedInteger = (
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = 3_600_000
): number => {
  const resolvedValue = value ?? fallback
  if (!Number.isSafeInteger(resolvedValue) || resolvedValue < 1 || resolvedValue > maximum) {
    throw new AgentBrowserClientError("invalid_configuration", `${name} is outside its bounded range`)
  }
  return resolvedValue
}

const opaqueId = (value: string, name: string): string => {
  if (!OPAQUE_ID.test(value)) {
    throw new AgentBrowserClientError("invalid_configuration", `${name} must be an opaque identifier`)
  }
  return value
}

const validHostname = (hostname: string): boolean => {
  if (hostname === "localhost") return true
  if (IPV4.test(hostname)) {
    return hostname.split(".").every((part) => {
      const octet = Number(part)
      return Number.isInteger(octet) && octet >= 0 && octet <= 255 && String(octet) === String(Number(part))
    })
  }
  const labels = hostname.split(".")
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label))
}

export const normalizeAgentBrowserAllowedDomains = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    throw new AgentBrowserClientError("invalid_configuration", "At least one bounded allowed domain is required")
  }
  if (values.length === 1 && values[0] === "*") return Object.freeze(["*"])
  const normalized = values.map((raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 253 || raw !== raw.trim()) {
      throw new AgentBrowserClientError("invalid_configuration", "An allowed domain is malformed")
    }
    const lower = raw.toLowerCase()
    const wildcard = lower.startsWith("*.")
    const hostname = wildcard ? lower.slice(2) : lower
    if (!validHostname(hostname) || (wildcard && (hostname === "localhost" || IPV4.test(hostname)))) {
      throw new AgentBrowserClientError("invalid_configuration", "An allowed domain is malformed")
    }
    return wildcard ? `*.${hostname}` : hostname
  })
  return Object.freeze([...new Set(normalized)].sort())
}

export const agentBrowserHostAllowed = (hostname: string, allowedDomains: ReadonlyArray<string>): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/u, "")
  return allowedDomains.some((pattern) => {
    if (pattern === "*") return true // Aiko public mode is enforced independently at the proxy.
    if (!pattern.startsWith("*.")) return host === pattern
    const base = pattern.slice(2)
    return host === base || host.endsWith(`.${base}`)
  })
}

export const validateAgentBrowserTarget = (value: string, allowedDomains: ReadonlyArray<string>): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new AgentBrowserClientError("invalid_target", "The target URL is outside its bounded range")
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AgentBrowserClientError("invalid_target", "The target URL is invalid")
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") {
    throw new AgentBrowserClientError("invalid_target", "The target URL must be credential-free HTTP or HTTPS")
  }
  if (!agentBrowserHostAllowed(parsed.hostname, allowedDomains)) {
    throw new AgentBrowserClientError("invalid_target", "The target host is outside the explicit allowlist")
  }
  return parsed.href
}

const MODEL_ARGUMENT_CONTROL = /[\u0000-\u001f\u007f]/u
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$/u
const KEY_NAME = /^[A-Za-z0-9+]{1,128}$/u
const TAB_ID = /^t[1-9][0-9]{0,5}$/u

const AGENT_BROWSER_AGENT_TOOL_BY_NAME: ReadonlyMap<string, AgentBrowserAgentToolRegistryEntry> = new Map(
  AGENT_BROWSER_AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry] as const)
)

if (AGENT_BROWSER_AGENT_TOOL_BY_NAME.size !== AGENT_BROWSER_AGENT_TOOL_REGISTRY.length) {
  throw new Error("The reviewed agent-browser tool registry contains a duplicate name")
}
const agentActionShapes = new Set<string>()
for (const entry of AGENT_BROWSER_AGENT_TOOL_REGISTRY) {
  const actionShape = `${entry.action}\u0000${Object.keys(entry.parameters).sort().join("\u0000")}`
  if (agentActionShapes.has(actionShape)) {
    throw new Error("The reviewed agent-browser tool registry contains an ambiguous action shape")
  }
  agentActionShapes.add(actionShape)
  for (const token of entry.command) {
    if (token.kind === "parameter" && !(token.name in entry.parameters)) {
      throw new Error("The reviewed agent-browser tool registry contains an unknown command parameter")
    }
  }
}

const hasExactKeys = (record: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

const safeModelArgument = (value: unknown, name: string, maximum: number): string => {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim().length === 0 || value.trimStart().startsWith("-") || MODEL_ARGUMENT_CONTROL.test(value)
  ) throw new AgentBrowserClientError("invalid_configuration", `${name} is not a safe bounded positional argument`)
  return value
}

/**
 * Strict runtime decoder for the only model-authored values that may become
 * agent-browser argv. Unknown fields/actions and flag-looking positional
 * strings fail before a subprocess can be spawned.
 */
export const agentBrowserAgentActionOf = (
  value: unknown,
  allowedDomains: ReadonlyArray<string>
): AgentBrowserAgentAction => {
  const record = recordOf(value)
  if (record === undefined || typeof record.action !== "string") {
    throw new AgentBrowserClientError("invalid_configuration", "The browser-agent action is invalid")
  }

  const descriptor = AGENT_BROWSER_AGENT_TOOL_REGISTRY.find((candidate) =>
    candidate.action === record.action &&
    hasExactKeys(record, ["action", ...Object.keys(candidate.parameters)])
  )
  if (descriptor === undefined) {
    throw new AgentBrowserClientError("invalid_configuration", "The browser-agent action is outside the strict schema")
  }

  const decoded: Record<string, unknown> = { action: descriptor.action }
  for (const [name, spec] of Object.entries(descriptor.parameters)) {
    const input = record[name]
    switch (spec.kind) {
      case "target_url":
        decoded[name] = validateAgentBrowserTarget(safeModelArgument(input, "navigation URL", 8_192), allowedDomains)
        break
      case "selector":
        decoded[name] = safeModelArgument(input, "selector", 2_048)
        break
      case "wait_selector": {
        const selector = safeModelArgument(input, "wait selector", 2_048)
        if (/^\+?[0-9]+$/u.test(selector)) {
          throw new AgentBrowserClientError("invalid_configuration", "The wait selector is ambiguous with a duration")
        }
        decoded[name] = selector
        break
      }
      case "value":
        decoded[name] = safeModelArgument(input, "value", 8_192)
        break
      case "key": {
        const key = safeModelArgument(input, "key", 128)
        if (!KEY_NAME.test(key)) throw new AgentBrowserClientError("invalid_configuration", "The key is invalid")
        decoded[name] = key
        break
      }
      case "direction":
        if (typeof input !== "string" || !["up", "down", "left", "right"].includes(input)) {
          throw new AgentBrowserClientError("invalid_configuration", "The scroll direction is invalid")
        }
        decoded[name] = input
        break
      case "pixels":
        if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 10_000) {
          throw new AgentBrowserClientError("invalid_configuration", "The scroll distance is invalid")
        }
        decoded[name] = input
        break
      case "milliseconds":
        if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 30_000) {
          throw new AgentBrowserClientError("invalid_configuration", "The wait duration is invalid")
        }
        decoded[name] = input
        break
      case "attribute_name": {
        const attributeName = safeModelArgument(input, "attribute name", 128)
        if (!ATTRIBUTE_NAME.test(attributeName)) {
          throw new AgentBrowserClientError("invalid_configuration", "The attribute name is invalid")
        }
        decoded[name] = attributeName
        break
      }
      case "tab_id": {
        const tabId = safeModelArgument(input, "tab ID", 16)
        if (!TAB_ID.test(tabId)) throw new AgentBrowserClientError("invalid_configuration", "The tab ID is invalid")
        decoded[name] = tabId
        break
      }
    }
  }
  return Object.freeze(decoded) as AgentBrowserAgentAction
}

export interface AgentBrowserAgentToolCall {
  readonly name: string
  readonly action: AgentBrowserAgentAction
}

/** Decode one exact offered function name and its argument object. */
export const agentBrowserAgentToolCallOf = (
  name: unknown,
  argumentsValue: unknown,
  allowedDomains: ReadonlyArray<string>
): AgentBrowserAgentToolCall => {
  if (typeof name !== "string") {
    throw new AgentBrowserClientError("invalid_configuration", "The browser-agent tool name is invalid")
  }
  const descriptor = AGENT_BROWSER_AGENT_TOOL_BY_NAME.get(name)
  const argumentsRecord = recordOf(argumentsValue)
  if (
    descriptor === undefined || argumentsRecord === undefined ||
    !hasExactKeys(argumentsRecord, Object.keys(descriptor.parameters))
  ) throw new AgentBrowserClientError("invalid_configuration", "The browser-agent tool call is outside the offered schema")

  const candidate: Record<string, unknown> = { action: descriptor.action }
  for (const parameterName of Object.keys(descriptor.parameters)) candidate[parameterName] = argumentsRecord[parameterName]
  return Object.freeze({
    name: descriptor.name,
    action: agentBrowserAgentActionOf(candidate, allowedDomains)
  })
}

const commandOfAgentAction = (action: AgentBrowserAgentAction): {
  readonly traceAction: BrowserToolAction
  readonly args: ReadonlyArray<string>
} => {
  const record = action as unknown as Record<string, unknown>
  const descriptor = AGENT_BROWSER_AGENT_TOOL_REGISTRY.find((candidate) =>
    candidate.action === action.action && hasExactKeys(record, ["action", ...Object.keys(candidate.parameters)])
  )
  if (descriptor === undefined) {
    throw new AgentBrowserClientError("invalid_configuration", "The browser-agent action has no reviewed command mapping")
  }
  return Object.freeze({
    traceAction: descriptor.traceAction,
    args: Object.freeze(descriptor.command.map((token) =>
      token.kind === "literal" ? token.value : String(record[token.name])
    ))
  })
}

export const isolatedAgentBrowserEnvironment = (
  inherited: Readonly<Record<string, string | undefined>>,
  isolation: AgentBrowserIsolation
): Readonly<Record<string, string>> => {
  const allowedDomains = normalizeAgentBrowserAllowedDomains(isolation.allowedDomains)
  opaqueId(isolation.session, "session")
  opaqueId(isolation.namespace, "namespace")
  if (
    !isAbsolute(isolation.configPath) ||
    !isAbsolute(isolation.actionPolicyPath) ||
    !isAbsolute(isolation.socketDirectory) ||
    !isAbsolute(isolation.temporaryDirectory)
  ) {
    throw new AgentBrowserClientError("invalid_configuration", "Isolation paths must be absolute")
  }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (PASSTHROUGH_ENV.has(name) && value !== undefined) env[name] = value
  }
  const idleTimeoutMs = positiveBoundedInteger(isolation.idleTimeoutMs, 300_000, "idle timeout")
  env.AGENT_BROWSER_CONFIG = resolve(isolation.configPath)
  env.AGENT_BROWSER_ACTION_POLICY = resolve(isolation.actionPolicyPath)
  env.AGENT_BROWSER_SOCKET_DIR = resolve(isolation.socketDirectory)
  env.TEMP = resolve(isolation.temporaryDirectory)
  env.TMP = resolve(isolation.temporaryDirectory)
  env.TMPDIR = resolve(isolation.temporaryDirectory)
  env.AGENT_BROWSER_NAMESPACE = isolation.namespace
  env.AGENT_BROWSER_SESSION = isolation.session
  if (allowedDomains.includes("*")) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(isolation.publicProxy ?? "") || Number(isolation.publicProxy?.split(":").at(-1)) > 65535) {
      throw new AgentBrowserClientError("invalid_configuration", "Public browsing requires the host filtering proxy")
    }
  } else env.AGENT_BROWSER_ALLOWED_DOMAINS = allowedDomains.join(",")
  if (isolation.publicProxy) {
    env.AGENT_BROWSER_PROXY = isolation.publicProxy
    env.AGENT_BROWSER_PROXY_BYPASS = "<-loopback>"
  }
  env.AGENT_BROWSER_PIN_TAB = "1"
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(idleTimeoutMs)
  env.AGENT_BROWSER_CONTENT_BOUNDARIES = "1"
  env.AGENT_BROWSER_MAX_OUTPUT = String(ISOLATED_MAX_OUTPUT_CHARS)
  return Object.freeze(env)
}

const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) throw new AgentBrowserClientError("output_limit", "Agent-browser output exceeded its byte limit")
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new AgentBrowserClientError("invalid_json", "Agent-browser output is not valid UTF-8")
  }
}

const parseSingleJsonObject = (bytes: Uint8Array): Record<string, unknown> => {
  const text = decodeUtf8(bytes).trim()
  if (text.length === 0) throw new AgentBrowserClientError("invalid_json", "Agent-browser returned no JSON object")
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new AgentBrowserClientError("invalid_json", "Agent-browser returned malformed JSON")
  }
  const record = recordOf(parsed)
  if (record === undefined) throw new AgentBrowserClientError("invalid_json", "Agent-browser returned a non-object JSON value")
  return record
}

const envelopeOf = (value: Record<string, unknown>): JsonEnvelope => {
  if (typeof value.success !== "boolean") {
    throw new AgentBrowserClientError("invalid_response", "Agent-browser returned an invalid response envelope")
  }
  return {
    success: value.success,
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
    ...(Object.hasOwn(value, "error") ? { error: value.error } : {})
  }
}

const streamStatusOf = (value: unknown): AgentBrowserStreamStatus => {
  const data = recordOf(value)
  if (
    data === undefined || typeof data.enabled !== "boolean" || typeof data.connected !== "boolean" ||
    typeof data.screencasting !== "boolean" ||
    !(data.port === null || (Number.isSafeInteger(data.port) && (data.port as number) >= 1 && (data.port as number) <= 65_535))
  ) throw new AgentBrowserClientError("invalid_response", "Agent-browser returned an invalid stream status")
  return Object.freeze({
    enabled: data.enabled,
    connected: data.connected,
    screencasting: data.screencasting,
    port: data.port as number | null
  })
}

const resultEventFromShape = (
  threadId: string,
  sequence: number,
  callId: string,
  pending: PendingResult,
  success: boolean | "unknown"
): BrowserTraceEvent => {
  const event = decodeBrowserTraceEvent({
    type: "BrowserToolResultObserved",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
    threadId,
    sequence,
    callId,
    action: pending.action,
    category: browserToolCategoryOf(pending.action),
    success,
    ...(pending.durationMs === undefined ? {} : { durationMs: pending.durationMs }),
    result: pending.shape
  })
  if (event === undefined) throw new AgentBrowserClientError("telemetry_incomplete", "Sanitized browser result was invalid")
  return event
}

export class AgentBrowserClient {
  private readonly options: AgentBrowserClientOptions
  private readonly argvPrefix: ReadonlyArray<string>
  private readonly env: Readonly<Record<string, string>>
  private readonly spawn: AgentBrowserSpawn
  private readonly makeWebSocket: AgentBrowserWebSocketFactory
  private readonly now: () => number
  private readonly controlTimeoutMs: number
  private readonly killGraceMs: number
  private readonly stdoutLimitBytes: number
  private readonly stderrLimitBytes: number
  private readonly telemetryLimitBytes: number
  private readonly verifyExecutable: (() => Promise<void>) | undefined
  private executableVerification: Promise<void> | undefined
  private readonly pendingByUpstream = new Map<string, PairedCall[]>()
  private readonly windows = new Map<string, MutableCallWindow>()
  private readonly directAttempts: DirectAttempt[] = []
  private socket: AgentBrowserWebSocket | undefined
  private connected = false
  private expectedSocketClose = false
  private traceHealthy = true
  private receiptOrder = 0
  private telemetryRecordCount = 0
  private telemetryByteCount = 0
  private publishedTraceEventCount = 0

  constructor(options: AgentBrowserClientOptions) {
    this.options = options
    opaqueId(options.trace.threadId, "trace thread")
    const globalArgs = [
      "--json",
      "--session",
      opaqueId(options.isolation.session, "session"),
      "--namespace",
      opaqueId(options.isolation.namespace, "namespace"),
      "--no-webmcp"
    ] as const
    if (options.spawn === undefined) {
      if (options.executablePath !== undefined || options.nodeExecutable !== undefined) {
        throw new AgentBrowserClientError(
          "invalid_configuration",
          "Custom agent-browser launchers require an explicit trusted spawn adapter"
        )
      }
      const asset = pinnedAgentBrowserAssetFor()
      const executablePath = pinnedAgentBrowserExecutablePath(asset)
      // Invoke the verified native asset directly. The upstream JavaScript
      // wrapper is intentionally bypassed because it does not verify its
      // postinstall-downloaded executable.
      this.argvPrefix = Object.freeze([executablePath, ...globalArgs])
      this.verifyExecutable = async () => { await verifyPinnedAgentBrowserExecutable(executablePath, asset) }
    } else {
      // Injected spawn is an explicit trusted adapter/test seam. Preserve the
      // wrapper-shaped argv contract so adapters never execute a local binary.
      const executablePath = resolve(options.executablePath ?? resolve(
        import.meta.dir,
        "..",
        "node_modules",
        "agent-browser",
        "bin",
        "agent-browser.js"
      ))
      this.argvPrefix = Object.freeze([options.nodeExecutable ?? "node", executablePath, ...globalArgs])
      this.verifyExecutable = undefined
    }
    this.env = isolatedAgentBrowserEnvironment(options.env ?? process.env, options.isolation)
    this.spawn = options.spawn ?? defaultSpawn
    this.makeWebSocket = options.webSocketFactory ?? defaultWebSocketFactory
    this.now = options.now ?? Date.now
    this.controlTimeoutMs = positiveBoundedInteger(options.controlTimeoutMs, DEFAULT_CONTROL_TIMEOUT_MS, "control timeout")
    this.killGraceMs = positiveBoundedInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS, "kill grace")
    this.stdoutLimitBytes = positiveBoundedInteger(options.stdoutLimitBytes, DEFAULT_STDOUT_LIMIT, "stdout limit")
    this.stderrLimitBytes = positiveBoundedInteger(options.stderrLimitBytes, DEFAULT_STDERR_LIMIT, "stderr limit")
    this.telemetryLimitBytes = positiveBoundedInteger(
      options.telemetryLimitBytes,
      DEFAULT_TELEMETRY_LIMIT_BYTES,
      "telemetry byte limit",
      MAX_TELEMETRY_LIMIT_BYTES
    )
  }

  get telemetryComplete(): boolean {
    return this.traceHealthy && [...this.windows.values()].every((window) => window.resultObserved)
  }

  get telemetryReady(): boolean {
    return this.connected && this.socket !== undefined && this.telemetryComplete
  }

  get callWindows(): ReadonlyArray<AgentBrowserCallWindow> {
    return Object.freeze([...this.windows.values()]
      .sort((left, right) => left.receiptOrder - right.receiptOrder)
      .map((window) => Object.freeze({
        callId: window.callId,
        action: window.action,
        startedAtMs: window.startedAtMs,
        ...(window.endedAtMs === undefined ? {} : { endedAtMs: window.endedAtMs }),
        direct: window.direct,
        resultObserved: window.resultObserved
      })))
  }

  private commandArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
    return Object.freeze([...this.argvPrefix, ...args])
  }

  private async ensureExecutableIntegrity(): Promise<void> {
    if (this.verifyExecutable === undefined) return
    this.executableVerification ??= this.verifyExecutable()
    await this.executableVerification
  }

  private async terminate(child: AgentBrowserSubprocess): Promise<void> {
    try { child.kill("SIGTERM") } catch {}
    const exitedAfterTerm = await withDeadline(child.exited.then(() => undefined, () => undefined), this.killGraceMs)
    if (exitedAfterTerm.timedOut) {
      try { child.kill("SIGKILL") } catch {}
      // A broken subprocess adapter must not hold trusted-controller cleanup
      // forever, even after SIGKILL. Real OS children normally settle here.
      await withDeadline(child.exited.then(() => undefined, () => undefined), this.killGraceMs)
    }
  }

  private async runProcess(
    args: ReadonlyArray<string>,
    deadlineAt: number,
    signal?: AbortSignal
  ): Promise<ProcessOutcome> {
    try {
      const integrityRemainingMs = Math.max(0, Math.floor(Math.min(this.controlTimeoutMs, deadlineAt - performance.now())))
      if (integrityRemainingMs < 1) {
        return { exitCode: -1, failure: new AgentBrowserClientError("process_timeout", "Agent-browser exceeded its deadline") }
      }
      const integrity = await withDeadline(this.ensureExecutableIntegrity(), integrityRemainingMs, signal)
      if (integrity.timedOut) {
        return { exitCode: -1, failure: new AgentBrowserClientError("process_timeout", "Agent-browser exceeded its deadline") }
      }
    } catch (error) {
      return {
        exitCode: -1,
        failure: error instanceof AgentBrowserClientError
          ? error
          : new AgentBrowserClientError("invalid_configuration", "Agent-browser executable verification failed")
      }
    }
    let child: AgentBrowserSubprocess
    try {
      if (signal?.aborted) return { exitCode: -1, failure: new AgentBrowserClientError("cancelled", "The browser action was cancelled") }
      child = this.spawn(this.commandArgs(args), { env: this.env, stdin: "ignore" })
    } catch {
      return { exitCode: -1, failure: new AgentBrowserClientError("process_failed", "Agent-browser could not be started") }
    }

    const completed = Promise.all([
      readBounded(child.stdout, this.stdoutLimitBytes),
      readBounded(child.stderr, this.stderrLimitBytes),
      child.exited
    ])
    try {
      const processRemainingMs = Math.max(0, Math.floor(deadlineAt - performance.now()))
      const deadlineOutcome = processRemainingMs < 1
        ? { timedOut: true } as const
        : await withDeadline(completed, processRemainingMs, signal)
      if (deadlineOutcome.timedOut) {
        await this.terminate(child)
        return { exitCode: -1, failure: new AgentBrowserClientError("process_timeout", "Agent-browser exceeded its deadline") }
      }
      const outcome = deadlineOutcome.value
      const [stdout, _stderr, exitCode] = outcome
      let value: Record<string, unknown>
      try {
        value = parseSingleJsonObject(stdout)
      } catch (error) {
        return {
          exitCode,
          failure: error instanceof AgentBrowserClientError
            ? error
            : new AgentBrowserClientError("invalid_json", "Agent-browser returned invalid JSON")
        }
      }
      return { exitCode, value }
    } catch (error) {
      await this.terminate(child)
      return {
        exitCode: -1,
        failure: error instanceof AgentBrowserClientError
          ? error
          : new AgentBrowserClientError("process_failed", "Agent-browser process I/O failed")
      }
    }
  }

  private publish(event: BrowserTraceEvent): boolean {
    if (this.publishedTraceEventCount >= MAX_BROWSER_TRACE_EVENTS) {
      this.traceHealthy = false
      return false
    }
    try {
      this.options.trace.publish(event)
      this.publishedTraceEventCount += 1
      return true
    } catch {
      this.traceHealthy = false
      return false
    }
  }

  private publishPending(callId: string, pending: PendingResult, success: boolean | "unknown"): boolean {
    const window = this.windows.get(callId)
    if (window === undefined || window.resultObserved) {
      this.traceHealthy = false
      return false
    }
    const event = resultEventFromShape(
      this.options.trace.threadId,
      this.options.trace.nextSequence(),
      callId,
      pending,
      success
    )
    if (!this.publish(event)) return false
    window.endedAtMs = pending.endedAtMs
    window.resultObserved = true
    return true
  }

  private directAttemptForCall(callId: string): DirectAttempt | undefined {
    return this.directAttempts.find((attempt) => attempt.callId === callId)
  }

  private async settleDirect(
    attempt: DirectAttempt,
    trustedSuccess: boolean,
    responseData: unknown,
    timeoutMs: number
  ): Promise<void> {
    attempt.settled = true
    attempt.trustedSuccess = trustedSuccess
    if (attempt.callId === undefined) {
      if (timeoutMs <= 0) {
        this.failTelemetry("direct telemetry timeout")
        throw new AgentBrowserClientError(
          "telemetry_incomplete",
          "Agent-browser did not emit the reviewed action before its telemetry deadline"
        )
      }
      const observed = await withDeadline(
        attempt.commandObserved,
        Math.min(timeoutMs, MAX_DIRECT_TELEMETRY_SETTLEMENT_MS)
      )
      if (observed.timedOut || attempt.callId === undefined) {
        this.failTelemetry("direct telemetry timeout")
        throw new AgentBrowserClientError(
          "telemetry_incomplete",
          "Agent-browser did not emit the reviewed action before its telemetry deadline"
        )
      }
    }
    const window = this.windows.get(attempt.callId)
    if (window?.resultObserved === true) return
    const pending = attempt.pendingResult ?? {
      action: attempt.action,
      shape: browserToolResultShapeOf(responseData),
      endedAtMs: this.now()
    }
    if (!this.publishPending(attempt.callId, pending, trustedSuccess)) {
      this.failTelemetry("telemetry publication")
      throw new AgentBrowserClientError("telemetry_incomplete", "Sanitized browser result could not be published")
    }
    delete attempt.pendingResult
  }

  private finalizeDirectResults(): void {
    for (const attempt of this.directAttempts) {
      if (attempt.callId === undefined || attempt.settled !== true) continue
      const window = this.windows.get(attempt.callId)
      if (window === undefined || window.resultObserved) continue
      if (!this.publishPending(attempt.callId, {
        action: attempt.action,
        shape: browserPayloadShapeOf(undefined),
        endedAtMs: this.now()
      }, attempt.trustedSuccess ?? false)) this.failTelemetry("telemetry event limit")
    }
  }

  private advanceTraceWindow(): void {
    if (!this.options.rollingTrace || !this.traceHealthy ||
        this.directAttempts.some((attempt) => !attempt.settled) ||
        [...this.windows.values()].some((window) => !window.resultObserved)) return
    // Keep correlation for late WebSocket results, even after a direct envelope
    // settled the canonical outcome. Missing acknowledgements remain bounded.
    const pending = new Set([...this.pendingByUpstream.values()].flatMap((queue) => queue.map((call) => call.callId)))
    const retired = new Set<string>()
    for (const [id, window] of this.windows) {
      if (window.resultObserved && !pending.has(id)) {
        this.windows.delete(id)
        retired.add(id)
      }
    }
    for (let i = this.directAttempts.length - 1; i >= 0; i--) {
      const id = this.directAttempts[i]!.callId
      if (id !== undefined && retired.has(id)) this.directAttempts.splice(i, 1)
    }
    // Flood/byte limits apply between settled commands, not cumulatively over
    // a healthy session. Published event sequence/call IDs never reset.
    this.telemetryRecordCount = 0
    this.telemetryByteCount = 0
    this.publishedTraceEventCount = 0
  }

  private async runEnvelope(
    args: ReadonlyArray<string>,
    timeoutMs: number | null,
    directAction?: BrowserToolAction,
    signal?: AbortSignal
  ): Promise<JsonEnvelope & { readonly raw: Record<string, unknown> }> {
    this.advanceTraceWindow()
    const deadlineAt = timeoutMs === null ? Number.POSITIVE_INFINITY : performance.now() + timeoutMs
    let attempt: DirectAttempt | undefined
    if (directAction !== undefined && this.connected) {
      let resolveCommandObserved!: () => void
      const commandObserved = new Promise<void>((resolveObserved) => { resolveCommandObserved = resolveObserved })
      attempt = { action: directAction, commandObserved, resolveCommandObserved }
    }
    if (attempt !== undefined) {
      if (this.directAttempts.length >= MAX_BROWSER_TRACE_CALLS) {
        this.failTelemetry("telemetry call limit")
        throw new AgentBrowserClientError("telemetry_incomplete", "Browser telemetry exceeded its call limit")
      }
      this.directAttempts.push(attempt)
    }
    const outcome = await this.runProcess(args, deadlineAt, signal)
    if (outcome.failure?.code === "cancelled" && attempt?.callId === undefined) {
      // Nothing was observed as executed. Preserve Stop, rather than turning
      // pre-command cancellation into a missing-telemetry error.
      if (attempt) this.directAttempts.splice(this.directAttempts.indexOf(attempt), 1)
      throw outcome.failure
    }
    let envelope: JsonEnvelope | undefined
    let trustedSuccess = false
    if (outcome.value !== undefined) {
      try {
        envelope = envelopeOf(outcome.value)
        trustedSuccess = outcome.exitCode === 0 && envelope.success
      } catch (error) {
        if (attempt !== undefined) {
          const remainingMs = Math.max(0, Math.ceil(deadlineAt - performance.now()))
          await this.settleDirect(attempt, false, undefined, remainingMs)
        }
        throw error
      }
    }
    if (attempt !== undefined) {
      const remainingMs = Math.max(0, Math.ceil(deadlineAt - performance.now()))
      await this.settleDirect(attempt, trustedSuccess, envelope?.data, remainingMs)
    }
    if (outcome.failure !== undefined) throw outcome.failure
    if (envelope === undefined) throw new AgentBrowserClientError("invalid_response", "Agent-browser returned no response envelope")
    if (!trustedSuccess) {
      // Only known native lookup failures on reads are recoverable. Never infer
      // safety from arbitrary error text on a mutation or from WebSocket success.
      if (outcome.exitCode === 1 && envelope.success === false &&
          directAction !== undefined && ["getattribute", "gettext", "inputvalue", "isvisible", "isenabled", "ischecked"].includes(directAction) &&
          typeof envelope.error === "string" && /^(?:Element not found(?: in the selected frame)?: |Unknown ref: )/u.test(envelope.error)) {
        throw new AgentBrowserClientError("element_not_found", "The selected element or snapshot reference was not found")
      }
      throw new AgentBrowserClientError("process_failed", "Agent-browser command failed")
    }
    return { ...envelope, raw: outcome.value! }
  }

  private timestampOf(record: Record<string, unknown>): number {
    const value = record.timestamp
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : this.now()
  }

  private handleCommand(record: Record<string, unknown>): boolean {
    if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256 || typeof record.action !== "string") {
      this.traceHealthy = false
      return true
    }
    if (this.windows.size >= MAX_BROWSER_TRACE_CALLS || this.publishedTraceEventCount >= MAX_BROWSER_TRACE_EVENTS) {
      this.traceHealthy = false
      return false
    }
    const action = browserToolActionOf(record.action)
    const callId = this.options.trace.nextCallId()
    const attempt = this.directAttempts.find((candidate) =>
      candidate.callId === undefined && candidate.action === action)
    const event = browserToolCallEventOf({
      threadId: this.options.trace.threadId,
      sequence: this.options.trace.nextSequence(),
      callId,
      action,
      params: record.params
    })
    if (!this.publish(event)) return false
    if (attempt !== undefined) {
      attempt.callId = callId
      attempt.resolveCommandObserved()
    }
    const key = `${record.id}\u0000${action}`
    const pending = this.pendingByUpstream.get(key) ?? []
    pending.push({ callId, action })
    this.pendingByUpstream.set(key, pending)
    this.windows.set(callId, {
      callId,
      action,
      startedAtMs: this.timestampOf(record),
      direct: attempt !== undefined,
      receiptOrder: this.receiptOrder++,
      resultObserved: false
    })
    return true
  }

  private handleResult(record: Record<string, unknown>): boolean {
    if (
      typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256 ||
      typeof record.action !== "string" || typeof record.success !== "boolean"
    ) {
      this.traceHealthy = false
      return true
    }
    const action = browserToolActionOf(record.action)
    const key = `${record.id}\u0000${action}`
    const queue = this.pendingByUpstream.get(key)
    const paired = queue?.shift()
    if (queue !== undefined && queue.length === 0) this.pendingByUpstream.delete(key)
    if (paired === undefined) {
      this.traceHealthy = false
      return true
    }
    const rawDuration = record.duration_ms
    const durationMs = Number.isSafeInteger(rawDuration) && (rawDuration as number) >= 0 &&
      (rawDuration as number) <= MAX_BROWSER_TOOL_DURATION_MS ? rawDuration as number : undefined
    if (rawDuration !== undefined && durationMs === undefined) this.traceHealthy = false
    const pending: PendingResult = {
      action,
      shape: browserToolResultShapeOf(record.data),
      ...(durationMs === undefined ? {} : { durationMs }),
      endedAtMs: this.timestampOf(record)
    }
    const direct = this.directAttemptForCall(paired.callId)
    const window = this.windows.get(paired.callId)
    // A direct process envelope is independent outcome evidence. If its
    // reduced result was already published, consume but otherwise ignore a
    // later untrusted WebSocket result so it cannot duplicate or poison the
    // canonical call/result pair.
    if (direct?.settled === true && window?.resultObserved === true) return true
    if (direct !== undefined && direct.settled !== true) {
      direct.pendingResult = pending
      return true
    }
    return this.publishPending(paired.callId, pending, direct?.trustedSuccess ?? "unknown")
  }

  private handleMessage(value: unknown, markStatus: () => void): boolean {
    this.telemetryRecordCount += 1
    if (this.telemetryRecordCount > MAX_BROWSER_TRACE_EVENTS) {
      this.traceHealthy = false
      return false
    }
    if (typeof value !== "string") {
      this.traceHealthy = false
      return false
    }
    if (value.length > MAX_BROWSER_RAW_RECORD_CHARS) {
      this.traceHealthy = false
      return false
    }
    const recordBytes = new TextEncoder().encode(value).byteLength
    if (
      recordBytes > MAX_BROWSER_RAW_RECORD_CHARS ||
      recordBytes > this.telemetryLimitBytes - this.telemetryByteCount
    ) {
      this.traceHealthy = false
      return false
    }
    this.telemetryByteCount += recordBytes
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      this.traceHealthy = false
      return true
    }
    const record = recordOf(parsed)
    if (record === undefined) {
      this.traceHealthy = false
      return true
    }
    if (record.type === "status") {
      markStatus()
      return true
    }
    if (record.type === "command") return this.handleCommand(record)
    if (record.type === "result") return this.handleResult(record)
    return true
  }

  private failTelemetry(reason: string): void {
    this.traceHealthy = false
    this.connected = false
    const socket = this.socket
    if (socket === undefined) return
    this.expectedSocketClose = true
    this.socket = undefined
    try { socket.close(1009, reason) } catch {}
  }

  async streamStatus(): Promise<AgentBrowserStreamStatus> {
    const response = await this.runEnvelope(["stream", "status"], this.controlTimeoutMs)
    return streamStatusOf(response.data)
  }

  async streamEnable(): Promise<AgentBrowserStreamStatus> {
    const response = await this.runEnvelope(["stream", "enable"], this.controlTimeoutMs)
    return streamStatusOf(response.data)
  }

  /** Host-only discovery of this isolated browser's observation endpoint. */
  async networkObservationEndpoint(): Promise<string> {
    const response = await this.runEnvelope(["get", "cdp-url"], this.controlTimeoutMs, "cdp_url")
    const endpoint = recordOf(response.data)?.cdpUrl
    if (typeof endpoint !== "string") throw new AgentBrowserClientError("invalid_response", "Browser observation endpoint unavailable")
    return endpoint
  }

  /** Trusted screenshot adapter only. The model cannot select a path or invoke arbitrary commands. */
  async captureScreenshot(path: string, signal?: AbortSignal): Promise<void> {
    const directory = resolve(this.options.isolation.temporaryDirectory)
    if (!isAbsolute(path) || !resolve(path).startsWith(`${directory}/`) || !/\/capture-[a-f0-9-]{36}\.png$/.test(path))
      throw new AgentBrowserClientError("invalid_configuration", "Invalid private screenshot path")
    this.requireAgentTelemetry()
    await this.runEnvelope(["screenshot", path], this.controlTimeoutMs, "screenshot", signal)
    this.requireAgentTelemetry()
  }

  async connectTelemetry(port: number): Promise<void> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || this.socket !== undefined) {
      throw new AgentBrowserClientError("stream_failed", "The stream port is invalid")
    }
    const socket = this.makeWebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=1`)
    this.socket = socket
    this.expectedSocketClose = false
    let opened = false
    let statusSeen = false
    let settled = false
    let resolveReady!: () => void
    let rejectReady!: (error: AgentBrowserClientError) => void
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise
      rejectReady = rejectPromise
    })
    const maybeReady = (): void => {
      if (!settled && opened && statusSeen) {
        settled = true
        this.connected = true
        resolveReady()
      }
    }
    socket.addEventListener("open", () => { opened = true; maybeReady() })
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return
      try {
        if (!this.handleMessage(event.data, () => { statusSeen = true; maybeReady() })) {
          this.failTelemetry("telemetry limit")
        }
      } catch {
        // Trace allocation/publication is controller-owned and may reject a
        // cumulative prefix at its hard bound. Never let that exception escape
        // an adapter event callback; the publisher retains the canonical error.
        this.failTelemetry("telemetry publication")
      }
    })
    socket.addEventListener("error", () => {
      this.traceHealthy = false
      if (!settled) {
        settled = true
        rejectReady(new AgentBrowserClientError("stream_failed", "The telemetry stream failed"))
      }
    })
    socket.addEventListener("close", () => {
      this.connected = false
      if (this.socket === socket) this.socket = undefined
      if (!this.expectedSocketClose) this.traceHealthy = false
      if (!settled) {
        settled = true
        rejectReady(new AgentBrowserClientError("stream_failed", "The telemetry stream closed before it was ready"))
      }
    })
    const readyOutcome = await withDeadline(ready, 5_000)
    if (readyOutcome.timedOut) {
      this.traceHealthy = false
      this.expectedSocketClose = true
      if (this.socket === socket) {
        this.socket = undefined
        socket.close(1000, "handshake timeout")
      }
      throw new AgentBrowserClientError("stream_failed", "The telemetry stream did not become ready")
    }
  }

  disconnectTelemetry(): void {
    if (this.socket === undefined) return
    const socket = this.socket
    try {
      this.finalizeDirectResults()
    } catch {
      // Publication failure is observed again by the controller's publisher
      // flush. It must not prevent socket-scoped daemon cleanup.
      this.traceHealthy = false
    }
    this.expectedSocketClose = true
    this.socket = undefined
    this.connected = false
    try {
      socket.close(1000, "controller cleanup")
    } catch {
      // A broken WebSocket adapter cannot be allowed to skip close --all.
      this.traceHealthy = false
    }
  }

  async harStart(): Promise<void> {
    const response = await this.runEnvelope(["network", "har", "start", "--content", "text"], this.controlTimeoutMs, "har_start")
    const data = recordOf(response.data)
    if (data === undefined || data.started !== true) {
      throw new AgentBrowserClientError("invalid_response", "Agent-browser did not confirm HAR capture")
    }
  }

  async open(target: string, timeoutMs: number | null = this.controlTimeoutMs, signal?: AbortSignal): Promise<void> {
    const allowed = normalizeAgentBrowserAllowedDomains(this.options.isolation.allowedDomains)
    const validatedTarget = validateAgentBrowserTarget(target, allowed)
    await this.runEnvelope(["open", validatedTarget], timeoutMs === null ? null :
      positiveBoundedInteger(timeoutMs, 1, "agent action timeout", 2_147_483_647), "navigate", signal)
  }

  private requireAgentTelemetry(): void {
    if (!this.traceHealthy || !this.connected || this.socket === undefined) {
      throw new AgentBrowserClientError(
        "telemetry_incomplete",
        "A reviewed browser action requires healthy connected telemetry"
      )
    }
  }

  async executeAgentAction(value: unknown, timeoutMs: number | null = this.controlTimeoutMs, signal?: AbortSignal): Promise<AgentBrowserAgentActionResult> {
    const allowedDomains = normalizeAgentBrowserAllowedDomains(this.options.isolation.allowedDomains)
    const action = agentBrowserAgentActionOf(value, allowedDomains)
    const command = commandOfAgentAction(action)
    this.requireAgentTelemetry()
    const actionTimeoutMs = timeoutMs === null ? null :
      positiveBoundedInteger(timeoutMs, 1, "agent action timeout", 2_147_483_647)
    let response: JsonEnvelope
    try { response = await this.runEnvelope(command.args, actionTimeoutMs, command.traceAction, signal) } catch (error) {
      if (error instanceof AgentBrowserClientError && error.code === "cancelled") throw error
      // A failed read may be repaired only while the telemetry channel remains
      // healthy. Disconnection overrides even a known element-lookup error.
      this.requireAgentTelemetry()
      throw error
    }
    this.requireAgentTelemetry()
    return Object.freeze({ action: command.traceAction, output: response.data })
  }

  async harStop(path: string): Promise<AgentBrowserHarStopResult> {
    if (!isAbsolute(path)) throw new AgentBrowserClientError("invalid_configuration", "The HAR path must be absolute")
    const response = await this.runEnvelope(["network", "har", "stop", resolve(path)], this.controlTimeoutMs, "har_stop")
    const data = recordOf(response.data)
    if (
      data === undefined || typeof data.path !== "string" || data.path.length === 0 || data.path.length > 8_192 ||
      !Number.isSafeInteger(data.requestCount) || (data.requestCount as number) < 0
    ) throw new AgentBrowserClientError("invalid_response", "Agent-browser returned an invalid HAR stop result")
    return Object.freeze({ path: data.path, requestCount: data.requestCount as number })
  }

  async closeAll(): Promise<void> {
    await this.runEnvelope(["close", "--all"], this.controlTimeoutMs)
  }
}
