import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import { canonical, DataError, identifier, type Command } from "../../../packages/structured-data/src/index.ts";
import { databaseState, prepareDatabaseCommand, type DatabaseBinding } from "./database-component.ts";
import { assertDatabaseReadResult, readDatabaseValue } from "./database.ts";

export interface DatabaseApiHost {
  read(): Promise<readonly Event[]>;
  commit(event: Event): Promise<unknown>;
  wake(): Promise<unknown> | void;
  serialize<T>(run: () => Promise<T>): Promise<T>;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); if (!reader) throw new DataError("invalid", "JSON body required");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.length; if (bytes > 1_048_576) { await reader.cancel(); throw new DataError("limit", "Database input exceeds 1 MiB"); } chunks.push(result.value); } }
  finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const result: unknown = JSON.parse(new TextDecoder().decode(buffer));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new DataError("invalid", "JSON object required");
  canonical(result); return result as Record<string, unknown>;
}
/** Principal is authenticated by the calling host, never decoded from request JSON. */
export async function databaseApi(request: Request, binding: DatabaseBinding, host: DatabaseApiHost, principal: { owner: string; scopes: readonly string[] }): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (principal.owner !== binding.owner || request.headers.has("origin") && request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
    const root = url.pathname.startsWith("/v1/databases") ? "/v1/databases" : "/api/databases";
    const path = url.pathname.slice(root.length);
    const write = path === "/commands" || path === "/cancel";
    if (!principal.scopes.includes(write ? "write" : "read") || !await binding.authorize(write ? "write" : "read", request.signal)) return json({ error: "forbidden" }, 403);
    const read = async (name: string, input: Record<string, unknown>) => {
      const events = await host.read();
      if (!await binding.authorize("read", request.signal)) throw new DataError("forbidden", "Database authority changed");
      request.signal.throwIfAborted();
      const result = await readDatabaseValue(binding, name, input, events, request.signal, { write: principal.scopes.includes("write") });
      if (name === "field_detail" && !principal.scopes.includes("write")) {
        const field = result as import("@unlock/protocol").DatabaseFieldResult;
        if (field.memory) field.memory.canCorrect = false;
      }
      if (!await binding.authorize("read", request.signal)) throw new DataError("forbidden", "Database authority changed");
      request.signal.throwIfAborted();
      assertDatabaseReadResult(binding, name, result);
      if (name === "field_detail") {
        const field = result as import("@unlock/protocol").DatabaseFieldResult;
        if (field.memory) {
          binding.store.assertCurrentDependencies(field.dependencies.filter(dependency => dependency.source?.kind === "entity" && dependency.source.observationId === field.memory!.observationId));
          if (binding.store.mapping(field.memory.mappingId).revision !== field.memory.mappingRevision) throw new DataError("conflict", "Memory mapping changed during review");
        }
      }
      return json(result);
    };
    if (request.method === "GET" && path === "") return await read("database_catalog", {});
    if (request.method === "GET" && path === "/changes") return await read("database_changes", {});
    if (request.method === "GET" && path === "/sources") return await read("database_sources", {});
    if (request.method === "POST" && path === "/field") {
      const input = await body(request);
      if (Object.keys(input).some(key => !["tableId", "rowId", "columnId"].includes(key))) throw new DataError("invalid", "Unexpected field read arguments");
      return await read("field_detail", input);
    }
    if (request.method === "POST" && path === "/query") {
      const input = await body(request);
      if (Object.keys(input).some(k => k !== "query")) throw new DataError("invalid", "Only query is accepted");
      return await read("table_query", input);
    }
    if (request.method === "GET" && path.startsWith("/operations/")) return await read("database_operation", { operationId: decodeURIComponent(path.slice(12)) });
    if (request.method === "GET" && path.startsWith("/mappings/")) return await read("table_mapping", { mappingId: decodeURIComponent(path.slice(10)) });
    if (request.method === "GET" && path.startsWith("/artifacts/")) return await read("artifact_open", { artifactId: decodeURIComponent(path.slice(11)) });
    if (request.method === "GET" && path.startsWith("/approvals/")) return await read("approval_detail", { approvalId: decodeURIComponent(path.slice(11)) });
    if (request.method === "POST" && path === "/commands") {
      const input = await body(request);
      if (Object.keys(input).some(k => !["idempotencyKey", "command"].includes(k))) throw new DataError("invalid", "Unexpected command fields");
      identifier(input.idempotencyKey);
      const operationId = createHash("sha256").update(canonical(["database-api/v1", binding.owner, input.idempotencyKey])).digest("hex");
      const prepared = await prepareDatabaseCommand(binding, { operationId, command: input.command as Command, producer: `user:${binding.owner}`, cause: operationId }, request.signal);
      return await host.serialize(async () => {
        const existing = databaseState(await host.read(), binding).get(operationId);
        if (existing && existing.request.commandRef !== prepared.commandRef) throw new DataError("conflict", "Idempotency key belongs to another command");
        if (!await binding.authorize("write", request.signal)) return json({ error: "forbidden" }, 403);
        request.signal.throwIfAborted();
        if (!existing) await host.commit(prepared);
        await host.wake();
        const current = databaseState(await host.read(), binding).get(operationId);
        return json({ operationId, status: current?.status ?? "queued" }, current?.status === "committed" ? 200 : 202);
      });
    }
    if (request.method === "POST" && path === "/cancel") {
      const input = await body(request); identifier(input.operationId);
      if (Object.keys(input).some(k => k !== "operationId")) throw new DataError("invalid", "Unexpected cancellation fields");
      const operationId = input.operationId;
      return await host.serialize(async () => {
        if (!await binding.authorize("write", request.signal)) throw new DataError("forbidden", "Database authority changed");
        request.signal.throwIfAborted();
        const operation = databaseState(await host.read(), binding).get(operationId);
        if (!operation) throw new DataError("missing", "Operation unavailable");
        if (operation.status !== "queued") return json({ operationId, status: operation.status });
        await host.commit({ type: "AikoDatabaseOperationCancelled", id: operationId, owner: binding.owner, thread: binding.thread, at: Date.now() });
        await host.wake(); return json({ operationId, status: "cancelling" }, 202);
      });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    const code = error instanceof DataError ? error.code : "invalid";
    return json({ error: code }, code === "forbidden" ? 403 : code === "missing" ? 404 : code === "conflict" ? 409 : code === "limit" ? 413 : 400);
  }
}
