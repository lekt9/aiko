import { safeUserId } from "./security.ts";

export type ThreadRole = "foreground" | "indexer" | "reflection" | "router" | "control";

/** Account identity is parsed from the complete thread identifier, never a loose prefix. */
export function threadBinding(
  thread: string,
): { owner: string; role: ThreadRole } | undefined {
  if (thread.startsWith("user-") && safeUserId(thread.slice(5)))
    return { owner: thread.slice(5), role: "foreground" };
  if (thread.startsWith("router-") && safeUserId(thread.slice(7)))
    return { owner: thread.slice(7), role: "router" };
  if (thread.startsWith("control-") && safeUserId(thread.slice(8)))
    return { owner: thread.slice(8), role: "control" };
  const match = /^background-(.+)-(indexer|reflection)$/.exec(thread);
  return match && safeUserId(match[1])
    ? { owner: match[1], role: match[2] as "indexer" | "reflection" }
    : undefined;
}

export function backgroundThread(
  owner: string,
  role: "indexer" | "reflection" | "router",
) {
  if (!safeUserId(owner)) throw new Error("Invalid account binding");
  return role === "router" ? `router-${owner}` : `background-${owner}-${role}`;
}
