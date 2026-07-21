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

export type CollectivePublicationMode =
  | "disabled"
  | "safe_public_shapes"
  | "review_every_object";

export interface CollectiveStatus {
  available: boolean;
  participation_enabled: boolean;
  publication_mode: CollectivePublicationMode;
  connected_peers: number;
  local_peer_id?: string;
  objects: number;
  quarantined: number;
  pinned: number;
  object_bytes: number;
  error?: string;
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

export async function revealDiscoveryHelp(): Promise<void> {
  if (!isTauri()) return;
  await invoke("reveal_runtime_help");
}

export async function getCollectiveStatus(): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>("/v1/collective/status");
  return response.collective;
}

export async function setCollectiveParticipation(enabled: boolean): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>(
    "/v1/collective/participation",
    "POST",
    { enabled },
  );
  return response.collective;
}

export async function setCollectivePublicationMode(
  mode: CollectivePublicationMode,
): Promise<CollectiveStatus> {
  const response = await request<{ collective: CollectiveStatus }>(
    "/v1/collective/publication-mode",
    "POST",
    { mode },
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
