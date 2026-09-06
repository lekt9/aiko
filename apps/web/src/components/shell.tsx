import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  KeyRound,
  Grid2X2,
  Plus,
  Settings,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { useWorkspace } from "../lib/workspace";
import { useVault } from "../lib/vault";
import { Avatar } from "./vault/primitives";
import { VaultDialogs } from "./vault/dialogs";

export function Shell({ children }: { children: ReactNode }) {
  const data = useWorkspace();
  const vault = useVault();
  const [picker, setPicker] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const isSettings = useRouterState({
    select: (s) => s.location.pathname === "/settings",
  });
  const name = vault.invalidProfile
    ? "Profile unavailable"
    : (vault.profile?.name ?? "My vault");
  useEffect(() => {
    if (!picker) return;
    const closeOutside = (e: PointerEvent) => {
      if (
        !popover.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setPicker(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPicker(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [picker]);
  const choose = (id?: string) => {
    vault.switchProfile(id);
    setPicker(false);
    trigger.current?.focus();
  };
  return (
    <div className="vault-app">
      <a href="#main" className="skip-link">
        Skip to apps
      </a>
      <aside className="vault-sidebar">
        <Link
          to="/"
          search={{}}
          className="vault-logo"
          aria-label="Aiko by Unbrowse home"
        >
          <span className="aiko-logo-mark" aria-hidden="true">
            a.
          </span>
          <span className="aiko-logo-label">
            Aiko<small>by Unbrowse</small>
          </span>
        </Link>
        <div className="profile-selector">
          <button
            ref={trigger}
            className="profile-trigger"
            aria-expanded={picker}
            aria-controls="profile-list"
            aria-label={`Switch profile: ${name}`}
            onClick={() => setPicker((v) => !v)}
          >
            <Avatar profile={vault.profile} />
            <span>
              <strong>{name}</strong>
              <small>
                {vault.profile ? "Agent profile" : "Your saved logins"}
              </small>
            </span>
            <ChevronDown size={16} />
          </button>
          {picker && (
            <div ref={popover} id="profile-list" className="profile-popover">
              <p className="popover-label">Switch profile</p>
              <button
                className="profile-option"
                aria-pressed={!vault.search.profile}
                onClick={() => choose()}
              >
                <Avatar />
                <span>
                  <strong>My vault</strong>
                  <small>All your saved logins</small>
                </span>
                {!vault.search.profile && <Check size={17} />}
              </button>
              <div className="profile-options">
                {data.profiles.map((p) => (
                  <button
                    className="profile-option"
                    key={p.id}
                    aria-pressed={p.id === vault.search.profile}
                    onClick={() => choose(p.id)}
                  >
                    <Avatar profile={p} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {p.connectionIds.length}{" "}
                        {p.connectionIds.length === 1 ? "login" : "logins"}
                        {!p.enabled ? " · Access off" : ""}
                      </small>
                    </span>
                    {p.id === vault.search.profile && <Check size={17} />}
                  </button>
                ))}
              </div>
              <div className="popover-actions">
                <button
                  onClick={() => {
                    setPicker(false);
                    vault.setDialog({ kind: "profile" });
                  }}
                >
                  <Plus size={18} />
                  New profile
                </button>
                {vault.profile && (
                  <button
                    onClick={() => {
                      setPicker(false);
                      vault.setDialog({
                        kind: "profile",
                        id: vault.profile!.id,
                      });
                    }}
                  >
                    <SlidersHorizontal size={18} />
                    Edit profile
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <nav className="vault-navigation" aria-label="Workspace navigation">
          <Link
            to="/"
            search={{ profile: vault.search.profile }}
            className={
              !isSettings &&
              !vault.search.favorites &&
              !vault.search.view &&
              !vault.search.login
                ? "selected"
                : ""
            }
          >
            <Grid2X2 size={19} />
            Your apps
          </Link>
          <Link
            to="/"
            search={{ profile: vault.search.profile, favorites: true }}
            className={
              !isSettings && vault.search.favorites && !vault.search.view
                ? "selected"
                : ""
            }
          >
            <Star size={19} />
            Favorites
          </Link>
          <Link
            to="/"
            search={{ profile: vault.search.profile, view: "accounts" }}
            className={
              !isSettings &&
              (vault.search.view === "accounts" || vault.search.login)
                ? "selected"
                : ""
            }
          >
            <KeyRound size={19} />
            Accounts & access
          </Link>
          <Link
            to="/settings"
            search={vault.search}
            className={`settings-link ${isSettings ? "selected" : ""}`}
          >
            <Settings size={19} />
            Settings
          </Link>
        </nav>
        <div className="sidebar-foot">
          <span className="demo-label">
            <span />
            Preview{" "}
            <span className="demo-description">· Sample accounts only</span>
          </span>
        </div>
      </aside>
      <main id="main" className="vault-main">
        {children}
      </main>
      <VaultDialogs />
    </div>
  );
}
