/**
 * Remote IM Bridge resilience — pure helpers (RIM-RESILIENCE).
 *
 * Reconnect backoff, rate-limit honesty, crash-recovery status for UI.
 * No I/O. Never surfaces secrets.
 *
 * Spec: docs/llm-wiki/remote-im.md §9 / §14 (rate limit · crash recovery)
 */

import type { BridgeRunState } from "./types";

/** Base for exponential backoff: delay = min(base^attempt, cap). attempt≥1. */
export const RIM_BACKOFF_BASE_SECS = 2;
/** Max wait between restart attempts (seconds). */
export const RIM_BACKOFF_CAP_SECS = 60;
/** Cap exponent so 2^n does not overflow (2^6=64 → min with 60s cap). */
export const RIM_BACKOFF_MAX_EXP = 6;
/** Host health watchdog tick (seconds) — informational for UI copy. */
export const RIM_WATCHDOG_TICK_SECS = 15;

/** Default inbound agent-turn rate limit (per chat scope). */
export const RIM_RATE_PER_CHAT = 8;
export const RIM_RATE_WINDOW_SECS = 60;
/** Global inbound agent-turn budget across all chats. */
export const RIM_RATE_GLOBAL = 40;

export type RimErrorKind =
  | "rate_limit"
  | "auth"
  | "network"
  | "crash"
  | "config"
  | "unknown";

export type RimRecoveryPhase =
  | "idle"
  | "listening"
  | "starting"
  | "backing_off"
  | "restarting"
  | "degraded"
  | "rate_limited"
  | "error"
  | "stopped";

export type RimRecoverySeverity = "ok" | "warn" | "err" | "neutral";

/**
 * Exponential reconnect delay for restart attempt `attempt` (0-based).
 * attempt 0 → 0 (immediate first try); 1 → 2s; 2 → 4s; … capped at 60s.
 */
export function reconnectBackoffSecs(attempt: number): number {
  const a = Math.max(0, Math.floor(Number(attempt) || 0));
  if (a <= 0) return 0;
  const exp = Math.min(a, RIM_BACKOFF_MAX_EXP);
  const delay = RIM_BACKOFF_BASE_SECS ** exp;
  return Math.min(delay, RIM_BACKOFF_CAP_SECS);
}

/**
 * After a failed restart at `failedAttempt` (0-based count of failures so far),
 * how long to wait before the next try.
 */
export function nextRetryAfterFailureSecs(failedAttempt: number): number {
  const a = Math.max(0, Math.floor(Number(failedAttempt) || 0));
  // First failure → wait 2s; second → 4s; …
  return reconnectBackoffSecs(a + 1);
}

/**
 * Whether a watchdog tick may attempt restart given scheduled next retry.
 * `nextRetryUnixSecs` 0 / null means no scheduled wait (try now).
 */
export function canAttemptRestart(
  nowUnixSecs: number,
  nextRetryUnixSecs: number | null | undefined,
): boolean {
  const now = Math.floor(Number(nowUnixSecs) || 0);
  if (nextRetryUnixSecs == null || nextRetryUnixSecs <= 0) return true;
  return now >= Math.floor(Number(nextRetryUnixSecs) || 0);
}

/** Remaining seconds until next retry (0 when due). */
export function secondsUntilRetry(
  nowUnixSecs: number,
  nextRetryUnixSecs: number | null | undefined,
): number {
  if (nextRetryUnixSecs == null || nextRetryUnixSecs <= 0) return 0;
  const rem = Math.floor(Number(nextRetryUnixSecs) || 0) - Math.floor(Number(nowUnixSecs) || 0);
  return Math.max(0, rem);
}

/**
 * Classify host / connector / agent error text for honest UI (no secrets).
 */
export function classifyRimError(raw: unknown): RimErrorKind {
  if (raw == null) return "unknown";
  const s = String(raw).toLowerCase();
  if (!s.trim()) return "unknown";

  if (
    s.includes("rate limit") ||
    s.includes("rate_limit") ||
    s.includes("ratelimit") ||
    s.includes("too many request") ||
    s.includes("429") ||
    s.includes("quota") ||
    s.includes("usage limit") ||
    s.includes("throttl") ||
    s.includes("slow down") ||
    s.includes("insufficient credit") ||
    s.includes("out of credits") ||
    s.includes("not entitled")
  ) {
    return "rate_limit";
  }
  if (
    s.includes("401") ||
    s.includes("403") ||
    s.includes("unauthor") ||
    s.includes("forbidden") ||
    s.includes("invalid token") ||
    s.includes("invalid_app") ||
    s.includes("app_secret") ||
    s.includes("authentication") ||
    s.includes("access denied") ||
    s.includes("not login") ||
    s.includes("login required")
  ) {
    return "auth";
  }
  if (
    s.includes("missing ") ||
    s.includes("no enabled channel") ||
    s.includes("no credentials") ||
    s.includes("missing_credentials") ||
    s.includes("not configured") ||
    s.includes("invalid config")
  ) {
    return "config";
  }
  if (
    s.includes("exited unexpectedly") ||
    s.includes("connectors exited") ||
    s.includes("panic") ||
    s.includes("crashed") ||
    s.includes("runtime handle finished") ||
    s.includes("pump exited")
  ) {
    return "crash";
  }
  if (
    s.includes("timeout") ||
    s.includes("timed out") ||
    s.includes("connection reset") ||
    s.includes("connection refused") ||
    s.includes("network") ||
    s.includes("dns") ||
    s.includes("econn") ||
    s.includes("socket") ||
    s.includes("ws connect") ||
    s.includes("tls") ||
    s.includes("unreachable") ||
    s.includes("offline")
  ) {
    return "network";
  }
  return "unknown";
}

/** Stable i18n key for an error kind. */
export function rimErrorKindKey(
  kind: RimErrorKind,
): `settings.remoteIm.resilience.errorKind.${RimErrorKind}` {
  return `settings.remoteIm.resilience.errorKind.${kind}`;
}

/** Stable i18n key for recovery phase title. */
export function rimRecoveryPhaseKey(
  phase: RimRecoveryPhase,
): `settings.remoteIm.resilience.phase.${RimRecoveryPhase}` {
  return `settings.remoteIm.resilience.phase.${phase}`;
}

// ─── Token bucket (inbound turn rate limit) ─────────────────────────────────

export type TokenBucketState = {
  tokens: number;
  /** Last refill timestamp (ms since epoch, or any monotonic ms clock). */
  lastRefillMs: number;
};

export type TokenBucketConfig = {
  capacity: number;
  /** Tokens restored per full window. */
  refillAmount: number;
  windowMs: number;
};

export function defaultChatRateConfig(): TokenBucketConfig {
  return {
    capacity: RIM_RATE_PER_CHAT,
    refillAmount: RIM_RATE_PER_CHAT,
    windowMs: RIM_RATE_WINDOW_SECS * 1000,
  };
}

export function defaultGlobalRateConfig(): TokenBucketConfig {
  return {
    capacity: RIM_RATE_GLOBAL,
    refillAmount: RIM_RATE_GLOBAL,
    windowMs: RIM_RATE_WINDOW_SECS * 1000,
  };
}

export function createTokenBucket(cfg: TokenBucketConfig, nowMs: number): TokenBucketState {
  const cap = Math.max(1, Math.floor(cfg.capacity));
  return { tokens: cap, lastRefillMs: Math.floor(nowMs) };
}

/** Pure refill toward capacity based on elapsed time. */
export function refillTokenBucket(
  state: TokenBucketState,
  cfg: TokenBucketConfig,
  nowMs: number,
): TokenBucketState {
  const cap = Math.max(1, Math.floor(cfg.capacity));
  const windowMs = Math.max(1, Math.floor(cfg.windowMs));
  const refillAmount = Math.max(1, Math.floor(cfg.refillAmount));
  const now = Math.floor(nowMs);
  const last = Math.floor(state.lastRefillMs);
  if (now <= last) {
    return { tokens: Math.min(cap, Math.max(0, state.tokens)), lastRefillMs: last };
  }
  const elapsed = now - last;
  // Linear refill: full window restores refillAmount
  const gained = (elapsed / windowMs) * refillAmount;
  const tokens = Math.min(cap, Math.max(0, state.tokens) + gained);
  return { tokens, lastRefillMs: now };
}

/**
 * Try to consume one token. Returns updated state + whether allowed.
 * When denied, `retryAfterSecs` estimates wait until ≥1 token.
 */
export function tryConsumeToken(
  state: TokenBucketState,
  cfg: TokenBucketConfig,
  nowMs: number,
  cost = 1,
): { ok: boolean; state: TokenBucketState; retryAfterSecs: number } {
  const refilled = refillTokenBucket(state, cfg, nowMs);
  const need = Math.max(1, Math.floor(cost));
  if (refilled.tokens >= need) {
    return {
      ok: true,
      state: { ...refilled, tokens: refilled.tokens - need },
      retryAfterSecs: 0,
    };
  }
  const windowMs = Math.max(1, Math.floor(cfg.windowMs));
  const refillAmount = Math.max(1, Math.floor(cfg.refillAmount));
  const deficit = need - refilled.tokens;
  const secs = Math.ceil((deficit / refillAmount) * (windowMs / 1000));
  return {
    ok: false,
    state: refilled,
    retryAfterSecs: Math.max(1, secs),
  };
}

/**
 * Combined per-chat + global check. Soft-fail style: pure decision only.
 */
export function checkInboundRateLimit(input: {
  chat: TokenBucketState;
  global: TokenBucketState;
  nowMs: number;
  chatCfg?: TokenBucketConfig;
  globalCfg?: TokenBucketConfig;
}): {
  ok: boolean;
  chat: TokenBucketState;
  global: TokenBucketState;
  retryAfterSecs: number;
  limitedBy: "chat" | "global" | null;
} {
  const chatCfg = input.chatCfg ?? defaultChatRateConfig();
  const globalCfg = input.globalCfg ?? defaultGlobalRateConfig();

  const g = tryConsumeToken(input.global, globalCfg, input.nowMs);
  if (!g.ok) {
    return {
      ok: false,
      chat: refillTokenBucket(input.chat, chatCfg, input.nowMs),
      global: g.state,
      retryAfterSecs: g.retryAfterSecs,
      limitedBy: "global",
    };
  }
  const c = tryConsumeToken(input.chat, chatCfg, input.nowMs);
  if (!c.ok) {
    // refund global token (soft — pure model)
    return {
      ok: false,
      chat: c.state,
      global: { ...g.state, tokens: g.state.tokens + 1 },
      retryAfterSecs: c.retryAfterSecs,
      limitedBy: "chat",
    };
  }
  return {
    ok: true,
    chat: c.state,
    global: g.state,
    retryAfterSecs: 0,
    limitedBy: null,
  };
}

// ─── Recovery status for Bridge overview UI ─────────────────────────────────

export type RimRecoveryStatusInput = {
  state: BridgeRunState | string | null | undefined;
  enabled: boolean;
  restartAttempt?: number | null;
  nextRetrySecs?: number | null;
  lastError?: string | null;
  errorKind?: RimErrorKind | string | null;
  rateLimited?: boolean | null;
};

export type RimRecoveryStatus = {
  phase: RimRecoveryPhase;
  severity: RimRecoverySeverity;
  titleKey: `settings.remoteIm.resilience.phase.${RimRecoveryPhase}`;
  bodyKey: string | null;
  /** Show “retry in N s / attempt M” line */
  showRetryMeta: boolean;
  attempt: number;
  nextRetrySecs: number | null;
  errorKind: RimErrorKind | null;
  errorKindKey: ReturnType<typeof rimErrorKindKey> | null;
  /** True when UI should surface a recovery / rate-limit card */
  showCard: boolean;
};

function parseErrorKind(raw: unknown, lastError?: string | null): RimErrorKind | null {
  if (typeof raw === "string" && raw.trim()) {
    const k = raw.trim().toLowerCase();
    if (
      k === "rate_limit" ||
      k === "auth" ||
      k === "network" ||
      k === "crash" ||
      k === "config" ||
      k === "unknown"
    ) {
      return k;
    }
  }
  if (lastError) return classifyRimError(lastError);
  return null;
}

/**
 * Derive recovery card state from Bridge status fields.
 * Honest: does not claim “listening” when degraded/backing off.
 */
export function classifyRecoveryStatus(
  input: RimRecoveryStatusInput,
): RimRecoveryStatus {
  const state = String(input.state ?? "stopped").toLowerCase();
  const enabled = !!input.enabled;
  const attempt = Math.max(0, Math.floor(Number(input.restartAttempt) || 0));
  const nextRaw = input.nextRetrySecs;
  const nextRetrySecs =
    nextRaw != null && Number.isFinite(Number(nextRaw)) && Number(nextRaw) > 0
      ? Math.floor(Number(nextRaw))
      : null;
  const rateLimited = !!input.rateLimited;
  const errorKind = parseErrorKind(input.errorKind, input.lastError);

  let phase: RimRecoveryPhase = "stopped";
  if (rateLimited || errorKind === "rate_limit") {
    phase = "rate_limited";
  } else if (state === "listening" || state === "running") {
    phase = "listening";
  } else if (state === "starting") {
    phase = attempt > 0 ? "restarting" : "starting";
  } else if (state === "degraded") {
    phase = nextRetrySecs != null && nextRetrySecs > 0 ? "backing_off" : "degraded";
  } else if (state === "error") {
    phase = "error";
  } else if (state === "stopping") {
    phase = "stopped";
  } else if (enabled && (state === "stopped" || !state)) {
    // Enabled but not listening — recovery path
    phase = nextRetrySecs != null && nextRetrySecs > 0 ? "backing_off" : "degraded";
  } else {
    phase = "stopped";
  }

  let severity: RimRecoverySeverity = "neutral";
  let bodyKey: string | null = null;
  let showRetryMeta = false;
  let showCard = false;

  switch (phase) {
    case "listening":
      severity = "ok";
      showCard = false;
      break;
    case "starting":
    case "restarting":
      severity = "warn";
      bodyKey = "settings.remoteIm.resilience.body.restarting";
      showRetryMeta = attempt > 0;
      showCard = true;
      break;
    case "backing_off":
      severity = "warn";
      bodyKey = "settings.remoteIm.resilience.body.backingOff";
      showRetryMeta = true;
      showCard = true;
      break;
    case "degraded":
      severity = "warn";
      bodyKey = "settings.remoteIm.resilience.body.degraded";
      showRetryMeta = attempt > 0;
      showCard = true;
      break;
    case "rate_limited":
      severity = "warn";
      bodyKey = "settings.remoteIm.resilience.body.rateLimited";
      showRetryMeta = nextRetrySecs != null;
      showCard = true;
      break;
    case "error":
      severity = "err";
      bodyKey = "settings.remoteIm.resilience.body.error";
      showRetryMeta = attempt > 0 || nextRetrySecs != null;
      showCard = true;
      break;
    default:
      severity = "neutral";
      showCard = false;
  }

  return {
    phase,
    severity,
    titleKey: rimRecoveryPhaseKey(phase),
    bodyKey,
    showRetryMeta,
    attempt,
    nextRetrySecs,
    errorKind,
    errorKindKey: errorKind ? rimErrorKindKey(errorKind) : null,
    showCard,
  };
}

/**
 * Sanitize a short recovery note for timeline (no URLs / secrets).
 */
export function sanitizeRecoveryNote(raw: unknown, max = 120): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.replace(/[\u0000-\u001f]/g, "").trim();
  if (!s) return undefined;
  if (/https?:\/\//i.test(s) || /[?&#]token=/i.test(s) || /\bbearer\s+/i.test(s)) {
    return undefined;
  }
  if (/\b(secret|password|app_secret|bot_token|access_token)\s*[:=]/i.test(s)) {
    return undefined;
  }
  if (s.length > max) s = s.slice(0, max);
  return s;
}
