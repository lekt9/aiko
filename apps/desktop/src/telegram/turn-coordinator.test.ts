import { describe, expect, it } from "vitest";
import { createTurnCoordinator } from "./turn-coordinator";

describe("createTurnCoordinator", () => {
  it("runs independent contracts concurrently but respects its bound", async () => {
    const coordinator = createTurnCoordinator(2);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = () =>
      coordinator.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await barrier;
        active--;
      });

    const jobs = [run(), run(), run()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    expect(coordinator.active).toBe(2);
    release();
    await Promise.all(jobs);
    expect(coordinator.active).toBe(0);
  });
});
