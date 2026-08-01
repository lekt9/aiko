import type { LucideIcon } from "lucide-react";

export type SurfaceId =
  | "current"
  | "continuations"
  | "channels"
  | "instruments"
  | "settings";

export interface Surface {
  id: SurfaceId;
  label: string;
  shortcut: string;
  icon: LucideIcon;
}

export interface RuntimeHealth {
  schema: string;
  status: "ok";
  version: string;
  pid: number;
  address: string;
  contractAbi: number | null;
  contractAvailable: boolean;
}

export interface ContractSummary {
  id: string;
  plan: string;
}

export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export interface ToolCallState {
  id: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  /** Human-readable summary of inputs (command, path, etc.) */
  detail?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  contentText?: string;
  locations?: string[];
}

/** Generative UI spec (json-render flat tree). Kept loosely typed for stream repair. */
export type GenerativeUiSpec = {
  root: string;
  elements: Record<string, unknown>;
  state?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface QuestionOptionView {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionView {
  question: string;
  options: QuestionOptionView[];
  multiSelect?: boolean;
}

export interface QuestionPartState {
  id: string;
  toolCallId: string;
  questions: QuestionView[];
  title?: string;
  mode?: "default" | "plan";
  requestId?: number | string;
  answered?: boolean;
  selected?: Record<string, string[]>;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: ToolCallState }
  | {
      type: "ui";
      id: string;
      spec: GenerativeUiSpec;
      partial?: boolean;
    }
  | { type: "question"; question: QuestionPartState };

export interface ConversationMessage {
  id: string;
  role: "user" | "aiko" | "status" | "error";
  /** Primary text (kept for simple cases / search). Prefer `parts` for rendering. */
  text: string;
  /** Structured body. When present, renderer uses this over `text`. */
  parts?: MessagePart[];
}

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "connected"; health: RuntimeHealth }
  | { kind: "unavailable"; message: string };
