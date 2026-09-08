import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto"
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import { canonicalStringify, compareText } from "./har"
import type { ReusableSessionSnapshot } from "./har-value-profile"

export const SESSION_VAULT_FORMAT_VERSION = 1 as const
export const SESSION_REFERENCE = /^session:v1:([0-9a-f]{32})$/u
export const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1_000
export const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024
const MAX_VAULT_DIRECTORY_ENTRIES = 8_192

export class SessionVaultError extends Error {
  constructor(
    readonly code:
      | "invalid_reference"
      | "invalid_snapshot"
      | "generation_conflict"
      | "not_found"
      | "expired"
      | "site_mismatch"
      | "vault_corrupt"
      | "vault_permissions",
    message: string
  ) {
    super(message)
    this.name = "SessionVaultError"
  }
}

export type SessionReference = `session:v1:${string}`

export interface SessionVaultRecord {
  readonly formatVersion: typeof SESSION_VAULT_FORMAT_VERSION
  readonly ref: SessionReference
  readonly siteId: string
  readonly generation: number
  readonly sourceImportDigest: string
  readonly profileRevision: string
  readonly storedHeaders: number
  readonly storedCookies: number
  readonly createdAt: number
  readonly expiresAt: number
}

interface SessionVaultEnvelope {
  readonly formatVersion: typeof SESSION_VAULT_FORMAT_VERSION
  readonly record: SessionVaultRecord
  readonly algorithm: "aes-256-gcm"
  readonly nonce: string
  readonly tag: string
  readonly ciphertext: string
}

const referenceOf = (value: string): SessionReference => {
  if (!SESSION_REFERENCE.test(value)) {
    throw new SessionVaultError("invalid_reference", "Session reference must be session:v1: followed by 32 lowercase hexadecimal characters")
  }
  return value as SessionReference
}

const referenceHexOf = (value: string): string => {
  const match = SESSION_REFERENCE.exec(value)
  if (match === null) throw new SessionVaultError("invalid_reference", "Invalid opaque session reference")
  return match[1]!
}

const validateSiteId = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/gu, "")
  if (
    normalized.length === 0 || normalized.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized) ||
    normalized.includes("..")
  ) throw new SessionVaultError("invalid_snapshot", "Session site ID is invalid")
  return normalized
}

const assertNoSymlinkAncestors = (path: string): void => {
  let current = resolve(path)
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new SessionVaultError("vault_permissions", `Session vault paths may not traverse symbolic links: ${current}`)
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const ensureDirectory = (path: string): void => {
  assertNoSymlinkAncestors(path)
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  assertNoSymlinkAncestors(path)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SessionVaultError("vault_permissions", "Session vault root must be a real directory")
  }
  chmodSync(path, 0o700)
}

const privateFile = (path: string): void => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new SessionVaultError("vault_permissions", "Session vault files must be regular mode-0600 files")
  }
}

const readEnvelope = (path: string): SessionVaultEnvelope => {
  privateFile(path)
  const bytes = readFileSync(path)
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new SessionVaultError("vault_corrupt", "Session envelope exceeds its size bound")
  try {
    const value = JSON.parse(bytes.toString("utf8")) as SessionVaultEnvelope
    referenceOf(value.record.ref)
    validateSiteId(value.record.siteId)
    if (
      value.formatVersion !== SESSION_VAULT_FORMAT_VERSION || value.record.formatVersion !== SESSION_VAULT_FORMAT_VERSION ||
      value.algorithm !== "aes-256-gcm" || !Number.isSafeInteger(value.record.generation) || value.record.generation < 1 ||
      !Number.isSafeInteger(value.record.createdAt) || !Number.isSafeInteger(value.record.expiresAt) ||
      value.record.expiresAt <= value.record.createdAt ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.record.sourceImportDigest) ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.nonce) ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.tag) ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.ciphertext)
    ) throw new Error("invalid envelope")
    return value
  } catch {
    throw new SessionVaultError("vault_corrupt", "Session vault envelope is invalid")
  }
}

const filenameOf = (ref: string, generation: number): string =>
  `session-${referenceHexOf(ref)}-g${String(generation).padStart(8, "0")}.json`

const parseFilename = (name: string): { readonly hex: string; readonly generation: number } | undefined => {
  const match = /^session-([0-9a-f]{32})-g([0-9]{8})\.json$/u.exec(name)
  if (match === null) return undefined
  const generation = Number(match[2])
  return Number.isSafeInteger(generation) && generation >= 1 ? { hex: match[1]!, generation } : undefined
}

export interface SessionVaultOptions {
  readonly root?: string
  readonly keyFile?: string
  readonly now?: () => number
}

export class LocalSessionVault {
  readonly root: string
  readonly keyFile: string
  readonly #now: () => number

  constructor(options: SessionVaultOptions = {}) {
    this.root = resolve(options.root ?? join(process.cwd(), ".tardigrade", "session-vault"))
    this.keyFile = resolve(options.keyFile ?? join(dirname(this.root), "session-vault.key"))
    this.#now = options.now ?? Date.now
    ensureDirectory(this.root)
    ensureDirectory(dirname(this.keyFile))
  }

  createReference(): SessionReference {
    return `session:v1:${randomBytes(16).toString("hex")}`
  }

  #key(): Buffer {
    if (!existsSync(this.keyFile)) {
      try {
        writeFileSync(this.keyFile, randomBytes(32), { flag: "wx", mode: 0o600 })
      } catch (cause) {
        if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause
      }
    }
    privateFile(this.keyFile)
    const key = readFileSync(this.keyFile)
    if (key.byteLength !== 32) throw new SessionVaultError("vault_corrupt", "Session vault key must contain exactly 32 bytes")
    return key
  }

  #files(ref?: string): ReadonlyArray<{ readonly path: string; readonly generation: number }> {
    const expectedHex = ref === undefined ? undefined : referenceHexOf(ref)
    const names = readdirSync(this.root)
    if (names.length > MAX_VAULT_DIRECTORY_ENTRIES) {
      throw new SessionVaultError("vault_corrupt", "Session vault directory exceeds its entry bound")
    }
    return names.flatMap((name) => {
      const parsed = parseFilename(name)
      if (parsed === undefined || (expectedHex !== undefined && parsed.hex !== expectedHex)) return []
      return [{ path: join(this.root, name), generation: parsed.generation }]
    }).sort((left, right) => left.generation - right.generation || compareText(left.path, right.path))
  }

  list(): ReadonlyArray<SessionVaultRecord> {
    return this.#files().map(({ path, generation }) => {
      const envelope = readEnvelope(path)
      if (envelope.record.generation !== generation || filenameOf(envelope.record.ref, generation) !== basename(path)) {
        throw new SessionVaultError("vault_corrupt", "Session envelope identity does not match its immutable filename")
      }
      return envelope.record
    }).sort((left, right) => compareText(left.ref, right.ref) || left.generation - right.generation)
  }

  put(input: {
    readonly ref?: string
    readonly snapshot: ReusableSessionSnapshot
    readonly ttlMs?: number
    readonly expectedGeneration?: number
  }): SessionVaultRecord {
    const ref = input.ref === undefined ? this.createReference() : referenceOf(input.ref)
    const siteId = validateSiteId(input.snapshot.siteId)
    const ttlMs = input.ttlMs ?? DEFAULT_SESSION_TTL_MS
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_SESSION_TTL_MS) {
      throw new SessionVaultError("invalid_snapshot", `Session TTL must be between 60000 and ${MAX_SESSION_TTL_MS} milliseconds`)
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.snapshot.sourceImportDigest)) {
      throw new SessionVaultError("invalid_snapshot", "Session snapshot import digest is invalid")
    }
    const existing = this.#files(ref)
    const currentGeneration = existing.at(-1)?.generation ?? 0
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== currentGeneration) {
      throw new SessionVaultError("generation_conflict", "Session snapshot generation changed before this write")
    }
    if (input.expectedGeneration === undefined && currentGeneration !== 0) {
      throw new SessionVaultError("generation_conflict", "Updating a session requires its expected generation")
    }
    const generation = currentGeneration + 1
    const createdAt = this.#now()
    const record: SessionVaultRecord = {
      formatVersion: SESSION_VAULT_FORMAT_VERSION,
      ref,
      siteId,
      generation,
      sourceImportDigest: input.snapshot.sourceImportDigest,
      profileRevision: input.snapshot.profileRevision,
      storedHeaders: input.snapshot.headers.length,
      storedCookies: input.snapshot.cookies.length,
      createdAt,
      expiresAt: createdAt + ttlMs
    }
    const plaintext = Buffer.from(canonicalStringify({ ...input.snapshot, siteId }), "utf8")
    if (plaintext.byteLength > MAX_ENVELOPE_BYTES / 2) {
      throw new SessionVaultError("invalid_snapshot", "Session snapshot exceeds its encrypted storage bound")
    }
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.#key(), nonce)
    cipher.setAAD(Buffer.from(canonicalStringify(record), "utf8"))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelope: SessionVaultEnvelope = {
      formatVersion: SESSION_VAULT_FORMAT_VERSION,
      record,
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    }
    const finalPath = join(this.root, filenameOf(ref, generation))
    const temporaryPath = `${finalPath}.tmp-${randomBytes(8).toString("hex")}`
    try {
      writeFileSync(temporaryPath, `${canonicalStringify(envelope)}\n`, { flag: "wx", mode: 0o600 })
      privateFile(temporaryPath)
      try {
        linkSync(temporaryPath, finalPath)
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST") {
          throw new SessionVaultError("generation_conflict", "Another writer created this immutable session generation")
        }
        throw cause
      }
      rmSync(temporaryPath, { force: false })
      privateFile(finalPath)
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
    }
    return record
  }

  resolve(refValue: string, siteValue: string): ReusableSessionSnapshot {
    const ref = referenceOf(refValue)
    const siteId = validateSiteId(siteValue)
    const latest = this.#files(ref).at(-1)
    if (latest === undefined) throw new SessionVaultError("not_found", "Session snapshot was not found")
    const envelope = readEnvelope(latest.path)
    if (envelope.record.ref !== ref || envelope.record.generation !== latest.generation) {
      throw new SessionVaultError("vault_corrupt", "Session envelope identity does not match its immutable filename")
    }
    if (envelope.record.siteId !== siteId) throw new SessionVaultError("site_mismatch", "Session snapshot belongs to another site")
    if (envelope.record.expiresAt <= this.#now()) throw new SessionVaultError("expired", "Session snapshot has expired")
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key(), Buffer.from(envelope.nonce, "base64"))
      decipher.setAAD(Buffer.from(canonicalStringify(envelope.record), "utf8"))
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8")
      const snapshot = JSON.parse(plaintext) as ReusableSessionSnapshot
      if (
        snapshot.formatVersion !== 1 || snapshot.siteId !== siteId ||
        snapshot.sourceImportDigest !== envelope.record.sourceImportDigest ||
        snapshot.profileRevision !== envelope.record.profileRevision ||
        !Array.isArray(snapshot.headers) || !Array.isArray(snapshot.cookies)
      ) throw new Error("snapshot mismatch")
      return snapshot
    } catch (cause) {
      if (cause instanceof SessionVaultError) throw cause
      throw new SessionVaultError("vault_corrupt", "Session snapshot failed authenticated decryption")
    }
  }

  remove(refValue: string): number {
    const ref = referenceOf(refValue)
    const files = this.#files(ref)
    for (const file of files) rmSync(file.path, { force: false })
    return files.length
  }
}
