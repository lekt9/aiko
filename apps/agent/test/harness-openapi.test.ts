import { expect, test } from "bun:test";
import { executeHarnessAction } from "@unbrowse/browser-harness/harness-runtime";
import { deriveOpenApiAction } from "../src/harness-openapi.ts";

const spec = () => ({ openapi: "3.1.1", servers: [{ url: "https://example.test/v1" }], components: { parameters: { id: { in: "path", name: "projectId", required: true, schema: { type: "integer" } } } }, paths: {
  "/projects/{projectId}": { parameters: [{ $ref: "#/components/parameters/id" }], get: { operationId: "getProject", parameters: [{ in: "query", name: "expand", required: true, schema: { type: "boolean" } }], responses: { "200": { description: "Project" } } } },
} });

test("OpenAPI path and query bindings preserve actual request semantics in the shared DAG evaluator", async () => {
  const draft = deriveOpenApiAction(spec(), "getProject");
  if (draft.status !== "candidate") throw Error(draft.unresolved.join(","));
  const urls: string[] = [];
  const run = await executeHarnessAction({ artifact: draft.graph, actionId: draft.actionId, input: { "parameter-0": 71, "parameter-1": true }, adapters: {
    clock: { now: () => new Date(0) }, uuid: { next: () => crypto.randomUUID() }, transport: { send: async request => { urls.push(request.url); return { status: 200, headers: {}, body: { id: 71 }, classification: "application" }; } },
  } });
  expect(run.status).toBe("completed");
  expect(urls).toEqual(["https://example.test/v1/projects/71?expand=true"]);
  expect(draft.inputSchema.required).toEqual(["parameter-0", "parameter-1"]);
  expect(draft.effect).toBe("read");
});

test("documented JSON mutations retain the body, content type and write classification", async () => {
  const draft = deriveOpenApiAction({ openapi: "3.0.3", servers: [{ url: "https://example.test" }], paths: { "/items": { post: { operationId: "createItem", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } } } } } }, responses: { "201": { description: "Created" } } } } } }, "createItem");
  if (draft.status !== "candidate") throw Error(draft.unresolved.join(","));
  let observed: any;
  const run = await executeHarnessAction({ artifact: draft.graph, actionId: draft.actionId, input: { body: { title: "controlled fixture" } }, adapters: { clock: { now: () => new Date(0) }, uuid: { next: () => crypto.randomUUID() }, transport: { send: async request => { observed = request; return { status: 201, headers: {}, body: { id: 1 }, classification: "application" }; } } } });
  expect(run.status).toBe("completed"); expect(draft.effect).toBe("write");
  expect(observed.method).toBe("POST"); expect(observed.body).toEqual({ title: "controlled fixture" });
  expect(observed.headers["content-type"]).toBe("application/json");
});

test("authentication, optional/complex serialization and ambiguous servers stay unresolved", () => {
  const secured = { ...spec(), security: [{ bearer: [] }] };
  expect(deriveOpenApiAction(secured, "getProject")).toMatchObject({ status: "unresolved", unresolved: ["trusted-session-adapter-required"] });
  const optional = spec(); optional.paths["/projects/{projectId}"].get.parameters[0]!.required = false;
  expect(deriveOpenApiAction(optional, "getProject").status).toBe("unresolved");
  expect(deriveOpenApiAction({ ...spec(), servers: [{ url: "https://one.test" }, { url: "https://two.test" }] }, "getProject").status).toBe("unresolved");
  expect(() => deriveOpenApiAction({ ...spec(), paths: { "/x": { $ref: "https://untrusted.test/spec.json" } } }, "getProject")).toThrow("reference");
});
