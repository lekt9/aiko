import { useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  FileUp,
  Link2,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Unplug,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Profile } from "@unlock/sdk";
import { api, date, useAction, useWorkspace } from "../lib/workspace";
import {
  Empty,
  Modal,
  Notice,
  PageHeader,
  SaveButton,
  ServiceIcon,
} from "./ui";

function ProfileEditor({
  profile,
  close,
}: {
  profile?: Profile;
  close: () => void;
}) {
  const data = useWorkspace();
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [ids, setIds] = useState(profile?.connectionIds ?? []);
  const save = useAction(
    async () =>
      profile
        ? api.profiles.update(profile.id, {
            name,
            description,
            enabled,
            connectionIds: ids,
          })
        : api.profiles.create({ name, description }),
    profile ? "Profile updated" : "Profile created",
  );
  return (
    <Modal
      title={profile ? "Edit agent profile" : "Create agent profile"}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, { onSuccess: close });
        }}
      >
        <label className="field">
          Profile name
          <input
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Release agent"
          />
        </label>
        <label className="field">
          Description
          <input
            required
            maxLength={60}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this agent is here to do"
          />
        </label>
        {profile ? (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>
                <strong>Profile enabled</strong>
                <small>
                  Disabled profiles cannot retrieve or sync sessions.
                </small>
              </span>
            </label>
            <fieldset className="assignment-list">
              <legend>Standing account access</legend>
              {data.connections
                .filter((c) => c.status !== "revoked")
                .map((c) => (
                  <label className="check-row" key={c.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(c.id)}
                      onChange={(e) =>
                        setIds(
                          e.target.checked
                            ? [...ids, c.id]
                            : ids.filter((id) => id !== c.id),
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
            </fieldset>
          </>
        ) : (
          <Notice>
            New profiles start with no account access. Assign accounts after
            creating the profile.
          </Notice>
        )}
        {save.isError && (
          <p role="alert" className="form-error">
            {save.error.message}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <SaveButton pending={save.isPending}>
            {profile ? "Save changes" : "Create profile"}
          </SaveButton>
        </div>
      </form>
    </Modal>
  );
}
export function Agents() {
  const data = useWorkspace();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  return (
    <>
      <PageHeader
        title="Agent profiles"
        description="A clear identity. The right accounts. Standing access."
        action={
          <button className="button primary" onClick={() => setEditing("new")}>
            <Plus size={16} />
            Create profile
          </button>
        }
      />
      <Notice>
        Access is assigned to a profile, not leased to an individual run.
        Disabling a profile blocks future retrieval and sync, but not cookies
        already delivered.
      </Notice>
      <div className="agents-list">
        {data.profiles.map((p) => (
          <section className="panel agent-card" key={p.id}>
            <div className="agent-card-head">
              <span className="agent-symbol">
                <Bot size={24} />
              </span>
              <div>
                <h2>{p.name}</h2>
                <p>{p.description}</p>
              </div>
              <span className={`status ${p.enabled ? "healthy" : "paused"}`}>
                <span className="dot" />
                {p.enabled ? "Enabled" : "Disabled"}
              </span>
              <button className="button" onClick={() => setEditing(p)}>
                <SlidersHorizontal size={15} />
                Edit profile
              </button>
            </div>
            <div className="agent-accounts">
              <span className="eyebrow">STANDING ACCESS</span>
              <div>
                {p.connectionIds.map((id) => {
                  const c = data.connections.find((c) => c.id === id);
                  return c ? (
                    <Link
                      to="/accounts/$id"
                      params={{ id }}
                      key={id}
                      className="assigned-service"
                    >
                      <ServiceIcon name={c.name} />
                      {c.name}
                      <ChevronRight size={13} />
                    </Link>
                  ) : null;
                })}
                {!p.connectionIds.length && (
                  <span className="muted">
                    No accounts assigned. This profile cannot retrieve sessions.
                  </span>
                )}
              </div>
            </div>
            <div className="agent-card-footer">
              <code>profile:{p.id}</code>
              <span>{p.connectionIds.length} assigned accounts</span>
            </div>
          </section>
        ))}
      </div>
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? undefined : editing}
          close={() => setEditing(null)}
        />
      )}
    </>
  );
}
export function Sources() {
  const data = useWorkspace();
  const [disconnect, setDisconnect] = useState<string | null>(null);
  const update = useAction(
    ({ id, connected }: { id: string; connected: boolean }) =>
      api.sources.update(id, connected),
    "Demo source updated",
  );
  return (
    <>
      <PageHeader
        title="Credential sources"
        description="Keep passwords where they belong. Bring access together."
        action={
          <Link to="/connect" className="button primary">
            <Plus size={16} />
            Add account
          </Link>
        }
      />
      <div className="source-explainer">
        <div>
          <FileUp size={21} />
          <h2>Import once</h2>
          <p>
            An independent snapshot in Unlock. Updates in the original vault do
            not sync.
          </p>
        </div>
        <div>
          <Link2 size={21} />
          <h2>Reference a source</h2>
          <p>
            The vault remains authoritative. Selected item references, without a
            password copy by default.
          </p>
        </div>
      </div>
      <div className="sources-list">
        {data.sources.map((s) => (
          <section className="panel source-row" key={s.id}>
            <span className={`source-symbol ${s.id}`}>
              <Unplug size={24} />
            </span>
            <div className="source-body">
              <h2>
                {s.name}
                <span className="demo-chip">
                  {s.id === "nordpass"
                    ? "Unimplemented"
                    : s.kind === "snapshot"
                      ? "Snapshot"
                      : "Demo"}
                </span>
              </h2>
              <p>{s.description}</p>
              <small>
                {
                  data.connections.filter(
                    (c) => c.sourceId === s.id && c.status !== "revoked",
                  ).length
                }{" "}
                accounts ·{" "}
                {s.kind === "sso"
                  ? "Reusable private identity context"
                  : s.kind === "reference"
                    ? "Source references"
                    : "Independent records"}
              </small>
            </div>
            <div className="source-actions">
              {s.kind === "reference" || s.kind === "sso" ? (
                <>
                  <span
                    className={`status ${s.connected ? "healthy" : "paused"}`}
                  >
                    <span className="dot" />
                    {s.connected ? "Demo connected" : "Not connected"}
                  </span>
                  <button
                    className="button"
                    disabled={update.isPending || s.id === "nordpass"}
                    onClick={() =>
                      s.connected
                        ? setDisconnect(s.id)
                        : update.mutate({ id: s.id, connected: true })
                    }
                  >
                    {s.connected
                      ? "Disconnect"
                      : s.id === "nordpass"
                        ? "Not available"
                        : "Connect demo"}
                  </button>
                </>
              ) : (
                <Link to="/connect" className="text-link">
                  Add a fixture
                  <ChevronRight size={15} />
                </Link>
              )}
            </div>
          </section>
        ))}
      </div>
      <Notice>
        <strong>Three different sign-ins.</strong> Owner login authenticates you
        to Unlock. Agent OAuth authenticates a profile to Unlock. Destination
        SSO creates website sessions. None of these are interchangeable.
      </Notice>
      {disconnect && (
        <Modal
          title="Disconnect this source?"
          close={() => setDisconnect(null)}
        >
          <p>
            Dependent accounts will become source unavailable and cannot renew.
            Already-delivered browser cookies may remain valid.
          </p>
          <div className="form-actions">
            <button className="button" onClick={() => setDisconnect(null)}>
              Keep connected
            </button>
            <button
              className="button danger"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: disconnect, connected: false },
                  { onSuccess: () => setDisconnect(null) },
                )
              }
            >
              Disconnect source
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function ActivityPage() {
  const { activity } = useWorkspace();
  const [search, setSearch] = useState("");
  const [tone, setTone] = useState("all");
  const rows = activity.filter(
    (a) =>
      `${a.action} ${a.subject} ${a.detail}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (tone === "all" || a.tone === tone),
  );
  return (
    <>
      <PageHeader
        title="Activity"
        description="Every access change has a trail. Secret values do not."
      />
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activity…"
            aria-label="Search activity"
          />
        </label>
        <select
          aria-label="Activity type"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
        >
          <option value="all">All events</option>
          <option value="success">Success</option>
          <option value="warning">Needs attention</option>
          <option value="neutral">Configuration</option>
        </select>
      </div>
      <div
        className="panel table-scroll"
        role="region"
        aria-label="Activity events"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Subject</th>
              <th>Details</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className={`event-label ${a.tone}`}>
                    <span className="dot" />
                    {a.action}
                  </span>
                </td>
                <td>{a.subject}</td>
                <td className="event-detail">{a.detail}</td>
                <td className="nowrap small">{date(a.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <Empty title="No matching events">
            <button
              className="button"
              onClick={() => {
                setSearch("");
                setTone("all");
              }}
            >
              Clear filters
            </button>
          </Empty>
        )}
      </div>
      <p className="small muted">
        Showing {rows.length} of {activity.length} synthetic events · most
        recent 250 kept in memory.
      </p>
    </>
  );
}
export function SettingsPage() {
  const data = useWorkspace();
  const [name, setName] = useState(data.settings.name);
  const [digest, setDigest] = useState(data.settings.digest);
  const [reset, setReset] = useState(false);
  const save = useAction(
    () => api.settings.update({ name, digest }),
    "Workspace preferences saved",
  );
  const resetAction = useAction(() => api.reset(), "Demo workspace reset");
  return (
    <>
      <PageHeader
        title="Workspace settings"
        description="A few preferences. Clear boundaries."
      />
      <div className="settings-layout">
        <section className="panel">
          <div className="section-head">
            <h2>General</h2>
          </div>
          <form
            className="panel-form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="field">
              Workspace name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={60}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={digest}
                onChange={(e) => setDigest(e.target.checked)}
              />
              <span>
                <strong>Activity digest preference</strong>
                <small>
                  Saved for the demo. Email delivery is not connected.
                </small>
              </span>
            </label>
            {save.isError && (
              <p className="form-error" role="alert">
                {save.error.message}
              </p>
            )}
            <SaveButton pending={save.isPending} />
          </form>
        </section>
        <section className="panel section-gap">
          <div className="section-head">
            <h2>Demo workspace</h2>
            <ShieldCheck size={18} />
          </div>
          <div className="panel-form">
            <p>
              This app uses a shared, process-local synthetic dataset. Changes
              persist across page reloads, but reset when the server restarts.
              Nothing is written to a real vault.
            </p>
            <ul className="boundary-list">
              <li>
                <Check size={15} />
                No real passwords or cookies accepted
              </li>
              <li>
                <Check size={15} />
                No external account logins
              </li>
              <li>
                <Check size={15} />
                No production authorization or encryption
              </li>
            </ul>
            <button className="button danger" onClick={() => setReset(true)}>
              Reset demo workspace
            </button>
          </div>
        </section>
      </div>
      {reset && (
        <Modal title="Reset the demo workspace?" close={() => setReset(false)}>
          <p>
            This removes demo accounts, profile changes, client configurations
            and activity, then restores the original fixtures.
          </p>
          <div className="form-actions">
            <button className="button" onClick={() => setReset(false)}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={resetAction.isPending}
              onClick={() =>
                resetAction.mutate(undefined, {
                  onSuccess: () => {
                    setName("Studio workspace");
                    setDigest(true);
                    setReset(false);
                  },
                })
              }
            >
              Reset everything
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
