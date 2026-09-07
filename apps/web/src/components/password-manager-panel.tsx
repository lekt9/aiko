import { useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { MiniAppScreen } from "./mini-app-screen";
import {
  managerKindHints,
  managerKindLabels,
  websiteDomain,
  type ManagerProvider,
  type PasswordManager,
} from "../lib/connectors";

type EntryDraft = { label: string; website: string; reference: string };

/** Connect a password manager once; sign-ins can then be filled from it.
 * OAuth grants stay sealed server-side; only references reach the app. */
export function PasswordManagerPanel({
  request,
  onClose,
  onChanged,
}: {
  request: <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [managers, setManagers] = useState<PasswordManager[]>();
  const [loadError, setLoadError] = useState("");
  const [providers, setProviders] = useState<ManagerProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const kind = provider?.kind ?? "remote-mcp";
  const [pending, setPending] = useState<{ id: string; url: string }>();
  const popup = useRef<Window | null>(null);
  const completing = useRef(false);
  const [responseUrl, setResponseUrl] = useState("");
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<EntryDraft[]>([
    { label: "", website: "", reference: "" },
  ]);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const removing = useRef<string | undefined>(undefined);

  async function refresh() {
    try {
      const result = await request<{
        managers: PasswordManager[];
        providers: ManagerProvider[];
      }>("/password-managers");
      setManagers(result.managers);
      setProviders(result.providers ?? []);
      setLoadError("");
    } catch (failure) {
      setLoadError(
        failure instanceof Error
          ? failure.message
          : "Password managers are unavailable.",
      );
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setEntry(index: number, patch: Partial<EntryDraft>) {
    setEntries((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const trimmed = entries.filter(
      (entry) => entry.reference.trim() || entry.label.trim(),
    );
    if (
      !name.trim() ||
      !provider ||
      trimmed.some((entry) => !entry.reference.trim() || !entry.label.trim())
    ) {
      setFormError(
        "Choose a connection, give it a name, and label every reference.",
      );
      return;
    }
    for (const entry of trimmed) {
      if (entry.website.trim() && !websiteDomain(entry.website)) {
        setFormError(
          "Websites look like github.com — an HTTPS address without login details.",
        );
        return;
      }
    }
    setSaving(true);
    setFormError("");
    try {
      const result = await request<
        PasswordManager & { authorizationUrl?: string }
      >("/password-managers/add", {
        kind,
        name: name.trim(),
        providerId: provider!.id,
        entries: trimmed.map((entry) => ({
          label: entry.label.trim(),
          reference: entry.reference.trim(),
          ...(entry.website.trim() ? { website: entry.website.trim() } : {}),
        })),
      });
      if (result.authorizationUrl)
        setPending({ id: result.id, url: result.authorizationUrl });
      setEntries([{ label: "", website: "", reference: "" }]);
      setName("");
      setNotice(
        result.authorizationUrl
          ? "Continue to your password manager to authorize this connection."
          : "Connected. Your saved references can now fill sign-ins.",
      );
      onChanged?.();
    } catch (failure) {
      setFormError(
        failure instanceof Error
          ? failure.message
          : "Could not save this password manager.",
      );
    } finally {
      await refresh();
      setSaving(false);
    }
  }
  async function completeAuthorization(data: {
    code?: unknown;
    state?: unknown;
    error?: unknown;
  }) {
    if (!pending || saving || completing.current) return;
    if (data.state !== new URL(pending.url).searchParams.get("state")) return;
    if (data.error || typeof data.code !== "string" || !data.code) {
      setFormError("Authorization was cancelled. Reconnect when ready.");
      setPending(undefined);
      return;
    }
    completing.current = true;
    setSaving(true);
    setFormError("");
    setResponseUrl("");
    try {
      await request("/password-managers/callback", {
        managerId: pending.id,
        code: data.code,
        state: data.state,
      });
      setNotice("Connected. Your saved references can now fill sign-ins.");
      onChanged?.();
    } catch {
      setFormError(
        "Authorization could not be completed. Reconnect to try again.",
      );
    } finally {
      setPending(undefined);
      setSaving(false);
      completing.current = false;
      void refresh();
    }
  }
  useEffect(() => {
    if (!pending) return;
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        !popup.current ||
        event.source !== popup.current ||
        event.data?.type !== "unlock-manager-oauth"
      )
        return;
      void completeAuthorization(event.data);
    };
    const channel = new BroadcastChannel("unlock-manager-oauth");
    channel.onmessage = (event) => {
      if (event.data?.type === "unlock-manager-oauth")
        void completeAuthorization(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      channel.close();
    };
  }, [pending, saving, request, onChanged]);
  async function reconnect(id: string) {
    setSaving(true);
    setFormError("");
    try {
      const result = await request<{ authorizationUrl?: string }>(
        "/password-managers/authorize",
        { managerId: id },
      );
      if (result.authorizationUrl)
        setPending({ id, url: result.authorizationUrl });
      await refresh();
    } catch {
      setFormError(
        "Could not reconnect this password manager. Try again or create a new connection.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function remove(id: string) {
    if (removing.current) return;
    removing.current = id;
    setFormError("");
    try {
      await request("/password-managers/remove", { managerId: id });
      if (pending?.id === id) setPending(undefined);
      setNotice(
        "Disconnected. Saved logins from it can no longer fill sign-ins.",
      );
      onChanged?.();
      await refresh();
    } catch (failure) {
      setFormError(
        failure instanceof Error
          ? failure.message
          : "Could not remove this password manager.",
      );
    } finally {
      removing.current = undefined;
    }
  }
  return (
    <MiniAppScreen title="Password managers" close={onClose}>
      <section aria-label="Connected password managers" aria-busy={saving}>
        <div className="credential-identity">
          <span className="credential-symbol">
            <KeyRound size={26} aria-hidden="true" />
          </span>
          <div>
            <h3>Sign in from your password manager</h3>
            <p>
              Connect it once; Aiko can fill app sign-ins from it. Authorize
              access in your password manager; Unlock saves references and fills
              passwords privately.
            </p>
          </div>
        </div>
        {loadError && (
          <p className="credential-error" role="alert">
            {loadError}
          </p>
        )}
        {notice && (
          <p className="connector-feedback" role="status">
            {notice}
          </p>
        )}
        {managers?.map((manager) => (
          <article className="manager-card" key={manager.id}>
            <div className="manager-card-heading">
              <div>
                <h3>{manager.name}</h3>
                <p>{managerKindLabels[manager.kind]}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Disconnect ${manager.name}`}
                disabled={saving || removing.current === manager.id}
                onClick={() => void remove(manager.id)}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
            {manager.status !== "connected" && (
              <p className="aiko-fineprint">Authorization required</p>
            )}
            {manager.providerId ? (
              <button
                type="button"
                className="text-button"
                disabled={saving}
                onClick={() => void reconnect(manager.id)}
              >
                Reconnect
              </button>
            ) : (
              <p className="aiko-fineprint">
                Disconnect this older connection and authorize a new one below.
              </p>
            )}
            <ul className="manager-entries">
              {manager.entries.map((entry) => (
                <li key={entry.reference}>
                  <span>{entry.label}</span>
                  <span className="manager-entry-domain">
                    {entry.website ?? "any app"}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
        {managers && !managers.length && !loadError && (
          <p className="aiko-fineprint">
            No password manager connected yet. Add one below.
          </p>
        )}
        {pending && (
          <div className="manager-card" role="status">
            <p>Authorize access in your password manager, then return here.</p>
            <button
              type="button"
              className="button primary"
              disabled={saving}
              onClick={() => {
                popup.current = window.open(
                  pending.url,
                  "unlock-password-manager-oauth",
                  "popup,width=600,height=720",
                );
                if (!popup.current)
                  setFormError(
                    "Allow popups to authorize your password manager.",
                  );
              }}
            >
              Continue to password manager
            </button>
            <details>
              <summary>Finish from another browser</summary>
              <label htmlFor="manager-response">Connection result</label>
              <input
                id="manager-response"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={responseUrl}
                onChange={(event) => setResponseUrl(event.target.value)}
                placeholder="Paste the result copied after authorization"
              />
              <button
                type="button"
                className="text-button"
                disabled={saving || !responseUrl}
                onClick={() => {
                  try {
                    const result = new URL(responseUrl);
                    if (
                      result.origin !== window.location.origin ||
                      result.pathname !== "/password-manager-callback.html" ||
                      result.searchParams.get("state") !==
                        new URL(pending.url).searchParams.get("state")
                    )
                      throw new Error();
                    void completeAuthorization({
                      code: result.searchParams.get("code"),
                      state: result.searchParams.get("state"),
                      error: result.searchParams.get("error"),
                    });
                  } catch {
                    setFormError(
                      "Paste the connection result from the authorization window.",
                    );
                  }
                }}
              >
                Finish connection
              </button>
            </details>
          </div>
        )}
        {!providers.length && !loadError && managers && (
          <p className="aiko-fineprint">
            No password manager connections are configured on this host yet.
          </p>
        )}
        <form className="manager-form" onSubmit={(event) => void save(event)}>
          <h3>Connect a password manager</h3>
          <div className="credential-fields">
            <div className="credential-field">
              <label htmlFor="manager-kind">Password manager</label>
              <select
                id="manager-kind"
                value={provider?.id ?? ""}
                onChange={(event) => setProviderId(event.target.value)}
                disabled={saving || !providers.length}
              >
                {!providers.length && (
                  <option value="">No connections available</option>
                )}
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="credential-field">
              <label htmlFor="manager-name">Name</label>
              <input
                id="manager-name"
                type="text"
                maxLength={60}
                required
                placeholder="Personal vault"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>
          <p className="aiko-fineprint">{managerKindHints[kind]}</p>
          {entries.map((entry, index) => (
            <fieldset className="manager-entry" key={index}>
              <legend>Saved login {index + 1}</legend>
              <div className="credential-fields">
                <div className="credential-field">
                  <label htmlFor={`entry-label-${index}`}>Label</label>
                  <input
                    id={`entry-label-${index}`}
                    type="text"
                    maxLength={60}
                    placeholder="GitHub login"
                    value={entry.label}
                    onChange={(event) =>
                      setEntry(index, { label: event.target.value })
                    }
                  />
                </div>
                <div className="credential-field">
                  <label htmlFor={`entry-website-${index}`}>
                    Website (optional)
                  </label>
                  <input
                    id={`entry-website-${index}`}
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={253}
                    placeholder="github.com"
                    value={entry.website}
                    onChange={(event) =>
                      setEntry(index, { website: event.target.value })
                    }
                  />
                </div>
                <div className="credential-field">
                  <label htmlFor={`entry-reference-${index}`}>
                    Secret reference
                  </label>
                  <input
                    id={`entry-reference-${index}`}
                    type="text"
                    required={index === 0}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={500}
                    placeholder={
                      kind === "onepassword"
                        ? "op://Vault/Item/password"
                        : "secret reference"
                    }
                    value={entry.reference}
                    onChange={(event) =>
                      setEntry(index, { reference: event.target.value })
                    }
                  />
                </div>
              </div>
            </fieldset>
          ))}
          {entries.length < 50 && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setEntries((current) => [
                  ...current,
                  { label: "", website: "", reference: "" },
                ])
              }
            >
              <Plus size={15} aria-hidden="true" /> Add another saved login
            </button>
          )}
          {formError && (
            <p className="credential-error" role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            className="button primary credential-submit"
            disabled={saving || !provider}
          >
            {saving ? (
              <>
                <LoaderCircle
                  size={16}
                  className="app-spinner"
                  aria-hidden="true"
                />{" "}
                Saving…
              </>
            ) : (
              "Connect password manager"
            )}
          </button>
          <p className="aiko-fineprint">
            You authorize access with your password manager. Unlock keeps that
            authorization encrypted and resolves saved references only when
            filling a sign-in. Passwords are never shared with the assistant.
          </p>
        </form>
      </section>
    </MiniAppScreen>
  );
}
