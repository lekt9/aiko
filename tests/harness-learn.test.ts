import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The self-learning loop distills harness_retry trace events into lessons.
 * Regression: an event with reason:"" masked its error field (`??` never fell
 * through), producing opaque "attempt=?" lessons the fixer agent could not
 * act on. The miner must fall back to the error and keep the attempt number.
 */
describe("harness-learn miner", () => {
  it("surfaces the error and attempt of harness_retry events with empty reason", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-learn-"));
    try {
      const traces = path.join(root, "graff", "traces");
      fs.mkdirSync(traces, { recursive: true });
      fs.writeFileSync(
        path.join(traces, "trace.jsonl"),
        `${JSON.stringify({
          ev: "subagent_retry",
          reason: "",
          error: "api error: credits exhausted",
          attempt: 2,
        })}\n${JSON.stringify({ ev: "retry", reason: "timeout" })}\n`,
      );
      execFileSync("node", ["scripts/harness-learn.mjs", "--logs", path.join(root, "graff"), "--out", path.join(root, "out"), "--since-days", "14"], { cwd: process.cwd() });
      const lessonsFile = fs
        .readdirSync(path.join(root, "out"))
        .filter((f) => f.startsWith("lessons-") && f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(root, "out", f), "utf8")))[0];
      const retries = lessonsFile.lessons.filter((l: { kind: string }) => l.kind === "harness_retry");
      expect(retries).toHaveLength(2);
      const byTool = Object.fromEntries(retries.map((l: { tool: string; detail: string }) => [l.tool, l.detail]));
      expect(byTool.subagent_retry).toContain("credits exhausted");
      expect(byTool.subagent_retry).toContain("attempt=2");
      expect(byTool.retry).toContain("timeout");
      // distinct context must not collapse into one fingerprint
      expect(new Set(retries.map((l: { fingerprint: string }) => l.fingerprint)).size).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
