import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runCell } from "../src/components/runCell.js";

setDefaultTimeout(30_000);
const root = resolve(import.meta.dir, "../../../..");
const cell = join(root, "cell/patterns/hoysan-draft/hoysan-draft.cell.yaml");
const work = mkdtempSync(join(tmpdir(), "hoysan-run-cell-test-"));
const generated = join(work, "inputs");

beforeAll(() => {
  const result = spawnSync("python3", [join(root, "tests/fixtures/hoysan-synthetic/generate.py"), "--out", generated], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "synthetic fixture generation failed");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
const load = (name) => JSON.parse(readFileSync(join(generated, `${name}.json`), "utf8"));

describe("native Cell element fires the actual Hoysan harness", () => {
  test("returns a complete deterministic synthetic draft with provenance", async () => {
    const fired = await runCell({ cell, inputs: load("feasible"), cwd: root });
    expect(fired.outputs.result.validation).toEqual({ ok: true, errors: [] });
    expect(fired.outputs.result.stats).toEqual({ cranes_requested: 3, cranes_filled: 3, workers_deployed: 15 });
    expect(fired.outputs.result.gangs.every((gang) => gang.workers.length === 5)).toBe(true);
    expect(fired.manifest.outputs.result).toMatch(/^[0-9a-f]{64}$/);
    expect(fired.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("propagates hard refusal instead of retaining a partial draft", async () => {
    await expect(runCell({ cell, inputs: load("shortfall"), cwd: root })).rejects.toThrow(/refused|no eligible/i);
  });
});
