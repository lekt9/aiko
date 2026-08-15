/**
 * Session path map for chat FilePathCards.
 *
 * Agents often write short relative paths (`04-正文/正文.md`, `正文.md`) while
 * tool_step rows already hold the true absolute path. Project trees can contain
 * many homonyms (article templates). We only map a short token → absolute path
 * when that token uniquely identifies one absolute path among files the session
 * has already touched (or absolute paths present in message text).
 */

import type { ChatMessage, MessageSegment } from "@/lib/session";
import { parseToolStepContent } from "@/lib/session";
import {
  isAbsoluteFsPath,
  isHomeRelativePath,
  isHttpUrl,
  isRealLocalAbsolutePath,
  isSiteRootAbsolutePath,
  normalizePathToken,
} from "@/lib/pathRefs";
import { pathBasename } from "@/lib/attachments";
import { normalizeLocalPathToken } from "@/lib/pathNormalize";

const ABS_PATH_RE =
  /(?:^|[\s`"'([{])((?:\/(?:Users|home|tmp|var|private|opt|Volumes)\/[^\s`"'\]})]+)|(?:[A-Za-z]:[\\/][^\s`"'\]})]+)|(?:~\/[^\s`"'\]})]+))/g;

function normAbs(p: string): string {
  const n = normalizeLocalPathToken(p) || p.replace(/\\/g, "/");
  return n.replace(/\/+$/, "");
}

function isPlausibleAbsFile(p: string): boolean {
  const t = normAbs(p.trim());
  if (!t || t.length > 800) return false;
  if (isHttpUrl(t) || t.includes("://")) return false;
  if (isSiteRootAbsolutePath(t)) return false;
  // Real absolute (`/Users/...`) or home-relative (`~/.aiko/docs/...`) —
  // agents commonly cite CLI docs with a tilde instead of expanding $HOME.
  if (
    !isRealLocalAbsolutePath(t) &&
    !isAbsoluteFsPath(t) &&
    !isHomeRelativePath(t)
  ) {
    return false;
  }
  // Prefer paths that look like files (have an extension) or known long tails.
  const base = pathBasename(t);
  if (!base || base === t) return false;
  return true;
}

/** Collect absolute file paths referenced by a single message. */
export function collectAbsolutePathsFromMessage(m: ChatMessage): string[] {
  const out: string[] = [];
  const push = (raw?: string | null) => {
    if (!raw) return;
    const t = normalizeLocalPathToken(raw) || raw.trim();
    if (!isPlausibleAbsFile(t)) return;
    out.push(normAbs(t));
  };

  push(m.toolPath);
  // Media / file cards attached to the message (image_gen, drops, etc.)
  // so short tokens like `images/1.jpg` resolve in every content segment.
  if (m.attachments?.length) {
    for (const a of m.attachments) {
      if (!a.isDir) push(a.path);
    }
  }
  if (m.marker === "tool_step" || m.content?.startsWith("tool_step|")) {
    const parsed = parseToolStepContent(m.content || "");
    push(parsed?.path);
    // Title / detail often embed `Read `/abs/path``
    if (parsed?.title) {
      for (const hit of parsed.title.matchAll(/`([^`]+)`/g)) {
        push(hit[1]);
      }
    }
    if (parsed?.detail) {
      for (const hit of parsed.detail.matchAll(/`([^`]+)`/g)) {
        push(hit[1]);
      }
      push(parsed.detail);
    }
  }

  if (m.segments?.length) {
    for (const seg of m.segments) {
      if (seg.kind === "tool") {
        push((seg as Extract<MessageSegment, { kind: "tool" }>).path);
      }
    }
  }

  const text = m.content || "";
  if (text && !text.startsWith("tool_step|")) {
    for (const hit of text.matchAll(ABS_PATH_RE)) {
      push(hit[1]);
    }
    for (const hit of text.matchAll(/`([^`\n]{2,800})`/g)) {
      const inner = hit[1]?.trim() || "";
      if (isAbsoluteFsPath(inner) || isHomeRelativePath(inner)) push(inner);
    }
  }

  return out;
}

/**
 * Suffix keys for an absolute path: basename, last 2..5 segments, and
 * project-relative form when under `projectPath`.
 */
export function suffixKeysForAbsolute(
  abs: string,
  projectPath?: string | null,
): string[] {
  const norm = normAbs(abs);
  const parts = norm.split("/").filter(Boolean);
  const keys: string[] = [norm];
  if (parts.length) {
    keys.push(parts[parts.length - 1]!);
  }
  const max = Math.min(5, parts.length);
  for (let n = 2; n <= max; n++) {
    keys.push(parts.slice(-n).join("/"));
  }
  const root = projectPath ? normAbs(projectPath) : "";
  if (root && (norm === root || norm.startsWith(root + "/"))) {
    const rel = norm.slice(root.length).replace(/^\//, "");
    if (rel) {
      keys.push(rel);
      keys.push(`./${rel}`);
    }
  }
  return keys;
}

/**
 * Build token → absolute map. A short token is only registered when exactly
 * one absolute path in the corpus ends with that token (or equals it).
 */
export function buildUniquePathMap(
  absolutePaths: string[],
  projectPath?: string | null,
): Record<string, string> {
  const absList = Array.from(
    new Set(absolutePaths.map(normAbs).filter(isPlausibleAbsFile)),
  );
  // token → set of abs
  const bucket = new Map<string, Set<string>>();
  const add = (token: string, abs: string) => {
    const t = token.trim().replace(/\\/g, "/");
    if (!t) return;
    // Skip pure absolute re-keying of itself later; still allow lookup.
    let set = bucket.get(t);
    if (!set) {
      set = new Set();
      bucket.set(t, set);
    }
    set.add(abs);
  };

  for (const abs of absList) {
    for (const key of suffixKeysForAbsolute(abs, projectPath)) {
      add(key, abs);
      const stripped = normalizePathToken(key);
      if (stripped && stripped !== key) add(stripped, abs);
    }
  }

  const map: Record<string, string> = {};
  for (const [token, set] of bucket) {
    if (set.size === 1) {
      map[token] = [...set][0]!;
    }
  }
  // Always map absolute → itself even if somehow multi (shouldn't happen).
  for (const abs of absList) {
    map[abs] = abs;
  }
  return map;
}

/** Session-wide map used by markdown path cards. */
export function buildSessionFilePathMap(
  messages: ChatMessage[],
  projectPath?: string | null,
): Record<string, string> {
  const abs: string[] = [];
  for (const m of messages) {
    abs.push(...collectAbsolutePathsFromMessage(m));
  }
  return buildUniquePathMap(abs, projectPath);
}

/** Merge media attachment map + session file map (session wins on conflict only if unique). */
export function mergePathMaps(
  ...maps: Array<Record<string, string> | undefined | null>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      if (k && v) out[k] = v;
    }
  }
  return out;
}
