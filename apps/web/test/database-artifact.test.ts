import { expect, test } from "vitest";
import { databaseCatalog, databaseRenderSpec } from "../src/components/database-artifact";
import { artifactLaunchId, parseCellDraft, type DatabaseArtifactResult } from "../src/lib/databases";

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

test("cell editors preserve exact decimals and reject unsafe integer coercion", () => {
  expect(parseCellDraft({ id: "amount", name: "Amount", type: "decimal" }, "9007199254740993.05")).toBe("9007199254740993.05");
  expect(() => parseCellDraft({ id: "amount", name: "Amount", type: "integer" }, "9007199254740993")).toThrow();
  expect(parseCellDraft({ id: "enabled", name: "Enabled", type: "boolean" }, "false")).toBe(false);
  expect(artifactLaunchId("?artifact=projects")).toBe("projects");
  expect(artifactLaunchId("?artifact=projects&artifact=foreign")).toBeUndefined();
});
