import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

const root = resolve(import.meta.dirname, "..");

function contractLibraryNames(target) {
  if (target.includes("windows")) return ["contract.dll", "libcontract.dll"];
  if (target.includes("apple")) return ["libcontract.dylib"];
  return ["libcontract.so"];
}

function contractLibraryCandidates(target) {
  const contractRoot = resolve(root, "..", "..", "..", "contract", "libcontract");
  const names = contractLibraryNames(target);
  return [
    process.env.AIKO_CONTRACT_LIBRARY,
    // Zig installs Windows shared libraries in bin/, both for the dedicated
    // cross prefix and for a native Windows build using the default prefix.
    ...(target.includes("windows")
      ? ["zig-out-windows", "zig-out"].flatMap((prefix) =>
          names.map((name) => resolve(contractRoot, prefix, "bin", name)),
        )
      : []),
    ...names.map((name) => resolve(contractRoot, "zig-out", "lib", name)),
  ].filter(Boolean);
}

function signAppleContractRuntime(target, libraryPath) {
  if (!target.includes("apple")) return;

  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity) return;

  const sign = spawnSync(
    "codesign",
    ["--force", "--timestamp", "--options", "runtime", "--sign", identity, libraryPath],
    { encoding: "utf8" },
  );
  if (sign.status !== 0) {
    throw new Error(
      `Failed to sign ${basename(libraryPath)}: ${sign.stderr || sign.stdout || sign.error}`,
    );
  }

  const verify = spawnSync(
    "codesign",
    ["--verify", "--strict", "--verbose=2", libraryPath],
    { encoding: "utf8" },
  );
  if (verify.status !== 0) {
    throw new Error(
      `Failed to verify ${basename(libraryPath)}: ${verify.stderr || verify.stdout || verify.error}`,
    );
  }

  const display = spawnSync(
    "codesign",
    ["--display", "--verbose=4", libraryPath],
    { encoding: "utf8" },
  );
  const signature = `${display.stdout ?? ""}\n${display.stderr ?? ""}`;
  if (display.status !== 0 || !signature.includes(`Authority=${identity}`)) {
    throw new Error(`${basename(libraryPath)} is not signed by ${identity}.`);
  }
  if (!signature.includes("Timestamp=")) {
    throw new Error(`${basename(libraryPath)} does not have a secure timestamp.`);
  }

  process.stdout.write(`Signed and verified ${basename(libraryPath)}\n`);
}

if (process.argv.includes("--test-contract-candidates")) {
  const candidates = contractLibraryCandidates("x86_64-pc-windows-msvc").map((candidate) =>
    candidate.replaceAll("\\", "/"),
  );
  for (const suffix of [
    "/zig-out-windows/bin/contract.dll",
    "/zig-out/bin/contract.dll",
  ]) {
    if (!candidates.some((candidate) => candidate.endsWith(suffix))) {
      throw new Error(`missing Windows Contract candidate: ${suffix}`);
    }
  }
  const platformCases = [
    ["aarch64-apple-darwin", "/zig-out/lib/libcontract.dylib"],
    ["x86_64-unknown-linux-gnu", "/zig-out/lib/libcontract.so"],
  ];
  for (const [target, suffix] of platformCases) {
    const platformCandidates = contractLibraryCandidates(target).map((candidate) =>
      candidate.replaceAll("\\", "/"),
    );
    if (!platformCandidates.some((candidate) => candidate.endsWith(suffix))) {
      throw new Error(`missing ${target} Contract candidate: ${suffix}`);
    }
    candidates.push(...platformCandidates);
  }
  if (candidates.some((candidate) => candidate.includes("collective"))) {
    throw new Error("collective-only library admitted as a full Contract candidate");
  }
  process.stdout.write("prepare-runtime full Contract candidates: PASS\n");
  process.exit(0);
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const executable = executableName(triple);
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

const contractCandidates = contractLibraryCandidates(triple);
const contractSource = contractCandidates.find((candidate) => existsSync(candidate));
if (!contractSource) {
  throw new Error(
    `No full Contract runtime was found for ${triple}. Build ../contract/libcontract for that target or set AIKO_CONTRACT_LIBRARY.`,
  );
}
const contractDirectory = resolve(root, "src-tauri", "resources", "contract");
mkdirSync(contractDirectory, { recursive: true });
for (const staleName of [
  "contract.dll",
  "contract_collective.dll",
  "libcontract.dll",
  "libcontract_collective.dll",
  "libcontract.dylib",
  "libcontract_collective.dylib",
  "libcontract.so",
  "libcontract_collective.so",
]) {
  rmSync(join(contractDirectory, staleName), { force: true });
}
const packagedContractName = triple.includes("windows") ? "contract.dll" : basename(contractSource);
const contractDestination = join(contractDirectory, packagedContractName);
copyFileSync(contractSource, contractDestination);
if (!triple.includes("windows")) chmodSync(contractDestination, 0o755);
// Tauri invokes this script again from beforeBuildCommand. Sign after the copy
// so that refresh cannot replace the release workflow's signed dylib.
signAppleContractRuntime(triple, contractDestination);

process.stdout.write(
  `Prepared ${basename(destination)} and ${basename(contractDestination)}\n`,
);
