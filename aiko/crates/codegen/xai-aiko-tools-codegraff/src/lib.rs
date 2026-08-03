//! Codegraff-ported tool primitives — faster, bounded, verified implementations
//! of read_file, edit_file, and write_file.
//!
//! Ported from [codegraff](https://github.com/justrach/codegraff):
//! - `src/read_file.zig` — streaming line-window reads, binary detection, preview truncation
//! - `src/edit_verify.zig` — post-write verification, concurrent write locks, companion-aware
//!
//! # Key differences from the existing Aiko Build tools
//!
//! | Feature                | Aiko Build              | Codegraff (this crate)       |
//! |------------------------|-------------------------|------------------------------|
//! | Whole-file read        | Allocates full content  | Capped at 256KB + preview    |
//! | Line-range reads       | Allocates full file     | Streams through 16KB buffers |
//! | Binary detection       | Extension-based only    | Content scan (null bytes)    |
//! | Edit verification      | None                    | Re-reads file, byte-compares |
//! | Write locks            | None                    | Striped mutex per file hash  |
//! | Output cap             | Configurable            | Fixed 256KB + proportional   |

pub mod edit_file;
pub mod read_file;
pub mod write_file;

// Re-exports
pub use edit_file::{EditResult, EditVerifier, Verdict, WriteLock};
pub use read_file::{ReadFileResult, ReadOptions, graff_read_file};
pub use write_file::{WriteFileResult, graff_write_file};

/// Max bytes for a whole-file read. Larger files get a preview.
/// Mirrors codegraff's `read_file.max_bytes`.
pub const READ_MAX_BYTES: usize = 256 * 1024;

/// Preview bytes when a file exceeds READ_MAX_BYTES.
/// Mirrors codegraff's `read_file.preview_bytes`.
pub const PREVIEW_BYTES: usize = 1536;

/// Max bytes for one tool output, proportional to context window.
/// Mirrors codegraff's `Provider.perOutputCap()`.
pub const ABS_OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// Read buffer size for streaming line windows.
pub const STREAM_BUF_SIZE: usize = 16 * 1024;

/// Max bytes for an edit source read.
pub const EDIT_READ_CAP: usize = 1024 * 1024;

/// Max bytes for post-edit verification re-read (looser than source cap).
pub const VERIFY_READ_CAP: usize = 16 * 1024 * 1024;

/// Number of write-lock stripes.
pub const WRITE_LOCK_STRIPES: usize = 16;

/// Known binary file extensions (from codegraff's `input_util.binaryFileExt`).
pub fn is_binary_ext(path: &str) -> bool {
    let lower = path.to_lowercase();
    BINARY_EXTS.iter().any(|ext| lower.ends_with(ext))
}

const BINARY_EXTS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif", ".mp3", ".mp4",
    ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
    ".rar", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".exe", ".dll", ".so",
    ".dylib", ".wasm", ".o", ".a", ".lib", ".class", ".ttf", ".otf", ".woff", ".woff2", ".db",
    ".sqlite", ".sqlite3", ".bin", ".dat",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_binary_ext() {
        assert!(is_binary_ext("photo.png"));
        assert!(is_binary_ext("archive.tar.gz"));
        assert!(is_binary_ext("libfoo.so"));
        assert!(!is_binary_ext("main.rs"));
        assert!(!is_binary_ext("README.md"));
        assert!(!is_binary_ext("script.py"));
    }
}
