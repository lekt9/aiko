import { privateEnv } from "../apps/agent/src/config.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const env = await privateEnv("/home/deck/.config/unbrowse/aiko-cloudflare.env");
const base = env.AIKO_CLOUDFLARE_URL;
if (!base?.startsWith("https://") || !env.AIKO_E2E_TOKEN)
  throw new Error("Deployment canary configuration missing");
const records: object[] = [];
async function request(path: string, body?: object, authorized = true) {
  const at = Date.now();
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(authorized ? { Authorization: `Bearer ${env.AIKO_E2E_TOKEN}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120000),
  });
  records.push({ path, status: response.status, ms: Date.now() - at });
  return response;
}
const page = await request("/connect", undefined, false);
if (!page.ok || !(await page.text()).includes('id="root"'))
  throw new Error("Connection page unavailable");
if (
  (await request("/api/connectors?query=gmail", undefined, false)).status !==
  401
)
  throw new Error("Authentication gate failed");
const search = await request("/api/connectors?query=gmail");
const found = (await search.json()) as any;
if (!search.ok || found.status !== "available" || !found.connectors?.length)
  throw new Error("Live catalog unavailable");
const result = await request("/api/connectors/route", {
  tasks: [
    { id: "mail", query: "Find unread emails in Gmail", domain: "gmail.com" },
    { id: "slack", query: "Search Slack messages", domain: "slack.com" },
  ],
});
const routed = (await result.json()) as any;
if (
  !result.ok ||
  routed.owner !== env.AIKO_E2E_OWNER ||
  !Array.isArray(routed.tasks) ||
  routed.tasks.length !== 2 ||
  routed.tasks.some((t: any) => !t.tools?.length)
)
  throw new Error("Native router failed");
if (
  !routed.tasks
    .find((t: any) => t.taskId === "mail")
    ?.tools.some((tool: any) => /Gmail\.Search/.test(tool.id))
)
  throw new Error("Gmail search coverage failed");
const toolIds = routed.tasks.flatMap((t: any) =>
  t.tools.map((tool: any) => tool.id),
);
if (
  toolIds.some((id: string) =>
    /Change|Delete|Triage|Create|Send|Remove|Update/.test(id),
  )
)
  throw new Error("Read task incorrectly routed to mutations");
const leak = await request("/api/connectors/route", {
  tasks: [
    {
      id: "reject",
      query: "GitHub",
      arguments: { nested: { token: "fixture-private-value" } },
    },
  ],
});
if (leak.status !== 409) throw new Error("Credential rejection failed");
// Password manager surface: add, sealed listing, foreign-reference fill refusal, remove.
const managers = await request("/api/connectors/password-managers");
const managerList = (await managers.json()) as { managers?: unknown[] };
if (!managers.ok || !Array.isArray(managerList.managers))
  throw new Error("Password manager surface unavailable");
const canaryToken = "canary-op-service-token-not-real";
const addedManager = await request("/api/connectors/password-managers/add", {
  kind: "onepassword",
  name: "Deployment canary",
  token: canaryToken,
  entries: [
    {
      label: "Canary",
      website: "https://canary.aiko-check.net",
      reference: "op://Canary/Vault/password",
    },
  ],
});
if (!addedManager.ok) throw new Error("Password manager add failed");
const managerView = (await addedManager.json()) as { id?: string };
if (!managerView.id || JSON.stringify(managerView).includes(canaryToken))
  throw new Error("Manager token leaked or add malformed");
const foreignFill = await request("/api/connectors/password-managers/fill", {
  connectionId: randomUUID(),
  managerId: managerView.id,
  reference: "op://Other/Nope/password",
});
if (foreignFill.ok) throw new Error("Foreign-reference fill must fail closed");
const removedManager = await request(
  "/api/connectors/password-managers/remove",
  { managerId: managerView.id },
);
if (!removedManager.ok) throw new Error("Password manager remove failed");
const afterRemove = (await (
  await request("/api/connectors/password-managers")
).json()) as { managers?: { id?: string }[] };
if (afterRemove.managers?.some((m) => m.id === managerView.id))
  throw new Error("Removed manager still listed");
await mkdir("artifacts/connectors", { recursive: true });
await writeFile(
  "artifacts/connectors/deployment.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      url: base + "/connect",
      verified: true,
      records,
      router: { state: routed.state, toolIds },
      passwordManagers: { verified: true },
      messagesSent: 0,
      inferenceCalls: 0,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    verified: true,
    url: base + "/connect",
    catalogSize: found.catalogSize,
    routerState: routed.state,
    toolIds,
  }),
);
