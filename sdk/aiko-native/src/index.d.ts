export declare const AIKO_NATIVE_SCHEMA: "aiko.native.v1";

export interface AikoNativeDiscovery {
  schema: typeof AIKO_NATIVE_SCHEMA;
  apiVersion: 1;
  pid: number;
  baseUrl: string;
  agentMailUrl: string;
  authorization: {
    type: "bearer";
    token: string;
    websocketQueryParameter: "token";
    websocketSubprotocol: "aiko.acp.v1";
  };
  manifest: string;
  openapi: string;
}

export interface AikoNativeHealth {
  schema: typeof AIKO_NATIVE_SCHEMA;
  status: "ok";
  version: string;
  pid: number;
  address: string;
  contractAbi: number | null;
  contractAvailable: boolean;
}

export interface ContractSummary {
  id: string;
  plan: string;
}

export interface ContractHistory {
  schema: typeof AIKO_NATIVE_SCHEMA;
  id: string;
  contentType: "application/x-ndjson";
  history: string;
}

export interface ContractSignal {
  name: string;
  cwd?: string;
  detail?: string;
}

export interface AgentMailInbox {
  inbox_id: string;
  email_address: string;
  display_name?: string | null;
}

export interface AgentMailThread {
  thread_id: string;
  subject?: string | null;
  snippet?: string | null;
  from_addresses: string[];
  to_addresses: string[];
  received_at?: string | null;
  message_count?: number | null;
}

export interface AgentMailMessage {
  message_id?: string | null;
  from_address?: string | null;
  to_addresses: string[];
  subject?: string | null;
  text_body?: string | null;
  html_body?: string | null;
  received_at?: string | null;
}

export interface AgentMailThreadDetail {
  thread_id: string;
  subject?: string | null;
  messages: AgentMailMessage[];
}

export interface CaptchaSolveInput {
  type?: "hcaptcha" | "recaptcha_v2" | "recaptcha_v3";
  site_key: string;
  page_url: string;
  invisible?: boolean;
  min_score?: number;
  confirmPurchase: true;
}

export declare class AikoNativeError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown);
}

export declare class AikoNativeClient {
  readonly discovery: AikoNativeDiscovery;
  readonly fetch: typeof globalThis.fetch;
  constructor(
    discovery: AikoNativeDiscovery,
    fetchImplementation?: typeof globalThis.fetch,
  );
  health(): Promise<AikoNativeHealth>;
  manifest(): Promise<Record<string, unknown>>;
  openApi(): Promise<Record<string, unknown>>;
  contracts(): Promise<ContractSummary[]>;
  scheduledContracts<T = Record<string, unknown>>(): Promise<T[]>;
  contract(id: string): Promise<ContractHistory>;
  retryContract(id: string): Promise<void>;
  cancelContract(id: string): Promise<void>;
  emitSignal(signal: ContractSignal): Promise<void>;
  leaders<T = Record<string, unknown>>(): Promise<T[]>;
  agentMailInboxes(): Promise<AgentMailInbox[]>;
  createAgentMailInbox(input: {
    name?: string;
    confirmPurchase: true;
  }): Promise<AgentMailInbox>;
  agentMailThreads(): Promise<AgentMailThread[]>;
  agentMailThread(id: string): Promise<AgentMailThreadDetail>;
  waitForAgentMailCode(options?: {
    timeout?: number;
    poll?: number;
  }): Promise<{
    schema: typeof AIKO_NATIVE_SCHEMA;
    thread?: AgentMailThreadDetail;
    verification_code: string | null;
    message?: string;
  }>;
  solveCaptcha(input: CaptchaSolveInput): Promise<{
    schema: typeof AIKO_NATIVE_SCHEMA;
    task_id: number;
    status: "processing";
  }>;
  captchaResult<T = Record<string, unknown>>(taskId: number): Promise<T>;
  waitForCaptcha<T = Record<string, unknown>>(input: {
    task_id: number;
    timeout?: number;
    poll?: number;
  }): Promise<T>;
  browserAgentMailUrl(): string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}
