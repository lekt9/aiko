import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareState, cloudflareStatePath, cloudflareOperatorConfig } from "./cloudflare-paths.ts";

test("cloud operations need no native state and respect CI overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiko-config-test-"));
  try {
    const path = join(dir, "deployment.env");
    await writeFile(path, "AIKO_E2E_OWNER=acct_portable_test\nAIKO_E2E_TOKEN=file-token\n", { mode: 0o600 });
    const env = { AIKO_CLOUDFLARE_STATE_FILE: path, AIKO_E2E_TOKEN: "ci-token", UNRELATED_SECRET: "excluded" };
    expect(await cloudflareState(env)).toEqual({ AIKO_E2E_OWNER: "acct_portable_test", AIKO_E2E_TOKEN: "ci-token" });
    expect(cloudflareStatePath({ XDG_CONFIG_HOME: dir })).toBe(join(dir, "unbrowse/aiko-cloudflare.env"));
    const operatorToken = "synthetic-operator-token-1234567890";
    expect(await cloudflareOperatorConfig({ AIKO_SECRET_FILE: join(dir, "absent.env"), AIKO_OPERATOR_TOKEN: operatorToken })).toEqual({ operatorToken, modelKey: undefined, botToken: undefined });
    expect(await readdir(dir)).toEqual(["deployment.env"]);
    await expect(cloudflareOperatorConfig({ XDG_CONFIG_HOME: dir, AIKO_SECRET_FILE: join(dir, "absent.env") })).rejects.toThrow("AIKO_OPERATOR_TOKEN");
    await chmod(path, 0o644);
    await expect(cloudflareState(env)).rejects.toThrow("owner-only");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
