#!/usr/bin/env node
/**
 * Aiko App in-process Remote IM bridge launcher.
 * Prefer dist/; fail clearly if not built.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");

if (!existsSync(distEntry)) {
  console.error(`aiko-remote-bridge: missing build at ${distEntry}
Run: cd remote-bridge && npm install && npm run build
`);
  process.exit(1);
}

await import(pathToFileURL(distEntry).href);
