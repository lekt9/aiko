import { expect, test } from "bun:test";
import { fixture } from "./registry-worker-host.test.ts";
import { connectorStorePrefix } from "../src/connectors.ts";
import type { BrowserWatchDeployment } from "../src/browser-watch-config.ts";

const owner = "123",
  connectionId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const path = "/api/channels/browser-watches/discovery";
const deployment = (): BrowserWatchDeployment => ({
  version: 1,
  ingressOrigin: "https://ingress.example.com",
  owners: {
    [owner]: {
      sources: [
        {
          connectionId,
          label: "Requests site",
          origin: "https://site.example.com",
          sourceGeneration: 3,
          events: [
            {
              id: "request",
              label: "New request",
              kind: "push",
              outcome: "received",
            },
          ],
        },
      ],
      actions: [
        {
          id: "investigate",
          label: "Investigate",
          supportsInstruction: true,
          action: { kind: "actor", instruction: "Investigate the new request" },
        },
      ],
      defaults: { expiresInMs: 60000, backlog: 8, maxOccurrences: 100 },
    },
  },
});
const record = (id = connectionId) => ({
  id,
  owner,
  connectorId: "browser:site.example.com",
  provider: "browser",
  status: "connected",
  createdAt: Date.now(),
  browserVerification: {
    verified: true,
    revision: 7,
    expiresAt: Date.now() + 3600000,
  },
  credentialReference: "PRIVATE_WATCH_CREDENTIAL_REFERENCE",
});
const storeKey = (id = connectionId) =>
  `${connectorStorePrefix(owner)}connection:${id}`;
async function configured() {
  const f = await fixture();
  f.env.AIKO_BROWSER_WATCH_CONFIG = JSON.stringify(deployment());
  await f.storage().put(storeKey(), record());
  await f.storage().put(storeKey(otherId), record(otherId));
  return f;
}

test("actual Worker JSON mount discovers only configured owned sources and actor choices without browser or model work", async () => {
  const f = await configured();
  const denied = await f.request(path, undefined, "wrong-owner-token");
  expect(denied.status).toBe(401);
  const response = await f.request(path);
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  expect(body).toMatchObject({
    available: true,
    result: {
      sites: [
        {
          connectionId,
          label: "Requests site",
          origin: "https://site.example.com",
          connectionRevision: "7",
          sourceGeneration: 3,
          events: [
            {
              id: "request",
              label: "New request",
              kind: "push",
              outcome: "received",
            },
          ],
        },
      ],
      actions: deployment().owners[owner]!.actions,
      defaults: deployment().owners[owner]!.defaults,
    },
  });
  expect(body.result.sites).toHaveLength(1);
  expect(body.result.sites[0].expiresAt).toBe(
    (await f.storage().get(storeKey())).browserVerification.expiresAt,
  );
  expect(body.result.actions).toHaveLength(1);
  expect(JSON.stringify(body)).not.toContain(
    "PRIVATE_WATCH_CREDENTIAL_REFERENCE",
  );
  expect(f.requests).toHaveLength(0);
  expect(f.jobs).toHaveLength(0);
  expect(await f.storage().get("codegraff:sandbox")).toBeUndefined();
  const changed = record();
  changed.browserVerification.revision = 8;
  await f.storage().put(storeKey(), changed);
  expect(
    ((await (await f.request(path)).json()) as any).result.sites[0]
      .connectionRevision,
  ).toBe("8");
  await f.storage().put(storeKey(), { ...changed, status: "disconnected" });
  expect(((await (await f.request(path)).json()) as any).result.sites).toEqual(
    [],
  );
  await f.storage().put(storeKey(), { ...changed, owner: "456" });
  expect(((await (await f.request(path)).json()) as any).result.sites).toEqual(
    [],
  );
  expect(f.requests).toHaveLength(0);
  expect(f.jobs).toHaveLength(0);
}, 30_000);

test("Worker configuration changes cut the mounted catalog and restart mounts the new catalog", async () => {
  const f = await configured();
  expect((await f.request(path)).status).toBe(200);
  const changed = deployment();
  changed.owners[owner]!.sources[0]!.label = "Updated requests site";
  changed.owners[owner]!.actions[0]!.label = "Review request";
  f.env.AIKO_BROWSER_WATCH_CONFIG = JSON.stringify(changed);
  const cut = await f.request(path);
  expect(cut.status).toBe(409);
  expect(await cut.json()).toMatchObject({
    error: "watch_operation_unavailable",
  });
  await f.restart();
  const mounted = await f.request(path);
  expect(mounted.status).toBe(200);
  expect(((await mounted.json()) as any).result).toMatchObject({
    sites: [{ label: "Updated requests site", connectionRevision: "7" }],
    actions: [{ label: "Review request" }],
  });
  delete f.env.AIKO_BROWSER_WATCH_CONFIG;
  expect((await f.request(path)).status).toBe(409);
  await f.restart();
  const removed = await f.request(path);
  expect(removed.status).toBe(503);
  expect(await removed.json()).toMatchObject({
    available: false,
    error: "browser_watches_not_configured",
  });
  expect(f.requests).toHaveLength(0);
  expect(f.jobs).toHaveLength(0);
}, 30_000);

test("Worker rejects malformed deployment data before mounting a watch catalog", async () => {
  const f = await fixture();
  f.env.AIKO_BROWSER_WATCH_CONFIG = "{";
  const response = await f.request(path);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "service_unavailable" });
  delete f.env.AIKO_BROWSER_WATCH_CONFIG;
  expect((await f.request(path)).status).toBe(503);
  expect(f.requests).toHaveLength(0);
  expect(f.jobs).toHaveLength(0);
}, 30_000);

for (const missing of [
  "registry",
  "native-sign-in",
  "synchronous-storage",
] as const) {
  test(`Worker fails closed when the configured watch mount lacks ${missing}`, async () => {
    const f = await fixture({ allowBootFailure: true });
    f.env.AIKO_BROWSER_WATCH_CONFIG = JSON.stringify(deployment());
    if (missing === "registry") f.env.AIKO_REGISTRY_FACTORY = () => undefined;
    if (missing === "synchronous-storage") delete f.storage().kv;
    if (missing === "native-sign-in")
      f.env.AIKO_CONNECTOR_VAULT_JSON = JSON.stringify({
        origin: "https://vault.example.com",
        accounts: {
          [owner]: {
            token: "fixture-vault-token-0123456789",
            tenantId: "tenant",
            profileId: "profile",
            runtimeId: "runtime",
            connections: { "site.example.com": "approved-site" },
          },
        },
      });
    const response = await f.request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
    expect(f.requests).toHaveLength(0);
    expect(f.jobs).toHaveLength(0);
  }, 30_000);
}
