import { describe, expect, it } from "vitest";
import {
  hasUnsettledRun,
  isSavedVersion,
  ToolRevisionSession,
  toolInput,
  type ToolInspection,
} from "../src/lib/saved-tools";
import type { WatchRequest } from "../src/lib/browser-watches";
const inspection = (): ToolInspection => ({
  digest: "sha256:original",
  expectedGeneration: 4,
  artifact: {
    name: "json.double",
    description: "Double a number",
    runtime: "javascript",
    contractDigest: "sha256:contract",
    entrypoint: "main.js",
    files: { "main.js": "return input.n * 2;" },
    sources: [],
  },
  contract: {
    outcome: "Double current input",
    inputSchema: { type: "object" },
    outputSchema: { type: "number" },
    effect: "read",
  },
});
function transport(
  respond: (path: string, body: any) => unknown | Promise<unknown>,
) {
  const calls: { path: string; body: any }[] = [];
  const request = (async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    return { available: true, result: await respond(path, body) };
  }) as WatchRequest;
  return { calls, request };
}
describe("saved revision lifecycle", () => {
  it("does not label retired or unknown route state as a saved version", () => {
    expect(
      isSavedVersion(
        { type: "AikoHarnessRetired", harnessDigest: "d", generation: 2 },
        "d",
      ),
    ).toBe(false);
    expect(isSavedVersion({ harnessDigest: "d", generation: 2 }, "d")).toBe(
      false,
    );
    expect(
      isSavedVersion(
        { type: "AikoHarnessPromoted", harnessDigest: "d", generation: 2 },
        "d",
      ),
    ).toBe(true);
  });
  it("retains failed candidates and draft edits without promoting, and gives changed revisions new fixed test IDs", async () => {
    let n = 0;
    const session = new ToolRevisionSession(inspection(), () => String(++n));
    session.files["main.js"] = "return 0;";
    const f = transport((path) =>
      path.endsWith("/revise")
        ? { status: "candidate", digest: "sha256:bad" }
        : {
            status: "failed",
            digest: "sha256:bad",
            evaluationId: "tool-test-1",
          },
    );
    await session.test(f.request);
    expect(session.tested?.status).toBe("failed");
    expect(session.files["main.js"]).toBe("return 0;");
    await expect(session.save(f.request)).rejects.toThrow("Test this revision");
    expect(f.calls).toHaveLength(2);
    session.files["main.js"] = "return input.n + input.n;";
    expect(session.tested).toBeUndefined();
    await session.test(f.request);
    expect(f.calls[3].body.evaluationId).toBe("tool-test-2");
  });
  it("rechecks an uncertain evaluation with the same candidate and evaluation ID", async () => {
    const session = new ToolRevisionSession(inspection(), () => "stable");
    session.description = "A revised description";
    let failed = true;
    const f = transport((path) => {
      if (path.endsWith("/revise"))
        return { status: "candidate", digest: "sha256:next" };
      if (failed) {
        failed = false;
        throw Error("response lost");
      }
      return {
        status: "eligible",
        digest: "sha256:next",
        evaluationId: "tool-test-stable",
      };
    });
    await expect(session.test(f.request)).rejects.toThrow("response lost");
    expect(session.tested?.status).toBe("unknown");
    await session.test(f.request);
    expect(f.calls.filter((c) => c.path.endsWith("/revise"))).toHaveLength(1);
    expect(f.calls[1].body).toEqual(f.calls[2].body);
    expect(session.tested?.status).toBe("eligible");
  });
  it("saving uses the checked candidate and inspected generation, and retains draft on a conflict", async () => {
    const session = new ToolRevisionSession(inspection(), () => "test");
    session.files["main.js"] = "return input.n + input.n;";
    const f = transport((path) => {
      if (path.endsWith("/revise"))
        return { status: "candidate", digest: "sha256:next" };
      if (path.endsWith("/evaluate"))
        return {
          status: "eligible",
          digest: "sha256:next",
          evaluationId: "tool-test-test",
        };
      throw Error("version conflict");
    });
    await session.test(f.request);
    await expect(session.save(f.request)).rejects.toThrow("version conflict");
    expect(f.calls[2].body).toEqual({
      digest: "sha256:next",
      evaluationId: "tool-test-test",
      expectedGeneration: 4,
    });
    expect(session.tested?.status).toBe("eligible");
    expect(session.files["main.js"]).toContain("+");
  });
  it("never resends an uncertain run; checking output is a separate read with the retained ID", async () => {
    const session = new ToolRevisionSession(inspection(), () => "same-id");
    const f = transport((path) => {
      if (path.endsWith("/run")) throw Error("ack lost");
      return {
        status: "satisfied",
        operationId: "tool-run-same-id",
        output: 14,
      };
    });
    await expect(
      session.run(f.request, "sha256:current", { n: 7 }),
    ).rejects.toThrow("ack lost");
    expect(session.runAttempt?.status).toBe("unknown");
    await expect(
      session.run(f.request, "sha256:current", { n: 7 }),
    ).rejects.toThrow("existing run");
    expect(f.calls).toHaveLength(1);
    expect(await session.output(f.request, session.runAttempt!)).toBe(14);
    expect(f.calls[1]).toEqual({
      path: "/harness/library/output",
      body: { operationId: "tool-run-same-id" },
    });
    expect(session.runAttempt?.status).toBe("satisfied");
  });
  it("a mismatched receipt cannot complete the selected run", async () => {
    const session = new ToolRevisionSession(inspection(), () => "ours");
    const f = transport(() => ({
      status: "satisfied",
      operationId: "foreign",
      output: "private",
    }));
    await expect(session.run(f.request, "sha256:current", {})).rejects.toThrow(
      "did not match",
    );
    expect(session.runAttempt?.status).toBe("unknown");
    await expect(
      session.output(f.request, session.runAttempt!),
    ).rejects.toThrow("No checked result");
    expect(session.runOutput).toBeUndefined();
  });
  it("restored unknown or running operations hold new execution", () => {
    expect(
      hasUnsettledRun([{ operationId: "old", digest: "d", status: "unknown" }]),
    ).toBe(true);
    expect(
      hasUnsettledRun([{ operationId: "old", digest: "d", status: "running" }]),
    ).toBe(true);
    expect(
      hasUnsettledRun([
        { operationId: "old", digest: "d", status: "satisfied" },
      ]),
    ).toBe(false);
  });
  it("parses fresh inputs without executing and bounds malformed or oversized JSON", () => {
    expect(toolInput('{"n":9}')).toEqual({ n: 9 });
    expect(() => toolInput("{")).toThrow("valid JSON");
    expect(() => toolInput(JSON.stringify("x".repeat(32769)))).toThrow("32 KB");
  });
});
