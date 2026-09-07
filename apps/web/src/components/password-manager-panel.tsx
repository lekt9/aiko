import { useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { MiniAppScreen } from "./mini-app-screen";
import {
  managerKindHints,
  managerKindLabels,
  websiteDomain,
  type ManagerKind,
  type PasswordManager,
} from "../lib/connectors";

type EntryDraft = { label: string; website: string; reference: string };
const kinds = Object.keys(managerKindLabels) as ManagerKind[];

/** Connect a password manager once; sign-ins can then be filled from it.
 * Only the provider token and opaque references are stored, sealed server-side. */
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
  const [kind, setKind] = useState<ManagerKind>("onepassword");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [entries, setEntries] = useState<EntryDraft[]>([{ label: "", website: "", reference: "" }]);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const removing = useRef<string>();

  async function refresh() {
    try {
      const result = await request<{ managers: PasswordManager[] }>("/password-managers");
      setManagers(result.managers);
      setLoadError("");
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : "Password managers are unavailable.");
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
    const trimmed = entries.filter((entry) => entry.reference.trim() || entry.label.trim());
    if (!name.trim() || !token.trim() || trimmed.some((entry) => !entry.reference.trim() || !entry.label.trim())) {
      setFormError("Give the connection a name, paste its token, and label every reference.");
      return;
    }
    for (const entry of trimmed) {
      if (entry.website.trim() && !websiteDomain(entry.website)) {
        setFormError("Websites look like github.com — an HTTPS address without login details.");
        return;
      }
    }
    setSaving(true);
    setFormError("");
    try {
      await request("/password-managers/add", {
        kind,
        name: name.trim(),
        token: token.trim(),
        entries: trimmed.map((entry) => ({
          label: entry.label.trim(),
          reference: entry.reference.trim(),
          ...(entry.website.trim() ? { website: entry.website.trim() } : {}),
        })),
      });
      setToken("");
      setEntries([{ label: "", website: "", reference: "" }]);
      setName("");
      setNotice("Saved. This password manager can now fill sign-ins.");
      onChanged?.();
      await refresh();
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : "Could not save this password manager.");
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
      setNotice("Disconnected. Saved logins from it can no longer fill sign-ins.");
      onChanged?.();
      await refresh();
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : "Could not remove this password manager.");
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
            <p>Connect it once; Aiko can fill app sign-ins from it. Your master password never leaves the app.</p>
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
                disabled={removing.current === manager.id}
                onClick={() => void remove(manager.id)}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
            <ul className="manager-entries">
              {manager.entries.map((entry) => (
                <li key={entry.reference}>
                  <span>{entry.label}</span>
                  <span className="manager-entry-domain">{entry.website ?? "any app"}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
        {managers && !managers.length && !loadError && (
          <p className="aiko-fineprint">No password manager connected yet. Add one below.</p>
        )}
        <form className="manager-form" onSubmit={(event) => void save(event)}>
          <h3>Connect a password manager</h3>
          <div className="credential-fields">
            <div className="credential-field">
              <label htmlFor="manager-kind">Password manager</label>
              <select
                id="manager-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as ManagerKind)}
              >
                {kinds.map((value) => (
                  <option key={value} value={value}>
                    {managerKindLabels[value]}
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
            <div className="credential-field">
              <label htmlFor="manager-token">Service token</label>
              <textarea
                id="manager-token"
                required
                rows={3}
                autoComplete="off"
                spellCheck={false}
                placeholder={managerKindHints[kind].split("·")[0]?.trim()}
                value={token}
                onChange={(event) => setToken(event.target.value)}
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
                    onChange={(event) => setEntry(index, { label: event.target.value })}
                  />
                </div>
                <div className="credential-field">
                  <label htmlFor={`entry-website-${index}`}>Website (optional)</label>
                  <input
                    id={`entry-website-${index}`}
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={253}
                    placeholder="github.com"
                    value={entry.website}
                    onChange={(event) => setEntry(index, { website: event.target.value })}
                  />
                </div>
                <div className="credential-field">
                  <label htmlFor={`entry-reference-${index}`}>Secret reference</label>
                  <input
                    id={`entry-reference-${index}`}
                    type="text"
                    required={index === 0}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={500}
                    placeholder={kind === "onepassword" ? "op://Vault/Item/password" : "secret reference"}
                    value={entry.reference}
                    onChange={(event) => setEntry(index, { reference: event.target.value })}
                  />
                </div>
              </div>
            </fieldset>
          ))}
          {entries.length < 50 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setEntries((current) => [...current, { label: "", website: "", reference: "" }])}
            >
              <Plus size={15} aria-hidden="true" /> Add another saved login
            </button>
          )}
          {formError && (
            <p className="credential-error" role="alert">
              {formError}
            </p>
          )}
          <button type="submit" className="button primary credential-submit" disabled={saving}>
            {saving ? (
              <>
                <LoaderCircle size={16} className="app-spinner" aria-hidden="true" /> Saving…
              </>
            ) : (
              "Connect password manager"
            )}
          </button>
          <p className="aiko-fineprint">
            The service token is encrypted on Aiko’s host and is used only when you choose to fill a
            sign-in. It is never shown again or shared with the assistant.
          </p>
        </form>
      </section>
    </MiniAppScreen>
  );
}
