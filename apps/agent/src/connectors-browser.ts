import type { NativeLoginInput, NativeLoginView } from "./native-login.ts";
/** Opaque host-owned relay identity. Never accept these fields from an actor's callback payload. */
export type SecureBrowserBinding = { owner: string; domain: string; connectionId: string };
export type SecureBrowserVerification = { verified: true; revision: number; expiresAt: number };
export type SecureBrowserStatus = SecureBrowserBinding & (
  | { status: "pending" | "failed" | "disconnected" | "unknown" }
  | { status: "connected"; verification: SecureBrowserVerification }
);
export interface SecureBrowserAdapter {
  native?: boolean;
  progress?(): Promise<{ stage: string; message: string; at: number }[]>;
  readContext?(binding: SecureBrowserBinding, signal?: AbortSignal, url?: string, linkOffset?: number): Promise<{url: string; text: string; links?: string[]; linksTruncated?: boolean; nextLinkOffset?: number}>;
  control?(binding: SecureBrowserBinding, input: Omit<NativeLoginInput, "connectionId" | "domain">, signal?: AbortSignal): Promise<NativeLoginView>;
  begin(binding: SecureBrowserBinding, signal?: AbortSignal): Promise<{ authorizationUrl: string }>;
  status?(binding: SecureBrowserBinding, signal?: AbortSignal): Promise<SecureBrowserStatus>;
  disconnect?(binding: SecureBrowserBinding, signal?: AbortSignal): Promise<SecureBrowserBinding & { status: "disconnected" | "unknown" }>;
}

/**
 * Host reuse contract (the engine does not import vault/server code or handle credentials):
 * - Map the authenticated Aiko owner to an existing verified OwnerAuth tenant, never to an arbitrary supplied tenant.
 * - Persist binding -> vault connection/profile/runtime IDs under that tenant before opening the relay.
 * - OwnerAuth.session + api.ts origin/CSRF and recent-auth checks guard the private credential form.
 * - Vault.add/setPassword encrypt credentials using context(tenant,"credential",id); do not use reveal in actor paths.
 * - Runtime.verify + publish / importSession enforce domain, identity, recipe/runtime, revision and expiry checks.
 * - status returns connected ONLY from a matching authorized stored session with verified=true, current generation,
 *   ready status and unexpired expires_at. Project its revision/expiresAt here; never return cookies or identity data.
 * - Disconnect revokes this binding's relay/session access. Vault.remove also deletes credentials and is appropriate
 *   only for an explicitly dedicated disposable connection, not a shared vault credential.
 * Existing createHttpRecipe supports approved documented HTTP login APIs; it is not a universal browser sign-in relay.
 * The host must implement secure relay UI, owner/tenant linkage, authenticated status transport and session revocation.
 * Engine callback verification is a host trust boundary, not independent proof of a real browser login.
 */
export function validateBrowserStatus(binding: SecureBrowserBinding, value: SecureBrowserStatus): SecureBrowserStatus {
  if (!value || typeof value !== "object" || value.owner !== binding.owner || value.domain !== binding.domain || value.connectionId !== binding.connectionId || !["pending", "connected", "failed", "disconnected", "unknown"].includes(value.status)) throw new Error("Secure browser status binding invalid");
  if (value.status === "connected") {
    const verification = value.verification;
    if (!verification || verification.verified !== true || !Number.isSafeInteger(verification.revision) || verification.revision < 1 || !Number.isSafeInteger(verification.expiresAt) || verification.expiresAt <= Date.now() || verification.expiresAt > Date.now() + 30 * 86400_000) throw new Error("Secure browser session verification invalid");
    return { ...binding, status: "connected", verification: { verified: true, revision: verification.revision, expiresAt: verification.expiresAt } };
  }
  return { ...binding, status: value.status };
}

/** Bound trusted host operations, with no raw relay/vault errors escaping into actor receipts. */
export async function browserOperation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Secure browser operation unavailable")); }, 30000); }),
    ]);
  } catch { throw new Error("Secure browser operation unavailable"); }
  finally { clearTimeout(timer); }
}
