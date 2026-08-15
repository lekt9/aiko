/**
 * Multi-instance browser tab — embedded Tauri Webview only.
 * URL chrome only (no engine status row). Automation uses webview label
 * `resource-browser-<tabId>` via host `side_browser_*` commands.
 *
 * Refresh / Enter:
 * - New URL → navigate in-place (EmbeddedBrowser keeps the webview warm).
 * - Same URL → bump reloadKey so the host runs a true document reload.
 *
 * Loading UX: parent chrome mirrors EmbeddedBrowser load state (spin + status)
 * because the nested browser bar is hidden by side-workbench CSS.
 */

import { useMemo, useRef, useState } from "react";
import { createT, type Locale } from "@/i18n";
import {
  EmbeddedBrowser,
  sideBrowserWebviewLabel,
} from "@/components/EmbeddedBrowser";
import { IconExternalLink, IconRefresh } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import * as api from "@/lib/api";

export type BrowserTabProps = {
  locale: Locale | string;
  tabId: string;
  url?: string;
  title?: string;
  active?: boolean;
  onUrlChange?: (url: string) => void;
};

function normalizeBrowserUrl(raw: string): string {
  const next = raw.trim() || "https://www.google.com";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(next)
    ? next
    : `https://${next}`;
}

/** True while CJK IME candidate UI is open / committing (do not treat as action Enter). */
function isImeKeyEvent(e: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
}): boolean {
  const ne = e.nativeEvent;
  // keyCode 229 = IME processing (common on Chromium / WebView2 / some WK).
  return !!(e.isComposing || ne?.isComposing || ne?.keyCode === 229);
}

export function BrowserTab({
  locale,
  tabId,
  url: initialUrl,
  title,
  active = true,
  onUrlChange,
}: BrowserTabProps) {
  const tr = useMemo(() => createT(locale as Locale), [locale]);
  const [url, setUrl] = useState(
    () => normalizeBrowserUrl((initialUrl || "").trim() || "https://www.google.com"),
  );
  const [draft, setDraft] = useState(url);
  /** Bumped on refresh / Enter-same-URL so EmbeddedBrowser reloads the page. */
  const [reloadKey, setReloadKey] = useState(0);
  const [pageLoading, setPageLoading] = useState(true);
  /**
   * Track composition explicitly: some WebViews clear isComposing before the
   * Enter keydown that confirms a candidate, so keyCode/isComposing alone miss.
   */
  const composingRef = useRef(false);
  const webviewLabel = sideBrowserWebviewLabel(tabId);

  const applyUrl = (nextRaw: string, forceReload: boolean) => {
    const withScheme = normalizeBrowserUrl(nextRaw);
    setDraft(withScheme);
    if (withScheme === url) {
      if (forceReload) {
        setPageLoading(true);
        setReloadKey((k) => k + 1);
      }
      return;
    }
    setPageLoading(true);
    setUrl(withScheme);
    onUrlChange?.(withScheme);
  };

  /** Address-bar commit: navigate, or hard-reload when the URL is unchanged. */
  const go = () => {
    applyUrl(draft, true);
  };

  /** Toolbar refresh always reloads the current page. */
  const reload = () => {
    // Prefer the live draft only if it matches the committed url; otherwise
    // refresh the committed page (same as a browser refresh button).
    setDraft(url);
    setPageLoading(true);
    setReloadKey((k) => k + 1);
  };

  return (
    <div
      className="sw-browser embedded-browser"
      data-testid="side-browser-tab"
      data-tab-id={tabId}
      data-webview-label={webviewLabel}
      data-browser-engine="system"
      data-page-loading={pageLoading ? "1" : "0"}
    >
      <div className="embedded-browser__bar">
        <div className="rp-tree-search sw-browser__url-wrap">
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              // Defer clear: the confirming Enter keydown can race compositionend.
              window.setTimeout(() => {
                composingRef.current = false;
              }, 0);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // IME candidate confirm must not navigate / reload.
              if (composingRef.current || isImeKeyEvent(e)) {
                return;
              }
              e.preventDefault();
              go();
            }}
            aria-label={tr("side.browser.urlAria")}
            data-testid="side-browser-url"
          />
        </div>
        <Tip label={tr("resources.browserReload")}>
          <button
            type="button"
            className="chrome-btn"
            onClick={reload}
            aria-label={
              pageLoading
                ? tr("resources.browserLoadingAria")
                : tr("resources.browserReload")
            }
            aria-busy={pageLoading}
            data-testid="side-browser-reload"
          >
            <span
              className={
                pageLoading ? "embedded-browser__reload-spin" : undefined
              }
            >
              <IconRefresh size={14} />
            </span>
          </button>
        </Tip>
        <Tip label={tr("resources.openExternal")}>
          <button
            type="button"
            className="chrome-btn"
            onClick={() => {
              void api
                .openExternalUrl(url)
                .catch(() =>
                  window.open(url, "_blank", "noopener,noreferrer"),
                );
            }}
            aria-label={tr("resources.openExternal")}
          >
            <IconExternalLink size={14} />
          </button>
        </Tip>
      </div>
      <div className="embedded-browser__host sw-browser__host">
        <EmbeddedBrowser
          url={url}
          title={title}
          locale={locale as Locale}
          active={active}
          instanceId={tabId}
          reloadKey={reloadKey}
          onLoadingChange={setPageLoading}
          className="sw-browser__embed"
        />
      </div>
    </div>
  );
}
