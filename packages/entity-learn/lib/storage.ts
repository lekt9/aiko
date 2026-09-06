/** Synchronous SQLite boundary. Implementations own connection setup and transaction semantics. */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;
export interface SqlStatement {
  get(...parameters: SqlValue[]): SqlRow | undefined;
  all(...parameters: SqlValue[]): SqlRow[];
  run(...parameters: SqlValue[]): void;
  iterate(...parameters: SqlValue[]): Iterable<SqlRow>;
}
export interface MemoryStorage {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(run: () => T): T;
  read<T>(run: () => T): T;
  close(): void;
}
