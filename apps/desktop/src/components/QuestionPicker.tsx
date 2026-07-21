import { Check, HelpCircle } from "lucide-react";
import { useMemo, useState } from "react";

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionPrompt {
  toolCallId: string;
  questions: QuestionItem[];
  mode?: "default" | "plan";
  /** JSON-RPC id to reply to, when this came from reverse-request */
  requestId?: number | string;
  title?: string;
}

interface QuestionPickerProps {
  prompt: QuestionPrompt;
  onAnswer: (
    answers: Record<string, string[]>,
    requestId?: number | string,
  ) => void;
  onCancel?: (requestId?: number | string) => void;
  answered?: boolean;
  selected?: Record<string, string[]>;
}

/**
 * Interactive multi-option picker for AskUserQuestion tool calls.
 * Renders as generative UI (buttons), not raw JSON.
 */
export function QuestionPicker({
  prompt,
  onAnswer,
  onCancel,
  answered,
  selected: selectedProp,
}: QuestionPickerProps) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const selections = answered && selectedProp ? selectedProp : picked;

  const allAnswered = useMemo(() => {
    return prompt.questions.every((q) => (selections[q.question]?.length ?? 0) > 0);
  }, [prompt.questions, selections]);

  const submitWith = (answers: Record<string, string[]>) => {
    if (answered) return;
    const ready = prompt.questions.every(
      (q) => (answers[q.question]?.length ?? 0) > 0,
    );
    if (!ready) return;
    onAnswer(answers, prompt.requestId);
  };

  const toggle = (question: string, label: string, multi: boolean) => {
    if (answered) return;
    setPicked((prev) => {
      const current = prev[question] ?? [];
      let next: Record<string, string[]>;
      if (multi) {
        const labels = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        next = { ...prev, [question]: labels };
      } else {
        next = { ...prev, [question]: [label] };
      }
      // Single-select: auto-submit once every question has a choice.
      if (!multi) {
        const ready = prompt.questions.every((q) => {
          if (q.multiSelect) return (next[q.question]?.length ?? 0) > 0;
          // Current question just set; others need a pick too.
          return (next[q.question]?.length ?? 0) > 0;
        });
        const anyMulti = prompt.questions.some((q) => q.multiSelect);
        if (ready && !anyMulti) {
          // Defer so state settles; one-click song pick continues immediately.
          queueMicrotask(() => submitWith(next));
        }
      }
      return next;
    });
  };

  const submit = () => {
    if (!allAnswered || answered) return;
    submitWith(selections);
  };

  return (
    <div className="question-picker" data-answered={answered ? "true" : "false"}>
      <header className="question-picker__header">
        <HelpCircle size={16} aria-hidden="true" />
        <div>
          <strong>{prompt.title ?? "Choose an option"}</strong>
          {!answered && (
            <p className="question-picker__hint">
              Click an option to select
              {prompt.questions.some((q) => q.multiSelect) ? " (multi-select available)" : ""}.
            </p>
          )}
          {answered && (
            <p className="question-picker__hint">Answer submitted</p>
          )}
        </div>
      </header>

      {prompt.questions.map((q) => (
        <fieldset key={q.question} className="question-picker__question" disabled={answered}>
          <legend>{q.question}</legend>
          <div className="question-picker__options" role="listbox" aria-label={q.question}>
            {q.options.map((opt) => {
              const isSelected = (selections[q.question] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="question-picker__option"
                  data-selected={isSelected}
                  onClick={() => toggle(q.question, opt.label, Boolean(q.multiSelect))}
                >
                  <span className="question-picker__option-check" aria-hidden="true">
                    {isSelected ? <Check size={14} /> : null}
                  </span>
                  <span className="question-picker__option-body">
                    <strong>{opt.label}</strong>
                    {opt.description && <small>{opt.description}</small>}
                    {opt.preview && (
                      <pre className="question-picker__preview">{opt.preview}</pre>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      {!answered && (
        <div className="question-picker__actions">
          {onCancel && (
            <button
              type="button"
              className="question-picker__btn question-picker__btn--ghost"
              onClick={() => onCancel(prompt.requestId)}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="question-picker__btn question-picker__btn--primary"
            disabled={!allAnswered}
            onClick={submit}
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}

/** Extract questions from AskUserQuestion tool rawInput or reverse-request params. */
export function parseQuestionPayload(raw: unknown): QuestionItem[] | null {
  if (!raw) return null;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  // Nested: { variant: "AskUserQuestion", questions: [...] }
  // or { questions: [...] }
  // or reverse request: { sessionId, toolCallId, questions, mode }
  let questions = record.questions;
  if (!Array.isArray(questions) && record.params && typeof record.params === "object") {
    questions = (record.params as Record<string, unknown>).questions;
  }
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const items: QuestionItem[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") continue;
    const qr = q as Record<string, unknown>;
    const question = typeof qr.question === "string" ? qr.question : null;
    const optionsRaw = Array.isArray(qr.options) ? qr.options : [];
    if (!question || optionsRaw.length === 0) continue;
    const options: QuestionOption[] = [];
    for (const o of optionsRaw) {
      if (!o || typeof o !== "object") continue;
      const or = o as Record<string, unknown>;
      if (typeof or.label !== "string") continue;
      options.push({
        label: or.label,
        description:
          typeof or.description === "string" ? or.description : undefined,
        preview: typeof or.preview === "string" ? or.preview : undefined,
      });
    }
    if (options.length === 0) continue;
    items.push({
      question,
      options,
      multiSelect: Boolean(qr.multiSelect ?? qr.multi_select),
    });
  }
  return items.length > 0 ? items : null;
}

export function isAskUserQuestionTool(tool: {
  title?: string;
  rawInput?: unknown;
  kind?: string;
}): boolean {
  const title = (tool.title ?? "").toLowerCase();
  if (title.startsWith("ask:") || title.includes("ask user") || title.includes("pick a song")) {
    return true;
  }
  if (parseQuestionPayload(tool.rawInput)) return true;
  return false;
}
