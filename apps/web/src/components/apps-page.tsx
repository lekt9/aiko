import { useEffect, useRef } from "react";
import { AIKO_TELEGRAM_URL } from "../lib/telegram";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Grid2X2,
  MessageCircle,
  Plus,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { useVault } from "../lib/vault";
import { useWorkspace } from "../lib/workspace";
import {
  appSuggestions,
  groupApps,
  maskIdentity,
  type AppGroup,
} from "../lib/apps";
import { ServiceIcon } from "./ui";

function AppAccess({ app }: { app: AppGroup }) {
  const vault = useVault();
  const data = useWorkspace();
  return (
    <section
      className="app-access"
      aria-label={`${app.name} capabilities and accounts`}
    >
      <button
        className="text-button"
        onClick={() => vault.update({ app: undefined })}
      >
        <ArrowLeft size={17} /> Your apps
      </button>
      <div className="app-access-identity">
        <ServiceIcon name={app.name} large />
        <div>
          <p className="aiko-eyebrow">APP & ACCESS</p>
          <h2>{app.name}</h2>
          <p>{app.domain}</p>
        </div>
      </div>
      <div className="app-access-section">
        <h3>What could Aiko help with?</h3>
        <a className="app-suggestion" href={AIKO_TELEGRAM_URL} rel="noreferrer">
          <MessageCircle size={19} />
          <span>
            {appSuggestions[app.domain] ?? `Find information in ${app.name}.`}
          </span>
          <ArrowUpRight size={17} />
        </a>
        <p className="aiko-fineprint">
          Example request, not a connected capability. Real app execution is not
          enabled in this demo.
        </p>
      </div>
      <div className="app-access-section">
        <div className="app-section-heading">
          <h3>Accounts & access</h3>
          <span>
            {app.accounts.length}{" "}
            {app.accounts.length === 1 ? "account" : "accounts"}
          </span>
        </div>
        <p className="aiko-fineprint">
          See each identity, its sign-in method, and who can use it.
        </p>
        <div className="app-accounts">
          {app.accounts.map((account) => {
            const profiles = data.profiles.filter((p) =>
              p.connectionIds.includes(account.id),
            );
            return (
              <button
                className="app-account"
                key={account.id}
                onClick={() =>
                  vault.update({
                    view: "accounts",
                    login: account.id,
                    app: undefined,
                    q: undefined,
                    favorites: undefined,
                  })
                }
                aria-label={`Inspect account ${account.identity}`}
              >
                <span className="app-account-avatar" aria-hidden="true">
                  {account.identity.slice(0, 1).toUpperCase()}
                </span>
                <span className="app-account-copy">
                  <strong>{maskIdentity(account.identity)}</strong>
                  <small>
                    {account.sourceMode === "sso"
                      ? "Single sign-on"
                      : account.kind === "session"
                        ? "Browser sign-in"
                        : account.sourceLabel}
                    {account.passwordUnavailable ? " · Metadata only" : ""}
                  </small>
                  <small>
                    {profiles.length
                      ? profiles
                          .map(
                            (p) => `${p.name}${p.enabled ? "" : " (paused)"}`,
                          )
                          .join(" · ")
                      : "Only you"}
                  </small>
                  <small>
                    Last checked:{" "}
                    {Number.isNaN(Date.parse(account.verifiedAt))
                      ? "Not verified"
                      : new Date(account.verifiedAt)
                          .toISOString()
                          .slice(0, 10)}{" "}
                    · sample
                  </small>
                  <span className={`app-account-status ${account.status}`}>
                    {account.status === "paused"
                      ? "Access paused"
                      : account.status === "challenge" ||
                          account.status === "source-unavailable"
                        ? "Needs you"
                        : account.passwordUnavailable
                          ? "Not verified"
                          : "Ready · sample"}
                  </span>
                </span>
                <ChevronRight size={18} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="app-access-foot">
        <ShieldCheck size={19} />
        <p>
          A saved login is not permission to act. You choose access;
          consequential actions will need separate approval.
        </p>
      </div>
    </section>
  );
}

export function AppsPage() {
  const vault = useVault();
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = groupApps(vault.inProfile, {
    query: vault.search.q,
    favorites: vault.search.favorites,
    paused: !!vault.profile && !vault.profile.enabled,
  });
  const selected = groups.find((app) => app.id === vault.search.app);
  const all = groupApps(vault.inProfile);
  const add = () =>
    vault.setDialog({ kind: vault.profile ? "existing" : "add" });
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
  return (
    <div className={`apps-page ${selected ? "has-app-selection" : ""}`}>
      <header className="apps-header">
        <div>
          <p className="aiko-eyebrow">A LITTLE LESS TO DO.</p>
          <h1>{vault.search.favorites ? "Your favorites" : "Your apps"}</h1>
          <p>
            {vault.profile
              ? `Apps shared with ${vault.profile.name}.`
              : "The familiar apps. A little more possible."}
          </p>
        </div>
        <button
          className="button primary"
          onClick={add}
          disabled={vault.invalidProfile}
        >
          <Plus size={18} /> Add app
        </button>
      </header>
      <div className="aiko-demo-notice">
        <span className="aiko-demo-dot" />
        <span>Preview workspace · sample accounts only</span>
      </div>
      {vault.invalidProfile ? (
        <div className="empty">
          <h2>Profile not found</h2>
          <p>This profile may have been removed.</p>
          <button className="button" onClick={() => vault.switchProfile()}>
            Back to my apps
          </button>
        </div>
      ) : (
        <>
          {vault.profile && !vault.profile.enabled && (
            <div className="profile-off">
              Access is paused for this profile.
              <button
                className="text-button"
                onClick={() =>
                  vault.setDialog({ kind: "profile", id: vault.profile!.id })
                }
              >
                Edit access
              </button>
            </div>
          )}
          <div className="apps-workspace">
            <section className="app-drawer-panel" aria-label="Your app drawer">
              <label className="login-search app-search">
                <Search size={19} />
                <input
                  ref={searchRef}
                  type="search"
                  value={vault.search.q ?? ""}
                  onChange={(e) =>
                    vault.update(
                      { q: e.target.value || undefined, app: undefined },
                      true,
                    )
                  }
                  aria-label="Search apps or accounts"
                  placeholder="Search apps or accounts"
                />
                {vault.search.q ? (
                  <button
                    className="icon-button"
                    aria-label="Clear search"
                    onClick={() =>
                      vault.update({ q: undefined, app: undefined }, true)
                    }
                  >
                    <X size={17} />
                  </button>
                ) : (
                  <kbd>⌘ K</kbd>
                )}
              </label>
              <div className="app-section-heading drawer-caption">
                <span>
                  {groups.length} {groups.length === 1 ? "app" : "apps"}
                </span>
                <span>Favorites first</span>
              </div>
              <div className="app-drawer">
                {groups.map((app) => (
                  <button
                    key={app.id}
                    className={`app-tile ${app.id === selected?.id ? "selected" : ""}`}
                    aria-label={`Open ${app.name}, ${app.accounts.length} ${app.accounts.length === 1 ? "account" : "accounts"}`}
                    aria-pressed={app.id === selected?.id}
                    onClick={() =>
                      vault.update({ app: app.id, login: undefined })
                    }
                  >
                    <span className="app-tile-icon">
                      <ServiceIcon name={app.name} large />
                      {app.favorite && (
                        <Star
                          className="app-favorite"
                          size={14}
                          fill="currentColor"
                          aria-label="Favorite"
                        />
                      )}
                    </span>
                    <strong>{app.name}</strong>
                    <small>
                      {app.accounts.length}{" "}
                      {app.accounts.length === 1 ? "account" : "accounts"}
                    </small>
                    <span
                      className={`app-state state-${app.status.toLowerCase().replaceAll(" ", "-")}`}
                    >
                      {app.status}
                    </span>
                  </button>
                ))}
                {!vault.search.q && !vault.search.favorites && (
                  <button className="app-tile add-app-tile" onClick={add}>
                    <span className="add-app-icon">
                      <Plus size={27} />
                    </span>
                    <strong>Add app</strong>
                    <small>You choose access</small>
                  </button>
                )}
              </div>
              {!groups.length && (
                <div className="empty app-drawer-empty">
                  <Grid2X2 size={30} />
                  <h2>
                    {vault.search.q
                      ? "No matching apps"
                      : vault.search.favorites
                        ? "No favorites yet"
                        : "Make this space yours"}
                  </h2>
                  <p>
                    {vault.search.q
                      ? "Try an app name or account identity."
                      : vault.search.favorites
                        ? "Star an account in Accounts & access to keep its app close."
                        : "Add a sample app to explore how access works."}
                  </p>
                  {vault.search.q && (
                    <button
                      className="text-button"
                      onClick={() => vault.update({ q: undefined }, true)}
                    >
                      Show all apps
                    </button>
                  )}
                </div>
              )}
              <div className="drawer-permission">
                <ShieldCheck size={21} />
                <p>
                  Your apps. Your say.
                  <br />
                  <span>Choose the accounts Aiko can use.</span>
                </p>
              </div>
              <button
                className="app-all-accounts"
                onClick={() =>
                  vault.update({
                    view: "accounts",
                    app: undefined,
                    q: undefined,
                    favorites: undefined,
                  })
                }
              >
                <span>
                  Accounts & access{" "}
                  <small>
                    {all.reduce((n, a) => n + a.accounts.length, 0)} saved
                    identities
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            </section>
            {selected ? (
              <AppAccess app={selected} />
            ) : vault.search.app ? (
              <section className="aiko-invitation">
                <h2>App not available here</h2>
                <p>It may have been removed or hidden by this profile.</p>
                <button
                  className="button"
                  onClick={() => vault.update({ app: undefined })}
                >
                  Back to your apps
                </button>
              </section>
            ) : (
              <aside className="aiko-invitation" aria-label="Meet Aiko">
                <span className="aiko-monogram" aria-hidden="true">
                  a.
                </span>
                <p className="aiko-eyebrow">MEET YOUR ASSISTANT</p>
                <h2>
                  Less switching.
                  <br />
                  More getting things done.
                </h2>
                <p>
                  Ask Aiko in a conversation. Your apps stay familiar, and you
                  stay in control.
                </p>
                <div className="aiko-example">
                  <span>You, to Aiko</span>
                  <p>“What needs my attention today?”</p>
                </div>
                <a
                  className="button primary"
                  href={AIKO_TELEGRAM_URL}
                  rel="noreferrer"
                >
                  <MessageCircle size={18} aria-hidden="true" /> Open Aiko in
                  Telegram
                </a>
                <p className="aiko-fineprint">
                  Your chat opens in Telegram, not here. Each Telegram account
                  has its own conversation and memory. App access is still a
                  preview.
                </p>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}
