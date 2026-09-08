import type { Database } from "bun:sqlite";
import { createHmac, randomUUID } from "node:crypto";
import type { VaultCipher } from "../../server/src/crypto.ts";
import { CdpBackgroundListener, type BackgroundObservation } from "./cdp-background-listener.ts";
import { BrowserObservationQueue } from "./browser-event-queue.ts";
import { browserEventOrigin, type BrowserProducerGrant } from "./browser-events.ts";
import { harnessDigest } from "./harness-library.ts";

export interface BrowserWatchLease {
  grant: BrowserProducerGrant;
  ingestUrl: string;
  networkRoutes?: { method: string; route: string }[];
  lifecycleRevision?: number;
  resumeFrom?: {lifecycleRevision:number;pausedThrough:number};
  leaseRevision?: number;
  renewalFrom?: {leaseRevision:number;expiresAt:number};
}
export interface BrowserWatchCoverageLapse {from:number;to:number;leaseRevision:number}
export interface BrowserWatchCoverageGap {
  generation:number;
  /** Confirmed misses; countUncertain means recovery only knows this lower bound. */
  missed:number;
  countUncertain:boolean;
  acknowledged:number;
  firstAt:number;
  lastAt:number;
  reason:"observation-backlog"|"observation-unavailable";
}
export interface BrowserWatchRunnerStatus {
  producer: string;
  generation: number;
  lifecycleRevision?: number;
  leaseRevision?: number;
  observationFloor?: number;
  coverageLapse?: BrowserWatchCoverageLapse;
  pausedThrough?: number;
  state: "watching" | "catching-up" | "needs-attention" | "paused";
  reason: string;
  expiresAt: number;
  lastEventAt?: number;
  lastDeliveredAt?: number;
  acknowledged?: number;
  /** Observation history at/before this privacy cut is deliberately excluded. */
  excludedBefore?: number;
  coverageGap?: BrowserWatchCoverageGap;
}
type Capture = Pick<CdpBackgroundListener,"connect"|"close"|"renewRecording"|"flush"|"health"> & {readonly observerTargetId?:string};
type StoredLease = BrowserWatchLease & {pausedThrough?:number;observationFloor?:number;coverageLapse?:BrowserWatchCoverageLapse};
type Entry = { lease: StoredLease; status: BrowserWatchRunnerStatus; capture?: Capture; nextRenew: number; nextAttempt:number; failures:number; stopped:boolean; delivery:AbortController; captureFailed?:boolean; gap?:BrowserWatchCoverageGap; gapPersistenceFailed?:boolean };
/** Owns only VM listening/transport. Native actor and channel logs own task execution. */
export class BrowserWatchRunner {
  private readonly queue: BrowserObservationQueue;
  private readonly watches=new Map<string,Entry>();
  private readonly networkOccurrences=new WeakMap<object,{id:string;cause?:string;leases:Map<string,Entry>}>();
  private mutations=Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private running?:Promise<void>;
  private closed=false;
  private suspended=false;
  private excludedBefore=0;
  private privacyRevision=0;
  private nextKeepAlive=0;
  private keepAliveFailed=false;
  private readonly lifetime=new AbortController();
  constructor(private readonly options:{
    owner:string;db:Database;cipher:VaultCipher;
    endpoint():Promise<string>;
    /** Trusted daemon liveness operation; never a page action or model call. */
    keepAlive?(signal:AbortSignal):Promise<void>;
    authorized(grant:BrowserProducerGrant):boolean;
    currentCause?():string|undefined;
    networkHealth?():{state:"watching"|"degraded"|"stopped";reason:string};
    fetch?:(input:Parameters<typeof fetch>[0],init?:RequestInit)=>Promise<Response>;
    now?():number;
    createCapture?:(options:ConstructorParameters<typeof CdpBackgroundListener>[0])=>Capture;
  }) {
    this.queue=new BrowserObservationQueue(options.db);
    options.db.exec("CREATE TABLE IF NOT EXISTS browser_watch_leases(producer TEXT PRIMARY KEY,owner TEXT NOT NULL,envelope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS browser_watch_privacy(owner TEXT PRIMARY KEY,envelope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS browser_watch_health(producer TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,envelope TEXT NOT NULL,pending INTEGER NOT NULL,PRIMARY KEY(producer,generation))");
    options.db.exec("CREATE TABLE IF NOT EXISTS browser_watch_observation_floors(producer TEXT PRIMARY KEY,owner TEXT NOT NULL,floor INTEGER NOT NULL,lapse_from INTEGER NOT NULL,lease_revision INTEGER NOT NULL)");
  }
  private now(){return this.options.now?.()??Date.now();}
  private context(producer:string){return `unlock:browser-watch:v1:${this.options.owner}:${producer}`;}
  private validate(raw:BrowserWatchLease) {
    const lease=structuredClone(raw),g=lease?.grant;
    if(!lease||typeof lease!=="object"||Array.isArray(lease))throw Error("browser_watch_lease_invalid");
    if(!Number.isSafeInteger(lease?.lifecycleRevision??0)||(lease.lifecycleRevision??0)<0 ||
      lease.resumeFrom!==undefined&&(!Number.isSafeInteger(lease.resumeFrom?.lifecycleRevision)||lease.resumeFrom.lifecycleRevision<0||
      !Number.isSafeInteger(lease.resumeFrom.pausedThrough)||lease.resumeFrom.pausedThrough<0) || "pausedThrough" in lease)
      throw Error("browser_watch_lifecycle_invalid");
    if(!Number.isSafeInteger(lease.leaseRevision??0)||(lease.leaseRevision??0)<0||
      lease.renewalFrom!==undefined&&(!Number.isSafeInteger(lease.renewalFrom?.leaseRevision)||lease.renewalFrom.leaseRevision<0||
      !Number.isSafeInteger(lease.renewalFrom.expiresAt)||lease.renewalFrom.expiresAt<1)||"observationFloor" in lease||"coverageLapse" in lease)
      throw Error("browser_watch_renewal_invalid");
    if(!g||g.owner!==this.options.owner||!g.active||!Number.isSafeInteger(g.expiresAt)||g.expiresAt<=this.now()||g.expiresAt>this.now()+86_400_000||
      !Number.isSafeInteger(g.registeredAt)||g.registeredAt>this.now()||!Number.isSafeInteger(g.generation)||g.generation<1||
      !/^[a-zA-Z0-9_.:-]{1,160}$/.test(g.producer)||!g.epoch||!g.profile||!g.connectionId||!g.connectionRevision||g.secret.length<32||
      !g.origins.length||g.origins.length>16||!g.kinds.length||g.kinds.some(k=>!["push","notification","network"].includes(k)))throw Error("browser_watch_lease_invalid");
    g.origins.forEach(browserEventOrigin);
    const url=new URL(lease.ingestUrl);
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.port||url.pathname!==`/v1/browser-events/${this.options.owner}`)throw Error("browser_watch_ingress_invalid");
    if((lease.networkRoutes?.length??0)>32||g.kinds.includes("network")&&!lease.networkRoutes?.length)throw Error("browser_watch_routes_required");
    for(const route of lease.networkRoutes??[])if(!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(route.method)||!/^\/[a-zA-Z0-9_/:.{}-]{0,511}$/.test(route.route)||route.route.includes(".."))throw Error("browser_watch_route_invalid");
    return lease;
  }
  private eligible(entry:Entry){return this.watches.get(entry.lease.grant.producer)===entry&&!this.closed&&!this.suspended&&!entry.stopped&&entry.lease.grant.active&&entry.lease.grant.expiresAt>this.now()&&this.options.authorized(entry.lease.grant);}
  private async savePrivacy(suspended:boolean,excludedBefore:number){
    const envelope=await this.options.cipher.seal(`unlock:browser-watch-privacy:v1:${this.options.owner}`,{suspended,excludedBefore});
    this.options.db.query("INSERT INTO browser_watch_privacy VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET envelope=excluded.envelope").run(this.options.owner,JSON.stringify(envelope));
  }
  async restore() {
    const privacy=this.options.db.query("SELECT envelope FROM browser_watch_privacy WHERE owner=?").get(this.options.owner) as {envelope:string}|null;
    if(privacy){
      const fence=await this.options.cipher.open<{suspended:boolean;excludedBefore:number}>(`unlock:browser-watch-privacy:v1:${this.options.owner}`,JSON.parse(privacy.envelope));
      if(typeof fence.suspended!=="boolean"||!Number.isSafeInteger(fence.excludedBefore)||fence.excludedBefore<0)throw Error("browser_watch_privacy_invalid");
      this.suspended=fence.suspended;this.excludedBefore=fence.excludedBefore;
    }
    for(const row of this.options.db.query("SELECT producer,owner,envelope FROM browser_watch_leases").all() as {producer:string;owner:string;envelope:string}[]) {
      if(row.owner!==this.options.owner)throw Error("browser_watch_owner_mismatch");
      const lease=await this.options.cipher.open<StoredLease>(this.context(row.producer),JSON.parse(row.envelope));
      if(lease.grant?.owner!==this.options.owner||lease.grant.producer!==row.producer)throw Error("browser_watch_owner_mismatch");
      if(!Number.isSafeInteger(lease.lifecycleRevision??0)||(lease.lifecycleRevision??0)<0||
        !Number.isSafeInteger(lease.leaseRevision??0)||(lease.leaseRevision??0)<0||
        lease.pausedThrough!==undefined&&(!Number.isSafeInteger(lease.pausedThrough)||lease.pausedThrough<0||lease.grant.active))throw Error("browser_watch_lifecycle_invalid");
      const floor=this.options.db.query("SELECT owner,floor,lapse_from,lease_revision FROM browser_watch_observation_floors WHERE producer=?").get(row.producer) as {owner:string;floor:number;lapse_from:number;lease_revision:number}|null;
      if(floor){
        if(floor.owner!==this.options.owner||!Number.isSafeInteger(floor.floor)||!Number.isSafeInteger(floor.lapse_from)||floor.lapse_from<1||floor.floor<floor.lapse_from||
          !Number.isSafeInteger(floor.lease_revision)||floor.lease_revision<1||floor.lease_revision>(lease.leaseRevision??0))throw Error("browser_watch_observation_floor_invalid");
        lease.observationFloor=floor.floor;lease.coverageLapse={from:floor.lapse_from,to:floor.floor,leaseRevision:floor.lease_revision};
      }
      if(lease.pausedThrough!==undefined&&lease.pausedThrough!==this.queue.highWatermark(lease.grant))throw Error("browser_watch_queue_watermark_unavailable");
      if(lease.grant.active&&lease.grant.expiresAt>this.now()){
        const raw={...lease};delete raw.observationFloor;delete raw.coverageLapse;
        this.validate(raw);
      }
      // Expiry is not an explicit pause and must not require a fabricated pause
      // watermark to renew. The eligibility check still prevents expired work.
      this.watches.set(row.producer,this.entry(lease,!lease.grant.active));
    }
    for(const entry of this.watches.values())await this.restoreHealth(entry);
    await this.tick();this.schedule();
  }
  private healthContext(entry:Entry){return `unlock:browser-watch-health:v1:${this.options.owner}:${entry.lease.grant.producer}:${entry.lease.grant.generation}`;}
  private async restoreHealth(entry:Entry){
    const row=this.options.db.query("SELECT owner,envelope,pending FROM browser_watch_health WHERE producer=? AND generation=?").get(entry.lease.grant.producer,entry.lease.grant.generation) as {owner:string;envelope:string;pending:number}|null;
    if(!row)return;
    if(row.owner!==this.options.owner)throw Error("browser_watch_owner_mismatch");
    if(row.envelope)entry.gap=await this.options.cipher.open<BrowserWatchCoverageGap>(this.healthContext(entry),JSON.parse(row.envelope));
    const gap=entry.gap;
    if(gap&&(!Number.isSafeInteger(gap.missed)||gap.missed<1||!Number.isSafeInteger(gap.acknowledged)||gap.acknowledged<0||gap.acknowledged>gap.missed||gap.generation!==entry.lease.grant.generation||typeof gap.countUncertain!=="boolean"||!Number.isSafeInteger(gap.firstAt)||!Number.isSafeInteger(gap.lastAt)||gap.lastAt<gap.firstAt||!["observation-backlog","observation-unavailable"].includes(gap.reason)))throw Error("browser_watch_health_invalid");
    if(row.pending){
      // A crash between marker and sealing never restores a falsely healthy watch.
      entry.gap={generation:entry.lease.grant.generation,missed:Math.min(Number.MAX_SAFE_INTEGER,(gap?.missed??0)+1),countUncertain:true,acknowledged:gap?.acknowledged??0,firstAt:gap?.firstAt??this.now(),lastAt:this.now(),reason:gap?.reason??"observation-unavailable"};
      await this.saveHealth(entry);
    }
  }
  private async saveHealth(entry:Entry){
    if(!entry.gap)return;
    const gap=structuredClone(entry.gap);
    const envelope=await this.options.cipher.seal(this.healthContext(entry),gap);
    this.options.db.query("INSERT INTO browser_watch_health VALUES(?,?,?,?,?) ON CONFLICT(producer,generation) DO UPDATE SET envelope=excluded.envelope,pending=excluded.pending").run(entry.lease.grant.producer,this.options.owner,entry.lease.grant.generation,JSON.stringify(envelope),entry.gap.missed===gap.missed?0:1);
    entry.gapPersistenceFailed=false;
  }
  private async observationGap(entry:Entry,error:unknown){
    const now=this.now(),prior=entry.gap;
    const reason=error instanceof Error&&error.message==="browser_observation_backlog"?"observation-backlog":"observation-unavailable";
    entry.gap={generation:entry.lease.grant.generation,missed:Math.min(Number.MAX_SAFE_INTEGER,(prior?.missed??0)+1),countUncertain:prior?.countUncertain??false,acknowledged:prior?.acknowledged??0,firstAt:prior?.firstAt??now,lastAt:now,reason};
    entry.status.state="needs-attention";entry.status.reason="observation-gap";
    try{
      // This value-free pending marker fences restart while the encrypted summary is being written.
      this.options.db.query("INSERT INTO browser_watch_health VALUES(?,?,?,'',1) ON CONFLICT(producer,generation) DO UPDATE SET pending=1").run(entry.lease.grant.producer,this.options.owner,entry.lease.grant.generation);
      await this.mutate(()=>this.saveHealth(entry));
    }catch{entry.gapPersistenceFailed=true;entry.status.reason="coverage-status-unavailable";}
  }
  /** Explicit owner acknowledgement retains the loss history; it does not claim recovered events. */
  async acknowledgeCoverageGap(producer:string,generation:number,missed:number){
    return this.mutate(async()=>{
      const entry=this.watches.get(producer);
      if(!entry||entry.lease.grant.generation!==generation||!entry.gap||entry.gap.missed!==missed||entry.gapPersistenceFailed)throw Error("browser_watch_gap_changed");
      const priorAcknowledged=entry.gap.acknowledged;
      entry.gap.acknowledged=missed;
      try{await this.saveHealth(entry);}catch(error){entry.gap.acknowledged=priorAcknowledged;entry.gapPersistenceFailed=true;throw error;}
      if(this.eligible(entry))this.captureStatus(entry);
      return this.status().find(status=>status.producer===producer)!;
    });
  }
  private entry(lease:StoredLease,stopped=false):Entry{return {lease,stopped,delivery:new AbortController(),nextRenew:0,nextAttempt:0,failures:0,status:{producer:lease.grant.producer,generation:lease.grant.generation,lifecycleRevision:lease.lifecycleRevision??0,leaseRevision:lease.leaseRevision??0,
    ...(lease.observationFloor===undefined?{}:{observationFloor:lease.observationFloor,coverageLapse:lease.coverageLapse}),
    ...(lease.pausedThrough===undefined?{}:{pausedThrough:lease.pausedThrough}),state:stopped?"paused":"needs-attention",reason:stopped?"paused":"attaching",expiresAt:lease.grant.expiresAt}};}
  private mutate<T>(action:()=>Promise<T>):Promise<T>{
    const next=this.mutations.then(action);this.mutations=next.then(()=>{},()=>{});return next;
  }
  async configure(raw:BrowserWatchLease) {
    const result=await this.mutate(()=>this.configureLease(raw));
    await this.tick();this.schedule();return this.status().find(s=>s.producer===result)!;
  }
  private async configureLease(raw:BrowserWatchLease) {
    if(this.closed)throw Error("browser_watch_runner_closed");
    const lease:StoredLease=this.validate(raw),key=lease.grant.producer,prior=this.watches.get(key),wasStopped=prior?.stopped;
    const leaseRevision=lease.leaseRevision??0,previousLeaseRevision=prior?.lease.leaseRevision??0,renewing=!!prior&&leaseRevision>previousLeaseRevision;
    let preservePause=false;
    if(!this.options.authorized(lease.grant))throw Error("browser_watch_connection_unavailable");
    if(prior&&prior.lease.grant.generation!==lease.grant.generation)throw Error("browser_watch_source_immutable_new_producer");
    if(prior&&prior.lease.grant.generation===lease.grant.generation){
      const revision=lease.lifecycleRevision??0,previous=prior.lease.lifecycleRevision??0;
      if(leaseRevision<previousLeaseRevision||leaseRevision>previousLeaseRevision+1)throw Error("browser_watch_stale_lease");
      if(renewing){
        if(lease.renewalFrom?.leaseRevision!==previousLeaseRevision||lease.renewalFrom.expiresAt!==prior.lease.grant.expiresAt||
          lease.grant.expiresAt<prior.lease.grant.expiresAt)throw Error("browser_watch_renewal_unconfirmed");
        if(revision!==previous)throw Error("browser_watch_stale_lifecycle");
      }else if(lease.grant.expiresAt!==prior.lease.grant.expiresAt||harnessDigest(lease.renewalFrom??null)!==harnessDigest(prior.lease.renewalFrom??null))throw Error("browser_watch_lease_conflict");
      preservePause=prior.stopped&&revision===previous&&(renewing||leaseRevision>0&&!!lease.renewalFrom);
      if(revision<previous||revision===previous&&prior.stopped&&!preservePause)throw Error("browser_watch_stale_lifecycle");
      if(revision>previous&&(!prior.stopped||prior.status.state!=="paused"||prior.status.pausedThrough===undefined||
        lease.resumeFrom?.lifecycleRevision!==previous||lease.resumeFrom.pausedThrough!==prior.status.pausedThrough||
        prior.status.pausedThrough!==this.queue.highWatermark(prior.lease.grant)))throw Error("browser_watch_resume_unconfirmed");
      const stable=(l:StoredLease)=>{const c=structuredClone(l);c.grant.expiresAt=0;c.grant.active=true;delete c.lifecycleRevision;delete c.resumeFrom;delete c.pausedThrough;delete c.leaseRevision;delete c.renewalFrom;delete c.observationFloor;delete c.coverageLapse;return harnessDigest(c);};
      if(stable(prior.lease)!==stable(lease))throw Error("browser_watch_generation_conflict");
    }else if((lease.lifecycleRevision??0)!==0||lease.resumeFrom||leaseRevision!==0||lease.renewalFrom)throw Error("browser_watch_resume_unconfirmed");
    if(preservePause){lease.grant.active=false;lease.pausedThrough=prior!.lease.pausedThrough;}
    if(prior?.lease.observationFloor!==undefined){lease.observationFloor=prior.lease.observationFloor;lease.coverageLapse=prior.lease.coverageLapse;}
    const envelope=await this.options.cipher.seal(this.context(key),lease);
    if(this.closed||!this.options.authorized({...lease.grant,active:true}))throw Error("browser_watch_connection_unavailable");
    if(prior&&(this.watches.get(key)!==prior||prior.stopped!==wasStopped))throw Error("browser_watch_stale_lifecycle");
    this.options.db.transaction(()=>{
      const committedAt=this.now();
      if(renewing&&!preservePause&&prior!.lease.grant.expiresAt<=committedAt){
        lease.observationFloor=Math.max(lease.observationFloor??0,committedAt);
        lease.coverageLapse={from:prior!.lease.grant.expiresAt,to:lease.observationFloor,leaseRevision};
        this.options.db.query("INSERT INTO browser_watch_observation_floors VALUES(?,?,?,?,?) ON CONFLICT(producer) DO UPDATE SET floor=excluded.floor,lapse_from=excluded.lapse_from,lease_revision=excluded.lease_revision")
          .run(key,this.options.owner,lease.observationFloor,lease.coverageLapse.from,leaseRevision);
      }
      this.options.db.query("INSERT INTO browser_watch_leases VALUES(?,?,?) ON CONFLICT(producer) DO UPDATE SET envelope=excluded.envelope").run(key,this.options.owner,JSON.stringify(envelope));
    })();
    if(prior&&prior.lease.grant.generation===lease.grant.generation&&(!prior.stopped||preservePause)){
      // A lease extension preserves the observer and its coverage; no detach/reattach gap.
      prior.lease=lease;prior.status.expiresAt=lease.grant.expiresAt;prior.status.leaseRevision=leaseRevision;
      prior.status.observationFloor=lease.observationFloor;prior.status.coverageLapse=lease.coverageLapse;
    }else{
      if(prior){prior.stopped=true;prior.delivery.abort();await prior.capture?.close();}
      const entry=this.entry(lease);await this.restoreHealth(entry);this.watches.set(key,entry);
    }
    return key;
  }
  private async observe(entry:Entry,event:BackgroundObservation) {
    if(!this.eligible(entry))throw Error("browser_watch_connection_unavailable");
    const kind=event.service==="pushMessaging"?"push":"notification";
    if(!entry.lease.grant.kinds.includes(kind)||event.historical||Math.floor(event.timestamp*1000)<=Math.max(this.excludedBefore,entry.lease.observationFloor??0))return;
    // Select actual receipt/display stage; synthetic DevTools dispatch is not a real push receipt.
    if(kind==="push"&&event.eventName!=="Push message received"||kind==="notification"&&!/^Notification (displayed|shown)$/i.test(event.eventName))return;
    const metadata=[...event.eventMetadata].sort((a,b)=>a.key.localeCompare(b.key)||a.value.localeCompare(b.value));
    const source=[event.service,event.origin,event.serviceWorkerRegistrationId,event.storageKey,event.timestamp,event.eventName,event.instanceId,metadata];
    const sourceId=createHmac("sha256",entry.lease.grant.secret).update(JSON.stringify(source.slice(0,-1))).digest("hex");
    try{
    const result=this.queue.append(entry.lease.grant,{kind,observedAt:Math.floor(event.timestamp*1000),sourceId,
      fields:{origin:event.origin,outcome:kind==="push"?"received":"displayed"},payload:metadata},sourceId,this.now());
    if(result.status==="queued")entry.status.lastEventAt=this.now();
    }catch(error){await this.observationGap(entry,error);}
    this.schedule(0);
  }
  async observeNetwork(raw:Record<string,unknown>,index:number,complete:boolean) {
    // The listener retains this exchange object through final extra-info callbacks.
    // Object identity distinguishes simultaneous requests and is never derived from a private URL.
    let occurrence=this.networkOccurrences.get(raw);
    if(!occurrence){occurrence={id:randomUUID(),cause:this.options.currentCause?.(),leases:new Map([...this.watches].filter(([,entry])=>this.eligible(entry)))};this.networkOccurrences.set(raw,occurrence);}
    if(!complete)return;
    const request=raw.request as {url?:string;method?:string}|undefined,response=raw.response as {status?:number}|undefined;
    if(!request?.url||!request.method||!Number.isInteger(response?.status))return;
    let url:URL;try{url=new URL(request.url);}catch{return;}
    const at=Date.parse(String(raw.startedDateTime));if(!Number.isSafeInteger(at)||at<=this.excludedBefore)return;
    for(const entry of this.watches.values()) {
      if(occurrence.leases.get(entry.lease.grant.producer)!==entry||!this.eligible(entry)||at<=(entry.lease.observationFloor??0)||!entry.lease.grant.kinds.includes("network")||!entry.lease.grant.origins.includes(url.origin))continue;
      const route=entry.lease.networkRoutes?.find(r=>r.method===request.method&&routeMatches(r.route,url.pathname));if(!route)continue;
      const sourceId=createHmac("sha256",entry.lease.grant.secret).update(occurrence.id).digest("hex");
      try{
      const result=this.queue.append(entry.lease.grant,{kind:"network",observedAt:at,sourceId,
        fields:{origin:url.origin,method:route.method,route:route.route,status:response!.status!,outcome:response!.status!>=200&&response!.status!<400?"completed":"failed"},...(occurrence.cause?{cause:occurrence.cause}:{})},sourceId,this.now());
      if(result.status==="queued")entry.status.lastEventAt=this.now();
      }catch(error){await this.observationGap(entry,error);}
    }
    this.schedule(0);
  }
  private schedule(delay=5000){
    if(this.closed)return;
    if(this.timer){if(delay!==0)return;clearTimeout(this.timer);}
    this.timer=setTimeout(()=>{this.timer=undefined;void this.tick().catch(()=>{}).finally(()=>this.schedule());},delay);this.timer.unref?.();
  }
  observerTargetIds():readonly string[]{return [...new Set([...this.watches.values()].flatMap(entry=>entry.capture?.observerTargetId?[entry.capture.observerTargetId]:[]))];}
  hasActiveLease(){return !this.closed&&[...this.watches.values()].some(entry=>!entry.stopped&&entry.lease.grant.active&&entry.lease.grant.expiresAt>this.now());}
  async suspend(){
    this.suspended=true;this.privacyRevision++;
    this.excludedBefore=Math.max(this.excludedBefore,this.now());
    for(const entry of this.watches.values())entry.delivery.abort();
    await Promise.allSettled([...this.watches.values()].map(entry=>entry.capture?.close()));
    await this.running;
    await this.mutate(()=>this.savePrivacy(true,this.excludedBefore));
    for(const entry of this.watches.values()){entry.capture=undefined;entry.status.state="needs-attention";entry.status.reason="private-sign-in";}
  }
  async resume(){
    if(this.closed||!this.suspended)return;
    const revision=++this.privacyRevision;
    // Recording can outlive this observer. Never replay the private interval after reconnect or restart.
    this.excludedBefore=Math.max(this.excludedBefore,this.now());
    await this.mutate(()=>this.savePrivacy(false,this.excludedBefore));
    if(revision!==this.privacyRevision||this.closed)return;
    for(const entry of this.watches.values())if(entry.delivery.signal.aborted&&!entry.stopped)entry.delivery=new AbortController();
    this.suspended=false;await this.tick();this.schedule();
  }
  private captureStatus(entry:Entry){
    const needsBackground=entry.lease.grant.kinds.some(k=>k!=="network");
    const background=entry.capture?.health;
    const network=entry.lease.grant.kinds.includes("network")?this.options.networkHealth?.()??{state:"degraded",reason:"network-capture-unavailable"}:undefined;
    const gap=entry.gap;
    const failed=entry.gapPersistenceFailed?{reason:"coverage-status-unavailable"}:gap&&gap.missed>gap.acknowledged?{reason:"observation-gap"}:this.keepAliveFailed?{reason:"browser-keep-alive-unavailable"}:entry.captureFailed?{reason:"capture-unavailable"}:needsBackground&&background?.state!=="watching"?background??{reason:"attaching"}:network&&network.state!=="watching"?network:undefined;
    entry.status.state=failed?"needs-attention":"watching";entry.status.reason=failed?.reason??(gap?"watching-after-acknowledged-gap":"ready");return entry.status.state;
  }
  async tick() {
    if(this.running)return this.running;
    this.running=this.step().finally(()=>{this.running=undefined;});return this.running;
  }
  private async step() {
    const live=[...this.watches.values()].find(entry=>this.eligible(entry));
    if(live&&this.options.keepAlive&&this.now()>=this.nextKeepAlive){
      this.nextKeepAlive=this.now()+120_000;
      try{await this.options.keepAlive(AbortSignal.any([this.lifetime.signal,live.delivery.signal,AbortSignal.timeout(30_000)]));this.keepAliveFailed=false;}
      catch{this.keepAliveFailed=true;this.nextKeepAlive=this.now()+30_000;}
    }
    for(const entry of this.watches.values()) {
      if(!this.eligible(entry)){
        await entry.capture?.close();entry.capture=undefined;
        entry.status.state=entry.stopped||entry.lease.grant.expiresAt<=this.now()?"paused":"needs-attention";
        entry.status.reason=this.suspended?"private-sign-in":entry.stopped?"paused":entry.lease.grant.expiresAt<=this.now()?"lease-expired":"connection-unavailable";continue;
      }
      if(entry.nextAttempt>this.now())continue;
      try {
        if(entry.gapPersistenceFailed){try{await this.mutate(()=>this.saveHealth(entry));}catch{}}
        // Delivery of already sealed observations proceeds even while capture reconnects.
        try {
        entry.captureFailed=false;
        if(entry.lease.grant.kinds.includes("network")&&this.options.networkHealth?.().state!=="watching"){
          await this.options.endpoint();if(!this.eligible(entry))throw Error("connection changed");
        }
        if(entry.lease.grant.kinds.some(k=>k!=="network")&&(!entry.capture||entry.capture.health.reason==="disconnected"||entry.capture.health.reason==="capture-failed")){
          await entry.capture?.close();
          const factory=this.options.createCapture??(options=>new CdpBackgroundListener(options));
          entry.capture=factory({origins:entry.lease.grant.origins,registeredAtMs:entry.lease.grant.registeredAt,onEvent:event=>this.observe(entry,event),signal:this.lifetime.signal});
          const endpoint=await this.options.endpoint();
          if(!this.eligible(entry))throw Error("connection changed");
          await entry.capture.connect(endpoint);entry.nextRenew=this.now()+86_400_000;
        }
        if(entry.capture&&(entry.nextRenew<=this.now()||entry.capture.health.reason==="recording-stopped")){
          await entry.capture.renewRecording();entry.nextRenew=this.now()+86_400_000;
        }
        }catch{entry.captureFailed=true;}
        if(!this.eligible(entry))throw Error("connection changed");
        this.captureStatus(entry);
        const transfer=this.queue.batch(entry.lease.grant);
        if(transfer){
          entry.status.state="catching-up";
          const response=await(this.options.fetch??fetch)(entry.lease.ingestUrl,{method:"POST",headers:{"content-type":"application/json","x-browser-signature":transfer.signature},body:JSON.stringify(transfer.batch),redirect:"error",signal:AbortSignal.any([this.lifetime.signal,entry.delivery.signal,AbortSignal.timeout(10000)])});
          if(!response.ok||response.status!==202)throw Error("browser_delivery_unavailable");
          const ack=await readAck(response);
          if(!["accepted","duplicate"].includes(ack.status)||!Number.isSafeInteger(ack.through)||ack.through<transfer.batch.items[0]!.sequence||ack.through>transfer.batch.items.at(-1)!.sequence)throw Error("browser_ack_invalid");
          if(!this.eligible(entry))throw Error("browser_watch_connection_unavailable");
          this.queue.acknowledge(entry.lease.grant,ack.through);entry.status.acknowledged=ack.through;entry.status.lastDeliveredAt=this.now();
          const captureState=this.captureStatus(entry);
          if(captureState==="watching"&&(transfer.hasMore||ack.through<transfer.batch.items.at(-1)!.sequence))entry.status.state="catching-up";
        }
        entry.failures=0;entry.nextAttempt=0;
      } catch {if(entry.stopped||this.suspended){entry.status.state=entry.stopped?"paused":"needs-attention";entry.status.reason=entry.stopped?"paused":"private-sign-in";continue;}entry.failures++;entry.nextAttempt=this.now()+Math.min(30_000,1000*2**Math.min(entry.failures,5));entry.status.state="needs-attention";entry.status.reason="capture-or-delivery-unavailable";}
    }
  }
  async pause(producer:string,lifecycleRevision=0) {
    if(!Number.isSafeInteger(lifecycleRevision)||lifecycleRevision<0)throw Error("browser_watch_lifecycle_invalid");
    // Revoke synchronously before encryption or a pending transport can finish.
    const current=this.watches.get(producer);
    if(!current)throw Error("browser_watch_missing");
    if((current.lease.lifecycleRevision??0)!==lifecycleRevision)throw Error("browser_watch_stale_lifecycle");
    current.stopped=true;current.delivery.abort();
    return this.mutate(async()=>{
      const entry=this.watches.get(producer);if(!entry)throw Error("browser_watch_missing");
      if(entry!==current||(entry.lease.lifecycleRevision??0)!==lifecycleRevision)throw Error("browser_watch_stale_lifecycle");
      entry.stopped=true;entry.delivery.abort();entry.lease.grant.active=false;
      entry.lease.pausedThrough=this.queue.highWatermark(entry.lease.grant);
      const envelope=await this.options.cipher.seal(this.context(producer),entry.lease);
      this.options.db.query("UPDATE browser_watch_leases SET envelope=? WHERE producer=? AND owner=?").run(JSON.stringify(envelope),producer,this.options.owner);
      await entry.capture?.close();entry.capture=undefined;entry.status.state="paused";entry.status.reason="paused";
      entry.status.lifecycleRevision=lifecycleRevision;entry.status.pausedThrough=entry.lease.pausedThrough;
      return {...entry.status};
    });
  }
  status(){return [...this.watches.values()].map(entry=>({...entry.status,...(entry.gap?{coverageGap:structuredClone(entry.gap)}:{}),...(this.excludedBefore?{excludedBefore:this.excludedBefore}:{})}));}
  async close(){this.closed=true;clearTimeout(this.timer);this.lifetime.abort();await Promise.allSettled([...this.watches.values()].map(entry=>entry.capture?.close()));await this.running;await this.mutations;}
}
export function routeMatches(template:string,path:string){
  const parts=template.split("/"),actual=path.split("/");
  return parts.length===actual.length&&parts.every((p,i)=>/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(p)||/^:[a-zA-Z_][a-zA-Z0-9_]*$/.test(p)?!!actual[i]:p===actual[i]);
}

async function readAck(response:Response):Promise<{status:string;through:number}> {
  if(!response.body)throw Error("browser_ack_invalid");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2048)throw Error("browser_ack_invalid");chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
