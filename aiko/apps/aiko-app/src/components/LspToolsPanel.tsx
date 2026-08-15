/**
 * Settings → Agent: LSP tools workbench honesty (`[features].lsp_tools`).
 *
 * Independent agent-home: allowlisted bool read/write via agentConfigEdit.
 * Shared mode: read-only. App never invents language-server diagnostics.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import type { AgentConfigEditSnapshot } from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import {
  LSP_TOOLS_CONFIG_EDIT_ANCHOR,
  LSP_TOOLS_CONFIG_PATH,
  LSP_TOOLS_MIN_CLI,
  LSP_TOOLS_SETTINGS_ANCHOR,
  buildLspToolsPatch,
  buildLspToolsStatusChips,
  buildLspToolsSummaryText,
  cliSupportsLspTools,
  hasLspToolsChanges,
  isLspToolsWritable,
  lspToolsBannerMessageKey,
  lspToolsEnabledFromSnapshot,
  lspToolsPresence,
  lspToolsStatusChipLabelKey,
  lspToolsToggleChecked,
  planOpenLspDocs,
  resolveLspToolsBanners,
  resolveLspToolsEmptyState,
  resolveLspToolsStatus,
  toggleLspToolsTri,
  type LspToolsStatus,
  type LspToolsStatusChipId,
} from "@/lib/lspToolsWorkbench";
import { IconCopy, IconRefresh } from "@/components/icons";

function Toggle({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={"ui-check" + (checked ? " is-on" : "")}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!disabled) onChange();
      }}
    >
      <span className="ui-check__box" aria-hidden>
        {checked ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.2L4.8 8.5L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
    </button>
  );
}

function PresenceBadge({
  enabled,
  t,
}: {
  enabled: boolean | null;
  t: (k: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const p = lspToolsPresence(enabled);
  if (p === "unset") {
    return (
      <span className="ext-badge ext-badge--muted">
        {t("settings.lspTools.presence.unset")}
      </span>
    );
  }
  if (p === "set_on") {
    return (
      <span className="ext-badge">{t("settings.lspTools.presence.on")}</span>
    );
  }
  return (
    <span className="ext-badge ext-badge--muted">
      {t("settings.lspTools.presence.off")}
    </span>
  );
}

function chipClass(chip: LspToolsStatusChipId): string {
  if (
    chip === "on" ||
    chip === "no_app_lsp" ||
    chip === "no_diagnostics" ||
    chip === "cli_default_off"
  ) {
    return chip === "on" ? "ext-badge" : "ext-badge ext-badge--muted";
  }
  if (chip === "off" || chip === "unset" || chip === "cli_old" || chip === "host_only") {
    return "ext-badge ext-badge--muted";
  }
  return "ext-badge";
}

export function LspToolsPanel({
  locale,
  onSaved,
  onError,
  cliVersion,
  onOpenConfigSection,
}: {
  locale: Locale;
  onSaved?: () => void;
  onError?: (message: string) => void;
  /** Optional probed CLI version for soft-fail capability badge. */
  cliVersion?: string | null;
  /** Optional jump to agent config.toml section editor. */
  onOpenConfigSection?: () => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const t = useCallback(
    (k: MessageKey, vars?: Record<string, string | number>) => tr(k, vars),
    [tr],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<AgentConfigEditSnapshot | null>(null);
  const [baseline, setBaseline] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [probedCli, setProbedCli] = useState<string | null>(cliVersion ?? null);
  const [copied, setCopied] = useState(false);

  const applySnap = useCallback((s: AgentConfigEditSnapshot) => {
    setSnap(s);
    const en = lspToolsEnabledFromSnapshot(s);
    setBaseline(en);
    setDraft(en);
  }, []);

  const load = useCallback(async () => {
    if (!api.isTauri()) {
      setSnap(null);
      setBaseline(null);
      setDraft(null);
      setError(t("settings.lspTools.needTauri"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.agentConfigEditGet();
      applySnap(res);
      if (cliVersion == null) {
        try {
          const probe = await api.probeCli();
          const ver =
            (probe as { version?: string | null } | null)?.version ?? null;
          setProbedCli(ver);
        } catch {
          setProbedCli(null);
        }
      } else {
        setProbedCli(cliVersion);
      }
    } catch (e) {
      setSnap(null);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [applySnap, cliVersion, onError, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useMemo(
    () => buildLspToolsPatch(draft, baseline),
    [draft, baseline],
  );
  const dirty = hasLspToolsChanges(patch);
  const hostOk = api.isTauri();
  const writable = isLspToolsWritable({
    writable: snap?.writable,
    mode: snap?.mode,
    isTauri: hostOk,
  });
  const disabled = !writable || busy || loading;

  const status: LspToolsStatus = useMemo(
    () =>
      resolveLspToolsStatus({
        enabled: draft,
        writable: snap?.writable ?? false,
        mode: snap?.mode ?? null,
        cliVersion: probedCli,
        minCli: LSP_TOOLS_MIN_CLI,
        isTauri: hostOk,
      }),
    [draft, snap?.writable, snap?.mode, probedCli, hostOk],
  );

  const chips = useMemo(() => buildLspToolsStatusChips(status), [status]);
  const banners = useMemo(
    () => resolveLspToolsBanners(status, { includeSoftRespawn: true }),
    [status],
  );
  const empty = useMemo(() => resolveLspToolsEmptyState(status), [status]);
  const docsPlan = useMemo(() => planOpenLspDocs(), []);
  const cliSupport = cliSupportsLspTools(probedCli ?? cliVersion);

  const onToggle = () => {
    if (!writable) return;
    setDraft((d) => toggleLspToolsTri(d));
  };

  const save = async () => {
    if (!dirty || !writable || !api.isTauri()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.agentConfigEditSet({
        lspToolsEnabled: patch.lspToolsEnabled ?? null,
      });
      applySnap(res);
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError?.(msg);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const reset = () => setDraft(baseline);

  const copySummary = async () => {
    const text = buildLspToolsSummaryText({
      status,
      enabled: draft,
      path: snap?.path ?? null,
      mode: snap?.mode ?? null,
      cliVersion: probedCli,
      minCli: LSP_TOOLS_MIN_CLI,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      onError?.(t("settings.lspTools.copyFailed"));
    }
  };

  const jumpConfig = () => {
    if (onOpenConfigSection) {
      onOpenConfigSection();
      return;
    }
    const el = document.getElementById(LSP_TOOLS_CONFIG_EDIT_ANCHOR);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <div
      className="settings-row settings-row--stack settings-lsp-tools"
      id={LSP_TOOLS_SETTINGS_ANCHOR}
    >
      <div className="settings-row__text">
        <div className="settings-row__label">{t("settings.lspTools")}</div>
        <div className="settings-row__desc">{t("settings.lspToolsDesc")}</div>
        {snap?.path ? (
          <div className="settings-row__hint" title={snap.path}>
            {t("settings.lspTools.path", { path: snap.path })}
          </div>
        ) : null}
      </div>

      {loading && !snap ? (
        <p className="ext-field-hint">{t("settings.lspTools.loading")}</p>
      ) : null}

      {error ? (
        <div className="ext-alert ext-alert--error" role="alert">
          <div className="ext-alert__title">{t("settings.lspTools.error")}</div>
          <p className="ext-alert__body">{error}</p>
        </div>
      ) : null}

      {snap && !writable ? (
        <div className="ext-alert ext-alert--warn" role="status">
          <p className="ext-alert__body" style={{ margin: 0 }}>
            {t("settings.lspTools.sharedWarning")}
          </p>
        </div>
      ) : null}

      {(snap || !hostOk) && (
        <>
          <div className="settings-config-edit__badges">
            {snap ? (
              <span className="ext-badge ext-badge--muted">
                {snap.mode === "shared"
                  ? t("settings.lspTools.mode.shared")
                  : t("settings.lspTools.mode.independent")}
              </span>
            ) : null}
            {snap && !snap.fileExists ? (
              <span className="ext-badge">
                {t("settings.lspTools.missing")}
              </span>
            ) : null}
            {writable ? (
              <span className="ext-badge">
                {t("settings.lspTools.writable")}
              </span>
            ) : (
              <span className="ext-badge">
                {t("settings.lspTools.readOnly")}
              </span>
            )}
            {chips.map((chip) => (
              <span key={chip} className={chipClass(chip)}>
                {t(lspToolsStatusChipLabelKey(chip), {
                  min: LSP_TOOLS_MIN_CLI,
                })}
              </span>
            ))}
            {cliSupport === null &&
              probedCli == null &&
              cliVersion == null && (
                <span className="ext-badge ext-badge--muted">
                  {t("settings.lspTools.cliUnknown")}
                </span>
              )}
          </div>

          <div
            className="ext-alert"
            role="note"
            style={{ marginTop: 8, marginBottom: 4 }}
          >
            <p className="ext-alert__body" style={{ margin: 0 }}>
              {t(empty.titleKey, { min: LSP_TOOLS_MIN_CLI })}
            </p>
            {empty.hintKey ? (
              <p
                className="ext-alert__body"
                style={{ margin: "6px 0 0", opacity: 0.9 }}
              >
                {t(empty.hintKey, { min: LSP_TOOLS_MIN_CLI })}
              </p>
            ) : null}
          </div>

          {banners
            .filter((b) =>
              b === "soft_respawn" ||
              b === "no_app_lsp" ||
              b === "agent_tools_only" ||
              b === "cli_old",
            )
            .map((b) => (
              <div key={b} className="ext-field-hint" style={{ marginTop: 4 }}>
                {t(lspToolsBannerMessageKey(b), { min: LSP_TOOLS_MIN_CLI })}
              </div>
            ))}

          <div className="settings-config-edit__fields">
            <div
              className="settings-row"
              id="settings-anchor-lspTools-enable"
            >
              <div className="settings-row__text">
                <div className="settings-row__label">
                  {t("settings.lspTools.enable")}{" "}
                  <PresenceBadge enabled={draft} t={t} />
                </div>
                <div className="settings-row__desc">
                  {t("settings.lspTools.enableDesc")}
                </div>
                <div
                  className="settings-row__hint"
                  title={LSP_TOOLS_CONFIG_PATH}
                >
                  {LSP_TOOLS_CONFIG_PATH}
                </div>
                {lspToolsPresence(draft) === "unset" ? (
                  <div className="settings-row__hint">
                    {t("settings.lspTools.unsetDefaultHint")}
                  </div>
                ) : null}
              </div>
              <Toggle
                checked={lspToolsToggleChecked(draft)}
                disabled={disabled || !hostOk}
                onChange={onToggle}
                ariaLabel={t("settings.lspTools.enable")}
              />
            </div>
          </div>

          <p className="ext-field-hint" style={{ marginTop: 8 }}>
            {docsPlan.honestyNote}
          </p>

          <div
            className="settings-row__actions"
          >
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              <IconRefresh size={14} />
              <span>{t("settings.lspTools.refresh")}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!dirty || busy || loading}
              onClick={reset}
            >
              {t("settings.lspTools.reset")}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!dirty || !writable || busy || loading}
              onClick={() => void save()}
            >
              {busy
                ? t("settings.lspTools.saving")
                : t("settings.lspTools.save")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={jumpConfig}
            >
              {t("settings.lspTools.openConfigSection")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void copySummary()}
            >
              <IconCopy size={14} />
              <span>
                {copied
                  ? t("settings.lspTools.copied")
                  : t("settings.lspTools.copySummary")}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
