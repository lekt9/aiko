import type { Event } from "tardie/core/event";
import type { MemoryBinding } from "./memory.ts";
import type { secretaryTelegram } from "./secretary-telegram.ts";
import { secretaryState, pair } from "./secretary-state.ts";
import {
  planDigest,
  workActive,
  workState,
  type Commitment,
  type WorkJournal,
} from "./commitments.ts";

export interface SecretaryWorkBinding extends WorkJournal {
  owner: string;
  thread: string;
  memory: MemoryBinding;
  readSecretary(): Promise<readonly Event[]>;
  telegram?: ReturnType<typeof secretaryTelegram>;
  now?: () => number;
}

export function contactForWork(
  events: readonly Event[],
  owner: string,
  w: Commitment,
) {
  const p = w.plan;
  if (!p) return;
  const s = secretaryState(events);
  const connection = s.connections.get(p.connectionId);
  const grant = s.grants.get(pair(p.connectionId, p.chat));
  if (connection?.owner !== owner) return;
  const messages = [...s.messages.values()].filter(
    (m) => m.connectionId === p.connectionId && m.chat === p.chat,
  );
  // Imported history is context. Only provider-observed message updates can
  // establish a live reply window or fulfill a delegated request.
  const observed = new Set(
    events
      .filter(
        (e) =>
          e.type === "AikoSecretaryUpdate" &&
          (e.update as any)?.kind === "message" &&
          (e.update as any).message.connectionId === p.connectionId &&
          (e.update as any).message.chat === p.chat,
      )
      .map((e) => (e.update as any).message.messageId as number),
  );
  const liveMessages = messages.filter((m) => observed.has(m.messageId));
  const incoming = liveMessages
    .filter(
      (m) =>
        m.sender === p.chat &&
        m.chatType === "private" &&
        !m.viaBot &&
        !m.unsupported &&
        m.text.trim(),
    )
    .sort((a, b) => b.date - a.date || b.messageId - a.messageId)[0];
  return { connection, grant, incoming, messages: liveMessages };
}

/** Shared preparation/dispatch gate. A timestamp and a contact reply grant do not authorize a new workflow. */
export async function workAdmission(
  binding: SecretaryWorkBinding,
  w: Commitment,
  now: number,
) {
  if (w.owner !== binding.owner || binding.thread !== "user-" + binding.owner)
    return { reason: "Owner scope changed" };
  const rows = await binding.read(),
    s = workState(rows, binding.owner);
  const current = s.commitments.get(w.id);
  if (!current || current.version !== w.version || !workActive(current))
    return { reason: "Work paused, taken over, or changed" };
  if (
    !w.plan ||
    !w.mandate ||
    w.mandate.planDigest !== planDigest(w) ||
    now >= w.mandate.expiresAt
  )
    return { reason: "The workflow needs current owner authorization" };
  if (s.contactHandling.get(pair(w.plan.connectionId, w.plan.chat)) === "owner")
    return { reason: "You are handling this contact" };
  if (
    w.dependencyRefs.some((id) => s.commitments.get(id)?.status !== "completed")
  )
    return { reason: "A dependency is still open" };
  const sourceRows = await binding.readSecretary();
  const contact = contactForWork(sourceRows, binding.owner, w);
  if (
    !contact?.connection.enabled ||
    !contact.connection.canReply ||
    !contact.grant?.enabled ||
    contact.grant.id !== w.mandate.grantId
  )
    return { reason: "Contact reply permission changed" };
  const m = contact.incoming;
  if (!m || m.date * 1000 > now + 30000 || now - m.date * 1000 >= 86400000)
    return { reason: "The contact reply window has closed" };
  if (
    sourceRows.some(
      (e) =>
        e.type === "AikoSecretaryUpdate" &&
        Number(e.updateId) > w.mandate!.sourceUpdateId &&
        (e.update as any)?.kind === "message" &&
        (e.update as any).message.sender === binding.owner &&
        (e.update as any).message.connectionId === w.plan!.connectionId &&
        (e.update as any).message.chat === w.plan!.chat,
    )
  )
    return {
      reason: "You replied after delegating; review before Aiko continues",
    };
  if (!binding.telegram) return { reason: "Telegram delivery is unavailable" };
  return { contact, reason: undefined };
}
