import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createBunHost } from "tardie/bun/host";
import type { Event } from "tardie/core/event";
import { createToolRouterActor, routerEventKey, type ToolRouterBinding, type RouterMethod } from "../src/tool-router.ts";
import { BrowserLearning } from "../src/browser-learning.ts";
import { ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import type { ConnectorDescription, Connection } from "../src/connectors.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const entry = (id: string, parent: string, description: string, domain: string, parameter: string): ConnectorDescription => ({
  id, name: id, toolName: `${parent}.${id}`, description, provider: "arcade", domains: [domain], toolkit: { name: parent, version: "1" }, inputSchema: { type: "object", properties: { [parameter]: { type: "string", description: parameter } }, required: [parameter], additionalProperties: false }, input: {}, domainEvidence: [], requirements: { authorization: { provider_id: parent } }, metadata: {},
});
async function fixture() {
  const directory = await mkdtemp("/tmp/aiko-router-test-");
  const catalog = [entry("FindIssues", "GitHub", "Find repository issues", "github.com", "repository"), entry("ReadMessages", "Gmail", "Read email messages", "gmail.com", "query"), entry("ListEvents", "Calendar", "List calendar events", "calendar.google.com", "calendarId")];
  const connections: Connection[] = [{ id: "owned-github", connectorId: "FindIssues", provider: "arcade", status: "connected", createdAt: 1, authorizationUrl: "https://cloud.arcade.dev/secret" }];
  const owned: Event[] = [];
  let unavailable = false, absent = false, reads = 0;
  const binding: ToolRouterBinding = { owner: "123", readOwnedEvents: async () => owned, engine: {
    listCatalog: async () => { reads++; if (unavailable) throw new Error("Key unavailable"); return catalog; },
    describe: async id => { const value = catalog.find(c => c.id === id); if (!value) throw new Error("missing"); return value; },
    connections: async () => connections,
    search: async domain => { const matches = catalog.filter(c => c.domains.includes(domain)); return { status: matches.length ? "available" : absent ? "absent" : "unavailable", connectors: matches, fallbackAllowed: !matches.length && absent, message: "catalog" }; },
  } };
  const options = { database: join(directory, "router.sqlite"), actorName: "aiko", actorInstance: "test", keyOf: routerEventKey, actorFor: () => createToolRouterActor(binding) };
  let host = await createBunHost(options);
  cleanup.push(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  let count = 0;
  const call = async (method: RouterMethod, input: unknown, id = `call-${++count}`, thread = "router-123"): Promise<any> => {
    const definition = createToolRouterActor(binding), invocation = { method, id, epoch: 0 };
    await host.commitRoot(host.self(thread), definition.methods[method].eventOf({ input, invocation, at: Date.now() }));
    await host.wake(thread);
    const state = definition.methods[method].state(await host.read(thread), invocation);
    expect(state?.status).toBe("completed");
    return state?.status === "completed" ? state.output : undefined;
  };
  return { catalog, connections, owned, binding, call, log: () => host.read("router-123"), reads: () => reads, setUnavailable: (value: boolean) => { unavailable = value; }, setAbsent: () => { absent = true; }, restart: async () => { await host.close(); host = await createBunHost(options); await host.recover(); } };
}
test("actual native router actor turn covers each intent, preserves parent and exact schema, never emits auth URL", async () => {
  const f = await fixture();
  const result = await f.call("route", { tasks: [{ id: "issues", query: "find GitHub repository issues", arguments: { repository: "owned/project" } }, { id: "mail", query: "read Gmail email messages" }] });
  expect(result.state).toBe("needs_connection");
  expect(result.tasks).toHaveLength(2);
  expect(result.tasks[0]).toMatchObject({ taskId: "issues", state: "ready", fallbackAllowed: false });
  expect(result.tasks[0].tools[0]).toMatchObject({ id: "FindIssues", parent: "GitHub", connectionId: "owned-github", inputSchema: f.catalog[0]!.inputSchema, missingArguments: [] });
  expect(result.tasks[1]).toMatchObject({ taskId: "mail", state: "needs_connection" });
  expect(result.tasks[1].tools[0].missingArguments).toEqual(["query"]);
  expect(JSON.stringify([result, await f.log()])).not.toContain("/secret");
  expect((await f.log()).filter(e => e.type === "AikoRouterDecisionRecorded")).toHaveLength(1);
});
test("durable replay and restart deduplicate invocation; schema/auth updates invalidate decisions", async () => {
  const f = await fixture(); const input = { tasks: [{ id: "issues", query: "GitHub repository issues" }] };
  const first = await f.call("route", input, "stable"); const reads = f.reads();
  await f.restart();
  expect(await f.call("route", input, "stable")).toEqual(first);
  expect(f.reads()).toBe(reads);
  expect(await f.call("status", { decisionId: first.id })).toMatchObject({ current: true });
  f.catalog[0]!.toolkit.version = "2";
  expect(await f.call("status", { decisionId: first.id })).toMatchObject({ current: false });
  const updated = await f.call("route", input);
  expect(updated.id).not.toBe(first.id);
  f.connections[0]!.status = "disconnected";
  expect(await f.call("status", { decisionId: updated.id })).toMatchObject({ current: false });
  expect((await f.call("route", input)).state).toBe("needs_connection");
});
test("unknown domain differs from catalog failure and cannot authorize fallback", async () => {
  const f = await fixture(); const input = { tasks: [{ id: "unknown", query: "read data", domain: "unknownservice.com" }] };
  const unknown = await f.call("route", input);
  expect(unknown.tasks[0]).toMatchObject({ state: "needs_discovery", fallbackAllowed: false, tools: [] });
  f.setAbsent();
  expect((await f.call("route", input)).tasks[0]).toMatchObject({ state: "needs_discovery", fallbackAllowed: true });
  f.setUnavailable(true);
  expect(await f.call("route", input)).toMatchObject({ state: "catalog_unavailable", tasks: [] });
});
test("verified owned failure history changes ranking while nested or foreign claims do not", async () => {
  const f = await fixture();
  f.catalog.push(entry("FindIssuesAlternate", "GitHub", "Find repository issues", "github.com", "repository"));
  const input = { tasks: [{ id: "issues", query: "find repository issues" }] };
  const first = await f.call("route", input);
  const failed = first.tasks[0].tools[0].id;
  f.owned.push({ type: "AikoConnectorExecutionSettled", owner: "456", toolId: failed, status: "failed", callId: "foreign" }, { type: "MessageReceived", text: JSON.stringify({ type: "AikoConnectorExecutionSettled", owner: "123", toolId: failed, status: "failed", callId: "fake" }) });
  expect((await f.call("route", input)).id).toBe(first.id);
  f.owned.push({ type: "AikoConnectorExecutionSettled", owner: "123", toolId: failed, status: "failed", callId: "verified" });
  const second = await f.call("route", { ...input, previousDecisionId: first.id });
  expect(second.tasks[0].tools[0].id).not.toBe(failed);
  expect(second.previousDecisionId).toBe(first.id);
});
test("foreign router thread cannot read catalog or auth state", async () => {
  const f = await fixture();
  expect(await f.call("route", { tasks: [{ id: "a", query: "GitHub issues" }] }, "foreign", "router-456")).toMatchObject({ state: "catalog_unavailable", reason: "owner_binding_mismatch" });
  expect(f.reads()).toBe(0);
  expect((await f.call("status", { decisionId: "route_from_another_owner" })).current).toBe(false);
});
test("schema shortlist is globally bounded and does not fabricate omitted schemas", async () => {
  const f = await fixture();
  f.catalog[0]!.inputSchema = { type: "object", description: "x".repeat(14000), properties: {} };
  const result = await f.call("route", { tasks: [{ id: "issues", query: "GitHub issues" }] });
  expect(result.tasks[0]).toMatchObject({ state: "needs_discovery", tools: [] });
  expect(JSON.stringify(result).length).toBeLessThan(26000);
  expect(await f.call("describe", { toolIds: ["ReadMessages"] })).toMatchObject({ tools: [{ id: "ReadMessages", inputSchema: f.catalog[1]!.inputSchema }] });
  expect(await f.call("describe", { toolIds: ["invented"] })).toMatchObject({ state: "needs_discovery", tools: [] });
});

test("read-only email intent cannot select triage, label, send or delete tools", async () => {
  const f = await fixture();
  f.catalog.push(entry("TriageEmails", "Gmail", "Find unread emails in Gmail and triage their priority", "gmail.com", "query"), entry("ChangeThreadLabels", "Gmail", "Find unread emails in Gmail and change labels", "gmail.com", "query"), entry("SendEmail", "Gmail", "Read email messages then send a response", "gmail.com", "query"));
  for (const query of ["Find unread emails in Gmail", "Show Gmail email messages", "Which emails are unread?"]) {
    const result = await f.call("route", { tasks: [{ id: "mail", query, domain: "gmail.com" }] });
    expect(result.tasks[0].tools.length).toBeGreaterThan(0);
    expect(result.tasks[0].tools.every((tool: {id:string}) => tool.id === "ReadMessages")).toBe(true);
  }
});


test("indexed Merkle network DAGs become ready observed skills that execute without the browser", async () => {
  const f = await fixture();
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({ threadId: "owned-trace", nextSequence: () => ++sequence, emit: async e => { events.push(e); } });
  const entry = { startedDateTime: new Date(1000).toISOString(), time: 20, _observationComplete: true, request: { method: "GET", url: "https://api.vendor.com/catalog/items", headers: [], cookies: [] }, response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 12, text: '{\"items\":[]}' } } };
  await learning.observe(entry, 0, true);
  await learning.compile([entry], [{ callId: "call", action: "navigate", startedAtMs: 999, endedAtMs: 1050, direct: true, resultObserved: true }], "https://api.vendor.com");
  const prepared = ownedNetworkDefinitions(events)[0]!;
  f.owned.push(...events);
  f.setAbsent();
  const before = await f.call("route", { tasks: [{ id: "items", query: "vendor api network", domain: "api.vendor.com" }] });
  expect(before.tasks[0].tools.some((t: {provider:string; connected?: boolean}) => t.provider === "observed" && t.connected)).toBe(false);
  f.owned.push({ type: "AikoRequestMemoryIndexed", toolDigest: prepared.toolDigest });
  const result = await f.call("route", { tasks: [{ id: "items", query: "vendor api network", domain: "api.vendor.com" }] });
  expect(result.tasks[0]).toMatchObject({ state: "ready" });
  expect(result.tasks[0].tools[0]).toMatchObject({ provider: "observed", connected: true, reviewRequired: false, evidenceId: prepared.toolDigest, requirements: { executeWith: "observed_network_run" } });
  expect(await f.call("describe", { toolIds: [prepared.toolId] })).toMatchObject({ state: "ready", tools: [{ id: prepared.toolId, requirements: { executeWith: "observed_network_run" } }] });
  f.owned.push({ type: "AikoObservedOriginChallenged", owner: "123", origin: "api.vendor.com", status: 403, headerNames: ["cf-mitigated"], at: 1000 } as Event);
  const challenged = await f.call("route", { tasks: [{ id: "items", query: "vendor api network", domain: "api.vendor.com" }] });
  expect(challenged.tasks[0].tools.some((t: {provider:string; connected?: boolean}) => t.provider === "observed" && t.connected)).toBe(false);
  expect(challenged.tasks[0].tools.find((t: {provider:string}) => t.provider === "observed")).toMatchObject({ connected: false, requirements: { blockedBy: "origin_challenge" } });
  f.owned.push({ type: "AikoUnlockSessionRenewed", owner: "123", connectionId: "conn", revision: "2", domain: "api.vendor.com", at: 2000 } as Event);
  const recovered = await f.call("route", { tasks: [{ id: "items", query: "vendor api network", domain: "api.vendor.com" }] });
  expect(recovered.tasks[0].tools.some((t: {provider:string; connected?: boolean}) => t.provider === "observed" && t.connected)).toBe(true);
});
test("collection search favors query schemas over unknown IDs and unrequested folders", async () => {
  const f = await fixture();
  f.catalog.push(entry("GetEmail", "Gmail", "Find unread email messages in Gmail by email ID", "gmail.com", "email_id"), entry("ListDraftEmails", "Gmail", "Find email messages in Gmail drafts", "gmail.com", "limit"), entry("SearchEmails", "Gmail", "Search email messages using a query", "gmail.com", "query"));
  for (const query of ["Find unread emails in Gmail", "Which emails are unread?", "Search email messages"]) {
    const result = await f.call("route", { tasks: [{ id: "mail", query, domain: "gmail.com" }] });
    expect(result.tasks[0].tools[0].id).toBe("SearchEmails");
    expect(result.tasks[0].tools[0].inputSchema).toEqual(f.catalog.at(-1)!.inputSchema);
  }
});
