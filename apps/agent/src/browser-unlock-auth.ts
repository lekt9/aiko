/** Host-only Unlock broker. Never mount this API as a model tool or journal its private callbacks. */
import { createVaultAgent, type VaultCookie } from "../../../packages/sdk/src/agent.ts";
import { vaultTransport } from "../../../packages/sdk/src/vault-transport.ts";
import { z } from "@unlock/protocol";
import { parseConnectorVault, type ConnectorVaultConfig } from "./connector-vault.ts";
import { connectorDomain, type ConnectorEngine } from "./connectors.ts";
import { publicTarget } from "./browser-proxy.ts";
import { safeUserId } from "./security.ts";

export interface PrivateUnlockContext { owner: string; contextId: string; generation: number }
export interface PrivateUnlockScope extends PrivateUnlockContext {
  domain: string; tenantId: string; profileId: string; runtimeId: string; connectionId: string;
  allowedDomains: string[];
}
/** Trusted lifecycle reason only; omission always means revocation. */
export interface PrivateUnlockClear extends PrivateUnlockScope { reason?: "release" | "revoke" }
export interface PrivateUnlockInstall extends PrivateUnlockScope {
  connectionGeneration: number; revision: number; expiresAt: number; cookies: VaultCookie[];
}
export interface PrivateUnlockInstallAck extends PrivateUnlockScope { revision: number }
export type BrowserUnlockReceipt = { status: "ready"; revision: number } | { status: "not_applicable" | "unavailable" | "renewal_pending" };
export interface BrowserUnlockAuthOptions {
  owner: string;
  /** Operator-supplied only. A getter allows rotation/revocation to invalidate in-flight operations. */
  config: ConnectorVaultConfig | (() => ConnectorVaultConfig | undefined);
  engine: Pick<ConnectorEngine, "search">;
  context: { contextId: string; generation: number };
  currentContext(): Promise<PrivateUnlockContext>;
  /** Encrypted private VM seam. No runtime token/password included; VM uses SDK CDP cookie adapter. */
  install(material: PrivateUnlockInstall, signal: AbortSignal): Promise<PrivateUnlockInstallAck>;
  /** Must clear this scope or destroy its context. A failure keeps navigation blocked. */
  clear(scope: PrivateUnlockClear, signal: AbortSignal): Promise<void>;
  transport?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}
export type BrowserUnlockNavigation = PrivateUnlockContext & { url: string };
const statusSchema = z.object({
  tenantId: z.string().uuid(), profileId: z.string().uuid(), runtimeId: z.string().uuid(), connectionId: z.string().uuid(),
  allowedDomains: z.array(z.string()).min(1).max(100), verified: z.boolean(), revision: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(), renewable: z.boolean().optional(),
}).strict();
type Status = z.infer<typeof statusSchema>;
const equalDomains = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every(d => b.includes(d));
const validContext = (c: PrivateUnlockContext) => typeof c.owner === "string" && safeUserId(c.owner) && typeof c.contextId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(c.contextId) && Number.isSafeInteger(c.generation) && c.generation >= 1;
const sameContext = (a: PrivateUnlockContext, b: PrivateUnlockContext) => a.owner === b.owner && a.contextId === b.contextId && a.generation === b.generation;
const sameScope = (a: PrivateUnlockScope, b: PrivateUnlockScope) => sameContext(a,b) && a.domain === b.domain && a.tenantId === b.tenantId && a.profileId === b.profileId && a.runtimeId === b.runtimeId && a.connectionId === b.connectionId && equalDomains(a.allowedDomains,b.allowedDomains);
const unavailable = (): BrowserUnlockReceipt => ({status:"unavailable"});
function check(value: unknown): asserts value { if (!value) throw new Error("Private Unlock binding unavailable"); }
async function race<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener!: () => void;
  const aborted = new Promise<never>((_,reject)=>{listener=()=>reject(new Error("Private Unlock cancelled"));signal.addEventListener("abort",listener,{once:true});});
  try { return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return work();}),aborted]); }
  finally {signal.removeEventListener("abort",listener);}
}
/** One broker per exclusively owned browser context generation. Host must stop navigation on unavailable/pending.
 * No credential-bearing return value; raw material is forwarded only to install, then discarded.
 */
export function createBrowserUnlockAuth(input: BrowserUnlockAuthOptions) {
  const options = {...input,context:{...input.context}};
  const bound = {owner:options.owner,...options.context};
  if (!validContext(bound)) throw new Error("Invalid private browser context");
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid private broker deadline");
  type Installed = {scope: PrivateUnlockScope;ready:boolean;revision:number;connectionGeneration:number;expiresAt:number};
  const installed = new Map<string,Installed>();
  const renewals = new Map<string,BrowserUnlockReceipt>();
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run:()=>Promise<T>):Promise<T> {const next=tail.then(run,run);tail=next.then(()=>undefined,()=>undefined);return next;}
  async function clearInstalled(reason: "release" | "revoke" = "revoke") {
    let cleared = true;
    for (const [id,state] of installed) {
      try { const signal=AbortSignal.timeout(3000);await race(()=>options.clear({...structuredClone(state.scope),reason:state.ready ? reason : "revoke"},signal),signal);installed.delete(id); }
      catch { state.ready=false;cleared=false; }
    }
    return cleared;
  }
  const readConfig = () => {
    const raw = typeof options.config === "function" ? options.config() : options.config;
    return raw ? parseConnectorVault(JSON.stringify(raw)) : undefined;
  };
  async function context(signal:AbortSignal) {check(sameContext(bound,await race(()=>options.currentContext(),signal)));}
  async function operate(nav:BrowserUnlockNavigation, renew:boolean, signal:AbortSignal):Promise<BrowserUnlockReceipt> {
    check(validContext(nav) && sameContext(bound,nav));
    await context(signal);
    if ([...installed.values()].some(state=>!state.ready)) check(await clearInstalled());
    const url = publicTarget(nav.url);check(url.protocol === "https:");
    const domain = connectorDomain(url.origin);
    const config = readConfig(), account = config && Object.hasOwn(config.accounts,options.owner) ? config.accounts[options.owner] : undefined;
    if (!config || !account) return await clearInstalled() ? {status:"not_applicable"} : unavailable();
    const retained = [...installed.values()].every(({scope})=>scope.tenantId===account.tenantId && scope.profileId===account.profileId && scope.runtimeId===account.runtimeId && scope.allowedDomains.every(d=>account.connections[d]===scope.connectionId));
    if (!Object.hasOwn(account.connections,domain)) {
      // Public navigation is retirement only while the previous assignment still exists.
      return await clearInstalled(retained ? "release" : "revoke") ? {status:"not_applicable"} : unavailable();
    }
    const connectionId = account.connections[domain]!;
    // A task context carries one active connection, preventing stale jars from other accounts
    // being sent as subresource cookies without this navigation's fresh authorization check.
    if ([...installed.keys()].some(id=>id!==connectionId)) check(await clearInstalled(retained ? "release" : "revoke"));
    // SDK IDs are actual Unlock UUIDs; permissive historical config IDs never reach a request.
    [account.tenantId,account.profileId,account.runtimeId,connectionId].forEach(id=>z.string().uuid().parse(id));
    const current = async () => {
      await context(signal);
      const latest = readConfig(), mapped = latest?.accounts[options.owner];
      check(latest?.origin === config.origin && mapped && mapped.token === account.token && mapped.tenantId === account.tenantId && mapped.profileId === account.profileId && mapped.runtimeId === account.runtimeId && mapped.connections[domain] === connectionId);
      return mapped;
    };
    const absent = async (domains:string[]) => {
      for (const d of domains) {
        check(connectorDomain(d)===d);
        const mapped=await current();check(Object.hasOwn(mapped.connections,d) && mapped.connections[d]===connectionId);
        const search=await race(()=>options.engine.search(d),signal);
        check(search.status === "absent" && search.fallbackAllowed === true);
      }
    };
    const search=await race(()=>options.engine.search(domain),signal);
    if (search.status === "available") return await clearInstalled("release") ? {status:"not_applicable"} : unavailable();
    check(search.status === "absent" && search.fallbackAllowed === true);
    const prefix = `${config.origin}/v1/runtime/connections`;
    const allowed = new Map<string,string[]>([[prefix,["GET"]],[`${prefix}/${connectionId}/status`,["GET"]],[`${prefix}/${connectionId}/session`,["GET"]],[`${prefix}/${connectionId}/renew`,["POST"]]]);
    const transport = async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const targetUrl=String(target);check(allowed.get(targetUrl)?.includes(init?.method ?? "GET"));
      await current();
      const response = await (options.transport ?? fetch)(targetUrl,{...init,redirect:"manual",credentials:"omit"});
      if (response.status>=300 && response.status<400 || response.redirected || response.url && new URL(response.url).origin!==config.origin) {
        await response.body?.cancel().catch(()=>{});throw new Error("Private Unlock redirect rejected");
      }
      return response;
    };
    const sdkOptions = {baseUrl:`${config.origin}/v1`,token:account.token,transport:transport as typeof fetch,timeoutMs,credentials:"omit" as const};
    const agent=createVaultAgent(sdkOptions), statusRequest=vaultTransport(sdkOptions);
    const status = async () => {
      const s=await statusRequest(statusSchema,`runtime/connections/${connectionId}/status`,"GET",undefined,{signal});
      check(s.tenantId===account.tenantId && s.profileId===account.profileId && s.runtimeId===account.runtimeId && s.connectionId===connectionId && s.allowedDomains.includes(domain));
      check(new Set(s.allowedDomains).size===s.allowedDomains.length);
      return s;
    };
    const metadata = async () => {
      const rows=await agent.connections({signal}), matching=rows.filter(c=>c.id===connectionId);
      check(matching.length===1);const m=matching[0]!;
      check(!m.deleted && m.version>=1 && m.domains.includes(domain));
      return m;
    };
    const beforeMeta=await metadata(), before=await status();
    check(equalDomains(beforeMeta.domains,before.allowedDomains));
    await absent(before.allowedDomains);
    const scope:PrivateUnlockScope={...bound,domain,tenantId:account.tenantId,profileId:account.profileId,runtimeId:account.runtimeId,connectionId,allowedDomains:[...before.allowedDomains]};
    const verified=(s:Status)=>s.verified===true && s.revision>0 && s.expiresAt>Date.now();
    // The server's explicit false overrides legacy initial-session inference. Legacy expired
    // rows remain ambiguous; only the authoritative renewable flag permits their renewal.
    const renewable = before.renewable === true || before.renewable === undefined && before.revision===0 && before.expiresAt===0;
    if (renew || !before.verified && renewable) {
      check(beforeMeta.recipeId && (verified(before) || renewable));
      const renewalKey = `${connectionId}:${beforeMeta.version}:${before.revision}`;
      const prior=renewals.get(renewalKey);if(prior)return prior;
      check(await clearInstalled());
      renewals.set(renewalKey,unavailable()); // An uncertain POST must not be retried in this broker.
      await agent.requestRenewal(connectionId,{signal});
      const result:BrowserUnlockReceipt={status:"renewal_pending"};renewals.set(renewalKey,result);return result;
    }
    check(verified(before));
    const previous=installed.get(connectionId);
    // Metadata/status are always fresh; an unchanged jar is not reinjected on each navigation.
    if (previous?.ready && sameScope(previous.scope,scope) && previous.revision===before.revision && previous.connectionGeneration===beforeMeta.version && previous.expiresAt===before.expiresAt) {
      await current();check(verified(before));return {status:"ready",revision:before.revision};
    }
    const material=await agent.retrieve(connectionId,{signal});
    check(material.connectionId===connectionId && material.profileId===account.profileId && material.runtimeId===account.runtimeId && material.revision===before.revision && material.expiresAt===before.expiresAt && material.expiresAt>Date.now() && equalDomains(material.allowedDomains,before.allowedDomains) && material.cookies.length>0);
    for (const cookie of material.cookies) {
      check(cookie.secure && cookie.hostOnly===!cookie.domain.startsWith(".") && material.allowedDomains.includes(cookie.domain.replace(/^\./,"")) && (cookie.expires===-1 || cookie.expires*1000>Date.now()));
      if (cookie.partitionKey) check(material.allowedDomains.includes(new URL(cookie.partitionKey.topLevelSite).hostname));
    }
    const afterMeta=await metadata(), after=await status();
    check(afterMeta.version===beforeMeta.version && equalDomains(afterMeta.domains,before.allowedDomains) && verified(after) && after.revision===material.revision && after.expiresAt===material.expiresAt && equalDomains(after.allowedDomains,material.allowedDomains));
    await absent(material.allowedDomains);await current();check(material.expiresAt>Date.now());
    const packet:PrivateUnlockInstall={...scope,connectionGeneration:beforeMeta.version,revision:material.revision,expiresAt:material.expiresAt,cookies:material.cookies};
    // Mark a possibly partial installation BEFORE crossing the seam so any error triggers cleanup.
    installed.set(connectionId,{scope,ready:false,connectionGeneration:packet.connectionGeneration,revision:packet.revision,expiresAt:packet.expiresAt});
    const ack=await race(()=>options.install(structuredClone(packet),signal),signal);
    check(ack && sameScope(ack,scope) && ack.revision===packet.revision);
    await current();
    const final=await status();check(verified(final) && final.revision===packet.revision && final.expiresAt===packet.expiresAt && equalDomains(final.allowedDomains,scope.allowedDomains));
    installed.get(connectionId)!.ready=true;
    return {status:"ready",revision:packet.revision};
  }
  function operation(nav:BrowserUnlockNavigation,renew:boolean,external?:AbortSignal) {
    // Snapshot host navigation context immediately, before queued work can observe mutated arguments.
    const requested=structuredClone(nav);
    return serial(async()=>{
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
      const signal=external?AbortSignal.any([controller.signal,external]):controller.signal;
      try {return await race(()=>operate(requested,renew,signal),signal);}
      catch {await clearInstalled();return unavailable();}
      finally {clearTimeout(timer);controller.abort();}
    });
  }
  return {
    beforeNavigate:(nav:BrowserUnlockNavigation,signal?:AbortSignal)=>operation(nav,false,signal),
    requestRenewal:(nav:BrowserUnlockNavigation,signal?:AbortSignal)=>operation(nav,true,signal),
    /** Host-only routine close/retirement. Never weakens failed/partial-install fences. */
    release:(_signal?:AbortSignal)=>serial(async():Promise<BrowserUnlockReceipt>=>await clearInstalled("release")?{status:"not_applicable"}:unavailable()),
    clear:(_signal?:AbortSignal)=>serial(async():Promise<BrowserUnlockReceipt>=>await clearInstalled()?{status:"not_applicable"}:unavailable()),
  };
}
