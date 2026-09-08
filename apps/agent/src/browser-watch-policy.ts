import { randomBytes } from "node:crypto";
import type { BrowserWatchHostPolicy, BrowserWatchNativeActions } from "./channel-host.ts";
import type { ConnectorEngine, BrowserWatchConnectionAuthority } from "./connectors.ts";
import type { CodegraffSandbox } from "./codegraff.ts";
import type { BrowserWatchConfig, BrowserWatchDiscovery } from "./browser-watches.ts";
import { browserEventOrigin, validateBrowserEventFields } from "./browser-events.ts";
import { publicTarget } from "./browser-proxy.ts";
import { harnessDigest, type HarnessLibrary } from "./harness-library.ts";

export interface NativeBrowserWatchPolicyOptions {
  owner: string;
  /** Canonical operator-configured HTTPS origin, never an incoming Host header. */
  ingressOrigin: string;
  connections: Pick<ConnectorEngine, "browserWatchAuthority" | "browserWatchAuthorities">;
  /** The already-owned private browser session; this adapter never constructs one. */
  runner: Pick<CodegraffSandbox, "watchContext" | "watchConfigure" | "watchPause" | "watchStatus" | "watchAcknowledgeGap"> & Partial<Pick<CodegraffSandbox, "watchRestoreProof" | "watchReauthorize">>;
  library: HarnessLibrary;
  receivingAuthority: string;
  current(): boolean;
  /** Trusted capability metadata, not proof of deployed event delivery. An owned
   * connection alone must never manufacture a push, notification or route choice. */
  discoverSources(authorities: readonly BrowserWatchConnectionAuthority[], signal: AbortSignal): Promise<BrowserWatchDiscovery["sites"]>;
  /** Trusted saved action choices. Harness execution still checks evaluation;
   * actor/webhook choices additionally require their mounted native capability. */
  discoverActions(signal: AbortSignal): Promise<BrowserWatchDiscovery["actions"]>;
  nativeActions?: BrowserWatchNativeActions;
  defaults: BrowserWatchDiscovery["defaults"];
}
const id = /^[A-Za-z0-9_.-]{1,64}$/;
const opaque = /^[A-Za-z0-9_.:-]{1,160}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const text = (value:string) => {
  if(typeof value!=="string"||!value.trim()||value.length>160)throw Error("watch_discovery_invalid");
  return value;
};
const bounded = <T>(value:T):T => {
  if(Buffer.byteLength(JSON.stringify(value))>262144)throw Error("watch_discovery_invalid");
  return structuredClone(value);
};

/** Host composition only. Source discovery and the same-session runner remain
 * explicit deployment dependencies; no source is inferred or enabled here. */
export function nativeBrowserWatchPolicy(options:NativeBrowserWatchPolicyOptions):BrowserWatchHostPolicy {
  if(options.nativeActions?.actor && typeof options.nativeActions.actor.commitCurrent!=="function")
    throw Error("watch_actor_commit_authority_required");
  const origin=browserEventOrigin(options.ingressOrigin);
  publicTarget(origin);
  const defaults=structuredClone(options.defaults);
  if(!opaque.test(options.owner)||!opaque.test(options.receivingAuthority)||
    options.library.binding.owner!==options.owner||options.library.binding.thread!==`user-${options.owner}`)
    throw Error("watch_policy_owner_invalid");
  if(!Number.isSafeInteger(defaults.expiresInMs)||defaults.expiresInMs<1000||defaults.expiresInMs>86400000||
    !Number.isSafeInteger(defaults.backlog)||defaults.backlog<1||defaults.backlog>128||
    !Number.isSafeInteger(defaults.maxOccurrences)||defaults.maxOccurrences<1||defaults.maxOccurrences>1000000)
    throw Error("watch_policy_defaults_invalid");
  const ingestUrl=`${origin}/v1/browser-events/${encodeURIComponent(options.owner)}`;
  const boundedSignal=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const guard=(signal:AbortSignal)=>{signal.throwIfAborted();if(!options.current())throw Error("watch_authority_unavailable");};
  const validAuthority=(a:BrowserWatchConnectionAuthority|undefined):a is BrowserWatchConnectionAuthority => !!a&&
    a.owner===options.owner&&a.native===true&&a.status==="connected"&&Number.isSafeInteger(a.revision)&&a.revision>0&&
    Number.isSafeInteger(a.expiresAt)&&a.expiresAt>Date.now();
  const authorityFor=async(connectionId:string,signal:AbortSignal)=>{
    guard(signal);
    const authority=await options.connections.browserWatchAuthority(connectionId);
    guard(signal);
    if(!validAuthority(authority)||authority.connectionId!==connectionId)throw Error("watch_connection_unavailable");
    return authority;
  };
  const matches=(a:BrowserWatchConnectionAuthority,site:{connectionId:string;connectionRevision:string;origin:string})=>
    a.connectionId===site.connectionId&&String(a.revision)===site.connectionRevision&&site.origin===`https://${a.domain}`;
  const sourceChoices=async(signal:AbortSignal):Promise<BrowserWatchDiscovery["sites"]>=>{
    guard(signal);
    const authorities=(await options.connections.browserWatchAuthorities()).filter(validAuthority);
    if(authorities.length>128)throw Error("watch_discovery_invalid");
    const supplied=bounded(await options.discoverSources(structuredClone(authorities),signal));
    guard(signal);
    if(!Array.isArray(supplied)||supplied.length>128||new Set(supplied.map(s=>s.connectionId)).size!==supplied.length)
      throw Error("watch_discovery_invalid");
    const sites:BrowserWatchDiscovery["sites"]=[];
    for(const site of supplied){
      const known=authorities.find(a=>matches(a,site));
      if(!known)continue;
      const authority=await authorityFor(site.connectionId,signal);
      if(!matches(authority,site))continue;
      browserEventOrigin(site.origin);publicTarget(site.origin);
      if(!Number.isSafeInteger(site.sourceGeneration)||site.sourceGeneration<1||!Array.isArray(site.events)||site.events.length>32||
        new Set(site.events.map(e=>e.id)).size!==site.events.length)throw Error("watch_discovery_invalid");
      const events=site.events.map(event=>{
        if(!id.test(event.id)||!["push","notification","network"].includes(event.kind))throw Error("watch_discovery_invalid");
        validateBrowserEventFields({origin:site.origin,outcome:event.outcome,...(event.method===undefined?{}:{method:event.method}),
          ...(event.route===undefined?{}:{route:event.route}),...(event.kind==="network"?{status:0}:{})},event.kind);
        return {id:event.id,label:text(event.label),kind:event.kind,outcome:event.outcome,
          ...(event.method===undefined?{}:{method:event.method}),...(event.route===undefined?{}:{route:event.route})};
      });
      if(events.length)sites.push({connectionId:site.connectionId,label:text(site.label),origin:site.origin,
        connectionRevision:site.connectionRevision,sourceGeneration:site.sourceGeneration,events});
    }
    guard(signal);return sites;
  };
  const actionChoices=async(signal:AbortSignal):Promise<BrowserWatchDiscovery["actions"]>=>{
    guard(signal);const supplied=bounded(await options.discoverActions(signal));guard(signal);
    if(!Array.isArray(supplied)||supplied.length>128||new Set(supplied.map(a=>a.id)).size!==supplied.length)throw Error("watch_discovery_invalid");
    const actions:BrowserWatchDiscovery["actions"]=[];
    for(const choice of supplied){
      if(choice.action?.kind==="actor"||choice.action?.kind==="webhook"){
        const action=choice.action;
        if(!options.nativeActions?.[action.kind])continue;
        if(!id.test(choice.id)||choice.description!==undefined&&(typeof choice.description!=="string"||choice.description.length>1000)||
          (action.kind==="actor" ? typeof action.instruction!=="string"||!action.instruction.trim()||action.instruction.length>8000||
            Object.keys(action).some(k=>!["kind","instruction"].includes(k))||choice.supportsInstruction!==undefined&&typeof choice.supportsInstruction!=="boolean"
            : !id.test(action.destination)||Object.keys(action).some(k=>!["kind","destination"].includes(k))||choice.supportsInstruction!==undefined))throw Error("watch_discovery_invalid");
        actions.push({id:choice.id,label:text(choice.label),...(choice.description===undefined?{}:{description:choice.description}),action:structuredClone(action),
          ...(choice.supportsInstruction===undefined?{}:{supportsInstruction:choice.supportsInstruction})});
        continue;
      }
      if(choice.action?.kind!=="harness")continue;
      const action=choice.action;
      if(!id.test(choice.id)||!digest.test(action.digest)||!digest.test(action.contractDigest)||
        Object.keys(action).some(k=>!["kind","digest","contractDigest","input","eventInputs"].includes(k))||
        Buffer.byteLength(JSON.stringify(action))>32768||choice.supportsInstruction!==undefined||
        choice.description!==undefined&&(typeof choice.description!=="string"||choice.description.length>1000))throw Error("watch_discovery_invalid");
      const resolved=await options.library.resolve(action.digest);
      if(resolved.artifact.contractDigest!==action.contractDigest)throw Error("watch_contract_pin_mismatch");
      actions.push({id:choice.id,label:text(choice.label),...(choice.description===undefined?{}:{description:choice.description}),action:structuredClone(action)});
    }
    guard(signal);return actions;
  };
  const sourceMatches=(sites:BrowserWatchDiscovery["sites"],config:Pick<BrowserWatchConfig,"connectionId"|"connectionRevision"|"origin"|"sourceGeneration"|"kind"|"outcome"|"method"|"route">)=>
    sites.some(site=>site.connectionId===config.connectionId&&site.connectionRevision===config.connectionRevision&&site.origin===config.origin&&
      site.sourceGeneration===config.sourceGeneration&&site.events.some(event=>event.kind===config.kind&&event.outcome===config.outcome&&event.method===config.method&&event.route===config.route));
  const authorize=async(raw:BrowserWatchConfig,operation:"configure"|"dispatch"|"reconcile",signal:AbortSignal)=>{
    try {
      const config=structuredClone(raw);
      guard(signal);
      if(!config.action||!Number.isSafeInteger(config.expiresAt)||operation!=="reconcile"&&config.expiresAt<=Date.now())return false;
      const sites=await sourceChoices(signal),actions=await actionChoices(signal);
      const authority=await authorityFor(config.connectionId,signal);
      return matches(authority,config)&&(operation==="reconcile"||config.expiresAt>Date.now()&&config.expiresAt<=authority.expiresAt)&&sourceMatches(sites,config)&&
        actions.some(choice=>harnessDigest(choice.action)===harnessDigest(config.action)||
          choice.action.kind==="actor"&&config.action.kind==="actor"&&choice.supportsInstruction===true&&
          typeof config.action.instruction==="string"&&!!config.action.instruction.trim()&&config.action.instruction.length<=8000&&
          Object.keys(config.action).every(k=>["kind","instruction"].includes(k)));
    }catch(error){signal.throwIfAborted();return false;}
  };
  return context=>{
    if(context.owner!==options.owner||context.thread!==`user-${options.owner}`)throw Error("watch_policy_owner_invalid");
    return {
      library:options.library,receivingAuthority:options.receivingAuthority,current:()=>options.current(),
      ...(options.nativeActions?{nativeActions:options.nativeActions}:{}),
      discovery:async signal=>{
        const sites=await sourceChoices(signal),actions=await actionChoices(signal);
        const currentSites:typeof sites=[];
        for(const site of sites){
          const authority=await authorityFor(site.connectionId,signal);
          if(matches(authority,site))currentSites.push({...site,expiresAt:authority.expiresAt});
        }
        guard(signal);
        const now=Date.now(),available=currentSites.filter(site=>site.expiresAt!-now>=1000);
        return {sites:available,actions,defaults:{...defaults,
          expiresInMs:Math.min(defaults.expiresInMs,...available.map(site=>site.expiresAt!-now))}};
      },authorize,
      prepareLease:async(raw,rawIdentity,callerSignal?:AbortSignal)=>{
        const config=structuredClone(raw),identity=structuredClone(rawIdentity),signal=boundedSignal(callerSignal);
        if(!await authorize(config,"configure",signal))throw Error("watch_authority_unavailable");
        const privateContext=await options.runner.watchContext(signal);
        if(privateContext.owner!==options.owner||!opaque.test(privateContext.profile))throw Error("watch_profile_unavailable");
        if(!await authorize(config,"configure",signal))throw Error("watch_authority_unavailable");
        if(!opaque.test(identity.producer)||!opaque.test(identity.epoch)||!Number.isSafeInteger(identity.registeredAt)||identity.registeredAt<0||identity.registeredAt> Date.now())
          throw Error("watch_producer_identity_invalid");
        // createBrowserWatches seals this lease with channelSeal in native custody.
        return {grant:{owner:options.owner,producer:identity.producer,epoch:identity.epoch,registeredAt:identity.registeredAt,profile:privateContext.profile,generation:config.sourceGeneration,
          connectionId:config.connectionId,connectionRevision:config.connectionRevision,origins:[config.origin],kinds:[config.kind],
          active:true,expiresAt:config.expiresAt,secret:Buffer.from(randomBytes(32)).toString("base64url")},ingestUrl,
          ...(config.kind==="network"?{networkRoutes:[{method:config.method!,route:config.route!}]}:{})};
      },
      configureLease:async(raw,callerSignal?:AbortSignal)=>{
        const lease=structuredClone(raw),signal=boundedSignal(callerSignal),g=lease.grant;
        guard(signal);
        if(g.owner!==options.owner||!g.active||lease.ingestUrl!==ingestUrl||g.origins.length!==1||g.kinds.length!==1)throw Error("watch_producer_binding_mismatch");
        const sites=await sourceChoices(signal);
        const site=sites.find(s=>s.connectionId===g.connectionId&&s.connectionRevision===g.connectionRevision&&s.sourceGeneration===g.generation&&s.origin===g.origins[0]);
        if(!site||!site.events.some(e=>e.kind===g.kinds[0]&&(e.kind!=="network"||
          Array.isArray(lease.networkRoutes)&&harnessDigest(lease.networkRoutes)===harnessDigest([{method:e.method,route:e.route}]))))throw Error("watch_source_unavailable");
        if(g.kinds[0]!=="network"&&lease.networkRoutes!==undefined)throw Error("watch_source_unavailable");
        const privateContext=await options.runner.watchContext(signal);
        const authority=await authorityFor(g.connectionId,signal);
        if(privateContext.owner!==options.owner||privateContext.profile!==g.profile||!matches(authority,{connectionId:g.connectionId,connectionRevision:g.connectionRevision,origin:g.origins[0]!})||
          !Number.isSafeInteger(g.expiresAt)||g.expiresAt<=Date.now()||g.expiresAt>authority.expiresAt)throw Error("watch_authority_unavailable");
        return options.runner.watchConfigure(structuredClone(lease),signal);
      },
      ...(options.runner.watchRestoreProof && options.runner.watchReauthorize ? {
        restoreProof: (producer: string, challenge: string, hostThrough: number, signal: AbortSignal) => options.runner.watchRestoreProof!(producer, challenge, hostThrough, boundedSignal(signal)),
        reauthorizeLease: (p: import("./browser-watch-reauthorization.ts").BrowserWatchRestorePermit, signal: AbortSignal) => options.runner.watchReauthorize!(p.producer, {
          owner: p.owner, producer: p.producer, profile: p.profile, epoch: p.epoch, generation: p.sourceGeneration,
          connectionId: p.connectionId, connectionRevision: p.connectionRevision, lifecycleRevision: p.lifecycleRevision, leaseRevision: p.leaseRevision,
          previousDeliveryEpoch: p.previousDeliveryEpoch, deliveryEpoch: p.deliveryEpoch, expiresAt: p.expiresAt, challenge: p.challenge, at: p.restoreAt,
          queue: { head: p.queueHead, acknowledged: p.queueAcknowledged, offered: p.queueOffered }, hostThrough: p.hostThrough, prefixDigest: p.prefixDigest,
        }, boundedSignal(signal)),
      } : {}),
      pauseLease:(producer,signal,lifecycleRevision)=>options.runner.watchPause(producer,signal,lifecycleRevision),
      leaseStatus:async(producer,signal)=>(await options.runner.watchStatus(signal)).find(status=>status.producer===producer),
      acknowledgeGap:(producer,generation,missed,signal)=>options.runner.watchAcknowledgeGap(producer,generation,missed,signal),
    };
  };
}
