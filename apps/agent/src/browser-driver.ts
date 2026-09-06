import { Database } from "bun:sqlite";
import { nodeStorage } from "../../../packages/entity-learn/lib/storage-node.ts";
import type { Event } from "tardie/core/event";
import { createRequestEmbedding } from "./request-embedding.ts";
import type {
  HarnessTransport,
  HarnessTransportRequest,
} from "../../../packages/browser-runtime/src/harness-runtime.ts";
import { RequestMemory } from "./request-memory.ts";
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBrowserClient,
  AGENT_BROWSER_AGENT_DAEMON_ACTIONS,
  type AgentBrowserAgentAction,
  type AgentBrowserCallWindow,
} from "@unbrowse/browser-runtime";
import { CdpNetworkListener } from "@unbrowse/browser-runtime/network-listener";
import { BrowserLearning } from "./browser-learning.ts";
import { createPublicProxy, publicTarget } from "./browser-proxy.ts";

export interface BrowserDriver {
  execute(
    action: AgentBrowserAgentAction,
    signal?: AbortSignal,
  ): Promise<unknown>;
  requestTransport?: HarnessTransport;
  requestSearch?: RequestMemory["search"];
  requestRehydrate?(
    pointerId: string,
    inputs?: Record<
      string,
      import("../../../packages/browser-runtime/src/harness-runtime.ts").HarnessJsonValue
    >,
    signal?: AbortSignal,
  ): Promise<
    Awaited<ReturnType<RequestMemory["hydrate"]>> & {
      hydration?: { body: unknown };
    }
  >;
  sessionContext?(): Promise<PrivateBrowserContext>;
  installSession?(input: PrivateSessionInstall, signal?: AbortSignal): Promise<PrivateSessionAck>;
  clearSession?(scope: PrivateSessionScope, signal?: AbortSignal): Promise<void>;
  screenshot?(signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}
export type BrowserDriverFactory = (options: {
  domains: readonly string[];
  owner?: string;
  emit: (event: object) => Promise<void>;
  signal?: AbortSignal;
}) => Promise<BrowserDriver>;
/** Uses the actual playground process/telemetry adapter, not its older model loop. */
export function browserDriverFactory(
  executablePath: string,
  options: { persistentDirectory?: string } = {},
): BrowserDriverFactory {
  return async ({ domains, emit, owner, signal: initialSignal }) => {
    initialSignal?.throwIfAborted();
    const identity = crypto.randomUUID();
    const principal = owner ?? identity;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(principal))
      throw new Error("Invalid browser owner");
    const persistent = options.persistentDirectory;
    if (persistent) await mkdir(persistent, { recursive: true, mode: 0o700 });
    const directory =
      persistent ?? (await mkdtemp(join(tmpdir(), "aiko-browser-")));
    const proxy = await createPublicProxy().catch(async (error) => {
      if (!persistent) await rm(directory, { recursive: true, force: true });
      throw error;
    });
    const configPath = join(directory, "config.json"),
      actionPolicyPath = join(directory, "policy.json");
    const socketDirectory = join(directory, "sockets"),
      temporaryDirectory = join(directory, "temp"),
      home = join(directory, "home");
    let sequence = 0,
      calls = 0,
      failed = false,
      opened = false,
      closed = false;
    let tail = Promise.resolve();
    const lifetime = new AbortController();
    const evidenceDb = new Database(join(directory, "request-evidence.sqlite"));
    evidenceDb.exec(
      "CREATE TABLE IF NOT EXISTS principal(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL)",
    );
    evidenceDb
      .query("INSERT OR IGNORE INTO principal(id,owner) VALUES(1,?)")
      .run(principal);
    const existingOwner = evidenceDb
      .query("SELECT owner FROM principal LIMIT 1")
      .get() as { owner: string } | null;
    if (existingOwner && existingOwner.owner !== principal) {
      evidenceDb.close();
      await proxy.close();
      throw new Error("Browser memory owner mismatch");
    }
    const pointerStorage = nodeStorage(
      join(directory, "request-memory.sqlite"),
    );
    let memory: RequestMemory;
    let hydrationBody: unknown;
    const learning = new BrowserLearning({
      browserSession: (origin) =>
        !closed && replayEndpoint
          ? { id: "implicit-browser-session-v1", origin }
          : undefined,
      threadId: identity,
      nextSequence: () => ++sequence,
      emit: async (event) => {
        await emit(event);
        evidenceDb
          .query("INSERT INTO evidence(event) VALUES(?)")
          .run(JSON.stringify(event));
      },
      onPrepared: async (event, responses, semantics) => {
        const concepts = [
          ...new Set(
            [...semantics.values()]
              .flatMap((v) => v.concepts)
              .filter((c) => /^[a-z][a-z _-]{0,79}$/i.test(c)),
          ),
        ].slice(0, 16);
        try {
          await memory.index(
            event.toolDigest,
            concepts.length ? concepts : ["response"],
            responses,
            lifetime.signal,
          );
        } catch {
          await emit({
            type: "AikoRequestMemoryIndexUnavailable",
            toolDigest: event.toolDigest,
          });
        }
      },
    });
    const network = new CdpNetworkListener(
      (entry, index, complete) => learning.observe(entry, index, complete),
      undefined,
      lifetime.signal,
    );
    const windows = new Map<string, AgentBrowserCallWindow>();
    let targetOrigin: string | undefined;
    let replayEndpoint: string | undefined;
    let started = false;
    let cookieConnection: Awaited<ReturnType<typeof openPrivateBrowserCdp>> | undefined;
    let cookieAdapter: import("../../../packages/sdk/src/agent.ts").PrivateBrowserAdapter | undefined;
    const context: PrivateBrowserContext = {owner: principal, contextId: identity, generation: 1};
    evidenceDb.exec("CREATE TABLE IF NOT EXISTS unlock_session_metadata(binding TEXT PRIMARY KEY,metadata TEXT NOT NULL)");
    const sessions = new PrivateBrowserSessions(context, async () => {
      await startBrowser();
      if (!cookieAdapter) {
        cookieConnection = await openPrivateBrowserCdp(replayEndpoint!, lifetime.signal);
        const targets = await cookieConnection.send("Target.getTargets", {});
        const pages = targets.targetInfos.filter((target: any) => target.type === "page");
        if (pages.length !== 1 || typeof pages[0].browserContextId !== "string") throw new Error("Exclusively owned browser context unavailable");
        cookieAdapter = await createOwnedCookieAdapter(cookieConnection, {browserContextId: pages[0].browserContextId, targetId: pages[0].targetId});
      }
      return cookieAdapter;
    }, record => {
      const binding=JSON.stringify([record.tenantId,record.profileId,record.runtimeId,record.connectionId]);
      evidenceDb.query("INSERT INTO unlock_session_metadata(binding,metadata) VALUES(?,?) ON CONFLICT(binding) DO UPDATE SET metadata=excluded.metadata").run(binding,JSON.stringify(record));
    }, (evidenceDb.query("SELECT metadata FROM unlock_session_metadata").all() as {metadata:string}[]).map(row=>JSON.parse(row.metadata)));
    const flush = async () => {
      await tail;
      if (failed) throw new Error("Trace persistence failed");
    };
    const policy = (agent: boolean) =>
      writeFile(
        actionPolicyPath,
        JSON.stringify({
          default: "deny",
          allow: agent
            ? ["launch", "screenshot", ...AGENT_BROWSER_AGENT_DAEMON_ACTIONS]
            : [
                "launch",
                "navigate",
                "cdp_url",
                "stream_enable",
                "stream_status",
                "close",
              ],
        }),
        { mode: 0o600 },
      );
    let client: AgentBrowserClient;
    try {
      for (const path of [socketDirectory, temporaryDirectory, home])
        await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(
        configPath,
        JSON.stringify({
          executablePath,
          ...(persistent ? { profile: join(directory, "profile") } : {}),
          proxy: proxy.url,
          proxyBypass: "<-loopback>",
          args: "--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--webrtc-ip-handling-policy=disable_non_proxied_udp",
        }),
        { mode: 0o600 },
      );
      await policy(false);
      initialSignal?.throwIfAborted();
      // The native daemon combines namespace/session in a <=103-byte Unix socket path.
      const suffix = identity.replaceAll("-", "").slice(0, 8);
      client = new AgentBrowserClient({
        isolation: {
          configPath,
          actionPolicyPath,
          socketDirectory,
          temporaryDirectory,
          session: `b${suffix}`,
          namespace: `t${suffix}`,
          allowedDomains: domains,
          publicProxy: proxy.url,
        },
        // No personal HOME, profile, credential file or inherited browser/provider settings.
        env: {
          HOME: home,
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          TMPDIR: temporaryDirectory,
        },
        controlTimeoutMs: 30_000,
        rollingTrace: true,
        trace: {
          threadId: identity,
          nextSequence: () => ++sequence,
          nextCallId: () => `call-${++calls}`,
          publish: (event) => {
            tail = tail
              .then(() => emit(event))
              .catch(() => {
                failed = true;
              });
          },
        },
      });
    } catch (error) {
      pointerStorage.close();
      evidenceDb.close();
      await proxy.close();
      if (!persistent) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    async function startBrowser() {
      if (started) return;
      let status = await client.streamStatus();
      if (!status.enabled) status = await client.streamEnable();
      if (status.port === null) throw new Error("Browser telemetry unavailable");
      await client.connectTelemetry(status.port);
      replayEndpoint = await client.networkObservationEndpoint();
      await network.connect(replayEndpoint);
      started = true;
    }
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await sessions.close();
        cookieConnection?.close();
        await policy(false);
        lifetime.abort();
        await network.stopAndSnapshot().catch(() => undefined);
        client.disconnectTelemetry();
        await client.closeAll();
      } finally {
        pointerStorage.close();
        evidenceDb.close();
        await proxy.close();
        if (!persistent) await rm(directory, { recursive: true, force: true });
      }
    };
    const requestTransport: HarnessTransport = {
      send: async (request) => {
        if (closed || !opened || !replayEndpoint || !targetOrigin)
          throw new Error("Owned browser session unavailable");
        return sessions.run(request.url, () => replayBrowserRequest(
          replayEndpoint!, targetOrigin!, request, lifetime.signal,
        ));
      },
    };
    memory = new RequestMemory({
      owner: principal,
      storage: pointerStorage,
      readOwnedEvents: async () =>
        (
          evidenceDb
            .query(
              "SELECT event FROM (SELECT id,event FROM evidence ORDER BY id DESC LIMIT 10000) ORDER BY id",
            )
            .all() as { event: string }[]
        ).map((row) => JSON.parse(row.event) as Event),
      embedding: createRequestEmbedding(join(directory, "models")),
      embedResponseValues: true,
      transport: requestTransport,
      authorizeSession: async (requirements) =>
        !!replayEndpoint &&
        !closed &&
        requirements.every((id) => id === "implicit-browser-session-v1"),
      consume: async (response) => {
        hydrationBody = response.body;
      },
    });
    let hydrating = false;
    return {
      sessionContext: async () => ({...context}),
      installSession: (input, signal) => sessions.install(input, signal),
      clearSession: (scope, signal) => sessions.clear(scope, signal),
      requestTransport,
      requestSearch: (query, limit, signal) =>
        memory.search(query, limit, signal),
      requestRehydrate: async (pointerId, inputs, signal) => {
        if (hydrating) throw new Error("Browser hydration busy");
        hydrating = true;
        hydrationBody = undefined;
        try {
          const receipt = await memory.hydrate(pointerId, inputs, signal);
          return {
            ...receipt,
            ...(receipt.status === "completed" && receipt.consumed
              ? { hydration: { body: hydrationBody ?? null } }
              : {}),
          };
        } finally {
          hydrationBody = undefined;
          hydrating = false;
        }
      },
      close,
      screenshot: async (signal) => {
        if (closed || !opened)
          throw new Error("No active owned page to capture");
        const path = join(
          temporaryDirectory,
          `capture-${crypto.randomUUID()}.png`,
        );
        try {
          await client.captureScreenshot(path, signal);
          await flush();
          const file = await open(path, "r");
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size < 8 || stat.size > 8 * 1024 * 1024)
              throw new Error("Screenshot size invalid");
            const bytes = new Uint8Array(await file.readFile());
            if (
              [137, 80, 78, 71, 13, 10, 26, 10].some(
                (byte, index) => bytes[index] !== byte,
              )
            )
              throw new Error("Screenshot is not PNG");
            return bytes;
          } finally {
            await file.close();
          }
        } finally {
          await rm(path, { force: true });
        }
      },
      execute: async (action, signal) => sessions.run(action.action === "navigate" ? action.url : targetOrigin, async () => {
        if (closed) throw new Error("Browser session closed");
        await flush();
        const active = AbortSignal.any([
          lifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        if (action.action === "navigate")
          targetOrigin = publicTarget(action.url).origin;
        const capture = async () => {
          await network.flush();
          await flush();
          for (const window of client.callWindows)
            windows.set(window.callId, window);
          while (windows.size > 4096)
            windows.delete(windows.keys().next().value!);
          if (client.telemetryComplete && targetOrigin && !active.aborted) {
            const result = await learning.compile(
              await network.snapshot(),
              [...windows.values()],
              targetOrigin,
            );
            await emit({
              type: "AikoBrowserLearningCheckpoint",
              id: `${identity}:${sequence}:${network.requestCount}`,
              observed: network.requestCount,
              prepared: result.prepared,
              pending: result.pending,
              fallbacks: result.fallbacks ?? [],
              at: Date.now(),
            });
          }
          await flush();
        };
        if (!opened) {
          if (action.action !== "navigate")
            throw new Error("Navigate before using page tools");
          await startBrowser();
          await client.open(action.url, null, active);
          await flush();
          await capture();
          await policy(true);
          opened = true;
          await flush();
          return {
            navigation: "completed",
            note: persistent
              ? "Use snapshot to inspect the current browser. This account's own persistent browser profile is retained; no other account profile is imported."
              : "Use snapshot to inspect this fresh browser. No prior profile or cookies were imported.",
          };
        }
        try {
          const result = await client.executeAgentAction(action, null, active);
          await capture();
          return result.output;
        } catch (error) {
          await flush();
          throw error;
        }
      }),
    };
  };
}

/** Fixed CDP program; callers cannot select JavaScript, CDP methods or another page origin. */
export async function replayBrowserRequest(
  endpoint: string,
  origin: string,
  request: HarnessTransportRequest,
  signal?: AbortSignal,
) {
  const target = publicTarget(request.url);
  if (
    target.origin !== origin ||
    !["GET", "HEAD"].includes(request.method) ||
    request.body !== undefined ||
    request.redirect !== "manual" ||
    Object.keys(request.headers).length
  )
    throw new Error(
      "Replay requires same-origin read with browser session credentials",
    );
  const cdp = await openPrivateBrowserCdp(endpoint, signal);
  const rpc = cdp.send;
  try {
    const targets = await rpc("Target.getTargets", {});
    const pages = targets.targetInfos.filter(
      (t: any) =>
        t.type === "page" &&
        (() => {
          try {
            return new URL(t.url).origin === origin;
          } catch {
            return false;
          }
        })(),
    );
    if (pages.length !== 1) throw new Error("Ambiguous owned page");
    const { sessionId } = await rpc("Target.attachToTarget", {
      targetId: pages[0].targetId,
      flatten: true,
    });
    const expression = `(async () => { const r = ${JSON.stringify({ url: target.href, method: request.method, origin })}; if (location.origin !== r.origin) throw Error("Origin changed"); const response = await fetch(r.url, {method:r.method,credentials:"same-origin",redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(15000)}); if(response.type === "opaqueredirect") throw Error("Redirect blocked"); const text = await response.text(); if(text.length > 1000000) throw Error("Response too large"); const type = response.headers.get("content-type") || ""; return {status:response.status,headers:{"content-type":type},classification:response.status===401||response.status===403?"browser_session_required":type.includes("application/json")?"application":"site_control",body:type.includes("application/json")&&text?JSON.parse(text):undefined}; })()`;
    const result = await rpc(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails || !result.result?.value)
      throw new Error("Browser replay failed");
    return result.result.value;
  } finally {
    cdp.close();
  }
}

export async function openPrivateBrowserCdp(endpoint: string, signal?: AbortSignal) {
  const { validateObserverEndpoint } =
    await import("@unbrowse/browser-runtime/network-listener");
  const socket = new WebSocket(validateObserverEndpoint(endpoint));
  const abort = () => socket.close();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  let sequence = 0;
  const rpc = (
    method: string,
    params: object,
    sessionId?: string,
  ): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => done(new Error("Replay timed out")),
        20_000,
      );
      const done = (error?: Error, result?: unknown) => {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", closed);
        error ? reject(error) : resolve(result);
      };
      const closed = () => done(new Error("Replay disconnected"));
      const receive = (event: MessageEvent) => {
        try {
          if (typeof event.data !== "string" || event.data.length > 2_000_000)
            return done(new Error("Replay response too large"));
          const v = JSON.parse(event.data);
          if (v.id === id)
            done(
              v.error ? new Error("Replay RPC failed") : undefined,
              v.result,
            );
        } catch {
          done(new Error("Invalid replay response"));
        }
      };
      socket.addEventListener("message", receive);
      socket.addEventListener("close", closed);
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Replay connection timed out")),
        10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Replay connection failed"));
        },
        { once: true },
      );
    });
  return { send: rpc, close: () => {socket.close();signal?.removeEventListener("abort",abort);} };
}

/** Chromium reports an opaque default context ID on targets but requires Storage calls
 * to omit that ID. Normalize only this exclusively owned process's verified default context;
 * the actual SDK still validates target binding and performs scoped cookie replacement. */
export async function createOwnedCookieAdapter(cdp: import("../../../packages/sdk/src/cdp.ts").PrivateCdp, binding: {browserContextId:string;targetId:string}) {
  const {createCdpCookieAdapter}=await import("../../../packages/sdk/src/cdp.ts");
  const contexts=await cdp.send("Target.getBrowserContexts", {});
  if(!Array.isArray(contexts.browserContextIds))throw new Error("Private browser contexts unavailable");
  const isDefault=!contexts.browserContextIds.includes(binding.browserContextId);
  return createCdpCookieAdapter({send:(method,params,sessionId)=>{
    if(isDefault&&(method==="Storage.getCookies"||method==="Storage.setCookies")&&params.browserContextId===binding.browserContextId){const {browserContextId:_,...scoped}=params;return cdp.send(method,scoped,sessionId);}
    return cdp.send(method,params,sessionId);
  }},binding);
}

/** Private Unlock metadata only. Neither this lifecycle nor the SDK cookie adapter is a model tool. */
export interface PrivateBrowserContext { owner: string; contextId: string; generation: number }
export interface PrivateSessionScope extends PrivateBrowserContext {
  domain: string; tenantId: string; profileId: string; runtimeId: string; connectionId: string; allowedDomains: string[];
}
export interface PrivateSessionInstall extends PrivateSessionScope {
  connectionGeneration: number; revision: number; expiresAt: number; allowedDomains: string[];
  cookies: import("../../../packages/sdk/src/agent.ts").VaultCookie[];
}
export type PrivateSessionAck = PrivateSessionScope & { revision: number };
export type PrivateSessionRecord = Omit<PrivateSessionInstall,"cookies"> & {active:boolean;revoked:boolean};

export class PrivateBrowserSessions {
  private records = new Map<string,PrivateSessionRecord>();
  private tail:Promise<unknown> = Promise.resolve();
  private initialized=false;
  private failed=false;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(readonly context:PrivateBrowserContext,private adapter:()=>Promise<import("../../../packages/sdk/src/agent.ts").PrivateBrowserAdapter>,private save:(record:PrivateSessionRecord)=>void,records:PrivateSessionRecord[]=[],private now=()=>Date.now()) {
    for(const record of records){if(record.owner!==context.owner)throw new Error("Private session owner mismatch");this.records.set(this.key(record),{...record,active:false});}
  }
  private key(scope:PrivateSessionScope){return JSON.stringify([scope.tenantId,scope.profileId,scope.runtimeId,scope.connectionId]);}
  private check(scope:PrivateSessionScope){
    if(scope.owner!==this.context.owner||scope.contextId!==this.context.contextId||scope.generation!==this.context.generation)throw new Error("Private session context mismatch");
    if(![scope.tenantId,scope.profileId,scope.runtimeId,scope.connectionId].every(v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v)))throw new Error("Invalid private session binding");
    if(publicTarget(`https://${scope.domain}`).hostname!==scope.domain)throw new Error("Invalid private session domain");
    if(!Array.isArray(scope.allowedDomains)||!scope.allowedDomains.length||!scope.allowedDomains.includes(scope.domain)||scope.allowedDomains.some(d=>typeof d!=="string"||publicTarget(`https://${d}`).hostname!==d))throw new Error("Invalid private session domains");
  }
  private serial<T>(run:()=>Promise<T>):Promise<T>{const result=this.tail.then(run,run);this.tail=result.then(()=>{},()=>{});return result;}
  private persist(record:PrivateSessionRecord){this.save(structuredClone(record));this.records.set(this.key(record),record);}
  private async start(){
    if(this.failed)throw new Error("Private session recovery required");
    if(this.initialized)return;
    try{for(const record of this.records.values())await(await this.adapter()).replaceCookies([],record.allowedDomains);this.initialized=true;}
    catch{this.failed=true;throw new Error("Private session reset failed");}
  }
  private schedule(){
    clearTimeout(this.timer);
    const next=Math.min(...[...this.records.values()].filter(r=>r.active).map(r=>r.expiresAt));
    if(Number.isFinite(next)){this.timer=setTimeout(()=>{void this.serial(()=>this.expire()).catch(()=>{});},Math.min(2_147_483_647,Math.max(1,next-this.now())));this.timer.unref?.();}
  }
  private async expire(){
    for(const record of this.records.values())if(record.active&&record.expiresAt<=this.now())await this.erase(record);
    this.schedule();
  }
  private async erase(record:PrivateSessionRecord){
    const revoked={...record,active:false,revoked:true};
    try { this.persist(revoked); } catch { this.failed=true; }
    try{await(await this.adapter()).replaceCookies([],record.allowedDomains);}catch{this.failed=true;}
    if(this.failed)throw new Error("Private session clear failed");
  }
  install(input:PrivateSessionInstall,signal?:AbortSignal){return this.serial(async()=>{
    this.check(input);signal?.throwIfAborted();
    const {sessionMaterial}=await import("../../../packages/protocol/src/index.ts");
    const material=sessionMaterial.parse({connectionId:input.connectionId,profileId:input.profileId,runtimeId:input.runtimeId,revision:input.revision,expiresAt:input.expiresAt,allowedDomains:input.allowedDomains,cookies:input.cookies});
    if(!Number.isSafeInteger(input.connectionGeneration)||input.connectionGeneration<1||material.expiresAt<=this.now()||!material.allowedDomains.includes(input.domain)||material.allowedDomains.some(d=>publicTarget(`https://${d}`).hostname!==d)||material.cookies.some(c=>!c.secure||c.hostOnly!==!c.domain.startsWith(".")||!material.allowedDomains.includes(c.domain.replace(/^\./,""))))throw new Error("Private session scope or expiry invalid");
    const old=this.records.get(this.key(input));
    if(old&&((old.revoked&&old.connectionGeneration===0&&old.contextId===input.contextId)||old.domain!==input.domain||JSON.stringify([...old.allowedDomains].sort())!==JSON.stringify([...input.allowedDomains].sort())||input.connectionGeneration<old.connectionGeneration||(input.connectionGeneration===old.connectionGeneration&&(input.revision<old.revision||(old.revoked&&input.revision<=old.revision)))))throw new Error("Stale private session rejected");
    if([...this.records.values()].some(r=>r.active&&this.key(r)!==this.key(input)&&r.allowedDomains.some(d=>input.allowedDomains.includes(d))))throw new Error("Overlapping private session scopes");
    await this.start();
    
    const ack:PrivateSessionAck={owner:input.owner,contextId:input.contextId,generation:input.generation,domain:input.domain,tenantId:input.tenantId,profileId:input.profileId,runtimeId:input.runtimeId,connectionId:input.connectionId,allowedDomains:[...material.allowedDomains],revision:input.revision};
    if(old?.active&&old.revision===input.revision&&old.connectionGeneration===input.connectionGeneration){if(old.expiresAt!==input.expiresAt)throw new Error("Private session revision mismatch");return ack;}
    const record:PrivateSessionRecord={...ack,connectionGeneration:input.connectionGeneration,expiresAt:material.expiresAt,allowedDomains:material.allowedDomains,active:false,revoked:false};this.persist(record);
    try{signal?.throwIfAborted();await(await this.adapter()).replaceCookies(material.cookies,material.allowedDomains);signal?.throwIfAborted();if(material.expiresAt<=this.now())throw new Error("Expired private session");this.persist({...record,active:true});this.schedule();return ack;}
    catch{await this.erase(record);throw new Error("Private session installation failed");}
  });}
  clear(scope:PrivateSessionScope,signal?:AbortSignal){return this.serial(async()=>{
    this.check(scope);signal?.throwIfAborted();await this.start();
    const record=this.records.get(this.key(scope));
    if(record){if(record.domain!==scope.domain||JSON.stringify([...record.allowedDomains].sort())!==JSON.stringify([...scope.allowedDomains].sort()))throw new Error("Private session scope mismatch");await this.erase(record);}
    else {await this.erase({...scope,connectionGeneration:0,revision:Number.MAX_SAFE_INTEGER,expiresAt:0,allowedDomains:[...scope.allowedDomains],active:false,revoked:true});}
    this.schedule();
  });}
  run<T>(url:string|undefined,action:()=>Promise<T>){return this.serial(async()=>{
    await this.start();const domain=url?publicTarget(url).hostname:undefined;
    const expired=[...this.records.values()].some(r=>r.active&&r.expiresAt<=this.now()&&(!domain||r.allowedDomains.includes(domain)));
    await this.expire();if(expired||this.failed)throw new Error("Private session lease expired");
    return action();
  });}
  close(){return this.serial(async()=>{clearTimeout(this.timer);for(const record of this.records.values())if(record.active){try{await(await this.adapter()).replaceCookies([],record.allowedDomains);}catch{this.failed=true;}}});}
}
