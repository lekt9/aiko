import { Bot, Check, Eye, EyeOff, Key, Loader2, Power, PowerOff, Radio } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getTelegramSettings,
  saveTelegramBotToken,
  type TelegramSettings,
} from "../bridge/native";
import { PlaceholderSurface } from "./PlaceholderSurface";

export function SettingsSurface() {
  const [activeTab, setActiveTab] = useState<"account" | "telegram">("account");
  return (
    <div className="surface settings-surface">
      <header className="settings-surface__header">
        <h2>Settings</h2>
      </header>
      <div className="settings-surface__tabs">
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
      ) : (
        <TelegramSettingsPane />
      )}
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
