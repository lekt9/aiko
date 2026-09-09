/** A short-lived, origin-bound browser session. After private form submission,
 * the bearer stays out of the native Voyager application, URLs, server storage
 * and JavaScript-readable session storage. */
export const VOYAGER_COOKIE = "__Host-aiko-voyager";
export const SESSION_SECONDS = 30 * 60;
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
export const validVoyagerToken = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);

async function key(secret: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw Error("Voyager session key is not configured");
  const bytes = decode(secret);
  if (bytes.length !== 32) throw Error("Invalid Voyager session key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const aad = (origin: string) => encoder.encode(`aiko-voyager/session-v1:${origin}`);
export type VoyagerSession = { token: string; expiresAt: number };

export async function sealVoyagerSession(secret: string, origin: string, token: string, now = Date.now()) {
  if (!validVoyagerToken(token)) throw Error("Invalid token");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = encoder.encode(JSON.stringify({ token, expiresAt: now + SESSION_SECONDS * 1000 }));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(origin) }, await key(secret), body);
  return `${encode(iv)}.${encode(new Uint8Array(sealed))}`;
}

export async function openVoyagerSession(secret: string, request: Request, now = Date.now()): Promise<VoyagerSession | undefined> {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 8192) return;
  const values = header.split(";").map(part => part.trim()).filter(part => part.startsWith(`${VOYAGER_COOKIE}=`));
  if (values.length !== 1) return;
  const value = values[0]!.slice(VOYAGER_COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,1024}$/.test(value)) return;
  try {
    const [iv, body] = value.split(".");
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv!), additionalData: aad(new URL(request.url).origin) }, await key(secret), decode(body!));
    const session = JSON.parse(new TextDecoder().decode(clear)) as VoyagerSession;
    if (validVoyagerToken(session.token) && Number.isSafeInteger(session.expiresAt) &&
        session.expiresAt > now && session.expiresAt <= now + SESSION_SECONDS * 1000) return session;
  } catch { /* Malformed, expired, another origin, or rotated key: require sign-in. */ }
}

export const voyagerCookie = (value: string, seconds = SESSION_SECONDS) =>
  `${VOYAGER_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
