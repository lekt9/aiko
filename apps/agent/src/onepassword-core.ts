import { createRequire } from "node:module";
import { validReference } from "./password-managers.ts";

/**
 * The deployment build embeds the 1Password wasm core and defines
 * OP_WASM_B64; local runs read it from node_modules through the real
 * filesystem. The glue loads the wasm eagerly from disk, so the embedded
 * build satisfies that read from memory before the SDK is imported.
 */
declare const OP_WASM_B64: string | undefined;

let patch: Promise<void> | undefined;

async function embeddedWasmReady() {
  if (typeof OP_WASM_B64 !== "string" || patch) return;
  patch = (async () => {
    // The bundled glue reads the wasm with require("fs").readFileSync; patch
    // that same CJS exports object (an ESM namespace would be frozen).
    const require = createRequire(import.meta.url);
    const fs = require("node:fs") as {
      readFileSync: (path: unknown, ...rest: unknown[]) => Buffer;
    };
    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = (path: unknown, ...rest: unknown[]) =>
      typeof path === "string" && path.endsWith("core_bg.wasm")
        ? Buffer.from(OP_WASM_B64 as string, "base64")
        : realReadFileSync(path, ...rest);
  })();
  await patch;
}

/**
 * Resolve a saved op:// reference with the tenant's own service account
 * token. Runs on the owner's private VM runner; the token arrives only in
 * the encrypted private envelope and is never journaled or logged.
 */
export async function resolveOnePassword(
  token: unknown,
  reference: unknown,
): Promise<string> {
  if (typeof token !== "string" || !token || token.length > 16384)
    throw new Error("Invalid resolution request");
  if (
    typeof reference !== "string" ||
    !validReference("onepassword", reference)
  )
    throw new Error("Invalid resolution request");
  await embeddedWasmReady();
  const { createClient } = await import("@1password/sdk");
  const client = await createClient({
    auth: token,
    integrationName: "Aiko",
    integrationVersion: "0.2.0",
  });
  const value = await client.secrets.resolve(reference);
  if (typeof value !== "string" || !value)
    throw new Error("Invalid resolution request");
  return value;
}
