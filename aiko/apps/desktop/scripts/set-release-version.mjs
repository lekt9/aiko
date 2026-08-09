import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const packagePath = resolve(desktop, "package.json");
const tauriPath = resolve(desktop, "src-tauri/tauri.conf.json");
const tag = (process.env.AIKO_RELEASE_TAG ?? "").trim();
const manual = (process.env.AIKO_RELEASE_VERSION ?? "").trim();

if (tag && manual) {
  throw new Error("Set AIKO_RELEASE_TAG or AIKO_RELEASE_VERSION, never both.");
}
if (!tag && !manual) {
  throw new Error("Release version is missing: expected a v-prefixed tag or the workflow_dispatch version input.");
}
if (manual.startsWith("v")) {
  throw new Error("Manual release version must not start with v (use e.g. 1.2.3).");
}
if (tag && !tag.startsWith("v")) {
  throw new Error(`Release tag must start with v: ${tag}`);
}

const version = tag ? tag.slice(1) : manual;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
if (!semver.test(version)) {
  throw new Error(`Release version is not valid SemVer: ${version}`);
}

function setVersion(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.version = version;
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  const verified = JSON.parse(readFileSync(path, "utf8"));
  if (verified.version !== version) {
    throw new Error(`Version verification failed for ${path}: ${verified.version}`);
  }
}

setVersion(packagePath);
setVersion(tauriPath);
console.log(`Release version ${version} written and verified in package.json and src-tauri/tauri.conf.json`);
