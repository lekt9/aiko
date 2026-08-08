import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type HaulioDb = ReturnType<typeof openDb>;

const DDL = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS firings (
  id TEXT PRIMARY KEY,
  cell TEXT NOT NULL,
  manifest TEXT NOT NULL,
  outputs TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  return {
    _db: db,
    upsertOrder(id: string, data: any) {
      db.prepare("INSERT OR REPLACE INTO orders (id, data, updated_at) VALUES (?, ?, ?)").run(id, JSON.stringify(data), new Date().toISOString());
    },
    orders(): any[] {
      return db.prepare("SELECT data FROM orders ORDER BY updated_at DESC").all().map((r: any) => JSON.parse(r.data));
    },
    recordFiring(id: string, cell: string, manifest: any, outputs: any) {
      db.prepare("INSERT OR REPLACE INTO firings (id, cell, manifest, outputs, created_at) VALUES (?, ?, ?, ?, ?)").run(id, cell, JSON.stringify(manifest), JSON.stringify(outputs), new Date().toISOString());
    },
    firings(): any[] {
      return db.prepare("SELECT * FROM firings ORDER BY created_at DESC LIMIT 20").all().map((r: any) => ({ ...r, manifest: JSON.parse(r.manifest), outputs: JSON.parse(r.outputs) }));
    },
  };
}

let singleton: HaulioDb | null = null;
export function getDb(): HaulioDb {
  if (singleton) return singleton;
  const p = process.env.HAULIO_DB ?? path.join(process.cwd(), "data", "haulio.db");
  singleton = openDb(p);
  // seed from out/ if empty (FounderOS pattern — adaptively; not branded)
  try {
    if (singleton.orders().length === 0) {
      const seedPath = path.resolve(process.cwd(), "..", "out/haulio-full");
      const invoice = fs.existsSync(path.join(seedPath, "invoice.json")) ? JSON.parse(fs.readFileSync(path.join(seedPath, "invoice.json"), "utf-8")) : null;
      const tracking = fs.existsSync(path.join(seedPath, "tracking.json")) ? JSON.parse(fs.readFileSync(path.join(seedPath, "tracking.json"), "utf-8")) : null;
      const manifest = fs.existsSync(path.join(seedPath, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(seedPath, "manifest.json"), "utf-8")) : null;
      if (invoice) singleton.upsertOrder(invoice.order_id ?? "ord-demo-001", invoice);
      if (manifest) singleton.recordFiring(manifest.produced_by ?? "seed", manifest.cell_path ?? "haulio-full.cell.yaml", manifest, { invoice, tracking });
    }
  } catch {}
  return singleton;
}
