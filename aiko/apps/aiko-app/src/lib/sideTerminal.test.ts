import { describe, expect, it } from "vitest";
import {
  formatTerminalCommand,
  resolveTerminalSpawnPlan,
} from "./sideTerminal";

describe("resolveTerminalSpawnPlan", () => {
  it("uses $SHELL with -l -i and project cwd", () => {
    const plan = resolveTerminalSpawnPlan({
      env: { SHELL: "/bin/zsh", HOME: "/Users/me" },
      projectPath: "/Users/me/proj",
    });
    expect(plan.shell).toBe("/bin/zsh");
    expect(plan.args).toEqual(["-l", "-i"]);
    expect(plan.cwd).toBe("/Users/me/proj");
    expect(plan.fromEnv).toBe(true);
    expect(formatTerminalCommand(plan)).toBe("/bin/zsh -l -i");
  });

  it("falls back to home when no project", () => {
    const plan = resolveTerminalSpawnPlan({
      env: { SHELL: "/bin/bash", HOME: "/home/u" },
      projectPath: null,
    });
    expect(plan.cwd).toBe("/home/u");
  });

  it("defaults shell when SHELL missing", () => {
    const plan = resolveTerminalSpawnPlan({
      env: { HOME: "/Users/x" },
      platform: "darwin",
    });
    expect(plan.shell).toBe("/bin/zsh");
    expect(plan.fromEnv).toBe(false);
    expect(plan.args).toEqual(["-l", "-i"]);
  });
});
