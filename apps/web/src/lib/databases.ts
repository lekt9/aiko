import type { DatabaseArtifactResult, DatabaseCatalog, DatabaseCommandInput, DatabaseFieldInput, DatabaseFieldResult, DatabaseOperationResult, DatabaseQuery, DatabaseQueryResult, AikoMessages } from "@unlock/sdk/aiko";
import { connectorRequest } from "./connectors";
export type { DatabaseArtifactResult, DatabaseCatalog, DatabaseQueryResult, DatabaseFieldResult };
export type DatabaseColumn = DatabaseQueryResult["columns"][number];
export type DatabaseRow = DatabaseQueryResult["rows"][number];
export interface ApprovalDetail {
  prepared: { id: string; operation: string; connectionId: string; connectionRevision: string; expiresAt: number; hash: string; payload: unknown };
  state: string; version: number; outcome: string | null; canDecide: boolean;
}
export type DatabaseAuthentication = { bearer?: string; telegram?: boolean };
export function artifactLaunchId(search: string): string | undefined {
  const entries = new URLSearchParams(search).getAll("artifact");
  return entries.length === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(entries[0]!) ? entries[0] : undefined;
}
export function databaseClient(authentication?: DatabaseAuthentication) {
  const request = <T>(path: string, body?: object, signal?: AbortSignal) => connectorRequest<T>(path, body, signal, authentication);
  return {
    field: (input: DatabaseFieldInput, signal?: AbortSignal) => request<DatabaseFieldResult>("/databases/field", input, signal),
    operation: (id: string, signal?: AbortSignal) => request<DatabaseOperationResult>(`/databases/operations/${encodeURIComponent(id)}`, undefined, signal),
    artifact: (id: string, signal?: AbortSignal) => request<DatabaseArtifactResult>(`/databases/artifacts/${encodeURIComponent(id)}`, undefined, signal),
    catalog: (signal?: AbortSignal) => request<DatabaseCatalog>("/databases", undefined, signal),
    query: (query: DatabaseQuery, signal?: AbortSignal) => request<DatabaseQueryResult>("/databases/query", { query }, signal),
    changes: (signal?: AbortSignal) => request<{ cursor: { revision: number; domains: Record<string, string> } }>("/databases/changes", undefined, signal),
    messages: (signal?: AbortSignal) => request<AikoMessages>("/messages", undefined, signal),
    approval: (id: string, signal?: AbortSignal) => request<ApprovalDetail>(`/databases/approvals/${encodeURIComponent(id)}`, undefined, signal),
    decide: (detail: ApprovalDetail, decision: "approve" | "reject", signal?: AbortSignal) => request<ApprovalDetail>("/observed-actions/approval", { id: detail.prepared.id, hash: detail.prepared.hash, decision }, signal),
    commit: async (input: DatabaseCommandInput, signal?: AbortSignal): Promise<DatabaseOperationResult> => {
      let operation = await request<DatabaseOperationResult>("/databases/commands", input, signal);
      operation = await request<DatabaseOperationResult>(`/databases/operations/${encodeURIComponent(operation.operationId)}`, undefined, signal);
      const deadline = Date.now() + 20000;
      while (operation.status === "queued" && Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason); return; }
          const stop = () => { clearTimeout(timer); reject(signal?.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, 300);
          signal?.addEventListener("abort", stop, { once: true });
        });
        operation = await request<DatabaseOperationResult>(`/databases/operations/${encodeURIComponent(operation.operationId)}`, undefined, signal);
      }
      return operation;
    },
  };
}
export type DatabaseClient = ReturnType<typeof databaseClient>;

export function parseCellDraft(column: DatabaseColumn, text: string): unknown {
  if (column.type === "integer") { if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw Error("Enter a whole number within the supported range."); return Number(text); }
  if (column.type === "decimal") { if (!/^-?\d+(\.\d+)?$/.test(text)) throw Error("Enter a decimal number, such as 12.50."); return text; }
  if (column.type === "boolean") { if (!["true", "false"].includes(text)) throw Error("Choose true or false."); return text === "true"; }
  if (column.type === "json" || column.type === "relation" && column.relation?.cardinality === "many-to-many") { try { return JSON.parse(text); } catch { throw Error("Enter valid JSON."); } }
  if (column.type === "timestamp") { if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(text) || !Number.isFinite(Date.parse(text))) throw Error("Enter a UTC date and time, such as 2026-09-08T09:00:00Z."); return new Date(text).toISOString(); }
  return text;
}
