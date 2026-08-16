import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SpawnAuthorityAikoAgent,
  confineAikoCwd,
  redactAikoSpawnDiagnostics,
} from "../src/SpawnAuthorityPolicy.js";

const scratch = [];
const mutatedEnvNames = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HOME", "SMITHERS_BASE_CLI_PARENT_SECRET_SENTINEL"];
const originalEnv = Object.fromEntries(mutatedEnvNames.map((name) => [name, process.env[name]]));
afterEach(async () => {
  for (const name of mutatedEnvNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "aiko-spawn-authority-"));
  scratch.push(dir);
  const workspace = path.join(dir, "workspace");
  const bin = path.join(dir, "bin");
  const countFile = path.join(dir, "count");
  await mkdir(workspace);
  await mkdir(bin);
  const executable = path.join(bin, "aiko");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const countFile = ${JSON.stringify(countFile)};
const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;
fs.writeFileSync(countFile, String(count));
const promptAt = process.argv.indexOf("--single");
const prompt = promptAt === -1 ? "" : process.argv[promptAt + 1];
if (prompt === "quota") { console.error("quota exceeded"); process.exit(1); }
if (prompt === "auth") { console.error("401 unauthorized invalid api key"); process.exit(1); }
const receipt = { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() };
process.stdout.write(JSON.stringify({ type: "text", data: JSON.stringify(receipt) }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "receipt", usage: {} }) + "\\n");
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return { dir, workspace, bin, countFile };
}

function makeAgent(f, overrides = {}) {
  return new SpawnAuthorityAikoAgent({
    workspaceRoot: f.workspace,
    runtimeEnv: { PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, LANG: "C" },
    account: {
      id: "operations-1",
      provider: "xai",
      generation: "key-generation-7",
      credential: { name: "XAI_API_KEY", value: "top-secret-xai-key" },
    },
    agent: { model: "grok-code-fast-1", ...overrides },
  });
}

describe("Aiko process spawn authority membrane", () => {
  test("captures the real child argv, cwd, and sealed environment", async () => {
    const f = await fixture();
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-secret";
    process.env.OPENAI_API_KEY = "ambient-openai-secret";
    process.env.HOME = path.join(f.dir, "ambient-home");
    process.env.SMITHERS_BASE_CLI_PARENT_SECRET_SENTINEL = "ambient-parent-secret";

    const agent = makeAgent(f);
    const result = await agent.generate({
      prompt: "receipt",
      rootDir: f.workspace,
      taskContext: { runId: "must-not-cross", attempt: 99 },
    });
    const receipt = JSON.parse(result.text);

    expect(receipt.cwd).toBe(agent.spawnAuthority.cwd);
    expect(receipt.argv).toContain("--permission-mode");
    expect(receipt.argv[receipt.argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(receipt.argv).not.toContain("bypassPermissions");
    expect(receipt.argv.slice(-2)).toEqual(["--single", "receipt"]);
    expect(receipt.env.XAI_API_KEY).toBe("top-secret-xai-key");
    expect(receipt.env.AIKO_AUTH_PROVIDER).toBe("xai");
    expect(receipt.env.AIKO_ACCOUNT_ID).toBe("operations-1");
    expect(receipt.env.AIKO_CREDENTIAL_GENERATION).toBe("key-generation-7");
    expect(receipt.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(receipt.env.OPENAI_API_KEY).toBeUndefined();
    expect(receipt.env.HOME).toBeUndefined();
    expect(receipt.env.SMITHERS_BASE_CLI_PARENT_SECRET_SENTINEL).toBeUndefined();
    expect(receipt.env.SMITHERS_RUN_ID).toBeUndefined();
    expect(receipt.env.SMITHERS_ATTEMPT).toBeUndefined();
  });

  test("canonical confinement refuses lexical and symlink escapes before spawn", async () => {
    const f = await fixture();
    const outside = path.join(f.dir, "outside");
    await mkdir(outside);
    const link = path.join(f.workspace, "looks-inside");
    await symlink(outside, link, "dir");
    expect(() => confineAikoCwd(f.workspace, link)).toThrow("escapes");
    expect(() => new SpawnAuthorityAikoAgent({
      workspaceRoot: f.workspace,
      cwd: outside,
      runtimeEnv: { PATH: f.bin },
      account: { id: "a", provider: "xai", generation: "g", credential: { name: "XAI_API_KEY", value: "s" } },
    })).toThrow("escapes");
    expect(await Bun.file(f.countFile).exists()).toBe(false);
  });

  test("refuses ambient env, mismatched provider credentials, and permission bypass", async () => {
    const f = await fixture();
    const base = {
      workspaceRoot: f.workspace,
      runtimeEnv: { PATH: f.bin },
      account: { id: "a", provider: "xai", generation: "g", credential: { name: "XAI_API_KEY", value: "s" } },
    };
    expect(() => new SpawnAuthorityAikoAgent({ ...base, runtimeEnv: { PATH: f.bin, HOME: "/tmp/ambient" } })).toThrow("allowlist");
    expect(() => new SpawnAuthorityAikoAgent({ ...base, account: { ...base.account, credential: { name: "OPENAI_API_KEY", value: "s" } } })).toThrow("exactly XAI_API_KEY");
    expect(() => new SpawnAuthorityAikoAgent({ ...base, agent: { extraArgs: ["--permission-mode", "bypassPermissions"] } })).toThrow("reserved argument");
    expect(() => new SpawnAuthorityAikoAgent({ ...base, agent: { extraArgs: ["--cwd=/tmp/escape"] } })).toThrow("reserved argument");
  });

  test("quota and authentication failures do not discover or fall back to another account", async () => {
    const f = await fixture();
    const agent = makeAgent(f);
    await expect(agent.generate({ prompt: "quota" })).rejects.toMatchObject({ code: "AGENT_QUOTA_EXCEEDED" });
    expect(await readFile(f.countFile, "utf8")).toBe("1");
    await expect(agent.generate({ prompt: "auth" })).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
    expect(await readFile(f.countFile, "utf8")).toBe("2");
  });

  test("diagnostics redact prompt, resume, and every credential value", async () => {
    const diagnostic = redactAikoSpawnDiagnostics({
      command: "aiko",
      args: ["--model", "grok", "--rules", "secret rules", "--single", "secret prompt", "--resume=session-secret"],
      cwd: "/workspace",
      env: { PATH: "/bin", XAI_API_KEY: "secret-key", AIKO_CREDENTIAL_GENERATION: "generation-7" },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(diagnostic.args).toEqual(["--model", "grok", "--rules", "[REDACTED]", "--single", "[REDACTED]", "--resume=[REDACTED]"]);
    expect(diagnostic.env.XAI_API_KEY).toBe("[REDACTED]");
    expect(diagnostic.env.AIKO_CREDENTIAL_GENERATION).toBe("[REDACTED]");
    expect(diagnostic.env.PATH).toBe("/bin");
  });
});
