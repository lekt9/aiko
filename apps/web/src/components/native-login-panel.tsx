import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import { MiniAppScreen } from "./mini-app-screen";
import {
  MiniAppAuthenticationError,
  type PasswordManager,
} from "../lib/connectors";

import { NativeLoginChallengeError, nativeLoginPageError, nativeOtpSubmission, type NativeLoginPanelView as View } from "../lib/native-login-input";

export function NativeLoginPanel({
  connectionId,
  request,
  onClose,
  domain,
  username,
}: {
  connectionId: string;
  request: <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;
  onClose: () => void;
  domain?: string;
  /** Staged from a password manager import; prefills the sign-in. */
  username?: string;
}) {
  const [view, setView] = useState<View>();
  const pageError = nativeLoginPageError(view);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<
    { stage: string; message: string; at: number }[]
  >([]);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!busy) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await requestRef.current<{
          progress: { stage: string; message: string; at: number }[];
        }>(
          `/native/progress?connectionId=${encodeURIComponent(connectionId)}`,
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted)
          setProgress((previous) => {
            const entries = new Map(
              previous.map((entry) => [`${entry.at}:${entry.stage}`, entry]),
            );
            for (const entry of result.progress)
              entries.set(`${entry.at}:${entry.stage}`, entry);
            return [...entries.values()].sort((a, b) => a.at - b.at).slice(-24);
          });
      } catch (failure) {
        if (
          !abort.signal.aborted &&
          failure instanceof MiniAppAuthenticationError
        ) {
          setError(failure.message);
          abort.abort();
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [busy, connectionId]);
  const [managers, setManagers] = useState<PasswordManager[]>();
  const [managerUsername, setManagerUsername] = useState(username ?? "");
  const [managerError, setManagerError] = useState("");
  const managerOpen = useRef(false);
  const cancelling = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const observer = useRef<AbortController | undefined>(undefined);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [observeUntil] = useState(() => Date.now() + 30 * 60_000);
  const [observing, setObserving] = useState(false);
  // Task-bound logins are also observed by the native durable waiter. The open
  // panel uses the existing verification action for standalone sign-ins too.
  // Never poll credential actions or replace a code the owner is still typing.
  useEffect(() => {
    if (busy || view?.requiresOrigin ||
        (!submitted && view?.status !== "pending") ||
        ["connected", "disconnected"].includes(view?.status ?? "")) return;
    const abort = new AbortController();
    observer.current = abort;
    const deadline = Math.min(observeUntil, view?.expiresAt ?? Infinity, view?.challenge?.expiresAt ?? Infinity);
    let timer: ReturnType<typeof setTimeout>;
    let checks = 0;
    const poll = async () => {
      if (abort.signal.aborted) return;
      if (Date.now() >= deadline) { setObserving(false); return; }
      try {
        if (!controller.current && !cancelling.current) {
          const next = await requestRef.current<View>("/native", { connectionId, action: "finish" }, abort.signal);
          if (abort.signal.aborted || controller.current || cancelling.current) return;
          if (next.status === "connected") {
            abort.abort();
            closeRef.current();
            return;
          }
          if (next.status === "disconnected") { abort.abort(); setObserving(false); return; }
        }
      } catch (failure) {
        if (!abort.signal.aborted && failure instanceof MiniAppAuthenticationError) {
          setError(failure.message);
          setObserving(false);
          abort.abort();
        }
      } finally {
        if (!abort.signal.aborted)
          timer = setTimeout(poll, Math.min(30_000, 5_000 * 2 ** Math.min(checks++, 3)));
      }
    };
    setObserving(Date.now() < deadline);
    timer = setTimeout(poll, 5_000);
    return () => {
      abort.abort();
      clearTimeout(timer);
      if (observer.current === abort) observer.current = undefined;
      setObserving(false);
    };
  }, [busy, connectionId, submitted, view?.status, view?.requiresOrigin, view?.expiresAt, view?.challenge?.expiresAt, observeUntil]);
  async function act(action: string, fields: object = {}) {
    if (cancelling.current) return;
    if (controller.current && !controller.current.signal.aborted) return;
    observer.current?.abort();
    setBusy(true);
    setError("");
    setProgress([]);
    const abort = new AbortController();
    let sent = false;
    controller.current = abort;
    const read = (action: string) =>
      request<View>("/native", { connectionId, action }, abort.signal);
    const pause = () =>
      new Promise<void>((resolve, reject) => {
        const cancelled = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          abort.signal.removeEventListener("abort", cancelled);
          resolve();
        }, 1500);
        abort.signal.addEventListener("abort", cancelled, { once: true });
        if (abort.signal.aborted) cancelled();
      });
    try {
      if (action === "reload") {
        const next = await request<View>("/native", { connectionId, action: "navigate", url: `https://${view?.domain ?? domain}/` }, abort.signal);
        if (!active.current || abort.signal.aborted) return;
        setView(next);
        if (nativeLoginPageError(next)) return;
        action = "form";
      }
      if (action === "credentials") {
        setPreparing(true);
        // The UI is usable immediately. Check the destination only after Connect,
        // and never send credentials until the private browser reports its fields.
        let ready: View | undefined;
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt) await pause();
          ready = await read("form");
          if (!active.current || abort.signal.aborted) return;
          if (ready.status === "connected") {
            onClose();
            return;
          }
          if (nativeLoginPageError(ready) || ready.requiresOrigin) { setView(ready); return; }
          if (ready.fields?.length) break;
        }
        if (!ready?.fields?.length || ready.requiresOrigin) {
          setView(ready);
          if (!ready?.requiresOrigin) setError(
            "Aiko couldn’t find supported sign-in fields. Your login has not been sent. Try again, or complete any verification on your phone and check sign-in status.",
          );
          return;
        }
        if(ready.fields.includes("code") && !("code" in fields && fields.code)) {
          form.current?.reset();setView(ready);setError("Enter your verification code to finish connecting.");return;
        }
        let otpBinding: ReturnType<typeof nativeOtpSubmission> | undefined;
        if("code" in fields && fields.code) {
          try {otpBinding=nativeOtpSubmission(view,ready);}
          catch(failure) {form.current?.reset();setView(ready);throw failure;}
        }
        const automatic =
          !otpBinding &&
          "username" in fields &&
          "password" in fields &&
          !!fields.username &&
          !!fields.password;
        const input = Object.fromEntries(
          Object.entries(fields).filter(
            ([name]) =>
              (automatic && ["username", "password"].includes(name)) ||
              ready!.fields!.includes(name),
          ),
        );
        if (!Object.keys(input).length) {
          setView(ready);
          setError("Complete the sign-in fields below.");
          return;
        }
        setPreparing(false);
        setSubmitted(true);
        sent = true;
        form.current?.reset();
        setShowPassword(false);
        // Submit once. Polling below never resends credentials, including after uncertain responses.
        const result = await request<View>(
          "/native",
          { connectionId, action: automatic ? "login" : action, ...input, ...otpBinding },
          abort.signal,
        );
        fields = {};
        if (!active.current || abort.signal.aborted) return;
        setView(result);
        if (result.status === "connected") {
          onClose();
          return;
        }
        if (nativeLoginPageError(result) || result.requiresOrigin) {
          return;
        }
        if (result.fields?.includes("code")) {
          setError("Enter your verification code to finish connecting.");
          return;
        }
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        if (action !== "form" || attempt > 0) await pause();
        if (!active.current || abort.signal.aborted) return;
        if (action !== "form") {
          try {
            const verified = await read("finish");
            if (!active.current || abort.signal.aborted) return;
            if (verified.status === "connected") {
              onClose();
              return;
            }
          } catch {
            if (abort.signal.aborted) return;
          }
        }
        const next = await read("form");
        if (!active.current || abort.signal.aborted) return;
        setView(next);
        if (nativeLoginPageError(next) || next.requiresOrigin) {
          return;
        }
        if (next.status === "connected") {
          onClose();
          return;
        }
        if (
          next.fields?.length &&
          (action === "form" || next.fields.includes("code") || attempt >= 2)
        ) {
          if (action !== "form")
            setError(
              next.fields.includes("code")
                ? "Enter your verification code to finish connecting."
                : "The website needs another sign-in step. Complete the fields below.",
            );
          return;
        }
      }
      setError(
        "This website needs an additional check. Try again after completing any verification on your phone.",
      );
    } catch (failure) {
      if (active.current && !abort.signal.aborted)
        setError(
          failure instanceof MiniAppAuthenticationError || failure instanceof NativeLoginChallengeError
            ? failure.message
            : sent || submitted
              ? "Could not confirm sign-in. Check its status before trying again; your credentials won’t be resent."
              : "Could not open this app’s sign-in page. Your login was not sent. Please try Connect again.",
        );
    } finally {
      fields = {};
      if (controller.current === abort) controller.current = undefined;
      if (active.current && !abort.signal.aborted) setBusy(false);
      if (active.current && !abort.signal.aborted) setPreparing(false);
    }
  }
  useEffect(() => {
    active.current = true;
    const currentForm = form.current;
    return () => {
      active.current = false;
      controller.current?.abort();
      currentForm?.reset();
    };
  }, [connectionId]);
  // Saved password managers are optional; an unavailable endpoint simply hides the option.
  useEffect(() => {
    let stale = false;
    request<{ managers: PasswordManager[] }>("/password-managers")
      .then((result) => {
        if (!stale) setManagers(result.managers);
      })
      .catch(() => {
        if (!stale) setManagers([]);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const managerEntries = (managers ?? [])
    .filter((manager) => manager.status === "connected")
    .flatMap((manager) =>
      manager.entries
        .filter((entry) => !entry.website || entry.website === domain)
        .map((entry) => ({
          ...entry,
          managerId: manager.id,
          kind: manager.kind,
          managerName: manager.name,
        })),
    );
  const sortedEntries = managerEntries.sort((a, b) => {
    const match = (entry: typeof a) =>
      entry.website ? Number(entry.website === (domain ?? "")) : 0;
    return match(b) - match(a);
  });
  const [picked, setPicked] = useState(0);
  const pickedEntry =
    sortedEntries[Math.min(picked, Math.max(sortedEntries.length - 1, 0))];
  async function fillWithManager() {
    if (cancelling.current || !pickedEntry) return;
    if (controller.current && !controller.current.signal.aborted) return;
    observer.current?.abort();
    setBusy(true);
    setError("");
    setManagerError("");
    const abort = new AbortController();
    controller.current = abort;
    const read = (action: string) =>
      request<View>("/native", { connectionId, action }, abort.signal);
    const pause = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    try {
      // The host resolves the saved reference and submits it into the private
      // page; the password is never sent back to this app.
      const next = await request<View>(
        "/password-managers/fill",
        {
          connectionId,
          managerId: pickedEntry.managerId,
          reference: pickedEntry.reference,
          ...(managerUsername.trim()
            ? { username: managerUsername.trim() }
            : {}),
        },
        abort.signal,
      );
      if (!active.current || abort.signal.aborted) return;
      setSubmitted(true);
      if (next.status === "connected") {
        onClose();
        return;
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        await pause();
        if (!active.current || abort.signal.aborted) return;
        try {
          const verified = await read("finish");
          if (!active.current || abort.signal.aborted) return;
          if (verified.status === "connected") {
            onClose();
            return;
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        const formView = await read("form");
        if (!active.current || abort.signal.aborted) return;
        setView(formView);
        if (nativeLoginPageError(formView) || formView.requiresOrigin) {
          return;
        }
        if (formView.status === "connected") {
          onClose();
          return;
        }
        if (formView.fields?.length) {
          setError(
            formView.fields.includes("code")
              ? "Enter your verification code to finish connecting."
              : "The website needs another sign-in step. Complete the fields below.",
          );
          return;
        }
      }
      setError(
        "This website needs an additional check. Try again after completing any verification on your phone.",
      );
    } catch (failure) {
      if (active.current && !abort.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not use the saved password manager.",
        );
    } finally {
      if (controller.current === abort) controller.current = undefined;
      if (active.current && !abort.signal.aborted) {
        setBusy(false);
        setPreparing(false);
      }
    }
  }
  async function approveOrigin() {
    if (busy || controller.current || cancelling.current || pageError || !view?.requiresOrigin) return;
    observer.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      const approved = await request<View>(
        "/native",
        { connectionId, action: "allow_origin", url: view.requiresOrigin },
        abort.signal,
      );
      if (!active.current || abort.signal.aborted) return;
      const next = approved.status === "connected" || approved.requiresOrigin
        ? approved
        : await request<View>("/native", { connectionId, action: "form" }, abort.signal);
      if (!active.current || abort.signal.aborted) return;
      if (next.status === "connected") {
        onClose();
        return;
      }
      setView(next);
      if (!next.requiresOrigin && !next.fields?.length)
        setError("Aiko couldn’t find supported sign-in fields. Complete any verification on your phone, then check sign-in status.");
    } catch (failure) {
      if (active.current && !abort.signal.aborted)
        setError(failure instanceof MiniAppAuthenticationError
          ? failure.message
          : "Could not confirm the sign-in provider. Check sign-in status before trying again.");
    } finally {
      if (controller.current === abort) controller.current = undefined;
      if (active.current && !abort.signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    if (cancelling.current) return;
    cancelling.current = true;
    observer.current?.abort();
    controller.current?.abort();
    form.current?.reset();
    setShowPassword(false);
    setBusy(true);
    try {
      const result = await request<{ relayDisconnectStatus?: string }>(
        "/disconnect",
        { connectionId },
      );
      if (
        result.relayDisconnectStatus &&
        result.relayDisconnectStatus !== "confirmed"
      )
        throw new Error("Private cleanup pending");
      if (active.current) onClose();
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof MiniAppAuthenticationError
            ? failure.message
            : "Cancellation could not be confirmed. Please try closing again.",
        );
    } finally {
      cancelling.current = false;
      if (active.current) setBusy(false);
    }
  }
  const fields = view?.fields?.length ? view.fields : ["username", "password"];
  const website = view?.domain ?? domain ?? "your website";
  return (
    <MiniAppScreen title="Connect app" close={() => void cancel()}>
      <section
        className="native-login"
        aria-label="Connect with password"
        aria-busy={busy}
      >
        <div className="credential-identity">
          <span className="credential-symbol">
            <KeyRound size={26} aria-hidden="true" />
          </span>
          <div>
            <h3>{website}</h3>
            <p>Enter your login</p>
          </div>
        </div>
        {error && (
          <p className="credential-error" role="alert" id="credential-error">
            {error}
          </p>
        )}
        {busy && (
          <p className="credential-progress" role="status">
            <LoaderCircle
              size={18}
              className="app-spinner"
              aria-hidden="true"
            />
            {preparing
              ? "Opening sign-in…"
              : submitted
                ? "Verifying your connection…"
                : "Getting your login ready…"}
          </p>
        )}
        {observing && !busy && (
          <p className="credential-progress" role="status">
            Waiting for verification. If you approve in the app, Aiko will check automatically.
          </p>
        )}
        {!!progress.length && (
          <details className="credential-setup" open>
            <summary>Connection progress</summary>
            <ol role="log" aria-live="polite" aria-label="Connection progress">
              {progress.map((entry) => (
                <li key={`${entry.at}:${entry.stage}`}>
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
        {(!view?.requiresOrigin || pageError) && (
          <form
            ref={form}
            autoComplete="on"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const credentials: Record<string, string> = {};
              for (const name of ["username", "password", "code"]) {
                const value = data.get(name);
                if (typeof value === "string" && value)
                  credentials[name] = value;
              }
              // Clear OTP before asynchronous form validation; only this submission closure retains it.
              if(credentials.code) event.currentTarget.reset();
              void act("credentials", credentials);
            }}
          >
            {!!fields.length && (
              <div className="credential-fields">
                {fields.includes("username") && (
                  <div className="credential-field">
                    <label htmlFor="website-username">Email or username</label>
                    <input
                      id="website-username"
                      name="username"
                      type="text"
                      placeholder="you@example.com"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={2048}
                      required
                      defaultValue={username ?? ""}
                      disabled={busy}
                    />
                  </div>
                )}
                {fields.includes("password") && (
                  <div className="credential-field">
                    <label htmlFor="website-password">Password</label>
                    <div className="credential-password">
                      <input
                        id="website-password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your password"
                        autoComplete="current-password"
                        maxLength={2048}
                        required
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                        aria-pressed={showPassword}
                        disabled={busy}
                        onClick={() => setShowPassword((value) => !value)}
                      >
                        {showPassword ? (
                          <EyeOff size={20} aria-hidden="true" />
                        ) : (
                          <Eye size={20} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                )}
                {fields.includes("code") && (
                  <div className="credential-field">
                    <label htmlFor="website-code">Verification code</label>
                    <input
                      id="website-code"
                      name="code"
                      type="text"
                      inputMode="numeric"
                      placeholder="Enter code"
                      autoComplete="one-time-code"
                      maxLength={2048}
                      required
                      disabled={busy}
                    />
                  </div>
                )}
              </div>
            )}
            {!!fields.length && (
              <button
                className="button primary credential-submit"
                disabled={busy}
                type="submit"
              >
                {busy
                  ? "Connecting…"
                  : fields.includes("code")
                    ? "Verify and connect"
                    : "Connect"}
              </button>
            )}
          </form>
        )}
        {!!sortedEntries.length && !view?.requiresOrigin && (
          <details
            className="manager-fill"
            onToggle={(event) => {
              managerOpen.current = event.currentTarget.open;
            }}
          >
            <summary>
              <KeyRound size={15} aria-hidden="true" /> Use a saved password
              manager
            </summary>
            <div className="credential-fields">
              <div className="credential-field">
                <label htmlFor="manager-entry">Saved login</label>
                <select
                  id="manager-entry"
                  value={Math.min(
                    picked,
                    Math.max(sortedEntries.length - 1, 0),
                  )}
                  onChange={(event) => setPicked(Number(event.target.value))}
                >
                  {sortedEntries.map((entry, index) => (
                    <option
                      key={`${entry.managerId}:${entry.reference}`}
                      value={index}
                    >
                      {entry.label} — {entry.managerName}
                      {entry.website && entry.website !== domain
                        ? ` (${entry.website})`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>
              {pickedEntry?.kind !== "zoho-vault" && <div className="credential-field">
                <label htmlFor="manager-username">Email or username</label>
                <input
                  id="manager-username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={2048}
                  value={managerUsername}
                  onChange={(event) => setManagerUsername(event.target.value)}
                  disabled={busy}
                />
              </div>}
            </div>
            {managerError && (
              <p className="credential-error" role="alert">
                {managerError}
              </p>
            )}
            <button
              type="button"
              className="button primary credential-submit"
              disabled={busy || !pickedEntry}
              onClick={() => void fillWithManager()}
            >
              {busy ? "Connecting…" : "Fill from password manager"}
            </button>
            <p className="aiko-fineprint">
              Aiko’s host reads the saved password and enters it into the
              private sign-in page. It is never shown, stored or shared.
            </p>
          </details>
        )}
        {pageError && <p className="credential-error" role="alert">{pageError}</p>}
        {view?.requiresOrigin && !pageError && (
          <div className="native-login-provider" role="status">
            <p>
              {website} opened {view.currentHost} for sign-in. Continue only if
              you recognize this sign-in provider.
            </p>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void approveOrigin()}
            >
              Continue to {view.currentHost ?? "sign-in provider"}
            </button>
          </div>
        )}
        {(view || error) && !busy && (
          <div className="connector-actions">
            {pageError && !submitted && view?.pageError !== "navigation_uncertain" && (
              <button type="button" className="button" onClick={() => void act("reload")}>
                Reload sign-in
              </button>
            )}
            <button
              type="button"
              className="button"
              onClick={() => void act(submitted ? "check" : "form")}
            >
              Check sign-in status
            </button>
          </div>
        )}
        <p className="credential-privacy">
          <LockKeyhole size={14} aria-hidden="true" />
          Private sign-in. Never shared in chat.
        </p>
      </section>
    </MiniAppScreen>
  );
}
