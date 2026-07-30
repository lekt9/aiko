import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..", "..");
const version = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8")).version;
const target = "x86_64-pc-windows-msvc";
const output = resolve(root, "dist/windows-x86_64");
const portableName = `Aiko-${version}-windows-x86_64-portable`;
const installerName = `Aiko-${version}-windows-x86_64-installer`;
const portable = resolve(output, portableName);
const installer = resolve(output, installerName);
const payload = resolve(installer, "payload");

function firstExisting(candidates, label) {
  const result = candidates.find((path) => path && existsSync(path));
  if (!result) throw new Error(`Missing ${label}. Checked:\n${candidates.join("\n")}`);
  return result;
}

const runtime = firstExisting([
  process.env.AIKO_WINDOWS_RUNTIME,
  resolve(root, `target/${target}/release/aiko.exe`),
  resolve(root, `target/${target}/release/xai-grok-pager.exe`),
  resolve(root, `apps/desktop/src-tauri/binaries/aiko-${target}.exe`),
], "Windows Aiko runtime");
const desktop = firstExisting([
  process.env.AIKO_WINDOWS_DESKTOP,
  resolve(root, `apps/desktop/src-tauri/target/${target}/release/aiko-desktop.exe`),
  resolve(output, `${portableName}/aiko-desktop.exe`),
], "Windows Aiko desktop executable");
const contract = firstExisting([
  process.env.AIKO_WINDOWS_CONTRACT,
  resolve(root, "../contract/libcontract/zig-out-windows/bin/contract.dll"),
], "full Windows Contract DLL");

rmSync(portable, { recursive: true, force: true });
rmSync(installer, { recursive: true, force: true });
mkdirSync(portable, { recursive: true });
mkdirSync(resolve(portable, "contract"), { recursive: true });
mkdirSync(resolve(portable, "skills"), { recursive: true });
mkdirSync(payload, { recursive: true });

copyFileSync(runtime, resolve(portable, "aiko.exe"));
copyFileSync(desktop, resolve(portable, "aiko-desktop.exe"));
copyFileSync(contract, resolve(portable, "contract", "contract.dll"));
copyFileSync(runtime, resolve(payload, "aiko.exe"));
copyFileSync(desktop, resolve(payload, "aiko-desktop.exe"));
copyFileSync(contract, resolve(payload, "contract.dll"));
for (const name of [
  "inspect-project", "build-and-test-project", "transform-local-files",
  "observe-desktop", "schedule-follow-up", "apply-standing-rule",
  "act-on-web-api", "send-notification", "control-local-media", "issue-to-patch",
]) {
  const source = resolve(root, ".agents/skills", name);
  cpSync(source, resolve(portable, "skills", name), { recursive: true });
  cpSync(source, resolve(payload, "skills", name), { recursive: true });
}
cpSync(resolve(root, "apps/desktop/installer/windows"), installer, { recursive: true });
copyFileSync(resolve(root, "apps/desktop/installer/windows/README.txt"), resolve(portable, "README.txt"));

function zip(directory, archive) {
  rmSync(archive, { force: true });
  const result = spawnSync("zip", ["-q", "-r", archive, basename(directory)], {
    cwd: output,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`zip failed for ${directory}`);
}

mkdirSync(output, { recursive: true });
zip(portable, resolve(output, `${portableName}.zip`));
zip(installer, resolve(output, `${installerName}.zip`));

const artifacts = [
  `${portableName}.zip`,
  `${installerName}.zip`,
  `${portableName}/aiko.exe`,
  `${portableName}/aiko-desktop.exe`,
  `${portableName}/contract/contract.dll`,
];
const sums = artifacts.map((relative) => {
  const bytes = readFileSync(resolve(output, relative));
  return `${createHash("sha256").update(bytes).digest("hex")}  ${relative}`;
});
writeFileSync(resolve(output, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.log(`Packaged ${portableName} and ${installerName} with ${basename(contract)}`);
