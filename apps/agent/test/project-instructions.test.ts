import { afterEach, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { Self } from "tardie/core/runtime";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectContext, PROJECT_FILE_MAX_BYTES } from "../src/project-instructions.ts";
import { projectFilesystemSource } from "../src/project-instructions-node.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiko-project-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  const source = projectFilesystemSource(root), current = { cwd: "src/feature" };
  const options = { owner: "ownerA", thread: "user-ownerA", source, current: () => current.cwd, redact: (text: string) => text.replaceAll("KNOWN_SECRET", "[redacted]") };
  return { root, put, source, current, options, project: new ProjectContext(options) };
}
const request: InferRequest = { identity: { actor: "aiko", instance: "test", thread: "user-ownerA", turn: "turn" }, trajectory: [], system: "HOST AUTHORITY AND TOOL GRANTS", tools: [] };
const inference = (project: ProjectContext) => {
  const seen: InferRequest[] = [];
  const layer = project.inference(Layer.succeed(Infer, { react: request => Effect.sync(() => { seen.push(request); return { kind: "complete" as const, output: "ok" }; }) }));
  return { seen, run: (value = request) => Effect.runPromise(Effect.gen(function* () { const service = yield* Infer; return yield* service.react(value, "native-attempt"); }).pipe(Effect.provide(layer))) };
};

test("inference loads root-to-cwd AGENTS and CLAUDE guidance afresh while preserving host precedence", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT RULE KNOWN_SECRET"); await f.put("CLAUDE.md", "ROOT CLAUDE RULE");
  await f.put("src/AGENTS.md", "SOURCE RULE"); await f.put("src/feature/AGENTS.md", "FEATURE RULE");
  await f.put("unrelated/AGENTS.md", "UNRELATED MUST NOT LOAD");
  const model = inference(f.project);
  expect(await model.run()).toMatchObject({ kind: "complete" });
  const system = model.seen[0]!.system;
  expect(system.startsWith(request.system)).toBe(true);
  expect(system.indexOf("ROOT RULE")).toBeLessThan(system.indexOf("ROOT CLAUDE RULE"));
  expect(system.indexOf("ROOT CLAUDE RULE")).toBeLessThan(system.indexOf("SOURCE RULE"));
  expect(system.indexOf("SOURCE RULE")).toBeLessThan(system.indexOf("FEATURE RULE"));
  expect(system).not.toContain("KNOWN_SECRET"); expect(system).not.toContain("UNRELATED MUST NOT LOAD");
  await f.put("src/feature/AGENTS.md", "FRESH FEATURE RULE");
  await model.run(); expect(model.seen[1]!.system).toContain("FRESH FEATURE RULE");
  f.current.cwd = "src";
  await model.run(); expect(model.seen[2]!.system).not.toContain("FEATURE RULE");
  expect(model.seen[2]!.tools).toEqual([]);
});

test("scoped skill discovery uses local precedence and requires explicit body loading", async () => {
  const f = await fixture();
  await f.put(".agents/skills/lint/SKILL.md", "---\nname: lint\ndescription: Root lint description\n---\nROOT PRIVATE BODY");
  await f.put("src/.codex/skills/lint/SKILL.md", "---\nname: lint\ndescription: >-\n  Local lint\n  description\n---\nEXPLICIT BODY MUST NOT AUTOLOAD");
  await f.put(".claude/skills/review/SKILL.md", '---\nname: review\ndescription: "Review repository changes"\n---\nREVIEW BODY');
  const manifest = await f.project.manifest();
  expect(manifest.skills.find(skill => skill.name === "lint")).toMatchObject({ path: "src/.codex/skills/lint/SKILL.md", description: "Local lint description" });
  expect(manifest.skills).toHaveLength(2);
  const model = inference(f.project); await model.run();
  expect(model.seen[0]!.system).toContain("Local lint description");
  expect(model.seen[0]!.system).not.toContain("EXPLICIT BODY MUST NOT AUTOLOAD");
  expect(await f.project.load("src/.codex/skills/lint/SKILL.md")).toMatchObject({ kind: "skill", body: expect.stringContaining("EXPLICIT BODY") });
  await expect(f.project.load(".agents/skills/lint/SKILL.md")).rejects.toThrow("outside");
});

test("project plugin and MCP discovery exposes metadata while withholding credentials and effect authority", async () => {
  const f = await fixture(), root = ".codex/plugins/example";
  await f.put(`${root}/.codex-plugin/plugin.json`, JSON.stringify({ name: "example", version: "1.0", description: "Project plugin", skills: "./skills" }));
  await f.put(`${root}/skills/browse/SKILL.md`, "---\nname: browse\ndescription: Inspect a source\n---\nPLUGIN BODY");
  await f.put(`${root}/.mcp.json`, JSON.stringify({ mcpServers: { hosted: { type: "http", url: "https://example.test/mcp?token=raw-url-token", headers: { Authorization: "raw-header-token" } }, local: { command: "/usr/bin/tool", env: { API_KEY: "raw-env-token" } } } }));
  await f.put(".mcp.json", JSON.stringify({ mcpServers: { root: { command: "/bin/anything", args: ["--token", "raw-arg-token"], env: { TOKEN: "root-private-token" } } } }));
  const manifest = await f.project.manifest();
  expect(manifest.plugins[0]).toMatchObject({ name: "example", version: "1.0", mcp: [
    { name: "hosted", transport: "http", endpoint: "https://example.test/mcp", environmentKeys: [], headerKeys: ["Authorization"] },
    { name: "local", transport: "stdio", command: "tool", environmentKeys: ["API_KEY"], headerKeys: [] },
  ] });
  expect(manifest.skills[0]).toMatchObject({ plugin: "example", name: "browse" });
  expect(manifest.mcp[0]).toMatchObject({ path: ".mcp.json", servers: [{ name: "root", command: "anything" }] });
  const explicit = await f.project.load(`${root}/.codex-plugin/plugin.json`), mcp = await f.project.load(".mcp.json");
  for (const value of [manifest, explicit, mcp]) expect(JSON.stringify(value)).not.toMatch(/raw-(?:url|header|env|arg)-token|root-private-token/);
  const model = inference(f.project); await model.run(); expect(model.seen[0]!.tools).toEqual([]);
});

test("explicit project plugin directories remain confined and cannot point skills outside the project", async () => {
  const f = await fixture();
  await f.put("vendor/demo/.claude-plugin/plugin.json", JSON.stringify({ name: "demo", skills: "skills" }));
  await f.put("vendor/demo/skills/check/SKILL.md", "---\nname: check\ndescription: Check\n---\nRun checks");
  const project = new ProjectContext({ ...f.options, pluginDirectories: ["vendor/demo"] });
  expect((await project.manifest()).plugins[0]?.name).toBe("demo");
  await f.put("vendor/demo/.claude-plugin/plugin.json", JSON.stringify({ name: "demo", skills: "../../outside" }));
  await expect(project.manifest()).rejects.toThrow("project-relative");
});

test("filesystem source rejects traversal, symlink escapes and oversized files", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "aiko-project-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "OUTSIDE PRIVATE");
  await symlink(outside, join(f.root, "escape"));
  await symlink(join(outside, "secret.md"), join(f.root, "secret.md"));
  const signal = AbortSignal.timeout(5000);
  await expect(f.source.read("../secret.md", signal)).rejects.toThrow("project-relative");
  await expect(f.source.read("/etc/passwd", signal)).rejects.toThrow("project-relative");
  await expect(f.source.read("escape/secret.md", signal)).rejects.toThrow("escapes");
  await expect(f.source.read("secret.md", signal)).rejects.toThrow("escapes");
  await expect(f.source.list("escape", signal)).rejects.toThrow("escapes");
  await f.put("AGENTS.md", "a".repeat(PROJECT_FILE_MAX_BYTES + 1));
  await expect(f.project.manifest()).rejects.toThrow("bounds");
});

test("context budgets fail before inference and native project tools enforce thread custody", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "rule ".repeat(300));
  const model = inference(new ProjectContext({ ...f.options, contextBytes: 1024 }));
  expect(await model.run()).toMatchObject({ kind: "fail", failure: { policy: { source: "project_context_unavailable" } } });
  expect(model.seen).toHaveLength(0);
  const tool = f.project.tools()[0]!;
  const result = await Effect.runPromise(tool.run({}, { callId: "read", turn: "turn", signal: AbortSignal.timeout(5000) }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "test", thread: "user-ownerA" } as any)));
  expect(result).toMatchObject({ cwd: "src/feature" });
  await expect(Effect.runPromise(tool.run({}, { callId: "read", signal: AbortSignal.timeout(5000) }).pipe(Effect.provideService(Self, { actor: "aiko", thread: "foreign" } as any)))).rejects.toThrow("scope mismatch");
});
