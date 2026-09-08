import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetManifest, runShip, scanReleaseFiles, secretProblem, shipOptions, sourceSnapshot, verifyRelease, type ReleaseReceipt, type ShipOperations } from "./ship.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const html = "<!doctype html><title>Aiko Connect</title>";
function receipt(): ReleaseReceipt {
  return { version: 1, id: "release-fixture", worker: "aiko-agent", url: "https://aiko.example", branch: "main", remote: "origin", ref: "refs/heads/main",
    source: "a".repeat(64), browserSource: "b".repeat(64), browserCommit: "c".repeat(40), browserDirty: false, phase: "preparing", checks: [],
    assets: [{ path: "/connect.html", bytes: Buffer.byteLength(html), sha256: digest(html) }] };
}

async function fixtureGit(path: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(err);
  return out.trim();
}

test("release CLI has no force/skip-checks escape hatch and preserves literal commit text", () => {
  expect(shipOptions(["-m", "Ship $(touch not-a-command)"]).message).toBe("Ship $(touch not-a-command)");
  expect(shipOptions(["--dry-run"]).dryRun).toBe(true);
  expect(shipOptions(["--verify"]).verify).toBe(true);
  for (const args of [["--force"], ["--skip-tests"], ["--message"], ["-m", "first\nsecond"], ["--dry-run", "--verify"]]) expect(() => shipOptions(args)).toThrow();
});

test("source fingerprint survives staging and committing additions/deletions but detects new edits and symlink retargeting", async () => {
  const root = await mkdtemp(join(tmpdir(), "ship-source-"));
  try {
    await fixtureGit(root, ["init", "-q"]);
    await fixtureGit(root, ["config", "user.email", "fixture@example.invalid"]);
    await fixtureGit(root, ["config", "user.name", "Release fixture"]);
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "removed.ts"), "export const before = true;\n");
    await fixtureGit(root, ["add", "--all"]); await fixtureGit(root, ["commit", "-qm", "baseline"]);
    await rm(join(root, "removed.ts"));
    await writeFile(join(root, " source with spaces.ts"), "export const added = true;\n");
    await symlink(" source with spaces.ts", join(root, "linked.ts"));
    const before = await sourceSnapshot(root);
    await fixtureGit(root, ["add", "--all"]);
    expect(await sourceSnapshot(root)).toBe(before);
    await fixtureGit(root, ["commit", "-qm", "candidate"]);
    expect(await sourceSnapshot(root)).toBe(before);
    await mkdir(join(root, "ignored")); await writeFile(join(root, "ignored", "log.txt"), "not a source");
    expect(await sourceSnapshot(root)).toBe(before);
    await rm(join(root, "linked.ts")); await symlink("other.ts", join(root, "linked.ts"));
    expect(await sourceSnapshot(root)).not.toBe(before);
    await rm(join(root, "linked.ts")); await symlink(" source with spaces.ts", join(root, "linked.ts"));
    await writeFile(join(root, " source with spaces.ts"), "export const added = false;\n");
    expect(await sourceSnapshot(root)).not.toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate scanning refuses forced tracked env files and configured secrets without printing the value", async () => {
  const root = await mkdtemp(join(tmpdir(), "ship-secrets-")), secret = "synthetic-release-credential-" + "9".repeat(32);
  try {
    await fixtureGit(root, ["init", "-q"]);
    await writeFile(join(root, ".gitignore"), ".env\n");
    await writeFile(join(root, ".env"), "SECRET=" + secret);
    await scanReleaseFiles(root, [secret]); // Ignored private files are not committed.
    await fixtureGit(root, ["add", "--force", ".env"]);
    await expect(scanReleaseFiles(root, [secret])).rejects.toThrow(".env: private credential file");
    expect(secretProblem("source.ts", Buffer.from(secret), [secret])).toBe("configured secret value");
    expect(secretProblem("key.ts", Buffer.from("-----BEGIN " + "PRIVATE KEY-----"), [])).toBe("private key or access token");
    expect(secretProblem(".env.example", Buffer.from("KEY=replace-me"), [])).toBeUndefined();
    expect(secretProblem(".env.example", Buffer.from(secret), [secret])).toBe("configured secret value");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("asset manifest binds binary bytes and refuses symlinks rather than following private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ship-assets-"));
  try {
    await writeFile(join(root, "connect.html"), html);
    await mkdir(join(root, "assets")); await writeFile(join(root, "assets", "image.png"), Buffer.from([0, 255, 128]));
    const files = await assetManifest(root);
    expect(files.find(file => file.path === "/connect.html")?.sha256).toBe(digest(html));
    expect(files.find(file => file.path === "/assets/image.png")?.bytes).toBe(3);
    await symlink("connect.html", join(root, "alias.html"));
    await expect(assetManifest(root)).rejects.toThrow("symlinks");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ["checkpoint", "push", "checks", "unchanged", "publish", "verify", undefined] as const) {
  test(`release ${failure ? `failure at ${failure}` : "success"} preserves its effect boundary and never retries publication`, async () => {
    const state = receipt(), calls: string[] = [], saved: ReleaseReceipt[] = [];
    const call = async (step: string) => { calls.push(step); if (step === failure) throw Error("injected " + step); };
    const operations: ShipOperations = {
      checkpoint: async () => { await call("checkpoint"); return "d".repeat(40); },
      push: async commit => { expect(commit).toBe(state.commit!); await call("push"); },
      checks: () => call("checks"), unchanged: () => call("unchanged"),
      publish: async release => {
        expect(saved.at(-1)?.phase).toBe("publishing"); // Durable intent precedes the network effect.
        expect(release.commit).toBe(state.commit!); await call("publish"); return state.url;
      },
      verify: () => call("verify"), save: async () => { saved.push(structuredClone(state)); },
    };
    if (failure) await expect(runShip(state, operations)).rejects.toThrow("injected " + failure);
    else await runShip(state, operations);
    expect(calls.filter(call => call === "publish").length).toBe(failure && ["checkpoint", "push", "checks", "unchanged"].includes(failure) ? 0 : 1);
    expect(state.phase === "verified").toBe(!failure);
    if (failure === "publish") expect(state.phase).toBe("publishing");
    if (failure === "verify") expect(state.phase).toBe("verifying");
    if (failure === "checks") expect(calls).toEqual(["checkpoint", "push", "checks"]);
  });
}

function liveFixture(state: ReleaseReceipt, options: { stale?: boolean; wrongAsset?: boolean; missingAsset?: boolean; denyCanary?: boolean; openActor?: boolean } = {}) {
  const calls: { path: string; auth: boolean }[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, auth = new Headers(init?.headers).has("authorization");
    calls.push({ path, auth });
    expect(url.origin).toBe(state.url); expect(init?.redirect).toBe("error");
    expect(init?.method ?? "GET").toBe("GET"); // Acceptance never submits a model prompt or browser action.
    if (path !== "/v1/messages") expect(auth).toBe(false);
    if (path === "/ready") return Response.json({ storage: "durable-object", harness: "tardie@0.22.0", release: { id: options.stale ? "old" : state.id, commit: state.commit, browserSource: state.browserSource } });
    if (path === "/connect") return new Response(options.wrongAsset ? html + " stale" : html, { status: options.missingAsset ? 404 : 200 });
    if (path === "/" || path === "/control") return new Response("Aiko");
    if (path === "/v1/messages") return Response.json({}, { status: auth ? options.denyCanary ? 403 : 200 : options.openActor ? 200 : 401 });
    throw Error("Unexpected route: " + path);
  }) as typeof fetch;
  return { fetcher, calls };
}

test("readback requires exact release, every routed asset and native auth; unexposed sample CSV is not a public route", async () => {
  const state = receipt(); state.commit = "d".repeat(40);
  state.assets.push({ path: "/sample-logins.csv", bytes: 6, sha256: digest("sample") });
  const fixture = liveFixture(state);
  await verifyRelease(state, "synthetic-canary-token", fixture.fetcher);
  expect(fixture.calls.filter(call => call.auth)).toEqual([{ path: "/v1/messages", auth: true }]);
  for (const options of [{ stale: true }, { wrongAsset: true }, { missingAsset: true }, { denyCanary: true }, { openActor: true }]) {
    const failed = liveFixture(state, options);
    await expect(verifyRelease(state, "synthetic-canary-token", failed.fetcher)).rejects.toThrow();
    if (options.stale || options.wrongAsset || options.missingAsset) expect(failed.calls.some(call => call.auth)).toBe(false);
  }
  for (const url of ["http://aiko.example", "https://user:password@aiko.example", "https://aiko.example/path", "https://aiko.example?key=bad"]) {
    const failed = liveFixture(state);
    await expect(verifyRelease({ ...state, url }, "synthetic-canary-token", failed.fetcher)).rejects.toThrow("bare HTTPS");
    expect(failed.calls).toEqual([]);
  }
});
