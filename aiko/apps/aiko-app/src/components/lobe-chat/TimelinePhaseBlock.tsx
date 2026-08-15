/**
 * Grok.com activity phase — visual 1:1 with official web reference.
 *
 * Expanded reference:
 *   Worked for 1m 2s ∨
 *   💡 thought title
 *   │
 *   🔍 Ran 4 searches
 *   │
 *   🌐 Browsed host/path/
 *   │
 *   🌐 Searched web for {query}          10 results  [◉◉]
 *   │
 *   ○  Compiling …
 *
 * Collapsed: only “Worked for … >”
 * Live: steps + “Working for …s” footer
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { COLLAPSE_ALL_ACTIVITY_EVENT } from "@/lib/collapseAllActivity";
import type { TimelinePhase } from "@/lib/timelinePhases";
import {
  loadToolStepsAutoCollapsePref,
  toolStepDefaultOpen,
  TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT,
} from "@/lib/toolStepsAutoCollapsePref";
import {
  earliestTimestampMs,
  estimateDurationSecFromTimestamps,
  formatWorkDuration,
  resolveWorkDurationSec,
} from "@/lib/formatWorkDuration";
import { resolveWorkChromeLabel } from "@/lib/workChromeLabel";
import {
  buildGrokActivitySteps,
  type GrokActivityStep,
} from "@/lib/grokActivitySteps";
import {
  resolveToolPrimaryLabel,
  toolExpandBody,
  type ToolDisplayKind,
} from "@/lib/toolDisplay";
import {
  GROK_ACTIVITY_STEP_ROW_PX,
  applyActivityStepExpandPolicy,
  applyActivityStepUserToggle,
  emptyActivityStepExpandState,
  grokActivityVirtualMaxHeightPx,
  shouldVirtualizeActivityWithExpand,
  type ActivityStepExpandState,
} from "@/lib/grokActivityVirtualize";
import { VirtualList } from "@/components/VirtualList";
import {
  IconBulb,
  IconChevronDown,
  IconChevronRight,
  IconCircle,
  IconEdit,
  IconFileText,
  IconFolder,
  IconGridDots,
  IconRobot,
  IconSearch,
  IconSkills,
  IconTerminal,
  IconWorld,
} from "@/components/icons";

function FaviconChip({ domain }: { domain: string }) {
  // Google s2 favicon — lightweight, no auth
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  return (
    <img
      className="aiko-act__favicon"
      src={src}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

/** Tool-type icon — one style for live and history (typed, not a bare dot). */
export function ToolBucketIcon({
  bucket,
  toolKind,
  size = 15,
  stroke = 1.5,
}: {
  bucket: ToolDisplayKind;
  toolKind?: string | null;
  size?: number;
  stroke?: number;
}) {
  // Machine tool names give finer icons than buckets (list_dir vs read_file).
  const k = (toolKind || "").toLowerCase();
  if (k.includes("list_dir") || k.includes("list_directory") || k === "ls") {
    return <IconFolder size={size} stroke={stroke} />;
  }
  switch (bucket) {
    case "bash":
      return <IconTerminal size={size} stroke={stroke} />;
    case "read":
      return <IconFileText size={size} stroke={stroke} />;
    case "edit":
      return <IconEdit size={size} stroke={stroke} />;
    case "search":
      return <IconSearch size={size} stroke={stroke} />;
    case "browse":
      return <IconWorld size={size} stroke={stroke} />;
    case "subagent":
      return <IconRobot size={size} stroke={stroke} />;
    default:
      return <IconSkills size={size} stroke={stroke} />;
  }
}

function StepIcon({ step }: { step: GrokActivityStep }) {
  // Official icons are ~15–16px, thin stroke, muted gray
  const size = 15;
  const stroke = 1.5;
  if (step.type === "thought") return <IconBulb size={size} stroke={stroke} />;
  if (step.type === "search-group")
    return <IconSearch size={size} stroke={stroke} />;
  if (step.type === "web-search")
    // Official uses globe+search hybrid; World is closest available
    return <IconWorld size={size} stroke={stroke} />;
  if (step.type === "browse") return <IconWorld size={size} stroke={stroke} />;
  if (step.type === "tool")
    return (
      <ToolBucketIcon bucket={step.bucket} toolKind={step.tool.toolKind} />
    );
  return <IconCircle size={size} stroke={stroke} />;
}

function StepMainText({
  step,
  tr,
}: {
  step: GrokActivityStep;
  tr: ReturnType<typeof createT>;
}) {
  switch (step.type) {
    case "thought":
      return (
        <span className="aiko-act__label-text">
          {step.summary || tr("chat.thinkingLabel")}
        </span>
      );
    case "search-group":
      return (
        <span className="aiko-act__label-text">
          {step.count === 1
            ? tr("chat.ranSearch")
            : tr("chat.ranSearches", { n: String(step.count) })}
        </span>
      );
    case "web-search":
      return (
        <span className="aiko-act__label-text">
          <span className="aiko-act__label-prefix">
            {tr("chat.searchedWebForPrefix")}
          </span>
          <span className="aiko-act__label-query"> {step.query}</span>
        </span>
      );
    case "browse":
      return (
        <span className="aiko-act__label-text">
          <span className="aiko-act__label-prefix">{tr("chat.browsedPrefix")}</span>
          <span className="aiko-act__label-url"> {step.url}</span>
        </span>
      );
    case "tool": {
      // Same primary-label resolver as bare TimelineToolRow.
      const label = resolveToolPrimaryLabel(step.tool, (key, params) =>
        tr(key as MessageKey, params as Record<string, string> | undefined),
      );
      return <span className="aiko-act__label-text">{label}</span>;
    }
  }
}

const GrokActivityStepRow = memo(function GrokActivityStepRow({
  step,
  isLast,
  tr,
  expanded,
  onUserToggle,
  onPolicySync,
}: {
  step: GrokActivityStep;
  isLast: boolean;
  tr: ReturnType<typeof createT>;
  /** Parent-owned open state — survives VirtualList → map remount. */
  expanded: boolean;
  /** User click: mark user-toggled + set open (parent). */
  onUserToggle?: (key: string, open: boolean) => void;
  /**
   * Running / auto-collapse policy sync (parent). Applies even when currently
   * expanded so running→finished collapses under default autoCollapse.
   * Never called on unmount.
   */
  onPolicySync?: (
    key: string,
    opts: { hasBody: boolean; running: boolean; autoCollapse: boolean },
  ) => void;
}) {
  const failed =
    step.type !== "thought" && "failed" in step ? !!step.failed : false;
  const running =
    step.type === "thought"
      ? !!step.streaming
      : "running" in step
        ? !!step.running
        : false;
  const resultCount =
    step.type === "web-search" ? step.resultCount : undefined;
  const domains =
    step.type === "web-search" ? step.resultDomains : undefined;

  const expandTool = step.type === "tool" ? step.tool : null;
  const { failHint, failHintShort, detailTail, hasBody } = expandTool
    ? toolExpandBody(expandTool, failed)
    : { failHint: "", failHintShort: "", detailTail: "", hasBody: false };

  const runningRef = useRef(running);
  runningRef.current = running;
  const [autoCollapse, setAutoCollapse] = useState(() =>
    loadToolStepsAutoCollapsePref(),
  );

  useEffect(() => {
    const onPref = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const next =
        typeof detail === "boolean" ? detail : loadToolStepsAutoCollapsePref();
      setAutoCollapse(next);
    };
    window.addEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    return () => {
      window.removeEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    };
  }, []);

  // Policy: running → open; finished → toolStepDefaultOpen (autoCollapse).
  // User-toggled keys are ignored inside parent applyActivityStepExpandPolicy.
  // Do not skip when expanded=true — that blocked running→finished collapse.
  useEffect(() => {
    if (!hasBody || !onPolicySync) return;
    onPolicySync(step.key, {
      hasBody: true,
      running,
      autoCollapse,
    });
  }, [running, autoCollapse, step.key, hasBody, onPolicySync]);

  const open = hasBody && expanded;
  const showBody = open;

  return (
    <div
      className={
        "aiko-act__step" +
        (failed ? " is-error" : "") +
        (running ? " is-running" : "") +
        (isLast ? " is-last" : "") +
        (showBody ? " lobe-timeline-tool is-expanded" : "")
      }
      role="listitem"
      data-step-type={step.type}
      data-expanded={hasBody ? (open ? "1" : "0") : undefined}
    >
      <div className="aiko-act__icon-col" aria-hidden>
        <span className="aiko-act__icon">
          <StepIcon step={step} />
        </span>
        {!isLast ? <span className="aiko-act__rail" /> : null}
      </div>
      <div className="aiko-act__main">
        <div className="aiko-act__label-row">
          {hasBody ? (
            <button
              type="button"
              className="aiko-act__step-btn aiko-act__step-btn--grow"
              aria-expanded={open}
              onClick={() => {
                onUserToggle?.(step.key, !expanded);
              }}
            >
              <StepMainText step={step} tr={tr} />
              <span
                className={"aiko-act__mini-caret" + (open ? " is-open" : "")}
                aria-hidden
              >
                <IconChevronRight size={11} />
              </span>
            </button>
          ) : (
            <StepMainText step={step} tr={tr} />
          )}
          {resultCount != null || (domains && domains.length > 0) ? (
            <span className="aiko-act__meta">
              {resultCount != null ? (
                <span className="aiko-act__meta-count">
                  {tr("chat.searchResults", { n: String(resultCount) })}
                </span>
              ) : null}
              {domains && domains.length > 0 ? (
                <span className="aiko-act__favicons">
                  {domains.slice(0, 3).map((d) => (
                    <FaviconChip key={d} domain={d} />
                  ))}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        {showBody ? (
          <div className="lobe-timeline-tool__body aiko-act__expand-body">
            {failHintShort ? (
              <div className="lobe-timeline-tool__fail-hint" title={failHint}>
                {failHintShort}
              </div>
            ) : null}
            {detailTail &&
            detailTail !== failHint &&
            detailTail !== failHintShort ? (
              <pre className="lobe-timeline-tool__detail">{detailTail}</pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/**
 * Grok activity step list. Short lists map fully; long lists window via
 * VirtualList so multi-turn phases with 20–100+ steps stay light.
 * Live phases pin the scroller to the tail (last step key).
 * When any step is expanded, leave VirtualList so fixed row height is not
 * broken — expanded body uses max-height + internal scroll instead.
 * Expand + userToggled keys live on the parent so remount keeps open state
 * and running→finished still auto-collapses when the user did not toggle.
 */
export function GrokActivitySteps({
  steps,
  tr,
  live = false,
}: {
  steps: GrokActivityStep[];
  tr: ReturnType<typeof createT>;
  /** When true, prefer showing the tail of a virtualized list. */
  live?: boolean;
}) {
  const total = steps.length;
  const [expandState, setExpandState] = useState<ActivityStepExpandState>(() =>
    emptyActivityStepExpandState(),
  );
  // Parent owns open + user-toggled sets — never clear on row unmount.
  const onUserToggle = useCallback((key: string, open: boolean) => {
    setExpandState((prev) => applyActivityStepUserToggle(prev, key, open));
  }, []);
  const onPolicySync = useCallback(
    (
      key: string,
      opts: { hasBody: boolean; running: boolean; autoCollapse: boolean },
    ) => {
      setExpandState((prev) => applyActivityStepExpandPolicy(prev, key, opts));
    },
    [],
  );
  const virtualize = shouldVirtualizeActivityWithExpand(
    total,
    expandState.expandedKeys.size,
  );
  const lastKey = total > 0 ? steps[total - 1]!.key : null;

  const getKey = useCallback((step: GrokActivityStep) => step.key, []);
  const renderItem = useCallback(
    (step: GrokActivityStep, idx: number) => (
      <GrokActivityStepRow
        step={step}
        isLast={idx === total - 1}
        tr={tr}
        expanded={expandState.expandedKeys.has(step.key)}
        onUserToggle={onUserToggle}
        onPolicySync={onPolicySync}
      />
    ),
    [total, tr, expandState.expandedKeys, onUserToggle, onPolicySync],
  );

  if (!total) return null;

  if (!virtualize) {
    return (
      <div className="aiko-act__steps" role="list">
        {steps.map((step, idx) => (
          <GrokActivityStepRow
            key={step.key}
            step={step}
            isLast={idx === total - 1}
            tr={tr}
            expanded={expandState.expandedKeys.has(step.key)}
            onUserToggle={onUserToggle}
            onPolicySync={onPolicySync}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="aiko-act__steps aiko-act__steps--virtual"
      role="list"
      style={{ maxHeight: grokActivityVirtualMaxHeightPx(total) }}
    >
      <VirtualList
        items={steps}
        getKey={getKey}
        renderItem={renderItem}
        rowHeight={GROK_ACTIVITY_STEP_ROW_PX}
        gap={0}
        threshold={0}
        scrollToKey={live ? lastKey : null}
      />
    </div>
  );
}

export const TimelinePhaseBlock = memo(function TimelinePhaseBlock({
  phase,
  locale,
  messageStreaming,
  autoCollapse: autoCollapseProp,
  durationSec: durationSecProp,
  historyTimestamps,
}: {
  phase: TimelinePhase;
  locale: Locale;
  messageStreaming?: boolean;
  autoCollapse?: boolean;
  durationSec?: number | null;
  historyTimestamps?: Array<string | undefined | null>;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [autoCollapse, setAutoCollapse] = useState(
    () => autoCollapseProp ?? loadToolStepsAutoCollapsePref(),
  );

  useEffect(() => {
    if (autoCollapseProp != null) setAutoCollapse(autoCollapseProp);
  }, [autoCollapseProp]);

  useEffect(() => {
    if (autoCollapseProp != null) return;
    const onPref = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setAutoCollapse(
        typeof detail === "boolean"
          ? detail
          : loadToolStepsAutoCollapsePref(),
      );
    };
    window.addEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    return () => {
      window.removeEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    };
  }, [autoCollapseProp]);

  // Live chrome only while the assistant turn is still open. Wire statuses
  // can stick on "running" after tools finish without a final update — those
  // must not keep "Working for …" forever once the turn is done.
  const phaseRunning =
    !!messageStreaming && (phase.live || phase.runningCount > 0);
  const wantOpen = toolStepDefaultOpen(phaseRunning, autoCollapse);
  const [open, setOpen] = useState(wantOpen);
  const userToggled = useRef(false);

  useEffect(() => {
    if (phaseRunning) {
      // Live phases auto-open by default, but a user-collapsed phase stays
      // collapsed while it keeps working (manual choice wins).
      if (!userToggled.current) setOpen(true);
      return;
    }
    if (!userToggled.current) setOpen(wantOpen);
  }, [phaseRunning, wantOpen, phase.id]);

  useEffect(() => {
    const onCollapseAll = () => {
      if (phaseRunning) return;
      userToggled.current = true;
      setOpen(false);
    };
    window.addEventListener(COLLAPSE_ALL_ACTIVITY_EVENT, onCollapseAll);
    return () => {
      window.removeEventListener(COLLAPSE_ALL_ACTIVITY_EVENT, onCollapseAll);
    };
  }, [phaseRunning]);

  const startRef = useRef<number | null>(null);
  const [liveSec, setLiveSec] = useState<number | null>(null);

  const stampPool = useMemo(
    () => [
      ...(historyTimestamps ?? []),
      ...phase.tools.map((t) => t.createdAt),
    ],
    [historyTimestamps, phase.tools],
  );

  const historySec = useMemo(() => {
    if (durationSecProp != null && durationSecProp > 0) return durationSecProp;
    return estimateDurationSecFromTimestamps(stampPool);
  }, [durationSecProp, stampPool]);

  useEffect(() => {
    // Seed / rewind the live timer from the earliest known work timestamp so a
    // remounted or trailing phase (after content split / segment reorder) does
    // not restart at "1s" and freeze a bogus short "Worked for …".
    const earliest = earliestTimestampMs(stampPool);
    if (phaseRunning) {
      if (startRef.current == null) {
        startRef.current = earliest ?? Date.now();
      } else if (earliest != null && earliest < startRef.current) {
        startRef.current = earliest;
      }
      const tick = () => {
        if (startRef.current != null) {
          setLiveSec(
            Math.max(1, Math.floor((Date.now() - startRef.current) / 1000)),
          );
        }
      };
      tick();
      const id = window.setInterval(tick, 1000);
      return () => window.clearInterval(id);
    }
    if (startRef.current != null) {
      setLiveSec(
        Math.max(1, Math.floor((Date.now() - startRef.current) / 1000)),
      );
      startRef.current = null;
    }
  }, [phaseRunning, phase.id, stampPool]);

  const stepsResolved = useMemo(() => {
    const items =
      phase.items?.length
        ? phase.items
        : [
            ...phase.thoughts
              .filter((t) => t.trim())
              .map((text) => ({ kind: "thought" as const, text })),
            ...phase.tools.map((tool) => ({ kind: "tool" as const, tool })),
          ];
    return buildGrokActivitySteps(items, {
      live: phase.live,
      messageStreaming: !!messageStreaming,
    });
  }, [phase.items, phase.thoughts, phase.tools, phase.live, messageStreaming]);

  // Prefer the larger of wall-clock and timestamp span (see resolveWorkDurationSec).
  const durationSec = resolveWorkDurationSec({ liveSec, historySec });
  // Unified with thinking chrome: live always “工作中 + 计时”; done “工作了 + 时长”.
  const phaseChromeLabel = resolveWorkChromeLabel({
    live: phaseRunning,
    durationSec: phaseRunning ? (durationSec ?? liveSec ?? 0) : durationSec,
    workingFor: (duration) => tr("chat.workingFor", { duration }),
    workedFor: (duration) => tr("chat.workedFor", { duration }),
    doneLabel: tr("chat.worked"),
    formatDuration: (sec) => formatWorkDuration(sec, locale),
  });

  if (phaseRunning) {
    return (
      <div
        className="aiko-act is-live"
        data-testid="timeline-phase"
        data-phase-id={phase.id}
        data-live="1"
      >
        <GrokActivitySteps steps={stepsResolved} tr={tr} live />
        <div className="aiko-act__working" role="status" aria-live="polite">
          <span className="aiko-act__working-icon" aria-hidden>
            <IconGridDots size={15} stroke={1.5} />
          </span>
          <span className="aiko-act__working-label">{phaseChromeLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={"aiko-act" + (open ? " is-open" : " is-collapsed")}
      data-testid="timeline-phase"
      data-phase-id={phase.id}
      data-live="0"
      data-expanded={open ? "1" : "0"}
    >
      <button
        type="button"
        className="aiko-act__header"
        aria-expanded={open}
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => !v);
        }}
      >
        <span className="aiko-act__header-icon" aria-hidden>
          <IconGridDots size={15} stroke={1.5} />
        </span>
        <span className="aiko-act__header-text">{phaseChromeLabel}</span>
        <span className="aiko-act__header-caret" aria-hidden>
          {open ? (
            <IconChevronDown size={12} stroke={2} />
          ) : (
            <IconChevronRight size={12} stroke={2} />
          )}
        </span>
      </button>
      {open ? <GrokActivitySteps steps={stepsResolved} tr={tr} /> : null}
    </div>
  );
});
