/**
 * ResourceViewer in-app confirm/conflict modals (never window.confirm).
 */

import type { MessageKey } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import { planDiffCommentToChat } from "@/lib/diffComment";
import type { BatchDiffPlan } from "@/lib/diffAccept";
import type { DiffViewState } from "./types";

export type ResourceViewerDialogsProps = {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
  conflictTabId: string | null;
  setConflictTabId: (id: string | null) => void;
  reloadActiveFile: () => void;
  saveActiveFile: (opts?: { force?: boolean }) => void;
  discardTabId: string | null;
  setDiscardTabId: (id: string | null) => void;
  closeTabForced: (id: string) => void;
  rejectConfirm: { path: string; name: string; untracked: boolean } | null;
  setRejectConfirm: (
    v: { path: string; name: string; untracked: boolean } | null,
  ) => void;
  diffActionBusy: boolean;
  executeRejectFile: (path: string, confirmed: boolean) => void;
  batchRejectConfirm: { plan: BatchDiffPlan; untracked: boolean } | null;
  setBatchRejectConfirm: (
    v: { plan: BatchDiffPlan; untracked: boolean } | null,
  ) => void;
  executeBatchReject: (plan: BatchDiffPlan, confirmed: boolean) => void;
  batchHunkRejectConfirm: boolean;
  setBatchHunkRejectConfirm: (v: boolean) => void;
  runBatchRemainingHunks: (action: "accept" | "reject") => void;
  remainingHunkCount: number;
  diffView: DiffViewState | null;
  diffCommentTarget: {
    path: string;
    name: string;
    hunkIndex: number;
    hunkHeader: string;
    hunkSnippet: string;
  } | null;
  setDiffCommentTarget: (
    v: {
      path: string;
      name: string;
      hunkIndex: number;
      hunkHeader: string;
      hunkSnippet: string;
    } | null,
  ) => void;
  diffCommentNote: string;
  setDiffCommentNote: (v: string) => void;
  diffCommentError: "empty" | "too_long" | "no_path" | "no_snippet" | null;
  setDiffCommentError: (
    v: "empty" | "too_long" | "no_path" | "no_snippet" | null,
  ) => void;
  onDiffCommentToChat?: (prompt: string) => void;
};

export function ResourceViewerDialogs({
  tr,
  conflictTabId,
  setConflictTabId,
  reloadActiveFile,
  saveActiveFile,
  discardTabId,
  setDiscardTabId,
  closeTabForced,
  rejectConfirm,
  setRejectConfirm,
  diffActionBusy,
  executeRejectFile,
  batchRejectConfirm,
  setBatchRejectConfirm,
  executeBatchReject,
  batchHunkRejectConfirm,
  setBatchHunkRejectConfirm,
  runBatchRemainingHunks,
  remainingHunkCount,
  diffView,
  diffCommentTarget,
  setDiffCommentTarget,
  diffCommentNote,
  setDiffCommentNote,
  diffCommentError,
  setDiffCommentError,
  onDiffCommentToChat,
}: ResourceViewerDialogsProps) {
  return (
    <>
<GlassModal
  open={!!conflictTabId}
  onClose={() => setConflictTabId(null)}
  title={tr("resources.conflictTitle")}
  size="sm"
  closeLabel={tr("common.close")}
  footer={
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => {
          setConflictTabId(null);
          void reloadActiveFile();
        }}
      >
        {tr("resources.conflictReload")}
      </button>
      <button
        type="button"
        className="btn btn--solid"
        onClick={() => {
          setConflictTabId(null);
          void saveActiveFile({ force: true });
        }}
      >
        {tr("resources.conflictOverwrite")}
      </button>
    </>
  }
>
  <p className="rp-modal-copy">{tr("resources.conflictBody")}</p>
</GlassModal>

<GlassModal
  open={!!discardTabId}
  onClose={() => setDiscardTabId(null)}
  title={tr("resources.discardTitle")}
  size="sm"
  closeLabel={tr("common.close")}
  footer={
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setDiscardTabId(null)}
      >
        {tr("common.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--solid"
        onClick={() => {
          const id = discardTabId;
          setDiscardTabId(null);
          if (id) closeTabForced(id);
        }}
      >
        {tr("resources.discardConfirm")}
      </button>
    </>
  }
>
  <p className="rp-modal-copy">{tr("resources.discardBody")}</p>
</GlassModal>

<GlassModal
  open={!!rejectConfirm}
  onClose={() => setRejectConfirm(null)}
  title={
    rejectConfirm?.untracked
      ? tr("changes.rejectConfirmUntrackedTitle")
      : tr("changes.rejectConfirmTitle")
  }
  size="sm"
  closeLabel={tr("common.close")}
  footer={
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setRejectConfirm(null)}
        disabled={diffActionBusy}
      >
        {tr("common.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--solid btn--danger"
        data-testid="changes-reject-confirm"
        disabled={diffActionBusy}
        onClick={() => {
          const p = rejectConfirm?.path;
          if (p) void executeRejectFile(p, true);
        }}
      >
        {diffActionBusy
          ? tr("changes.actionBusy")
          : tr("changes.rejectConfirmAction")}
      </button>
    </>
  }
>
  <p className="rp-modal-copy">
    {rejectConfirm?.untracked
      ? tr("changes.rejectConfirmUntrackedBody", {
          name: rejectConfirm.name,
        })
      : tr("changes.rejectConfirmBody")}
  </p>
</GlassModal>

<GlassModal
  open={!!batchRejectConfirm}
  onClose={() => setBatchRejectConfirm(null)}
  title={
    batchRejectConfirm?.untracked
      ? tr("changes.batchRejectConfirmUntrackedTitle")
      : tr("changes.batchRejectConfirmTitle")
  }
  size="sm"
  closeLabel={tr("common.close")}
  footer={
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setBatchRejectConfirm(null)}
        disabled={diffActionBusy}
      >
        {tr("common.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--solid btn--danger"
        data-testid="changes-batch-reject-confirm"
        disabled={diffActionBusy}
        onClick={() => {
          const p = batchRejectConfirm?.plan;
          if (p) void executeBatchReject(p, true);
        }}
      >
        {diffActionBusy
          ? tr("changes.actionBusy")
          : tr("changes.rejectAllRemaining")}
      </button>
    </>
  }
>
  <p className="rp-modal-copy">
    {batchRejectConfirm?.untracked
      ? tr("changes.batchRejectConfirmUntrackedBody", {
          n: String(batchRejectConfirm.plan.runCount),
          u: String(batchRejectConfirm.plan.untrackedConfirmCount),
        })
      : tr("changes.batchRejectConfirmBody", {
          n: String(batchRejectConfirm?.plan.runCount ?? 0),
        })}
  </p>
</GlassModal>

<GlassModal
  open={batchHunkRejectConfirm}
  onClose={() => setBatchHunkRejectConfirm(false)}
  title={tr("changes.batchHunksRejectConfirmTitle")}
  size="sm"
  closeLabel={tr("common.close")}
  footer={
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setBatchHunkRejectConfirm(false)}
        disabled={diffActionBusy}
      >
        {tr("common.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--solid btn--danger"
        data-testid="changes-batch-hunks-reject-confirm"
        disabled={diffActionBusy}
        onClick={() => void runBatchRemainingHunks("reject")}
      >
        {diffActionBusy
          ? tr("changes.actionBusy")
          : tr("changes.rejectAllHunks")}
      </button>
    </>
  }
>
  <p className="rp-modal-copy">
    {tr("changes.batchHunksRejectConfirmBody", {
      n: String(remainingHunkCount),
      name: diffView?.name ?? "",
    })}
  </p>
</GlassModal>

<GlassModal
  open={!!diffCommentTarget}
  onClose={() => {
    setDiffCommentTarget(null);
    setDiffCommentNote("");
    setDiffCommentError(null);
  }}
  title={tr("changes.commentModalTitle")}
  size="sm"
  closeLabel={tr("common.close")}
  wrapBody
  className="rp-diff-comment-modal"
  footer={
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => {
          setDiffCommentTarget(null);
          setDiffCommentNote("");
          setDiffCommentError(null);
        }}
      >
        {tr("common.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--solid"
        data-testid="changes-comment-insert"
        disabled={!onDiffCommentToChat}
        onClick={() => {
          if (!diffCommentTarget || !onDiffCommentToChat) return;
          const planned = planDiffCommentToChat({
            path: diffCommentTarget.path,
            name: diffCommentTarget.name,
            hunkHeader: diffCommentTarget.hunkHeader,
            hunkSnippet: diffCommentTarget.hunkSnippet,
            note: diffCommentNote,
          });
          if (!planned.ok) {
            setDiffCommentError(planned.reason);
            return;
          }
          onDiffCommentToChat(planned.prompt);
          setDiffCommentTarget(null);
          setDiffCommentNote("");
          setDiffCommentError(null);
        }}
      >
        {tr("changes.commentInsert")}
      </button>
    </>
  }
>
  <p className="rp-diff-comment-modal__desc">
    {diffCommentTarget
      ? tr("changes.commentModalDesc", {
          name:
            diffCommentTarget.name ||
            diffCommentTarget.path ||
            "",
          n: String(diffCommentTarget.hunkIndex + 1),
        })
      : null}
  </p>
  {diffCommentTarget?.hunkHeader ? (
    <p className="rp-diff-comment-modal__hunk" title={diffCommentTarget.hunkHeader}>
      {diffCommentTarget.hunkHeader}
    </p>
  ) : null}
  <label className="rp-diff-comment-modal__field">
    <span className="sr-only">{tr("changes.commentPlaceholder")}</span>
    <textarea
      className="rp-diff-comment-modal__textarea"
      value={diffCommentNote}
      onChange={(e) => {
        setDiffCommentNote(e.target.value);
        if (diffCommentError) setDiffCommentError(null);
      }}
      placeholder={tr("changes.commentPlaceholder")}
      rows={4}
      autoFocus
      data-testid="changes-comment-note"
    />
  </label>
  {diffCommentError ? (
    <p className="rp-diff-comment-modal__error" role="alert">
      {diffCommentError === "empty"
        ? tr("changes.commentErrorEmpty")
        : diffCommentError === "too_long"
          ? tr("changes.commentErrorTooLong")
          : tr("changes.commentErrorGeneric")}
    </p>
  ) : null}
</GlassModal>
    </>
  );
}
