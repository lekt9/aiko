// Structural signals on the deploy config. These fail if wrangler.toml drifts into
// an unpublishable shape, or — the dangerous one — if the upstream secret is ever
// committed as a plaintext [vars] entry instead of a Worker secret.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

describe("wrangler.toml deploy config", () => {
  it("points main at the Worker entrypoint", () => {
    expect(toml).toMatch(/^main\s*=\s*"src\/worker\.ts"/m);
  });

  it("enables a non-interactive workers.dev deploy", () => {
    expect(toml).toMatch(/^workers_dev\s*=\s*true/m);
  });

  it("declares the non-secret vars the Worker reads", () => {
    expect(toml).toMatch(/UPSTREAM_BASE\s*=/);
    expect(toml).toMatch(/DEFAULT_MODEL\s*=/);
  });

  it("NEVER commits CODEGRAFF_API_KEY as a plaintext var (it must be a Worker secret)", () => {
    // A bare mention in a comment is fine; an assignment `CODEGRAFF_API_KEY = "..."` is not.
    expect(toml).not.toMatch(/^\s*CODEGRAFF_API_KEY\s*=/m);
  });
});
