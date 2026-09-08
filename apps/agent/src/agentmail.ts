import { createHash } from "node:crypto";
import type { ConnectorStore } from "./connectors.ts";
import { DynamicToolDenied, type DynamicToolSession } from "./dynamic-tools.ts";
import { integrationIdentity, integrationStoreKey } from "./composio.ts";
import { boundedText, type HttpFetch } from "./security.ts";

export const agentmailTools = { AGENTMAIL_CREATE_INBOX: "write", AGENTMAIL_INBOX_STATUS: "read" } as const;
interface Mailbox { owner: string; clientId: string; podId: string; inboxId?: string }
export interface AgentMailOptions {
  owner: string;
  instance: string;
  apiKey: string;
  store: ConnectorStore;
  current(): boolean | Promise<boolean>;
  canProvision(turn: string | undefined): Promise<boolean>;
  fetch?: HttpFetch;
}
const empty = { type: "object", properties: {}, additionalProperties: false };
const record = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid AgentMail response");
  return v as Record<string, any>;
};

/** An organization key never becomes a model capability. Only one host-bound
 * pod/inbox can be provisioned/read here; no organization-wide mail endpoints. */
export function agentmailSession(options: AgentMailOptions): DynamicToolSession {
  const clientId = integrationIdentity(options.instance, options.owner);
  const credential = createHash("sha256").update(options.apiKey).digest("hex");
  const key = integrationStoreKey(options.owner, clientId, "agentmail", credential);
  const current = async (signal: AbortSignal) => { signal.throwIfAborted(); if (!await options.current()) throw Error("AgentMail access revoked"); };
  const api = async (path: string, signal: AbortSignal, body?: unknown) => {
    await current(signal);
    const response = await (options.fetch ?? fetch)(`https://api.agentmail.to/v0/${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`AgentMail request unavailable (HTTP ${response.status}). No automatic retry.`);
    }
    const value = record(JSON.parse(await boundedText(response, 256_000)));
    await current(signal);
    return value;
  };
  const read = async (signal: AbortSignal) => {
    await current(signal);
    const row = await options.store.get(key) as Mailbox | undefined;
    if (row && (row.owner !== options.owner || row.clientId !== clientId || typeof row.podId !== "string" || !row.podId)) throw Error("Foreign AgentMail pod binding");
    if (row) {
      const pod = await api(`pods/${encodeURIComponent(row.podId)}`, signal);
      if (pod.pod_id !== row.podId || pod.client_id !== clientId) throw Error("AgentMail pod ownership mismatch");
    }
    return row;
  };
  let provision: Promise<Mailbox> | undefined;
  const ensureInbox = (signal: AbortSignal): Promise<Mailbox> => provision ??= (async () => {
    let row = await read(signal);
    if (!row) {
      // AgentMail documents client_id as idempotent resource creation. A restart
      // may recover this exact pod, never attach an arbitrary existing inbox.
      const pod = await api("pods", signal, { client_id: clientId, name: "Unlock private mailbox" });
      if (typeof pod.pod_id !== "string" || pod.client_id !== clientId) throw Error("AgentMail pod binding unconfirmed");
      row = { owner: options.owner, clientId, podId: pod.pod_id };
      await options.store.set(key, row);
    }
    if (!row.inboxId) {
      const inbox = await api(`pods/${encodeURIComponent(row.podId)}/inboxes`, signal, { client_id: `${clientId}_inbox`, display_name: "Aiko" });
      if (inbox.pod_id !== row.podId || typeof inbox.inbox_id !== "string" || inbox.client_id !== `${clientId}_inbox`) throw Error("AgentMail inbox binding unconfirmed");
      row = { ...row, inboxId: inbox.inbox_id };
      await options.store.set(key, row);
    }
    return row;
  })().finally(() => { provision = undefined; });
  return {
    close: async () => {},
    listTools: async () => ({ tools: [
      { name: "AGENTMAIL_CREATE_INBOX", description: "Create this owner's isolated AgentMail inbox when asked. One per owner; existing inboxes are reused. Does not send email or sign into another service.", inputSchema: empty },
      { name: "AGENTMAIL_INBOX_STATUS", description: "Read this owner's inbox address and whether it has messages. Does not expose message bodies, OTPs, links or cookies. No inbox is created by this read.", inputSchema: empty },
    ] }),
    callTool: async (input, _, request) => {
      const signal = request?.signal ?? AbortSignal.timeout(30_000);
      await current(signal);
      if (!Object.hasOwn(agentmailTools, input.name) || !input.arguments || Object.keys(input.arguments).length) throw new DynamicToolDenied("Invalid AgentMail call");
      const create = input.name === "AGENTMAIL_CREATE_INBOX";
      if (create && !await options.canProvision(typeof input._meta?.["aiko/native-turn"] === "string" ? input._meta["aiko/native-turn"] : undefined)) throw new DynamicToolDenied("Create an inbox from your current private Telegram conversation");
      const row = create ? await ensureInbox(signal) : await read(signal);
      if (!row?.inboxId) return { status: "not_connected", message: "Ask Aiko to create your AgentMail inbox." };
      const inbox = await api(`pods/${encodeURIComponent(row.podId)}/inboxes/${encodeURIComponent(row.inboxId)}`, signal);
      if (inbox.pod_id !== row.podId || inbox.inbox_id !== row.inboxId || typeof inbox.email !== "string") throw Error("AgentMail inbox ownership mismatch");
      // AgentMail's count is PAGE length, not inbox total. Only message
      // presence crosses this boundary; never claim a total from limit=1.
      const messages = await api(`inboxes/${encodeURIComponent(row.inboxId)}/messages?limit=1`, signal);
      if (!Array.isArray(messages.messages) || messages.messages.length > 1 || messages.count !== messages.messages.length || messages.messages.some((m: any) => m.inbox_id !== row.inboxId)) throw Error("AgentMail message scope unconfirmed");
      return { status: "connected", address: inbox.email, hasMessages: messages.count > 0 };
    },
  };
}
