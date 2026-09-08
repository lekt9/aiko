/**
 * Impersonation modules.
 *
 * `scanHarModules` is pure: it walks one raw HAR in memory and reports
 * structural entries plus captured wasm/JavaScript payloads and their digest.
 * It never touches an event log or the filesystem. The stores persist those
 * payloads content-addressed (`<digest-hex>.wasm` or `.js`, with a JS env
 * sidecar) below one directory. `read` and `list` re-verify anything they hand
 * out.
 *
 * `openStoredWasmAdapter` instantiates a stored module once and returns a
 * real adapter for the existing executor seam: every call executes the module.
 * There is no scripted stand-in path for a stored digest — an unavailable or
 * corrupt module settles the step instead of guessing a value.
 *
 * `site-wasm/1` ABI: exactly one integer JSON argument per wasm parameter,
 * one numeric result. Memory-backed string ABIs, signature checking, and
 * import/fuel limits are later seams with their own reviewed gates.
 */
import { createHash } from "node:crypto"
import { mkdir, readdir } from "node:fs/promises"
import { resolve, sep } from "node:path"
import type { Sha256Digest } from "./harness-artifact"
import type {
  ApprovedHarnessWasmAdapter,
  HarnessJsonValue
} from "./harness-runtime"

export const WASM_MODULE_MAX_BYTES = 1_048_576
export const JS_MODULE_MAX_BYTES = 512 * 1024
export const JS_ENV_MAX_BYTES = 64 * 1024
const STORE_FILE = /^[0-9a-f]{64}\.(?:wasm|js)$/u
const WASM_MIME = /^(?:application\/wasm|application\/vnd\.[^.]+\.wasm)$/u
const JAVASCRIPT_MIME = /^(?:application\/javascript|text\/javascript)$/u
const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647

const objectAt = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const optionalInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined
  return value
}

export interface HarModuleScan {
  readonly kind: "wasm" | "javascript"
  /** Index of the source HAR entry. */
  readonly index: number
  readonly url: string
  readonly mimeType: string
  readonly status?: number
  /** wasm only: base64 module bytes as captured. */
  readonly bytes?: string
  /** javascript only: the script text as captured. */
  readonly text?: string
  /** sha256 of the captured payload bytes (utf8 for js, raw for wasm). */
  readonly digest?: Sha256Digest
}

export const wasmModuleDigest = (bytes: Uint8Array): Sha256Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/**
 * Structurally walks a HAR and reports wasm/javascript response entries.
 * A wasm entry is reported even when its byte payload is absent; only entries
 * with bytes get a digest and may be stored.
 */
export const scanHarModules = (raw: unknown): HarModuleScan[] => {
  const root = objectAt(raw, "<har>")
  const log = objectAt(root.log, "<har>.log")
  const entries = log.entries
  if (!Array.isArray(entries)) throw new Error("<har>.log.entries must be an array")
  const scans: HarModuleScan[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = objectAt(entries[index], `<har>.log.entries[${index}]`)
    const request = entry.request === undefined ? {} : objectAt(entry.request, `<har>.log.entries[${index}].request`)
    const response = entry.response === undefined ? {} : objectAt(entry.response, `<har>.log.entries[${index}].response`)
    const content = response.content === undefined ? {} : objectAt(response.content, `<har>.log.entries[${index}].response.content`)
    const mimeType = optionalString(content.mimeType)?.trim().toLowerCase()
    const url = optionalString(request.url)
    if (mimeType === undefined) continue
    let kind: "wasm" | "javascript" | undefined
    if (WASM_MIME.test(mimeType)) kind = "wasm"
    else if (JAVASCRIPT_MIME.test(mimeType)) kind = "javascript"
    if (kind === undefined) continue
    if (url === undefined) throw new Error(`<har>.log.entries[${index}] has a script-like response but no request.url`)
    const scan: HarModuleScan = {
      kind,
      index,
      url,
      mimeType,
      ...(optionalInteger(response.status) === undefined ? {} : { status: optionalInteger(response.status)! })
    }
    if (kind === "wasm") {
      const b64 = optionalString(content.bytes)
      const decoded = b64 === undefined ? undefined : Uint8Array.from(Buffer.from(b64, "base64"))
      if (decoded !== undefined && (decoded.length === 0 || decoded.length > WASM_MODULE_MAX_BYTES)) {
        throw new Error(`entry ${index} wasm payload exceeds ${WASM_MODULE_MAX_BYTES} bytes`)
      }
      if (decoded !== undefined) {
        scans.push({ ...scan, bytes: b64!, digest: wasmModuleDigest(decoded) })
        continue
      }
      scans.push(scan)
      continue
    }
    const text = optionalString(content.text)
    if (text !== undefined) {
      const encoded = new TextEncoder().encode(text)
      if (encoded.length === 0 || encoded.length > JS_MODULE_MAX_BYTES) {
        throw new Error(`entry ${index} script payload exceeds ${JS_MODULE_MAX_BYTES} bytes`)
      }
      scans.push({ ...scan, text, digest: wasmModuleDigest(encoded) })
      continue
    }
    scans.push(scan)
  }
  return scans
}

const storeFileFor = (store: string, digest: string, ext: "wasm" | "js"): { readonly root: string; readonly file: string } => {
  const prefix = digest.slice(0, 7)
  const fileName = `${digest.slice(7)}.${ext}`
  if (prefix !== "sha256:" || !STORE_FILE.test(fileName)) throw new Error(`invalid module digest ${digest}`)
  const root = resolve(store)
  const file = resolve(root, fileName)
  if (file === root || !file.startsWith(root + sep)) throw new Error(`digest escapes the module store`)
  return { root, file }
}

export const storeWasmModule = async (
  store: string,
  digest: string,
  bytes: Uint8Array
): Promise<{ readonly digest: Sha256Digest; readonly path: string; readonly wrote: boolean }> => {
  const { file } = storeFileFor(store, digest, "wasm")
  if (bytes.length === 0 || bytes.length > WASM_MODULE_MAX_BYTES) {
    throw new Error(`module bytes exceed ${WASM_MODULE_MAX_BYTES} bytes`)
  }
  const actual = wasmModuleDigest(bytes)
  if (actual !== digest) throw new Error(`module bytes hash to ${actual}, expected ${digest}`)
  if (await Bun.file(file).exists()) {
    const existing = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (wasmModuleDigest(existing) !== digest) {
      throw new Error(`module file exists with different bytes for ${digest}`)
    }
    return { digest: digest as Sha256Digest, path: file, wrote: false }
  }
  await Bun.file(file).write(bytes)
  return { digest: digest as Sha256Digest, path: file, wrote: true }
}

export const storeJsModule = async (
  store: string,
  digest: string,
  source: string,
  env: Readonly<Record<string, unknown>>
): Promise<{ readonly digest: Sha256Digest; readonly path: string; readonly envPath: string; readonly wrote: boolean }> => {
  const envJson = JSON.stringify(env)
  const envBytes = new TextEncoder().encode(envJson)
  if (envBytes.length > JS_ENV_MAX_BYTES) throw new Error(`script env exceeds ${JS_ENV_MAX_BYTES} bytes`)
  const { root, file } = storeFileFor(store, digest, "js")
  const envFile = file.replace(/\.js$/u, ".env.json")
  const sourceBytes = new TextEncoder().encode(source)
  if (sourceBytes.length === 0 || sourceBytes.length > JS_MODULE_MAX_BYTES) {
    throw new Error(`script exceeds ${JS_MODULE_MAX_BYTES} bytes`)
  }
  const actual = wasmModuleDigest(sourceBytes)
  if (actual !== digest) throw new Error(`script hashes to ${actual}, expected ${digest}`)
  const sourceExists = await Bun.file(file).exists()
  if (sourceExists) {
    const existing = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (wasmModuleDigest(existing) !== digest) throw new Error(`script file exists with different bytes for ${digest}`)
    if (await Bun.file(envFile).exists()) {
      const existingEnv = await Bun.file(envFile).json() as unknown
      if (JSON.stringify(existingEnv) !== envJson) throw new Error(`env differs from the recorded env for ${digest}`)
    } else {
      await Bun.file(envFile).write(envJson)
    }
    return { digest: digest as Sha256Digest, path: file, envPath: envFile, wrote: false }
  }
  await mkdir(root, { recursive: true })
  await Bun.file(file).write(sourceBytes)
  await Bun.file(envFile).write(envJson)
  return { digest: digest as Sha256Digest, path: file, envPath: envFile, wrote: true }
}

export const readWasmModule = async (store: string, digest: string): Promise<Uint8Array> => {
  const { file } = storeFileFor(store, digest, "wasm")
  const source = Bun.file(file)
  if (!(await source.exists())) throw new Error(`wasm module not in store: ${digest}`)
  const bytes = new Uint8Array(await source.arrayBuffer())
  if (wasmModuleDigest(bytes) !== digest) throw new Error(`stored wasm module is corrupt: ${digest}`)
  return bytes
}

export const readJsModule = async (
  store: string,
  digest: string
): Promise<{ readonly source: string; readonly env: Readonly<Record<string, unknown>> }> => {
  const { file } = storeFileFor(store, digest, "js")
  const source = Bun.file(file)
  if (!(await source.exists())) throw new Error(`script not in store: ${digest}`)
  const raw = new Uint8Array(await source.arrayBuffer())
  if (wasmModuleDigest(raw) !== digest) throw new Error(`stored script is corrupt: ${digest}`)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  const envFile = file.replace(/\.js$/u, ".env.json")
  const envSource = Bun.file(envFile)
  if (!(await envSource.exists())) throw new Error(`script env not in store: ${digest}`)
  const env = (await envSource.json()) as unknown
  if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error(`script env must be an object: ${digest}`)
  return { source: text, env: env as Readonly<Record<string, unknown>> }
}

export const listWasmModules = async (store: string): Promise<Sha256Digest[]> => {
  const { root } = storeFileFor(store, "sha256:" + "0".repeat(64), "wasm")
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const digests = names
    .filter((name) => /^[0-9a-f]{64}\.wasm$/u.test(name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => `sha256:${name.slice(0, 64)}` as Sha256Digest)
  for (const digest of digests) await readWasmModule(store, digest)
  return digests
}

export const listJsModules = async (store: string): Promise<Sha256Digest[]> => {
  const { root } = storeFileFor(store, "sha256:" + "0".repeat(64), "js")
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const digests = names
    .filter((name) => /^[0-9a-f]{64}\.js$/u.test(name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => `sha256:${name.slice(0, 64)}` as Sha256Digest)
  for (const digest of digests) await readJsModule(store, digest)
  return digests
}

/**
 * Loads one digest/export pair from the store and returns a real adapter for
 * the executor seam. Compile and export-shape problems fail here, not inside
 * a case: no step can ever observe a value this module did not compute.
 */
export const openStoredWasmAdapter = async (options: {
  readonly store: string
  readonly digest: string
  readonly export: string
}): Promise<ApprovedHarnessWasmAdapter> => {
  const { digest, export: exportName } = options
  if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(exportName)) throw new Error(`invalid export name ${exportName}`)
  const bytes = await readWasmModule(options.store, digest)
  let instance: WebAssembly.Instance
  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(bytes))
  } catch {
    throw new Error(`stored wasm module failed to compile: ${digest}`)
  }
  const fn = instance.exports[exportName]
  if (typeof fn !== "function") throw new Error(`wasm export ${JSON.stringify(exportName)} is not a function: ${digest}`)
  return {
    moduleDigest: digest,
    exportName,
    invoke: (args: ReadonlyArray<HarnessJsonValue>): HarnessJsonValue => {
      if (args.length === 0) throw new TypeError(`site-wasm/1 requires one integer argument per parameter: ${digest}`)
      const params = args.map((argument) => {
        if (typeof argument !== "number" || !Number.isSafeInteger(argument) ||
          argument < INT32_MIN || argument > INT32_MAX) {
          throw new TypeError(`site-wasm/1 argument must be an i32-safe integer: ${digest}`)
        }
        return argument
      })
      const result = fn(...params)
      if (typeof result !== "number") throw new TypeError(`site-wasm/1 result must be numeric: ${digest}`)
      return result
    }
  }
}
