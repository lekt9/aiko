/** Hosted connector metadata imports; the custody CSV API has a separate contract. */
export const LOGIN_IMPORT_MAX_ROWS = 500;
export const LOGIN_IMPORT_MAX_BYTES = 1_048_576;
export const LOGIN_IMPORT_SIZE_MESSAGE = "This import is too large. Import fewer logins at a time (up to 1 MiB).";

/** Measure the exact JSON envelope sent by the Mini App, including UTF-8 encoding. */
export function loginImportCapacityError(rows: readonly unknown[]): string | undefined {
  if (rows.length > LOGIN_IMPORT_MAX_ROWS)
    return `Import at most ${LOGIN_IMPORT_MAX_ROWS} logins at a time.`;
  if (new TextEncoder().encode(JSON.stringify({ rows })).byteLength > LOGIN_IMPORT_MAX_BYTES)
    return LOGIN_IMPORT_SIZE_MESSAGE;
}
