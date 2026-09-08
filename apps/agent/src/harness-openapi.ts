import { validateSiteHarnessArtifact, type HarnessInput, type HarnessHttpMethod, type ValueProducer } from "@unbrowse/browser-harness/harness-artifact";
import { harnessDigest } from "./harness-library.ts";

/** Deterministic adapter for the executable subset of OpenAPI 3.0/3.1.
 * Unsupported authentication/serialization becomes an explicit unresolved draft;
 * it never silently drops a parameter, credential requirement or request body. */
export function deriveOpenApiAction(document: unknown, operationId: string) {
  const unresolved: string[] = [];
  const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(document) || !/^3\.[01]\./.test(document.openapi ?? "") || !object(document.paths) || typeof operationId !== "string") throw Error("OpenAPI 3.0/3.1 document and operation ID required");
  const resolve = (raw: unknown, seen = new Set<string>()): Record<string, any> => {
    if (!object(raw)) throw Error("OpenAPI object required");
    if (!Object.hasOwn(raw, "$ref")) return raw;
    const ref = raw.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/") || seen.has(ref) || seen.size >= 8 || Object.keys(raw).some(k => k !== "$ref" && k !== "summary" && k !== "description")) throw Error("Unresolved or ambiguous OpenAPI reference");
    seen.add(ref);
    let value: unknown = document;
    for (const key of ref.slice(2).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (!object(value) || !Object.hasOwn(value, key)) throw Error("Missing OpenAPI reference");
      value = value[key];
    }
    return resolve(value, seen);
  };
  const methods = ["get", "head", "options", "post", "put", "patch", "delete"];
  const matches: { path: string; method: string; item: Record<string, any>; operation: Record<string, any> }[] = [];
  for (const [path, raw] of Object.entries(document.paths)) {
    const item = resolve(raw);
    for (const method of methods) if (object(item[method]) && item[method].operationId === operationId) matches.push({ path, method, item, operation: item[method] });
  }
  if (matches.length !== 1) throw Error("Unique OpenAPI operation required");
  const selected = matches[0]!, op = selected.operation;
  const security = op.security ?? document.security ?? [];
  if (!Array.isArray(security) || security.length && !security.some(s => object(s) && Object.keys(s).length === 0)) unresolved.push("trusted-session-adapter-required");
  const servers = op.servers ?? selected.item.servers ?? document.servers;
  if (!Array.isArray(servers) || servers.length !== 1 || !object(servers[0]) || typeof servers[0].url !== "string" || servers[0].variables || servers[0].url.includes("{")) unresolved.push("explicit-single-server-binding-required");
  let server: URL | undefined;
  try {
    server = new URL(servers?.[0]?.url);
    if (server.protocol !== "https:" || server.username || server.password || server.search || server.hash || server.port) unresolved.push("unsupported-server-url");
  } catch { unresolved.push("absolute-server-url-required"); }
  const inputs: HarnessInput[] = [], properties: Record<string, unknown> = Object.create(null), required: string[] = [];
  const pathParameters: Record<string, ValueProducer> = {}, query: Record<string, ValueProducer> = {}, headers: Record<string, ValueProducer> = {};
  const parameters = new Map<string, Record<string, any>>();
  for (const list of [selected.item.parameters ?? [], op.parameters ?? []]) {
    if (!Array.isArray(list) || list.length > 64) throw Error("Bounded OpenAPI parameters required");
    const inLevel = new Set<string>();
    for (const raw of list) {
      const parameter = resolve(raw), key = `${parameter.in}:${parameter.name}`;
      if (typeof parameter.name !== "string" || inLevel.has(key)) throw Error("Duplicate OpenAPI parameter");
      inLevel.add(key); parameters.set(key, parameter);
    }
  }
  let route = (server?.pathname.replace(/\/$/, "") ?? "") + selected.path;
  const mapping: { input: string; location: string; parameter: string }[] = [];
  for (const parameter of parameters.values()) {
    if (!["path", "query"].includes(parameter.in)) { unresolved.push(`trusted-${parameter.in}-parameter-adapter-required`); continue; }
    const schema = resolve(parameter.schema ?? {}), primitive = ["string", "number", "integer", "boolean"].includes(schema.type);
    const defaultStyle = parameter.in === "path" ? "simple" : "form";
    if (!primitive || parameter.content || parameter.allowReserved === true || parameter.style && parameter.style !== defaultStyle || ["oneOf", "anyOf", "allOf"].some(k => Object.hasOwn(schema, k))) {
      unresolved.push(`parameter-serialization:${parameter.in}:${parameter.name}`); continue;
    }
    if (parameter.in === "path" && parameter.required !== true) { unresolved.push("path-parameter-must-be-required"); continue; }
    if (parameter.required !== true) { unresolved.push(`explicit-optional-parameter-variant:${parameter.in}:${parameter.name}`); continue; }
    const input = `parameter-${inputs.length}`;
    inputs.push({ name: input, type: schema.type, required: parameter.required === true });
    properties[input] = schema; if (parameter.required === true) required.push(input);
    mapping.push({ input, location: parameter.in, parameter: parameter.name });
    if (parameter.in === "path") {
      if (!route.includes(`{${parameter.name}}`)) { unresolved.push("unused-path-parameter"); continue; }
      route = route.split(`{${parameter.name}}`).join(`{${input}}`); pathParameters[input] = { kind: "input", name: input };
    } else query[parameter.name] = { kind: "input", name: input };
  }
  if ((route.match(/\{[^}]+\}/g) ?? []).some(part => !Object.hasOwn(pathParameters, part.slice(1, -1)))) unresolved.push("undeclared-path-placeholder");
  let body: ValueProducer | undefined;
  if (op.requestBody !== undefined) {
    const request = resolve(op.requestBody), json = request.content?.["application/json"];
    if (!["post", "put", "patch", "delete"].includes(selected.method) || request.required !== true || !object(json) || !object(json.schema)) unresolved.push("explicit-required-json-body-variant-required");
    else {
      const schema = resolve(json.schema);
      if (JSON.stringify(schema).includes('"$ref"')) unresolved.push("nested-body-schema-reference-requires-materialization");
      inputs.push({ name: "body", type: "json", required: true }); properties.body = schema; required.push("body");
      body = { kind: "input", name: "body" }; headers["content-type"] = { kind: "constant", value: "application/json" };
    }
  }
  const statuses = Object.keys(op.responses ?? {}).filter(code => /^2\d\d$/.test(code)).map(Number);
  if (!statuses.length || statuses.length > 32) unresolved.push("explicit-success-status-required");
  if (unresolved.length) return { status: "unresolved" as const, operationId, unresolved: [...new Set(unresolved)], mapping };
  const graph = validateSiteHarnessArtifact({ schemaVersion: 2, executorAbi: "site-harness/1", siteId: "repository-api", version: "1", sourceCaptureDigest: harnessDigest(document), allowedOrigins: [server!.origin], actions: [{ id: "invoke", inputs,
    steps: [{ id: "request", method: selected.method.toUpperCase() as HarnessHttpMethod, origin: server!.origin, path: route, pathParameters, query, headers, ...(body ? { body } : {}), dependsOn: [], expectedStatuses: statuses }] }] });
  return { status: "candidate" as const, operationId, actionId: "invoke", graph, mapping, inputSchema: { type: "object", properties, required, additionalProperties: false }, effect: ["get", "head", "options"].includes(selected.method) ? "read" as const : "write" as const };
}
