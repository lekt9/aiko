import {
  Bot,
  Check,
  Database,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Network,
  Power,
  PowerOff,
  Radio,
  ShieldCheck,
  Trash2,
  Ban,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getCollectiveStatus,
  getCollectiveAudit,
  getCollectiveObjects,
  getCollectiveEquivocations,
  getCollectiveReviewQueue,
  approveCollectiveReview,
  rejectCollectiveReview,
  eraseCollectiveObject,
  revokeCollectiveObject,
  getTelegramSettings,
  saveTelegramBotToken,
  setCollectiveParticipation,
  setCollectivePublicationMode,
  setCollectiveEvidenceSharing,
  type CollectivePublicationMode,
  type CollectiveAuditEvent,
  type CollectiveObject,
  type CollectiveEquivocation,
  type CollectiveReviewItem,
  type CollectiveStatus,
  type TelegramSettings,
} from "../bridge/native";
import { PlaceholderSurface } from "./PlaceholderSurface";

export function SettingsSurface() {
  const [activeTab, setActiveTab] = useState<"account" | "collective" | "telegram">("account");
  return (
    <div className="surface settings-surface">
      <header className="settings-surface__header">
        <h2>Settings</h2>
      </header>
      <div className="settings-surface__tabs">
        <button
          data-active={activeTab === "collective"}
          onClick={() => setActiveTab("collective")}
          type="button"
        >
          Collective
        </button>
        <button
          data-active={activeTab === "account"}
          onClick={() => setActiveTab("account")}
          type="button"
        >
          Account
        </button>
        <button
          data-active={activeTab === "telegram"}
          onClick={() => setActiveTab("telegram")}
          type="button"
        >
          Telegram
        </button>
      </div>
      {activeTab === "account" ? (
        <PlaceholderSurface
          title="Account"
          description="Account, providers, authority, MCP connections, runtime health, and desktop updates."
          icon={Key}
        />
      ) : activeTab === "collective" ? (
        <CollectiveSettingsPane />
      ) : (
        <TelegramSettingsPane />
      )}
    </div>
  );
}

function CollectiveSettingsPane() {
  const [status, setStatus] = useState<CollectiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<CollectiveAuditEvent[]>([]);
  const [objects, setObjects] = useState<CollectiveObject[]>([]);
  const [review, setReview] = useState<CollectiveReviewItem[]>([]);
  const [equivocations, setEquivocations] = useState<CollectiveEquivocation[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextAudit, nextObjects, nextReview, nextEquivocations] = await Promise.all([
        getCollectiveStatus(),
        getCollectiveAudit(),
        getCollectiveObjects(),
        getCollectiveReviewQueue(),
        getCollectiveEquivocations(),
      ]);
      setStatus(nextStatus);
      setAudit(nextAudit);
      setObjects(nextObjects);
      setReview(nextReview);
      setEquivocations(nextEquivocations);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Collective runtime unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changeParticipation = useCallback(async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await setCollectiveParticipation(enabled));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change participation.");
    } finally {
      setSaving(false);
    }
  }, []);

  const changeMode = useCallback(async (mode: CollectivePublicationMode) => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await setCollectivePublicationMode(mode));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change publication policy.");
    } finally {
      setSaving(false);
    }
  }, []);

  const changeEvidenceSharing = useCallback(async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await setCollectiveEvidenceSharing(enabled));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change evidence sharing.");
    } finally {
      setSaving(false);
    }
  }, []);

  const eraseObject = useCallback(async (objectId: string) => {
    setSaving(true);
    setError(null);
    try {
      await eraseCollectiveObject(objectId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not erase the local copy.");
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const revokeObject = useCallback(async (objectId: string) => {
    setSaving(true);
    setError(null);
    try {
      await revokeCollectiveObject(objectId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish a revocation.");
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const decideReview = useCallback(async (objectId: string, approve: boolean) => {
    setSaving(true);
    setError(null);
    try {
      if (approve) await approveCollectiveReview(objectId);
      else await rejectCollectiveReview(objectId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply the review decision.");
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  if (loading) {
    return (
      <div className="collective-settings__loading">
        <Loader2 size={20} className="spin" />
        <span>Loading the local Collective…</span>
      </div>
    );
  }

  return (
    <div className="collective-settings">
      <section className="collective-settings__hero">
        <div>
          <span className="collective-settings__eyebrow">Local-first network</span>
          <h3>Your Aiko can become part of Unbrowse.</h3>
          <p>
            Peers exchange signed, sanitized capability shapes. Private tools,
            credentials, prompts, and execution stay on this machine.
          </p>
        </div>
        <div className="collective-settings__signal" data-online={status?.participation_enabled}>
          <Network size={18} aria-hidden="true" />
          {status?.participation_enabled ? `${status.connected_peers} peers` : "Offline"}
        </div>
      </section>

      {error || status?.error ? (
        <p className="collective-settings__error">{error ?? status?.error}</p>
      ) : null}

      {equivocations.length > 0 ? (
        <section className="collective-settings__section collective-settings__section--stacked collective-settings__warning">
          <div className="collective-settings__section-copy">
            <h3><TriangleAlert size={15} aria-hidden="true" /> Conflicting signed indexes</h3>
            <p>{equivocations.length} publisher generation{equivocations.length === 1 ? "" : "s"} produced different witnessed roots. Those indexes remain evidence only and cannot authorize execution.</p>
          </div>
          <ul className="collective-settings__audit">
            {equivocations.slice(0, 5).map((item) => (
              <li key={`${item.publisher}-${item.generation}`}>
                <strong>{item.publisher.slice(0, 20)}… · generation {item.generation}</strong>
                <small>{item.roots.length} roots · {item.witnesses.length} authenticated witnesses</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="collective-settings__section">
        <div className="collective-settings__section-copy">
          <h3><Power size={15} aria-hidden="true" /> Participate</h3>
          <p>Starts LAN discovery and the peer runtime. Turning this off stops network activity.</p>
        </div>
        <button
          className="collective-settings__toggle"
          aria-pressed={status?.participation_enabled ?? false}
          disabled={saving || !status?.available}
          onClick={() => void changeParticipation(!(status?.participation_enabled ?? false))}
          type="button"
        >
          <span />
          {status?.participation_enabled ? "On" : "Off"}
        </button>
      </section>

      <section className="collective-settings__section collective-settings__section--stacked">
        <div className="collective-settings__section-copy">
          <h3><ShieldCheck size={15} aria-hidden="true" /> Publication policy</h3>
          <p>Participation and publication are separate. Nothing is published unless this policy allows it and Contract admits the exact bytes.</p>
        </div>
        <div className="collective-settings__modes" role="radiogroup" aria-label="Publication policy">
          {([
            ["disabled", "Private", "Never announce contracts."],
            ["safe_public_shapes", "Safe shapes", "Contribute read-only public API shapes after sanitization."],
            ["review_every_object", "Review", "Hold every candidate for explicit approval."],
          ] as const).map(([mode, label, detail]) => (
            <button
              aria-checked={status?.publication_mode === mode}
              data-active={status?.publication_mode === mode}
              disabled={saving || !status?.available}
              key={mode}
              onClick={() => void changeMode(mode)}
              role="radio"
              type="button"
            >
              <strong>{label}</strong>
              <span>{detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="collective-settings__section">
        <div className="collective-settings__section-copy">
          <h3><Radio size={15} aria-hidden="true" /> Share aggregate evidence</h3>
          <p>Optional and off by default. Publishes at most one categorical outcome and latency bucket per capability each hour—never arguments, prompts, results, or account data.</p>
        </div>
        <button
          className="collective-settings__toggle"
          aria-pressed={status?.publish_aggregate_attestations ?? false}
          disabled={saving || !status?.available}
          onClick={() => void changeEvidenceSharing(!(status?.publish_aggregate_attestations ?? false))}
          type="button"
        >
          <span />
          {status?.publish_aggregate_attestations ? "On" : "Off"}
        </button>
      </section>

      {review.length > 0 ? (
        <section className="collective-settings__section collective-settings__section--stacked">
          <div className="collective-settings__section-copy">
            <h3><ShieldCheck size={15} aria-hidden="true" /> Awaiting your review</h3>
            <p>These are the exact sanitized shapes that Contract found publishable. Approval signs and pins the selected object.</p>
          </div>
          <ul className="collective-settings__objects">
            {review.map((item) => (
              <li key={item.object_id}>
                <div>
                  <strong>{item.candidate.payload?.capability_id ?? item.candidate.kind ?? "Contract"}</strong>
                  <span>{item.candidate.payload?.summary ?? item.object_id}</span>
                </div>
                <button disabled={saving} onClick={() => void decideReview(item.object_id, true)} type="button"><Check size={14} /> Approve</button>
                <button disabled={saving} onClick={() => void decideReview(item.object_id, false)} type="button"><EyeOff size={14} /> Keep private</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="collective-settings__section collective-settings__section--stacked">
        <div className="collective-settings__section-copy">
          <h3><Database size={15} aria-hidden="true" /> Verified local catalog</h3>
          <p>Erasing removes this machine’s copy. Revoking publishes a signed instruction that peers can apply to future discovery.</p>
        </div>
        {objects.length === 0 ? <p>No verified Collective objects yet.</p> : (
          <ul className="collective-settings__objects">
            {objects.slice(0, 20).map((object) => (
              <li key={object.object_id}>
                <div>
                  <strong>{object.capability_id || object.kind}</strong>
                  <span>{object.summary || object.object_id}</span>
                </div>
                {object.kind !== "revocation" ? (
                  <button disabled={saving} onClick={() => void revokeObject(object.object_id)} type="button" title="Publish signed revocation"><Ban size={14} /> Revoke</button>
                ) : null}
                <button disabled={saving} onClick={() => void eraseObject(object.object_id)} type="button" title="Erase local copy"><Trash2 size={14} /> Erase</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="collective-settings__stats" aria-label="Local Collective storage">
        <div><Database size={14} /><strong>{status?.objects ?? 0}</strong><span>verified objects</span></div>
        <div><ShieldCheck size={14} /><strong>{status?.pinned ?? 0}</strong><span>pinned</span></div>
        <div><Radio size={14} /><strong>{status?.quarantined ?? 0}</strong><span>quarantined</span></div>
      </section>

      <section className="collective-settings__section collective-settings__section--stacked">
        <div className="collective-settings__section-copy">
          <h3><Eye size={15} aria-hidden="true" /> Local publication history</h3>
          <p>This privacy-safe audit records decisions only; it never stores prompts, credentials, request bodies, or responses.</p>
        </div>
        {audit.length === 0 ? (
          <p>No Collective publication decisions yet.</p>
        ) : (
          <ol className="collective-settings__audit">
            {audit.slice(-5).reverse().map((event, index) => (
              <li key={`${event.timestamp}-${event.action}-${index}`}>
                <strong>{event.action.replaceAll("_", " ")}</strong>
                <span>{new Date(event.timestamp).toLocaleString()}</span>
                <small>{event.reason_codes.join(", ")}</small>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function TelegramSettingsPane() {
  const [settings, setSettings] = useState<TelegramSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageError, setMessageError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await getTelegramSettings();
      setSettings(s);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveToken = useCallback(async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setMessage("Enter a bot token from @BotFather.");
      setMessageError(true);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await saveTelegramBotToken(trimmed);
      setMessage("Token saved. Restart the bridge to apply.");
      setMessageError(false);
      setTokenInput("");
      await refresh();
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : "Failed to save token."
      );
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }, [tokenInput, refresh]);

  if (loading) {
    return (
      <div className="telegram-settings__loading">
        <Loader2 size={20} className="spin" />
        <span>Loading Telegram settings…</span>
      </div>
    );
  }

  const hasToken = Boolean(settings?.botToken);
  const running = settings?.bridgeRunning ?? false;

  return (
    <div className="telegram-settings">
      {/* Bot token */}
      <section className="telegram-settings__section">
        <h3>
          <Key size={14} aria-hidden="true" />
          Bot token
        </h3>
        <p>
          Create a bot with{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
          >
            @BotFather
          </a>{" "}
          on Telegram, then paste its token here. The token is stored in{" "}
          <code>~/.aiko/user-settings.json</code> and never sent to remote
          servers.
        </p>

        {hasToken ? (
          <div className="telegram-settings__token-display">
            <Bot size={16} aria-hidden="true" />
            <span className="telegram-settings__token-masked">
              {showToken ? settings!.botToken : settings!.botToken}
            </span>
            <button
              aria-label={showToken ? "Hide token" : "Show token"}
              onClick={() => setShowToken(!showToken)}
              type="button"
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <span className="telegram-settings__token-ok">
              <Check size={12} aria-hidden="true" />
              Configured
            </span>
          </div>
        ) : null}

        <div className="telegram-settings__token-input-row">
          <input
            className="telegram-settings__token-input"
            onChange={(e) => {
              setTokenInput(e.target.value);
              setMessage(null);
            }}
            placeholder={
              hasToken
                ? "Paste a new token to replace…"
                : "Paste bot token from @BotFather…"
            }
            type="password"
            value={tokenInput}
          />
          <button
            className="telegram-settings__save-button"
            disabled={!tokenInput.trim() || saving}
            onClick={handleSaveToken}
            type="button"
          >
            {saving ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            Save
          </button>
        </div>

        {message && (
          <p
            className={`telegram-settings__feedback ${messageError ? "error" : "ok"}`}
          >
            {message}
          </p>
        )}
      </section>

      {/* Bridge status */}
      <section className="telegram-settings__section">
        <h3>
          <Radio size={14} aria-hidden="true" />
          Bridge status
        </h3>
        <div
          className={`telegram-settings__status-row ${running ? "running" : "stopped"}`}
        >
          {running ? (
            <Power size={16} aria-hidden="true" />
          ) : (
            <PowerOff size={16} aria-hidden="true" />
          )}
          <span>
            {running
              ? "Bridge is running as a launchd service"
              : "Bridge is not running"}
          </span>
          <span className="telegram-settings__status-badge">
            {running ? "Active" : "Stopped"}
          </span>
        </div>

        <div className="telegram-settings__commands">
          <p>
            <strong>Start:</strong>{" "}
            <code>
              launchctl bootstrap gui/501
              ~/Library/LaunchAgents/net.theclarityproject.aiko.telegram-bridge.plist
            </code>
          </p>
          <p>
            <strong>Stop:</strong>{" "}
            <code>
              launchctl bootout gui/501/net.theclarityproject.aiko.telegram-bridge
            </code>
          </p>
          <p>
            <strong>Logs:</strong> <code>~/.aiko/logs/telegram-bridge.log</code>
          </p>
        </div>
      </section>

      {/* Quick info */}
      <section className="telegram-settings__section">
        <h3>Quick reference</h3>
        <ul className="telegram-settings__ref-list">
          <li>
            Bot: <strong>@aiko_kubot</strong>
          </li>
          <li>
            Pairing: DM the bot with <code>/pair</code>, approve the code in{" "}
            <strong>Channels → Telegram</strong>
          </li>
          <li>
            Features: text, streaming replies, typing indicators, voice
            transcription, images, files
          </li>
          <li>
            Token lives in: <code>~/.aiko/user-settings.json</code>
          </li>
        </ul>
      </section>
    </div>
  );
}
