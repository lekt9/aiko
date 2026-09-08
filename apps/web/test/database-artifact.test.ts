import { expect, test, vi } from "vitest";
import { connectorRequest, MiniAppAuthenticationError } from "../src/lib/connectors";
import { databaseCatalog, databaseRenderSpec } from "../src/components/database-artifact";
import { databaseRefreshMessage } from "../src/components/database-refresh-controls";
import { artifactLaunchId, parseCellDraft, type DatabaseArtifactResult } from "../src/lib/databases";

test.each([401, 403] as const)("database authentication failures preserve HTTP %s for data clearing", async status => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "REMOTE_PRIVATE_ERROR" }, { status })));
  try {
    const error = await connectorRequest("/databases/artifacts/example", undefined, undefined, { bearer: "fixture-only", telegram: false }).catch(error => error);
    expect(error).toBeInstanceOf(MiniAppAuthenticationError); expect(error.status).toBe(status); expect(error.message).not.toContain("REMOTE_PRIVATE_ERROR");
  } finally { vi.unstubAllGlobals(); }
});

test("persisted and legacy leaf specs render only the host-owned database component", () => {
  const data = { artifact: { artifactId: "projects", renderer: { kind: "json-render", catalogVersion: "aiko-db/v1" } } } as DatabaseArtifactResult;
  const spec = databaseRenderSpec(data);
  expect(spec).toBeDefined(); expect(databaseCatalog.validate(spec).success).toBe(true);
  data.artifact.spec = spec as typeof data.artifact.spec;
  expect(databaseRenderSpec(data)).toEqual(spec);
  const malicious = structuredClone(data);
  (malicious.artifact.spec!.elements.database as any).on = { mount: { action: "approve" } };
  expect(databaseRenderSpec(malicious)).toBeUndefined();
  malicious.artifact.spec = structuredClone(data.artifact.spec);
  malicious.artifact.spec!.elements.database.props.artifactId = "foreign";
  expect(databaseRenderSpec(malicious)).toBeUndefined();
});

test("refresh wording distinguishes full checks, partial commits and queued or cancelled work", () => {
  const base = { operationId: "refresh", status: "committed" as const, receipt: { operationId: "refresh", revision: 1, at: 1, result: { coverage: "complete", committed: 2 } } };
  expect(databaseRefreshMessage(base)).toContain("Source checks finished");
  expect(databaseRefreshMessage({ ...base, receipt: { ...base.receipt, result: { coverage: "partial", committed: 1 } } })).toContain("could not be completed");
  expect(databaseRefreshMessage({ ...base, status: "conflict" })).toContain("Earlier saved checks are kept");
  expect(databaseRefreshMessage({ operationId: "refresh", status: "queued" })).toContain("still running");
  expect(databaseRefreshMessage({ ...base, status: "cancelled" })).toContain("Refresh cancelled");
});

test("cell editors preserve exact decimals and reject unsafe integer coercion", () => {
  expect(parseCellDraft({ id: "amount", name: "Amount", type: "decimal" }, "9007199254740993.05")).toBe("9007199254740993.05");
  expect(() => parseCellDraft({ id: "amount", name: "Amount", type: "integer" }, "9007199254740993")).toThrow();
  expect(parseCellDraft({ id: "enabled", name: "Enabled", type: "boolean" }, "false")).toBe(false);
  expect(artifactLaunchId("?artifact=projects")).toBe("projects");
  expect(artifactLaunchId("?artifact=projects&artifact=foreign")).toBeUndefined();
});
