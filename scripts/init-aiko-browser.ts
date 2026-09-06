// Trusted installer only; never mounted as an actor tool. Upstream install hooks are not run.
import { mkdir, lstat, copyFile, chmod, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  pinnedAgentBrowserAssetFor,
  pinnedAgentBrowserExecutablePath,
  verifyPinnedAgentBrowserExecutable,
} from "../packages/browser-runtime/src/agent-browser-client.ts";
process.umask(0o077);
const asset = pinnedAgentBrowserAssetFor(),
  target = pinnedAgentBrowserExecutablePath(asset);
try {
  await lstat(target);
  await verifyPinnedAgentBrowserExecutable(target, asset);
  console.log("Pinned agent-browser is already verified.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error(
      "Existing browser asset was not changed; inspect its integrity.",
    );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + "." + crypto.randomUUID() + ".partial";
  try {
    const [flag, source, ...extra] = process.argv.slice(2);
    if (flag !== undefined && (flag !== "--source" || !source || extra.length))
      throw new Error(
        "Use --source <existing pinned asset>, or no arguments to download the official release.",
      );
    if (source) {
      await verifyPinnedAgentBrowserExecutable(source, asset);
      await copyFile(source, temporary);
    } else {
      const response = await fetch(
        `https://github.com/vercel-labs/agent-browser/releases/download/v0.36.0/${asset.name}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok || !response.body)
        throw new Error("Pinned browser download failed");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > asset.sizeBytes) throw new Error("Asset size exceeded");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      await Bun.write(temporary, Buffer.concat(chunks));
    }
    await chmod(temporary, 0o700);
    await verifyPinnedAgentBrowserExecutable(temporary, asset);
    await rename(temporary, target);
    console.log(
      "Installed the exact size/SHA-256 verified agent-browser 0.36.0 native asset. No browser launched.",
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
