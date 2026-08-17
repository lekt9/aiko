-- Hoysan Drop-In — D1 fallback schema (Neon Postgres preferred, D1 compatible)
-- Workers: 51 DAY + 15 NIGHT + 32 NTS — S/N, NAME, HP, pool, class
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hp TEXT,
  pool TEXT CHECK (pool IN ('DAY','NIGHT','NTS')) NOT NULL,
  class TEXT CHECK (class IN ('LOCAL','TS','NTS','BLUE')) NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  shift TEXT CHECK (shift IN ('DAY','NIGHT')) NOT NULL,
  required INTEGER NOT NULL DEFAULT 40
);
CREATE TABLE IF NOT EXISTS roster_cells (
  worker_id TEXT NOT NULL REFERENCES workers(id),
  date TEXT NOT NULL,
  state TEXT CHECK (state IN ('X','ABS','SBY','MC','ON')) NOT NULL,
  fence_ok INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (worker_id, date)
);
CREATE TABLE IF NOT EXISTS ld_ledger (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  shift TEXT NOT NULL,
  informed_before_cutoff INTEGER NOT NULL,
  shortfall INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);
