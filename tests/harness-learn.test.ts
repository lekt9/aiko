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
  it("discovers account fields and distinguishes blocked responses from successful receipts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-remote-"));
    try {
      const preload = path.join(root, "fetch.mjs");
      fs.writeFileSync(preload, `globalThis.fetch = async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/accounts')) return Response.json({accounts:[{account:'fixture-owner',threads:1}]});
        if (url.searchParams.get('account') !== 'fixture-owner') return Response.json({threads:[]});
        return Response.json({threads:[{thread:'user-fixture-owner',events:[
          ...['queued','completed','listed','processed','ready'].map(status=>({type:'ToolReturned',result:{kind:'fixture',status}})),
          {type:'AikoResponseRequested',outcome:'blocked',output:'private user content'},
          {type:'AikoDeliverySettled',result:{status:'rejected',reason:'invalid_request'}}
        ]}]});
      };`);
      execFileSync("node", ["--import", preload, "scripts/harness-learn.mjs", "--logs", path.join(root,"empty"), "--out", path.join(root,"out"), "--remote-url", "https://fixture.invalid", "--remote-token", "fixture", "--tardigrade", path.join(root,"none")], {timeout:15000});
      const report = JSON.parse(fs.readFileSync(path.join(root,"out",fs.readdirSync(path.join(root,"out")).find(f=>f.startsWith("lessons-")&&f.endsWith(".json"))!),"utf8"));
      expect(report.remote).toMatchObject({accounts_found:1,threads:1,events:7});
      expect(report.lessons.map((l: any)=>l.kind).sort()).toEqual(["delivery_rejected","response_blocked"]);
      expect(report.lessons.find((l:any)=>l.kind==="delivery_rejected").detail).toContain("invalid_request");
      expect(JSON.stringify(report)).not.toContain("private user content");
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  }, 20000);
  it("surfaces the error and attempt of harness_retry events with empty reason", () => { // spawns node; needs headroom beyond the default 5s under parallel workers
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
      // Keep this fixture independent of the operator's live accounts and local logs.
      execFileSync("node", ["scripts/harness-learn.mjs", "--logs", path.join(root, "graff"), "--out", path.join(root, "out"), "--since-days", "14", "--no-remote", "--tardigrade", path.join(root, "tardigrade")], { cwd: process.cwd(), timeout: 15_000 });
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
  }, 20_000);
});
