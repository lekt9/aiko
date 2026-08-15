import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Write a tauri.release.conf.json with release-only overrides.
//
// Tauri's --config flag merges the provided JSON on top of the base
// tauri.conf.json, so this file must contain ONLY the delta fields —
// not a copy of the base config.
//
// Release builds emit:
// 1. bundle.createUpdaterArtifacts = true so Tauri produces the .tar.gz
//    (or platform archive) and .sig during the build.
// 2. plugins.updater with pubkey + endpoint from env vars.
//    Both AIKO_UPDATER_PUBLIC_KEY and AIKO_UPDATER_ENDPOINT are required.
//
// Usage (CI):
//   AIKO_UPDATER_PUBLIC_KEY=... \
//   AIKO_UPDATER_ENDPOINT=https://github.com/<org>/<repo>/releases/download/aiko-desktop-latest/latest.json \
//   node scripts/build-release-config.mjs
//
// Then:
//   pnpm tauri build --config src-tauri/tauri.release.conf.json
// with the same AIKO_UPDATER_* env vars so build.rs enables the plugin.

const outputConfigPath = resolve(
  process.cwd(),
  "src-tauri/tauri.release.conf.json",
);

const updaterPubkey = process.env.AIKO_UPDATER_PUBLIC_KEY;
const updaterEndpoint = process.env.AIKO_UPDATER_ENDPOINT;

const missing = [];
if (!updaterPubkey) missing.push("AIKO_UPDATER_PUBLIC_KEY");
if (!updaterEndpoint) missing.push("AIKO_UPDATER_ENDPOINT");
if (missing.length > 0) {
  console.error(
    `Error: required environment variable(s) missing: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const releaseConfig = {
  bundle: {
    macOS: {
      minimumSystemVersion: "11.0",
    },
    // `app` is required so Tauri emits signed .app.tar.gz for macOS silent update.
    // Installer targets stay in base tauri.conf.json (dmg / nsis / appimage / …).
    createUpdaterArtifacts: true,
  },
  plugins: {
    updater: {
      pubkey: updaterPubkey,
      endpoints: [updaterEndpoint],
    },
  },
};

const pubkeyPreview =
  updaterPubkey.length > 24
    ? `${updaterPubkey.slice(0, 12)}…${updaterPubkey.slice(-8)}`
    : "(short key)";
console.log(`Updater enabled -> ${updaterEndpoint}`);
console.log(`Pubkey prefix   -> ${pubkeyPreview}`);

writeFileSync(outputConfigPath, `${JSON.stringify(releaseConfig, null, 2)}\n`);
console.log(`Wrote ${outputConfigPath}`);
console.log(
  "Next: pnpm tauri build --config src-tauri/tauri.release.conf.json",
);
console.log(
  "(same AIKO_UPDATER_* env vars must be set so build.rs enables registration)",
);
