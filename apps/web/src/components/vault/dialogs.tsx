import { useState } from "react";
import { CsvImportDialog } from "./csv-import";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Plus,
  ShieldCheck,
} from "lucide-react";
import type { Connection, ConnectInput, ProfileAvatar } from "@unlock/sdk";
import { api, useAction, useWorkspace } from "../../lib/workspace";
import { DEMO_PASSWORD, useVault } from "../../lib/vault";
import {
  Avatar,
  CopyButton,
  FormError,
  Modal,
  ServiceIcon,
} from "./primitives";

const samples = [
  {
    id: "vercel",
    name: "Vercel",
    identity: "deploy@studio.example",
    domain: "vercel.example.test",
  },
  {
    id: "github",
    name: "GitHub",
    identity: "developer@studio.example",
    domain: "github.example.test",
  },
  {
    id: "linear",
    name: "Linear",
    identity: "product@studio.example",
    domain: "linear.example.test",
  },
  {
    id: "notion",
    name: "Notion",
    identity: "team@studio.example",
    domain: "notion.example.test",
  },
  {
    id: "figma",
    name: "Figma",
    identity: "design@studio.example",
    domain: "figma.example.test",
  },
] as const;
function LoginForm({
  login,
  mode,
}: {
  login?: Connection;
  mode?: "import" | "reference";
}) {
  const vault = useVault();
  const data = useWorkspace();
  const close = () => vault.setDialog(null);
  const [fixture, setFixture] = useState<ConnectInput["fixture"]>(
    samples.find((s) => !vault.items.some((c) => c.domain === s.domain))?.id ??
      "vercel",
  );
  const [name, setName] = useState(login?.name ?? "");
  const [identity, setIdentity] = useState(login?.identity ?? "");
  const [show, setShow] = useState(false);
  const [browser, setBrowser] = useState(false);
  const sample = samples.find((s) => s.id === fixture)!;
  const duplicate = vault.items.some((c) => c.domain === sample.domain);
  const external = login && ["reference", "sso"].includes(login.sourceMode);
  const connect = useAction(
    () =>
      api.connections.connect({
        fixture,
        mode: mode ?? (browser ? "session" : "native"),
        profileIds: vault.profile ? [vault.profile.id] : [],
      }),
    "",
  );
  const update = useAction(
    () =>
      api.connections.update(login!.id, {
        name,
        ...(!external ? { identity } : {}),
      }),
    "",
  );
  const sourceOffline =
    mode === "reference" &&
    !data.sources.find((s) => s.id === "onepassword")?.connected;
  const title = login
    ? "Edit login"
    : mode === "import"
      ? "Import a sample login"
      : mode === "reference"
        ? "Add from 1Password"
        : "Add login";
  return (
    <Modal title={title} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (login) update.mutate(undefined, { onSuccess: close });
          else
            connect.mutate(undefined, {
              onSuccess: (c) => {
                close();
                void vault.update({
                  login: c.id,
                  q: undefined,
                  favorites: undefined,
                });
              },
            });
        }}
      >
        <p className="modal-intro">
          {login
            ? "Keep your saved login up to date."
            : vault.profile
              ? `This login will be available to ${vault.profile.name}.`
              : "Save a login now. Choose your agents later."}
        </p>
        <div className="demo-note">
          Demo only · Use the sample details below, not real credentials.
        </div>
        {login ? (
          <>
            <label className="field">
              Login name
              <input
                autoFocus
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              Website
              <input readOnly value={login.domain} />
            </label>
          </>
        ) : (
          <label className="field">
            Website
            <select
              autoFocus
              value={fixture}
              onChange={(e) =>
                setFixture(e.target.value as ConnectInput["fixture"])
              }
            >
              {samples.map((s) => (
                <option
                  key={s.id}
                  value={s.id}
                  disabled={vault.items.some((c) => c.domain === s.domain)}
                >
                  {s.name}
                  {vault.items.some((c) => c.domain === s.domain)
                    ? " — already saved"
                    : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Username
          <input
            aria-label="Username"
            type="email"
            required
            readOnly={!login || !!external}
            value={login ? identity : sample.identity}
            onChange={(e) => setIdentity(e.target.value)}
            pattern=".+@.+\.(example|test)"
          />
          {login && !external && (
            <small>Use a synthetic address ending in .example or .test.</small>
          )}
        </label>
        {login?.passwordUnavailable ? (
          <p className="demo-note">
            Password not imported. This CSV item contains demo metadata only.
          </p>
        ) : browser || login?.kind === "session" ? (
          <div className="browser-method">
            <ShieldCheck size={22} />
            <div>
              <strong>
                {login?.sourceMode === "sso"
                  ? "Sign in with Google"
                  : "Sign in with your browser"}
              </strong>
              <p>
                A private sign-in, without a saved password. Simulated in this
                demo.
              </p>
            </div>
          </div>
        ) : (
          <label className="field">
            Password
            <div className="password-input">
              <input
                aria-label="Sample password"
                readOnly
                type={show ? "text" : "password"}
                value={DEMO_PASSWORD}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={
                  show ? "Hide sample password" : "Show sample password"
                }
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <small>
              {external
                ? `Managed in ${login.sourceLabel}. This demo cannot change it.`
                : "A fixed sample password. Real password changes are not connected."}
            </small>
          </label>
        )}
        {!login && !mode && (
          <button
            type="button"
            className="text-button alternate-method"
            onClick={() => setBrowser((v) => !v)}
          >
            {browser ? "Use a password instead" : "Use browser sign-in instead"}
          </button>
        )}
        {mode === "import" && (
          <p className="helper">
            An independent copy. Changes in the original password manager won’t
            sync. Existing logins are skipped.
          </p>
        )}
        {mode === "reference" && (
          <p className="helper">
            The original password stays in 1Password. This saves a sample
            reference, not a real vault connection.
          </p>
        )}
        {sourceOffline && (
          <p className="inline-error" role="alert">
            Reconnect 1Password in Settings first.
          </p>
        )}
        {!login && duplicate && (
          <p className="helper">
            All available samples are already saved. You can share them with
            another profile instead.
          </p>
        )}
        <FormError error={login ? update.error : connect.error} />
        <div className="form-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              update.isPending ||
              connect.isPending ||
              (!login && (duplicate || sourceOffline))
            }
          >
            {update.isPending || connect.isPending
              ? "Saving…"
              : login
                ? "Save changes"
                : mode === "import"
                  ? "Import login"
                  : "Save login"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ExistingLogins() {
  const vault = useVault();
  const [selected, setSelected] = useState<string[]>([]);
  const profile = vault.profile!;
  const rows = vault.items.filter((c) => !profile.connectionIds.includes(c.id));
  const save = useAction(
    () =>
      api.profiles.update(profile.id, {
        connectionIds: [...profile.connectionIds, ...selected],
      }),
    "",
  );
  return (
    <Modal title={`Add to ${profile.name}`} close={() => vault.setDialog(null)}>
      <p className="modal-intro">
        Choose from your vault. No need to save the same login twice.
      </p>
      <div className="check-list">
        {rows.map((c) => (
          <label className="check-row" key={c.id}>
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, c.id]
                    : selected.filter((id) => id !== c.id),
                )
              }
            />
            <ServiceIcon name={c.name} />
            <span>
              <strong>{c.name}</strong>
              <small>{c.identity}</small>
            </span>
          </label>
        ))}
        {!rows.length && (
          <p className="helper">
            Every saved login is already in this profile.
          </p>
        )}
      </div>
      <button
        className="new-login-option"
        onClick={() => vault.setDialog({ kind: "add" })}
      >
        <Plus size={19} />
        Create a new login
        <ArrowRight size={16} />
      </button>
      <FormError error={save.error} />
      <div className="form-actions">
        <button className="button" onClick={() => vault.setDialog(null)}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!selected.length || save.isPending}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: () => {
                vault.setDialog(null);
                void vault.update({
                  login: selected[0],
                  q: undefined,
                  favorites: undefined,
                });
              },
            })
          }
        >
          {save.isPending
            ? "Adding…"
            : `Add ${selected.length || ""} ${selected.length === 1 ? "login" : "logins"}`}
        </button>
      </div>
    </Modal>
  );
}
function ProfileForm({ id }: { id?: string }) {
  const data = useWorkspace();
  const vault = useVault();
  const profile = data.profiles.find((p) => p.id === id);
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState<ProfileAvatar>(
    profile?.avatar ?? "violet",
  );
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [connections, setConnections] = useState(profile?.connectionIds ?? []);
  const save = useAction(
    () =>
      profile
        ? api.profiles.update(profile.id, {
            name,
            avatar,
            enabled,
            connectionIds: connections,
          })
        : api.profiles.create({
            name,
            avatar,
            description: "Agent profile",
            connectionIds: connections,
          }),
    "",
  );
  if (id && !profile)
    return (
      <Modal title="Profile not found" close={() => vault.setDialog(null)}>
        <p>This profile is no longer available.</p>
      </Modal>
    );
  return (
    <Modal
      title={profile ? "Edit profile" : "New agent profile"}
      close={() => vault.setDialog(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, {
            onSuccess: (p) => vault.switchProfile(p.id),
          });
        }}
      >
        <p className="modal-intro">
          Give your agent a name and the logins it needs.
        </p>
        <label className="field">
          Profile name
          <input
            autoFocus
            required
            maxLength={60}
            value={name}
            placeholder="e.g. Research agent"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="avatar-picker">
          <legend>Profile color</legend>
          {(["violet", "blue", "mint", "peach"] as const).map((color) => (
            <label className={`avatar-choice ${color}`} key={color}>
              <input
                type="radio"
                name="avatar"
                value={color}
                checked={avatar === color}
                onChange={() => setAvatar(color)}
                aria-label={color}
              />
              <span aria-hidden="true">{(name[0] ?? "A").toUpperCase()}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="check-list">
          <legend>Available logins</legend>
          {vault.items.map((c) => (
            <label className="check-row" key={c.id}>
              <input
                type="checkbox"
                checked={connections.includes(c.id)}
                onChange={(e) =>
                  setConnections(
                    e.target.checked
                      ? [...connections, c.id]
                      : connections.filter((i) => i !== c.id),
                  )
                }
              />
              <ServiceIcon name={c.name} />
              <span>
                <strong>{c.name}</strong>
                <small>{c.identity}</small>
              </span>
            </label>
          ))}
          {!vault.items.length && (
            <p className="helper">
              Your vault is empty. You can add logins later.
            </p>
          )}
        </fieldset>
        {profile && (
          <>
            <label className="check-row access-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>
                <strong>Allow agent access</strong>
                <small>Turn off to stop this agent getting new sign-ins.</small>
              </span>
            </label>
            <details className="advanced">
              <summary>Connect this agent</summary>
              <p>
                Agent pairing is not connected in this demo. Use this profile ID
                with the local SDK for testing.
              </p>
              <div className="profile-id">
                <code>{profile.id}</code>
                <CopyButton value={profile.id} label="profile ID" />
              </div>
            </details>
          </>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <button
            type="button"
            className="button"
            onClick={() => vault.setDialog(null)}
          >
            Cancel
          </button>
          <button className="button primary" disabled={save.isPending}>
            {save.isPending
              ? "Saving…"
              : profile
                ? "Save profile"
                : "Create profile"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function AccessForm({ login }: { login: Connection }) {
  const data = useWorkspace();
  const vault = useVault();
  const [ids, setIds] = useState(
    data.profiles
      .filter((p) => p.connectionIds.includes(login.id))
      .map((p) => p.id),
  );
  const save = useAction(() => api.connections.assign(login.id, ids), "");
  return (
    <Modal
      title={`Who can use ${login.name}?`}
      close={() => vault.setDialog(null)}
    >
      <p className="modal-intro">
        You always have access. Choose the agents that can use this login too.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, { onSuccess: () => vault.setDialog(null) });
        }}
      >
        <div className="check-list">
          {data.profiles.map((p) => (
            <label className="check-row" key={p.id}>
              <input
                type="checkbox"
                checked={ids.includes(p.id)}
                onChange={(e) =>
                  setIds(
                    e.target.checked
                      ? [...ids, p.id]
                      : ids.filter((i) => i !== p.id),
                  )
                }
              />
              <Avatar profile={p} />
              <span>
                <strong>{p.name}</strong>
                <small>
                  {p.enabled ? "Agent profile" : "Access off for this profile"}
                </small>
              </span>
            </label>
          ))}
        </div>
        <p className="helper">
          An agent that has already signed in may stay signed in after you
          remove access.
        </p>
        <FormError error={save.error} />
        <div className="form-actions">
          <button
            type="button"
            className="button"
            onClick={() => vault.setDialog(null)}
          >
            Cancel
          </button>
          <button className="button primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save access"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RemoveLogin({
  login,
  everywhere,
}: {
  login: Connection;
  everywhere: boolean;
}) {
  const data = useWorkspace();
  const vault = useVault();
  const profile = vault.profile;
  const save = useAction(
    async () => {
      if (everywhere) await api.connections.action(login.id, "revoke");
      else
        await api.profiles.update(profile!.id, {
          connectionIds: profile!.connectionIds.filter((id) => id !== login.id),
        });
    },
    everywhere ? "Login deleted" : "Removed from profile",
  );
  const names = data.profiles
    .filter((p) => p.connectionIds.includes(login.id))
    .map((p) => p.name);
  return (
    <Modal
      title={
        everywhere
          ? `Delete ${login.name}?`
          : `Remove ${login.name} from this profile?`
      }
      close={() => vault.setDialog(null)}
    >
      <p className="modal-intro">
        {everywhere
          ? `This removes the login from your vault${names.length ? ` and from ${names.join(", ")}` : ""}.`
          : `It will stay in My vault and in other profiles. ${profile?.name} will no longer be able to get new sign-ins.`}
      </p>
      <p className="helper">
        Anyone already signed in may stay signed in. This doesn’t sign them out
        of the website.
      </p>
      <FormError error={save.error} />
      <div className="form-actions">
        <button className="button" onClick={() => vault.setDialog(null)}>
          Keep login
        </button>
        <button
          className={`button ${everywhere ? "danger" : "primary"}`}
          disabled={save.isPending}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: () => {
                vault.setDialog(null);
                void vault.update({ login: undefined });
              },
            })
          }
        >
          {save.isPending
            ? "Removing…"
            : everywhere
              ? "Delete for everyone"
              : "Remove from profile"}
        </button>
      </div>
    </Modal>
  );
}
function Reconnect({ login }: { login: Connection }) {
  const vault = useVault();
  const save = useAction(() => api.connections.action(login.id, "recover"), "");
  return (
    <Modal
      title={`Sign in to ${login.name}`}
      close={() => vault.setDialog(null)}
    >
      <div className="reconnect-identity">
        <ServiceIcon name={login.name} large />
        <strong>{login.identity}</strong>
      </div>
      <p className="modal-intro">
        Sign in once, and your agents can keep going.
      </p>
      <div className="demo-note">
        This is a simulated sign-in. No browser login or real credentials are
        collected.
      </div>
      <FormError error={save.error} />
      <div className="form-actions">
        <button className="button" onClick={() => vault.setDialog(null)}>
          <ArrowLeft size={16} />
          Not now
        </button>
        <button
          className="button primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(undefined, { onSuccess: () => vault.setDialog(null) })
          }
        >
          {save.isPending ? "Signing in…" : "Complete demo sign-in"}
        </button>
      </div>
    </Modal>
  );
}
export function VaultDialogs() {
  const vault = useVault();
  const dialog = vault.dialog;
  if (!dialog) return null;
  if (dialog.kind === "csv") return <CsvImportDialog />;
  if (dialog.kind === "profile") return <ProfileForm id={dialog.id} />;
  if (dialog.kind === "add") return <LoginForm mode={dialog.mode} />;
  if (dialog.kind === "existing")
    return vault.profile ? <ExistingLogins /> : <LoginForm />;
  const login = vault.items.find((c) => c.id === dialog.id);
  if (!login)
    return (
      <Modal
        title="Login no longer available"
        close={() => vault.setDialog(null)}
      >
        <p>Close this window and choose another login.</p>
      </Modal>
    );
  if (dialog.kind === "edit") return <LoginForm login={login} />;
  if (dialog.kind === "access") return <AccessForm login={login} />;
  if (dialog.kind === "reconnect") return <Reconnect login={login} />;
  return (
    <RemoveLogin
      login={login}
      everywhere={dialog.kind === "delete" || !vault.profile}
    />
  );
}
