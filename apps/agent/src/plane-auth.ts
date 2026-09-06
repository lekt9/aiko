import { createHash } from "node:crypto";
import { safeUserId } from "./security.ts";

export type PlaneCredential = {
  account: string;
  digest: string;
  scopes: ("read" | "write")[];
};
export const credentialDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function parsePlaneCredentials(value: string): PlaneCredential[] {
  const entries: unknown = JSON.parse(value);
  if (!Array.isArray(entries) || entries.length > 256)
    throw new Error("Invalid plane credentials");
  const digests = new Set<string>();
  return entries.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "account,digest,scopes" ||
      !safeUserId(entry.account) ||
      entry.account === "local" ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      digests.has(entry.digest) ||
      !Array.isArray(entry.scopes) ||
      !entry.scopes.length ||
      entry.scopes.some(
        (scope: unknown) => scope !== "read" && scope !== "write",
      )
    )
      throw new Error("Invalid plane credential binding");
    digests.add(entry.digest);
    return entry as PlaneCredential;
  });
}
