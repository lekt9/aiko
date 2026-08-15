/**
 * Collapsed strip for historical assistant turns that were split into
 * multiple intermediate status fragments (Aiko CLI writes one row per
 * fragment; reconcile may add them individually).
 *
 * Mature-product history folding: the bubble body shows only the final
 * deliverable; earlier fragments ("正在构建…", "检查图片…") are folded here.
 * Per-message local state — expanding one strip never affects others.
 */

import { memo, useMemo, useState } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import { IconChevronDown, IconChevronRight, IconSparkles } from "@/components/icons";
import { MarkdownChat } from "./MarkdownChat";

export const LeadFragmentsStrip = memo(function LeadFragmentsStrip({
  fragments,
  locale,
  onOpenExternalLink,
}: {
  fragments: string[];
  locale: Locale;
  onOpenExternalLink?: (url: string) => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  // Local-only toggle (matches per-block Thinking behavior — a user opening
  // one turn's fragments must not open every other turn).
  const [open, setOpen] = useState(false);
  const joined = useMemo(
    () => fragments.filter((f) => f.trim()).join("\n\n"),
    [fragments],
  );
  if (!joined.trim()) return null;

  return (
    <div
      className={"aiko-fragments" + (open ? " is-open" : " is-collapsed")}
      data-testid="lead-fragments"
      data-expanded={open ? "1" : "0"}
    >
      <button
        type="button"
        className="aiko-fragments__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="aiko-fragments__icon" aria-hidden>
          <IconSparkles size={14} stroke={1.5} />
        </span>
        <span className="aiko-fragments__label">
          {tr("chat.leadFragments", { n: String(fragments.length) })}
        </span>
        <span className="aiko-fragments__caret" aria-hidden>
          {open ? (
            <IconChevronDown size={13} stroke={1.75} />
          ) : (
            <IconChevronRight size={13} stroke={1.75} />
          )}
        </span>
      </button>
      {open ? (
        <div className="aiko-fragments__body">
          <MarkdownChat
            locale={locale}
            muted
            pathCards={false}
            onOpenExternalLink={onOpenExternalLink}
          >
            {joined}
          </MarkdownChat>
        </div>
      ) : null}
    </div>
  );
});
