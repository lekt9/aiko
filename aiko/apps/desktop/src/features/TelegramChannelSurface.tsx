import {
  Bot,
  Check,
  Copy,
  Link2,
  Loader2,
  MessageCircle,
  Phone,
  Power,
  Radio,
  RefreshCw,
  Send,
  Shield,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveTelegramPairCode,
  getTelegramBridgeLog,
  getTelegramSettings,
  type TelegramSettings,
} from "../bridge/native";

function truncateLine(line: string, max = 120): string {
  return line.length <= max ? line : `${line.slice(0, max - 3)}…`;
}

function formatLogLine(line: string): { label: string; detail: string } | null {
  const match = line.match(/^\[([^\]]+)\]\s+(.+)$/);
  if (!match) return null;
  return { label: match[2], detail: match[1] };
}

const LOG_LABELS: Record<string, { icon: React.ReactNode; tone: string }> = {
  bot_ready: { icon: <Radio size={12} />, tone: "bot_ready" },
  telegram_bridge_started: { icon: <Power size={12} />, tone: "started" },
  pair_approved: { icon: <Shield size={12} />, tone: "approved" },
  user_: { icon: <MessageCircle size={12} />, tone: "user" },
  assistant_: { icon: <Bot size={12} />, tone: "assistant" },
  tools_: { icon: <Send size={12} />, tone: "tools" },
  tool_result_: { icon: <Check size={12} />, tone: "result" },
  bridge_error_: { icon: <X size={12} />, tone: "error" },
  shutdown_: { icon: <Power size={12} />, tone: "shutdown" },
  approved_users_: { icon: <Users size={12} />, tone: "users" },
};

function logTone(line: string): { icon: React.ReactNode; tone: string } {
  for (const [prefix, style] of Object.entries(LOG_LABELS)) {
    if (line.includes(prefix)) return style;
  }
  return { icon: null, tone: "unknown" };
}

export function TelegramChannelSurface() {
  const [settings, setSettings] = useState<TelegramSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [pairCode, setPairCode] = useState("");
  const [pairMessage, setPairMessage] = useState<string | null>(null);
  const [pairError, setPairError] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const s = await getTelegramSettings();
      setSettings(s);
      setLoading(false);
      const lines = await getTelegramBridgeLog(30);
      setLog(lines);
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const handleApprovePair = useCallback(async () => {
    const trimmed = pairCode.trim();
    if (trimmed.length < 4) {
      setPairMessage("Enter at least a 4-character pairing code.");
      setPairError(true);
      return;
    }
    setPairMessage(null);
    setPairError(false);
    try {
      const result = await approveTelegramPairCode(trimmed);
      if (result.ok) {
        setPairMessage("Code approved. The bridge will pick it up in a moment.");
        setPairError(false);
        setPairCode("");
        setTimeout(refresh, 1500);
      } else {
        setPairMessage(result.error ?? "Failed to approve code.");
        setPairError(true);
      }
    } catch (err) {
      setPairMessage(err instanceof Error ? err.message : "Approval failed.");
      setPairError(true);
    }
  }, [pairCode, refresh]);

  if (loading) {
    return (
      <div className="surface telegram-channel">
        <div className="surface__loading">
          <Loader2 size={20} className="spin" />
          <span>Loading Telegram channel…</span>
        </div>
      </div>
    );
  }

  const hasToken = Boolean(settings?.botToken);
  const running = settings?.bridgeRunning ?? false;
  const users = settings?.approvedUserIds ?? [];

  return (
    <div className="surface telegram-channel">
      <header className="telegram-channel__header">
        <div className="telegram-channel__title">
          <MessageCircle size={20} aria-hidden="true" />
          <h2>Telegram</h2>
          <span
            className={`telegram-channel__status ${running ? "running" : "stopped"}`}
          >
            {running ? "Bridge running" : "Bridge stopped"}
          </span>
        </div>
        {hasToken && running && (
          <span className="telegram-channel__bot">
            <Bot size={14} aria-hidden="true" />
            @aiko_kubot
          </span>
        )}
      </header>

      {!hasToken ? (
        <div className="telegram-channel__setup-prompt">
          <Phone size={32} aria-hidden="true" />
          <h3>Connect Telegram</h3>
          <p>
            Add a bot token in <strong>Settings → Telegram</strong> to enable
            messaging, voice, files, and image support.
          </p>
        </div>
      ) : !running ? (
        <div className="telegram-channel__setup-prompt">
          <Power size={32} aria-hidden="true" />
          <h3>Bridge not running</h3>
          <p>
            The Telegram bridge process is not active. Check the launchd service
            in Settings or run{" "}
            <code>launchctl bootstrap gui/501 ~/Library/LaunchAgents/net.theclarityproject.aiko.telegram-bridge.plist</code>
          </p>
        </div>
      ) : (
        <>
          {/* ── Paired users ── */}
          <section className="telegram-channel__section">
            <h3>
              <Users size={14} aria-hidden="true" />
              Paired users
              <span className="telegram-channel__count">{users.length}</span>
            </h3>
            {users.length === 0 ? (
              <p className="telegram-channel__empty">
                No users paired yet. Have contacts DM @aiko_kubot with /pair,
                then approve their code below.
              </p>
            ) : (
              <ul className="telegram-channel__user-list">
                {users.map((id) => (
                  <li key={id}>
                    <Shield size={14} aria-hidden="true" />
                    <span>User {id}</span>
                    <span className="telegram-channel__approved">approved</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Pair code approval ── */}
          <section className="telegram-channel__section">
            <h3>
              <UserPlus size={14} aria-hidden="true" />
              Approve pairing code
            </h3>
            <p className="telegram-channel__help">
              When a contact DMs @aiko_kubot with /pair, they receive a
              6-character code. Paste it here to approve.
            </p>
            <div className="telegram-channel__pair-bar">
              <input
                className="telegram-channel__pair-input"
                maxLength={6}
                onChange={(e) => {
                  setPairCode(e.target.value);
                  setPairMessage(null);
                }}
                placeholder="e.g. A3F9C2"
                value={pairCode}
              />
              <button
                className="telegram-channel__pair-button"
                disabled={pairCode.trim().length < 4}
                onClick={handleApprovePair}
                type="button"
              >
                <Link2 size={14} aria-hidden="true" />
                Approve
              </button>
            </div>
            {pairMessage && (
              <p
                className={`telegram-channel__pair-feedback ${pairError ? "error" : "ok"}`}
              >
                {pairMessage}
              </p>
            )}
          </section>

          {/* ── Bridge log ── */}
          <section className="telegram-channel__section">
            <h3>
              <Radio size={14} aria-hidden="true" />
              Recent activity
              <button
                className="telegram-channel__refresh"
                onClick={refresh}
                type="button"
                aria-label="Refresh"
              >
                <RefreshCw size={12} />
              </button>
            </h3>
            <div className="telegram-channel__log">
              {log.length === 0 ? (
                <p className="telegram-channel__empty">No activity yet.</p>
              ) : (
                log.map((line, i) => {
                  const parsed = formatLogLine(line);
                  const { icon, tone } = parsed ? logTone(parsed.label) : logTone(line);
                  return (
                    <div className={`telegram-channel__log-line ${tone}`} key={i}>
                      <span className="telegram-channel__log-icon">{icon}</span>
                      <span className="telegram-channel__log-text">
                        {parsed ? truncateLine(parsed.label) : truncateLine(line)}
                      </span>
                      {parsed && (
                        <span className="telegram-channel__log-time">
                          {parsed.detail.slice(11, 19)}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
