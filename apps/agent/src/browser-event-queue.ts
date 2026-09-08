import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { BROWSER_EVENT_SCHEMA, browserBatchSignature, validateBrowserEventBatch, type BrowserOccurrence, type BrowserProducerGrant, type BrowserEventBatch } from "./browser-events.ts";
import { browserWatchRestorePrefixDigest } from "./browser-watch-restore.ts";

/** Owner-VM transport journal. Native actor logs remain authoritative; acknowledgements never replay browser effects. */
export class BrowserEventQueue {
  constructor(private db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS browser_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL); CREATE TABLE IF NOT EXISTS browser_delivery(singleton INTEGER PRIMARY KEY CHECK(singleton=1),acknowledged INTEGER NOT NULL); INSERT OR IGNORE INTO browser_delivery VALUES(1,0); CREATE TABLE IF NOT EXISTS browser_drafts(digest TEXT PRIMARY KEY,event TEXT NOT NULL)");
  }
  append(event: object) {
    const prepared = event as { type?: string; toolDigest?: string };
    const serialized = JSON.stringify({ ...event, at: Date.now() });
    if (Buffer.byteLength(serialized) > 256_000) throw new Error("Structural event exceeds native transport bound");
    this.db.transaction(() => {
      this.db.query("INSERT INTO browser_events(event) VALUES(?)").run(serialized);
      if (prepared.type === "BrowserNetworkToolPrepared" && prepared.toolDigest)
        this.db.query("INSERT OR IGNORE INTO browser_drafts(digest,event) VALUES(?,?)").run(prepared.toolDigest, serialized);
    })();
  }
  batch() {
    const rows = this.db.query("SELECT seq,event FROM browser_events ORDER BY seq LIMIT 257").all() as { seq: number; event: string }[];
    let bytes = 0, through = 0; const events: object[] = [];
    for (const row of rows) {
      const size = Buffer.byteLength(row.event);
      if (events.length && (events.length >= 256 || bytes + size > 128_000)) break;
      events.push(JSON.parse(row.event)); bytes += size; through = row.seq;
    }
    return { events, through, hasMore: rows.length > events.length };
  }
  acknowledge(through: unknown) {
    const head = (this.db.query("SELECT COALESCE(MAX(seq),0) AS head FROM browser_events").get() as { head: number }).head;
    const acknowledged = (this.db.query("SELECT acknowledged FROM browser_delivery WHERE singleton=1").get() as { acknowledged: number }).acknowledged;
    if (!Number.isSafeInteger(through) || Number(through) < 0 || Number(through) > Math.max(head, acknowledged)) throw new Error("Invalid trace cursor");
    this.db.transaction(() => {
      this.db.query("DELETE FROM browser_events WHERE seq<=?").run(Number(through));
      this.db.query("UPDATE browser_delivery SET acknowledged=MAX(acknowledged,?) WHERE singleton=1").run(Number(through));
    })();
  }
}

/** Browser observation transport uses the same VM SQLite journal, with encrypted
 * content and durable source fingerprints. Acknowledgement deletes content only. */
export class BrowserObservationQueue {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS browser_observation_heads(
      source TEXT PRIMARY KEY,owner TEXT NOT NULL,grant_digest TEXT NOT NULL,head INTEGER NOT NULL,ack INTEGER NOT NULL,offered INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_observation_items(
      source TEXT NOT NULL,seq INTEGER NOT NULL,fingerprint TEXT NOT NULL,sealed TEXT,PRIMARY KEY(source,seq),UNIQUE(source,fingerprint));`);
  }
  private identity(grant: BrowserProducerGrant, create = true) {
    if (grant.secret.length < 32) throw Error("browser_producer_key_invalid");
    const source = JSON.stringify([grant.producer, grant.epoch, grant.generation]);
    // Bind immutable producer context; expiry/active are live lease state.
    const { active: _active, expiresAt: _expiresAt, deliveryEpoch: _deliveryEpoch, ...context } = grant;
    const digest = createHmac("sha256", grant.secret).update(JSON.stringify(context)).digest("hex");
    if (create) this.db.query("INSERT OR IGNORE INTO browser_observation_heads VALUES(?,?,?,0,0,0)").run(source, grant.owner, digest);
    const state = this.db.query("SELECT * FROM browser_observation_heads WHERE source=?").get(source) as {owner:string;grant_digest:string;head:number;ack:number;offered:number};
    if (!state || state.owner !== grant.owner || state.grant_digest !== digest) throw Error("browser_producer_context_changed");
    if (![state.head,state.ack,state.offered].every(n=>Number.isSafeInteger(n)&&n>=0) || state.ack>state.offered || state.offered>state.head) throw Error("browser_observation_cursor_invalid");
    return { source, state, key: createHash("sha256").update(grant.secret).digest() };
  }
  append(grant: BrowserProducerGrant, input: Omit<BrowserOccurrence, "sequence" | "occurrence">, fingerprint: string, now = Date.now()) {
    if (!grant.active || grant.expiresAt <= now || !grant.kinds.includes(input.kind) || !grant.origins.includes(input.fields.origin)) throw Error("browser_watch_inactive");
    if (input.observedAt < grant.registeredAt) return { status: "historical" as const };
    if (!fingerprint || fingerprint.length > 4096) throw Error("browser_fingerprint_invalid");
    return this.db.transaction(() => {
      const { source, state, key } = this.identity(grant);
      const id = createHmac("sha256", key).update(fingerprint).digest("hex");
      const prior = this.db.query("SELECT seq FROM browser_observation_items WHERE source=? AND fingerprint=?").get(source, id) as {seq:number}|null;
      if (prior) return { status: "duplicate" as const, sequence: prior.seq };
      if (state.head - state.ack >= 1024) throw Error("browser_observation_backlog");
      const sequence = state.head + 1;
      const item: BrowserOccurrence = { ...input, sequence, occurrence: id };
      validateBrowserEventBatch({ schema: BROWSER_EVENT_SCHEMA, producer: grant.producer, epoch: grant.epoch, generation: grant.generation, items: [item] });
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([source, sequence, grant.owner])));
      const data = Buffer.concat([cipher.update(JSON.stringify(item)), cipher.final()]);
      const sealed = JSON.stringify({iv:Buffer.from(iv).toString("base64"),tag:Buffer.from(cipher.getAuthTag()).toString("base64"),data:data.toString("base64")});
      this.db.query("INSERT INTO browser_observation_items VALUES(?,?,?,?)").run(source, sequence, id, sealed);
      this.db.query("UPDATE browser_observation_heads SET head=? WHERE source=?").run(sequence, source);
      return { status: "queued" as const, sequence };
    })();
  }
  /** Includes acknowledged observations; pause cuts cannot shrink after content
   * deletion or host reconstruction. Identity is the exact private source. */
  highWatermark(grant: BrowserProducerGrant): number {
    return this.identity(grant).state.head;
  }
  /** Read-only continuity evidence. Missing or changed identity is not an empty queue. */
  verifiedState(grant: BrowserProducerGrant): {head:number;acknowledged:number;offered:number}|undefined {
    try {
      const {state}=this.identity(grant,false);
      return {head:state.head,acknowledged:state.ack,offered:state.offered};
    } catch { return undefined; }
  }
  restoreProof(grant:BrowserProducerGrant,hostThrough:number) {
    const queue=this.verifiedState(grant);
    if(!queue||!Number.isSafeInteger(hostThrough)||hostThrough<queue.acknowledged||hostThrough>queue.head)throw Error("browser_watch_restore_proof_unavailable");
    const source=JSON.stringify([grant.producer,grant.epoch,grant.generation]);
    const rows=this.db.query("SELECT seq,fingerprint FROM browser_observation_items WHERE source=? AND seq<=? ORDER BY seq").iterate(source,hostThrough) as Iterable<{seq:number;fingerprint:string}>;
    let count=0;
    function* pairs(){for(const row of rows){count++;yield [row.seq,row.fingerprint] as const;}}
    const prefixDigest=browserWatchRestorePrefixDigest(grant,pairs());
    if(count!==hostThrough)throw Error("browser_watch_restore_prefix_unavailable");
    return {queue,hostThrough,prefixDigest};
  }
  /** Only a separately checked restore permit may reconcile this proven prefix.
   * Caller commits this with transport incarnation and hold removal in one transaction. */
  acknowledgeRestoredPrefix(grant:BrowserProducerGrant,hostThrough:number,prefixDigest:string) {
    const proof=this.restoreProof(grant,hostThrough);
    if(proof.prefixDigest!==prefixDigest)throw Error("browser_watch_restore_prefix_changed");
    const source=JSON.stringify([grant.producer,grant.epoch,grant.generation]);
    this.db.query("UPDATE browser_observation_items SET sealed=NULL WHERE source=? AND seq<=?").run(source,hostThrough);
    this.db.query("UPDATE browser_observation_heads SET ack=?,offered=MAX(offered,?) WHERE source=?").run(hostThrough,hostThrough,source);
  }
  batch(grant: BrowserProducerGrant): {batch:BrowserEventBatch;signature:string;hasMore:boolean}|undefined {
    const { source, state, key } = this.identity(grant);
    const rows = this.db.query("SELECT seq,sealed FROM browser_observation_items WHERE source=? AND seq>? ORDER BY seq LIMIT 128").all(source,state.ack) as {seq:number;sealed:string|null}[];
    if (!rows.length) return;
    const items:BrowserOccurrence[]=[];
    for (const row of rows) {
      if (!row.sealed || row.seq !== state.ack + items.length + 1) throw Error("browser_observation_gap");
      const value=JSON.parse(row.sealed), decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(value.iv,"base64"));
      decipher.setAuthTag(Buffer.from(value.tag,"base64"));
      decipher.setAAD(Buffer.from(JSON.stringify([source,row.seq,grant.owner])));
      const item=JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,"base64")),decipher.final()]).toString());
      const proposed={schema:BROWSER_EVENT_SCHEMA,producer:grant.producer,epoch:grant.epoch,generation:grant.generation,...(grant.deliveryEpoch===undefined?{}:{deliveryEpoch:grant.deliveryEpoch}),items:[...items,item]};
      if (items.length && Buffer.byteLength(JSON.stringify(proposed)) > 128_000) break;
      items.push(item);
    }
    const batch=validateBrowserEventBatch({schema:BROWSER_EVENT_SCHEMA,producer:grant.producer,epoch:grant.epoch,generation:grant.generation,...(grant.deliveryEpoch===undefined?{}:{deliveryEpoch:grant.deliveryEpoch}),items});
    const through=items.at(-1)!.sequence;
    this.db.query("UPDATE browser_observation_heads SET offered=MAX(offered,?) WHERE source=?").run(through,source);
    return {batch,signature:browserBatchSignature(batch,grant.secret),hasMore:through<state.head};
  }
  acknowledge(grant: BrowserProducerGrant, through: number) {
    this.db.transaction(()=>{
      const {source,state}=this.identity(grant);
      if (!Number.isSafeInteger(through) || through<0 || through>state.offered) throw Error("browser_observation_ack_invalid");
      this.db.query("UPDATE browser_observation_items SET sealed=NULL WHERE source=? AND seq<=?").run(source,through);
      this.db.query("UPDATE browser_observation_heads SET ack=MAX(ack,?) WHERE source=?").run(through,source);
    })();
  }
  discard(grant: BrowserProducerGrant) {
    const {source}=this.identity(grant);
    this.db.query("UPDATE browser_observation_items SET sealed=NULL WHERE source=?").run(source);
    // Preserve the head and fingerprints: later reactivation cannot replay old work.
    this.db.query("UPDATE browser_observation_heads SET ack=head,offered=head WHERE source=?").run(source);
  }
}
