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

function webhookDeployment(){
  const value=deployment();
  value.owners[owner]!.webhooks=[{id:"requests-v1",url:"https://hooks.receiver.com/aiko",signingKeyRef:"requests-v1",expiresAt:Date.now()+600000,maxBytes:8192,retentionMs:600000}];
  value.owners[owner]!.actions=[{id:"deliver",label:"Send request",action:{kind:"webhook",destination:"requests-v1"}}];
  return value;
}
const webhookKeys=(account=owner,key="PRIVATE_WEBHOOK_SIGNING_KEY_00000000000000")=>JSON.stringify({version:1,owners:{[account]:{"requests-v1":key,"requests-v2":key+"V2"}}});
async function webhookConfigured(){
  const f=await fixture(),config=webhookDeployment();
  f.env.AIKO_BROWSER_WATCH_CONFIG=JSON.stringify(config);f.env.AIKO_BROWSER_WATCH_WEBHOOK_KEYS=webhookKeys();
  await f.storage().put(storeKey(),record());return {...f,config};
}

test("actual Worker initializes immutable webhook channel before discovery without allocating a browser",async()=>{
  const f=await webhookConfigured();
  const response=await f.request(path);expect(response.status).toBe(200);
  const body=await response.json() as any;expect(body.result.actions).toEqual(f.config.owners[owner]!.actions);
  const rows=f.events(),intents=rows.filter(e=>e.type==="AikoChannelBindingIntent");
  expect(intents).toHaveLength(1);expect(intents[0].binding.name).toBe("browser-watch-webhook:requests-v1");
  expect(intents[0].binding.generation).toBe(1);expect(rows.filter(e=>e.type==="AikoChannelBindingReady")).toHaveLength(1);
  expect(JSON.stringify(rows)+JSON.stringify(body)).not.toContain("PRIVATE_WEBHOOK_SIGNING_KEY");
  expect(f.requests).toHaveLength(0);expect(f.jobs).toHaveLength(0);expect(await f.storage().get("codegraff:sandbox")).toBeUndefined();
  await f.restart();expect((await f.request(path)).status).toBe(200);
  expect(f.events().filter(e=>e.type==="AikoChannelBindingIntent")).toEqual(intents);
},30000);

test("actual Worker omits destinations with missing or foreign secret references",async()=>{
  for(const secret of [undefined,webhookKeys("456")]){
    const f=await webhookConfigured();f.env.AIKO_BROWSER_WATCH_WEBHOOK_KEYS=secret;
    const response=await f.request(path);expect(response.status).toBe(200);expect((await response.json() as any).result.actions).toEqual([]);
    expect(f.events().some(e=>e.type==="AikoChannelBindingIntent")).toBe(false);expect(f.requests).toHaveLength(0);
  }
},30000);

test("same-ID secret or URL rotation cannot rebind the retained Worker channel across restart",async()=>{
  for(const field of ["secret","url"]){
    const f=await webhookConfigured();expect((await f.request(path)).status).toBe(200);
    const original=f.events().filter(e=>e.type==="AikoChannelBindingIntent");
    if(field==="secret")f.env.AIKO_BROWSER_WATCH_WEBHOOK_KEYS=webhookKeys(owner,"CHANGED_PRIVATE_WEBHOOK_KEY_00000000000000");
    else{f.config.owners[owner]!.webhooks![0]!.url="https://hooks.receiver.com/changed";f.env.AIKO_BROWSER_WATCH_CONFIG=JSON.stringify(f.config);}
    const cut=await f.request(path);expect([200,409]).toContain(cut.status);if(cut.status===200)expect((await cut.json() as any).result.actions).toEqual([]);
    await f.restart();const response=await f.request(path);expect(response.status).toBe(200);expect((await response.json() as any).result.actions).toEqual([]);
    expect(f.events().filter(e=>e.type==="AikoChannelBindingIntent")).toEqual(original);expect(f.requests).toHaveLength(0);expect(f.jobs).toHaveLength(0);
  }
},30000);

test("new destination identity installs a new native channel while removal never remaps the old identity",async()=>{
  const f=await webhookConfigured();expect((await f.request(path)).status).toBe(200);
  const original=f.events().filter(e=>e.type==="AikoChannelBindingIntent");
  f.config.owners[owner]!.webhooks![0]={...f.config.owners[owner]!.webhooks![0]!,id:"requests-v2",signingKeyRef:"requests-v2",url:"https://hooks.receiver.com/v2"};
  f.config.owners[owner]!.actions[0]!.action={kind:"webhook",destination:"requests-v2"};f.env.AIKO_BROWSER_WATCH_CONFIG=JSON.stringify(f.config);
  await f.restart();const response=await f.request(path);expect(response.status).toBe(200);expect((await response.json() as any).result.actions[0].action.destination).toBe("requests-v2");
  const intents=f.events().filter(e=>e.type==="AikoChannelBindingIntent");expect(intents).toHaveLength(2);expect(intents[0]).toEqual(original[0]);
  expect(intents.map(e=>e.binding.generation)).toEqual([1,1]);
  delete f.env.AIKO_BROWSER_WATCH_CONFIG;expect((await f.request(path)).status).toBe(409);
  await f.restart();expect((await f.request(path)).status).toBe(503);expect(f.events().filter(e=>e.type==="AikoChannelBindingIntent")).toEqual(intents);
},30000);

test("Worker resumes an exact retained webhook binding intent after a crash before BindingReady",async()=>{
  const f=await webhookConfigured();let pending:Uint8Array|undefined;
  const transaction=f.storage().transactionSync;
  f.storage().transactionSync=(fn:()=>unknown)=>{
    const result=transaction(fn);
    if(!pending&&f.db().query("SELECT name FROM sqlite_master WHERE name='aiko_thread_events'").get()){
      const rows=f.events();if(rows.some(e=>e.type==="AikoChannelBindingIntent")&&!rows.some(e=>e.type==="AikoChannelBindingReady"))pending=f.db().serialize();
    }
    return result;
  };
  expect((await f.request(path)).status).toBe(200);expect(pending).toBeDefined();
  const first=f.events().find(e=>e.type==="AikoChannelBindingIntent");
  await f.restore(pending!);expect(f.events().some(e=>e.type==="AikoChannelBindingReady")).toBe(false);
  const response=await f.request(path);expect(response.status).toBe(200);expect((await response.json() as any).result.actions).toHaveLength(1);
  expect(f.events().filter(e=>e.type==="AikoChannelBindingIntent")).toEqual([first]);
  expect(f.events().filter(e=>e.type==="AikoChannelBindingReady")).toHaveLength(1);expect(f.requests).toHaveLength(0);
},30000);
