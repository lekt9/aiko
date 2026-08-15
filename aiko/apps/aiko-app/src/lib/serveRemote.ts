/**
 * Pure helpers for Settings → Runtime → Agent serve:
 * optional proxy `--remote <URL>`, client connection templates, secret masking.
 *
 * Host also implements the same rules in `src-tauri/src/serve.rs` (source of truth
 * for spawn). These helpers keep the UI honest for validation + display.
 */

export type ServeRemoteUrlError =
  | "empty"
  | "whitespace"
  | "scheme"
  | "empty_host"
  | "secret_in_query"
  | "junk";

export type NormalizeServeRemoteResult =
  | { ok: true; value: string | null }
  | { ok: false; error: ServeRemoteUrlError };

const SECRET_QUERY_KEYS = [
  "server-key",
  "secret",
  "token",
  "password",
  "api_key",
  "apikey",
];

/**
 * Mask serve secrets for UI (short → all bullets; longer → bullets + last 4).
 * Mirrors host `serve::mask_secret`.
 */
export function maskServeSecret(value: string | null | undefined): string {
  const t = (value ?? "").trim();
  if (!t) return "";
  if (t.length <= 4) return "••••";
  return `••••${t.slice(-4)}`;
}

/** Client WebSocket base without secret: `ws://{bind}/ws`. */
export function buildServeRemoteWsBase(bind: string): string {
  return `ws://${bind}/ws`;
}

/** Full client URL with secret query: `ws://{bind}/ws?server-key=…`. */
export function buildServeConnectionUrl(bind: string, secret: string): string {
  return `${buildServeRemoteWsBase(bind)}?server-key=${secret}`;
}

/** Masked client URL (secret last-4 only). */
export function buildServeConnectionUrlMasked(bind: string, secret: string): string {
  return `${buildServeRemoteWsBase(bind)}?server-key=${maskServeSecret(secret)}`;
}

/**
 * Client CLI connection string template:
 * `aiko --remote ws://{bind}/ws --secret <token>`
 */
export function buildServeConnectionCli(bind: string, secret: string): string {
  return `aiko --remote ${buildServeRemoteWsBase(bind)} --secret ${secret}`;
}

/** Masked CLI connection string for status / logs. */
export function buildServeConnectionCliMasked(bind: string, secret: string): string {
  return `aiko --remote ${buildServeRemoteWsBase(bind)} --secret ${maskServeSecret(secret)}`;
}

/**
 * Normalize optional proxy-mode `--remote` URL for serve spawn.
 * Empty → `{ ok: true, value: null }` (omit flag).
 * Accepts `ws://` / `wss://`; rewrites `http(s)://` to ws/wss.
 * Rejects secrets in the query and whitespace/junk.
 */
export function normalizeServeRemoteUrl(
  raw: string | null | undefined,
): NormalizeServeRemoteResult {
  if (raw == null) return { ok: true, value: null };
  const trimmed = String(raw).trim();
  if (!trimmed) return { ok: true, value: null };
  if (/\s/.test(trimmed) || /[\0\r\n]/.test(trimmed)) {
    return { ok: false, error: "whitespace" };
  }

  const lower = trimmed.toLowerCase();
  let normalized: string;
  if (lower.startsWith("ws://") || lower.startsWith("wss://")) {
    normalized = trimmed;
  } else if (lower.startsWith("http://")) {
    normalized = `ws://${trimmed.slice("http://".length)}`;
  } else if (lower.startsWith("https://")) {
    normalized = `wss://${trimmed.slice("https://".length)}`;
  } else {
    return { ok: false, error: "scheme" };
  }

  const qIdx = normalized.indexOf("?");
  if (qIdx >= 0) {
    const q = normalized.slice(qIdx + 1).toLowerCase();
    for (const key of SECRET_QUERY_KEYS) {
      if (q.includes(`${key}=`)) {
        return { ok: false, error: "secret_in_query" };
      }
    }
  }

  const afterScheme = normalized.split("://")[1] ?? "";
  const hostPart = afterScheme.split(/[/?#]/)[0] ?? "";
  if (!hostPart) return { ok: false, error: "empty_host" };

  return { ok: true, value: normalized };
}

/** Serve spawn argv extras when remote is set: `["--remote", url]` or null. */
export function serveRemoteSpawnCliArgs(
  raw: string | null | undefined,
): string[] | null {
  const n = normalizeServeRemoteUrl(raw);
  if (!n.ok || !n.value) return null;
  return ["--remote", n.value];
}
