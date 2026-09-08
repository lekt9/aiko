import { Validator, type Schema } from "@cfworker/json-schema";
import { HarnessLibrary, harnessLibraryState, type HarnessLibraryBinding } from "./harness-library.ts";
import { HarnessRevisions } from "./harness-revisions.ts";
import { boundedText } from "./security.ts";

const base = /^\/(?:api|v1)\/harness\/library(?:\/|$)/;
/** POST lookup operations carry structured inputs but cannot acquire write scope. */
export const harnessLibraryReadRequest = (request: Request) => request.method === "GET" ||
  request.method === "POST" && /^\/(?:api|v1)\/harness\/library\/(?:inspect|recall|output)$/.test(new URL(request.url).pathname);
const digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" };
const name = { type: "string", minLength: 1, maxLength: 160 };
const shape = (properties: object) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const schemas: Record<string, object> = {
  inspect: shape({ digest }), revise: shape({ predecessorDigest: digest, changes: { type: "object", minProperties: 1,
    properties: { description: { type: "string" }, runtime: { enum: ["javascript", "python", "network"] }, runtimeLockDigest: digest,
      entrypoint: { type: "string" }, files: { type: "object", additionalProperties: { type: "string" } },
      dependencies: { type: "array" }, sources: { type: "array" }, contractDigest: digest }, additionalProperties: false } }),
  evaluate: shape({ digest, evaluationId: id }), promote: shape({ digest, evaluationId: id, expectedGeneration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
  recall: shape({ name, contractDigest: digest, input: {} }), run: shape({ digest, input: {}, operationId: id }),
  output: shape({ operationId: id }), "from-request": shape({ toolDigest: digest, name, contractDigest: digest }),
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** The API supplies account scope only. Execution, fixture authority, custody,
 * independent verification and operation identity stay in the existing library. */
export async function harnessLibraryApi(request: Request, owner: string, library: HarnessLibrary | undefined,
  principal: { owner: string; scopes: readonly string[] }, options: { current(): boolean; wake(): void }): Promise<Response> {
  const read = harnessLibraryReadRequest(request);
  const current = () => { try { return options.current(); } catch { return false; } };
  if (principal.owner !== owner || !principal.scopes.includes(read ? "read" : "write") || !current()) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url), path = url.pathname.replace(base, "");
  if (!base.test(url.pathname)) return json({ error: "not_found" }, 404);
  if (url.search) return json({ error: "invalid_query" }, 400);
  if (!["GET", "POST"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
  if (!library) return json({ available: false, error: "harness_library_not_configured" }, 503);
  if (library.binding.owner !== owner || library.binding.thread !== `user-${owner}`) return json({ error: "forbidden" }, 403);
  const operation = request.method === "GET" && !path ? "list" : request.method === "POST" && Object.hasOwn(schemas, path) ? path : undefined;
  if (!operation) return json({ error: "not_found" }, 404);
  let body: any = {};
  if (request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "json_required" }, 415);
    try { body = JSON.parse(await boundedText(new Response(request.body), 262144)); }
    catch { return json({ error: "invalid_body" }, 400); }
    if (!new Validator(schemas[operation] as Schema).validate(body).valid) return json({ error: "invalid_body" }, 400);
  }
  const signal = request.signal;
  const guard = () => { signal.throwIfAborted(); if (!current()) throw Error("account_scope_changed"); };
  const checked = async <T>(run: () => Promise<T>): Promise<T> => { guard(); const value = await run(); guard(); return value; };
  const original = library.binding;
  const binding: HarnessLibraryBinding = { ...original,
    guard: value => { guard(); original.guard(value); },
    context: (...args) => checked(() => original.context(...args)),
    authorize: (...args) => checked(() => original.authorize(...args)),
    ...(original.authorizeEvaluation ? { authorizeEvaluation: (...args: Parameters<NonNullable<HarnessLibraryBinding["authorizeEvaluation"]>>) => checked(() => original.authorizeEvaluation!(...args)) } : {}),
    execute: (...args) => checked(() => original.execute(...args)),
  };
  const scoped = new HarnessLibrary(binding, { read: () => checked(() => library.journal.read()),
    append: events => checked(() => library.journal.append(events)) });
  const revisions = new HarnessRevisions(scoped);
  try {
    guard();
    let result: unknown;
    switch (operation) {
      case "list": {
        const rows = await scoped.journal.read(), state = harnessLibraryState(rows, owner);
        const operations = rows.filter(row => row.owner === owner && row.type === "AikoHarnessRunStarted" && row.caseId === null && row.receiptOf === undefined)
          .slice(-32).reverse().map(row => {
            const witness = state.witnesses.get(String(row.id));
            return { operationId: row.id, digest: row.harnessDigest, status: witness?.status ?? "unknown", at: row.at,
              outputAvailable: witness?.status === "satisfied" && !!witness.outputRef };
          });
        result = { ...await scoped.list(), operations, evaluations: [...state.evaluations.values()].slice(-32).reverse() };
        break;
      }
      case "inspect": result = await revisions.inspect(body.digest, signal); break;
      case "revise": result = await revisions.derive(body.predecessorDigest, body.changes, signal); break;
      case "evaluate": result = await revisions.evaluate(body.digest, body.evaluationId, signal); break;
      case "promote": result = await revisions.promote(body.digest, body.evaluationId, body.expectedGeneration, signal); break;
      case "recall": result = await revisions.recall(body.name, body.contractDigest, body.input, signal); break;
      case "run": result = await scoped.run(body.digest, body.input, body.operationId, signal); break;
      case "output": result = await scoped.output(body.operationId); break;
      case "from-request": result = await revisions.fromRequest(body.toolDigest, body.name, body.contractDigest, signal); break;
    }
    guard(); if (!read) options.wake();
    return json({ available: true, result });
  } catch {
    if (!current()) return json({ error: "forbidden" }, 403);
    return json({ error: "harness_operation_unavailable", message: "The operation could not be completed. Inspect its saved evidence before trying again." }, 409);
  }
}
