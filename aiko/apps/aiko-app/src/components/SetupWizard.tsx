/**
 * Full-screen first-run gate: verify embedded Aiko CLI → account (skippable) → enter home.
 * No page scrollbars; content is centered and compact.
 *
 * Honesty (SETUP-GATE-PRO): CLI is hard-required; account is soft/skippable.
 * Errors are classified via pure `setupGatePro` helpers — never invent success.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AikoLogo } from "@/components/AikoLogo";
import { Select } from "@/components/Select";
import { Spinner } from "@/components/ui/spinner";
import { titlebarMaximizeHandlers } from "@/components/WindowControls";
import * as api from "@/lib/api";
import type { createT } from "@/i18n";
import type { MessageKey } from "@/i18n";
import {
  buildAuthDeferredFlags,
  buildReadyChecklist,
  canAdvancePastRuntime,
  canEnterHome,
  resolveInitialWizardStep,
  resolveSetupGateError,
  type SetupGateErrorView,
  type SetupWizardStep,
} from "@/lib/setupGatePro";

type Tr = ReturnType<typeof createT>;

export type SetupCliInfo = {
  found: boolean;
  path: string | null;
  version: string | null;
  source: string;
  cliAuthPresent: boolean;
};

type Step = SetupWizardStep;
type AccountPanel = "menu" | "key" | "relay";

type Props = {
  tr: Tr;
  platform: "mac" | "win" | "linux" | "other";
  useCustomWindowChrome: boolean;
  initialCli: SetupCliInfo;
  onComplete: (cli: SetupCliInfo) => void;
  onAccountLoginOauth: () => Promise<boolean>;
};

export function SetupWizard({
  tr,
  platform,
  useCustomWindowChrome,
  initialCli,
  onComplete,
  onAccountLoginOauth,
}: Props) {
  const [step, setStep] = useState<Step>(() =>
    resolveInitialWizardStep(initialCli.found),
  );
  const [cli, setCli] = useState<SetupCliInfo>(initialCli);
  const [probing, setProbing] = useState(false);
  const [errorView, setErrorView] = useState<SetupGateErrorView | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [accountPanel, setAccountPanel] = useState<AccountPanel>("menu");
  const [accountBusy, setAccountBusy] = useState(false);
  const [authOk, setAuthOk] = useState(
    () => initialCli.cliAuthPresent,
  );
  const [authDeferred, setAuthDeferred] = useState(false);
  const [officialKey, setOfficialKey] = useState("");
  const [relayBase, setRelayBase] = useState("");
  const [relayKey, setRelayKey] = useState("");
  /** Default: OpenAI Responses — preferred for modern gateways. */
  const [relayBackend, setRelayBackend] = useState("responses");

  const reportError = useCallback((err: unknown) => {
    const view = resolveSetupGateError(err);
    if (view.silent) {
      setErrorView(null);
      return view;
    }
    setErrorView(view);
    return view;
  }, []);

  const clearError = useCallback(() => {
    setErrorView(null);
  }, []);

  const protocolOptions = useMemo(
    () => [
      { value: "responses", label: tr("prov.protocol.responses") },
      {
        value: "chat_completions",
        label: tr("prov.protocol.chatCompletions"),
      },
      { value: "messages", label: tr("prov.protocol.messages") },
    ],
    [tr],
  );

  const recheck = useCallback(async () => {
    setProbing(true);
    clearError();
    try {
      const r = await api.probeCli();
      const next: SetupCliInfo = {
        found: r.found,
        path: r.path,
        version: r.version,
        source: r.source || "",
        cliAuthPresent: !!r.cliAuthPresent,
      };
      setCli(next);
      if (next.cliAuthPresent) setAuthOk(true);
      if (next.found) {
        setStatusMsg(null);
      }
      return next;
    } catch (e) {
      reportError(e);
      return null;
    } finally {
      setProbing(false);
    }
  }, [clearError, reportError]);

  // Soft auto-detect once when opening runtime step without CLI
  useEffect(() => {
    if (step !== "runtime" || cli.found) return;
    void recheck();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  const finishWizard = useCallback(
    async (opts: { authDeferred: boolean; authOk: boolean }) => {
      if (!canEnterHome(cli.found)) return;
      const flags = buildAuthDeferredFlags({
        authDeferred: opts.authDeferred,
        authOk: opts.authOk,
      });
      try {
        const s = await api.settingsGet();
        await api.settingsSet({
          ...s,
          setupWizardCompleted: true,
          authSetupDeferred: flags.authSetupDeferred,
          onboardingDone: true,
          setupSkipped: flags.setupSkipped,
        });
      } catch {
        /* still enter if probe ok */
      }
      onComplete(cli);
    },
    [cli, onComplete],
  );

  const goAccountContinue = useCallback(() => {
    if (!canAdvancePastRuntime(cli.found)) return;
    setStep("ready");
  }, [cli.found]);

  const skipAccount = useCallback(() => {
    // Soft gate: account is optional — never blocks home after CLI is ready.
    setAuthDeferred(true);
    setStep("ready");
  }, []);

  const saveOfficialKey = useCallback(async () => {
    const key = officialKey.trim();
    if (!key) return;
    setAccountBusy(true);
    clearError();
    try {
      await api.secretsSet({ officialApiKey: key });
      setAuthOk(true);
      setStatusMsg(tr("setup.account.ok"));
      setAccountPanel("menu");
      setStep("ready");
    } catch (e) {
      reportError(e);
    } finally {
      setAccountBusy(false);
    }
  }, [clearError, officialKey, reportError, tr]);

  const saveRelay = useCallback(async () => {
    const base = relayBase.trim();
    const key = relayKey.trim();
    if (!base || !key) return;
    setAccountBusy(true);
    clearError();
    try {
      // Write agent-home config with chosen message format (default Responses).
      // Host recycles warm agents on setAsDefault so the first workbench send
      // spawns with the relay (no full app restart — issue #376).
      await api.providersUpsert({
        id: "relay",
        model: "default",
        baseUrl: base,
        name: "Custom relay",
        apiKey: key,
        apiBackend: relayBackend || "responses",
        setAsDefault: true,
      });
      try {
        await api.secretsSet({ relayBaseUrl: base, relayApiKey: key });
      } catch {
        /* soft-fail: config.toml already holds the key */
      }
      try {
        const ping = await api.providersPing({ baseUrl: base, apiKey: key });
        if (ping && (ping as { ok?: boolean }).ok === false) {
          setStatusMsg(
            String((ping as { message?: string }).message || "ping failed"),
          );
        } else {
          setStatusMsg(tr("setup.account.ok"));
        }
      } catch {
        // Soft-fail ping — still enter workbench; user can fix URL in Settings.
        setStatusMsg(tr("setup.account.ok"));
      }
      setAuthOk(true);
      setAccountPanel("menu");
      setStep("ready");
    } catch (e) {
      reportError(e);
    } finally {
      setAccountBusy(false);
    }
  }, [clearError, relayBase, relayKey, relayBackend, reportError, tr]);

  const runOauth = useCallback(async () => {
    setAccountBusy(true);
    clearError();
    try {
      const ok = await onAccountLoginOauth();
      if (ok) {
        setAuthOk(true);
        setStatusMsg(tr("setup.account.ok"));
        setStep("ready");
      }
      const next = await recheck();
      if (next?.cliAuthPresent) {
        setAuthOk(true);
        setStep("ready");
      }
    } catch (e) {
      reportError(e);
    } finally {
      setAccountBusy(false);
    }
  }, [clearError, cli.path, onAccountLoginOauth, recheck, reportError, tr]);

  const importCli = useCallback(async () => {
    setAccountBusy(true);
    clearError();
    try {
      const r = await api.importAikoCli();
      if ((r as { ok?: boolean }).ok) {
        setAuthOk(true);
        setStatusMsg(tr("setup.account.ok"));
        setStep("ready");
      } else {
        setStatusMsg(JSON.stringify((r as { messages?: string[] }).messages || r));
      }
    } catch (e) {
      reportError(e);
    } finally {
      setAccountBusy(false);
    }
  }, [clearError, reportError, tr]);

  const importGo = useCallback(async () => {
    setAccountBusy(true);
    clearError();
    try {
      await api.importGrokGo();
      setAuthOk(true);
      setStatusMsg(tr("setup.account.ok"));
      setStep("ready");
    } catch (e) {
      reportError(e);
    } finally {
      setAccountBusy(false);
    }
  }, [clearError, reportError, tr]);

  /** Abort the running login (OAuth/device) and unlock the UI immediately.
   *  The backend kills the `aiko login` child; the pending handler's `finally`
   *  also clears accountBusy, but we reset here so the UI is instant. */
  const cancelAccountLogin = useCallback(async () => {
    try {
      await api.accountLoginCancel();
    } catch {
      /* host may be unavailable; still unlock UI below */
    }
    setAccountBusy(false);
  }, []);

  const readyChecklist = useMemo(
    () =>
      buildReadyChecklist({
        cliFound: cli.found,
        cliVersion: cli.version,
        authOk,
        authDeferred,
      }),
    [cli.found, cli.version, authOk, authDeferred],
  );

  const stepIndex = step === "runtime" ? 0 : step === "account" ? 1 : 2;

  return (
    <div
      className={
        "setup-gate" +
        (useCustomWindowChrome ? " setup-gate--custom-chrome" : "")
      }
      data-platform={platform}
      data-testid="setup-wizard"
    >
      <div
        className="setup-gate__drag"
        data-tauri-drag-region
        {...titlebarMaximizeHandlers()}
      />

      <div className="setup-gate__center">
        <div className="setup-hero">
          <div
            className={
              "setup-logo" +
              (probing ? " setup-logo--spin" : " setup-logo--pulse")
            }
          >
            <AikoLogo size={44} />
          </div>
          <h1 className="setup-title">{tr("setup.title")}</h1>
          <p className="setup-subtitle">{tr("setup.subtitle")}</p>
        </div>

        <ol className="setup-steps" aria-label="Setup steps">
          {(
            [
              ["runtime", "setup.step.runtime"],
              ["account", "setup.step.account"],
              ["ready", "setup.step.ready"],
            ] as const
          ).map(([id, key], i) => (
            <li
              key={id}
              className={
                "setup-steps__item" +
                (i === stepIndex ? " is-active" : "") +
                (i < stepIndex ? " is-done" : "")
              }
            >
              <span className="setup-steps__dot" />
              <span className="setup-steps__label">{tr(key)}</span>
            </li>
          ))}
        </ol>

        <div className="setup-card">
          {step === "runtime" && (
            <>
              <div className="setup-card__head">
                <h2>
                  {cli.found
                    ? tr("setup.cli.found")
                    : tr("setup.cli.required")}
                </h2>
                <p>
                  {cli.found
                    ? tr("setup.cli.foundHint", {
                        version: cli.version || "—",
                      })
                    : tr("setup.cli.requiredHint")}
                </p>
                {cli.path && (
                  <p className="setup-mono">
                    {tr("setup.cli.path", { path: cli.path })}
                  </p>
                )}
              </div>

              {!cli.found && (
                <p className="setup-hint">{tr("setup.cli.embeddedMissing")}</p>
              )}

              <div className="setup-actions">
                {cli.found ? (
                  <button
                    type="button"
                    className="btn btn--primary setup-btn-primary"
                    onClick={() => setStep("account")}
                  >
                    {tr("setup.continue")}
                  </button>
                ) : null}
                <div className="setup-actions__row">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={probing}
                    onClick={() => void recheck()}
                  >
                    {probing ? <Spinner className="size-3.5" /> : null}
                    {tr("setup.recheck")}
                  </button>
                </div>
              </div>
            </>
          )}

          {step === "account" && (
            <>
              <div className="setup-card__head">
                <h2>{tr("setup.account.title")}</h2>
                <p>{tr("setup.account.hint")}</p>
              </div>

              {accountPanel === "menu" && (
                <div className="setup-entry-grid">
                  {cli.cliAuthPresent && (
                    <button
                      type="button"
                      className="setup-entry setup-entry--recommended"
                      disabled={accountBusy}
                      onClick={() => void importCli()}
                    >
                      <strong>{tr("setup.reuseCliAuthTitle")}</strong>
                      <span>{tr("setup.reuseCliAuthDesc")}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="setup-entry"
                    disabled={accountBusy}
                    onClick={() => void runOauth()}
                  >
                    <strong>{tr("setup.account.oauth")}</strong>
                    <span>{tr("setup.account.oauthHint")}</span>
                  </button>
                  <button
                    type="button"
                    className="setup-entry"
                    disabled={accountBusy}
                    onClick={() => setAccountPanel("key")}
                  >
                    <strong>{tr("setup.account.key")}</strong>
                    <span>{tr("setup.account.keyHint")}</span>
                  </button>
                  <button
                    type="button"
                    className="setup-entry"
                    disabled={accountBusy}
                    onClick={() => setAccountPanel("relay")}
                  >
                    <strong>{tr("setup.account.relay")}</strong>
                    <span>{tr("setup.account.relayHint")}</span>
                  </button>
                  <button
                    type="button"
                    className="setup-entry"
                    disabled={accountBusy}
                    onClick={() => void importGo()}
                  >
                    <strong>{tr("setup.account.importGo")}</strong>
                    <span>{tr("onboarding.importGoHint")}</span>
                  </button>
                </div>
              )}

              {accountPanel === "key" && (
                <div className="setup-form">
                  <input
                    className="setup-input"
                    type="password"
                    autoComplete="off"
                    placeholder={tr("setup.account.keyPh")}
                    value={officialKey}
                    onChange={(e) => setOfficialKey(e.target.value)}
                  />
                  <div className="setup-actions__row">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setAccountPanel("menu")}
                    >
                      {tr("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={accountBusy || !officialKey.trim()}
                      onClick={() => void saveOfficialKey()}
                    >
                      {tr("setup.account.saveKey")}
                    </button>
                  </div>
                </div>
              )}

              {accountPanel === "relay" && (
                <div className="setup-form">
                  <input
                    className="setup-input"
                    type="url"
                    autoComplete="off"
                    placeholder={tr("setup.account.basePh")}
                    value={relayBase}
                    onChange={(e) => setRelayBase(e.target.value)}
                  />
                  <input
                    className="setup-input"
                    type="password"
                    autoComplete="off"
                    placeholder={tr("setup.account.relayKeyPh")}
                    value={relayKey}
                    onChange={(e) => setRelayKey(e.target.value)}
                  />
                  <label className="setup-field">
                    <span className="setup-field__label">
                      {tr("setup.account.protocol")}
                    </span>
                    <Select
                      value={relayBackend}
                      onChange={setRelayBackend}
                      options={protocolOptions}
                      aria-label={tr("setup.account.protocol")}
                    />
                  </label>
                  <div className="setup-actions__row">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setAccountPanel("menu")}
                    >
                      {tr("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={
                        accountBusy || !relayBase.trim() || !relayKey.trim()
                      }
                      onClick={() => void saveRelay()}
                    >
                      {tr("setup.account.saveRelay")}
                    </button>
                  </div>
                </div>
              )}

              {accountBusy && (
                <div className="setup-busy">
                  <Spinner className="size-4" />
                  {tr("setup.account.busy")}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void cancelAccountLogin()}
                  >
                    {tr("setup.account.cancelBusy")}
                  </button>
                </div>
              )}

              <div className="setup-actions setup-actions--footer">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={accountBusy}
                  onClick={skipAccount}
                >
                  {tr("setup.account.skip")}
                </button>
                {(authOk || accountPanel === "menu") && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={accountBusy}
                    onClick={goAccountContinue}
                  >
                    {tr("setup.continue")}
                  </button>
                )}
              </div>
            </>
          )}

          {step === "ready" && (
            <>
              <div className="setup-card__head">
                <h2>{tr("setup.ready.title")}</h2>
                {readyChecklist.authDeferred && (
                  <p className="setup-ready-soft">
                    {tr("setup.ready.authSoftNote")}
                  </p>
                )}
              </div>
              <ul className="setup-checklist">
                {readyChecklist.rows.map((row) => (
                  <li
                    key={row.id}
                    className={
                      row.ok ? "is-ok" : row.soft ? "is-soft" : "is-fail"
                    }
                    data-setup-check={row.id}
                  >
                    <span className="setup-check" />
                    {tr(row.labelKey as MessageKey)}
                    {row.meta ? (
                      <span className="setup-check-meta">{row.meta}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="setup-actions">
                <button
                  type="button"
                  className="btn btn--primary setup-btn-primary"
                  disabled={!readyChecklist.canEnter}
                  onClick={() =>
                    void finishWizard({
                      authDeferred: authDeferred || !authOk,
                      authOk,
                    })
                  }
                >
                  {tr("setup.ready.enter")}
                </button>
              </div>
            </>
          )}

          {errorView && !errorView.silent && (
            <div
              className={
                "setup-error" +
                (errorView.tone === "warn" ? " setup-error--warn" : "")
              }
              role="alert"
              data-setup-error-kind={errorView.kind}
            >
              <strong>{tr(errorView.titleKey as MessageKey)}</strong>
              {errorView.detail ? <span>{errorView.detail}</span> : null}
              {errorView.hintKey ? (
                <span className="setup-error__hint">
                  {tr(errorView.hintKey as MessageKey)}
                </span>
              ) : null}
            </div>
          )}
          {statusMsg && !(errorView && !errorView.silent) && (
            <div className="setup-status" role="status">
              {statusMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
