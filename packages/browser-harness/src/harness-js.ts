/**
 * `site-js/1` — real page-JS execution for captured scripts.
 *
 * The bundle is whatever the HAR captured, stored digest-keyed next to its
 * recorded env sidecar (`<digest-hex>.js` + `<digest-hex>.env.json`). The
 * sandbox gets nothing ambient: no Date, no Math.random, no real fetch — only
 * `console`, `TextEncoder/Decoder`, the declared env globals, and one
 * `services` object ({ now, uuid, fetch, log }) supplied by the evaluator.
 *
 * ABI: the bundle assigns
 * `globalThis.harness = { entry: (args, services) => jsonValue | Promise }`.
 * `args` are the producer arguments; the result must be one JSON value — the
 * executor re-bounds it through its normal value checks afterwards.
 */
import vm from "node:vm"
import type {
  ApprovedHarnessJsAdapter,
  HarnessJsonValue,
  HarnessJsServices
} from "./harness-runtime"
import { JS_ENV_MAX_BYTES, readJsModule } from "./harness-modules"

export const JS_TIMEOUT_MS = 250
const JS_ENTRY_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u
const ENV_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u
const ENV_DEPTH = 8
const ENV_NODES = 4_096
const SECRETISH = /(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\bBearer\s+\S+|\b(?:password|passwd)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9_-]{16,})/iu
const RESULT_MARK = "__siteJs"

const countSegments = (path: string): number =>
  path.split(/[.[\]]+/u).filter((part) => part.length > 0).length

const walkEnv = (value: unknown, path: string, budget: { used: number }): void => {
  budget.used += 1
  if (budget.used > ENV_NODES) throw new Error("script env has too many nodes")
  if (typeof value !== "object" || value === null) return
  if (countSegments(path) > ENV_DEPTH) throw new Error("script env is too deep")
  if (Array.isArray(value)) {
    for (const entry of value) walkEnv(entry, `${path}[?]`, budget)
    return
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!ENV_KEY.test(key)) throw new Error(`script env key must be an identifier: ${JSON.stringify(key)}`)
    walkEnv((value as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`, budget)
  }
}

const scanEnv = (env: Readonly<Record<string, unknown>>): void => {
  walkEnv(env, "", { used: 0 })
  const text = JSON.stringify(env)
  if (new TextEncoder().encode(text).length > JS_ENV_MAX_BYTES) throw new Error(`script env exceeds ${JS_ENV_MAX_BYTES} bytes`)
  const match = SECRETISH.exec(text)
  if (match !== null) throw new Error(`script env looks like a credential: ${match[0].slice(0, 48)}`)
}

interface JsBundleInput {
  readonly entry: string
  readonly source: string
  readonly args: ReadonlyArray<HarnessJsonValue>
  readonly env: Readonly<Record<string, unknown>>
  readonly services: HarnessJsServices
}

const bundle = (input: JsBundleInput): Promise<unknown> => {
  const { entry, source, args, env, services } = input
  const argText = JSON.stringify([...args])
  const marker = JSON.stringify(entry)
  const template =
    "(async () => {\n" +
    `  const target = globalThis.harness && globalThis.harness[${marker}];\n` +
    '  if (typeof target !== "function") {\n' +
    `    return { __siteJs: { kind: "entry_error", message: typeof globalThis.harness === "undefined" ? "bundle did not define globalThis.harness.${entry}" : "entry " + ${JSON.stringify(marker)} + " is not a function" } };\n` +
    "  }\n" +
    "  let out;\n" +
    "  try {\n" +
    `    out = target(${argText}, __services);\n` +
    "  } catch (callError) {\n" +
    '    return { __siteJs: { kind: "call_error", message: String(callError && (callError.message || callError)) } };\n' +
    "  }\n" +
    '  return out === undefined ? { __siteJs: { kind: "empty_result" } } : await out;\n' +
    "})()"
  const sandbox: Record<string, unknown> = {
    console: { log: (line: unknown) => services.log(String(line)) },
    TextEncoder,
    TextDecoder,
    __services: services,
    ...(env as Record<string, unknown>)
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  const context = vm.createContext(sandbox)
  try {
    vm.runInContext(source, context, { timeout: JS_TIMEOUT_MS, filename: `${entry}.bundle.js` })
  } catch (initError) {
    const message = initError instanceof Error ? initError.message : String(initError)
    return Promise.resolve({ [RESULT_MARK]: { kind: "init_error", message } })
  }
  const ran = vm.runInContext(template, context, { timeout: JS_TIMEOUT_MS, filename: `${entry}.invoke.js` })
  return Promise.resolve(ran)
}

const unwrap = (raw: unknown): HarnessJsonValue => {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Readonly<Record<string, unknown>>
    const marked = record[RESULT_MARK]
    if (typeof marked === "object" && marked !== null) {
      const problem = marked as Readonly<{ readonly kind?: unknown; readonly message?: unknown }>
      const kind = typeof problem.kind === "string" ? problem.kind : "unknown"
      const message = typeof problem.message === "string" ? ` (${problem.message})` : ""
      throw new Error(`js:${kind}${message}`)
    }
  }
  if (raw === undefined) throw new Error("js:bundle returned undefined")
  if (typeof raw === "bigint") throw new Error("js:result is not a JSON value")
  return raw as HarnessJsonValue
}

export const openStoredJsAdapter = async (
  options: {
    readonly store: string
    readonly digest: string
    readonly entry: string
    readonly log?: (line: string) => void
  }
): Promise<ApprovedHarnessJsAdapter> => {
  const { digest, entry } = options
  if (digest.slice(0, 7) !== "sha256:" || !/^[0-9a-f]{64}$/u.test(digest.slice(7))) {
    throw new Error(`invalid module digest ${digest}`)
  }
  if (!JS_ENTRY_NAME.test(entry)) throw new Error(`invalid entry name ${JSON.stringify(entry)}`)
  const { source, env } = await readJsModule(options.store, digest)
  scanEnv(env)
  const log = options.log ?? (() => undefined)
  return {
    moduleDigest: digest,
    entry,
    invoke: async (args, context) => {
      try {
        const services: HarnessJsServices = {
          now: context.services.now,
          uuid: context.services.uuid,
          fetch: context.services.fetch,
          log: (line) => log(line)
        }
        const raw = await bundle({ entry, source, args, env, services })
        return unwrap(raw)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("js:")) throw error
        throw new Error(`js:${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
