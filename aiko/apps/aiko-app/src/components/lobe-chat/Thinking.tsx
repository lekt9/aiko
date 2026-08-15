/**
 * Bare thinking row (no tools in this burst) — unified chrome with work phases.
 *
 * Official rhythm:
 * - Streaming: 💡 思考中 / Thinking for {duration}  (live timer, always)
 * - Done collapsed (default): 💡 思考了 / Thought for {duration}  >
 * - Done expanded: same header + muted body
 *
 * Never use gist / first-line body as the chrome label.
 * Tool bursts use TimelinePhaseBlock (“工作了 / Worked for …”) instead.
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconBulb, IconChevronDown, IconChevronRight } from "@/components/icons";
import { cn } from "@/lib/utils";
import { MarkdownChat } from "./MarkdownChat";
import { createT, type Locale } from "@/i18n";
import { COLLAPSE_ALL_ACTIVITY_EVENT } from "@/lib/collapseAllActivity";
import {
  loadThinkingExpandPref,
  thinkingDefaultOpenWhenDone,
  THINKING_PREF_EVENT,
  type ThinkingExpandPref,
} from "@/lib/thinkingPref";
import { formatWorkDuration } from "@/lib/formatWorkDuration";
import { resolveThinkingChromeLabel } from "@/lib/thinkingChromeLabel";

export const Thinking = memo(function Thinking({
  content,
  thinking,
  durationMs,
  startedAt,
  locale = "en",
  expandPref,
  onOpenExternalLink,
}: {
  content?: string | ReactNode;
  thinking?: boolean;
  /** Duration in ms when known (live timer or history). */
  durationMs?: number;
  /**
   * Epoch ms when this thinking episode began (e.g. turn / post-steer clock).
   * Survives remounts so placeholder → real thought does not reset to “1s”.
   */
  startedAt?: number | null;
  locale?: Locale;
  /** Global default for finished blocks (Settings). Per-block toggles are local. */
  expandPref?: ThinkingExpandPref;
  onOpenExternalLink?: (url: string) => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [pref, setPref] = useState<ThinkingExpandPref>(
    () => expandPref ?? loadThinkingExpandPref(),
  );
  // Done → start collapsed (auto-collapse default). Streaming → open.
  const [open, setOpen] = useState(() =>
    thinking ? true : thinkingDefaultOpenWhenDone(pref),
  );
  const startRef = useRef<number | null>(null);
  const [localDuration, setLocalDuration] = useState<number | undefined>(
    durationMs,
  );
  const userToggled = useRef(false);
  const thinkingRef = useRef(!!thinking);
  thinkingRef.current = !!thinking;

  useEffect(() => {
    if (expandPref != null) setPref(expandPref);
  }, [expandPref]);

  useEffect(() => {
    if (expandPref != null) return;
    const apply = (next: ThinkingExpandPref) => {
      setPref(next);
      if (!thinkingRef.current && !userToggled.current) {
        setOpen(thinkingDefaultOpenWhenDone(next));
      }
    };
    const onPref = (e: Event) => {
      const detail = (e as CustomEvent<ThinkingExpandPref>).detail;
      apply(
        detail === "keep-open" || detail === "auto-collapse"
          ? detail
          : loadThinkingExpandPref(),
      );
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "aiko.thinkingExpanded") {
        apply(loadThinkingExpandPref());
      }
    };
    window.addEventListener(THINKING_PREF_EVENT, onPref);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(THINKING_PREF_EVENT, onPref);
      window.removeEventListener("storage", onStorage);
    };
  }, [expandPref]);

  useEffect(() => {
    const onCollapseAll = () => {
      if (thinkingRef.current) return;
      userToggled.current = true;
      setOpen(false);
    };
    window.addEventListener(COLLAPSE_ALL_ACTIVITY_EVENT, onCollapseAll);
    return () => {
      window.removeEventListener(COLLAPSE_ALL_ACTIVITY_EVENT, onCollapseAll);
    };
  }, []);

  // Live wall-clock while streaming; freeze when done.
  // Prefer `startedAt` (turn / post-steer clock) so remounts after steer do not
  // collapse a long wait into “Thought for 1s”.
  const frozenRef = useRef(false);
  useEffect(() => {
    if (thinking) {
      frozenRef.current = false;
      setOpen(true);
      userToggled.current = false;
      const anchor =
        typeof startedAt === "number" && Number.isFinite(startedAt)
          ? startedAt
          : null;
      if (startRef.current == null) {
        startRef.current = anchor ?? Date.now();
      } else if (anchor != null && anchor < startRef.current) {
        // Host pulled the episode start earlier (e.g. steer) — honor it.
        startRef.current = anchor;
      }
      const tick = () => {
        if (startRef.current != null) {
          setLocalDuration(Math.max(0, Date.now() - startRef.current));
        }
      };
      tick();
      const id = window.setInterval(tick, 1000);
      return () => {
        window.clearInterval(id);
      };
    }
    // Episode ended — freeze once (do not keep advancing via startedAt).
    if (!frozenRef.current) {
      if (startRef.current != null) {
        setLocalDuration(Math.max(0, Date.now() - startRef.current));
        startRef.current = null;
      } else if (
        typeof startedAt === "number" &&
        Number.isFinite(startedAt) &&
        durationMs == null
      ) {
        // Remounted already-finished thought with only an anchor.
        setLocalDuration(Math.max(0, Date.now() - startedAt));
      }
      frozenRef.current = true;
    }
    // Finished → collapse unless user prefers keep-open and hasn’t toggled.
    if (!userToggled.current) {
      setOpen(thinkingDefaultOpenWhenDone(pref));
    }
  }, [thinking, pref, startedAt, durationMs]);

  useEffect(() => {
    if (durationMs != null) setLocalDuration(durationMs);
  }, [durationMs]);

  /**
   * Chrome label:
   * - live: “思考中 {duration}” / “Thinking for {duration}”
   * - done: “思考了 {duration}” / “Thought for {duration}”
   * Never gist / body first line.
   */
  const chromeLabel = useMemo(
    () =>
      resolveThinkingChromeLabel({
        live: !!thinking,
        durationMs: localDuration,
        thinkingFor: (duration) => tr("chat.thinkingFor", { duration }),
        thoughtFor: (duration) => tr("chat.thoughtFor", { duration }),
        doneLabel: tr("chat.thoughtDone"),
        formatDuration: (sec) => formatWorkDuration(sec, locale),
      }),
    [thinking, localDuration, tr, locale],
  );

  const hasBody =
    (typeof content === "string" && content.trim().length > 0) ||
    (content != null && typeof content !== "string");

  const toggle = () => {
    if (!hasBody) return;
    // Per-block local state only — toggling one finished thought must NOT flip
    // the global default (that retroactively opened/collapsed every other
    // block via THINKING_PREF_EVENT). The global pref is Settings-only and
    // applies to blocks the user has not toggled.
    setOpen((v) => {
      const next = !v;
      userToggled.current = true;
      return next;
    });
  };

  return (
    <div
      className={
        "aiko-thought" +
        (thinking ? " is-live" : "") +
        (open && hasBody ? " is-open" : " is-collapsed")
      }
      data-testid="thinking-block"
      data-expanded={open && hasBody ? "1" : "0"}
    >
      <button
        type="button"
        className="aiko-thought__header"
        aria-expanded={hasBody ? open : undefined}
        onClick={toggle}
        disabled={!hasBody}
      >
        <span className="aiko-thought__icon" aria-hidden>
          <IconBulb size={15} stroke={1.5} />
        </span>
        <span
          className={cn(
            "aiko-thought__label",
            thinking && "aiko-thought__label--live",
          )}
        >
          {chromeLabel}
        </span>
        {hasBody ? (
          <span className="aiko-thought__caret" aria-hidden>
            {open ? (
              <IconChevronDown size={12} stroke={2} />
            ) : (
              <IconChevronRight size={12} stroke={2} />
            )}
          </span>
        ) : null}
      </button>

      {/* Collapsed: header only. Expanded: muted dig-in body. */}
      {open && hasBody ? (
        <div className="aiko-thought__body">
          {typeof content === "string" ? (
            <MarkdownChat
              locale={locale}
              muted
              pathCards={false}
              onOpenExternalLink={onOpenExternalLink}
            >
              {content}
            </MarkdownChat>
          ) : (
            content
          )}
        </div>
      ) : null}
    </div>
  );
});
