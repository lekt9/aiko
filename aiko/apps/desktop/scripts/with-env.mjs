#!/usr/bin/env node
// with-env.mjs — load repo-root .env into the child command's environment.
// No secrets are ever printed; only redacted previews (length + last 4) go to stderr.
// Usage: node scripts/with-env.mjs -- <command> [args...]
//        npm run installer:prep   (wraps ../../scripts/prep-installer.sh with .env)

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

function redact(v) {
  if (!v) return "<empty>";
  const n = v.length;
  const tail = n >= 4 ? v.slice(-4) : "";
  return tail ? `<${n} chars…${tail}>` : `<${n} chars>`;
}

function parseEnvFile(path) {
  const out = {};
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // strip surrounding single/double quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

const thisDir = dirname(new URL(import.meta.url).pathname);
// repo root is two levels up from apps/desktop/scripts
const candidates = [
  resolve(thisDir, "../../../.env"),
  resolve(thisDir, "../../.env"),
  resolve(thisDir, "../.env"),
  resolve(thisDir, ".env"),
];

let loaded = null;
let loadedPath = null;
for (const p of candidates) {
  if (existsSync(p)) {
    loaded = parseEnvFile(p);
    loadedPath = p;
    break;
  }
}

// find "--" separator
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1 || sep === argv.length - 1) {
  console.error("usage: node scripts/with-env.mjs -- <command> [args...]");
  if (loadedPath) console.error(`would load: ${loadedPath}`);
  else console.error(`no .env found (looked in ${candidates.join(", ")})`);
  process.exit(2);
}

const cmd = argv[sep + 1];
const args = argv.slice(sep + 2);

// build child env: only inject keys not already set (explicit env wins)
const childEnv = { ...process.env };
let injected = 0;
if (loaded) {
  for (const [k, v] of Object.entries(loaded)) {
    if (!(k in childEnv) || childEnv[k] === "") {
      childEnv[k] = v;
      injected++;
    }
  }
  console.error(`with-env: loaded ${loadedPath} — injected ${injected} vars`);
  // redacted preview for the notarization-relevant keys only
  for (const k of ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_PASSWORD", "AIKO_API_KEY", "SURPLUS_API_KEY", "API_KEY", "AIKO_TOKEN", "SMITHERY_API_KEY", "TWOCAPTCHA_KEY"]) {
    if (k in (loaded || {})) {
      console.error(`  ${k} ${redact(childEnv[k])}`);
    }
  }
} else {
  console.error(`with-env: no .env found — running without injection (looked in ${candidates.join(", ")})`);
}

const result = spawnSync(cmd, args, { stdio: "inherit", env: childEnv });
process.exit(result.status ?? 1);
