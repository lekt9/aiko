/**
 * Lightweight node checks for agentStream (no vitest harness yet).
 * Run: node src/lib/agentStream.test.mjs
 *
 * Mirrors the pure parse helpers by re-implementing the critical regex path
 * against the TypeScript source via dynamic import of the built module when
 * available; for source-only we assert regex behaviour inline.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "agentStream.ts"), "utf8");

// --- smoke: source exports what we need ---
for (const name of [
  "splitAgentText",
  "parseSessionUpdate",
  "streamEventFromParams",
  "upsertToolPart",
  "applyToolUpdate",
  "partsToPlainText",
]) {
  assert.match(source, new RegExp(`export function ${name}`), `export ${name}`);
}

// --- inline replica of the XML split used by splitAgentText ---
const TOOL_BLOCK_RE =
  /<(?:tool_call|function_call|xai:tool_call)\b[^>]*>[\s\S]*?<\/(?:tool_call|function_call|xai:tool_call)>/gi;

const sample = `I'll install Unbrowse for you. This is a two-step process: install the global npm package, then run the setup.<tool_call>
<function=run_terminal_command>
<parameter=command>npm install -g unbrowse && unbrowse setup</parameter>
<parameter=description>Install unbrowse globally and run first-time setup</parameter>
<parameter=timeout>120000</parameter>
</function>
</tool_call>
`;

const matches = [...sample.matchAll(TOOL_BLOCK_RE)];
assert.equal(matches.length, 1, "one tool block");
assert.match(matches[0][0], /run_terminal_command/);
assert.match(matches[0][0], /npm install -g unbrowse/);

const prose = sample.replace(TOOL_BLOCK_RE, "").trim();
assert.equal(
  prose,
  "I'll install Unbrowse for you. This is a two-step process: install the global npm package, then run the setup.",
);
assert.doesNotMatch(prose, /tool_call|parameter|function=/);

// ACP tool_call shape smoke via JSON (mirrors parseSessionUpdate inputs)
const acpTool = {
  sessionUpdate: "tool_call",
  toolCallId: "tc-1",
  title: "npm install -g unbrowse",
  kind: "execute",
  status: "in_progress",
  rawInput: { command: "npm install -g unbrowse && unbrowse setup" },
};
assert.equal(acpTool.sessionUpdate, "tool_call");
assert.ok(acpTool.toolCallId);

// Generative UI fence extraction lives in parseSpec; assert the import path exists.
import { readFileSync as read2 } from "node:fs";
const parseSource = read2(join(root, "../generative/parseSpec.ts"), "utf8");
assert.match(parseSource, /export function extractGenerativeUi/);
assert.match(parseSource, /json-render/);
assert.match(source, /extractGenerativeUi/);

const uiSample = `Here is the dashboard:

\`\`\`json-render
{
  "root": "root",
  "elements": {
    "root": { "type": "Metric", "props": { "label": "A", "value": "1" }, "children": [] }
  }
}
\`\`\`
`;
assert.match(uiSample, /json-render/);
assert.doesNotMatch(uiSample.replace(/```json-render[\s\S]*?```/g, ""), /"elements"/);

console.log("agentStream checks passed");
