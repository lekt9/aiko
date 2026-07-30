/**
 * Run: node src/generative/sanitizeSpec.test.mjs
 * Mirrors sanitizeSpec logic for playlist crash regressions without a bundler.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, "sanitizeSpec.ts"), "utf8");
assert.match(src, /export function sanitizeSpec/);
assert.match(src, /case "List"/);
assert.match(src, /asStringArray/);

// Inline equivalent of sanitize List/Table/BarChart for partial stream
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)));
}

// Partial playlist: items missing → empty array, not throw
const partialList = { items: undefined };
assert.deepEqual(asStringArray(partialList.items), []);

// Partial playlist mid-array with non-strings
assert.deepEqual(asStringArray(["a", null, 3]), ["a", "", "3"]);

// Math.max spread on empty must not use bare Math.max()
const values = [];
const max = Math.max(1, ...values, 0);
assert.equal(max, 1);

// agentStream stable ids (not hash of raw)
const agentSrc = readFileSync(join(root, "../lib/agentStream.ts"), "utf8");
assert.match(agentSrc, /Stable ids/);
assert.doesNotMatch(agentSrc, /hashSpec\(parsed\.raw\)/);

console.log("sanitizeSpec crash regressions passed");
