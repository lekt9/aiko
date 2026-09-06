import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  KeyRound,
  Pause,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { ConnectionAction } from "@unlock/sdk";
import { api, date, time, useAction, useWorkspace } from "../lib/workspace";
import {
  AccountLink,
  ConnectButton,
  Empty,
  Modal,
  Notice,
  PageHeader,
  ServiceIcon,
  Status,
  statusLabels,
} from "./ui";

export function Overview() {
  const data = useWorkspace();
  const active = data.connections.filter((c) => c.status !== "revoked");
  const healthy = active.filter((c) => c.status === "healthy");
  const attention = active.filter(
    (c) => c.status === "challenge" || c.status === "source-unavailable",
  );
  const enabled = data.profiles.filter((p) => p.enabled);
  return (
    <>
      <PageHeader
        eyebrow="YOUR ACCESS, IN ORDER"
        title="Workspace overview"
        description="The accounts your agents need. Ready when they are."
        action={<ConnectButton />}
      />
      <div className="summary-strip">
        <Link to="/accounts">
          <span>
            Connected accounts
            <KeyRound size={16} />
          </span>
          <strong>{active.length.toString().padStart(2, "0")}</strong>
          <small>
            Across {new Set(active.map((c) => c.sourceId)).size} credential
            sources
          </small>
        </Link>
        <Link to="/sessions">
          <span>
            Healthy sessions
            <ShieldCheck size={17} />
          </span>
          <strong>
            {healthy.length.toString().padStart(2, "0")}
            <em> / {active.length}</em>
          </strong>
          <small>
            <span className="dot positive" />
            Available to assigned profiles
          </small>
        </Link>
        <Link to="/agents">
          <span>
            Active agents
            <Bot size={17} />
          </span>
          <strong>{enabled.length.toString().padStart(2, "0")}</strong>
          <small>Standing access, no per-run prompts</small>
        </Link>
        <Link to="/sessions">
          <span>
            Needs attention
            <TriangleAlert size={17} />
          </span>
          <strong className={attention.length ? "warning-text" : ""}>
            {attention.length.toString().padStart(2, "0")}
          </strong>
          <small>
            {attention.length
              ? "A quick reconnect is needed"
              : "Everything is in order"}
          </small>
        </Link>
      </div>
      {attention.length > 0 && (
        <section className="attention-banner">
          <span className="attention-icon">
            <TriangleAlert size={21} />
          </span>
          <div>
            <strong>{attention[0].name} needs a little attention</strong>
            <p>
              {attention[0].status === "source-unavailable"
                ? "Its credential source is disconnected. Reconnect the source to continue."
                : "A sign-in challenge is waiting. Reconnect to keep your agent moving."}
            </p>
          </div>
          <Link
            to="/accounts/$id"
            params={{ id: attention[0].id }}
            className="button warning-button"
          >
            Review account
            <ArrowRight size={15} />
          </Link>
        </section>
      )}
      <div className="overview-grid">
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>
                Your accounts<span className="count-pill">{active.length}</span>
              </h2>
              <p>One place for passwords and maintained sessions.</p>
            </div>
            <Link to="/accounts" className="text-link">
              View all
              <ArrowUpRight size={14} />
            </Link>
          </div>
          <div className="compact-table">
            <div className="compact-head">
              <span>ACCOUNT</span>
              <span>SESSION HEALTH</span>
            </div>
            {active.slice(0, 5).map((c) => (
              <div className="compact-row" key={c.id}>
                <AccountLink connection={c} />
                <Status status={c.status} />
              </div>
            ))}
            {!active.length && (
              <Empty title="Connect your first account">
                <ConnectButton />
              </Empty>
            )}
          </div>
          <Link to="/connect" className="panel-bottom-link">
            <Plus size={16} />
            Connect another account
            <ArrowRight size={15} />
          </Link>
        </section>
        <section className="panel activity-panel">
          <div className="section-head">
            <div>
              <h2>Latest activity</h2>
              <p>A clear trail. Without the secrets.</p>
            </div>
            <Link
              to="/activity"
              className="text-link"
              aria-label="View all activity"
            >
              <ArrowUpRight size={17} />
            </Link>
          </div>
          <div className="timeline">
            {data.activity.slice(0, 4).map((a) => (
              <div className="timeline-item" key={a.id}>
                <span className={`timeline-marker ${a.tone}`}>
                  {a.tone === "warning" ? (
                    <TriangleAlert size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                </span>
                <div>
                  <strong>{a.action}</strong>
                  <p>
                    {a.subject} <span>· {time(a.at)}</span>
                  </p>
                  <small>{a.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="runtime-strip">
        <div className="runtime-symbol">
          <ShieldCheck size={28} />
        </div>
        <div>
          <h2>Your browser. Your agents. Less signing in.</h2>
          <p>
            Unlock prepares destination sessions for a trusted wrapper around
            your existing browser tools.
          </p>
        </div>
        <Link to="/developers" className="text-link">
          Explore the SDK
          <ArrowRight size={15} />
        </Link>
      </section>
      <div className="section-head below">
        <h2>Agent profiles</h2>
        <Link to="/agents" className="text-link">
          Manage profiles
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <div className="profile-strip">
        {data.profiles.map((p) => (
          <Link to="/agents" className="profile-preview" key={p.id}>
            <span className="agent-symbol">
              <Bot size={20} />
            </span>
            <div>
              <strong>{p.name}</strong>
              <small>
                {p.connectionIds.length} accounts assigned ·{" "}
                {p.enabled ? "Enabled" : "Disabled"}
              </small>
            </div>
            <ChevronRight size={16} />
          </Link>
        ))}
      </div>
    </>
  );
}

export function Accounts() {
  const { connections, profiles } = useWorkspace();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const rows = connections
    .filter(
      (c) =>
        `${c.name} ${c.identity} ${c.sourceLabel}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (filter === "all"
          ? c.status !== "revoked"
          : filter === "attention"
            ? ["challenge", "source-unavailable"].includes(c.status)
            : c.status === filter),
    )
    .sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b.revision - a.revision,
    );
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Passwords, sessions, and the agents that can use them."
        action={<ConnectButton />}
      />
      <div className="tabs">
        {[
          ["all", "All accounts"],
          ["healthy", "Healthy"],
          ["attention", "Needs attention"],
          ["revoked", "Revoked"],
        ].map(([v, l]) => (
          <button
            className={filter === v ? "active" : ""}
            onClick={() => setFilter(v)}
            key={v}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="Search accounts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts, identities, sources…"
          />
        </label>
        <select
          aria-label="Sort accounts"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="name">Name A–Z</option>
          <option value="revision">Latest revision</option>
        </select>
        <span className="muted small">{rows.length} accounts</span>
      </div>
      <div
        className="panel table-scroll"
        role="region"
        aria-label="Connected accounts"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Credentials</th>
              <th>Source</th>
              <th>Session</th>
              <th>Agents</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <AccountLink connection={c} />
                </td>
                <td>
                  <span className="credential-tag">
                    <KeyRound size={13} />
                    {c.kind === "both"
                      ? "Password + session"
                      : c.kind === "password"
                        ? "Password"
                        : "Session"}
                  </span>
                </td>
                <td>
                  {c.sourceLabel}
                  <small>
                    {c.sourceMode === "reference"
                      ? "Live reference · demo"
                      : c.sourceMode === "snapshot"
                        ? "Independent snapshot"
                        : c.sourceMode === "sso"
                          ? "Destination session"
                          : "Native fixture"}
                  </small>
                </td>
                <td>
                  <Status status={c.status} />
                </td>
                <td>
                  <span className="assignment-count">
                    <Bot size={15} />
                    {
                      profiles.filter((p) => p.connectionIds.includes(c.id))
                        .length
                    }
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <Empty title="No accounts match">
            <p>Try another search or connect a synthetic account.</p>
            <button
              className="button"
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              Clear filters
            </button>
          </Empty>
        )}
      </div>
      <Notice>
        Only metadata appears here. Passwords and cookie values never enter this
        management interface.
      </Notice>
    </>
  );
}

export function ConnectionDetail({ id }: { id: string }) {
  const data = useWorkspace();
  const c = data.connections.find((c) => c.id === id);
  const [confirm, setConfirm] = useState(false);
  const action = useAction(
    (value: ConnectionAction) => api.connections.action(id, value),
    "Account updated",
  );
  const assignment = useAction(
    ({ profileId, ids }: { profileId: string; ids: string[] }) =>
      api.profiles.update(profileId, { connectionIds: ids }),
    "Standing access updated",
  );
  if (!c)
    return (
      <Empty title="Account not found">
        <Link to="/accounts" className="button">
          Back to accounts
        </Link>
      </Empty>
    );
  const events = data.activity.filter((a) => a.subject === c.name);
  return (
    <>
      <Link to="/accounts" className="back-link">
        ← All accounts
      </Link>
      <div className="detail-header">
        <ServiceIcon name={c.name} large />
        <div>
          <h1>{c.name}</h1>
          <p>{c.identity}</p>
        </div>
        <Status status={c.status} />
      </div>
      {c.status === "challenge" && (
        <Notice warning>
          <strong>A sign-in challenge needs your attention.</strong>
          <p>
            Renewal is waiting. Use the synthetic recovery flow; no real sign-in
            is performed.
          </p>
          <Link
            to="/connect"
            search={{ recover: id }}
            className="button warning-button"
          >
            Reconnect demo session
            <ArrowRight size={15} />
          </Link>
        </Notice>
      )}
      {c.status === "source-unavailable" && (
        <Notice warning>
          <strong>The source is disconnected.</strong>
          <p>Reconnect the source, then recover this destination session.</p>
          <Link to="/sources" className="text-link">
            Manage sources →
          </Link>
        </Notice>
      )}
      <div className="detail-grid">
        <div>
          <section className="panel">
            <div className="section-head">
              <h2>Session health</h2>
              <span className="revision">
                REV {c.revision.toString().padStart(3, "0")}
              </span>
            </div>
            <div className="health-summary">
              <div className={`health-orbit ${c.status}`}>
                <ShieldCheck size={32} />
              </div>
              <div>
                <h3>{statusLabels[c.status]}</h3>
                <p>
                  {c.maintenance
                    ? "Maintenance enabled · demo simulation"
                    : "Maintenance stopped"}
                </p>
              </div>
            </div>
            <dl className="facts">
              <div>
                <dt>Last verified</dt>
                <dd>{date(c.verifiedAt)}</dd>
              </div>
              <div>
                <dt>Session expiry</dt>
                <dd>{date(c.expiresAt)}</dd>
              </div>
              <div>
                <dt>Renewal recipe</dt>
                <dd>{c.recipe}</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>
                  <code>{c.domain}</code>
                </dd>
              </div>
            </dl>
            {c.status !== "revoked" && (
              <div className="panel-actions">
                <button
                  className="button"
                  disabled={
                    action.isPending ||
                    ["challenge", "source-unavailable"].includes(c.status)
                  }
                  onClick={() => action.mutate("refresh")}
                >
                  <RefreshCw size={15} />
                  {action.isPending ? "Updating…" : "Simulate refresh"}
                </button>
                <button
                  className="button"
                  disabled={
                    action.isPending || c.status === "source-unavailable"
                  }
                  onClick={() =>
                    action.mutate(c.maintenance ? "pause" : "resume")
                  }
                >
                  <Pause size={15} />
                  {c.maintenance ? "Pause" : "Resume"}
                </button>
                {c.status === "healthy" && (
                  <button
                    className="text-link"
                    disabled={action.isPending}
                    onClick={() => action.mutate("challenge")}
                  >
                    Simulate challenge
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="panel section-gap">
            <div className="section-head">
              <h2>Session history</h2>
              <Clock3 size={17} />
            </div>
            <div className="timeline">
              {events.map((a) => (
                <div className="timeline-item" key={a.id}>
                  <span className={`timeline-marker ${a.tone}`}>
                    <CheckCheck size={14} />
                  </span>
                  <div>
                    <strong>{a.action}</strong>
                    <p>{a.detail}</p>
                    <small>{date(a.at)}</small>
                  </div>
                </div>
              ))}
              {!events.length && <Empty title="No history yet" />}
            </div>
          </section>
        </div>
        <div>
          <section className="panel">
            <div className="section-head">
              <h2>Standing access</h2>
              <Bot size={18} />
            </div>
            <p className="panel-description">
              Assigned profiles can retrieve this session without asking on
              every run.
            </p>
            <div className="assignment-list">
              {data.profiles.map((p) => (
                <label className="check-row" key={p.id}>
                  <input
                    type="checkbox"
                    checked={p.connectionIds.includes(id)}
                    disabled={assignment.isPending || c.status === "revoked"}
                    onChange={(e) =>
                      assignment.mutate({
                        profileId: p.id,
                        ids: e.target.checked
                          ? [...p.connectionIds, id]
                          : p.connectionIds.filter((i) => i !== id),
                      })
                    }
                  />
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.enabled ? "Enabled" : "Disabled · no runtime access"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </section>
          <section className="panel section-gap">
            <div className="section-head">
              <h2>Credential source</h2>
              <KeyRound size={17} />
            </div>
            <dl className="facts">
              <div>
                <dt>Source</dt>
                <dd>{c.sourceLabel}</dd>
              </div>
              <div>
                <dt>Storage model</dt>
                <dd>{c.sourceMode}</dd>
              </div>
              <div>
                <dt>Credentials</dt>
                <dd>{c.kind === "both" ? "Password + session" : c.kind}</dd>
              </div>
            </dl>
            <p className="panel-description">
              {c.sourceMode === "reference"
                ? "Selected item reference. No persistent password copy by default."
                : c.sourceMode === "snapshot"
                  ? "An independent imported snapshot. The original vault no longer controls this record."
                  : c.sourceMode === "sso"
                    ? "Only destination cookies go to task browsers. The parent identity context stays private."
                    : "Synthetic native record. Production encryption is not connected."}
            </p>
          </section>
          <section className="danger-zone section-gap">
            <h3>Revoke Unlock access</h3>
            <p>
              Stops future retrieval and sync. Cookies already delivered may
              remain valid until the provider expires or invalidates them.
            </p>
            <button
              className="button danger"
              disabled={c.status === "revoked" || action.isPending}
              onClick={() => setConfirm(true)}
            >
              {c.status === "revoked" ? "Access revoked" : "Revoke access"}
            </button>
          </section>
        </div>
      </div>
      {confirm && (
        <Modal
          title={`Revoke access to ${c.name}?`}
          close={() => setConfirm(false)}
        >
          <p>
            All standing assignments for this account will be removed. This does
            not log out browsers that already received a session.
          </p>
          <div className="form-actions">
            <button className="button" onClick={() => setConfirm(false)}>
              Keep access
            </button>
            <button
              className="button danger"
              disabled={action.isPending}
              onClick={() =>
                action.mutate("revoke", { onSuccess: () => setConfirm(false) })
              }
            >
              Confirm revocation
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function Sessions() {
  const { connections } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const action = useAction(
    ({ id, action }: { id: string; action: ConnectionAction }) =>
      api.connections.action(id, action),
    "Session updated",
  );
  const rows = connections.filter((c) =>
    filter === "all" ? c.status !== "revoked" : c.status === filter,
  );
  return (
    <>
      <PageHeader
        title="Sessions"
        description="Watch session health. Handle the exceptions, not every sign-in."
      />
      <Notice>
        Renewals are manually simulated in this demo. Production maintenance
        will serialize provider-specific refresh and login recipes.
      </Notice>
      <div className="toolbar">
        <label>
          Status{" "}
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter sessions"
          >
            <option value="all">All active sessions</option>
            {Object.entries(statusLabels).map(([s, l]) => (
              <option key={s} value={s}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <span className="small muted">{rows.length} sessions</span>
      </div>
      <div className="session-list">
        {rows.map((c) => (
          <section className="panel session-row" key={c.id}>
            <div>
              <AccountLink connection={c} />
              <Status status={c.status} />
            </div>
            <dl>
              <div>
                <dt>Revision</dt>
                <dd className="mono">
                  {c.revision.toString().padStart(3, "0")}
                </dd>
              </div>
              <div>
                <dt>Verified</dt>
                <dd>{time(c.verifiedAt)}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{date(c.expiresAt)}</dd>
              </div>
              <div>
                <dt>Maintenance</dt>
                <dd>{c.maintenance ? "Enabled" : "Paused"}</dd>
              </div>
            </dl>
            <div className="session-actions">
              {c.status === "challenge" ? (
                <Link
                  to="/connect"
                  search={{ recover: c.id }}
                  className="button warning-button"
                >
                  Recover session
                  <ArrowRight size={14} />
                </Link>
              ) : c.status === "source-unavailable" ? (
                <Link to="/sources" className="button">
                  Reconnect source
                </Link>
              ) : (
                c.status !== "revoked" && (
                  <>
                    <button
                      className="button"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({ id: c.id, action: "refresh" })
                      }
                    >
                      <RefreshCw size={14} />
                      Refresh
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`${c.maintenance ? "Pause" : "Resume"} ${c.name}`}
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({
                          id: c.id,
                          action: c.maintenance ? "pause" : "resume",
                        })
                      }
                    >
                      <Pause size={16} />
                    </button>
                  </>
                )
              )}
            </div>
          </section>
        ))}
        {!rows.length && <Empty title="No sessions in this state" />}
      </div>
    </>
  );
}
