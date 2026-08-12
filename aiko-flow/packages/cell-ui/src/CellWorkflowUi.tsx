/** @jsxImportSource react */
import type { ComponentType } from "react";
import { useGatewayNodeOutput } from "@smthrs/gateway-react";
import { CellPortView, type CellRenderComponentProps } from "./CellPortView.tsx";
import { normalizeCellVisualMembrane, type CellPort } from "./model.ts";

export type CellPortKey = string | `${CellPort["direction"]}:${string}`;
export type CellWorkflowUiProps = {
  cell: unknown;
  runId?: string;
  nodeIds?: Partial<Record<CellPortKey, string>>;
  title?: string;
  values?: Partial<Record<CellPortKey, unknown>>;
  RenderSpec?: ComponentType<CellRenderComponentProps>;
};

type NodeEnvelope = { status: "pending" | "failed" | "produced"; row: unknown };
function unwrapNodeOutput(data: unknown): NodeEnvelope {
  if (data !== null && typeof data === "object") {
    const envelope = data as Record<string, unknown>;
    if (envelope.status === "pending" || envelope.status === "failed") return { status: envelope.status, row: null };
    if (envelope.status === "produced") return { status: "produced", row: envelope.row ?? null };
  }
  return { status: "produced", row: data ?? null };
}

function portValue<T>(values: Partial<Record<CellPortKey, T>>, port: CellPort): T | undefined {
  return values[`${port.direction}:${port.name}`] ?? values[port.name];
}

export type CellPortOutputState = { data?: unknown; loading: boolean; error?: Error | null };
export function resolveCellPortState({
  port,
  runId,
  nodeId,
  hasFallback,
  fallback,
  output,
}: {
  port: CellPort;
  runId?: string;
  nodeId?: string;
  hasFallback: boolean;
  fallback?: unknown;
  output: CellPortOutputState;
}) {
  const envelope = unwrapNodeOutput(output.data);
  const row = envelope.row;
  const value =
    row !== null && typeof row === "object" && port.name in (row as Record<string, unknown>)
      ? (row as Record<string, unknown>)[port.name]
      : (row ?? fallback);
  const pending = Boolean(
    nodeId && (!runId || (output.loading && output.data == null) || envelope.status === "pending"),
  );
  const missing =
    !nodeId && !hasFallback && port.required
      ? `Required ${port.direction} port “${port.name}” has no node mapping or value.`
      : null;
  const error =
    output.error?.message ??
    (envelope.status === "failed" ? "The producing node failed before writing this port." : missing);
  return { value, pending, error };
}

function LivePort({
  runId,
  nodeId,
  port,
  hasFallback,
  fallback,
  RenderSpec,
}: {
  runId?: string;
  nodeId?: string;
  port: CellPort;
  hasFallback: boolean;
  fallback?: unknown;
  RenderSpec?: ComponentType<CellRenderComponentProps>;
}) {
  const output = useGatewayNodeOutput({ runId, nodeId });
  const state = resolveCellPortState({ port, runId, nodeId, hasFallback, fallback, output });
  return (
    <CellPortView port={port} value={state.value} RenderSpec={RenderSpec} pending={state.pending} error={state.error} />
  );
}

export function CellWorkflowUi({ cell, runId, nodeIds = {}, title, values = {}, RenderSpec }: CellWorkflowUiProps) {
  const membrane = normalizeCellVisualMembrane(cell);
  return (
    <main className="workflow-shell cell-workflow-ui">
      <style>{`.cell-workflow-ui{font:14px/1.5 system-ui,sans-serif;color:#17202a;padding:24px}.cell-workflow-ui .topbar{display:flex;align-items:end;justify-content:space-between;margin-bottom:20px}.cell-workflow-ui h1{margin:0;font-size:24px}.cell-workflow-ui .meta{color:#667085}.cell-membrane{display:grid;gap:16px}.cell-port{border:1px solid #d0d5dd;border-radius:10px;padding:16px;background:#fff}.cell-port .section-head{display:flex;justify-content:space-between;font-weight:600;margin-bottom:12px}.cell-port .pill{font-size:11px;text-transform:uppercase;color:#475467}.cell-port-table{width:100%;border-collapse:collapse}.cell-port-table th,.cell-port-table td{text-align:left;border-bottom:1px solid #eaecf0;padding:8px}.cell-port-fields{display:grid;gap:8px}.cell-port-field{display:grid;grid-template-columns:minmax(120px,1fr) 2fr}.alert.err{color:#b42318}.empty,.cell-port-empty{color:#667085}`}</style>
      <header className="topbar"><div><h1>{title ?? membrane.name}</h1>{membrane.description ? <span className="meta">{membrane.description}</span> : null}</div></header>
      <div className="workflow-dashboard cell-membrane" data-cell={membrane.name}>
        {membrane.ports.map((port) => {
          const directedKey: CellPortKey = `${port.direction}:${port.name}`;
          const hasFallback =
            Object.prototype.hasOwnProperty.call(values, directedKey) ||
            Object.prototype.hasOwnProperty.call(values, port.name);
          return (
            <LivePort
              key={directedKey}
              runId={runId}
              nodeId={portValue(nodeIds, port)}
              port={port}
              hasFallback={hasFallback}
              fallback={portValue(values, port)}
              RenderSpec={RenderSpec}
            />
          );
        })}
      </div>
    </main>
  );
}
