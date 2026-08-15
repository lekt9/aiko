/**
 * Resolve a previewable URL for local files.
 * Video / audio / PDF / large binary use the Host loopback media HTTP server
 * (HTTP Range, bounded chunks) so multi‑GB files never load fully into memory.
 * HTML is rendered via HtmlBrowser (srcDoc) — not via this URL helper —
 * because `file://` is blocked inside Tauri's main webview iframes.
 */

import type { FsReadResult } from "@/lib/api";
import { isTauri } from "@/lib/api";
import {
  ensureMediaEndpoint,
  localPathToMediaHttpUrl,
  resolveImageSrcSync,
} from "@/lib/imageSrc";

/** Prefer Range-capable media HTTP for streaming kinds (not HTML). */
function useMediaHttp(kind: string): boolean {
  return (
    kind === "video" ||
    kind === "audio" ||
    kind === "pdf" ||
    kind === "image"
  );
}

/** Kinds that load binary via media URL for rich client-side render. */
export function isOfficeKind(kind: string): boolean {
  return (
    kind === "docx" ||
    kind === "xlsx" ||
    kind === "pptx" ||
    kind === "odf" ||
    kind === "office" ||
    kind === "pdf"
  );
}

/**
 * Absolute filesystem path → `file://` URL (encode segments; keep `/`).
 * Used for local HTML so relative CSS/JS resolve like a real browser tab.
 */
export function pathToFileUrl(absolutePath: string): string {
  let p = absolutePath.trim().replace(/\\/g, "/");
  if (!p) return "";
  // Windows drive → file:///C:/...
  const win = p.match(/^([A-Za-z]:)(\/.*)?$/);
  if (win) {
    const drive = win[1]!;
    const rest = win[2] || "/";
    const segs = rest.split("/").map((s) => (s ? encodeURIComponent(s) : ""));
    return `file:///${drive}${segs.join("/")}`;
  }
  if (!p.startsWith("/")) p = `/${p}`;
  const segs = p.split("/").map((s, i) => (i === 0 || !s ? "" : encodeURIComponent(s)));
  // segs[0] is empty before first / → join gives leading /
  return `file://${segs.join("/")}`;
}

/**
 * Convert absolute path → URL the webview can load.
 * Loopback media HTTP for range streaming kinds; image helper for the rest.
 */
export async function pathToPreviewUrl(
  absolutePath: string,
  kind?: string,
): Promise<string | null> {
  if (!absolutePath) return null;
  // HTML is handled by HtmlBrowser (srcDoc); asset URL is only a fetch fallback
  if (!isTauri()) {
    if (kind === "html") return pathToFileUrl(absolutePath);
    return null;
  }

  await ensureMediaEndpoint();

  if (!kind || useMediaHttp(kind) || isOfficeKind(kind)) {
    const http = localPathToMediaHttpUrl(absolutePath);
    if (http) return http;
  }

  // Shared path with chat images (HTTP or cold-start media:// fallback).
  return resolveImageSrcSync(absolutePath);
}

export async function resolvePreviewSrc(
  preview: FsReadResult,
): Promise<string | null> {
  // HTML: don't put file:// into iframe src (blank). HtmlBrowser uses text/srcDoc.
  if (preview.kind === "html") {
    return null;
  }

  // Prefer stream path for video/audio/pdf/large image
  if (preview.stream && preview.absolutePath && isTauri()) {
    const url = await pathToPreviewUrl(preview.absolutePath, preview.kind);
    if (url) return url;
  }

  if (preview.base64 && preview.mime) {
    return `data:${preview.mime};base64,${preview.base64}`;
  }

  // Streamable kinds without flag (legacy) still try absolute path
  if (
    preview.absolutePath &&
    isTauri() &&
    (preview.kind === "video" ||
      preview.kind === "audio" ||
      preview.kind === "pdf" ||
      preview.kind === "image" ||
      isOfficeKind(preview.kind))
  ) {
    return pathToPreviewUrl(preview.absolutePath, preview.kind);
  }

  return null;
}

/** Fetch local file bytes for office renderers (docx-preview / xlsx / pdfjs). */
export async function fetchPreviewArrayBuffer(
  absolutePath: string,
  kind?: string,
): Promise<ArrayBuffer> {
  const url = await pathToPreviewUrl(absolutePath, kind);
  if (!url) {
    throw new Error("cannot resolve local file URL");
  }
  // Large files: assemble Range chunks (server caps each response at 2 MiB).
  return fetchViaRange(url);
}

/** Fetch full body, following Range windowing when the server returns 206. */
async function fetchViaRange(url: string): Promise<ArrayBuffer> {
  const first = await fetch(url);
  if (!first.ok && first.status !== 206) {
    throw new Error(`failed to load file (${first.status})`);
  }

  // Full body available
  if (first.status === 200) {
    return first.arrayBuffer();
  }

  // 206: assemble remaining ranges
  const contentRange = first.headers.get("content-range") || "";
  // bytes start-end/total
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(contentRange);
  const firstBuf = new Uint8Array(await first.arrayBuffer());
  if (!m) {
    return firstBuf.buffer;
  }
  const end = Number(m[2]);
  const total = m[3] === "*" ? NaN : Number(m[3]);
  if (!Number.isFinite(total) || total <= end + 1) {
    return firstBuf.buffer;
  }

  const chunks: Uint8Array[] = [firstBuf];
  let next = end + 1;
  while (next < total) {
    const res = await fetch(url, {
      headers: { Range: `bytes=${next}-` },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`failed to load file range (${res.status})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.byteLength) break;
    chunks.push(buf);
    const cr = res.headers.get("content-range") || "";
    const rm = /bytes\s+(\d+)-(\d+)\//i.exec(cr);
    if (rm) {
      next = Number(rm[2]) + 1;
    } else {
      next += buf.byteLength;
    }
    // Safety: prevent infinite loops
    if (chunks.length > 10_000) {
      throw new Error("file too large to reassemble");
    }
  }

  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
