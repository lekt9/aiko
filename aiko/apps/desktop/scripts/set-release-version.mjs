import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const packagePath = resolve(desktop, "package.json");
const packageLockPath = resolve(desktop, "package-lock.json");
const tauriPath = resolve(desktop, "src-tauri/tauri.conf.json");
const cargoPath = resolve(desktop, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(desktop, "src-tauri/Cargo.lock");
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

function setJsonVersion(path, update = (document) => { document.version = version; }) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  update(document);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

function replaceVersion(path, pattern, label) {
  const source = readFileSync(path, "utf8");
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label} version in ${path}`);
  }
  const updated = source.replace(pattern, `$1${version}$2`);
  if (!updated.includes(`version = "${version}"`)) {
    throw new Error(`Could not set ${label} version in ${path}`);
  }
  writeFileSync(path, updated);
}

setJsonVersion(packagePath);
setJsonVersion(packageLockPath, (document) => {
  document.version = version;
  if (!document.packages?.[""]) throw new Error("package-lock root package is missing");
  document.packages[""].version = version;
});
setJsonVersion(tauriPath);
replaceVersion(cargoPath, /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, "Cargo package");
replaceVersion(
  cargoLockPath,
  /(\[\[package\]\]\r?\nname = "aiko-desktop"\r?\nversion = ")[^"]+(")/,
  "Cargo.lock package",
);

for (const path of [packagePath, packageLockPath, tauriPath]) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (document.version !== version) {
    throw new Error(`Version verification failed for ${path}: ${document.version}`);
  }
}
console.log("Release version metadata written and verified across desktop package, lockfiles, Cargo, and Tauri configuration");
