import { withBrowserTabs } from "./browser-tabs.ts";
import {nativeLoginMetadataJournal} from "./native-login-journal.ts";
import { nativeLogin, prepareNativeLogin, type NativeLoginInput, type NativeLoginState, type NativeLoginView } from "./native-login.ts";
import { nativeCookieScope, nativeLoginResourceHost, nativeLoginScopesOverlap } from "./native-login-policy.ts";
import { NativeLoginVault, nativeLoginCipher } from "./native-login-vault.ts";
import { runPrivateLogin } from "./native-login-assistance.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { nodeStorage } from "../../../packages/entity-learn/lib/storage-node.ts";
import type { Event } from "tardie/core/event";
import { createRequestEmbedding } from "./request-embedding.ts";
import type {
  HarnessTransport,
  HarnessTransportRequest,
} from "@unbrowse/browser-harness/harness-runtime";
import { RequestMemory } from "./request-memory.ts";
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBrowserClient,
  AGENT_BROWSER_AGENT_DAEMON_ACTIONS,
  type AgentBrowserAgentAction,
  type AgentBrowserCallWindow,
} from "@unbrowse/browser-harness/client";
import { CdpNetworkListener, type NetworkExchangeSource } from "@unbrowse/browser-harness/network-listener";
import { BrowserLearning } from "./browser-learning.ts";
import { BrowserWatchRunner, type BrowserWatchLease, type BrowserWatchRunnerStatus } from "./browser-watch-runner.ts";
import type { BrowserProducerGrant } from "./browser-events.ts";
import { createPublicProxy, publicTarget } from "./browser-proxy.ts";
import { connectionRoute, CONNECTION_LINK_LIMIT } from "./connection-index.ts";

export interface BrowserDriver {
  /** Host-owned task tab; closing it must not retire the account browser. */
  forTab?(key: string): Promise<BrowserDriver>;
  /** Private host controls. These are never exposed as browser model actions. */
  watchContext?(): Promise<{ owner: string; profile: string }>;
  watchConfigure?(lease: BrowserWatchLease, signal?: AbortSignal): Promise<BrowserWatchRunnerStatus>;
  watchPause?(producer: string, signal?: AbortSignal, lifecycleRevision?:number): Promise<BrowserWatchRunnerStatus>;
  watchStatus?(): Promise<BrowserWatchRunnerStatus[]>;
  watchAcknowledgeGap?(producer: string, generation: number, missed: number, signal?: AbortSignal): Promise<BrowserWatchRunnerStatus>;
  hasActiveWatchLease?(): Promise<boolean>;
  executeScoped?(action:AgentBrowserAgentAction,policy:BrowserControlPolicy,signal?:AbortSignal):Promise<unknown>;
  /** Fixed reads of an already open page; never starts or navigates the browser. */
  inspectCurrentPage?(policy: BrowserInspectionPolicy, signal?: AbortSignal): Promise<BrowserInspection>;
  authorizeInspection?(policy: BrowserInspectionPolicy, signal?: AbortSignal): Promise<boolean>;
  readConnectionPage?(url: string, linkOffset?: number, signal?: AbortSignal): Promise<{url:string;text:string;links:string[];linksTruncated:boolean;nextLinkOffset?:number}>;
  nativeAuth?(input: NativeLoginInput, signal?: AbortSignal): Promise<NativeLoginView>;
  execute(
    action: AgentBrowserAgentAction,
    signal?: AbortSignal,
    policy?: BrowserControlPolicy,
  ): Promise<unknown>;
  requestTransport?: HarnessTransport;
  requestSearch?: RequestMemory["search"];
  requestRehydrate?(
    pointerId: string,
    inputs?: Record<
      string,
      import("@unbrowse/browser-harness/harness-runtime").HarnessJsonValue
    >,
    signal?: AbortSignal,
  ): Promise<
    Awaited<ReturnType<RequestMemory["hydrate"]>> & {
      hydration?: { body: unknown };
    }
  >;
  sessionContext?(): Promise<PrivateBrowserContext>;
  installSession?(
    input: PrivateSessionInstall,
    signal?: AbortSignal,
  ): Promise<PrivateSessionAck>;
  clearSession?(
    scope: PrivateSessionClear,
    signal?: AbortSignal,
  ): Promise<void>;
  screenshot?(signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface BrowserInspectionPolicy { origin: string; publicOnly: boolean }
export interface BrowserControlPolicy {origin:string;origins:readonly string[]}
export interface BrowserInspection {
  url: string; title: string; text: string; snapshot: string; links: string[]; linksTruncated: boolean;
}
export type BrowserDriverFactory = (options: {
  domains: readonly string[];
  owner?: string;
  emit: (event: object) => Promise<void>;
  signal?: AbortSignal;
}) => Promise<BrowserDriver>;

/** Exact connection revision and profile are authority; sharing an origin with
 * another signed-in connection does not authorize its observations. */
export function browserWatchConnectionAuthorized(
  grant: BrowserProducerGrant,
  owner: string,
  profile: string,
  native: readonly NativeLoginState[],
  installed: (connectionId:string, revision:string, origin:string) => boolean,
  now = Date.now(),
) {
  if (grant.owner!==owner || grant.profile!==profile || !grant.active || grant.expiresAt<=now || !grant.origins.length) return false;
  return grant.origins.every(origin => {
    let hostname: string;
    try {hostname = publicTarget(origin).hostname;} catch {return false;}
    const connection = native.find(state => state.connectionId===grant.connectionId);
    // A retained disconnected/pending native record fences this identity even
    // if a different session adapter happens to hold cookies for the origin.
    if (connection) return connection.status==="connected" && connection.expiresAt>now &&
      String(connection.revision)===grant.connectionRevision &&
      (hostname===connection.domain || hostname.endsWith(`.${connection.domain}`));
    return installed(grant.connectionId,grant.connectionRevision,origin);
  });
}
/** Uses the actual playground process/telemetry adapter, not its older model loop. */
export function browserDriverFactory(
  executablePath: string,
  options: { persistentDirectory?: string; nativeAssetDirectory?: string; browserBackend?: "chromium" | "cloakbrowser" } = {},
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
    evidenceDb.exec("CREATE TABLE IF NOT EXISTS native_login(id TEXT PRIMARY KEY,state TEXT NOT NULL)");
    const loginJournal=nativeLoginMetadataJournal(evidenceDb,principal);
    const flushLoginObservations=()=>loginJournal.flush(emit);
    const nativeStates = () => (evidenceDb.query("SELECT state FROM native_login").all() as {state:string}[]).map(row => JSON.parse(row.state) as NativeLoginState);
    const nativeLocked = () => nativeStates().some(state => state.status === "pending");
    let nativeVault: NativeLoginVault;
    let watchCipher: ReturnType<typeof nativeLoginCipher>;
    try { watchCipher = nativeLoginCipher(directory, evidenceDb); nativeVault = new NativeLoginVault(evidenceDb, principal, watchCipher); }
    catch (error) {
      evidenceDb.close();
      await proxy.close();
      if (!persistent) await rm(directory, {recursive:true,force:true});
      throw error;
    }
    const nativeBridges = new Map<string, {
      bridge: Awaited<ReturnType<NativeLoginVault["bridge"]>>;
      close: () => void;
    }>();
    let nativeBusy = false;
    let watches: BrowserWatchRunner | undefined;
    let privateGeneration = 0;
    const privateLogin = () => nativeBusy || nativeLocked();
    const pointerStorage = nodeStorage(
      join(directory, "request-memory.sqlite"),
    );
    let memory: RequestMemory;
    let hydrationBody: unknown;
    const learning = new BrowserLearning({
      pageScoped: true,
      browserSession: (origin) =>
        !closed && replayEndpoint
          ? { id: "implicit-browser-session-v1", origin }
          : undefined,
      threadId: identity,
      nextSequence: () => ++sequence,
      emit: async (event) => {
        if (privateLogin()) return;
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
        const indexAttempt = crypto.randomUUID();
        try {
          const indexed = await memory.index(
            event.toolDigest,
            concepts.length ? concepts : ["response"],
            responses,
            lifetime.signal,
          );
          // Durable, value-free bridge from the browser trace to its separate entity-learn pointer store.
          await emit({ type: "AikoRequestMemoryIndexed", id: indexAttempt, toolDigest: event.toolDigest,
            pointerId: indexed.pointerId, model: indexed.model, at: Date.now() });
        } catch {
          await emit({
            type: "AikoRequestMemoryIndexUnavailable",
            id: indexAttempt,
            toolDigest: event.toolDigest,
            at: Date.now(),
          });
        }
      },
    });
    const observeNetwork = async (entry: Record<string, unknown>, index: number, complete: boolean, source: NetworkExchangeSource) => {
      if (privateLogin() || closed) return;
      await watches?.observeNetwork(entry, index, complete);
      return learning.observe(entry, index, complete, source);
    };
    let network = new CdpNetworkListener(
      observeNetwork,
      undefined,
      lifetime.signal,
    );
    const windows = new Map<string, AgentBrowserCallWindow>();
    const callTargets = new Map<string, string | undefined>();
    const replaceNetworkListener = () => {
      learning.beginObservation();
      windows.clear();
      callTargets.clear();
      network = new CdpNetworkListener(observeNetwork,undefined,lifetime.signal);
    };
    let learningCommandTarget: string | undefined;
    const retainWindows = () => {
      for (const window of client.callWindows) windows.set(window.callId, window);
      while (windows.size > 4096) windows.delete(windows.keys().next().value!);
    };
    // Bind at command receipt, not at a later snapshot while a sibling is active.
    // Setup, tab changes, inspection and replay do not acquire this association.
    const learningCommand = async <T>(run: () => Promise<T>, targetId?: string): Promise<T> => {
      learningCommandTarget = targetId;
      try { return await run(); }
      finally { retainWindows(); learningCommandTarget = undefined; }
    };
    let targetOrigin: string | undefined;
    let selectedTargetId: string | undefined;
    let taskTabSelected = false;
    let replayEndpoint: string | undefined;
    let started = false;
    let starting: Promise<void> | undefined;
    let cookieConnection:
      Awaited<ReturnType<typeof openPrivateBrowserCdp>> | undefined;
    const context: PrivateBrowserContext = {
      owner: principal,
      contextId: identity,
      generation: 1,
    };
    evidenceDb.exec(
      "CREATE TABLE IF NOT EXISTS unlock_session_metadata(binding TEXT PRIMARY KEY,metadata TEXT NOT NULL)",
    );
    const sessions = new PrivateBrowserSessions(
      context,
      async (signal) => {
        signal?.throwIfAborted();
        await startBrowser();
        cookieConnection ??= await openPrivateBrowserCdp(
          replayEndpoint!,
          lifetime.signal,
        );
        const targets = await cookieConnection.send("Target.getTargets", {});
        const observerTargets = new Set(watches?.observerTargetIds() ?? []);
        const pages = targets.targetInfos.filter(
          (target: any) =>
            target.type === "page" &&
            !observerTargets.has(target.targetId) &&
            (!selectedTargetId || target.targetId === selectedTargetId) &&
            (target.url === "about:blank" || /^https?:\/\//.test(target.url)),
        );
        if (pages.length !== 1 || typeof pages[0].browserContextId !== "string")
          throw new Error("Exclusively owned browser context unavailable");
        return createOwnedCookieAdapter(
          cookieConnection,
          {
            browserContextId: pages[0].browserContextId,
            targetId: pages[0].targetId,
          },
          signal,
        );
      },
      (record) => {
        const binding = JSON.stringify([
          record.tenantId,
          record.profileId,
          record.runtimeId,
          record.connectionId,
        ]);
        evidenceDb
          .query(
            "INSERT INTO unlock_session_metadata(binding,metadata) VALUES(?,?) ON CONFLICT(binding) DO UPDATE SET metadata=excluded.metadata",
          )
          .run(binding, JSON.stringify(record));
      },
      (
        evidenceDb
          .query("SELECT metadata FROM unlock_session_metadata")
          .all() as { metadata: string }[]
      ).map((row) => JSON.parse(row.metadata)),
    );
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
            ? ["launch", "screenshot", "tab_new", ...AGENT_BROWSER_AGENT_DAEMON_ACTIONS]
            : [
                "launch",
                "navigate",
                "cdp_url",
                "stream_enable",
                "stream_status",
                "viewport",
                "tab_list", "tab_new", "tab_switch",
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
          // A Chromium 152 profile cannot safely be opened by the pinned Cloak 146 build.
          ...(persistent ? { profile: join(directory, options.browserBackend === "cloakbrowser" ? "profile-cloak" : "profile") } : {}),
          proxy: proxy.url,
          proxyBypass: "<-loopback>",
          args: [
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp",
            ...(options.browserBackend === "cloakbrowser" ? [
              `--fingerprint=${Number.parseInt(createHash("sha256").update(`aiko-cloak:${principal}`).digest("hex").slice(0, 8), 16) || 1}`,
              "--fingerprint-platform=windows",
            ] : []),
          ].join(","),
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
          requirePublicProxy: true,
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
        ...(options.nativeAssetDirectory === undefined ? {} : { nativeAssetDirectory: options.nativeAssetDirectory }),
        trace: {
          threadId: identity,
          nextSequence: () => ++sequence,
          nextCallId: () => `call-${++calls}`,
          publish: (event) => {
            if (privateLogin()) return;
            if (event.type === "BrowserToolCallObserved") {
              callTargets.set(event.callId, learningCommandTarget);
              while (callTargets.size > 4096) callTargets.delete(callTargets.keys().next().value!);
            }
            tail = tail
              .then(() => emit(event))
              .catch(() => {
                failed = true;
              });
          },
        },
      });
    } catch (error) {
      nativeVault.close();
      pointerStorage.close();
      evidenceDb.close();
      await proxy.close();
      if (!persistent) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    async function startBrowser() {
      if (starting) return starting;
      if (started) return;
      const generation = privateGeneration;
      starting = (async () => {
      // Reconnect after private sign-in must restore controller-only setup authority.
      await policy(false);
      await client.prepareViewport();
      let status = await client.streamStatus();
      if (!status.enabled) status = await client.streamEnable();
      if (status.port === null)
        throw new Error("Browser telemetry unavailable");
      if (!privateLogin()) await client.connectTelemetry(status.port);
      replayEndpoint = await client.networkObservationEndpoint();
      if (closed || generation !== privateGeneration) throw Error("Browser startup authority changed");
      if (!privateLogin()) await network.connect(replayEndpoint);
      if (closed || generation !== privateGeneration) throw Error("Browser startup authority changed");
      started = true;
      if (opened) await policy(true);
      })();
      try {await starting;} finally {starting = undefined;}
    }
    const withNativeSession = async <T>(url: string | undefined, action: () => Promise<T>): Promise<T> => {
      if (!url) return action();
      const hostname = publicTarget(url).hostname;
      const state = selectNativeSession(nativeStates(),hostname);
      if (!state) return action();
      await startBrowser();
      const generation = privateGeneration;
      const key = `${state.connectionId}:${state.revision}:${hostname}:${generation}`;
      let entry = nativeBridges.get(key);
      if (!entry) {
        for (const [oldKey,old] of nativeBridges) if (oldKey.startsWith(`${state.connectionId}:`)) {
          old.close();nativeBridges.delete(oldKey);
        }
        const connection = await openPrivateBrowserCdp(replayEndpoint!,lifetime.signal);
        try {
          const cdp = {send: async (method:string,params:Record<string,unknown>,sessionId?:string) => {
            lifetime.signal.throwIfAborted();
            if (privateLogin() || generation !== privateGeneration) throw Error("Private browser authority changed");
            return connection.send(method,params,sessionId);
          }};
          if (!await nativeVault.restore(state,cdp)) throw Error("Reconnect this app to restore its session");
          const cookies = await nativeVault.session(state);
          const domains = [...new Set([...nativeCookieScope(state.domain).domains,hostname,...(cookies ?? []).map(c => c.domain.replace(/^\./,""))])];
          const targets = await cdp.send("Target.getTargets",{});
          const page = targets.targetInfos?.find((t:any) => t.type === "page" && (!selectedTargetId || t.targetId === selectedTargetId) && typeof t.browserContextId === "string");
          if (!page) throw Error("Private browser context unavailable");
          const adapter = await createOwnedCookieAdapter(cdp,{browserContextId:page.browserContextId,targetId:page.targetId},lifetime.signal);
          const bridge = await nativeVault.bridge(state,adapter,identity,domains,() => nativeStates().find(s => s.connectionId === state.connectionId));
          entry = {bridge,close:() => connection.close()};
          nativeBridges.set(key,entry);
        } catch (error) {connection.close();throw error;}
      } else if (!entry.bridge.status().ready) {
        // A later requested action may recover the latest committed jar. The
        // action whose checkpoint failed is never retried here.
        await entry.bridge.recover();
      }
      // The SDK preserves successful action results when checkpointing fails,
      // then fences subsequent actions until the host recovers current custody.
      return entry.bridge.run(action,() => {console.warn("native_session_checkpoint_pending");});
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await watches?.close();
        for (const entry of nativeBridges.values()) entry.close();
        nativeBridges.clear();
        await sessions.close();
        cookieConnection?.close();
        await policy(false);
        lifetime.abort();
        await network.stopAndSnapshot().catch(() => undefined);
        client.disconnectTelemetry();
        await client.closeAll();
      } finally {
        nativeVault.close();
        pointerStorage.close();
        evidenceDb.close();
        await proxy.close();
        if (!persistent) await rm(directory, { recursive: true, force: true });
      }
    };
    // Expiry alone does not release private custody: close/revoke the old
    // sign-in through the native path before exposing any page to the actor.
    const preparePublicBrowser = async (signal?: AbortSignal) => {
      if (!nativeBusy && !closed) {
        const expired = nativeStates().find(state => state.status === "pending" &&
          (state.expiresAt <= Date.now() || (state.verifiedSession?.expiresAt ?? Infinity) <= Date.now()));
        if (expired && expired.expiresAt <= Date.now()) {
          try {
            await driver.nativeAuth!({connectionId: expired.connectionId, domain: expired.domain, action: "status"}, signal);
          } catch {
            throw Object.assign(new Error("Expired private sign-in cleanup failed"), {code: "private_sign_in_cleanup_failed"});
          }
        }
      }
      if (privateLogin()) throw Object.assign(new Error("Browser unavailable during private sign-in"), {code: "private_sign_in_pending"});
      if (closed) throw new Error("Browser session closed");
    };
    const requestTransport: HarnessTransport = {
      send: async (request) => {
        await preparePublicBrowser(lifetime.signal);
        if (!["GET","HEAD"].includes(request.method) || request.body !== undefined || request.redirect !== "manual" || Object.keys(request.headers).length)
          throw Error("Only observed read requests can restore a browser session");
        const target = publicTarget(request.url);
        const state = selectNativeSession(nativeStates(),target.hostname);
        let renewedForRead = false;
        if (!opened || !replayEndpoint || targetOrigin !== target.origin) {
          if (!state) throw Error("Reconnect this app before restoring its request session");
          if (state.expiresAt <= Date.now()) {
            const renewed = await driver.nativeAuth!({connectionId:state.connectionId,domain:state.domain,action:"renew"}, lifetime.signal);
            if (renewed.status !== "connected") throw Error("Private sign-in requires owner input");
            renewedForRead = true;
          }
          await driver.execute({action:"navigate",url:target.origin},lifetime.signal);
        }
        const read = () => sessions.run(request.url, () => withNativeSession(request.url, () =>
          replayBrowserRequest(
            replayEndpoint!,
            targetOrigin!,
            request,
            lifetime.signal,
            selectedTargetId,
          )),
        );
        const result = await read();
        if (result.classification !== "browser_session_required" || renewedForRead) return result;
        if (!state) return result;
        const renewed = await driver.nativeAuth!({connectionId:state.connectionId,domain:state.domain,action:"renew"}, lifetime.signal);
        if (renewed.status !== "connected") return result;
        await driver.execute({action:"navigate",url:target.origin},lifetime.signal);
        // Only the read-only replay seam reaches this branch. A mutation is
        // never retried when its outcome is unknown.
        return read();
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
      record: emit,
      embedResponseValues: true,
      transport: requestTransport,
      authorizeSession: async (requirements, origins) =>
        !closed && !privateLogin() &&
        requirements.every((id) => id === "implicit-browser-session-v1") &&
        origins.every(origin => (opened && targetOrigin === origin) || nativeStates().some(state => {
          const hostname = publicTarget(origin).hostname;
          return state.status === "connected" && (hostname === state.domain || hostname.endsWith(`.${state.domain}`));
        })),
      consume: async (response) => {
        hydrationBody = response.body;
      },
    });
    let hydrating = false;
    const inspectionAuthorized = (inspection: BrowserInspectionPolicy) => {
      try {
        const origin=publicTarget(inspection.origin).origin, hostname=publicTarget(origin).hostname;
        if (inspection.origin!==origin || typeof inspection.publicOnly!=="boolean" || !opened || !replayEndpoint ||
            targetOrigin!==origin || closed || privateLogin()) return false;
        // Revoking cookies does not make an already rendered account page public.
        if (inspection.publicOnly) return !sessions.hasPrivateSession() && !sessions.hasPrivateHistory(hostname) &&
          !nativeStates().some(state=>state.status==="connected" || hostname===state.domain || hostname.endsWith(`.${state.domain}`));
        return sessions.inspectionAuthorized(hostname) && nativeStates().filter(state=>hostname===state.domain||hostname.endsWith(`.${state.domain}`))
          .every(state=>state.status==="connected" && state.expiresAt>Date.now());
      } catch {return false;}
    };
    const driver: BrowserDriver = {
      watchContext: async () => ({owner: principal, profile: watchProfile}),
      watchConfigure: async (lease, signal) => {
        signal?.throwIfAborted();
        if (!watches) throw Error("Browser watch unavailable");
        return watches.configure(lease);
      },
      watchPause: async (producer, signal, lifecycleRevision) => {
        signal?.throwIfAborted();
        if (!watches) throw Error("Browser watch unavailable");
        return watches.pause(producer, lifecycleRevision);
      },
      watchAcknowledgeGap: async (producer, generation, missed, signal) => {
        signal?.throwIfAborted();
        if (!watches || closed) throw Error("Browser watch unavailable");
        return watches.acknowledgeCoverageGap(producer, generation, missed);
      },
      watchStatus: async () => watches?.status() ?? [],
      hasActiveWatchLease: async () => watches?.hasActiveLease() ?? false,
      executeScoped:(action,policy,signal)=>driver.execute(action,signal,policy),
      authorizeInspection: async (inspection,signal) => {
        signal?.throwIfAborted();
        return inspectionAuthorized(inspection);
      },
      inspectCurrentPage: (inspection, signal) => sessions.run(targetOrigin, async () => {
        const origin = publicTarget(inspection.origin).origin;
        if (inspection.origin !== origin || typeof inspection.publicOnly !== "boolean") throw Error("Invalid inspection policy");
        signal?.throwIfAborted();
        if (closed || privateLogin()) throw Error("Page inspection unavailable during private sign-in");
        if (!opened || !replayEndpoint || targetOrigin !== origin) throw Error("No matching existing page");
        const generation = privateGeneration;
        const check = () => {
          signal?.throwIfAborted();
          if (!inspectionAuthorized(inspection) || generation !== privateGeneration)
            throw Error("Page inspection authority unavailable");
        };
        check();
        const currentLocation = async () => {
          const result=await client.executeAgentAction({action:"url"},null,signal);
          const location=result.output as {url?:unknown};
          if (typeof location?.url!=="string" || publicTarget(location.url).origin!==origin) throw Error("Active page origin changed");
        };
        await currentLocation();
        // The fixed DOM read refuses password forms and pins the selected page origin.
        const page = await readBrowserConnectionPage(replayEndpoint, origin, 0, signal, true, selectedTargetId);
        check();
        const finalPage = await readBrowserConnectionPage(replayEndpoint, origin, 0, signal, false, selectedTargetId);
        await currentLocation();
        check();
        if (page.url !== finalPage.url || page.text !== finalPage.text || page.title !== finalPage.title)
          throw Error("Page changed during inspection");
        await flush();
        check();
        return {...finalPage, snapshot:page.snapshot ?? ""};
      }),
      readConnectionPage: async (url, linkOffset = 0, signal) => {
        await driver.execute({action:"navigate",url},signal);
        const page = await readBrowserConnectionPage(replayEndpoint!,publicTarget(url).origin,linkOffset,signal,false,selectedTargetId);
        // Settle the native observation window before its event queue is drained.
        const current = await driver.execute({action:"url"},signal) as {url?:string};
        if (typeof current.url !== "string" || connectionRoute(current.url,publicTarget(url).hostname) !== page.url)
          throw Error("Connection page changed during discovery");
        return page;
      },
      nativeAuth: async (input, signal) => {
        if (taskTabSelected) throw Object.assign(Error("Renew private sign-in through the account before continuing this task"), {code:"private_sign_in_pending"});
        if (nativeBusy) throw Error("Private sign-in busy");
        privateGeneration++;
        proxy.restrictOrigins(undefined);
        nativeBusy = true;
        let stage = "trace-flush";
        try {
          await watches?.suspend();
          // A concurrent observation startup is fenced by privateGeneration;
          // settle its cleanup before using the sign-in page.
          await starting?.catch(() => undefined);
          await flushLoginObservations();
          await flush();
          stage = "pause-capture";
          await network.stopAndSnapshot().catch(() => undefined);
          client.disconnectTelemetry();
          stage = "browser-start";
          await startBrowser();
          stage = "private-cdp";
          let cdp: Awaited<ReturnType<typeof openPrivateBrowserCdp>>;
          try { cdp = await openPrivateBrowserCdp(replayEndpoint!, signal); }
          catch (error) {
            // A stopped Chromium can leave a live runner holding its old CDP
            // endpoint. Re-establish it once for page inspection, before any
            // login input is dispatched. Writes remain explicit owner retries.
            started = false;
            if (!["form","view","begin","status"].includes(input.action) || signal?.aborted) throw error;
            stage = "browser-reconnect";
            await startBrowser();
            stage = "private-cdp";
            cdp = await openPrivateBrowserCdp(replayEndpoint!, signal);
          }
          try {
            const privateCdp = {...cdp,send:async(method:string,params:object,sessionId?:string)=>{
              try {return await cdp.send(method,params,sessionId);}
              catch(error) {console.warn("private_login_cdp_failed",method);throw error;}
            }};
            const run = async (request: NativeLoginInput, reason?: "expired") => {
              if (request.action === "begin") nativeVault.discard(request.connectionId);
              const dependencies: Parameters<typeof nativeLogin>[1] = { cdp:privateCdp,
              read: () => nativeStates().find(s => s.connectionId === request.connectionId),
              save: state => {
                if (reason === "expired" && state.status === "disconnected") state = {...state, expired: true};
                if (state.status === "disconnected") nativeVault.remove(state.connectionId);
                loginJournal.save(state);
              },
              credentials: (state, credentials) => nativeVault.stage(state, credentials),
              verified: (state, cookies, identity) => nativeVault.verified(state, cookies, identity),
              };
              return runPrivateLogin(request, { ...dependencies, vault: nativeVault, signal,
                source: id => nativeStates().find(state => state.connectionId === id),
                cookieAdapter: async targetId => {
                  const inventory = await privateCdp.send("Target.getTargets", {});
                  const target = inventory.targetInfos?.find((t: any) => t.targetId === targetId && typeof t.browserContextId === "string");
                  if (!target) throw Error("Private cookie context unavailable");
                  return createOwnedCookieAdapter(privateCdp, { targetId, browserContextId: target.browserContextId }, signal);
                },
              });
            };
            stage = "expired-cleanup";
            const recovered = await prepareNativeLogin(input, nativeStates(), run);
            stage = "sign-in-action";
            const view = recovered ?? await run(input);
            if (input.action === "renew") await emit({type:"AikoNativeLoginStatus",id:crypto.randomUUID(),owner:principal,connectionId:input.connectionId,at:Date.now()});
            return view;
          } finally { cdp.close(); }
        } catch(error) {
          if (["credentials","login"].includes(input.action)) nativeVault.discard(input.connectionId);
          // Fixed stages/method names only: never credentials, URLs or raw CDP errors.
          console.warn("private_login_failed",stage);
          throw error;
        } finally {
          await flushLoginObservations().catch(() => undefined);
          nativeBusy = false;
          if (!nativeLocked()) {
            replaceNetworkListener();
            started = false;
          }
          if (!privateLogin()) await watches?.resume();
        }
      },
      sessionContext: async () => ({ ...context }),
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
        if (privateLogin() || closed || !opened)
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
      execute: async (action, signal, control) =>
        sessions.run(
          action.action === "navigate" ? action.url : targetOrigin,
          async () => {
            if(control) {
              if(!control.origins.length||control.origins.length>16||!control.origins.includes(control.origin)||publicTarget(control.origin).origin!==control.origin||
                 control.origins.some(origin=>publicTarget(origin).origin!==origin)||action.action.startsWith("tab_"))throw Error("Invalid delegated browser policy");
              if(privateLogin()||closed)throw Object.assign(Error("Private sign-in holds browser"),{code:"private_sign_in_pending"});
              if(action.action==="navigate"&&publicTarget(action.url).origin!==control.origin)throw Error("Navigation origin differs from grant");
              const hostname=publicTarget(control.origin).hostname;
              if(!sessions.inspectionAuthorized(hostname)||nativeStates().filter(state=>hostname===state.domain||hostname.endsWith(`.${state.domain}`)).some(state=>state.status!=="connected"||state.expiresAt<=Date.now()))throw Error("Current browser session authority unavailable");
            }else {
              await preparePublicBrowser(signal);
              if (action.action === "navigate") {
                const hostname = publicTarget(action.url).hostname;
                const expired = selectNativeSession(nativeStates(),hostname);
                if (expired && expired.expiresAt <= Date.now()) {
                  const renewal = await driver.nativeAuth!({connectionId:expired.connectionId,domain:expired.domain,action:"renew"},signal);
                  if (renewal.status !== "connected") throw Error("Private sign-in requires owner input");
                }
              }
            }
            proxy.restrictOrigins(control?.origins);
            await startBrowser();
            await flush();
            const active = AbortSignal.any([
              lifetime.signal,
              ...(signal ? [signal] : []),
            ]);
            const generation=privateGeneration;
            const scopedLocation=async()=>{
              if(!control)return;
              active.throwIfAborted();
              if(privateLogin()||generation!==privateGeneration)throw Error("Private browser authority changed");
              const location=(await client.executeAgentAction({action:"url"},null,active)).output as {url?:unknown};
              if(typeof location?.url!=="string"||publicTarget(location.url).origin!==control.origin)throw Error("Browser left delegated operation origin");
              if(!inspectionAuthorized({origin:control.origin,publicOnly:false}))throw Error("Current browser session authority unavailable");
              // The existing fixed DOM gate refuses password forms without exposing their content.
              await readBrowserConnectionPage(replayEndpoint!,control.origin,0,active,false,selectedTargetId);
            };
            if(control&&action.action!=="navigate")await scopedLocation();
            if (!opened && action.action !== "navigate")
              throw new Error("Navigate before using page tools");
            if (!selectedTargetId) {
              selectedTargetId = (await client.ownedTabs()).find(tab => tab.active)?.targetId;
              if (!selectedTargetId) throw Error("Browser learning page unavailable");
            }
            if (action.action === "navigate") {
              learning.beginNavigation(selectedTargetId);
              targetOrigin = publicTarget(action.url).origin;
            }
            return withNativeSession(targetOrigin,async () => {
            const capture = async () => {
              await network.flush();
              await flush();
              retainWindows();
              if (client.telemetryComplete && targetOrigin && selectedTargetId && !active.aborted) {
                const result = await learning.compile(
                  await network.snapshot(),
                  [...windows.values()],
                  targetOrigin,
                  { pageTargetId: selectedTargetId, callIds: new Set([...callTargets].flatMap(([id, target]) => target === selectedTargetId ? [id] : [])) },
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
            if (!opened && action.action === "navigate") {
              const navigationUrl = action.url;
              await startBrowser();
              await learningCommand(() => client.open(navigationUrl, null, active), selectedTargetId);
              await flush();
              await capture();
              await policy(true);
              opened = true;
              await scopedLocation();
              await flush();
              return {
                navigation: "completed",
                note: "Use snapshot to inspect the current browser.",
              };
            }
            try {
              const result = await learningCommand(
                () => client.executeAgentAction(action, null, active),
                action.action.startsWith("tab_") ? undefined : selectedTargetId,
              );
              if (action.action.startsWith("tab_")) selectedTargetId = undefined;
              if(control) {targetOrigin=control.origin;await scopedLocation();}
              await capture();
              return result.output;
            } catch (error) {
              await flush();
              throw error;
            }
            });
          },
        ),
    };
    // A profile survives collector and runner restarts. Session context IDs above
    // still rotate; retaining a profile never revives an old session grant.
    evidenceDb.exec("CREATE TABLE IF NOT EXISTS browser_watch_profiles(backend TEXT PRIMARY KEY,profile TEXT NOT NULL)");
    const watchBackend = options.browserBackend ?? "chromium";
    evidenceDb.query("INSERT OR IGNORE INTO browser_watch_profiles VALUES(?,?)").run(watchBackend, crypto.randomUUID());
    const watchProfile = (evidenceDb.query("SELECT profile FROM browser_watch_profiles WHERE backend=?").get(watchBackend) as {profile:string}).profile;
    watches = new BrowserWatchRunner({owner:principal,db:evidenceDb,cipher:watchCipher,
      authorized: grant => !closed && !privateLogin() && browserWatchConnectionAuthorized(grant,principal,watchProfile,nativeStates(),
        (connectionId, revision, origin) => sessions.watchAuthorized(connectionId,revision,new URL(origin).hostname)),
      endpoint: async () => {
        if (closed || privateLogin()) throw Error("Browser watch connection unavailable");
        if (started) {
          try {network.assertHealthy();}
          catch {
            await network.stopAndSnapshot().catch(() => undefined);
            replaceNetworkListener();
            started = false;
          }
        }
        await startBrowser();
        if (closed || privateLogin()) throw Error("Browser watch connection unavailable");
        return replayEndpoint!;
      },
      keepAlive: async signal => {
        signal.throwIfAborted();
        if (closed || privateLogin()) throw Error("Browser watch connection unavailable");
        await startBrowser();
        signal.throwIfAborted();
        if (closed || privateLogin()) throw Error("Browser watch connection unavailable");
        const status = await client.streamStatus();
        signal.throwIfAborted();
        if (closed || privateLogin() || !status.enabled || status.port === null)
          throw Error("Browser watch telemetry unavailable");
      },
      networkHealth: () => {
        if (closed || privateLogin() || !started) return {state:"stopped",reason:"network-not-attached"};
        try {network.assertHealthy();return {state:"watching",reason:"recording"};}
        catch {return {state:"degraded",reason:"network-disconnected"};}
      },
    });
    try {await watches.restore();if (!privateLogin()) await watches.resume();}
    catch (error) {await close();throw error;}
    type TabState = { tab?: {tabId:string;targetId:string}; opened: boolean; origin?: string };
    let activeTab: TabState | undefined;
    return withBrowserTabs(driver, {
      initial: () => {
        const state: TabState = {opened:false};
        activeTab ??= state;
        return state;
      },
      select: async (state, create) => {
        await preparePublicBrowser();
        await startBrowser();
        activeTab!.opened = opened;
        activeTab!.origin = targetOrigin;
        if (!activeTab!.tab) {
          const current = (await client.ownedTabs()).find(tab => tab.active);
          if (!current) throw Error("Account browser tab unavailable");
          activeTab!.tab = current;
        }
        if (!state.tab) {
          if (!create) throw Error("Account browser tab unavailable");
          state.tab = await client.createOwnedTab();
        }
        await client.selectOwnedTab(state.tab);
        await flush();
        activeTab = state;
        opened = state.opened;
        targetOrigin = state.origin;
        selectedTargetId = state.tab.targetId;
        taskTabSelected = create;
      },
      close: async state => {
        if (!state.tab || closed) return;
        await client.closeOwnedTab(state.tab, async targetId => {
          const cdp = await openPrivateBrowserCdp(replayEndpoint!, lifetime.signal);
          try {
            const result = await cdp.send("Target.closeTarget", {targetId});
            if (result.success !== true) throw Error("Task tab cleanup unconfirmed");
            const deadline = Date.now() + 2000;
            for (;;) {
              const targets = await cdp.send("Target.getTargets", {});
              if (!targets.targetInfos.some((target: {targetId:string}) => target.targetId === targetId)) break;
              if (Date.now() >= deadline) throw Error("Task tab cleanup unconfirmed");
              await Bun.sleep(20);
            }
          } finally { cdp.close(); }
        });
        await flush();
      },
    });
  };
}

/** Fixed CDP program; callers cannot select JavaScript, CDP methods or another page origin. */
export async function readBrowserConnectionPage(endpoint:string,origin:string,linkOffset=0,signal?:AbortSignal,includeSnapshot=false,targetId?:string) {
  const target=publicTarget(origin);
  if(!Number.isSafeInteger(linkOffset)||linkOffset<0)throw Error("Invalid link offset");
  const cdp=await openPrivateBrowserCdp(endpoint,signal);
  try {
    const targets=await cdp.send("Target.getTargets",{});
    const pages=targets.targetInfos.filter((t:any)=>t.type==="page"&&(!targetId||t.targetId===targetId)&&(()=>{try{return new URL(t.url).origin===target.origin;}catch{return false;}})());
    if(pages.length!==1)throw Error("Ambiguous owned page");
    const {sessionId}=await cdp.send("Target.attachToTarget",{targetId:pages[0].targetId,flatten:true});
    // A single fixed DOM read preserves document order across parent elements.
    // Native selectors do not implement Playwright's `>> nth=` syntax.
    const expression=`(() => {if(location.origin!==${JSON.stringify(target.origin)}||document.querySelector('input[type="password"]'))throw Error('Sign-in context unavailable');const links=Array.from(document.querySelectorAll('a[href]'));return {url:location.href,title:document.title.slice(0,1000),text:(document.body?.innerText??'').slice(0,12000),links:links.slice(${linkOffset},${linkOffset+CONNECTION_LINK_LIMIT}).map(a=>a.href),count:links.length};})()`;
    const result=await cdp.send("Runtime.evaluate",{expression,returnByValue:true},sessionId);
    const page=result.result?.value;
    if(result.exceptionDetails||!page||typeof page.text!=="string"||!Array.isArray(page.links)||!Number.isSafeInteger(page.count))throw Error("Connection context unavailable");
    const url=connectionRoute(page.url,target.hostname);
    if(!url)throw Error("Connection context left its domain");
    const links=[...new Set<string>(page.links.flatMap((href:unknown)=>typeof href==="string"?(connectionRoute(href,target.hostname,url)??[]):[]))];
    let snapshot:string|undefined;
    if(includeSnapshot) {
      const tree=await cdp.send("Accessibility.getFullAXTree",{},sessionId);
      if(!Array.isArray(tree.nodes))throw Error("Page accessibility snapshot unavailable");
      // Same explicit CDP target as the DOM read. Values and editable controls are excluded.
      snapshot=tree.nodes.filter((node:any)=>!node.ignored&&!['textbox','searchbox','combobox'].includes(node.role?.value)).slice(0,200)
        .map((node:any)=>`${String(node.role?.value??'').slice(0,80)}: ${String(node.name?.value??'').slice(0,500)}`).join('\n').slice(0,12000);
    }
    return {url,title:typeof page.title === "string" ? page.title.slice(0,1000) : "",text:JSON.stringify({visibleText:page.text}).slice(0,16000),links,linksTruncated:page.count>linkOffset+CONNECTION_LINK_LIMIT,...(snapshot!==undefined?{snapshot}:{}),...(page.count>linkOffset+CONNECTION_LINK_LIMIT?{nextLinkOffset:linkOffset+CONNECTION_LINK_LIMIT}:{})};
  } finally {cdp.close();}
}

/** Fixed CDP program; callers cannot select JavaScript, CDP methods or another page origin. */
export async function replayBrowserRequest(
  endpoint: string,
  origin: string,
  request: HarnessTransportRequest,
  signal?: AbortSignal,
  targetId?: string,
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
        (!targetId || t.targetId === targetId) &&
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
    const expression = `(async () => { const r = ${JSON.stringify({ url: target.href, method: request.method, origin })}; if (location.origin !== r.origin) throw Error("Origin changed"); const response = await fetch(r.url, {method:r.method,credentials:"same-origin",redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(15000)}); if(response.type === "opaqueredirect") throw Error("Redirect blocked"); const text = await response.text(); if(text.length > 1000000) throw Error("Response too large"); const type = (response.headers.get("content-type") || "").toLowerCase();
      const html = type.includes("text/html") ? new DOMParser().parseFromString(text,"text/html") : undefined;
      const challenge = response.headers.get("cf-mitigated") === "challenge" || !!html?.querySelector('iframe[src*="captcha"],iframe[src*="challenges.cloudflare.com"],script[src*="/cdn-cgi/challenge-platform/"],.g-recaptcha,.h-captcha') || !!html && /just a moment|attention required|verify you are human|security verification|checking your browser/i.test(html.title);
      const login = !!html?.querySelector('input[type="password"]');
      const classification = challenge ? "site_control" : response.status===401||response.status===403||login ? "browser_session_required" : type.includes("application/json") || html && response.ok || r.method === "HEAD" && response.ok ? "application" : "site_control";
      return {status:response.status,headers:{"content-type":type},classification,body:classification === "application" && text ? type.includes("application/json") ? JSON.parse(text) : text : undefined}; })()`;
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

export async function openPrivateBrowserCdp(
  endpoint: string,
  signal?: AbortSignal,
) {
  const { validateObserverEndpoint } =
    await import("@unbrowse/browser-harness/network-listener");
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
  return {
    send: rpc,
    close: () => {
      socket.close();
      signal?.removeEventListener("abort", abort);
    },
  };
}

/** Overlapping native jars share browser cookie scope and cannot have separate custody. */
export function selectNativeSession(states: import("./native-login.ts").NativeLoginState[], hostname: string) {
  const connected = states.filter(s => s.status === "connected");
  const selected = connected.find(s => nativeLoginResourceHost(s.domain,hostname));
  if (selected && connected.some(s => s.connectionId !== selected.connectionId &&
      nativeLoginScopesOverlap(s.domain,selected.domain)))
    throw Error("This app has overlapping connections. Disconnect the duplicate before continuing");
  return selected;
}

/** Chromium reports an opaque default context ID on targets but requires Storage calls
 * to omit that ID. Normalize only this exclusively owned process's verified default context;
 * the actual SDK still validates target binding and performs scoped cookie replacement. */
export async function createOwnedCookieAdapter(
  cdp: import("../../../packages/sdk/src/cdp.ts").PrivateCdp,
  binding: { browserContextId: string; targetId: string },
  signal?: AbortSignal,
) {
  const { createCdpCookieAdapter } =
    await import("../../../packages/sdk/src/cdp.ts");
  const contexts = await cdp.send("Target.getBrowserContexts", {});
  if (!Array.isArray(contexts.browserContextIds))
    throw new Error("Private browser contexts unavailable");
  const isDefault = !contexts.browserContextIds.includes(
    binding.browserContextId,
  );
  return createCdpCookieAdapter(
    {
      send: async (method, params, sessionId) => {
        signal?.throwIfAborted();
        if (
          isDefault &&
          (method === "Storage.getCookies" ||
            method === "Storage.setCookies") &&
          params.browserContextId === binding.browserContextId
        ) {
          const { browserContextId: _, ...scoped } = params;
          return cdp.send(method, scoped, sessionId);
        }
        return cdp.send(method, params, sessionId);
      },
    },
    binding,
  );
}

/** Private Unlock metadata only. Neither this lifecycle nor the SDK cookie adapter is a model tool. */
export interface PrivateBrowserContext {
  owner: string;
  contextId: string;
  generation: number;
}
export interface PrivateSessionScope extends PrivateBrowserContext {
  domain: string;
  tenantId: string;
  profileId: string;
  runtimeId: string;
  connectionId: string;
  allowedDomains: string[];
}
export interface PrivateSessionClear extends PrivateSessionScope {
  reason?: "release" | "revoke";
}
export interface PrivateSessionInstall extends PrivateSessionScope {
  connectionGeneration: number;
  revision: number;
  expiresAt: number;
  allowedDomains: string[];
  cookies: import("../../../packages/sdk/src/agent.ts").VaultCookie[];
}
export type PrivateSessionAck = PrivateSessionScope & { revision: number };
export type PrivateSessionRecord = Omit<PrivateSessionInstall, "cookies"> & {
  active: boolean;
  revoked: boolean;
};

export class PrivateBrowserSessions {
  private records = new Map<string, PrivateSessionRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private failed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly context: PrivateBrowserContext,
    private adapter: (
      signal?: AbortSignal,
    ) => Promise<
      import("../../../packages/sdk/src/agent.ts").PrivateBrowserAdapter
    >,
    private save: (record: PrivateSessionRecord) => void,
    records: PrivateSessionRecord[] = [],
    private now = () => Date.now(),
  ) {
    for (const record of records) {
      if (record.owner !== context.owner)
        throw new Error("Private session owner mismatch");
      this.records.set(this.key(record), { ...record, active: false });
    }
  }
  private key(scope: PrivateSessionScope) {
    return JSON.stringify([
      scope.tenantId,
      scope.profileId,
      scope.runtimeId,
      scope.connectionId,
    ]);
  }
  private check(scope: PrivateSessionScope) {
    if (
      scope.owner !== this.context.owner ||
      scope.contextId !== this.context.contextId ||
      scope.generation !== this.context.generation
    )
      throw new Error("Private session context mismatch");
    if (
      ![
        scope.tenantId,
        scope.profileId,
        scope.runtimeId,
        scope.connectionId,
      ].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v))
    )
      throw new Error("Invalid private session binding");
    if (publicTarget(`https://${scope.domain}`).hostname !== scope.domain)
      throw new Error("Invalid private session domain");
    if (
      !Array.isArray(scope.allowedDomains) ||
      !scope.allowedDomains.length ||
      !scope.allowedDomains.includes(scope.domain) ||
      scope.allowedDomains.some(
        (d) =>
          typeof d !== "string" || publicTarget(`https://${d}`).hostname !== d,
      )
    )
      throw new Error("Invalid private session domains");
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private persist(record: PrivateSessionRecord) {
    this.save(structuredClone(record));
    this.records.set(this.key(record), record);
  }
  private async start() {
    if (this.failed) throw new Error("Private session recovery required");
    if (this.initialized) return;
    try {
      for (const record of this.records.values())
        await (await this.adapter()).replaceCookies([], record.allowedDomains);
      this.initialized = true;
    } catch {
      this.failed = true;
      throw new Error("Private session reset failed");
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    const next = Math.min(
      ...[...this.records.values()]
        .filter((r) => r.active)
        .map((r) => r.expiresAt),
    );
    if (Number.isFinite(next)) {
      this.timer = setTimeout(
        () => {
          void this.serial(() => this.expire()).catch(() => {});
        },
        Math.min(2_147_483_647, Math.max(1, next - this.now())),
      );
      this.timer.unref?.();
    }
  }
  private async expire() {
    for (const record of this.records.values())
      if (record.active && record.expiresAt <= this.now())
        await this.erase(record);
    this.schedule();
  }
  private async erase(record: PrivateSessionRecord, release = false) {
    const revoked = {
      ...record,
      active: false,
      revoked: record.revoked || !release,
    };
    try {
      this.persist(revoked);
    } catch {
      this.failed = true;
    }
    try {
      await (await this.adapter()).replaceCookies([], record.allowedDomains);
    } catch {
      this.failed = true;
    }
    if (this.failed) throw new Error("Private session clear failed");
  }
  install(input: PrivateSessionInstall, signal?: AbortSignal) {
    input = structuredClone(input);
    return this.serial(async () => {
      this.check(input);
      signal?.throwIfAborted();
      const { sessionMaterial } =
        await import("../../../packages/protocol/src/index.ts");
      const material = sessionMaterial.parse({
        connectionId: input.connectionId,
        profileId: input.profileId,
        runtimeId: input.runtimeId,
        revision: input.revision,
        expiresAt: input.expiresAt,
        allowedDomains: input.allowedDomains,
        cookies: input.cookies,
      });
      if (
        !Number.isSafeInteger(input.connectionGeneration) ||
        input.connectionGeneration < 1 ||
        material.expiresAt <= this.now() ||
        !material.allowedDomains.includes(input.domain) ||
        material.allowedDomains.some(
          (d) => publicTarget(`https://${d}`).hostname !== d,
        ) ||
        material.cookies.some(
          (c) =>
            !c.secure ||
            c.hostOnly !== !c.domain.startsWith(".") ||
            !material.allowedDomains.includes(c.domain.replace(/^\./, "")),
        )
      )
        throw new Error("Private session scope or expiry invalid");
      const old = this.records.get(this.key(input));
      if (
        old &&
        ((old.revoked &&
          old.connectionGeneration === 0 &&
          old.contextId === input.contextId) ||
          old.domain !== input.domain ||
          JSON.stringify([...old.allowedDomains].sort()) !==
            JSON.stringify([...input.allowedDomains].sort()) ||
          input.connectionGeneration < old.connectionGeneration ||
          (input.connectionGeneration === old.connectionGeneration &&
            (input.revision < old.revision ||
              (old.revoked &&
                old.contextId === input.contextId &&
                input.revision <= old.revision))))
      )
        throw new Error("Stale private session rejected");
      if (
        [...this.records.values()].some(
          (r) =>
            r.active &&
            this.key(r) !== this.key(input) &&
            r.allowedDomains.some((d) => input.allowedDomains.includes(d)),
        )
      )
        throw new Error("Overlapping private session scopes");
      await this.start();

      const ack: PrivateSessionAck = {
        owner: input.owner,
        contextId: input.contextId,
        generation: input.generation,
        domain: input.domain,
        tenantId: input.tenantId,
        profileId: input.profileId,
        runtimeId: input.runtimeId,
        connectionId: input.connectionId,
        allowedDomains: [...material.allowedDomains],
        revision: input.revision,
      };
      if (
        old?.active &&
        old.revision === input.revision &&
        old.connectionGeneration === input.connectionGeneration
      ) {
        if (old.expiresAt !== input.expiresAt)
          throw new Error("Private session revision mismatch");
        return ack;
      }
      const record: PrivateSessionRecord = {
        ...ack,
        connectionGeneration: input.connectionGeneration,
        expiresAt: material.expiresAt,
        allowedDomains: material.allowedDomains,
        active: false,
        revoked: false,
      };
      this.persist(record);
      try {
        signal?.throwIfAborted();
        await (
          await this.adapter(signal)
        ).replaceCookies(material.cookies, material.allowedDomains);
        signal?.throwIfAborted();
        if (material.expiresAt <= this.now())
          throw new Error("Expired private session");
        this.persist({ ...record, active: true });
        this.schedule();
        return ack;
      } catch {
        await this.erase(record);
        throw new Error("Private session installation failed");
      }
    });
  }
  clear(scope: PrivateSessionClear, signal?: AbortSignal) {
    scope = structuredClone(scope);
    return this.serial(async () => {
      this.check(scope);
      if (
        scope.reason !== undefined &&
        scope.reason !== "release" &&
        scope.reason !== "revoke"
      )
        throw new Error("Invalid private session clear reason");
      signal?.throwIfAborted();
      await this.start();
      const record = this.records.get(this.key(scope));
      if (record) {
        if (
          record.domain !== scope.domain ||
          JSON.stringify([...record.allowedDomains].sort()) !==
            JSON.stringify([...scope.allowedDomains].sort())
        )
          throw new Error("Private session scope mismatch");
        await this.erase(record, scope.reason === "release");
      } else if (scope.reason === "release") {
        // No installed metadata to release; erase only the explicitly scoped jar.
        // Unlike revoke, ordinary release must not invent a revision tombstone.
        try {
          await (await this.adapter()).replaceCookies([], scope.allowedDomains);
        } catch {
          this.failed = true;
          throw new Error("Private session clear failed");
        }
      } else {
        await this.erase({
          owner: scope.owner,
          contextId: scope.contextId,
          generation: scope.generation,
          domain: scope.domain,
          tenantId: scope.tenantId,
          profileId: scope.profileId,
          runtimeId: scope.runtimeId,
          connectionId: scope.connectionId,
          connectionGeneration: 0,
          revision: Number.MAX_SAFE_INTEGER,
          expiresAt: 0,
          allowedDomains: [...scope.allowedDomains],
          active: false,
          revoked: true,
        });
      }
      this.schedule();
    });
  }
  hasPrivateSession() { return [...this.records.values()].some(record => record.active); }
  hasPrivateHistory(hostname:string) { return [...this.records.values()].some(record=>record.allowedDomains.includes(hostname)); }
  inspectionAuthorized(hostname:string) {
    return !this.failed && [...this.records.values()].filter(record=>record.allowedDomains.includes(hostname))
      .every(record=>record.active && !record.revoked && record.expiresAt>this.now());
  }
  watchAuthorized(connectionId:string,revision:string,hostname:string) {
    return !this.failed && [...this.records.values()].some(record => record.connectionId===connectionId &&
      String(record.revision)===revision && record.active && !record.revoked && record.expiresAt>this.now() &&
      record.contextId===this.context.contextId && record.generation===this.context.generation && record.allowedDomains.includes(hostname));
  }
  run<T>(url: string | undefined, action: () => Promise<T>) {
    return this.serial(async () => {
      await this.start();
      const domain = url ? publicTarget(url).hostname : undefined;
      const expired = [...this.records.values()].some(
        (r) =>
          r.active &&
          r.expiresAt <= this.now() &&
          (!domain || r.allowedDomains.includes(domain)),
      );
      await this.expire();
      if (expired || this.failed)
        throw new Error("Private session lease expired");
      return action();
    });
  }
  close() {
    return this.serial(async () => {
      clearTimeout(this.timer);
      for (const record of this.records.values())
        if (record.active) {
          try {
            await (
              await this.adapter()
            ).replaceCookies([], record.allowedDomains);
          } catch {
            this.failed = true;
          }
        }
    });
  }
}
