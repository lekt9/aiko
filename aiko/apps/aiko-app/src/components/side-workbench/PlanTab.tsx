/**
 * Process-only Plan tab body — wraps PlanReviewPanel when plan data present.
 */

import { useMemo } from "react";
import { createT, type Locale } from "@/i18n";
import { PlanReviewPanel } from "@/components/PlanReviewPanel";
import type { PlanReviewState } from "@/lib/planBody";

export type PlanTabProps = {
  locale: Locale | string;
  plan?: PlanReviewState | null;
  planFocusKey?: number | null;
  onApprovePlan?: () => void;
  onRequestPlanChanges?: (note?: string) => void;
  onDismissPlan?: () => void;
};

export function PlanTab({
  locale,
  plan = null,
  planFocusKey = null,
  onApprovePlan,
  onRequestPlanChanges,
  onDismissPlan,
}: PlanTabProps) {
  const tr = useMemo(() => createT(locale as Locale), [locale]);

  if (!plan?.visible) {
    return (
      <div className="sw-plan" data-testid="side-plan-tab">
        <div className="rp__empty-state">
          <div className="rp__empty-title">{tr("resources.plan")}</div>
          <div className="rp__empty-desc">{tr("resources.planEmpty")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="sw-plan" data-testid="side-plan-tab">
      <PlanReviewPanel
        plan={plan}
        forceExpandKey={planFocusKey}
        labels={{
          ready: tr("plan.ready"),
          waiting: tr("plan.waiting"),
          progress: tr("planBar.progress"),
          done: tr("planBar.done"),
          empty: tr("plan.empty"),
          approve: tr("plan.approve"),
          changes: tr("plan.changes"),
          dismiss: tr("plan.dismiss"),
          steps: tr("plan.steps"),
          fraction: tr("planBar.fraction"),
          expandDetails: tr("plan.expandDetails"),
          collapseDetails: tr("plan.collapseDetails"),
          current: tr("planBar.current"),
          edit: tr("plan.edit"),
          cancelEdit: tr("plan.cancelEdit"),
          requestWithDraft: tr("plan.requestWithDraft"),
          approveDirtyHint: tr("plan.approveDirtyHint"),
          draftPlaceholder: tr("plan.draftPlaceholder"),
          draftAria: tr("plan.draftAria"),
          discardTitle: tr("plan.discardTitle"),
          discardMessage: tr("plan.discardMessage"),
          discardConfirm: tr("plan.discardConfirm"),
          discardCancel: tr("common.cancel"),
          draftEmpty: tr("plan.draftEmpty"),
          draftTooLong: tr("plan.draftTooLong"),
          close: tr("common.close"),
        }}
        onApprove={onApprovePlan}
        onRequestChanges={onRequestPlanChanges}
        onDismiss={onDismissPlan}
      />
    </div>
  );
}
