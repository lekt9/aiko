import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import { MiniAppScreen } from "./mini-app-screen";
import type { PasswordManager } from "../lib/connectors";

type View = {
  status: string;
  domain: string;
  fields?: string[];
  currentHost?: string;
  requiresOrigin?: string;
  screenshot?: string;
  width?: number;
  height?: number;
};
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
  const [websiteView, setWebsiteView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [managers, setManagers] = useState<PasswordManager[]>();
  const [managerUsername, setManagerUsername] = useState(username ?? "");
  const [managerError, setManagerError] = useState("");
  const managerOpen = useRef(false);
  const cancelling = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  async function act(action: string, fields: object = {}) {
    if (cancelling.current) return;
    if (controller.current && !controller.current.signal.aborted) return;
    setBusy(true);
    setError("");
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
          if (ready.fields?.length) break;
        }
        if (!ready?.fields?.length || ready.requiresOrigin) {
          setView(ready);
          setWebsiteView(true);
          if (!ready?.requiresOrigin) setView(await read("view"));
          setError(
            "Continue on the website below. Your login has not been sent.",
          );
          return;
        }
        const automatic =
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
        await request<View>(
          "/native",
          { connectionId, action: automatic ? "login" : action, ...input },
          abort.signal,
        );
        fields = {};
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
        if (next.requiresOrigin) {
          setWebsiteView(true);
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
    } catch {
      if (active.current && !abort.signal.aborted)
        setError(
          sent || submitted
            ? "Could not confirm sign-in. Check its status before trying again; your credentials won’t be resent."
            : "Could not open this app’s sign-in page. Your login was not sent. Please try Connect again.",
        );
    } finally {
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
  const managerEntries = (managers ?? []).flatMap((manager) =>
    manager.entries.map((entry) => ({
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
        if (formView.requiresOrigin) {
          setWebsiteView(true);
          return;
        }
        if (formView.status === "connected") {
          onClose();
          return;
        }
        if (formView.fields?.length) {
          setWebsiteView(false);
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
  async function control(action: string, fields: object = {}) {
    if (busy || controller.current || cancelling.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setWebsiteView(true);
    try {
      const next = await request<View>(
        "/native",
        { connectionId, action, ...fields },
        abort.signal,
      );
      if (!active.current || abort.signal.aborted) return;
      if (next.status === "connected") {
        onClose();
        return;
      }
      setView(next);
      if (!next.screenshot && !next.requiresOrigin && action !== "finish")
        setView(
          await request<View>(
            "/native",
            { connectionId, action: "view" },
            abort.signal,
          ),
        );
    } catch {
      if (!abort.signal.aborted)
        setError(
          action === "finish"
            ? "Sign-in is not confirmed yet. Finish signing in and return to the app’s website, then check again."
            : "This step could not be confirmed. Refresh the website before repeating it.",
        );
    } finally {
      if (controller.current === abort) controller.current = undefined;
      if (active.current && !abort.signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    if (cancelling.current) return;
    cancelling.current = true;
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
    } catch {
      if (active.current)
        setError(
          "Cancellation could not be confirmed. Please try closing again.",
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
        {!websiteView && (
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
        {!!sortedEntries.length && !websiteView && (
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
              <div className="credential-field">
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
              </div>
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
        {websiteView && (
          <div className="native-login-browser">
            <p className="aiko-fineprint">{view?.currentHost ?? website}</p>
            {view?.requiresOrigin ? (
              <div role="status">
                <p>
                  This website opened {view.requiresOrigin} to sign in. Continue
                  only if you recognize this sign-in provider.
                </p>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void control("allow_origin", { url: view.requiresOrigin })
                  }
                >
                  Continue to {view.currentHost}
                </button>
              </div>
            ) : view?.screenshot ? (
              <img
                src={view.screenshot}
                alt="Private sign-in website. Tap a field or button to interact."
                draggable={false}
                onClick={(event) => {
                  if (busy) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  void control("click", {
                    x: Math.round(
                      ((event.clientX - box.left) / box.width) *
                        (view.width ?? 390),
                    ),
                    y: Math.round(
                      ((event.clientY - box.top) / box.height) *
                        (view.height ?? 640),
                    ),
                  });
                }}
              />
            ) : (
              <p>Open or refresh the website to continue.</p>
            )}
            {!view?.requiresOrigin && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = new FormData(event.currentTarget).get("text");
                  if (typeof input === "string" && input && !busy) {
                    event.currentTarget.reset();
                    void control("type", { text: input });
                  }
                }}
              >
                <label htmlFor="private-website-text">
                  Tap a field above, then enter its value
                </label>
                <input
                  id="private-website-text"
                  name="text"
                  type="password"
                  autoComplete="off"
                  maxLength={2048}
                  disabled={busy}
                />
                <button className="button" disabled={busy}>
                  Enter in selected field
                </button>
              </form>
            )}
            <div className="native-login-browser-tools">
              <button
                className="button"
                disabled={busy}
                onClick={() => void control("view")}
              >
                Refresh
              </button>
              <button
                className="button"
                disabled={busy || !!view?.requiresOrigin}
                onClick={() => void control("key", { key: "Tab" })}
              >
                Next field
              </button>
              <button
                className="button"
                disabled={busy || !!view?.requiresOrigin}
                onClick={() => void control("key", { key: "Enter" })}
              >
                Submit
              </button>
              <button
                className="button"
                disabled={busy || !!view?.requiresOrigin}
                onClick={() => void control("scroll", { delta: -480 })}
              >
                Scroll up
              </button>
              <button
                className="button"
                disabled={busy || !!view?.requiresOrigin}
                onClick={() => void control("scroll", { delta: 480 })}
              >
                Scroll down
              </button>
            </div>
            <details>
              <summary>Use a different sign-in address</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const url = new FormData(event.currentTarget).get("url");
                  if (typeof url === "string")
                    void control("navigate", { url });
                }}
              >
                <label htmlFor="private-login-url">HTTPS sign-in address</label>
                <input
                  id="private-login-url"
                  name="url"
                  type="url"
                  placeholder={`https://${website}/login`}
                  required
                  disabled={busy}
                />
                <button className="button" disabled={busy}>
                  Open address
                </button>
              </form>
            </details>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void control("finish")}
            >
              I’m signed in
            </button>
          </div>
        )}
        <div className="connector-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              websiteView
                ? (setWebsiteView(false), void act("form"))
                : void control("view")
            }
          >
            {websiteView ? "Use login fields" : "Sign in on website"}
          </button>
          {!!error && !busy && submitted && (
            <button
              className="button"
              onClick={() => void act(submitted ? "check" : "form")}
            >
              Check sign-in status
            </button>
          )}
        </div>
        <p className="credential-privacy">
          <LockKeyhole size={14} aria-hidden="true" />
          Private sign-in. Never shared in chat.
        </p>
      </section>
    </MiniAppScreen>
  );
}
