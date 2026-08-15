import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  mkdirSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const appRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const appVersion = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")).version;

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

function isFile(candidate) {
  if (!candidate || !existsSync(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function filesEqual(left, right) {
  if (!isFile(left) || !isFile(right)) return false;
  if (statSync(left).size !== statSync(right).size) return false;
  const leftFd = openSync(left, "r");
  const rightFd = openSync(right, "r");
  const leftBuffer = Buffer.allocUnsafe(1024 * 1024);
  const rightBuffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const leftRead = readSync(leftFd, leftBuffer, 0, leftBuffer.length, null);
      const rightRead = readSync(rightFd, rightBuffer, 0, rightBuffer.length, null);
      if (leftRead !== rightRead) return false;
      if (leftRead === 0) return true;
      if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) {
        return false;
      }
    }
  } finally {
    closeSync(leftFd);
    closeSync(rightFd);
  }
}

function copyIfChanged(source, destination) {
  if (filesEqual(source, destination)) return false;
  copyFileSync(source, destination);
  return true;
}

function executableName(triple) {
  return triple.includes("windows") ? "aiko.exe" : "aiko";
}

function runtimeCandidates(target, host) {
  const executable = executableName(target);
  const targetSpecific = [
    process.env.AIKO_DESKTOP_RUNTIME,
    resolve(workspaceRoot, "target", target, "release", executable),
    resolve(workspaceRoot, "target", target, "debug", executable),
  ];
  if (target !== host) return targetSpecific.filter(Boolean);
  return [
    ...targetSpecific,
    resolve(workspaceRoot, "target", "release", executable),
    resolve(workspaceRoot, "target", "debug", executable),
  ].filter(Boolean);
}

function runtimeMatchesAppVersion(candidate, target, host) {
  if (!isFile(candidate)) return false;
  // Cross-target binaries cannot execute on the build host; release workflows
  // are responsible for building the matching target/version in that case.
  if (target !== host) return true;
  const version = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (version.status !== 0) return false;
  const banner = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  return new RegExp(`(^|\\s)${appVersion.replaceAll(".", "\\.")}($|\\s|\\()`).test(banner);
}

function contractLibraryNames(target) {
  if (target.includes("windows")) return ["contract.dll", "libcontract.dll"];
  if (target.includes("apple")) return ["libcontract.dylib"];
  return ["libcontract.so"];
}

function contractLibraryCandidates(target) {
  const contractRoot = resolve(workspaceRoot, "..", "contract", "libcontract");
  const names = contractLibraryNames(target);
  const targetPrefix = `zig-out-${target}`;
  return [
    process.env.AIKO_CONTRACT_LIBRARY,
    ...[targetPrefix, ...(target.includes("windows") ? ["zig-out-windows"] : []), "zig-out"]
      .flatMap((prefix) => ["bin", "lib"].flatMap((dir) =>
        names.map((name) => resolve(contractRoot, prefix, dir, name)),
      )),
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
  const platformCases = [
    ["x86_64-pc-windows-msvc", "/zig-out-windows/bin/contract.dll"],
    ["aarch64-apple-darwin", "/zig-out/lib/libcontract.dylib"],
    ["x86_64-unknown-linux-gnu", "/zig-out/lib/libcontract.so"],
  ];
  for (const [target, suffix] of platformCases) {
    const candidates = contractLibraryCandidates(target).map((candidate) =>
      candidate.replaceAll("\\", "/"),
    );
    if (!candidates.some((candidate) => candidate.endsWith(suffix))) {
      throw new Error(`missing ${target} Contract candidate: ${suffix}`);
    }
    if (candidates.some((candidate) => candidate.includes("collective"))) {
      throw new Error("collective-only library admitted as a full Contract candidate");
    }
  }
  process.stdout.write("prepare-runtime full Contract candidates: PASS\n");
  process.exit(0);
}

const host = hostTriple();
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.AIKO_TARGET_TRIPLE || host;
const suffix = triple.includes("windows") ? ".exe" : "";
const binaryDirectory = resolve(appRoot, "src-tauri", "binaries");
const destination = join(binaryDirectory, `aiko-${triple}${suffix}`);

const candidates = runtimeCandidates(triple, host);
const source = candidates.find((candidate) => runtimeMatchesAppVersion(candidate, triple, host));
if (!source) {
  throw new Error(
    `No Aiko ${appVersion} runtime was found for ${triple}. Build it first with scripts/contract-runtime.sh build-aiko-only or set AIKO_DESKTOP_RUNTIME. Tried:\n${candidates.join("\n")}`,
  );
}

const contractCandidates = contractLibraryCandidates(triple);
const contractSource = contractCandidates.find(isFile);
if (!contractSource) {
  throw new Error(
    `No full Contract runtime was found for ${triple}. Build ../contract/libcontract for that target or set AIKO_CONTRACT_LIBRARY. Tried:\n${contractCandidates.join("\n")}`,
  );
}

const contractDirectory = resolve(appRoot, "src-tauri", "resources", "contract");
const packagedContractName = triple.includes("windows") ? "contract.dll" : basename(contractSource);
const contractDestination = join(contractDirectory, packagedContractName);

if (process.argv.includes("--check")) {
  process.stdout.write(`Aiko runtime source: ${source}\n`);
  process.stdout.write(`Aiko sidecar destination: ${destination}\n`);
  process.stdout.write(`Contract runtime source: ${contractSource}\n`);
  process.stdout.write(`Contract resource destination: ${contractDestination}\n`);
  process.stdout.write(`prepare-runtime resolution (${triple}): PASS\n`);
  process.exit(0);
}

mkdirSync(binaryDirectory, { recursive: true });
copyIfChanged(source, destination);
if (!triple.includes("windows")) chmodSync(destination, 0o755);

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
  if (staleName !== packagedContractName) {
    rmSync(join(contractDirectory, staleName), { force: true });
  }
}
copyIfChanged(contractSource, contractDestination);
if (!triple.includes("windows")) chmodSync(contractDestination, 0o755);

// Tauri invokes this from beforeBuildCommand. Sign after the copy so a refresh
// cannot replace a release workflow's signed dylib with unsigned bytes.
signAppleContractRuntime(triple, contractDestination);

process.stdout.write(
  `Prepared ${basename(destination)} and ${basename(contractDestination)} for ${triple}\n`,
);
