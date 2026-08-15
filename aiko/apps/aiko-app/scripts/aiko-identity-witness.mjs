#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function requireMatch(path, source, pattern, message) {
  if (!pattern.test(source)) failures.push(`${path}: ${message}`);
}

function forbidMatch(path, source, pattern, message) {
  if (pattern.test(source)) failures.push(`${path}: ${message}`);
}

function walkTs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.name !== "aiko-app") {
  failures.push(`package.json: expected package name aiko-app, got ${packageJson.name}`);
}
if (packageJson.version !== "0.2.115") {
  failures.push(`package.json: expected composition-root version 0.2.115, got ${packageJson.version}`);
}
if (!String(packageJson.description).includes("Aiko App")) {
  failures.push("package.json: description must identify Aiko App");
}
if (!String(packageJson.description).includes("embedded Aiko CLI")) {
  failures.push("package.json: description must name the embedded Aiko CLI");
}
if (packageJson.repository?.url !== "https://github.com/RongleCat/grok-app.git") {
  failures.push("package.json: preserve the authoritative upstream repository URL until an Aiko URL exists");
}

const cargo = read("src-tauri/Cargo.toml");
requireMatch("src-tauri/Cargo.toml", cargo, /^\[workspace\]\n\n\[package\]/, "app must remain an isolated Cargo workspace");
requireMatch("src-tauri/Cargo.toml", cargo, /^name = "aiko-app"$/m, "package name is not aiko-app");
requireMatch("src-tauri/Cargo.toml", cargo, /^version = "0\.2\.115"$/m, "package version does not match the Aiko composition root (0.2.115)");
requireMatch("src-tauri/Cargo.toml", cargo, /^name = "aiko_app_lib"$/m, "library name is not aiko_app_lib");
requireMatch("src-tauri/Cargo.toml", cargo, /^description = "Aiko App — native desktop workbench for the embedded Aiko CLI"$/m, "description does not identify Aiko App and its embedded CLI");
forbidMatch("src-tauri/Cargo.toml", cargo, /^name = "grok-app"$/m, "legacy package identity remains");
forbidMatch("src-tauri/Cargo.toml", cargo, /^name = "grok_app_lib"$/m, "legacy library identity remains");

const main = read("src-tauri/src/main.rs");
requireMatch("src-tauri/src/main.rs", main, /aiko_app_lib::run\(\);/, "binary does not enter aiko_app_lib");
forbidMatch("src-tauri/src/main.rs", main, /grok_app_lib::run\(\);/, "binary still enters grok_app_lib");

const cargoLock = read("src-tauri/Cargo.lock");
requireMatch("src-tauri/Cargo.lock", cargoLock, /\[\[package\]\]\nname = "aiko-app"\nversion = "0\.2\.115"/, "lockfile identity does not match aiko-app 0.2.115");
forbidMatch("src-tauri/Cargo.lock", cargoLock, /\[\[package\]\]\nname = "grok-app"/, "legacy package identity remains in the lockfile");

const html = read("index.html");
requireMatch("index.html", html, /<title>Aiko<\/title>/, "document title is not Aiko");
requireMatch("index.html", html, /Welcome to Aiko/, "boot shell does not identify Aiko");
forbidMatch("index.html", html, /<title>Grok<\/title>|Welcome to Grok|欢迎使用 Grok|歡迎使用 Grok/, "legacy product identity remains in the boot shell");

const i18nRoot = join(root, "src/i18n");
const i18nFiles = walkTs(i18nRoot);
const catalogs = i18nFiles
  .map((path) => [relative(root, path), readFileSync(path, "utf8")])
  .filter(([path]) => path.includes("/messages/"));
const allCatalogText = catalogs.map(([, source]) => source).join("\n");

const requiredCatalogIdentities = [
  /"app\.name": "Aiko"/,
  /"app\.versionFooter": "Aiko v0\.2\.115/,
  /"tray\.tooltip": "Aiko"/,
  /"message\.nodes\.assistant": "Aiko"/,
  /"setup\.title": "Welcome to Aiko"/,
  /"setup\.title": "欢迎使用 Aiko"/,
  /"setup\.title": "歡迎使用 Aiko"/,
  /"tutorial\.step\.welcome\.title": "Welcome to Aiko App"/,
  /"tutorial\.step\.welcome\.title": "欢迎使用 Aiko App"/,
  /"tutorial\.step\.welcome\.title": "歡迎使用 Aiko App"/,
  /"settings\.aboutApp": "About Aiko App"/,
  /"settings\.aboutApp": "关于 Aiko App"/,
  /"settings\.aboutApp": "關於 Aiko App"/,
];
for (const pattern of requiredCatalogIdentities) {
  requireMatch("src/i18n/messages/**", allCatalogText, pattern, `missing ${pattern}`);
}

const legacyProductPatterns = [
  /"app\.name": "Grok"/,
  /"app\.versionFooter": "Grok v/,
  /"tray\.tooltip": "Grok"/,
  /"message\.nodes\.assistant": "Grok"/,
  /Grok App/,
  /Grok Build|Grok CLI/,
  /`grok(?:\s|`)/,
  /GROK_HOME|~\/\.grok(?:\/|\b)/,
  /Welcome to Grok|欢迎使用 Grok|歡迎使用 Grok/,
  /Enter Grok|进入 Grok|進入 Grok/,
  /Open Grok|Quit Grok|打开 Grok|開啟 Grok|退出 Grok|結束 Grok/,
  /Grok (?:desktop|window|is open|finished a turn)/,
  /Grok (?:桌面|窗口|視窗|应用|應用|打开|開啟|已完成)/,
  /(?:Start|Keep) (?:the )?Grok/,
  /(?:open|reopen) Grok again/,
];
for (const [path, source] of catalogs) {
  for (const pattern of legacyProductPatterns) {
    forbidMatch(path, source, pattern, `legacy product identity matched ${pattern}`);
  }
}

const preservedUpstreamTokens = [
  ["Official Grok", /Official Grok/],
  ["SuperGrok", /SuperGrok/],
  ["Grok Imagine", /Grok Imagine/],
  ["grok-4.5", /grok-4\.5/],
];
for (const [label, pattern] of preservedUpstreamTokens) {
  requireMatch("src/i18n/messages/**", allCatalogText, pattern, `upstream/provider token ${label} was removed`);
}

const activeProductFiles = [
  "package.json",
  "README.md",
  "docs/BUILD.md",
  "docs/desktop-auto-update.md",
  "scripts/build-release-config.mjs",
  "scripts/assemble-updater-manifest.sh",
  "scripts/generate-latest-json.sh",
  "scripts/verify-updater-setup.sh",
  "scripts/probe-models.sh",
  "scripts/official-aux-mcp.mjs",
  "scripts/package-windows-portable.sh",
  "scripts/chatcut-plugin-start.mjs",
  "scripts/prepare-runtime.mjs",
];
const activeLegacyPatterns = [
  /Grok App|Grok Build|Grok CLI|grok CLI/,
  /GROK_UPDATER|grok-desktop-latest|\/tmp\/grok-(?:updater|latest|model-probe)/,
  /(?:command -v|spawnSync\()\s*["']?grok\b/,
  /["']grok["']\s*,\s*\[(?:"|')?(?:agent|update|plugin|mcp|models|leader|sessions|worktree)/,
  /GROK_HOME|~\/\.grok(?:\/|\b)|~\/\.grok-app/,
  /homedir\(|pathCandidate\(|process\.env\.PATH/,
];
for (const path of activeProductFiles) {
  const source = read(path);
  for (const pattern of activeLegacyPatterns) {
    forbidMatch(path, source, pattern, `legacy product/runtime identity matched ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error("Aiko identity witness: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Aiko identity witness: PASS (${catalogs.length} catalog files checked)`);
