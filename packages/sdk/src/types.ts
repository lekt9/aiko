export type SessionStatus =
  "healthy" | "challenge" | "paused" | "source-unavailable" | "revoked";
export type CredentialKind = "password" | "session" | "both";
export interface Connection {
  id: string;
  name: string;
  domain: string;
  identity: string;
  kind: CredentialKind;
  sourceId: string;
  sourceLabel: string;
  sourceMode: "native" | "snapshot" | "reference" | "sso";
  status: SessionStatus;
  revision: number;
  verifiedAt: string;
  expiresAt: string;
  maintenance: boolean;
  recipe: string;
  createdAt: string;
  favorite?: boolean;
  /** CSV demo metadata contains no imported password. */
  passwordUnavailable?: boolean;
}
export interface CsvLoginRow {
  row: number;
  name: string;
  domain: string;
  identity: string;
}
export interface CsvImportInput {
  rows: CsvLoginRow[];
}
export interface CsvImportResult {
  imported: number;
  duplicates: number;
  invalid: number;
  rows: {
    row: number;
    status: "imported" | "duplicate" | "invalid";
    message: string;
    connectionId?: string;
  }[];
}
export interface LoginUpdate {
  name?: string;
  identity?: string;
  favorite?: boolean;
}
export type ProfileAvatar = "violet" | "blue" | "mint" | "peach";
export interface SessionMetadata {
  connectionId: string;
  status: SessionStatus;
  revision: number;
  verifiedAt: string;
  expiresAt: string;
  maintenance: boolean;
}
export interface Profile {
  avatar?: ProfileAvatar;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  connectionIds: string[];
}
export interface Source {
  id: string;
  name: string;
  kind: "native" | "snapshot" | "reference" | "sso";
  connected: boolean;
  description: string;
}
export interface Activity {
  id: string;
  at: string;
  action: string;
  subject: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
}
export interface OAuthClient {
  id: string;
  name: string;
  redirectUri: string;
  profileId: string;
  scopes: string[];
}
export interface Workspace {
  connections: Connection[];
  profiles: Profile[];
  sources: Source[];
  activity: Activity[];
  clients: OAuthClient[];
  settings: { name: string; digest: boolean };
  demo: true;
}
export type ConnectionAction =
  "refresh" | "pause" | "resume" | "challenge" | "recover" | "revoke";
export interface ConnectInput {
  fixture: "github" | "linear" | "notion" | "figma" | "vercel";
  mode: "native" | "session" | "import" | "reference" | "sso";
  profileIds: string[];
}
export interface ClientInput {
  name: string;
  redirectUri: string;
  profileId: string;
}
export interface ProfileInput {
  name: string;
  description: string;
  avatar?: ProfileAvatar;
  connectionIds?: string[];
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface ClientOptions {
  baseUrl: string;
  token?: string | (() => string | undefined | Promise<string | undefined>);
  transport?: typeof fetch;
  timeoutMs?: number;
  credentials?: "omit" | "same-origin" | "include";
  headers?: () => HeadersInit | Promise<HeadersInit>;
}
