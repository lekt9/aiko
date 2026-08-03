//! Codegraff-style write_file — bounded, atomic write with pre-write
//! snapshot for rewind support. Ported from codegraff's write path in `exec.zig`.
//!
//! # Key features
//!
//! 1. **Write lock**: Serializes concurrent writes to the same file.
//! 2. **Pre-write snapshot**: Records file state before mutation for `/rewind`.
//! 3. **Bounded output**: Large writes are capped to prevent context explosion.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::edit_file::WriteLock;

/// Result of a write_file operation.
#[derive(Debug)]
pub struct WriteFileResult {
    /// Whether the write completed.
    pub ok: bool,
    /// Bytes written.
    pub bytes_written: usize,
    /// Whether the output was truncated.
    pub truncated: bool,
    /// Human-readable message.
    pub message: String,
    /// Pre-write file content (for rewind). None if file didn't exist.
    pub snapshot: Option<String>,
}

/// Write content to a file, with pre-write snapshot and write locking.
///
/// # Arguments
/// * `path` - Path to write to.
/// * `content` - Content to write.
/// * `max_bytes` - Maximum bytes allowed (truncates if exceeded).
/// * `write_lock` - Optional write lock for concurrent safety.
pub fn graff_write_file<P: AsRef<Path>>(
    path: P,
    content: &str,
    max_bytes: Option<usize>,
    write_lock: Option<&WriteLock>,
) -> std::io::Result<WriteFileResult> {
    let path = path.as_ref();
    let cap = max_bytes.unwrap_or(super::READ_MAX_BYTES);

    // Take write lock if provided
    let _guard = write_lock.map(|wl| wl.lock(path));

    // Snapshot: record pre-write state for rewind
    let snapshot = if path.exists() {
        match fs::read_to_string(path) {
            Ok(s) => Some(s),
            Err(_) => None,
        }
    } else {
        None
    };

    // Apply cap
    let (to_write, truncated) = if content.len() > cap {
        // Truncate at a valid UTF-8 boundary
        let mut end = cap;
        while end > 0 && !content.is_char_boundary(end) {
            end -= 1;
        }
        (&content[..end], true)
    } else {
        (content, false)
    };

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Write atomically: write to temp, then rename
    let mut tmp_path = path.to_path_buf();
    tmp_path.set_file_name(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    if let Some(parent) = path.parent() {
        tmp_path = parent.join(tmp_path.file_name().unwrap_or(std::ffi::OsStr::new(".tmp")));
    }

    {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(to_write.as_bytes())?;
        file.flush()?;
    }

    fs::rename(&tmp_path, path)?;

    let message = if truncated {
        format!(
            "wrote {} to {} (truncated from {} bytes to {})",
            path.display(),
            path.display(),
            content.len(),
            to_write.len()
        )
    } else {
        format!("wrote {} to {}", path.display(), path.display())
    };

    Ok(WriteFileResult {
        ok: true,
        bytes_written: to_write.len(),
        truncated,
        message,
        snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");

        let result = graff_write_file(&path, "hello world", None, None).unwrap();
        assert!(result.ok);
        assert_eq!(result.bytes_written, 11);
        assert!(!result.truncated);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_write_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        fs::write(&path, "original").unwrap();

        let result = graff_write_file(&path, "modified", None, None).unwrap();
        assert!(result.ok);
        assert_eq!(result.snapshot, Some("original".to_string()));

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "modified");
    }

    #[test]
    fn test_write_no_snapshot_for_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.txt");

        let result = graff_write_file(&path, "new content", None, None).unwrap();
        assert!(result.ok);
        assert_eq!(result.snapshot, None);
    }

    #[test]
    fn test_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");

        let big = "x".repeat(500_000);
        let result = graff_write_file(&path, &big, Some(256 * 1024), None).unwrap();
        assert!(result.ok);
        assert!(result.truncated);
        assert!(result.bytes_written <= 256 * 1024);
    }

    #[test]
    fn test_write_lock_serialization() {
        use std::sync::Arc;
        use std::thread;

        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("lock_test.txt"));
        let lock = Arc::new(WriteLock::default());

        let mut handles = vec![];
        for i in 0..10 {
            let p = path.clone();
            let l = lock.clone();
            handles.push(thread::spawn(move || {
                let content = format!("writer {}", i);
                graff_write_file(p.as_path(), &content, None, Some(&l)).unwrap();
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // File should exist and contain the last writer's content
        let content = fs::read_to_string(path.as_path()).unwrap();
        assert!(content.starts_with("writer "));
    }

    #[test]
    fn test_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deep/nested/file.txt");

        let result = graff_write_file(&path, "deep", None, None).unwrap();
        assert!(result.ok);
        assert!(path.exists());
    }
}
