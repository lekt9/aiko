import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  FileUp,
  Fingerprint,
  KeyRound,
  Link2,
  ShieldCheck,
} from "lucide-react";
import type { ConnectInput } from "@unlock/sdk";
import { api, useAction, useWorkspace } from "../lib/workspace";
import { Empty, Notice, ServiceIcon } from "./ui";
const modes = [
  {
    id: "native",
    icon: KeyRound,
    title: "Password & session",
    description: "A native account, ready for maintained sign-in.",
  },
  {
    id: "session",
    icon: Fingerprint,
    title: "Existing session",
    description: "Start with a session from a trusted browser.",
  },
  {
    id: "import",
    icon: FileUp,
    title: "One-time import",
    description: "An independent snapshot from a password export.",
  },
  {
    id: "reference",
    icon: Link2,
    title: "Password manager",
    description: "Keep the password in its source vault.",
  },
  {
    id: "sso",
    icon: ShieldCheck,
    title: "Sign in with SSO",
    description: "Use a private identity context for a destination.",
  },
] as const;
const samples = [
  { id: "vercel", name: "Vercel", identity: "deploy@studio.example" },
  { id: "github", name: "GitHub", identity: "developer@studio.example" },
  { id: "linear", name: "Linear", identity: "product@studio.example" },
  { id: "notion", name: "Notion", identity: "team@studio.example" },
  { id: "figma", name: "Figma", identity: "design@studio.example" },
] as const;
export function Connect({ recover }: { recover?: string }) {
  const data = useWorkspace();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<ConnectInput["mode"]>("native");
  const [fixture, setFixture] = useState<ConnectInput["fixture"]>("vercel");
  const [profiles, setProfiles] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [connectedId, setConnectedId] = useState("");
  const connect = useAction(
    (input: ConnectInput) => api.connections.connect(input),
    "Demo account connected",
  );
  const recovery = useAction(
    (id: string) => api.connections.action(id, "recover"),
    "Demo session recovered",
  );
  const current = data.connections.find((c) => c.id === recover);
  const duplicate = data.connections.some(
    (c) => c.name.toLowerCase() === fixture && c.status !== "revoked",
  );
  const selected = samples.find((s) => s.id === fixture)!;
  const sourceId =
    mode === "sso"
      ? "google"
      : mode === "reference"
        ? "onepassword"
        : undefined;
  const sourceUnavailable =
    sourceId && !data.sources.find((s) => s.id === sourceId)?.connected;
  if (recover && !current)
    return (
      <Empty title="Session not found">
        <Link to="/accounts">Return to accounts</Link>
      </Empty>
    );
  if (done)
    return (
      <div className="connect-card completion">
        <span className="completion-mark">
          <CheckCircle2 size={36} />
        </span>
        <div className="eyebrow">YOU’RE ALL SET</div>
        <h1>{recover ? "Session ready again." : "One less sign-in."}</h1>
        <p>
          {recover
            ? `${current?.name} has a new synthetic session revision.`
            : `${selected.name} is connected to ${profiles.length} agent ${profiles.length === 1 ? "profile" : "profiles"}.`}
        </p>
        <Notice>
          This was a demo connection. No real credentials were collected and no
          external service was contacted.
        </Notice>
        <Link
          to="/accounts/$id"
          params={{ id: recover ?? connectedId }}
          className="button primary full"
        >
          View account
          <ArrowRight size={16} />
        </Link>
        <Link to="/accounts" className="text-link">
          Back to all accounts
        </Link>
      </div>
    );
  if (recover && current)
    return (
      <div className="connect-card">
        <Link to="/accounts/$id" params={{ id: recover }} className="back-link">
          <ArrowLeft size={14} />
          Back to account
        </Link>
        <ServiceIcon name={current.name} large />
        <h1>Let’s reconnect {current.name}.</h1>
        <p>
          Recover a destination session without sharing its parent SSO context
          or asking agents for passwords.
        </p>
        <Notice warning>
          <strong>Demo challenge recovery</strong>
          <p>
            This simulates completing an MFA challenge. Production recovery must
            use an owner-controlled, private sign-in flow.
          </p>
        </Notice>
        <dl className="facts">
          <div>
            <dt>Account</dt>
            <dd>{current.identity}</dd>
          </div>
          <div>
            <dt>Current revision</dt>
            <dd>{current.revision}</dd>
          </div>
          <div>
            <dt>Next revision</dt>
            <dd>{current.revision + 1}</dd>
          </div>
        </dl>
        {recovery.isError && (
          <p role="alert" className="form-error">
            {recovery.error.message}
          </p>
        )}
        <button
          className="button primary full"
          disabled={recovery.isPending || current.status === "revoked"}
          onClick={() =>
            recovery.mutate(recover, { onSuccess: () => setDone(true) })
          }
        >
          {recovery.isPending ? "Recovering…" : "Complete demo recovery"}
          <ArrowRight size={16} />
        </button>
      </div>
    );
  return (
    <>
      <div className="connect-progress" aria-label={`Step ${step + 1} of 3`}>
        {["Connection method", "Sample account", "Agent access"].map(
          (label, i) => (
            <span className={step >= i ? "current" : ""} key={label}>
              <b>{step > i ? <Check size={12} /> : i + 1}</b>
              {label}
            </span>
          ),
        )}
      </div>
      <div className="connect-card">
        <button
          className="back-link"
          onClick={() =>
            step > 0 ? setStep(step - 1) : location.assign("/accounts")
          }
        >
          <ArrowLeft size={14} />
          {step ? "Back" : "Cancel"}
        </button>
        <div className="eyebrow">CONNECT AN ACCOUNT</div>
        <h1>
          {step === 0
            ? "Make yourself at home."
            : step === 1
              ? "Start with a sample."
              : "Who can use this account?"}
        </h1>
        <p>
          {step === 0
            ? "Bring an account your agents need. Choose how you’d like to connect it."
            : step === 1
              ? "Try the complete flow without entering a real password, cookie, or vault token."
              : "Give profiles standing access. No approval prompt on every run."}
        </p>
        {step === 0 && (
          <div className="connection-options">
            {modes.map((m) => (
              <button
                className={`connection-option ${mode === m.id ? "selected" : ""}`}
                key={m.id}
                onClick={() => {
                  setMode(m.id);
                  setStep(1);
                }}
              >
                <span className="option-icon">
                  <m.icon size={21} />
                </span>
                <span>
                  <strong>{m.title}</strong>
                  <small>{m.description}</small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <>
            <div className="selected-method">
              <KeyRound size={16} />
              {modes.find((m) => m.id === mode)?.title}
              <span className="demo-chip">Demo</span>
            </div>
            <Notice>
              {mode === "import"
                ? "Sample export preview. Select one record to import; existing accounts are skipped. Imported snapshots do not sync with the original vault."
                : mode === "reference"
                  ? "Simulated 1Password item selection. No real vault is connected. Only a selected item reference is modeled."
                  : mode === "sso"
                    ? "Simulated Google parent context → separate destination session. Google API tokens are not browser cookies."
                    : "Use an obviously synthetic fixture. Real credential entry is intentionally unavailable in this prototype."}
            </Notice>
            <fieldset className="fixture-list">
              <legend>Sample accounts</legend>
              {samples.map((s) => {
                const exists = data.connections.some(
                  (c) => c.name === s.name && c.status !== "revoked",
                );
                return (
                  <label
                    className={`fixture-row ${exists ? "disabled" : ""}`}
                    key={s.id}
                  >
                    <input
                      type="radio"
                      name="fixture"
                      disabled={exists}
                      checked={fixture === s.id}
                      onChange={() => setFixture(s.id)}
                    />
                    <ServiceIcon name={s.name} />
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.identity}</small>
                    </span>
                    {exists && (
                      <small className="duplicate-label">
                        Already connected
                      </small>
                    )}
                  </label>
                );
              })}
            </fieldset>
            {sourceUnavailable && (
              <p className="form-error" role="alert">
                This demo source is disconnected.{" "}
                <Link to="/sources">Reconnect the source first.</Link>
              </p>
            )}
            <button
              className="button primary full"
              disabled={duplicate || !!sourceUnavailable}
              onClick={() => setStep(2)}
            >
              Continue with {selected.name}
              <ArrowRight size={16} />
            </button>
            {duplicate && (
              <p className="small muted">
                All selected records already exist. Revoke a sample account to
                reconnect it, or reset the demo.
              </p>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <div className="connect-account-preview">
              <ServiceIcon name={selected.name} />
              <div>
                <strong>{selected.name}</strong>
                <small>{selected.identity}</small>
              </div>
              <CheckCircle2 size={18} />
            </div>
            <fieldset className="assignment-list">
              <legend>Assign agent profiles</legend>
              {data.profiles.map((p) => (
                <label className="check-row" key={p.id}>
                  <input
                    type="checkbox"
                    checked={profiles.includes(p.id)}
                    onChange={(e) =>
                      setProfiles(
                        e.target.checked
                          ? [...profiles, p.id]
                          : profiles.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <Bot size={18} />
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.enabled
                        ? p.description
                        : "Disabled · assignment saved for later"}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="small muted">
              {profiles.length === 0
                ? "No profiles selected. You can assign access later."
                : `${profiles.length} standing assignments. You can change these anytime.`}
            </p>
            {connect.isError && (
              <p className="form-error" role="alert">
                {connect.error.message}
              </p>
            )}
            <button
              className="button primary full"
              disabled={connect.isPending}
              onClick={() =>
                connect.mutate(
                  { fixture, mode, profileIds: profiles },
                  {
                    onSuccess: (result) => {
                      setConnectedId(result.id);
                      setDone(true);
                    },
                  },
                )
              }
            >
              {connect.isPending ? "Connecting…" : "Connect demo account"}
              <ArrowRight size={16} />
            </button>
          </>
        )}
        <p className="connect-trust">
          <ShieldCheck size={14} />
          Synthetic fixtures only. Your real accounts stay untouched.
        </p>
      </div>
    </>
  );
}
