/** Isolated pinned-browser witness. No user profile is used; the opt-in live test contacts its push service.
 * The synthetic push case proves CDP/worker delivery, NOT subscribed Web Push.
 * Run with UNLOCK_BACKGROUND_BROWSER_DIRECTORY=<verified pinned directory>. */
import { expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { verifyCloakBrowser, CLOAK_BROWSER_VERSION, CLOAK_BROWSER_TREE_SHA256 } from "@unbrowse/browser-harness/install-cloakbrowser"
import { CdpBackgroundListener, type BackgroundObservation } from "../src/cdp-background-listener"
const directory = process.env.UNLOCK_BACKGROUND_BROWSER_DIRECTORY
const until = async (check: () => boolean | Promise<boolean>, reason: string) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(25) }
  throw new Error(`Browser witness unavailable: ${reason}`)
}
async function launch(executable: string, profile: string, externalPush = false, stopped?: () => void) {
  await rm(`${profile}/DevToolsActivePort`, { force: true })
  const diagnostics=externalPush&&globalThis.process.env.UNLOCK_BACKGROUND_PUSH_DIAGNOSTICS==="1";
  const diagnosticArgs=diagnostics?[`--log-net-log=${profile}/netlog.json`,"--net-log-capture-mode=Default","--enable-logging=file",`--log-file=${profile}/gcm.log`,"--vmodule=gcm*=1,push_messaging*=1,instance_id*=1"]:[];
  const process = Bun.spawn([executable, "--headless=new", "--no-sandbox", "--disable-extensions", "--password-store=basic", ...(externalPush ? [] : ["--disable-background-networking"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`, ...diagnosticArgs, "about:blank"], { stdout: "ignore", stderr: "ignore" })
  let port = "", path = ""
  await until(async () => { try { [port = "", path = ""] = (await readFile(`${profile}/DevToolsActivePort`, "utf8")).trim().split("\n"); return !!port && !!path } catch { return false } }, "CDP endpoint").catch(async error => { process.kill(); await process.exited; stopped?.(); throw error })
  const endpoint = `ws://127.0.0.1:${port}${path}`, socket = new WebSocket(endpoint)
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)), call = pending.get(message.id)
    if (call) { pending.delete(message.id); clearTimeout(call.timer); if (message.error) call.reject(new Error(`Fixture CDP rejected: ${message.error.message}`)); else call.resolve(message.result) }
  })
  await until(() => socket.readyState === WebSocket.OPEN, "CDP socket").catch(async error => { socket.close(); process.kill(); await process.exited; stopped?.(); throw error })
  const rpc = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(`Fixture CDP timed out: ${method}`)) }, 5000)
    pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { endpoint, rpc, async close() { socket.close(); for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Fixture closing")) }; pending.clear(); process.kill(); await process.exited; stopped?.();
    const diagnostic = diagnostics ? await sanitizedPushDiagnostics(profile) : undefined;
    if(diagnostic)console.info("Isolated push diagnostic:",JSON.stringify(diagnostic));
    return { processStopped: true, ...(diagnostic ? { diagnostics: diagnostic } : {}) };
  } }
}

/** Read only fixed structural facts; raw logs die with this disposable profile. */
async function sanitizedPushDiagnostics(profile:string){
  const out:{netlogReadable:boolean;eventCount:number;pushHosts:string[];networkErrors:number[];httpStatuses:number[];gcmSignals:Record<string,number>}={netlogReadable:false,eventCount:0,pushHosts:[],networkErrors:[],httpStatuses:[],gcmSignals:{}};
  const hosts=new Set<string>(),errors=new Set<number>(),statuses=new Set<number>();
  try{
    const raw=await readFile(`${profile}/netlog.json`,"utf8");
    if(Buffer.byteLength(raw)>16_000_000)throw Error("diagnostic bound");
    const log=JSON.parse(raw);
    out.netlogReadable=true;out.eventCount=Array.isArray(log.events)?log.events.length:0;
    for(const event of log.events??[]){
      const p=event.params??{};
      for(const candidate of [p.url,p.original_url,p.host,p.host_and_port]){
        if(typeof candidate!=="string")continue;
        try{const host=new URL(candidate.includes("://")?candidate:`https://${candidate}`).hostname;if(/^(android\.clients|mtalk|fcm|fcmregistrations)\.google(?:apis)?\.com$/.test(host))hosts.add(host);}catch{}
      }
      if(Number.isInteger(p.net_error)&&p.net_error<0)errors.add(p.net_error);
      for(const line of Array.isArray(p.headers)?p.headers:[]){if(typeof line!=="string")continue;const match=/^HTTP\/[^ ]+ (\d{3})\b/.exec(line);if(match)statuses.add(Number(match[1]));}
    }
  }catch{}
  try{
    const raw=await readFile(`${profile}/gcm.log`,"utf8");
    if(Buffer.byteLength(raw)>4_000_000)throw Error("diagnostic bound");
    const signals={initialCheckin:"Starting initial GCM checkin",checkinRejected:"Checkin rejected",storeResetFailed:"Failed to reset GCM store",gcmStop:"Stopping the GCM Client",tokenCannotStart:"Unable to get the InstanceID token: cannot start the GCM Client",instanceCannotStart:"Unable to get the InstanceID data: cannot start the GCM Client"};
    for(const [key,signal]of Object.entries(signals))out.gcmSignals[key]=raw.split(signal).length-1;
  }catch{}
  out.pushHosts=[...hosts].sort();out.networkErrors=[...errors].sort((a,b)=>a-b);out.httpStatuses=[...statuses].sort((a,b)=>a-b);return out;
}

;(directory ? test : test.skip)("pinned browser observes private notification, closed-tab synthetic push, renewal, reconnect, restart and profile isolation", async () => {
  const executable = await verifyCloakBrowser(directory)
  const firstProfile = await mkdtemp(`${tmpdir()}/unlock-bg-first-`), secondProfile = await mkdtemp(`${tmpdir()}/unlock-bg-second-`)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const worker = new URL(request.url).pathname === "/sw.js"
    return new Response(worker ? `self.addEventListener('push', event => event.waitUntil(self.registration.showNotification('Closed site fixture', { body: event.data.text(), tag: 'fixture' })));` : "<title>Isolated notification fixture</title>", { headers: { "content-type": worker ? "application/javascript" : "text/html" } })
  } })
  const origin = server.url.origin, events: BackgroundObservation[] = [], otherEvents: BackgroundObservation[] = [], registeredAtMs = Date.now()
  let browser: Awaited<ReturnType<typeof launch>> | undefined, other: Awaited<ReturnType<typeof launch>> | undefined, collector: CdpBackgroundListener | undefined, isolated: CdpBackgroundListener | undefined
  const collect = (values: BackgroundObservation[], cut = registeredAtMs) => new CdpBackgroundListener({ origins: [origin], registeredAtMs: cut, onEvent: async e => { values.push(e) } })
  try {
    browser = await launch(executable, firstProfile)
    expect((await browser.rpc("Browser.getVersion")).product).toBe(`Chrome/${CLOAK_BROWSER_VERSION.slice(0, -2)}`)
    collector = collect(events); await collector.connect(browser.endpoint)
    expect(collector.health.state).toBe("watching")
    other = await launch(executable, secondProfile); isolated = collect(otherEvents); await isolated.connect(other.endpoint)
    const site = await browser.rpc("Target.createTarget", { url: origin }), attached = await browser.rpc("Target.attachToTarget", { targetId: site.targetId, flatten: true }), session = attached.sessionId
    const evaluate = async (expression: string) => {
      const result = await browser!.rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session)
      if (result.exceptionDetails) throw new Error(`Fixture script failed: ${result.exceptionDetails.text}`)
      return result.result.value
    }
    await until(() => evaluate("document.readyState === 'complete' && !!navigator.serviceWorker"), "service worker page")
    await browser.rpc("Browser.setPermission", { permission: { name: "notifications" }, setting: "granted", origin })
    await evaluate("(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;return true})()")
    await evaluate("(async()=>{const r=await navigator.serviceWorker.ready;await r.showNotification('Visible local fixture',{body:'private fixture body'});return true})()")
    await until(() => events.some(e => e.service === "notifications"), "notification display")
    expect(events.find(e => e.service === "notifications")?.eventMetadata.some(v => v.key === "Body" && v.value === "private fixture body")).toBe(true)
    const controller = await browser.rpc("Target.attachToTarget", { targetId: collector.observerTargetId, flatten: true })
    await browser.rpc("ServiceWorker.enable", {}, controller.sessionId)
    await browser.rpc("Target.closeTarget", { targetId: site.targetId })
    await browser.rpc("ServiceWorker.deliverPushMessage", { origin, registrationId: events[0]!.serviceWorkerRegistrationId, data: "synthetic local payload" }, controller.sessionId)
    await until(() => events.some(e => e.service === "notifications" && e.eventMetadata.some(v => v.value === "synthetic local payload")), "closed-tab notification")
    expect(collector.health.state).toBe("watching")
    expect(events.some(e => e.service === "pushMessaging" && e.eventMetadata.some(v => v.key === "Payload" && v.value === "synthetic local payload"))).toBe(true)
    await isolated.flush(); expect(otherEvents).toEqual([])
    await browser.rpc("BackgroundService.setRecording", { service: "notifications", shouldRecord: false }, controller.sessionId)
    await until(() => collector!.health.state === "degraded", "recording stop")
    await collector.renewRecording(); expect(collector.health.state).toBe("watching")
    const captured = events.length
    await collector.close(); collector = collect(events); await collector.connect(browser.endpoint)
    await until(() => events.length > captured, "retained CDP replay")
    expect(events.every(e => !e.historical)).toBe(true) // Host must deduplicate same subscribed occurrences.
    await collector.close(); await browser.close(); browser = undefined
    const replay: BackgroundObservation[] = []
    browser = await launch(executable, firstProfile); collector = collect(replay, Date.now() + 1000); await collector.connect(browser.endpoint)
    await until(() => replay.some(e => e.service === "notifications"), "browser restart retained events")
    expect(replay.every(e => e.historical)).toBe(true)
    await isolated.flush(); expect(otherEvents).toEqual([])
  } finally {
    await collector?.close(); await isolated?.close(); await browser?.close(); await other?.close(); await server.stop(true)
    await rm(firstProfile, { recursive: true, force: true }); await rm(secondProfile, { recursive: true, force: true })
  }
}, 30_000)

/** Explicit opt-in: sends only to the fresh test browser's own subscription.
 * Supply web-push@3.6.7 from an isolated test installation via
 * UNLOCK_WEB_PUSH_MODULE=/.../node_modules/web-push/src/index.js.
 * UNLOCK_BACKGROUND_SUBSCRIBE_CONTEXT=service-worker uses a normal message to the controlled worker.
 * Optional absolute UNLOCK_BACKGROUND_PUSH_RECEIPT retains structural results after cleanup.
 * The test FAILS when push-service registration/delivery is unavailable. */
;(directory && process.env.UNLOCK_BACKGROUND_LIVE_PUSH === "1" ? test : test.skip)("real subscribed Web Push reaches owned observer after site tab closes", async () => {
  const modulePath = process.env.UNLOCK_WEB_PUSH_MODULE
  if (!modulePath?.startsWith("/")) throw new Error("Supply the host-owned absolute UNLOCK_WEB_PUSH_MODULE test dependency path")
  const subscribeContext = process.env.UNLOCK_BACKGROUND_SUBSCRIBE_CONTEXT ?? "document"
  if (!["document", "service-worker"].includes(subscribeContext)) throw Error("Invalid subscription context")
  const receiptPath = process.env.UNLOCK_BACKGROUND_PUSH_RECEIPT
  if (receiptPath && !receiptPath.startsWith("/")) throw Error("Push receipt path must be absolute")
  const receipt: Record<string, any> = { gate: "B01", result: "not-proven", subscribeContext, startedAt: new Date().toISOString(), subscription: {state:"not-started"}, delivery: {attempted:false,siteTabClosed:false,pushObserved:false,notificationObserved:false}, provenance: {version:CLOAK_BROWSER_VERSION,treeSHA256:CLOAK_BROWSER_TREE_SHA256}, cleanup: {processStopped:false,profileRemoved:false,serverStopped:false} }
  const webPush = (await import(modulePath)).default
  const keys = webPush.generateVAPIDKeys(), executable = await verifyCloakBrowser(directory)
  const profile = await mkdtemp(`${tmpdir()}/unlock-bg-subscribed-`), events: BackgroundObservation[] = []
  const payload = `isolated-browser-witness-${crypto.randomUUID()}`
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const worker = new URL(request.url).pathname === "/sw.js"
    return new Response(worker ? `self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('message', event => {
        if(event.data?.type !== 'subscribe-owned-fixture' || !event.ports[0]) return;
        const port=event.ports[0];
        port.postMessage({state:'running',stage:'subscribing-in-worker'});
        event.waitUntil((async()=>{try {
          const subscription=await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:new Uint8Array(event.data.applicationServerKey)});
          port.postMessage({state:'subscribed',value:subscription.toJSON()});
        } catch(error) {port.postMessage({state:'failed',stage:'subscribing-in-worker',name:error.name});}})());
      });
      self.addEventListener('push', event => event.waitUntil(self.registration.showNotification('Isolated subscribed push', { body: event.data.text() })));` : "<title>Isolated subscribed push fixture</title>", { headers: { "content-type": worker ? "application/javascript" : "text/html" } })
  } })
  const origin = server.url.origin
  let browser: Awaited<ReturnType<typeof launch>> | undefined, collector: CdpBackgroundListener | undefined
  try {
    browser = await launch(executable, profile, true, () => { receipt.cleanup.processStopped = true })
    collector = new CdpBackgroundListener({ origins: [origin], registeredAtMs: Date.now(), onEvent: async e => { events.push(e) } }); await collector.connect(browser.endpoint)
    const page = await browser.rpc("Target.createTarget", { url: origin }), attached = await browser.rpc("Target.attachToTarget", { targetId: page.targetId, flatten: true }), session = attached.sessionId
    const evaluate = async (expression: string) => {
      const value = await browser!.rpc("Runtime.evaluate", { expression, returnByValue: true, userGesture: true }, session)
      if (value.exceptionDetails) throw new Error(`Subscription fixture script failed: ${value.exceptionDetails.text}`)
      return value.result.value
    }
    await until(() => evaluate("document.readyState === 'complete' && !!navigator.serviceWorker"), "subscription page")
    await browser.rpc("Browser.grantPermissions", { permissions: ["notifications"], origin })
    const applicationServerKey = JSON.stringify([...Buffer.from(keys.publicKey, "base64url")])
    const subscribe = subscribeContext === "service-worker"
      ? `globalThis.subscriptionProbe.stage='waiting-for-controlled-worker'; if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true})); const channel=new MessageChannel(); channel.port1.onmessage=event=>{globalThis.subscriptionProbe=event.data}; navigator.serviceWorker.controller.postMessage({type:'subscribe-owned-fixture',applicationServerKey:${applicationServerKey}},[channel.port2]);`
      : `globalThis.subscriptionProbe.stage='subscribing'; const subscription=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:new Uint8Array(${applicationServerKey})}); globalThis.subscriptionProbe={state:'subscribed',value:subscription.toJSON()};`
    await evaluate(`globalThis.subscriptionProbe = {state:'running',stage:'registering-worker'}; (async()=>{try{await navigator.serviceWorker.register('/sw.js');globalThis.subscriptionProbe.stage='waiting-worker-ready'; const r=await navigator.serviceWorker.ready;${subscribe}}catch(error){globalThis.subscriptionProbe={state:'failed',stage:globalThis.subscriptionProbe.stage,name:error.name}}})()`)
    let result: any
    for (let attempt = 0; attempt < 150; attempt++) {
      result = await evaluate("globalThis.subscriptionProbe")
      if (result.state !== "running") break
      await Bun.sleep(200)
    }
    receipt.subscription = {state:result.state,stage:result.stage,...(result.name?{error:result.name}:{}),permission:await evaluate("Notification.permission"),secureContext:await evaluate("isSecureContext"),controlled:await evaluate("!!navigator.serviceWorker.controller")}
    const actualVersion=await browser.rpc("Browser.getVersion")
    receipt.browser={product:actualVersion.product,revision:actualVersion.revision,protocol:actualVersion.protocolVersion}
    if (result.state !== "subscribed") {
      const diagnosticPage = await browser.rpc("Target.createTarget", { url: "chrome://gcm-internals/" }), diagnostic = await browser.rpc("Target.attachToTarget", { targetId: diagnosticPage.targetId, flatten: true })
      await Bun.sleep(250)
      const state = await browser.rpc("Runtime.evaluate", { expression: `Object.fromEntries(['gcm-enabled','gcm-client-state','connection-client-created','connection-state'].map(id=>[id,document.getElementById(id)?.innerText]))`, returnByValue: true }, diagnostic.sessionId)
      const permission = await evaluate("Notification.permission")
      const secureContext = await evaluate("isSecureContext")
      const version = await browser.rpc("Browser.getVersion")
      receipt.subscription.gcm = state.result.value
      throw new Error(`Real push registration unavailable: ${JSON.stringify({ state: result.state, stage: result.stage, error: result.name, permission, secureContext, browser: {product:version.product,revision:version.revision,protocol:version.protocolVersion}, gcm: state.result.value })}`)
    }
    expect((await browser.rpc("Target.closeTarget", { targetId: page.targetId })).success).toBe(true)
    expect((await browser.rpc("Target.getTargets")).targetInfos.some((target: any) => target.targetId === page.targetId)).toBe(false)
    receipt.delivery.siteTabClosed = true
    // Subscription is private ephemeral test data; it never enters test output.
    let response: { statusCode: number }
    receipt.delivery.attempted = true
    try { response = await webPush.sendNotification(result.value, payload, { TTL: 60, timeout: 10_000, vapidDetails: { subject: "mailto:unlock-browser-test@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey } }) }
    catch (error) { throw new Error(`Isolated Web Push delivery failed (HTTP ${typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : "unavailable"})`) }
    receipt.delivery.httpStatus = response.statusCode
    expect(response.statusCode).toBeGreaterThanOrEqual(200); expect(response.statusCode).toBeLessThan(300)
    await until(() => events.some(e => e.service === "pushMessaging" && e.eventName === "Push message received" && e.eventMetadata.some(v => v.key === "Payload" && v.value === payload)), "genuine received push payload")
    receipt.delivery.pushObserved = true
    await until(() => events.some(e => e.service === "notifications" && e.eventMetadata.some(v => v.key === "Body" && v.value === payload)), "genuine push notification")
    expect(collector.health.state).toBe("watching")
    receipt.delivery.notificationObserved = true
    receipt.result = "proven"
  } finally {
    try { await collector?.close() } finally {
      try { const stopped=await browser?.close(); if(stopped) {receipt.cleanup.processStopped=stopped.processStopped;receipt.diagnostics=stopped.diagnostics} } finally {
        try { await server.stop(true);receipt.cleanup.serverStopped=true } finally {
          await rm(profile, { recursive: true, force: true })
          receipt.cleanup.profileRemoved=await access(profile).then(()=>false,()=>true)
          receipt.completedAt=new Date().toISOString()
          if(receiptPath)await writeFile(receiptPath,JSON.stringify(receipt,null,2))
        }
      }
    }
  }
}, 50_000)


test("push diagnostics retain structural failures without subscription endpoints or credential values",async()=>{
  const profile=await mkdtemp(`${tmpdir()}/unlock-push-diagnostic-redaction-`);
  try{
    await writeFile(`${profile}/netlog.json`,JSON.stringify({events:[
      {params:{url:"https://fcm.googleapis.com/private-subscription-endpoint?token=private-token",headers:["HTTP/1.1 401 Unauthorized","Authorization: private-credential"],net_error:-3}},
      {params:{host:"mtalk.google.com:5228",headers:["Cookie: private-cookie"]}},
      {params:{url:"https://unrelated-private.example/path",payload:"private-payload"}}
    ]}));
    await writeFile(`${profile}/gcm.log`,"Starting initial GCM checkin. private-device-id\nCheckin rejected. private-token\n");
    const result=await sanitizedPushDiagnostics(profile);
    expect(result).toMatchObject({netlogReadable:true,eventCount:3,pushHosts:["fcm.googleapis.com","mtalk.google.com"],networkErrors:[-3],httpStatuses:[401],gcmSignals:{initialCheckin:1,checkinRejected:1}});
    expect(JSON.stringify(result)).not.toContain("private");
  }finally{await rm(profile,{recursive:true,force:true});}
});
