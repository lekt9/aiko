export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "REVOKED"
  | "SOURCE_UNAVAILABLE"
  | "REAUTH_REQUIRED"
  | "UNSUPPORTED_PROVIDER"
  | "RUNTIME_UNAVAILABLE"
  | "RATE_LIMITED"
  | "CAPACITY"
  | "UNAVAILABLE";
export class VaultError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503 = 400,
  ) {
    super(code);
    this.name = "VaultError";
  }
}
export function requireValue<T>(
  value: T | undefined | null,
  code: ErrorCode = "NOT_FOUND",
): T {
  if (value === undefined || value === null)
    throw new VaultError(code, code === "NOT_FOUND" ? 404 : 403);
  return value;
}
