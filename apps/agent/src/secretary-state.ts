import type { Event } from "tardie/core/event";
import type {
  SecretaryConnection,
  SecretaryMessage,
} from "./secretary-telegram.ts";
type E = Event & Record<string, any>;
type Grant = {
  id: string;
  connectionId: string;
  chat: string;
  enabled: boolean;
};
export const pair = (connection: string, chat: string) =>
  JSON.stringify([connection, chat]);
export const secretaryThread = (owner: string) => `secretary-${owner}`;
export const secretaryEventKey = (e: Event) =>
  e.type.startsWith("AikoSecretary") && typeof e.id === "string"
    ? `${e.type}:${e.id}`
    : undefined;
export function secretaryState(log: readonly E[]) {
  const connections = new Map<string, SecretaryConnection>();
  const connectionUpdates = new Map<string, number>();
  const grants = new Map<string, Grant>();
  const messages = new Map<string, SecretaryMessage>();
  const deleted = new Set<string>();
  const messageUpdates = new Map<string, number>();
  for (const e of log) {
    if (e.type === "AikoSecretaryUpdate") {
      const u = e.update,
        c = u.connection as SecretaryConnection;
      if ((connectionUpdates.get(c.id) ?? -1) <= e.updateId) {
        connections.set(c.id, c);
        connectionUpdates.set(c.id, e.updateId);
      }
      if (u.kind === "message" || u.kind === "edit") {
        const m = u.message as SecretaryMessage,
          k = `${pair(c.id, m.chat)}:${m.messageId}`;
        if (!deleted.has(k) && (messageUpdates.get(k) ?? -1) < e.updateId) {
          messages.set(k, m);
          messageUpdates.set(k, e.updateId);
        }
      }
      if (u.kind === "delete")
        for (const id of u.messageIds) {
          const k = `${pair(c.id, u.chat)}:${id}`;
          deleted.add(k);
          messages.delete(k);
        }
    }
    if (e.type === "AikoSecretaryGrant")
      grants.set(pair(e.connectionId, e.chat), {
        id: e.id,
        connectionId: e.connectionId,
        chat: e.chat,
        enabled: e.enabled,
      });
    if (e.type === "AikoSecretaryHistory")
      for (const m of e.messages as SecretaryMessage[]) {
        const k = `${pair(m.connectionId, m.chat)}:${m.messageId}`;
        if (!messages.has(k) && !deleted.has(k)) messages.set(k, m);
      }
  }
  return { connections, grants, messages };
}
export function authorized(log: readonly E[], job: E, now = Date.now()) {
  const s = secretaryState(log),
    m = job.update.message as SecretaryMessage;
  const c = s.connections.get(m.connectionId),
    grant = s.grants.get(pair(m.connectionId, m.chat));
  const current = s.messages.get(
    `${pair(m.connectionId, m.chat)}:${m.messageId}`,
  );
  return !!(
    c?.enabled &&
    c.canReply &&
    grant?.enabled &&
    grant.id === job.grantId &&
    m.chatType === "private" &&
    m.chat !== c.owner &&
    m.sender !== c.owner &&
    !m.viaBot &&
    !m.unsupported &&
    m.text.trim() &&
    m.date * 1000 <= now + 30_000 &&
    now - m.date * 1000 < 86_400_000 &&
    current &&
    JSON.stringify(current) === JSON.stringify(m) &&
    !log.some(
      (e) =>
        e.type === "AikoSecretaryUpdate" &&
        e.updateId > job.updateId &&
        e.update.kind === "message" &&
        e.update.message.connectionId === m.connectionId &&
        e.update.message.chat === m.chat &&
        e.update.message.sender === c.owner,
    )
  );
}
/** Mine only this contact's owner-authored examples. Imported and AI-authored speech never silently become owner speech. */
export function secretaryContext(
  log: readonly E[],
  owner: string,
  m: SecretaryMessage,
) {
  const rows = [...secretaryState(log).messages.values()]
    .filter(
      (x) =>
        x.connectionId === m.connectionId &&
        x.chat === m.chat &&
        !x.viaBot &&
        !x.unsupported,
    )
    .sort((a, b) => a.date - b.date || a.messageId - b.messageId);
  const query = new Set(
    m.text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
  const relevant = rows
    .filter((x) => x.messageId !== m.messageId)
    .map((x) => ({
      row: x,
      score: [...query].filter((w) => x.text.toLowerCase().includes(w)).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.row.date - a.row.date)
    .slice(0, 10)
    .map((x) => x.row);
  const selected = [
    ...new Map(
      [...relevant, ...rows.slice(-20)].map((x) => [x.messageId, x]),
    ).values(),
  ].sort((a, b) => a.date - b.date || a.messageId - b.messageId);
  const examples = rows.filter((x) => x.sender === owner).slice(-40);
  const lengths = examples.map((x) => x.text.length).sort((a, b) => a - b);
  return JSON.stringify({
    owner,
    contact: { id: m.chat, name: m.name },
    voice: {
      source: "owner-authored messages in this chat",
      sampleCount: examples.length,
      medianCharacters: lengths[Math.floor(lengths.length / 2)] ?? null,
      lowercaseFraction: examples.length
        ? examples.filter((x) => x.text === x.text.toLowerCase()).length /
          examples.length
        : null,
      examples: examples.map((x) => ({
        id: x.messageId,
        text: x.text.slice(0, 600),
      })),
    },
    coverage: {
      availableMessages: rows.length,
      selectedMessages: selected.length,
      selection: "recent messages plus relevant earlier messages",
    },
    history: selected.map((x) => ({
      id: x.messageId,
      speaker: x.sender === owner ? "owner" : "contact",
      text: x.text.slice(0, 1200),
      date: x.date,
    })),
    incoming: { id: m.messageId, text: m.text },
  });
}
