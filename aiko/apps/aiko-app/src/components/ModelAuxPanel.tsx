/**
 * Settings → Account → Model layers.
 * Maps Hermes-style auxiliary routing onto Aiko `[models]` slots.
 * Never mutates main route / `[models].default` — only the four side-task keys.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import { Select } from "@/components/Select";
import { GlassModal } from "@/components/GlassModal";

export interface ModelAuxPanelProps {
  locale: Locale;
  onToast?: (msg: string, ms?: number) => void;
  /** After aux write + agent recycle (optional parent refresh). */
  onChanged?: () => void;
  /** Deep-link to Custom providers (official key / Amux). */
  onOpenProviders?: () => void;
}

function healthMessageKey(
  code: string | undefined,
): MessageKey | null {
  switch (code) {
    case "official_aux_incomplete":
      return "modelAux.health.officialIncomplete";
    case "text_only_no_vision":
      return "modelAux.health.textOnlyNoVision";
    default:
      return null;
  }
}

type SlotKey =
  | "imageDescription"
  | "webSearch"
  | "sessionSummary"
  | "promptSuggestion";

const SLOT_META: {
  key: SlotKey;
  labelKey: MessageKey;
  descKey: MessageKey;
  anchorId: string;
}[] = [
  {
    key: "imageDescription",
    labelKey: "modelAux.slot.imageDescription",
    descKey: "modelAux.slot.imageDescriptionDesc",
    anchorId: "settings-anchor-model-aux-image",
  },
  {
    key: "webSearch",
    labelKey: "modelAux.slot.webSearch",
    descKey: "modelAux.slot.webSearchDesc",
    anchorId: "settings-anchor-model-aux-search",
  },
  {
    key: "sessionSummary",
    labelKey: "modelAux.slot.sessionSummary",
    descKey: "modelAux.slot.sessionSummaryDesc",
    anchorId: "settings-anchor-model-aux-summary",
  },
  {
    key: "promptSuggestion",
    labelKey: "modelAux.slot.promptSuggestion",
    descKey: "modelAux.slot.promptSuggestionDesc",
    anchorId: "settings-anchor-model-aux-prompt",
  },
];

function slotToApiValue(v: string): string {
  const t = v.trim();
  if (!t || t === "auto") return "auto";
  return t;
}

function displaySlot(raw: string): string {
  const t = raw.trim();
  return t || "auto";
}

export function ModelAuxPanel({
  locale,
  onToast,
  onChanged,
  onOpenProviders,
}: ModelAuxPanelProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [state, setState] = useState<api.ModelsAuxState | null>(null);
  const [official, setOfficial] = useState<api.OfficialAuxStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmSaveGrok, setConfirmSaveGrok] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, o] = await Promise.all([
        api.modelsAuxGet(),
        api.officialAuxStatus().catch(() => null),
      ]);
      setState(s);
      setOfficial(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const options = useMemo(() => {
    const list = state?.options ?? [];
    const mapped = list.map((o) => ({
      value: o.id,
      label:
        o.id === "auto"
          ? tr("modelAux.option.auto")
          : o.label || o.id,
    }));
    // Keep current slot values selectable even if provider was removed.
    const slots = state?.slots;
    const extras = [
      slots?.imageDescription,
      slots?.webSearch,
      slots?.sessionSummary,
      slots?.promptSuggestion,
    ]
      .map((v) => (v ?? "").trim())
      .filter((v) => v && v !== "auto" && !mapped.some((o) => o.value === v));
    for (const id of new Set(extras)) {
      mapped.push({ value: id, label: id });
    }
    return mapped;
  }, [state?.options, state?.slots, tr]);

  const applySlot = useCallback(
    async (key: SlotKey, value: string) => {
      if (!state?.writable) {
        onToast?.(tr("modelAux.sharedReadOnly"), 3200);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const body: api.ModelsAuxSetInput = {
          [key]: slotToApiValue(value),
        };
        const next = await api.modelsAuxSet(body);
        setState(next);
        onChanged?.();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        onToast?.(msg, 4000);
      } finally {
        setBusy(false);
      }
    },
    [state?.writable, onToast, tr, onChanged],
  );

  const runSaveGrok = useCallback(async () => {
    setConfirmSaveGrok(false);
    if (!state?.writable) {
      onToast?.(tr("modelAux.sharedReadOnly"), 3200);
      return;
    }
    if (!state.saveGrokTarget) {
      onToast?.(tr("modelAux.saveGrokNoTarget"), 4200);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.modelsAuxApplySaveGrok();
      setState(next);
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onToast?.(msg, 4500);
    } finally {
      setBusy(false);
    }
  }, [state, onToast, tr, onChanged]);

  const runReset = useCallback(async () => {
    setConfirmReset(false);
    if (!state?.writable) {
      onToast?.(tr("modelAux.sharedReadOnly"), 3200);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.modelsAuxResetDefaults();
      setState(next);
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onToast?.(msg, 4000);
    } finally {
      setBusy(false);
    }
  }, [state?.writable, onToast, tr, onChanged]);

  if (loading && !state) {
    return (
      <div className="settings-card model-aux-panel" id="settings-anchor-model-aux">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">{tr("modelAux.loading")}</div>
          </div>
        </div>
      </div>
    );
  }

  const slots = state?.slots;
  const writable = !!state?.writable;

  return (
    <div className="settings-card model-aux-panel" id="settings-anchor-model-aux">
      <div className="settings-row settings-row--stack">
        <div className="settings-row__text">
          <div className="settings-row__label">{tr("modelAux.title")}</div>
          <div className="settings-row__desc">{tr("modelAux.desc")}</div>
        </div>
        {!writable && (
          <div className="settings-row__hint is-danger" role="status">
            {tr("modelAux.sharedReadOnly")}
          </div>
        )}
        <div className="settings-row settings-row--stack">
          <div className="settings-row__label">
            {tr("modelAux.officialAuxTitle")}
          </div>
          <div
            className={
              "settings-row__hint" +
              (official?.available ? "" : " is-danger")
            }
            role="status"
          >
            {official?.available
              ? tr("modelAux.officialAuxReady", {
                  reason: official.reason || "",
                })
              : tr("modelAux.officialAuxMissing")}
          </div>
        </div>
        {(() => {
          const hk = healthMessageKey(state?.healthCode);
          return hk ? (
            <div className="settings-row__hint is-danger" role="status">
              {tr(hk)}
            </div>
          ) : null;
        })()}
        {state?.healthCode ? (
          <div className="model-aux-panel__next">
            <div className="settings-row__label">{tr("modelAux.nextStepsTitle")}</div>
            <ol className="model-aux-panel__next-list">
              <li>{tr("modelAux.nextStep1")}</li>
              <li>{tr("modelAux.nextStep2")}</li>
              <li>{tr("modelAux.nextStep3")}</li>
            </ol>
          </div>
        ) : null}
        <div className="model-aux-panel__meta settings-row__hint">
          <span>
            {tr("modelAux.mainDefault")}:{" "}
            <code>{state?.mainDefault || "—"}</code>
          </span>
          <span>
            {tr("modelAux.activeSource")}:{" "}
            <code>{state?.activeSource || "—"}</code>
          </span>
        </div>
        <div className="model-aux-panel__actions">
          <button
            type="button"
            className="btn btn--solid"
            disabled={!writable || busy || !state?.saveGrokTarget}
            title={
              state?.saveGrokTarget
                ? tr("modelAux.saveGrokHint", {
                    model: state.saveGrokLabel || state.saveGrokTarget,
                  })
                : tr("modelAux.saveGrokNoTarget")
            }
            onClick={() => setConfirmSaveGrok(true)}
          >
            {tr("modelAux.saveGrok")}
          </button>
          <button
            type="button"
            className={
              "btn" +
              (state?.healthCode === "official_aux_incomplete"
                ? " btn--solid"
                : " btn--ghost")
            }
            disabled={!writable || busy}
            id="settings-anchor-model-aux-reset"
            onClick={() => setConfirmReset(true)}
          >
            {tr("modelAux.resetDefaults")}
          </button>
          {onOpenProviders ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => onOpenProviders()}
            >
              {tr("modelAux.goProviders")}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {tr("modelAux.refresh")}
          </button>
        </div>
        {!state?.saveGrokTarget && writable ? (
          <div className="settings-row__hint">{tr("modelAux.saveGrokNoTarget")}</div>
        ) : null}
        {error ? (
          <div className="settings-row__hint is-danger" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      {SLOT_META.map((meta) => {
        const raw =
          meta.key === "imageDescription"
            ? slots?.imageDescription
            : meta.key === "webSearch"
              ? slots?.webSearch
              : meta.key === "sessionSummary"
                ? slots?.sessionSummary
                : slots?.promptSuggestion;
        const value = displaySlot(raw ?? "");
        return (
          <div
            key={meta.key}
            className="settings-row"
            id={meta.anchorId}
          >
            <div className="settings-row__text">
              <div className="settings-row__label">{tr(meta.labelKey)}</div>
              <div className="settings-row__desc">{tr(meta.descKey)}</div>
            </div>
            <Select
              value={value}
              options={options}
              disabled={!writable || busy}
              aria-label={tr(meta.labelKey)}
              onChange={(v) => void applySlot(meta.key, v)}
            />
          </div>
        );
      })}

      <div className="settings-row settings-row--stack">
        <div className="settings-row__hint">{tr("modelAux.footnote")}</div>
        {state?.configPath ? (
          <div className="settings-row__hint">
            <code>{state.configPath}</code>
          </div>
        ) : null}
      </div>

      <GlassModal
        open={confirmSaveGrok}
        onClose={() => setConfirmSaveGrok(false)}
        title={tr("modelAux.saveGrokConfirmTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setConfirmSaveGrok(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => void runSaveGrok()}
            >
              {tr("modelAux.saveGrok")}
            </button>
          </>
        }
      >
        <p>
          {tr("modelAux.saveGrokConfirmBody", {
            model: state?.saveGrokLabel || state?.saveGrokTarget || "",
          })}
        </p>
      </GlassModal>

      <GlassModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title={tr("modelAux.resetConfirmTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setConfirmReset(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => void runReset()}
            >
              {tr("modelAux.resetDefaults")}
            </button>
          </>
        }
      >
        <p>{tr("modelAux.resetConfirmBody")}</p>
      </GlassModal>
    </div>
  );
}
