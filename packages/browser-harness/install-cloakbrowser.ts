#!/usr/bin/env bun
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import {
  CLOAK_BROWSER_ARCHIVE, CLOAK_BROWSER_DIRECTORY, CLOAK_BROWSER_RELEASE_URL,
  CLOAK_BROWSER_VERSION, requireCloakBrowserPlatform, verifyCloakBrowser,
  verifyCloakBrowserManifest
} from "./src/cloak-browser"

// Public vendor downloads only. No license discovery, mirror overrides or
// upstream install hooks. End users download directly; no binary redistribution.
export { CLOAK_BROWSER_VERSION, verifyCloakBrowser } from "./src/cloak-browser"

export const installPinnedCloakBrowser = async ({ verifyOnly = false, directory = CLOAK_BROWSER_DIRECTORY }: { readonly verifyOnly?: boolean; readonly directory?: string } = {}): Promise<string> => {
  requireCloakBrowserPlatform()
  let exists = false
  try { await lstat(directory); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (exists || verifyOnly) return verifyCloakBrowser(directory)
  const parent = dirname(directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(join(parent, ".cloak-install-"))
  await chmod(stage, 0o700)
  const signal = AbortSignal.timeout(300_000)
  const download = async (name: string, size: number, destination?: string): Promise<Uint8Array> => {
    const response = await fetch(`${CLOAK_BROWSER_RELEASE_URL}/${name}`, { signal })
    if (!response.ok || !response.body) throw new Error("CloakBrowser download failed")
    const length = response.headers.get("content-length")
    if (length !== null && Number(length) !== size) throw new Error("Unexpected CloakBrowser download size")
    const handle = destination ? await open(destination, "wx", 0o600) : undefined
    const hash = createHash("sha256")
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        total += chunk.byteLength
        if (total > size) throw new Error("CloakBrowser download size exceeded")
        hash.update(chunk)
        if (handle) {
          let offset = 0
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
            if (!bytesWritten) throw new Error("Short write")
            offset += bytesWritten
          }
        } else chunks.push(chunk)
      }
      if (total !== size) throw new Error("Incomplete CloakBrowser download")
      if (destination && hash.digest("hex") !== CLOAK_BROWSER_ARCHIVE.sha256) throw new Error("CloakBrowser archive integrity failed")
      await handle?.sync()
      return Buffer.concat(chunks)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await handle?.close()
    }
  }
  try {
    const manifest = await download("SHA256SUMS", 216)
    const signature = await download("SHA256SUMS.sig", 88)
    verifyCloakBrowserManifest(manifest, new TextDecoder().decode(signature))
    const archive = join(stage, "browser.tar.gz")
    await download(CLOAK_BROWSER_ARCHIVE.name, CLOAK_BROWSER_ARCHIVE.size, archive)
    const extracted = join(stage, "browser")
    await mkdir(extracted, { mode: 0o700 })
    // Only the exact authenticated archive reaches tar. Ignore TAR_OPTIONS and
    // other inherited process settings; no shell or model-supplied arguments.
    const child = Bun.spawn(["/usr/bin/tar", "-xzf", archive, "--no-same-owner", "--same-permissions", "-C", extracted], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdin: "ignore", stdout: "ignore", stderr: "ignore"
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    try { if (await child.exited !== 0) throw new Error("CloakBrowser extraction failed") } finally { clearTimeout(timer) }
    await verifyCloakBrowser(extracted)
    await rename(extracted, directory)
    return verifyCloakBrowser(directory)
  } finally { await rm(stage, { recursive: true, force: true }) }
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== "--verify")) throw new Error("Unsupported argument")
  await installPinnedCloakBrowser({ verifyOnly: args.includes("--verify") })
  console.log(`Verified CloakBrowser ${CLOAK_BROWSER_VERSION} executable and resources.`)
}

if (import.meta.main) await main().catch(() => {
  console.error("Pinned CloakBrowser installation/verification failed. No fallback was selected; an existing installation is never overwritten.")
  process.exitCode = 1
})
