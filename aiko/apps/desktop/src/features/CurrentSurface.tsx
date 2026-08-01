import { useEffect, useRef } from "react";
import { ArrowRight, Command, FolderOpen, GitBranch, ShieldCheck } from "lucide-react";
import { Composer } from "../components/Composer";
import { MessageBody } from "../components/MessageBody";
import type { ConversationMessage, QuestionPartState } from "../app/types";
import type { CapabilityDiagnostic } from "../lib/agentStream";

interface CurrentSurfaceProps {
  attachment?: string;
  busy: boolean;
  capabilityDiagnostic?: CapabilityDiagnostic;
  messages: ConversationMessage[];
  streamingMessageId?: string;
  workspaceName?: string;
  onAttach: () => void;
  onCancel: () => void;
  onOpenWorkspace: () => void;
  onReviewContinuations: () => void;
  onSubmit: (value: string) => Promise<void>;
  onAnswerQuestion?: (
    question: QuestionPartState,
    answers: Record<string, string[]>,
  ) => void;
  onCancelQuestion?: (question: QuestionPartState) => void;
}

export function CurrentSurface({
  attachment,
  busy,
  capabilityDiagnostic,
  messages,
  streamingMessageId,
  workspaceName,
  onAttach,
  onCancel,
  onOpenWorkspace,
  onReviewContinuations,
  onSubmit,
  onAnswerQuestion,
  onCancelQuestion,
}: CurrentSurfaceProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Stick to bottom only when the user is already near it — avoids the
  // generative-UI stream yanking the viewport up and down on every height tick.
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom < 140) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, busy]);

  return (
    <section className="surface current-surface" aria-labelledby="current-title">
      <div className="surface__topline">
        <span className="surface__context">
          <FolderOpen size={14} aria-hidden="true" />
          {workspaceName ?? "No workspace open"}
        </span>
        <span className="surface__context">
          <GitBranch size={14} aria-hidden="true" />
          Main
        </span>
        {capabilityDiagnostic ? (
          <span
            className={`surface__route surface__route--${capabilityDiagnostic.status}`}
            title={[
              capabilityDiagnostic.freshness,
              ...capabilityDiagnostic.prerequisites,
              ...capabilityDiagnostic.reasonCodes,
              ...capabilityDiagnostic.candidates.map(
                (candidate) =>
                  `${candidate.capabilityId}@${candidate.capabilityVersion} ${candidate.status} ${Math.round(candidate.score * 100)}%`,
              ),
            ].filter(Boolean).join(" · ")}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            {capabilityDiagnostic.status === "degraded"
              ? "Routing unavailable"
              : capabilityDiagnostic.selectedRoute ?? "Normal routing"}
            <small>{Math.round(capabilityDiagnostic.confidence * 100)}% · {capabilityDiagnostic.learningStatus}</small>
          </span>
        ) : null}
      </div>

      {messages.length === 0 ? (
        <div className="current-empty">
          <div className="current-empty__copy">
            <p className="current-empty__overline">A quiet place for active work</p>
            <h1 id="current-title">What should we make true?</h1>
            <p>
              Open a workspace and describe the outcome. Aiko keeps the goal,
              authority, tools, and evidence in one continuous thread.
            </p>
          </div>

          <div className="quick-actions" aria-label="Quick actions">
            <button className="quick-action" onClick={onOpenWorkspace} type="button">
              <FolderOpen size={17} aria-hidden="true" />
              <span>
                <strong>Open workspace</strong>
                <small>Choose a local project</small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button
              className="quick-action"
              onClick={onReviewContinuations}
              type="button"
            >
              <ShieldCheck size={17} aria-hidden="true" />
              <span>
                <strong>Review continuations</strong>
                <small>See durable and scheduled work</small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : (
        <div className="conversation" aria-live="polite" ref={scrollerRef}>
          {messages.map((message) => (
            <article
              className="conversation__message"
              data-role={message.role}
              key={message.id}
            >
              <span className="conversation__role">
                {message.role === "user"
                  ? "You"
                  : message.role === "aiko"
                    ? "Aiko"
                    : "Runtime"}
              </span>
              <div className="conversation__body">
                <MessageBody
                  message={message}
                  workspace={workspaceName}
                  streaming={
                    busy &&
                    message.role === "aiko" &&
                    message.id === streamingMessageId
                  }
                  onAnswerQuestion={onAnswerQuestion}
                  onCancelQuestion={onCancelQuestion}
                />
              </div>
            </article>
          ))}
          {busy && (
            <div className="conversation__working" role="status">
              <span className="conversation__working-dot" aria-hidden="true" />
              Aiko is working…
            </div>
          )}
        </div>
      )}

      <div className="current-surface__composer">
        <Composer
          attachment={attachment}
          busy={busy}
          onAttach={onAttach}
          onCancel={onCancel}
          onSubmit={onSubmit}
          workspaceName={workspaceName}
        />
        <p className="composer-hint">
          <Command size={12} aria-hidden="true" />
          Enter to send · Shift Enter for a new line
        </p>
      </div>
    </section>
  );
}
