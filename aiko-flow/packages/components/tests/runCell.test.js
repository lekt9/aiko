import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCellRunner, runCell } from "../src/components/runCell.js";

setDefaultTimeout(30_000);

const here = dirname(fileURLToPath(import.meta.url));
const helloCell = resolve(here, "../../../../cell/example/hello.cell.yaml");
const selfWire = resolve(here, "../../../../cell/patterns/fde/self-wire.cell.yaml");

describe("runCell", () => {
  test("finds cell/run.py from this monorepo", () => {
    const runner = findCellRunner();
    expect(runner.endsWith("cell/run.py")).toBe(true);
  });

  test("fires hello.cell.yaml", async () => {
    const fired = await runCell({ cell: helloCell, inputs: {} });
    expect(fired.outputs.greeting).toBe("hello world");
  });

  test("seats Aiko through self-wire cell", async () => {
    const fired = await runCell({
      cell: selfWire,
      inputs: {
        account: { tenant: "acme", origin: "https://mail.example", account_id: "aiko-ops" },
        role: "ops-staffer",
        outcome: "own daily roster confirmation",
      },
    });
    expect(fired.outputs.handoff.agent).toBe("aiko");
    expect(String(fired.outputs.handle.id).startsWith("cred:")).toBe(true);
  });
});
