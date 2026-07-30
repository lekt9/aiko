import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("./native", () => ({
  isAvailable: () => false,
  declare: () => null,
}));

import { buildSpawnCommand } from "./neurons";

describe("contract neuron process invocation", () => {
  it("runs the installed stateless Aiko interface with contract lineage", () => {
    const invocation = buildSpawnCommand(
      "tell me when Alethea messages",
      { cwd: "/tmp/project", maxToolRounds: 12, env: { AIKO_BIN: "/opt/aiko" } },
      "abcd1234",
      "deadbeef",
    );
    expect(invocation.command).toBe("/opt/aiko");
    expect(invocation.args).toContain("-p");
    expect(invocation.args).toContain("--no-memory");
    expect(invocation.args).toContain("tell me when Alethea messages");
    expect(invocation.env.AIKO_CONTRACT_PARENT_ID).toBe("abcd1234");
    expect(invocation.env.AIKO_CONTRACT_ID).toBe("deadbeef");
    expect(invocation.env.AIKO_CONTRACT_ROOT_ID).toBe("abcd1234");
    expect(invocation.env.AIKO_CONTRACT_DEPTH).toBe("1");
    expect(invocation.env.AIKO_CONTRACT_MAX_DEPTH).toBe("4");
    expect(invocation.env.AIKO_CONTRACT_REMAINING_CHILDREN).toBe("64");
    expect(invocation.env.AIKO_CONTRACT_CANCEL_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
    expect(invocation.args).not.toContain("dist/index.js");
  });

  it("inherits one cancellation domain through descendants", () => {
    const invocation = buildSpawnCommand(
      "child",
      { env: { AIKO_CONTRACT_CANCEL_TOKEN: "root-cancel-token" } },
      "abcd1234",
      "deadbeef",
    );
    expect(invocation.env.AIKO_CONTRACT_CANCEL_TOKEN).toBe("root-cancel-token");
  });
});
