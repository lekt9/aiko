import {
  Bot,
  ChevronsUpDown,
  CircleHelp,
  Clock3,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  LayoutDashboard,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcpClient } from "../bridge/acp";
import { getContract, getContracts, getHealth } from "../bridge/native";
import { BrandMark } from "../components/BrandMark";
import { RuntimeBadge } from "../components/RuntimeBadge";
import { ContinuationsSurface } from "../features/ContinuationsSurface";
import { CurrentSurface } from "../features/CurrentSurface";
import { SettingsSurface } from "../features/SettingsSurface";
import { TelegramChannelSurface } from "../features/TelegramChannelSurface";
import { UiLibrarySurface } from "../features/UiLibrarySurface";
import { parseQuestionPayload } from "../components/QuestionPicker";
import {
  applyToolUpdate,
  partsToPlainText,
  splitAgentText,
  streamEventFromParams,
  upsertQuestionPart,
  upsertToolPart,
} from "../lib/agentStream";
import type {
  ConnectionState,
  ContractSummary,
  ConversationMessage,
  MessagePart,
  QuestionPartState,
  Surface,
  SurfaceId,
} from "./types";
import type { CapabilityDiagnostic } from "../lib/agentStream";

const surfaces: Surface[] = [
  { id: "current", label: "Current", shortcut: "1", icon: Bot },
  { id: "continuations", label: "Continuations", shortcut: "2", icon: Clock3 },
  { id: "channels", label: "Channels", shortcut: "3", icon: MessageCircle },
  { id: "instruments", label: "Surfaces", shortcut: "4", icon: LayoutDashboard },
  { id: "settings", label: "Settings", shortcut: ",", icon: Settings2 },
];

function filename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function toolFingerprint(tool: {
  title: string;
  detail?: string;
  kind: string;
}): string {
  return `${tool.kind}|${tool.title}|${(tool.detail ?? "").slice(0, 120)}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function rebuildAikoMessage(
  accumulatedText: string,
  structuredParts: MessagePart[],
  streaming: boolean,
): { text: string; parts: MessagePart[] } {
  const textParts = splitAgentText(accumulatedText, { streaming });
  const structuredTools = structuredParts.filter(
    (part): part is Extract<MessagePart, { type: "tool" }> => part.type === "tool",
  );
  const structuredQuestions = structuredParts.filter(
    (part): part is Extract<MessagePart, { type: "question" }> =>
      part.type === "question",
  );
  const structuredIds = new Set(structuredTools.map((part) => part.tool.id));
  const structuredPrints = new Set(
    structuredTools.map((part) => toolFingerprint(part.tool)),
  );
  const questionToolIds = new Set(
    structuredQuestions.map((part) => part.question.toolCallId),
  );

  const merged: MessagePart[] = [];
  for (const part of textParts) {
    if (part.type === "text" || part.type === "ui") {
      merged.push(part);
      continue;
    }
    if (part.type === "question") {
      // Prefer structured ACP / reverse-request questions.
      const already = structuredQuestions.some(
        (q) =>
          q.question.toolCallId === part.question.toolCallId ||
          q.question.id === part.question.id,
      );
      if (!already) merged.push(part);
      continue;
    }
    // Drop leaked markup tools that already arrived as structured ACP events
    // or as interactive question pickers.
    if (
      structuredIds.has(part.tool.id) ||
      questionToolIds.has(part.tool.id) ||
      structuredPrints.has(toolFingerprint(part.tool))
    ) {
      continue;
    }
    merged.push(part);
  }

  for (const toolPart of structuredTools) {
    // Skip tools superseded by a question picker with the same id.
    if (questionToolIds.has(toolPart.tool.id)) continue;
    const already = merged.some(
      (part) =>
        part.type === "tool" &&
        (part.tool.id === toolPart.tool.id ||
          toolFingerprint(part.tool) === toolFingerprint(toolPart.tool)),
    );
    if (!already) merged.push(toolPart);
  }

  for (const questionPart of structuredQuestions) {
    const already = merged.some(
      (part) =>
        part.type === "question" &&
        (part.question.id === questionPart.question.id ||
          part.question.toolCallId === questionPart.question.toolCallId),
    );
    if (!already) merged.push(questionPart);
  }

  return {
    text: partsToPlainText(merged) || accumulatedText,
    parts: merged,
  };
}

export function App() {
  const [activeSurface, setActiveSurface] = useState<SurfaceId>("current");
  const [connection, setConnection] = useState<ConnectionState>({
    kind: "connecting",
  });
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractDetail, setContractDetail] = useState<{
    id: string;
    history: string;
  }>();
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [attachmentPath, setAttachmentPath] = useState<string>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [promptBusy, setPromptBusy] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string>();
  const [capabilityDiagnostic, setCapabilityDiagnostic] =
    useState<CapabilityDiagnostic>();
  const sessionIdRef = useRef<string | undefined>(undefined);
  const acpRef = useRef<AcpClient | undefined>(undefined);
  const messageCounter = useRef(0);
  const activeAssistantId = useRef<string | undefined>(undefined);
  const pendingPrompts = useRef(0);
  const receivedLiveOutput = useRef(false);
  /** Raw text buffer for the active assistant turn (pre-split). */
  const activeTextRef = useRef("");
  /** Structured ACP tool parts for the active assistant turn. */
  const activeToolsRef = useRef<MessagePart[]>([]);

  const appendMessage = useCallback(
    (role: ConversationMessage["role"], text: string) => {
      const id = `message-${++messageCounter.current}`;
      setMessages((current) => [...current, { id, role, text }]);
    },
    [],
  );

  const ensureAssistantMessage = useCallback(() => {
    let id = activeAssistantId.current;
    if (id) return id;
    id = `message-${++messageCounter.current}`;
    activeAssistantId.current = id;
    activeTextRef.current = "";
    activeToolsRef.current = [];
    setStreamingMessageId(id);
    setMessages((current) => [
      ...current,
      { id, role: "aiko", text: "", parts: [] },
    ]);
    return id;
  }, []);

  const publishRaf = useRef<number | null>(null);
  const publishTimer = useRef<number | null>(null);
  const lastStreamPublish = useRef(0);
  const publishAssistant = useCallback((streaming: boolean) => {
    const id = activeAssistantId.current;
    if (!id) return;
    // Coalesce stream UI rebuilds. Open json-render fences re-parse heavily;
    // publishing every token made playlist cards jump. Cap at ~8 Hz while
    // streaming; flush immediately when the turn ends.
    const run = () => {
      publishRaf.current = null;
      publishTimer.current = null;
      lastStreamPublish.current = Date.now();
      const activeId = activeAssistantId.current;
      if (!activeId) return;
      const { text, parts } = rebuildAikoMessage(
        activeTextRef.current,
        activeToolsRef.current,
        streaming,
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === activeId ? { ...message, text, parts } : message,
        ),
      );
    };
    if (!streaming) {
      if (publishRaf.current != null) {
        cancelAnimationFrame(publishRaf.current);
        publishRaf.current = null;
      }
      if (publishTimer.current != null) {
        window.clearTimeout(publishTimer.current);
        publishTimer.current = null;
      }
      run();
      return;
    }
    const elapsed = Date.now() - lastStreamPublish.current;
    const minGapMs = 120;
    if (elapsed >= minGapMs) {
      if (publishRaf.current != null) return;
      publishRaf.current = requestAnimationFrame(run);
      return;
    }
    if (publishTimer.current != null) return;
    publishTimer.current = window.setTimeout(() => {
      publishTimer.current = null;
      publishRaf.current = requestAnimationFrame(run);
    }, minGapMs - elapsed);
  }, []);

  const handleStreamEvent = useCallback(
    (params: unknown) => {
      const event = streamEventFromParams(params);
      if (!event) return;
      if (event.type === "capability") {
        setCapabilityDiagnostic(event.capability);
        return;
      }
      receivedLiveOutput.current = true;
      ensureAssistantMessage();

      if (event.type === "text") {
        activeTextRef.current += event.text;
        publishAssistant(true);
        return;
      }

      if (event.type === "thought") {
        // Thoughts stay out of the main transcript for now.
        return;
      }

      if (event.type === "question") {
        activeToolsRef.current = upsertQuestionPart(
          activeToolsRef.current,
          event.question,
        );
        publishAssistant(true);
        return;
      }

      if (event.type === "tool") {
        activeToolsRef.current = upsertToolPart(
          activeToolsRef.current,
          event.tool,
        );
        publishAssistant(true);
        return;
      }

      if (event.type === "tool_update") {
        // If an AskUserQuestion tool gains rawInput later, promote to picker.
        const questions = parseQuestionPayload(event.tool.rawInput);
        if (questions) {
          activeToolsRef.current = upsertQuestionPart(activeToolsRef.current, {
            id: `q-${event.tool.id}`,
            toolCallId: event.tool.id,
            questions,
            title:
              (event.tool.title ?? "").replace(/^Ask:\s*/i, "") ||
              "Choose an option",
            answered:
              event.tool.status === "completed" ||
              event.tool.status === "cancelled",
          });
        } else {
          activeToolsRef.current = applyToolUpdate(
            activeToolsRef.current,
            event.tool,
          );
          // Mirror terminal status onto an existing question picker.
          if (
            event.tool.status === "completed" ||
            event.tool.status === "cancelled" ||
            event.tool.status === "failed"
          ) {
            activeToolsRef.current = activeToolsRef.current.map((part) => {
              if (
                part.type === "question" &&
                part.question.toolCallId === event.tool.id
              ) {
                return {
                  type: "question",
                  question: { ...part.question, answered: true },
                };
              }
              return part;
            });
          }
        }
        publishAssistant(true);
      }
    },
    [ensureAssistantMessage, publishAssistant],
  );

  const markQuestionAnswered = useCallback(
    (
      question: QuestionPartState,
      selected?: Record<string, string[]>,
      answered = true,
    ) => {
      const next: QuestionPartState = {
        ...question,
        answered,
        ...(selected ? { selected } : {}),
      };
      activeToolsRef.current = upsertQuestionPart(activeToolsRef.current, next);
      setMessages((current) =>
        current.map((message) => {
          if (!message.parts) return message;
          const parts = upsertQuestionPart(message.parts, next);
          if (parts === message.parts) return message;
          return {
            ...message,
            parts,
            text: partsToPlainText(parts) || message.text,
          };
        }),
      );
      publishAssistant(Boolean(activeAssistantId.current));
    },
    [publishAssistant],
  );

  const onAnswerQuestion = useCallback(
    (question: QuestionPartState, answers: Record<string, string[]>) => {
      const requestId = question.requestId;
      if (requestId !== undefined && acpRef.current) {
        acpRef.current.respond(requestId, {
          outcome: "accepted",
          answers,
        });
      }
      markQuestionAnswered(question, answers, true);
    },
    [markQuestionAnswered],
  );

  const onCancelQuestion = useCallback(
    (question: QuestionPartState) => {
      const requestId = question.requestId;
      if (requestId !== undefined && acpRef.current) {
        acpRef.current.respond(requestId, { outcome: "cancelled" });
      }
      markQuestionAnswered(question, question.selected, true);
    },
    [markQuestionAnswered],
  );

  const handleServerRequest = useCallback(
    (id: number | string, method: string, params: unknown) => {
      const isAsk =
        method === "x.ai/ask_user_question" ||
        method.endsWith("ask_user_question");
      if (!isAsk) {
        // Permissions already auto-handled in AcpClient when no handler;
        // still allow-once here so the wired handler path stays complete.
        if (
          method === "session/request_permission" ||
          method.endsWith("request_permission")
        ) {
          acpRef.current?.respond(id, {
            outcome: { outcome: "selected", optionId: "allow-once" },
          });
          return;
        }
        acpRef.current?.respondError(id, `Unhandled reverse-request: ${method}`);
        return;
      }

      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const questions = parseQuestionPayload(params);
      if (!questions) {
        acpRef.current?.respond(id, { outcome: "cancelled" });
        return;
      }

      const toolCallId =
        (typeof record.toolCallId === "string" && record.toolCallId) ||
        (typeof record.tool_call_id === "string" && record.tool_call_id) ||
        `ask-${id}`;
      const modeRaw = record.mode;
      const mode =
        modeRaw === "plan" || modeRaw === "Plan" ? ("plan" as const) : ("default" as const);

      receivedLiveOutput.current = true;
      ensureAssistantMessage();
      const question: QuestionPartState = {
        id: `q-${toolCallId}`,
        toolCallId,
        questions,
        title: "Choose an option",
        mode,
        requestId: id,
        answered: false,
      };
      activeToolsRef.current = upsertQuestionPart(
        activeToolsRef.current,
        question,
      );
      publishAssistant(true);
      // Do not respond yet — wait for the user to click options.
    },
    [ensureAssistantMessage, publishAssistant],
  );

  const ensureAcp = useCallback(async () => {
    if (!acpRef.current) {
      acpRef.current = new AcpClient((method, params) => {
        if (
          method === "aiko/session/prompt_complete" ||
          method === "x.ai/session/prompt_complete"
        ) {
          // Finalize: re-parse without streaming strip, mark tools completed
          // if still pending and no structured status arrived.
          if (activeAssistantId.current) {
            activeToolsRef.current = activeToolsRef.current.map((part) => {
              if (part.type !== "tool") return part;
              if (
                part.tool.status === "in_progress" ||
                part.tool.status === "pending"
              ) {
                // Leave status alone for structured ACP tools; only leaked
                // tools (id starts with leaked-/invoke-) settle as completed.
                if (
                  part.tool.id.startsWith("leaked-") ||
                  part.tool.id.startsWith("invoke-")
                ) {
                  return {
                    type: "tool",
                    tool: { ...part.tool, status: "completed" },
                  };
                }
              }
              return part;
            });
            const id = activeAssistantId.current;
            const { text, parts } = rebuildAikoMessage(
              activeTextRef.current,
              activeToolsRef.current,
              false,
            );
            setMessages((current) =>
              current.map((message) =>
                message.id === id ? { ...message, text, parts } : message,
              ),
            );
          }
          activeAssistantId.current = undefined;
          setStreamingMessageId(undefined);
          return;
        }
        if (
          method !== "session/update" &&
          method !== "_aiko/session/update" &&
          method !== "_x.ai/session/update"
        ) {
          return;
        }
        handleStreamEvent(params);
      });
      acpRef.current.onServerRequest(handleServerRequest);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        await acpRef.current.connect();
        return acpRef.current;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Aiko’s session runtime is unavailable.");
  }, [handleServerRequest, handleStreamEvent]);

  const connect = useCallback(async () => {
    setConnection({ kind: "connecting" });
    let lastError: unknown;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      try {
        const health = await getHealth();
        setConnection({ kind: "connected", health });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    setConnection({
      kind: "unavailable",
      message:
        lastError instanceof Error ? lastError.message : "Aiko is unavailable.",
    });
  }, []);

  const chooseWorkspace = useCallback(async () => {
    const path = await open({ directory: true, multiple: false });
    if (!path) return undefined;
    setWorkspacePath(path);
    sessionIdRef.current = undefined;
    setMessages([]);
    activeAssistantId.current = undefined;
    setStreamingMessageId(undefined);
    activeTextRef.current = "";
    activeToolsRef.current = [];
    return path;
  }, []);

  const newCurrent = useCallback(() => {
    acpRef.current?.close();
    acpRef.current = undefined;
    sessionIdRef.current = undefined;
    setMessages([]);
    setAttachmentPath(undefined);
    pendingPrompts.current = 0;
    setPromptBusy(false);
    activeAssistantId.current = undefined;
    setStreamingMessageId(undefined);
    activeTextRef.current = "";
    activeToolsRef.current = [];
    setActiveSurface("current");
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    return () => acpRef.current?.close();
  }, []);

  useEffect(() => {
    if (activeSurface !== "continuations" || connection.kind !== "connected") {
      return;
    }
    setContractsLoading(true);
    void getContracts()
      .then(setContracts)
      .finally(() => setContractsLoading(false));
  }, [activeSurface, connection.kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        newCurrent();
        return;
      }
      const target = surfaces.find((surface) => surface.shortcut === event.key);
      if (!target) return;
      event.preventDefault();
      setActiveSurface(target.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newCurrent]);

  const submitPrompt = useCallback(
    async (text: string) => {
      const cwd = workspacePath ?? (await chooseWorkspace());
      if (!cwd) {
        appendMessage("error", "Choose a workspace before starting work.");
        return;
      }
      let prompt = attachmentPath
        ? `${text}\n\nAttached files:\n- ${attachmentPath}`
        : text;
      appendMessage("user", text);
      activeAssistantId.current = undefined;
      setStreamingMessageId(undefined);
      activeTextRef.current = "";
      activeToolsRef.current = [];
      receivedLiveOutput.current = false;
      pendingPrompts.current += 1;
      setPromptBusy(true);
      setAttachmentPath(undefined);
      try {
        const client = await ensureAcp();
        const sessionId =
          sessionIdRef.current ?? (await client.newSession(cwd));
        sessionIdRef.current = sessionId;
        // Do NOT append registry guides into the user goal text — that polluted
        // ledger plans and broke contract recommend/reuse matching.
        // Generative UI rules live in the agent system prompt instead.
        const result = await client.prompt(sessionId, prompt);
        if (result.text && !receivedLiveOutput.current) {
          const parts = splitAgentText(result.text, { streaming: false });
          const id = `message-${++messageCounter.current}`;
          setMessages((current) => [
            ...current,
            {
              id,
              role: "aiko",
              text: partsToPlainText(parts) || result.text,
              parts,
            },
          ]);
        } else if (activeAssistantId.current) {
          // Prompt RPC returned; finalize streaming message.
          const id = activeAssistantId.current;
          activeToolsRef.current = activeToolsRef.current.map((part) => {
            if (part.type !== "tool") return part;
            if (
              (part.tool.status === "in_progress" ||
                part.tool.status === "pending") &&
              (part.tool.id.startsWith("leaked-") ||
                part.tool.id.startsWith("invoke-"))
            ) {
              return {
                type: "tool",
                tool: { ...part.tool, status: "completed" },
              };
            }
            return part;
          });
          const rebuilt = rebuildAikoMessage(
            activeTextRef.current,
            activeToolsRef.current,
            false,
          );
          setMessages((current) =>
            current.map((message) =>
              message.id === id
                ? { ...message, text: rebuilt.text, parts: rebuilt.parts }
                : message,
            ),
          );
          activeAssistantId.current = undefined;
          setStreamingMessageId(undefined);
        }
      } catch (error) {
        appendMessage(
          "error",
          error instanceof Error ? error.message : "The prompt failed.",
        );
      } finally {
        pendingPrompts.current = Math.max(0, pendingPrompts.current - 1);
        setPromptBusy(pendingPrompts.current > 0);
      }
    },
    [
      appendMessage,
      attachmentPath,
      chooseWorkspace,
      ensureAcp,
      workspacePath,
    ],
  );

  const content = useMemo(() => {
    switch (activeSurface) {
      case "current":
        return (
          <CurrentSurface
            attachment={attachmentPath ? filename(attachmentPath) : undefined}
            busy={promptBusy}
            capabilityDiagnostic={capabilityDiagnostic}
            messages={messages}
            streamingMessageId={streamingMessageId}
            onAnswerQuestion={onAnswerQuestion}
            onCancelQuestion={onCancelQuestion}
            onAttach={() => {
              void open({ directory: false, multiple: false }).then((path) => {
                if (path) setAttachmentPath(path);
              });
            }}
            onCancel={() => {
              const sessionId = sessionIdRef.current;
              if (sessionId) void acpRef.current?.cancel(sessionId);
              pendingPrompts.current = 0;
              setPromptBusy(false);
            }}
            onOpenWorkspace={() => void chooseWorkspace()}
            onReviewContinuations={() => setActiveSurface("continuations")}
            onSubmit={submitPrompt}
            workspaceName={workspacePath ? filename(workspacePath) : undefined}
          />
        );
      case "continuations":
        return (
          <ContinuationsSurface
            contracts={contracts}
            detail={contractDetail}
            loading={contractsLoading}
            onInspect={(id) => {
              setContractsLoading(true);
              void getContract(id)
                .then(setContractDetail)
                .finally(() => setContractsLoading(false));
            }}
          />
        );
      case "channels":
        return <TelegramChannelSurface />;
      case "instruments":
        return (
          <UiLibrarySurface
            workspaceName={workspacePath ? filename(workspacePath) : undefined}
          />
        );
      case "settings":
        return <SettingsSurface />;
    }
  }, [
    activeSurface,
    attachmentPath,
    chooseWorkspace,
    contractDetail,
    contracts,
    contractsLoading,
    messages,
    promptBusy,
    streamingMessageId,
    submitPrompt,
    workspacePath,
  ]);

  return (
    <div className="app-frame">
      <aside className="rail">
        <div className="rail__drag-region" data-tauri-drag-region />
        <BrandMark />
        <button className="new-current" type="button" onClick={newCurrent}>
          <Plus size={16} aria-hidden="true" />
          <span>New current</span>
          <kbd>⌘N</kbd>
        </button>
        <nav className="rail__nav" aria-label="Primary">
          {surfaces.slice(0, 4).map(({ id, label, icon: Icon, shortcut }) => (
            <button
              className="rail-link"
              data-active={activeSurface === id}
              key={id}
              onClick={() => setActiveSurface(id)}
              type="button"
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
              <kbd>⌘{shortcut}</kbd>
            </button>
          ))}
        </nav>
        <div className="rail__projects">
          <div className="rail__section-title">
            <span>Workspaces</span>
            <button
              type="button"
              aria-label="Open workspace"
              onClick={() => void chooseWorkspace()}
            >
              <Search size={14} aria-hidden="true" />
            </button>
          </div>
          <button
            className="workspace-row"
            type="button"
            onClick={() =>
              workspacePath
                ? setActiveSurface("current")
                : void chooseWorkspace()
            }
          >
            {workspacePath ? (
              <span className="workspace-row__glyph">
                {filename(workspacePath).slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <Plus size={15} aria-hidden="true" />
            )}
            <span>
              <strong>
                {workspacePath ? filename(workspacePath) : "Open workspace"}
              </strong>
              <small>{workspacePath ?? "Choose a local folder"}</small>
            </span>
          </button>
        </div>
        <div className="rail__footer">
          <RuntimeBadge state={connection} onRetry={() => void connect()} />
          <button
            className="rail-link"
            data-active={activeSurface === "settings"}
            onClick={() => setActiveSurface("settings")}
            type="button"
          >
            <Settings2 size={17} aria-hidden="true" />
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </button>
          <button
            className="account-row"
            type="button"
            onClick={() => setActiveSurface("settings")}
          >
            <span className="account-row__avatar">L</span>
            <span>
              <strong>Local account</strong>
              <small>
                {connection.kind === "connected" ? "Connected" : "Check runtime"}
              </small>
            </span>
            <ChevronsUpDown size={14} aria-hidden="true" />
          </button>
        </div>
      </aside>
      <main className="workbench">
        <div className="window-drag-region" data-tauri-drag-region>
          <button
            type="button"
            aria-label="Runtime help"
            onClick={() => setActiveSurface("settings")}
          >
            <CircleHelp size={15} aria-hidden="true" />
          </button>
        </div>
        {content}
      </main>
    </div>
  );
}
