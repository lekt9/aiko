/** Read-only witness validation. Does not contact providers or allocate a VM. */
import { createHash } from "node:crypto";
import { trustedCodegraffMediaRecipe } from "../src/compute-harness.ts";
const directory = process.argv[2];
if (!directory) throw Error("Pass the retained compute-canary evidence directory");
const read = (name: string) => Bun.file(`${directory}/${name}`).json();
const summary = await read("summary.json"), audit = await read("debian-audit.json"), local = await read("local-artifact.json");
const recipe = trustedCodegraffMediaRecipe(
  await Bun.file(new URL("../assets/media-requirements.lock", import.meta.url)).text(),
  (await Bun.file(new URL("../assets/media-model.lock.json", import.meta.url)).json()).model,
  (await Bun.file(new URL("../assets/media-multilingual-model.lock.json", import.meta.url)).json()).model,
);
if (recipe.native.ffmpeg.sha256 !== audit.binarySha256.ffmpeg || recipe.native.ffprobe.sha256 !== audit.binarySha256.ffprobe ||
    audit.packageSha256 !== "8669bc77e55393c14e0dd257ba9a916007cb6da0e1074c9b5e1d53812024f2af") throw Error("Recipe does not match independent Debian audit");
const bundle = Buffer.from(await Bun.file(`${directory}/compute-runner.txt`).arrayBuffer());
if (createHash("sha256").update(bundle).digest("hex") !== local.candidateSha256) throw Error("Retained compute artifact changed");
if (!summary.browserPageVerified || summary.codeReceipt?.status !== "completed" || summary.codeReceipt.output?.value !== 42 ||
    summary.networkReceipt?.status !== "completed" || summary.networkReceipt.requests !== 1 || !summary.networkReused ||
    !summary.allModelFilesVerified || summary.wheelCount !== 30 || !summary.allWheelHashesPinned ||
    summary.livePythonReady !== false || summary.liveMediaExecutionVerified !== false || summary.setupExitCode !== 137 ||
    summary.cleanup !== "deleted-confirmed-404" || summary.existingVmPreserved === summary.canaryId) throw Error("Bounded live outcome evidence mismatch");
console.log("Audited recipe, retained live browser/code/network evidence and cleanup verified; Python/media readiness remains unconfirmed.");
