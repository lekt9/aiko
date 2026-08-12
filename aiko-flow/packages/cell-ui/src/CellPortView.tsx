/** @jsxImportSource react */
import type { ComponentType, ReactNode } from "react";
import type { CellPort } from "./model.ts";

export type CellRenderComponentProps = { spec: CellPort["render"]; value: unknown };
export type CellPortViewProps = {
  port: CellPort;
  value: unknown;
  pending?: boolean;
  error?: string | null;
  /** A React component, not a callback: hook-using json-render adapters remain hook-safe. */
  RenderSpec?: ComponentType<CellRenderComponentProps>;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function FormValue({ port, value }: { port: CellPort; value: unknown }) {
  const row =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const render = port.render as { fields?: Array<{ key: string; label?: string; required?: boolean }> };
  return (
    <dl className="cell-port-fields">
      {(render.fields ?? []).map((field) => (
        <div key={field.key} className="cell-port-field">
          <dt>
            {field.label ?? field.key}
            {field.required ? " *" : ""}
          </dt>
          <dd>{text(row[field.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function TableValue({ port, value }: { port: CellPort; value: unknown }) {
  const rows = Array.isArray(value) ? value : [];
  const columns = (port.render as { columns?: Array<{ key: string; label?: string }> }).columns ?? [];
  return (
    <div className="cell-port-table-wrap">
      <table className="cell-port-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label ?? column.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item, index) => {
            const row: Record<string, unknown> =
              item !== null && typeof item === "object" ? (item as Record<string, unknown>) : { value: item };
            return (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key}>{text(row[column.key])}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <div className="cell-port-empty">No rows.</div> : null}
    </div>
  );
}

function body(port: CellPort, value: unknown): ReactNode {
  const type = typeof port.render.type === "string" ? port.render.type : "raw";
  if (type === "form") return <FormValue port={port} value={value} />;
  if (type === "table") return <TableValue port={port} value={value} />;
  if (type === "list")
    return (
      <ul>
        {(Array.isArray(value) ? value : []).map((item, index) => (
          <li key={index}>{text(item)}</li>
        ))}
      </ul>
    );
  if (type === "field") return <div className="cell-port-scalar">{text(value)}</div>;
  return <pre className="cell-port-raw">{JSON.stringify(value, null, 2)}</pre>;
}

export function CellPortView({ port, value, pending = false, error = null, RenderSpec }: CellPortViewProps) {
  const isJsonRender = port.renderVia === "explicit" && "root" in port.render;
  return (
    <section className="card cell-port" data-direction={port.direction} data-render-via={port.renderVia}>
      <header className="section-head">
        <span>{port.name.replaceAll("_", " ")}</span>
        <span className="pill">{port.direction}</span>
      </header>
      {error ? (
        <div className="alert err">{error}</div>
      ) : pending ? (
        <div className="empty">Waiting for durable output…</div>
      ) : isJsonRender ? (
        RenderSpec ? (
          <RenderSpec spec={port.render} value={value} />
        ) : (
          <div className="alert err">This port requires an admitted json-render registry.</div>
        )
      ) : (
        body(port, value)
      )}
    </section>
  );
}
