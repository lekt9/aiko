import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Connection } from "@unlock/sdk";
import { api, useAction, useWorkspace } from "../../lib/workspace";
import { DEMO_PASSWORD, useVault } from "../../lib/vault";
import { Avatar, CopyButton, ServiceIcon } from "./primitives";
import { AppsPage } from "../apps-page";

function LoginDetail({ login }: { login: Connection }) {
  const vault = useVault();
  const data = useWorkspace();
  const [show, setShow] = useState(false);
  const favorite = useAction(
    () => api.connections.update(login.id, { favorite: !login.favorite }),
    "",
  );
  const members = data.profiles.filter((p) =>
    p.connectionIds.includes(login.id),
  );
  const sourceProblem = login.status === "source-unavailable";
  const reconnect =
    !login.passwordUnavailable &&
    (sourceProblem || login.status === "challenge");
  return (
    <section className="login-detail" aria-label={`${login.name} details`}>
      <div className="detail-toolbar">
        <button
          className="back-to-list"
          onClick={() => vault.update({ login: undefined })}
        >
          <ArrowLeft size={18} />
          All logins
        </button>
        <span className="detail-type">
          <KeyRound size={15} />
          Login
        </span>
        <div className="detail-tools">
          <button
            className={`icon-button ${login.favorite ? "is-favorite" : ""}`}
            aria-label={login.favorite ? "Remove favorite" : "Add favorite"}
            aria-pressed={!!login.favorite}
            disabled={favorite.isPending}
            onClick={() => favorite.mutate()}
          >
            <Star size={20} fill={login.favorite ? "currentColor" : "none"} />
          </button>
          <details className="login-more">
            <summary aria-label="More login actions">
              <MoreHorizontal size={22} />
            </summary>
            <div className="more-menu">
              <button
                onClick={() => vault.setDialog({ kind: "edit", id: login.id })}
              >
                Edit login
              </button>
              {vault.profile && (
                <button
                  onClick={() =>
                    vault.setDialog({ kind: "remove", id: login.id })
                  }
                >
                  Remove from profile
                </button>
              )}
              <button
                className="danger-text"
                onClick={() =>
                  vault.setDialog({ kind: "delete", id: login.id })
                }
              >
                Delete login
              </button>
            </div>
          </details>
        </div>
      </div>
      <div className="login-identity">
        <ServiceIcon name={login.name} large />
        <h2>{login.name}</h2>
        <span>{login.domain}</span>
      </div>
      {reconnect && (
        <div className="signin-notice">
          <span>
            <strong>
              {sourceProblem
                ? `Reconnect ${login.sourceLabel}`
                : "Sign in again"}
            </strong>
            <small>
              {sourceProblem
                ? "Reconnect your password manager to use this login."
                : "A quick sign-in is needed to use this login again."}
            </small>
          </span>
          {sourceProblem ? (
            <Link
              to="/settings"
              search={vault.search}
              className="button subtle"
            >
              Reconnect
            </Link>
          ) : (
            <button
              className="button subtle"
              onClick={() =>
                vault.setDialog({ kind: "reconnect", id: login.id })
              }
            >
              Sign in
            </button>
          )}
        </div>
      )}
      <div className="credential-fields">
        <div className="credential-field">
          <div>
            <span className="field-label">Website</span>
            <span className="field-value">{login.domain}</span>
          </div>
          <CopyButton value={`https://${login.domain}`} label="website" />
        </div>
        <div className="credential-field">
          <div>
            <span className="field-label">Username</span>
            <span className="field-value">{login.identity}</span>
          </div>
          <CopyButton value={login.identity} label="username" />
        </div>
        {login.passwordUnavailable ? (
          <div className="credential-field">
            <div>
              <span className="field-label">Password</span>
              <span className="field-value">Not imported in this demo</span>
            </div>
          </div>
        ) : login.kind === "session" ? (
          <div className="credential-field">
            <div>
              <span className="field-label">Sign-in method</span>
              <span className="field-value">
                {login.sourceMode === "sso" ? "Google" : "Browser sign-in"}
              </span>
            </div>
            <ShieldCheck size={19} />
          </div>
        ) : (
          <div className="credential-field">
            <div>
              <span className="field-label">Password</span>
              <span className={`field-value ${show ? "revealed" : "masked"}`}>
                {show ? DEMO_PASSWORD : "••••••••••••••"}
              </span>
            </div>
            <div className="field-tools">
              <button
                className="icon-button"
                aria-label={show ? "Hide password" : "Show password"}
                aria-pressed={show}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
              <CopyButton value={DEMO_PASSWORD} label="password" />
            </div>
          </div>
        )}
      </div>
      <section className="available-to">
        <div className="section-heading">
          <h3>Available to</h3>
          <button
            className="text-button"
            onClick={() => vault.setDialog({ kind: "access", id: login.id })}
          >
            Edit access
          </button>
        </div>
        {members.length ? (
          <div className="profile-chips">
            {members.map((p) => (
              <button
                className="profile-chip"
                key={p.id}
                onClick={() => vault.switchProfile(p.id)}
              >
                <Avatar profile={p} small />
                {p.name}
                {!p.enabled && <small>Access off</small>}
              </button>
            ))}
          </div>
        ) : (
          <p>Only you. Add an agent when you’re ready.</p>
        )}
        <p className="access-hint">
          You choose which agents can use this login.
        </p>
      </section>
      <div className="login-footnote">
        <KeyRound size={14} />
        {login.sourceMode === "reference"
          ? `Saved in ${login.sourceLabel}`
          : login.sourceMode === "sso"
            ? "Sign in with Google"
            : "Saved in your vault"}
        <span>· Demo</span>
      </div>
    </section>
  );
}
export function VaultPage() {
  const vault = useVault();
  return vault.search.view === "accounts" || vault.search.login ? (
    <AccountsPage />
  ) : (
    <AppsPage />
  );
}

function AccountsPage() {
  const vault = useVault();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const add = () =>
    vault.setDialog({ kind: vault.profile ? "existing" : "add" });
  return (
    <div className={`vault-page ${vault.search.login ? "show-detail" : ""}`}>
      <header className="vault-header">
        <div>
          <h1>{vault.search.favorites ? "Favorites" : "All logins"}</h1>
          <p>
            {vault.profile
              ? `Logins shared with ${vault.profile.name}.`
              : "Your logins, right where you need them."}
          </p>
        </div>
        <button
          className="button primary"
          onClick={add}
          disabled={vault.invalidProfile}
        >
          <Plus size={18} />
          Add login
        </button>
      </header>
      {vault.invalidProfile ? (
        <div className="empty">
          <h2>Profile not found</h2>
          <p>This profile may have been removed.</p>
          <button className="button" onClick={() => vault.switchProfile()}>
            Back to my vault
          </button>
        </div>
      ) : (
        <>
          {vault.profile && !vault.profile.enabled && (
            <div className="profile-off">
              Access is off for this profile.
              <button
                className="text-button"
                onClick={() =>
                  vault.setDialog({ kind: "profile", id: vault.profile!.id })
                }
              >
                Edit profile
              </button>
            </div>
          )}
          <div className="vault-workspace">
            <section className="login-list-panel" aria-label="Saved logins">
              <label className="login-search">
                <Search size={19} />
                <input
                  ref={searchRef}
                  value={vault.search.q ?? ""}
                  onChange={(e) =>
                    vault.update(
                      { q: e.target.value || undefined, login: undefined },
                      true,
                    )
                  }
                  aria-label="Search logins"
                  placeholder="Search logins"
                />
                {vault.search.q ? (
                  <button
                    className="icon-button"
                    aria-label="Clear search"
                    onClick={() =>
                      vault.update({ q: undefined, login: undefined }, true)
                    }
                  >
                    <X size={16} />
                  </button>
                ) : (
                  <kbd>⌘ K</kbd>
                )}
              </label>
              <div className="list-caption">
                <span>
                  {vault.visible.length}{" "}
                  {vault.visible.length === 1 ? "login" : "logins"}
                </span>
                <span>Name A–Z</span>
              </div>
              <div className="login-list">
                {vault.visible.map((c) => (
                  <button
                    key={c.id}
                    className={`login-row ${vault.selected?.id === c.id ? "selected" : ""}`}
                    aria-label={`Open ${c.name}`}
                    aria-current={
                      vault.selected?.id === c.id ? "true" : undefined
                    }
                    onClick={() => vault.update({ login: c.id })}
                  >
                    <ServiceIcon name={c.name} />
                    <span className="login-row-copy">
                      <strong>
                        {c.name}
                        {c.favorite && (
                          <Star
                            size={12}
                            fill="currentColor"
                            aria-label="Favorite"
                          />
                        )}
                      </strong>
                      <small>{c.identity}</small>
                      {!c.passwordUnavailable &&
                        (c.status === "challenge" ||
                          c.status === "source-unavailable") && (
                          <span className="row-attention">
                            {c.status === "challenge"
                              ? "Sign in again"
                              : `Reconnect ${c.sourceLabel}`}
                          </span>
                        )}
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
                {!vault.visible.length && (
                  <div className="empty list-empty">
                    <KeyRound size={28} />
                    <h2>
                      {vault.search.q
                        ? "No matching logins"
                        : vault.search.favorites
                          ? "No favorites yet"
                          : "Make this vault yours"}
                    </h2>
                    <p>
                      {vault.search.q
                        ? "Try a different name or username."
                        : vault.search.favorites
                          ? "Star a login to keep it close."
                          : vault.profile
                            ? "Choose the logins this agent can use."
                            : "Add a login or bring one from a password manager."}
                    </p>
                    {vault.search.q ? (
                      <button
                        className="text-button"
                        onClick={() => vault.update({ q: undefined })}
                      >
                        Clear search
                      </button>
                    ) : (
                      !vault.search.favorites && (
                        <button className="button" onClick={add}>
                          Add your first login
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
              <button className="list-add" onClick={add}>
                <Plus size={17} />
                {vault.profile ? "Add a login to this profile" : "Add a login"}
              </button>
            </section>
            {vault.selected ? (
              <LoginDetail
                key={`${vault.search.profile ?? "owner"}:${vault.selected.id}`}
                login={vault.selected}
              />
            ) : (
              <section className="detail-empty">
                <KeyRound size={40} />
                <h2>
                  {vault.search.login
                    ? "Login not available here"
                    : "A little less to remember."}
                </h2>
                <p>
                  {vault.search.login
                    ? "Choose another login or switch profiles."
                    : "Choose a login to see its details."}
                </p>
                {vault.search.login && (
                  <button
                    className="button"
                    onClick={() => vault.update({ login: undefined })}
                  >
                    Back to logins
                  </button>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
