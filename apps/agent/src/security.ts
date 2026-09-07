import { createHmac, timingSafeEqual } from "node:crypto";

export type HttpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

export const equalSecret = (a: string, b: string): boolean => {
  const digest = (s: string) =>
    createHmac("sha256", "aiko-constant-time-comparison").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
};

export function redactor(secrets: readonly string[] = []) {
  return (input: string): string => {
    let text = input;
    for (const secret of secrets.filter((s) => s.length >= 8))
      text = text.split(secret).join("[redacted]");
    return text
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted authorization]")
      .replace(
        /\b(?:password|api[_ -]?key|secret|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi,
        "[redacted credential]",
      )
      .replace(
        /\b(?:aiko_|arc_proj|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g,
        "[redacted]",
      )
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted bot token]");
  };
}

export async function boundedText(
  response: Response,
  maxBytes = 24_000,
): Promise<string> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("response too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Telegram Mini App authentication; signatures are not a substitute for per-user authorization. */
export function verifyInitData(
  raw: string,
  botToken: string,
  now = Date.now(),
): string | undefined {
  if (raw.length > 8_192) return undefined;
  const params = new URLSearchParams(raw);
  const names = [...params.keys()];
  if (new Set(names).size !== names.length) return undefined;
  const hash = params.get("hash");
  const date = Number(params.get("auth_date"));
  if (
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(date) ||
    date * 1000 > now + 30_000 ||
    now - date * 1000 > 300_000
  )
    return undefined;
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", key).update(check).digest("hex");
  if (!equalSecret(expected, hash)) return undefined;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user &&
      Number.isSafeInteger(user.id) &&
      user.id > 0 &&
      user.is_bot !== true
      ? String(user.id)
      : undefined;
  } catch {
    return undefined;
  }
}

// Exchange fresh Telegram launch data once. The signed, short-lived app session
// stays in browser memory; stale launch data can never mint or renew a session.
export function createMiniAppSession(owner: string, botToken: string, now = Date.now()) {
  const payload = `${owner}.${now + 12 * 60 * 60_000}`;
  const signature = createHmac("sha256", botToken).update(`aiko-mini-app/v1:${payload}`).digest("hex");
  return `${payload}.${signature}`;
}
export function verifyMiniAppSession(token: string, botToken: string, now = Date.now()): string | undefined {
  const match = /^([1-9]\d{0,15})\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return;
  const [, owner, expiry, signature] = match;
  if (Number(expiry) <= now || Number(expiry) > now + 12 * 60 * 60_000) return;
  const expected = createHmac("sha256", botToken).update(`aiko-mini-app/v1:${owner}.${expiry}`).digest("hex");
  return equalSecret(signature!, expected) ? owner : undefined;
}

export const safeUserId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:local|[1-9]\d{0,15}|acct_[A-Za-z0-9_-]{8,64})$/.test(value);
