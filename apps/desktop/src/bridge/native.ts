import { invoke } from "@tauri-apps/api/core";
import type { ContractSummary, RuntimeHealth } from "../app/types";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export interface TelegramSettings {
  botToken?: string;
  approvedUserIds: number[];
  bridgeRunning: boolean;
  bridgeLog: string[];
}

export interface TelegramPairResult {
  ok: boolean;
  userId?: number;
  error?: string;
}

export interface ReflexCandidate {
  binary: string;
  energy: number;
  context_energy: number;
  transition_energy: number | null;
  fires: number;
  successes: number;
  failures: number;
  confidence: number;
  evidence_ready: boolean;
}

export interface ReflexPolicy {
  reflexes_enabled: boolean;
  activity_sensors_enabled: boolean;
  retention_days: number;
  max_automatic_cost: number;
  capabilities: Record<string, boolean>;
  excluded_applications: string[];
}

export interface ActivityEvent {
  schema: number;
  event: "foreground_application";
  application: string;
  observed_unix: number;
}

export type CollectivePublicationMode =
  | "disabled"
  | "safe_public_shapes"
  | "review_every_object";

export interface CollectiveStatus {
  available: boolean;
  participation_enabled: boolean;
  publication_mode: CollectivePublicationMode;
  publish_aggregate_attestations: boolean;
  connected_peers: number;
  local_peer_id?: string;
  objects: number;
  quarantined: number;
  pinned: number;
  object_bytes: number;
  error?: string;
}

export interface CollectiveAuditEvent {
  timestamp: string;
  action: string;
  object_id?: string;
  allowed: boolean;
  reason_codes: string[];
}

export interface CollectiveObject {
  object_id: string;
  kind: string;
  publisher: string;
  admitted_at: string;
  capability_id: string;
  capability_version: string;
  summary: string;
  operation: string;
  origin: string;
  effects: string[];
}

export interface CollectiveReviewItem {
  object_id: string;
  candidate: {
    kind?: string;
    payload?: { capability_id?: string; summary?: string; operation?: string; origin?: string };
  };
  queued_at: string;
}

export interface CollectiveEquivocation {
  publisher: string;
  generation: number;
  roots: string[];
  witnesses: string[];
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (!isTauri()) {
    throw new Error("Aiko Desktop is running without its native runtime bridge.");
  }

  return invoke<T>("native_api_request", {
    request: {
      path,
      method,
      body: body ?? null,
    },
  });
}

export async function getHealth(): Promise<RuntimeHealth> {
  return request<RuntimeHealth>("/v1/health");
}

export async function getContracts(): Promise<ContractSummary[]> {
  const response = await request<{ items: ContractSummary[] }>("/v1/contracts");
  return response.items;
}

export async function getContract(id: string): Promise<{
  id: string;
  history: string;
}> {
  return request(`/v1/contracts/${encodeURIComponent(id)}`);
}

export async function getAgentMailUrl(): Promise<string> {
  if (!isTauri()) {
    throw new Error("ACP requires the trusted Aiko desktop bridge.");
  }
  return invoke<string>("native_agent_mail_url");
}

export async function retryContract(id: string): Promise<void> {
  await request(`/v1/contracts/${encodeURIComponent(id)}/retry`, "POST");
}

export async function cancelContract(id: string): Promise<void> {
  await request(`/v1/contracts/${encodeURIComponent(id)}/cancel`, "POST");
}

export async function getReflexes(context = ""): Promise<{ candidates: ReflexCandidate[]; policy: ReflexPolicy }> {
  const response = await request<{
    rankings: { candidates: ReflexCandidate[] };
    policy: ReflexPolicy;
  }>(`/v1/reflexes?context=${encodeURIComponent(context)}`);
  return { candidates: response.rankings.candidates ?? [], policy: response.policy };
}

export async function updateReflexPolicy(body: Record<string, unknown>): Promise<ReflexPolicy> {
  const response = await request<{ policy: ReflexPolicy }>("/v1/reflex-policy", "PUT", body);
  return response.policy;
}

export async function deleteReflex(capability: string): Promise<void> {
  await request(`/v1/reflexes/${encodeURIComponent(capability)}`, "DELETE");
}

export async function getActivityEvents(limit = 100): Promise<ActivityEvent[]> {
  const response = await request<{ activity: { events: ActivityEvent[] } }>(`/v1/activity?limit=${limit}`);
  return response.activity.events ?? [];
}

export async function clearActivityEvents(): Promise<void> {
  await request("/v1/activity", "DELETE");
}

export async function revealDiscoveryHelp(): Promise<void> {
  if (!isTauri()) return;
  await invoke("reveal_runtime_help");
}

export async function getCollectiveStatus(): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>("/v1/collective/status");
  return response.collective;
}

export async function getCollectiveAudit(): Promise<CollectiveAuditEvent[]> {
  const response = await request<{ items: CollectiveAuditEvent[] }>("/v1/collective/audit");
  return response.items;
}

export async function getCollectiveObjects(): Promise<CollectiveObject[]> {
  const response = await request<{ items: CollectiveObject[] }>("/v1/collective/objects");
  return response.items;
}

export async function getCollectiveEquivocations(): Promise<CollectiveEquivocation[]> {
  const response = await request<{ items: CollectiveEquivocation[] }>(
    "/v1/collective/equivocations",
  );
  return response.items;
}

export async function getCollectiveReviewQueue(): Promise<CollectiveReviewItem[]> {
  const response = await request<{ items: CollectiveReviewItem[] }>("/v1/collective/review");
  return response.items;
}

export async function approveCollectiveReview(objectId: string): Promise<void> {
  await request(`/v1/collective/review/${encodeURIComponent(objectId)}/approve`, "POST");
}

export async function rejectCollectiveReview(objectId: string): Promise<void> {
  await request(`/v1/collective/review/${encodeURIComponent(objectId)}/reject`, "POST");
}

export async function eraseCollectiveObject(objectId: string): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>(
    `/v1/collective/objects/${encodeURIComponent(objectId)}`,
    "DELETE",
  );
  return response.collective;
}

export async function revokeCollectiveObject(objectId: string): Promise<string> {
  const response = await request<{ revocationObjectId: string }>(
    `/v1/collective/objects/${encodeURIComponent(objectId)}/revoke`,
    "POST",
    { reason: "publisher_request" },
  );
  return response.revocationObjectId;
}

export async function setCollectiveParticipation(enabled: boolean): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>(
    "/v1/collective/participation",
    "PUT",
    { enabled },
  );
  return response.collective;
}

export async function setCollectivePublicationMode(
  mode: CollectivePublicationMode,
): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>(
    "/v1/collective/publication-mode",
    "PUT",
    { mode },
  );
  return response.collective;
}

export async function setCollectiveEvidenceSharing(enabled: boolean): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>(
    "/v1/collective/evidence-sharing",
    "PUT",
    { enabled },
  );
  return response.collective;
}

// ── Telegram bridge ──────────────────────────────────────────────

export async function getTelegramSettings(): Promise<TelegramSettings> {
  if (!isTauri()) {
    return { approvedUserIds: [], bridgeRunning: false, bridgeLog: [] };
  }
  return invoke<TelegramSettings>("get_telegram_settings");
}

export async function saveTelegramBotToken(token: string): Promise<void> {
  if (!isTauri()) throw new Error("Telegram settings require Aiko Desktop.");
  return invoke("save_telegram_bot_token", { token });
}

export async function approveTelegramPairCode(code: string): Promise<TelegramPairResult> {
  if (!isTauri()) throw new Error("Telegram pair approval requires Aiko Desktop.");
  return invoke<TelegramPairResult>("approve_telegram_pair_code", { code });
}

export async function getTelegramBridgeLog(tail?: number): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("get_telegram_bridge_log", { tailLines: tail ?? null });
}
