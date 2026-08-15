//! Cached chat image thumbnails.
//!
//! Chat virtual-list remounts re-request media URLs often. Serving full multi-MB
//! originals over loopback is wasteful. We materialize a small JPEG under
//! `{app_data}/cache/image-thumbs/{hash}.jpg` keyed by:
//! - local file: path + mtime + size
//! - remote https: URL string
//!
//! Card UI loads the thumb via loopback media; lightbox still uses the original.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::path_scope;
use crate::paths;

/// Longest edge for chat card thumbs (display max 240px; 2× for Retina).
const THUMB_MAX_EDGE: u32 = 480;

/// Skip re-encode when source is already small enough (bytes).
const SKIP_IF_SMALLER_THAN: u64 = 96 * 1024; // 96 KiB

/// Remote download cap.
const MAX_REMOTE_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageThumbResult {
    /// Absolute path of the JPEG thumb (or original when we skip re-encode).
    pub thumb_path: String,
    pub from_cache: bool,
    /// Natural pixel size of the **source** (for aspect cache), when known.
    pub width: u32,
    pub height: u32,
    /// True when `thumb_path` is the original file (not a resized thumb).
    pub is_original: bool,
}

pub fn image_thumbs_dir() -> PathBuf {
    paths::image_thumbs_dir()
}

fn hash_hex(bytes: &[u8]) -> String {
    let dig = Sha256::digest(bytes);
    dig.iter().take(20).map(|b| format!("{b:02x}")).collect()
}

fn local_cache_key(path: &Path, mtime_secs: u64, size: u64) -> String {
    let mut h = Sha256::new();
    let norm = path.to_string_lossy().replace('\\', "/");
    h.update(b"local\0");
    h.update(norm.as_bytes());
    h.update(b"\0");
    h.update(mtime_secs.to_le_bytes());
    h.update(size.to_le_bytes());
    h.update(b"\0");
    h.update(THUMB_MAX_EDGE.to_le_bytes());
    hash_hex(&h.finalize())
}

fn remote_cache_key(url: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"remote\0");
    h.update(url.trim().as_bytes());
    h.update(b"\0");
    h.update(THUMB_MAX_EDGE.to_le_bytes());
    hash_hex(&h.finalize())
}

fn thumb_path_for_key(key: &str) -> PathBuf {
    image_thumbs_dir().join(format!("{key}.jpg"))
}

fn file_meta(path: &Path) -> Result<(u64, u64), String> {
    let meta = fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((mtime, size))
}

fn looks_like_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "avif"
    )
}

fn resize_to_thumb(img: DynamicImage) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return img;
    }
    let long = w.max(h);
    if long <= THUMB_MAX_EDGE {
        return img;
    }
    let scale = THUMB_MAX_EDGE as f32 / long as f32;
    let nw = ((w as f32) * scale).round().max(1.0) as u32;
    let nh = ((h as f32) * scale).round().max(1.0) as u32;
    img.resize(nw, nh, FilterType::Triangle)
}

fn encode_jpeg(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let rgb = img.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 78);
    enc.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(buf.into_inner())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create thumb dir: {e}"))?;
    }
    let tmp = path.with_extension("jpg.partial");
    fs::write(&tmp, bytes).map_err(|e| format!("write thumb: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename thumb: {e}")
    })?;
    Ok(())
}

fn decode_image_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory(bytes).map_err(|e| format!("decode image: {e}"))
}

fn build_thumb_from_bytes(bytes: &[u8], out: &Path) -> Result<(u32, u32, bool), String> {
    let img = decode_image_bytes(bytes)?;
    let width = img.width();
    let height = img.height();
    let long = width.max(height);
    // Already tiny and under edge: write original-ish JPEG for format unify.
    let thumb_img = if long <= THUMB_MAX_EDGE && bytes.len() as u64 <= SKIP_IF_SMALLER_THAN {
        // Still re-encode small sources so cache is always JPEG under path_scope.
        img
    } else {
        resize_to_thumb(img)
    };
    let jpeg = encode_jpeg(&thumb_img)?;
    write_atomic(out, &jpeg)?;
    Ok((width, height, false))
}

/// Ensure a chat-card thumb exists for a local absolute path.
pub fn ensure_local_image_thumb(path: &str) -> Result<ImageThumbResult, String> {
    let raw = PathBuf::from(path.trim());
    if raw.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    let canonical = path_scope::require_allowed(&raw)?;
    if !looks_like_image(&canonical) {
        return Err("not an image file".into());
    }

    let (mtime, size) = file_meta(&canonical)?;
    // Very small local files: serve original (grant + path) without re-encode.
    if size > 0 && size <= SKIP_IF_SMALLER_THAN {
        // Still try to read dims for aspect cache.
        let (w, h) = fs::read(&canonical)
            .ok()
            .and_then(|b| decode_image_bytes(&b).ok())
            .map(|im| (im.width(), im.height()))
            .unwrap_or((0, 0));
        path_scope::grant_path(&canonical);
        return Ok(ImageThumbResult {
            thumb_path: canonical.to_string_lossy().to_string(),
            from_cache: true,
            width: w,
            height: h,
            is_original: true,
        });
    }

    let key = local_cache_key(&canonical, mtime, size);
    let out = thumb_path_for_key(&key);
    if out.is_file() && fs::metadata(&out).map(|m| m.len()).unwrap_or(0) >= 32 {
        // Dims from original (prefer re-read header only once).
        let (w, h) = fs::read(&canonical)
            .ok()
            .and_then(|b| decode_image_bytes(&b).ok())
            .map(|im| (im.width(), im.height()))
            .unwrap_or((0, 0));
        path_scope::grant_path(&out);
        return Ok(ImageThumbResult {
            thumb_path: out.to_string_lossy().to_string(),
            from_cache: true,
            width: w,
            height: h,
            is_original: false,
        });
    }

    let bytes = fs::read(&canonical).map_err(|e| format!("read image: {e}"))?;
    if bytes.is_empty() {
        return Err("empty image".into());
    }
    let (w, h, _) = build_thumb_from_bytes(&bytes, &out)?;
    path_scope::grant_path(&out);
    Ok(ImageThumbResult {
        thumb_path: out.to_string_lossy().to_string(),
        from_cache: false,
        width: w,
        height: h,
        is_original: false,
    })
}

/// Download remote image (https) once and cache a chat thumb.
pub fn ensure_remote_image_thumb(url: &str) -> Result<ImageThumbResult, String> {
    let url = url.trim();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("not an http(s) url".into());
    }
    // Block loopback abuse via remote branch.
    if url.contains("127.0.0.1") || url.contains("localhost") {
        return Err("loopback url not allowed here".into());
    }

    let key = remote_cache_key(url);
    let out = thumb_path_for_key(&key);
    if out.is_file() && fs::metadata(&out).map(|m| m.len()).unwrap_or(0) >= 32 {
        path_scope::grant_path(&out);
        // Dims unknown without decode; decode cheap from small thumb.
        let (w, h) = fs::read(&out)
            .ok()
            .and_then(|b| decode_image_bytes(&b).ok())
            .map(|im| (im.width(), im.height()))
            .unwrap_or((0, 0));
        return Ok(ImageThumbResult {
            thumb_path: out.to_string_lossy().to_string(),
            from_cache: true,
            width: w,
            height: h,
            is_original: false,
        });
    }

    let client = crate::proxy::apply_to_reqwest_blocking(
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5)),
    )
    .build()
    .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/*,*/*;q=0.8")
        .send()
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download status {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_REMOTE_BYTES {
            return Err("remote image too large".into());
        }
    }
    let bytes = resp.bytes().map_err(|e| format!("download body: {e}"))?;
    if bytes.len() as u64 > MAX_REMOTE_BYTES {
        return Err("remote image too large".into());
    }
    if bytes.is_empty() {
        return Err("empty remote image".into());
    }

    let (w, h, _) = build_thumb_from_bytes(&bytes, &out)?;
    path_scope::grant_path(&out);
    Ok(ImageThumbResult {
        thumb_path: out.to_string_lossy().to_string(),
        from_cache: false,
        width: w,
        height: h,
        is_original: false,
    })
}

/// Unified entry: local absolute path or http(s) URL.
pub fn ensure_image_thumb(path_or_url: &str) -> Result<ImageThumbResult, String> {
    let s = path_or_url.trim();
    if s.is_empty() {
        return Err("empty path".into());
    }
    if s.starts_with("https://") || s.starts_with("http://") {
        return ensure_remote_image_thumb(s);
    }
    ensure_local_image_thumb(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_thumb_from_png_bytes() {
        let img =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(20, 10, image::Rgb([255, 0, 0])));
        let mut png = Vec::new();
        img.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let dir = std::env::temp_dir().join(format!("grok-img-thumb-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("t.jpg");
        let (w, h, _) = build_thumb_from_bytes(&png, &out).unwrap();
        assert_eq!((w, h), (20, 10));
        assert!(out.is_file());
        assert!(fs::metadata(&out).unwrap().len() > 32);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_and_local_keys_differ() {
        let a = remote_cache_key("https://cdn.example.com/a.png");
        let b = remote_cache_key("https://cdn.example.com/b.png");
        assert_ne!(a, b);
        let p = PathBuf::from("/tmp/x.png");
        let k1 = local_cache_key(&p, 1, 100);
        let k2 = local_cache_key(&p, 2, 100);
        assert_ne!(k1, k2);
    }
}
