import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ConversationMessage, MessagePart, QuestionPartState } from "../app/types";
import { GenerativeView } from "../generative/GenerativeView";
import {
  putUiComponent,
  routeFromTitle,
  titleFromSpec,
} from "../generative/store";
import { splitAgentText } from "../lib/agentStream";
import { QuestionPicker } from "./QuestionPicker";
import { ToolCallCard } from "./ToolCallCard";
import type { Spec } from "@json-render/react";

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`c-${key++}`} className="msg-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={`i-${key++}`}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function TextBlock({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className="message-prose">
      {paragraphs.map((paragraph, index) => {
        const lines = paragraph.split("\n");
        return (
          <p key={index}>
            {lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function PersistUi({
  spec,
  partial,
  workspace,
}: {
  spec: Spec;
  partial?: boolean;
  workspace?: string;
}) {
  const saved = useRef<string | null>(null);
  const [pointer, setPointer] = useState<string | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  useEffect(() => {
    if (partial) return;
    const digest = JSON.stringify(spec);
    if (saved.current === digest) return;
    saved.current = digest;
    const title = titleFromSpec(spec);
    void putUiComponent({
      title,
      spec,
      workspace,
      route: routeFromTitle(title),
      tags: ["generative", "chat"],
      registerContract: true,
    })
      .then((result) => {
        setPointer(result.pointer);
        setContractId(result.contractId ?? result.meta.contractId ?? null);
      })
      .catch((err) => {
        console.warn("Failed to persist generative UI", err);
      });
  }, [spec, partial, workspace]);
  if (!pointer) return null;
  return (
    <div className="gen-pointer-chip" title="Contract-native surface">
      <code>{pointer}</code>
      {contractId && <span>contract:{contractId}</span>}
    </div>
  );
}

function Parts({
  parts,
  streaming,
  workspace,
  onAnswerQuestion,
  onCancelQuestion,
}: {
  parts: MessagePart[];
  streaming?: boolean;
  workspace?: string;
  onAnswerQuestion?: (
    question: QuestionPartState,
    answers: Record<string, string[]>,
  ) => void;
  onCancelQuestion?: (question: QuestionPartState) => void;
}) {
  return (
    <div className="message-parts">
      {parts.map((part, index) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return <TextBlock key={`t-${index}`} text={part.text} />;
        }
        if (part.type === "ui") {
          const isPartial = Boolean(part.partial || streaming);
          return (
            <div key={part.id || `ui-${index}`} className="message-ui-block">
              <GenerativeView
                spec={part.spec as Spec}
                streaming={isPartial && Boolean(part.partial)}
              />
              <PersistUi
                spec={part.spec as Spec}
                partial={isPartial && Boolean(part.partial)}
                workspace={workspace}
              />
            </div>
          );
        }
        if (part.type === "question") {
          return (
            <QuestionPicker
              key={part.question.id}
              prompt={{
                toolCallId: part.question.toolCallId,
                questions: part.question.questions,
                title: part.question.title,
                mode: part.question.mode,
                requestId: part.question.requestId,
              }}
              answered={part.question.answered}
              selected={part.question.selected}
              onAnswer={(answers) =>
                onAnswerQuestion?.(part.question, answers)
              }
              onCancel={() => onCancelQuestion?.(part.question)}
            />
          );
        }
        return (
          <ToolCallCard key={part.tool.id || `tool-${index}`} tool={part.tool} />
        );
      })}
    </div>
  );
}

interface MessageBodyProps {
  message: ConversationMessage;
  streaming?: boolean;
  workspace?: string;
  onAnswerQuestion?: (
    question: QuestionPartState,
    answers: Record<string, string[]>,
  ) => void;
  onCancelQuestion?: (question: QuestionPartState) => void;
}

export function MessageBody({
  message,
  streaming,
  workspace,
  onAnswerQuestion,
  onCancelQuestion,
}: MessageBodyProps) {
  if (
    message.role === "user" ||
    message.role === "error" ||
    message.role === "status"
  ) {
    return <TextBlock text={message.text} />;
  }

  if (message.parts && message.parts.length > 0) {
    return (
      <Parts
        parts={message.parts}
        streaming={streaming}
        workspace={workspace}
        onAnswerQuestion={onAnswerQuestion}
        onCancelQuestion={onCancelQuestion}
      />
    );
  }

  const parts = splitAgentText(message.text, { streaming });
  if (parts.length === 0) {
    return streaming ? (
      <span className="message-streaming-dot" aria-label="Generating">
        …
      </span>
    ) : null;
  }
  return (
    <Parts
      parts={parts}
      streaming={streaming}
      workspace={workspace}
      onAnswerQuestion={onAnswerQuestion}
      onCancelQuestion={onCancelQuestion}
    />
  );
}
