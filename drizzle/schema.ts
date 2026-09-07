import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  fullName: text("full_name"),
  phone: varchar("phone", { length: 256 }),
});

export const unlockSchema = pgTable("unlock_schema", {
  version: integer("version").primaryKey(),
});

export const vaults = pgTable("vaults",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [unique("vaults_issuer_subject_key").on(table.issuer, table.subject)],
);

export const profiles = pgTable(
  "profiles",
  {
    tenant: text("tenant")
      .notNull()
      .references(() => vaults.id),
    id: text("id").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.tenant, table.id] })],
);

export const sources = pgTable(
  "sources",
  {
    tenant: text("tenant")
      .notNull()
      .references(() => vaults.id),
    id: text("id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    secret: jsonb("secret").notNull(),
    refs: jsonb("refs").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenant, table.id] })],
);

export const connections = pgTable("connections",
  {
    tenant: text("tenant")
      .notNull()
      .references(() => vaults.id),
    id: text("id").notNull(),
    name: text("name").notNull(),
    identity: text("identity").notNull(),
    domains: jsonb("domains").notNull(),
    website: text("website").notNull(),
    secret: jsonb("secret"),
    sourceId: text("source_id"),
    sourceRef: text("source_ref"),
    recipe: text("recipe"),
    maintenance: boolean("maintenance").notNull().default(false),
    version: integer("version").notNull().default(1),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenant, table.id] }),
    foreignKey({
      columns: [table.tenant, table.sourceId],
      foreignColumns: [sources.tenant, sources.id],
    }),
  ],
);

export const assignments = pgTable(
  "assignments",
  {
    tenant: text("tenant").notNull(),
    profile: text("profile").notNull(),
    connection: text("connection").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenant, table.profile, table.connection] }),
    foreignKey({
      columns: [table.tenant, table.profile],
      foreignColumns: [profiles.tenant, profiles.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenant, table.connection],
      foreignColumns: [connections.tenant, connections.id],
    }).onDelete("cascade"),
  ],
);

export const clients = pgTable(
  "clients",
  {
    tenant: text("tenant").notNull(),
    id: text("id").primaryKey(),
    profile: text("profile").notNull(),
    name: text("name").notNull(),
    redirects: jsonb("redirects").notNull(),
    connections: jsonb("connections").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    foreignKey({
      columns: [table.tenant, table.profile],
      foreignColumns: [profiles.tenant, profiles.id],
    }),
  ],
);

export const sessions = pgTable("sessions",
  {
    tenant: text("tenant").notNull(),
    connection: text("connection").notNull(),
    profile: text("profile").notNull(),
    client: text("client")
      .notNull()
      .references(() => clients.id),
    revision: integer("revision").notNull().default(1),
    secret: jsonb("secret").notNull(),
    verified: boolean("verified").notNull().default(false),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    generation: integer("generation").notNull(),
    status: text("status").notNull().default("unverified"),
  },
  (table) => [
    primaryKey({
      columns: [table.tenant, table.connection, table.profile, table.client],
    }),
    foreignKey({
      columns: [table.tenant, table.connection],
      foreignColumns: [connections.tenant, connections.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenant, table.profile],
      foreignColumns: [profiles.tenant, profiles.id],
    }).onDelete("cascade"),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    connection: text("connection").notNull(),
    profile: text("profile").notNull(),
    client: text("client")
      .notNull()
      .references(() => clients.id),
    generation: integer("generation").notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    due: bigint("due", { mode: "number" }).notNull(),
    claim: text("claim"),
    leaseUntil: bigint("lease_until", { mode: "number" }),
    error: text("error"),
  },
  (table) => [
    foreignKey({
      columns: [table.tenant, table.connection],
      foreignColumns: [connections.tenant, connections.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenant, table.profile],
      foreignColumns: [profiles.tenant, profiles.id],
    }).onDelete("cascade"),
    uniqueIndex("active_job")
      .on(table.tenant, table.connection, table.profile, table.client)
      .where(sql`state IN ('queued','running')`),
    index("due_jobs")
      .on(table.due)
      .where(sql`state='queued'`),
  ],
);

export const accountLocks = pgTable(
  "account_locks",
  {
    tenant: text("tenant").notNull(),
    connection: text("connection").notNull(),
    claim: text("claim").notNull(),
    leaseUntil: bigint("lease_until", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenant, table.connection] })],
);

export const ssoContexts = pgTable(
  "sso_contexts",
  {
    tenant: text("tenant")
      .notNull()
      .references(() => vaults.id),
    id: text("id").notNull(),
    identity: text("identity").notNull(),
    runtime: text("runtime").notNull(),
    secret: jsonb("secret").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.tenant, table.id] })],
);

export const connectionSso = pgTable(
  "connection_sso",
  {
    tenant: text("tenant").notNull(),
    connection: text("connection").notNull(),
    parent: text("parent").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenant, table.connection] }),
    foreignKey({
      columns: [table.tenant, table.connection],
      foreignColumns: [connections.tenant, connections.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenant, table.parent],
      foreignColumns: [ssoContexts.tenant, ssoContexts.id],
    }),
  ],
);

export const audit = pgTable(
  "audit",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant")
      .notNull()
      .references(() => vaults.id),
    at: bigint("at", { mode: "number" }).notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    detail: jsonb("detail").notNull(),
  },
  (table) => [index("audit_tenant_at").on(table.tenant, table.at.desc())],
);

export const ownerSessions = pgTable("owner_sessions", {
  hash: text("hash").primaryKey(),
  tenant: text("tenant")
    .notNull()
    .references(() => vaults.id),
  csrf: text("csrf").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const authStates = pgTable("auth_states", {
  hash: text("hash").primaryKey(),
  secret: jsonb("secret").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const imports = pgTable(
  "imports",
  {
    tenant: text("tenant")
      .notNull()
      .references(() => vaults.id),
    id: text("id").notNull(),
    secret: jsonb("secret").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    committed: boolean("committed").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.tenant, table.id] })],
);

export const oidcObjects = pgTable(
  "oidc_objects",
  {
    model: text("model").notNull(),
    id: text("id").notNull(),
    secret: jsonb("secret").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    consumed: bigint("consumed", { mode: "number" }),
    grantId: text("grant_id"),
    userCode: text("user_code"),
    uid: text("uid"),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.id] }),
    index("oidc_grants").on(table.grantId),
  ],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const connectorRecords = pgTable("connector_records", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const VAULT_TABLES = [
  "unlock_schema",
  "vaults",
  "profiles",
  "sources",
  "connections",
  "assignments",
  "clients",
  "sessions",
  "jobs",
  "account_locks",
  "sso_contexts",
  "connection_sso",
  "audit",
  "owner_sessions",
  "auth_states",
  "imports",
  "oidc_objects",
  "rate_limits",
  "users",
] as const;
