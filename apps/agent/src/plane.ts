import { Knowledge, renderKnowledgeHtml, MemoryError } from "entity-learn";
import { openMemory, type MemoryBinding } from "./memory.ts";

export const planeManifest = {
  protocol: "aiko-plane/v1",
  authentication:
    "Bearer account credential; the server binds account and scopes",
  methods: [
    { method: "POST", path: "/v1/connectors/route", body: { tasks: "atomic task list with query, optional domain and arguments" } },
    { method: "GET", path: "/v1/connectors?query=service-or-domain" },
    { method: "GET", path: "/v1/connectors/connections" },
    { method: "POST", path: "/v1/connectors/connect", body: { connectorId: "catalog connector ID" } },
    { method: "POST", path: "/v1/connectors/complete", body: { connectionId: "owner-bound pending connection ID" } },
    { method: "POST", path: "/v1/connectors/disconnect", body: { connectionId: "owner-bound connection ID" } },
    { method: "POST", path: "/v1/connectors/discover", body: { domain: "public domain", evidenceUrls: "optional GitHub/DeepWiki documents" } },
    { method: "POST", path: "/v1/connectors/execute", body: { connectionId: "connected tool ID", input: "tool arguments" } },
    { method: "GET", path: "/v1/status" },
    {
      method: "POST",
      path: "/v1/messages",
      body: { id: "8–80 character idempotency key", text: "1–4000 characters" },
    },
    { method: "GET", path: "/v1/messages" },
    {
      method: "POST",
      path: "/v1/hooks/unbrowse",
      body: {
        type: "BrowserNetworkToolPrepared",
        evidence:
          "complete committed native event; digests and summary are verified before admission",
      },
    },
    {
      method: "POST",
      path: "/v1/hooks",
      body: {
        id: "8–128 character producer event ID",
        subject: "stable source entity ID",
        title: "entity title",
        kind: "entity | fact | episode | skill",
        type: "entity type",
        payload: "non-secret JSON evidence",
      },
    },
    { method: "POST", path: "/v1/cancel", body: { id: "accepted message ID" } },
    { method: "GET", path: "/v1/memory/recall?search=..." },
    { method: "GET", path: "/v1/memory/observations/{observationId}" },
    { method: "GET", path: "/v1/memory/knowledge/{observationId}" },
    { method: "GET", path: "/v1/browser" },
    { method: "POST", path: "/v1/browser/approval" },
    { method: "POST", path: "/v1/observed-actions/approval", body: { id: "approval id", hash: "payload hash", decision: "approve | reject" } },
  ],
  isolation:
    "private account log, memory database and browser profile; not arbitrary-code OS isolation",
} as const;

export function planeMemoryRead(
  url: URL,
  binding: Pick<MemoryBinding, "stateDir" | "owner" | "openMemory">,
): Response | undefined {
  if (!url.pathname.startsWith("/v1/memory/")) return undefined;
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "cache-control": "no-store" } });
  const search = url.searchParams.get("search") ?? "";
  if (
    search.length > 512 ||
    [...url.searchParams.keys()].some((key) => key !== "search")
  )
    return json({ error: "invalid_query" }, 400);
  const memory = openMemory(binding);
  try {
    if (url.pathname === "/v1/memory/recall")
      return json(
        memory.recall({
          search,
          limit: 10,
          maxBytes: 12000,
          maxCandidates: 2000,
          depth: 0,
        }),
      );
    const pageMatch = /^\/v1\/memory\/knowledge\/(obs_[a-f0-9]{64})$/.exec(url.pathname);
    if (pageMatch) {
      return memory.journal.read(() => {
        const knowledge = new Knowledge(memory); const page = knowledge.get(pageMatch[1]);
        return page ? json({ page, html: renderKnowledgeHtml(knowledge, pageMatch[1]) }) : json({ error: "not_found" }, 404);
      });
    }
    const match = /^\/v1\/memory\/observations\/(obs_[a-f0-9]{64})$/.exec(
      url.pathname,
    );
    if (match) {
      const found = memory.get(match[1]);
      return found ? json(found) : json({ error: "not_found" }, 404);
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return json({ error: error instanceof MemoryError ? "memory_unavailable" : "read_failed" }, 409);
  } finally {
    memory.close();
  }
}
