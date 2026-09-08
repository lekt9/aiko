#!/usr/bin/env bun

import { chmod, lstat, mkdir, mkdtemp, open as openFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  AGENT_BROWSER_PINNED_VERSION,
  pinnedAgentBrowserAssetFor,
  pinnedAgentBrowserExecutablePath,
  verifyPinnedAgentBrowserExecutable
} from "./src/agent-browser-client"

const INSTALL_TIMEOUT_MS = 120_000
const RELEASE_BASE_URL = `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_PINNED_VERSION}`

const writeAll = async (
  handle: Awaited<ReturnType<typeof openFile>>,
  bytes: Uint8Array
): Promise<void> => {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten <= 0) throw new Error("short write")
    offset += bytesWritten
  }
}

const regularDestinationOrMissing = async (path: string): Promise<boolean> => {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe destination")
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/** Explicit trusted-host setup only; importing the package never downloads a binary. */
export const installPinnedAgentBrowser = async ({ verifyOnly = false }: { readonly verifyOnly?: boolean } = {}): Promise<string> => {
  const asset = pinnedAgentBrowserAssetFor()
  const destination = pinnedAgentBrowserExecutablePath(asset)
  const destinationExists = await regularDestinationOrMissing(destination)

  if (destinationExists) {
    try {
      await verifyPinnedAgentBrowserExecutable(destination, asset)
      if (process.platform !== "win32") await chmod(destination, 0o755)
      return destination
    } catch {
      if (verifyOnly) throw new Error("integrity verification failed")
    }
  } else if (verifyOnly) {
    throw new Error("native executable missing")
  }

  const binaryDirectory = dirname(destination)
  await mkdir(binaryDirectory, { recursive: true })
  const stagingDirectory = await mkdtemp(join(binaryDirectory, ".verified-install-"))
  const staged = join(stagingDirectory, asset.name)
  const previous = join(stagingDirectory, "previous-untrusted-binary")
  let previousMoved = false
  try {
    const response = await fetch(`${RELEASE_BASE_URL}/${asset.name}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS)
    })
    if (!response.ok || response.body === null) throw new Error("download failed")
    const declaredLength = response.headers.get("content-length")
    if (declaredLength !== null && Number(declaredLength) !== asset.sizeBytes) {
      throw new Error("unexpected download length")
    }

    const handle = await openFile(staged, "wx", 0o600)
    let received = 0
    try {
      const reader = response.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > asset.sizeBytes) {
          await reader.cancel()
          throw new Error("download exceeded pinned size")
        }
        await writeAll(handle, chunk.value)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (received !== asset.sizeBytes) throw new Error("download did not match pinned size")
    await verifyPinnedAgentBrowserExecutable(staged, asset)
    if (process.platform !== "win32") await chmod(staged, 0o755)

    if (destinationExists) {
      await rename(destination, previous)
      previousMoved = true
    }
    try {
      await rename(staged, destination)
    } catch (error) {
      if (previousMoved) {
        try { await rename(previous, destination) } catch {}
      }
      throw error
    }
    await verifyPinnedAgentBrowserExecutable(destination, asset)
    return destination
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  if (args.some((argument) => argument !== "--verify")) throw new Error("unsupported argument")
  await installPinnedAgentBrowser({ verifyOnly: args.includes("--verify") })
  process.stdout.write(`Verified pinned agent-browser v${AGENT_BROWSER_PINNED_VERSION} native executable.\n`)
}

if (import.meta.main) await main().catch(() => {
  process.stderr.write("Pinned agent-browser native executable installation failed.\n")
  process.exitCode = 1
})
