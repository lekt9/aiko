import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FileSearch,
  Globe,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ToolCallState, ToolCallStatus, ToolKind } from "../app/types";

function kindIcon(kind: ToolKind) {
  switch (kind) {
    case "execute":
      return Terminal;
    case "read":
      return FileSearch;
    case "edit":
    case "move":
      return FilePenLine;
    case "search":
      return Search;
    case "fetch":
      return Globe;
    default:
      return Wrench;
  }
}

function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "in_progress":
      return "Running";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function StatusGlyph({ status }: { status: ToolCallStatus }) {
  if (status === "in_progress" || status === "pending") {
    return <LoaderCircle size={14} className="tool-card__spin" aria-hidden="true" />;
  }
  if (status === "completed") {
    return <Check size={14} aria-hidden="true" />;
  }
  if (status === "failed") {
    return <CircleAlert size={14} aria-hidden="true" />;
  }
  return <X size={14} aria-hidden="true" />;
}

function formatPayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface ToolCallCardProps {
  tool: ToolCallState;
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = kindIcon(tool.kind);
  const input = formatPayload(tool.rawInput);
  const output =
    tool.contentText?.trim() ||
    formatPayload(tool.rawOutput);
  const hasBody = Boolean(input || output || (tool.locations && tool.locations.length > 0));

  return (
    <div className="tool-card" data-status={tool.status} data-kind={tool.kind}>
      <button
        type="button"
        className="tool-card__header"
        onClick={() => hasBody && setOpen((value) => !value)}
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
      >
        <span className="tool-card__icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="tool-card__meta">
          <span className="tool-card__title">{tool.title}</span>
          {tool.detail && (
            <span className="tool-card__detail" title={tool.detail}>
              {tool.detail}
            </span>
          )}
        </span>
        <span className="tool-card__status">
          <StatusGlyph status={tool.status} />
          <span>{statusLabel(tool.status)}</span>
        </span>
        {hasBody && (
          <span className="tool-card__chevron" aria-hidden="true">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
      </button>
      {open && hasBody && (
        <div className="tool-card__body">
          {tool.locations && tool.locations.length > 0 && (
            <div className="tool-card__section">
              <span className="tool-card__label">Paths</span>
              <ul className="tool-card__paths">
                {tool.locations.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {input && (
            <div className="tool-card__section">
              <span className="tool-card__label">Input</span>
              <pre className="tool-card__pre">{input}</pre>
            </div>
          )}
          {output && (
            <div className="tool-card__section">
              <span className="tool-card__label">Output</span>
              <pre className="tool-card__pre">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
