import type { Database } from "bun:sqlite";

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
