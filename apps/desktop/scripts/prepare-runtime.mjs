import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function hostTriple() {
  const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (rustc.status !== 0) {
    throw new Error("rustc is required to determine the Aiko sidecar target.");
  }
  const host = rustc.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "))
    ?.slice(6);
  if (!host) throw new Error("rustc did not report a host target.");
  return host;
}

function executableName(triple) {
  return triple.includes("windows") ? "aiko.exe" : "aiko";
}

function pathCandidate(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const executable = executableName(triple);
const root = resolve(import.meta.dirname, "..");
const candidates = [
  process.env.AIKO_DESKTOP_RUNTIME,
  resolve(root, "..", "..", "target", "release", executable),
  resolve(root, "..", "..", "target", "debug", executable),
  join(homedir(), "bin", executable),
  pathCandidate(executable),
].filter(Boolean);
const source = candidates.find((candidate) => existsSync(candidate));

if (!source) {
  throw new Error(
    `No Aiko runtime was found for ${triple}. Build it first or set AIKO_DESKTOP_RUNTIME.`,
  );
}

const binaryDirectory = resolve(root, "src-tauri", "binaries");
const suffix = triple.includes("windows") ? ".exe" : "";
const destination = join(binaryDirectory, `aiko-${triple}${suffix}`);
mkdirSync(binaryDirectory, { recursive: true });
copyFileSync(source, destination);
if (!triple.includes("windows")) chmodSync(destination, 0o755);

function contractLibraryNames(target) {
  if (target.includes("windows")) return ["contract.dll", "libcontract.dll"];
  if (target.includes("apple")) return ["libcontract.dylib"];
  return ["libcontract.so"];
}

const contractNames = contractLibraryNames(triple);
const contractCandidates = [
  process.env.AIKO_CONTRACT_LIBRARY,
  ...contractNames.map((name) =>
    resolve(root, "..", "..", "..", "contract", "libcontract", "zig-out", "lib", name),
  ),
].filter(Boolean);
const contractSource = contractCandidates.find((candidate) => existsSync(candidate));
if (!contractSource) {
  throw new Error(
    `No Contract runtime was found for ${triple}. Build ../contract/libcontract for that target or set AIKO_CONTRACT_LIBRARY.`,
  );
}
const contractDirectory = resolve(root, "src-tauri", "resources", "contract");
mkdirSync(contractDirectory, { recursive: true });
const contractDestination = join(contractDirectory, basename(contractSource));
copyFileSync(contractSource, contractDestination);
if (!triple.includes("windows")) chmodSync(contractDestination, 0o755);

process.stdout.write(
  `Prepared ${basename(destination)} and ${basename(contractDestination)}\n`,
);
