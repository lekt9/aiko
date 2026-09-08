import { createHash, createPublicKey, verify } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

export type BrowserBackend = "stock" | "cloakbrowser"
export const browserBackendOf = (value: string | undefined): BrowserBackend => {
  if (value === undefined || value === "stock") return "stock"
  if (value === "cloakbrowser") return value
  throw new Error("BROWSE_HARNESS_BROWSER must be stock or cloakbrowser")
}

// Official community release; no wrapper, license discovery, auto-update or
// environment-controlled download/executable override runs in this integration.
export const CLOAK_BROWSER_VERSION = "146.0.7680.177.5"
export const CLOAK_BROWSER_ARCHIVE = Object.freeze({
  name: "cloakbrowser-linux-x64.tar.gz",
  size: 216_890_134,
  sha256: "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e"
})
export const CLOAK_BROWSER_RELEASE_URL = `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAK_BROWSER_VERSION}`
// Derived from the signed, digest-pinned archive, including ALL resources/libs.
export const CLOAK_BROWSER_TREE_SHA256 = "bddeae46d110525919baa6633770eed533282f03d5ef7df86caaeca2c2f5995f"
export const CLOAK_BROWSER_DIRECTORY = resolve(import.meta.dir, "../.tardigrade/browsers", `cloakbrowser-${CLOAK_BROWSER_VERSION}-linux-x64`)
export const CLOAK_BROWSER_VERIFIED_MESSAGE = `Browser backend: cloakbrowser ${CLOAK_BROWSER_VERSION} (verified executable and resources)`

export const requireCloakBrowserPlatform = (platform = process.platform, arch = process.arch): void => {
  if (platform !== "linux" || arch !== "x64") throw new Error("Pinned CloakBrowser currently supports Linux x64 only")
}

export const verifyCloakBrowserManifest = (manifest: Uint8Array, signature: string): void => {
  if (manifest.byteLength !== 216 || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) throw new Error("Invalid CloakBrowser manifest")
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from("MKFKwIhUcKWq5xTuNA0Ovg99njcDEcEJvmWYYhApvaU=", "base64")]),
    format: "der", type: "spki"
  })
  if (!verify(null, manifest, key, Buffer.from(signature, "base64"))) throw new Error("CloakBrowser signature verification failed")
  const lines = new TextDecoder().decode(manifest).split("\n")
  if (lines[0] !== `version=${CLOAK_BROWSER_VERSION}` || !lines.includes(`${CLOAK_BROWSER_ARCHIVE.sha256}  ${CLOAK_BROWSER_ARCHIVE.name}`)) {
    throw new Error("CloakBrowser release binding failed")
  }
}

/** Bounded, no-symlink digest of every shipped file, name and executable bit. */
export const cloakBrowserTreeDigest = async (directory: string): Promise<string> => {
  const root = resolve(directory)
  if (await realpath(root) !== root) throw new Error("CloakBrowser directory must not contain symlinks")
  const rows: string[] = []
  let entries = 0
  let totalBytes = 0
  const deadline = Date.now() + 30_000
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (++entries > 4096 || depth > 8 || Date.now() > deadline) throw new Error("CloakBrowser tree limit exceeded")
    const path = join(root, relative)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error("CloakBrowser symlinks are forbidden")
    if (info.mode & 0o6022) throw new Error("CloakBrowser privileged or shared-writable files are forbidden")
    if (info.isDirectory()) {
      rows.push(JSON.stringify([relative, "directory"]))
      for await (const entry of await opendir(path)) await visit(relative ? `${relative}/${entry.name}` : entry.name, depth + 1)
      return
    }
    if (!info.isFile() || info.size > 1_073_741_824 || totalBytes + info.size > 1_610_612_736) throw new Error("Invalid CloakBrowser file")
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new Error("CloakBrowser file changed")
      const hash = createHash("sha256")
      let bytes = 0
      while (true) {
        if (Date.now() > deadline) throw new Error("CloakBrowser verification timed out")
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        bytes += bytesRead
        if (bytes > info.size) throw new Error("CloakBrowser file grew")
        hash.update(buffer.subarray(0, bytesRead))
      }
      if (bytes !== info.size) throw new Error("CloakBrowser file shrank")
      totalBytes += bytes
      rows.push(JSON.stringify([relative, bytes, info.mode & 0o111, hash.digest("hex")]))
    } finally { await handle.close() }
  }
  await visit("", 0)
  return createHash("sha256").update(rows.sort().join("\n") + "\n").digest("hex")
}

export const verifyCloakBrowser = async (directory = CLOAK_BROWSER_DIRECTORY): Promise<string> => {
  requireCloakBrowserPlatform()
  if (await cloakBrowserTreeDigest(directory) !== CLOAK_BROWSER_TREE_SHA256) throw new Error("CloakBrowser installation failed integrity verification")
  return join(directory, "chrome")
}

/** Called only by the trusted controller, never from model arguments. */
export const browserLaunchConfig = async (backend: BrowserBackend): Promise<Readonly<{ executablePath?: string }>> => {
  if (browserBackendOf(backend) === "stock") return Object.freeze({})
  return Object.freeze({ executablePath: await verifyCloakBrowser() })
}
