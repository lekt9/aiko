import { useEffect, useState } from "react";

type Chat = {
  connectionId: string;
  chat: string;
  name: string;
  chatType: string;
  enabled: boolean;
  supported: boolean;
  ownerSamples: number;
};
type State = {
  connections: {
    id: string;
    enabled: boolean;
    canReply: boolean;
    canRead: boolean;
  }[];
  chats: Chat[];
  deliveries: { id: string; status: string; at: number }[];
};
type Request = <T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<T>;

export function SecretaryPanel({ request }: { request: Request }) {
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh(signal?: AbortSignal) {
    setState(await request<State>("/secretary", undefined, signal));
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (e.name !== "AbortError") setError(e.message);
    });
    return () => controller.abort();
    // The parent remounts this panel whenever the authenticated account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="secretary-panel" aria-labelledby="secretary-title">
      <div className="app-section-heading">
        <h3 id="secretary-title">Secretary Mode</h3>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => void perform(async () => {})}
        >
          Refresh
        </button>
      </div>
      <p>
        Let Aiko reply in your voice. Choose which contacts get automatic
        replies, then pause whenever you like.
      </p>
      <details className="secretary-setup">
        <summary>Set up Secretary Mode</summary>
        <ol>
          <li>
            <a href="tg://settings">Open Telegram settings</a>, then Secretary
            Mode (or Telegram Business → Chatbots). Choose Aiko and the private
            chats it can access.
          </li>
          <li>
            Allow replies in Telegram, then return here and refresh. Your
            Telegram connection grants access; signing in to this app alone does
            not.
          </li>
          <li>
            Import history to teach Aiko how you speak, then enable contacts
            below.
          </li>
        </ol>
        <p className="aiko-fineprint">
          New messages build context automatically. For older messages, export a
          single chat as JSON from Telegram Desktop. Aiko learns from your own
          messages in that chat. Account-level group replies are not supported
          by Telegram. Replies require recent incoming messages and Telegram’s
          permission.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!state && !error && <p role="status">Loading Secretary Mode…</p>}
      {state && (
        <>
          {!state.connections.some((c) => c.enabled) && (
            <p>No Telegram account connected for Secretary Mode yet.</p>
          )}
          {state.connections
            .filter((c) => c.enabled)
            .map((c) => (
              <p key={c.id} className="aiko-fineprint">
                Telegram connected ·{" "}
                {c.canReply
                  ? "Reply permission granted"
                  : "Enable reply permission in Telegram"}{" "}
                ·{" "}
                {c.canRead
                  ? "Can mark messages read"
                  : "Read receipts disabled"}
              </p>
            ))}
          {!state.chats.length && state.connections.some((c) => c.enabled) && (
            <p>
              Your selected contacts appear after their next message reaches
              Aiko.
            </p>
          )}
          <div className="secretary-contacts">
            {state.chats.map((chat) => {
              const c = state.connections.find(
                (c) => c.id === chat.connectionId,
              );
              return (
                <article
                  className="secretary-contact"
                  key={`${chat.connectionId}:${chat.chat}`}
                >
                  <div className="app-section-heading">
                    <div>
                      <h4>{chat.name || chat.chat}</h4>
                      <p className="aiko-fineprint">
                        {chat.chat} · {chat.ownerSamples} messages from you
                      </p>
                    </div>
                    <button
                      type="button"
                      className="button"
                      aria-pressed={chat.enabled}
                      disabled={
                        busy ||
                        (!chat.enabled &&
                          (!chat.supported || !c?.enabled || !c.canReply))
                      }
                      onClick={() =>
                        void perform(async () => {
                          await request("/secretary/contact", {
                            connectionId: chat.connectionId,
                            chat: chat.chat,
                            enabled: !chat.enabled,
                          });
                          setNotice(
                            chat.enabled
                              ? `Automatic replies paused for ${chat.name}.`
                              : `Always reply enabled for ${chat.name}. No approval notifications for this contact.`,
                          );
                        })
                      }
                    >
                      {chat.enabled
                        ? "Pause automatic replies"
                        : "Enable always reply"}
                    </button>
                  </div>
                  <p>
                    {chat.enabled
                      ? "Always reply is on"
                      : "Automatic replies are off"}
                    {!chat.supported
                      ? " · Telegram does not support account replies in this group"
                      : ""}
                  </p>
                  {chat.supported && (
                    <label className="secretary-import">
                      Import this chat’s Telegram JSON export (up to 2,000
                      messages, 1 MB)
                      <input
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (!file) return;
                          void perform(async () => {
                            if (file.size > 950_000)
                              throw new Error(
                                "Choose a chat export smaller than 950 KB, with up to 2,000 messages.",
                              );
                            const result = await request<{ imported: number }>(
                              "/secretary/history",
                              {
                                connectionId: chat.connectionId,
                                chat: chat.chat,
                                history: JSON.parse(await file.text()),
                              },
                            );
                            setNotice(
                              `Imported ${result.imported} messages for ${chat.name}.`,
                            );
                          });
                        }}
                      />
                    </label>
                  )}
                </article>
              );
            })}
          </div>
          {!!state.deliveries.length && (
            <details>
              <summary>Recent automatic replies</summary>
              <ul>
                {state.deliveries.map((d) => (
                  <li key={d.id}>
                    {new Date(d.at).toLocaleString()} ·{" "}
                    {d.status === "unknown"
                      ? "Delivery uncertain — not retried"
                      : d.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
