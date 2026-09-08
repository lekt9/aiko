import { harnessDigest, type HarnessDigest } from "./harness-library.ts";
import pins from "../assets/media-model.lock.json";
import multilingualPins from "../assets/media-multilingual-model.lock.json";

/** Public upstream metadata only. These pins are not proof that a VM contains
 * these bytes. The root runtime must verify files and its full resolved wheel lock. */
export const mediaModelPin = Object.freeze(structuredClone(pins.model));
export const mediaMultilingualModelPin = Object.freeze(structuredClone(multilingualPins.model));
export interface MediaModelPin { repository: string; revision: string; files: Record<string, { sha256: string; bytes: number }> }
export const mediaPackagePin = Object.freeze(structuredClone(pins.package));
export interface MediaRuntimeInventory {
  python: { version: string; executableSha256: string };
  ffmpeg: { version: string; executableSha256: string };
  ffprobe: { version: string; executableSha256: string };
  /** Complete installed wheel closure from the isolated environment, not just direct requirements. */
  wheels: { name: string; version: string; filename: string; sha256: string }[];
  resolvedRequirementsSha256: string;
  models: Record<string, { sha256: string; bytes: number }>;
}
const sha = /^[a-f0-9]{64}$/;
export function mediaRuntimeLockMetadata(inventory: MediaRuntimeInventory, model: MediaModelPin = mediaModelPin) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model.repository) || !/^[a-f0-9]{40}$/.test(model.revision) || !Object.keys(model.files).length) throw Error("Media model pin missing");
  const copy = structuredClone(inventory);
  if (
    !sha.test(copy.resolvedRequirementsSha256) ||
    [copy.python, copy.ffmpeg, copy.ffprobe].some(
      (tool) => !tool.version || !sha.test(tool.executableSha256),
    )
  )
    throw Error("Media runtime binary/closure pin missing");
  if (
    !copy.wheels.length ||
    new Set(copy.wheels.map((w) => w.name)).size !== copy.wheels.length ||
    copy.wheels.some(
      (w) =>
        !w.name ||
        !w.version ||
        !w.filename.endsWith(".whl") ||
        !sha.test(w.sha256),
    )
  )
    throw Error("Media wheel pin missing");
  const faster = copy.wheels.find(
    (w) => w.name.replaceAll("_", "-") === "faster-whisper",
  );
  if (
    !faster ||
    faster.version !== pins.package.version ||
    !pins.package.wheels.some(
      (w) => w.filename === faster.filename && w.sha256 === faster.sha256,
    )
  )
    throw Error("Whisper wheel pin mismatch");
  for (const name of [
    "ctranslate2",
    "huggingface-hub",
    "tokenizers",
    "onnxruntime",
    "av",
    "tqdm",
    "numpy",
    "requests",
  ])
    if (!copy.wheels.some((w) => w.name.replaceAll("_", "-") === name))
      throw Error(`Media dependency pin missing: ${name}`);
  for (const dependency of pins.compatibilityPackages) {
    const installed = copy.wheels.find((w) => w.name === dependency.name);
    if (
      !installed ||
      installed.version !== dependency.version ||
      !dependency.wheels.some(
        (w) =>
          w.filename === installed.filename && w.sha256 === installed.sha256,
      )
    )
      throw Error("Media compatibility wheel pin mismatch");
  }
  for (const [name, expected] of Object.entries(model.files))
    if (
      copy.models[name]?.sha256 !== expected.sha256 ||
      copy.models[name]?.bytes !== expected.bytes
    )
      throw Error("Whisper model pin mismatch");
  return {
    version: 1 as const,
    kind: "unlock-media-runtime-inventory/v1",
    ...copy,
    modelRepository: model.repository,
    modelRevision: model.revision,
    network: "disabled-during-jobs",
    custody: "private-input-and-output",
    sources: [...pins.sources, `https://huggingface.co/${model.repository}/tree/${model.revision}`],
  };
}
export function mediaRuntimeInventoryDigest(
  inventory: MediaRuntimeInventory,
  model: MediaModelPin = mediaModelPin,
): HarnessDigest {
  return harnessDigest(mediaRuntimeLockMetadata(inventory, model));
}

/** Setup-time check only, never a guest operation or a downloader. Call before
 * sealing the runtime tree; runtime.check must continue fencing later mutation. */
export async function verifyMediaModelDirectory(
  directory: string,
  model: { files: Record<string, { sha256: string; bytes: number }> } = mediaModelPin,
): Promise<void> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const { lstat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  for (const [name, expected] of Object.entries(model.files)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !sha.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1) throw Error("Invalid model file pin");
    const path = join(directory, name),
      stat = await lstat(path);
    if (!stat.isFile() || stat.size !== expected.bytes)
      throw Error("Whisper model bytes unavailable");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (hash.digest("hex") !== expected.sha256)
      throw Error("Whisper model bytes changed");
  }
}
