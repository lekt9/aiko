import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export interface BrowserWatchRestoreStatus {
  challenge: string;
  at: number;
  /** Omitted when the original queue identity cannot be verified. */
  queue?: { head: number; acknowledged: number; offered: number };
}

export interface BrowserWatchRestoreProof {
  owner:string;
  producer:string;
  profile:string;
  epoch:string;
  generation:number;
  connectionId:string;
  connectionRevision:string;
  lifecycleRevision:number;
  leaseRevision:number;
  deliveryEpoch?:string;
  expiresAt:number;
  challenge:string;
  at:number;
  queue:{head:number;acknowledged:number;offered:number};
  hostThrough:number;
  prefixDigest:string;
}
export type BrowserWatchReauthorizeRequest = Omit<BrowserWatchRestoreProof,"deliveryEpoch"> & {
  previousDeliveryEpoch:string|null;
  deliveryEpoch:string;
};

/** Identical on the native host and private VM; hashes identities, never payloads. */
export function browserWatchRestorePrefixDigest(
  scope:{owner:string;producer:string;epoch:string;generation:number},
  items:Iterable<readonly [number,string]>,
):string {
  const hash=createHash("sha256").update(JSON.stringify(["browser-watch-restore-prefix-v1",scope.owner,scope.producer,scope.epoch,scope.generation]));
  let sequence=0;
  for(const item of items){
    if(item[0]!==++sequence||!/^([a-f0-9]{64})$/.test(item[1]))throw Error("browser_watch_restore_prefix_unavailable");
    hash.update("\n"+JSON.stringify(item));
  }
  return hash.digest("hex");
}

export function ensureBrowserWatchRestoreTable(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS browser_watch_restore_holds(producer TEXT PRIMARY KEY,owner TEXT NOT NULL,challenge TEXT NOT NULL,at INTEGER NOT NULL)");
}

/** Called only on a verified, unpublished snapshot while its runner is stopped.
 * Restoring credentials is not fresh authority to collect or deliver events.
 * No lease, queue cursor, fingerprint or pause watermark is rewritten. */
export function holdRestoredBrowserWatches(db: Database, owner: string, at = Date.now()) {
  if (!Number.isSafeInteger(at) || at < 1) throw Error("browser_watch_restore_invalid");
  ensureBrowserWatchRestoreTable(db);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_watch_leases'").get()) return;
  db.transaction(() => {
    for (const row of db.query("SELECT producer,owner FROM browser_watch_leases").all() as {producer:string;owner:string}[]) {
      if (row.owner !== owner) throw Error("browser_watch_owner_mismatch");
      db.query("INSERT INTO browser_watch_restore_holds VALUES(?,?,?,?) ON CONFLICT(producer) DO UPDATE SET owner=excluded.owner,challenge=excluded.challenge,at=excluded.at")
        .run(row.producer, owner, randomUUID(), at);
    }
  })();
}

/** Structural hold only. Ordinary lease controls intentionally have no clear operation. */
export function browserWatchRestoreHold(db: Database, owner: string, producer: string): BrowserWatchRestoreStatus | undefined {
  const row = db.query("SELECT owner,challenge,at FROM browser_watch_restore_holds WHERE producer=?").get(producer) as {owner:string;challenge:string;at:number}|null;
  if (!row) return;
  if (row.owner !== owner || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.challenge) || !Number.isSafeInteger(row.at) || row.at < 1)
    throw Error("browser_watch_restore_invalid");
  return {challenge:row.challenge, at:row.at};
}
