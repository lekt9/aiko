/**
 * Wallpaper source helpers — X search + Imagine gallery types and pure logic.
 */

export type WallpaperSourceKind = "x" | "imagine" | "library";

export type WallpaperGalleryItem = {
  id: string;
  thumbUrl: string;
  fullUrl: string;
  kind: "image" | "video" | string;
  width?: number | null;
  height?: number | null;
  source: WallpaperSourceKind | string;
  username?: string | null;
  postUrl?: string | null;
  textPreview?: string | null;
  likes?: number | null;
  localPath?: string | null;
  prompt?: string | null;
};

export type WallpaperSearchResult = {
  items: WallpaperGalleryItem[];
  errorCode?: string | null;
  message?: string | null;
};

export type WallpaperFetchResult = {
  path: string;
  mime: string;
  bytes: number;
  name: string;
};

export type WallpaperLibraryEntry = {
  path: string;
  name: string;
  source: string;
  kind: string;
  bytes: number;
  modifiedMs: number;
};

export type WallpaperSourceErrorCode =
  | "auth_required"
  | "cli_missing"
  | "search_failed"
  | "empty"
  | "download_failed"
  | "url_blocked"
  | "imagine_failed"
  | "timeout"
  | "generic";

/** Map host error strings / codes to a stable UI code. */
export function parseWallpaperSourceError(err: unknown): WallpaperSourceErrorCode {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "";
  const s = raw.toLowerCase();
  if (s.includes("auth_required")) return "auth_required";
  if (s.includes("cli_missing")) return "cli_missing";
  if (s.includes("url_blocked")) return "url_blocked";
  // Local media:// / path reads used when applying Imagine / library items
  if (
    s.includes("download_failed") ||
    s.includes("download") ||
    s.includes("read_failed") ||
    s.includes("short read")
  ) {
    return "download_failed";
  }
  if (s.includes("desktop_only")) return "generic";
  if (s.includes("imagine_failed") || s.includes("imagine")) return "imagine_failed";
  if (s.includes("timeout")) return "timeout";
  if (s.includes("empty")) return "empty";
  if (s.includes("search_failed") || s.includes("search")) return "search_failed";
  return "generic";
}

export function errorCodeFromSearchResult(
  result: WallpaperSearchResult,
): WallpaperSourceErrorCode | null {
  if (result.items.length > 0) return null;
  const code = (result.errorCode || "").toLowerCase();
  if (!code) return "empty";
  if (code === "auth_required") return "auth_required";
  if (code === "cli_missing") return "cli_missing";
  if (code === "search_failed") return "search_failed";
  if (code === "imagine_failed") return "imagine_failed";
  if (code === "empty") return "empty";
  if (code === "timeout") return "timeout";
  return "generic";
}

/** Deduplicate gallery items by fullUrl / localPath. */
export function dedupeGalleryItems(
  items: WallpaperGalleryItem[],
): WallpaperGalleryItem[] {
  const seen = new Set<string>();
  const out: WallpaperGalleryItem[] = [];
  for (const it of items) {
    const key = (it.localPath || it.fullUrl || it.id).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Loopback media HTTP (and legacy media://) answers bare GETs of large files
 * with **206 + first 2 MiB only** (video Range streaming). A naive
 * `fetch(url).blob()` therefore truncates Imagine PNGs / large X downloads and
 * `prepareWallpaperFromFile` fails with a cryptic decode error. Always
 * reassemble via Range (or accept a true 200).
 *
 * Exported for unit tests.
 */
export const MEDIA_PROTO_CHUNK = 2 * 1024 * 1024;

/** Parse `Content-Range: bytes start-end/total` → total length. */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(header.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Fetch an entire media HTTP (or legacy media://) resource, reassembling Range chunks.
 *
 * `opts.chunkSize` is for unit tests only (default = media protocol 2 MiB).
 */
export async function fetchEntireMediaBlob(
  url: string,
  fetchImpl: typeof fetch = fetch,
  opts?: { chunkSize?: number },
): Promise<Blob> {
  const chunkSize = opts?.chunkSize ?? MEDIA_PROTO_CHUNK;
  // Probe total size with a 1-byte Range (media protocol always supports it).
  const probe = await fetchImpl(url, {
    headers: { Range: "bytes=0-0" },
  });
  if (!(probe.ok || probe.status === 206)) {
    throw new Error(`read_failed: HTTP ${probe.status}`);
  }

  const totalFromRange = parseContentRangeTotal(
    probe.headers.get("content-range"),
  );
  // Consume probe body so the connection can close cleanly.
  try {
    await probe.arrayBuffer();
  } catch {
    /* ignore */
  }

  if (totalFromRange === 0) {
    return new Blob([]);
  }

  // No Content-Range → host returned a full 200 for the probe; just GET once.
  if (totalFromRange == null) {
    const full = await fetchImpl(url);
    if (!full.ok) {
      throw new Error(`read_failed: HTTP ${full.status}`);
    }
    return full.blob();
  }

  if (totalFromRange <= chunkSize) {
    const one = await fetchImpl(url, {
      headers: { Range: `bytes=0-${totalFromRange - 1}` },
    });
    if (!(one.ok || one.status === 206)) {
      throw new Error(`read_failed: HTTP ${one.status}`);
    }
    return one.blob();
  }

  const parts: Blob[] = [];
  let got = 0;
  for (let start = 0; start < totalFromRange; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, totalFromRange - 1);
    const part = await fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!(part.ok || part.status === 206)) {
      throw new Error(`read_failed: HTTP ${part.status} at ${start}-${end}`);
    }
    const blob = await part.blob();
    got += blob.size;
    parts.push(blob);
  }
  if (got < totalFromRange) {
    throw new Error(
      `read_failed: short read (${got}/${totalFromRange} bytes)`,
    );
  }
  return new Blob(parts);
}

/**
 * Load a local absolute path into a File for prepareWallpaperFromFile.
 * Uses Host loopback media HTTP with **full Range reassembly** (not a single bare GET).
 */
export async function fileFromAbsolutePath(
  absolutePath: string,
  opts?: { name?: string; mime?: string },
): Promise<File> {
  const name =
    opts?.name ||
    absolutePath.split(/[/\\]/).pop() ||
    "wallpaper.jpg";
  const mime = opts?.mime || mimeFromName(name);

  // Browser / unit tests: no Tauri
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  ) {
    throw new Error("desktop_only");
  }

  const { resolveImageSrc } = await import("@/lib/imageSrc");
  const url = await resolveImageSrc(absolutePath);
  if (!url) {
    throw new Error("read_failed: cannot resolve local media URL");
  }

  let blob: Blob;
  try {
    blob = await fetchEntireMediaBlob(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("read_failed")) throw e instanceof Error ? e : new Error(msg);
    throw new Error(`read_failed: ${msg}`);
  }

  if (!blob.size) {
    throw new Error("read_failed: empty file");
  }

  const type =
    blob.type && blob.type !== "application/octet-stream" ? blob.type : mime;
  return new File([blob], name, { type });
}

/** Prefer local path when present (Imagine / library). */
export function resolveApplySource(
  item: WallpaperGalleryItem,
): { kind: "path"; path: string } | { kind: "url"; url: string } {
  if (item.localPath && item.localPath.trim()) {
    return { kind: "path", path: item.localPath.trim() };
  }
  // file:// from host scan
  if (item.fullUrl.startsWith("file://")) {
    const p = item.fullUrl.replace(/^file:\/\//, "");
    return { kind: "path", path: decodeURIComponent(p) };
  }
  return { kind: "url", url: item.fullUrl };
}
