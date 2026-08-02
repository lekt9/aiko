//! Codegraff-style edit_file — post-write verification, concurrent write locks,
//! companion-aware splicing. Ported from codegraff's `edit_verify.zig`.
//!
//! # The problem this solves (codegraff issue #337)
//!
//! `edit_file` was reporting "replaced 1 occurrence(s)" over files it had left
//! byte-identical. A loud failure costs one retry; a confident false success
//! corrupts everything built on top of it.
//!
//! # How it works
//!
//! 1. **Write lock**: Striped mutex per file hash — serializes concurrent edits
//!    to the same file, so two parallel edits can't interleave and drop one.
//! 2. **Post-write re-read**: Every "success" path re-reads the file from disk.
//! 3. **Verification**: Byte-compares against expected output; falls back to
//!    semantic checks for companion-applied splices.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use crate::{EDIT_READ_CAP, VERIFY_READ_CAP};

/// What a re-read of the file says about an edit that just reported success.
/// Mirrors codegraff's `edit_verify.Verdict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The edit is on disk.
    Ok,
    /// The file could not be re-read after the write.
    Unreadable,
    /// Byte-identical to before the edit: nothing was written.
    Unchanged,
    /// Changed, but not into the expected bytes.
    Mismatch,
    /// new_string is nowhere in the file.
    MissingNew,
    /// new_string appears fewer times than expected.
    Partial,
    /// old_string survives more than allowed.
    StaleOld,
}

/// Result of an edit_file operation with verification.
#[derive(Debug)]
pub struct EditResult {
    /// Whether the edit was successful.
    pub ok: bool,
    /// The verification verdict.
    pub verdict: Verdict,
    /// Number of replacements made (based on old_string count).
    pub replacements: usize,
    /// Human-readable message.
    pub message: String,
}

/// Write lock manager — striped mutex per file hash.
/// Concurrent edits to the same file serialize; different files run in parallel.
pub struct WriteLock {
    stripes: Vec<Mutex<()>>,
}

impl WriteLock {
    /// Create a new write lock with the given number of stripes.
    pub fn new(stripes: usize) -> Self {
        let mut v = Vec::with_capacity(stripes);
        for _ in 0..stripes {
            v.push(Mutex::new(()));
        }
        Self { stripes: v }
    }

    /// Hash a path to a stripe index.
    fn stripe_for(&self, path: &Path) -> usize {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut hasher);
        let hash = hasher.finish();
        (hash as usize) % self.stripes.len()
    }

    /// Acquire the write lock for a path, returning a guard.
    pub fn lock(&self, path: &Path) -> std::sync::MutexGuard<'_, ()> {
        let idx = self.stripe_for(path);
        self.stripes[idx].lock().unwrap()
    }
}

impl Default for WriteLock {
    fn default() -> Self {
        Self::new(super::WRITE_LOCK_STRIPES)
    }
}

/// An edit verifier that holds the before/after state for verification.
pub struct EditVerifier {
    write_lock: WriteLock,
}

impl EditVerifier {
    pub fn new() -> Self {
        Self {
            write_lock: WriteLock::default(),
        }
    }

    /// Verify a native splice (graff computed and wrote itself).
    /// Mirrors codegraff's `verifyNative`.
    pub fn verify_native(before: &str, after: &str, expected: &str) -> Verdict {
        if after == expected {
            Verdict::Ok
        } else if after == before {
            Verdict::Unchanged
        } else {
            Verdict::Mismatch
        }
    }

    /// Verify a companion-applied splice (external tool like zigpatch).
    /// Mirrors codegraff's `verifyCompanion`.
    pub fn verify_companion(
        before: &str,
        after: &str,
        expected: &str,
        old: &str,
        new: &str,
    ) -> Verdict {
        if after == expected {
            return Verdict::Ok;
        }
        if after == before {
            return Verdict::Unchanged;
        }
        if old.is_empty() {
            return Verdict::Mismatch;
        }

        let sites = before.matches(old).count();
        if !new.is_empty() {
            let produced = after.matches(new).count();
            if produced == 0 {
                return Verdict::MissingNew;
            }
            if produced < sites {
                return Verdict::Partial;
            }
        }

        // Old string should be gone from after, minus copies inside new
        let old_in_after = after.matches(old).count();
        let old_in_new = new.matches(old).count();
        let allowed_old = if !new.is_empty() { old_in_new * sites } else { 0 };
        if old_in_after > allowed_old {
            return Verdict::StaleOld;
        }

        Verdict::Ok
    }

    /// Apply an edit to a file and verify the result.
    /// Takes the write lock, reads the file, applies the replacement,
    /// writes, re-reads, and verifies.
    pub fn edit_file(
        &self,
        path: &Path,
        old_string: &str,
        new_string: &str,
        replace_all: bool,
    ) -> std::io::Result<EditResult> {
        let _guard = self.write_lock.lock(path);

        // Read before
        let before = match read_file_bounded(path, EDIT_READ_CAP) {
            Ok(s) => s,
            Err(e) => {
                return Ok(EditResult {
                    ok: false,
                    verdict: Verdict::Unreadable,
                    replacements: 0,
                    message: format!("could not read file: {}", e),
                });
            }
        };

        if old_string.is_empty() {
            return Ok(EditResult {
                ok: false,
                verdict: Verdict::Mismatch,
                replacements: 0,
                message: "old_string must not be empty".to_string(),
            });
        }

        let occurrences = before.matches(old_string).count();
        if occurrences == 0 {
            return Ok(EditResult {
                ok: false,
                verdict: Verdict::MissingNew,
                replacements: 0,
                message: format!("old_string not found in {}", path.display()),
            });
        }

        // Apply replacement
        let after = if replace_all {
            before.replace(old_string, new_string)
        } else if occurrences > 1 {
            // Only replace first occurrence
            before.replacen(old_string, new_string, 1)
        } else {
            before.replacen(old_string, new_string, 1)
        };

        // Write
        fs::write(path, after.as_bytes())?;

        // Re-read and verify
        let on_disk = match read_file_bounded(path, VERIFY_READ_CAP) {
            Ok(s) => s,
            Err(e) => {
                return Ok(EditResult {
                    ok: false,
                    verdict: Verdict::Unreadable,
                    replacements: occurrences,
                    message: format!("write succeeded but could not re-read: {}", e),
                });
            }
        };

        let verdict = Self::verify_native(&before, &on_disk, &after);

        let actual_replacements = if replace_all { occurrences } else { 1 };
        let message = match &verdict {
            Verdict::Ok => {
                format!("replaced {} occurrence(s) in {}", actual_replacements, path.display())
            }
            Verdict::Unchanged => {
                format!(
                    "edit_file reported success but {} is unchanged — the write did not persist",
                    path.display()
                )
            }
            Verdict::Mismatch => {
                format!(
                    "edit_file wrote to {} but the result does not match the expected splice",
                    path.display()
                )
            }
            _ => format!("edit_file: {:?}", verdict),
        };

        Ok(EditResult {
            ok: verdict == Verdict::Ok,
            verdict,
            replacements: actual_replacements,
            message,
        })
    }
}

impl Default for EditVerifier {
    fn default() -> Self {
        Self::new()
    }
}

/// Read a file, bounded to `cap` bytes. Returns error if file exceeds cap.
fn read_file_bounded(path: &Path, cap: usize) -> std::io::Result<String> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > cap as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("file too large for edit ({} > {} bytes)", metadata.len(), cap),
        ));
    }
    let mut file = fs::File::open(path)?;
    let mut buf = vec![0u8; metadata.len() as usize];
    file.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_native_ok() {
        assert_eq!(
            EditVerifier::verify_native("before", "after", "after"),
            Verdict::Ok
        );
    }

    #[test]
    fn test_verify_native_unchanged() {
        assert_eq!(
            EditVerifier::verify_native("same", "same", "different"),
            Verdict::Unchanged
        );
    }

    #[test]
    fn test_verify_native_mismatch() {
        assert_eq!(
            EditVerifier::verify_native("before", "wrong", "expected"),
            Verdict::Mismatch
        );
    }

    #[test]
    fn test_verify_companion_exact_match() {
        assert_eq!(
            EditVerifier::verify_companion("a b c", "a x c", "a x c", "b", "x"),
            Verdict::Ok
        );
    }

    #[test]
    fn test_verify_companion_unchanged() {
        assert_eq!(
            EditVerifier::verify_companion("same", "same", "different", "old", "new"),
            Verdict::Unchanged
        );
    }

    #[test]
    fn test_verify_companion_missing_new() {
        assert_eq!(
            EditVerifier::verify_companion("hello world", "hello world x", "expected", "hello", "new"),
            Verdict::MissingNew
        );
    }

    #[test]
    fn test_verify_companion_stale_old() {
        assert_eq!(
            EditVerifier::verify_companion("a b a", "a b a x", "expected", "b", "x"),
            Verdict::StaleOld
        );
    }

    #[test]
    fn test_edit_file_basic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edit.txt");
        fs::write(&path, "hello world hello").unwrap();

        let verifier = EditVerifier::new();
        let result = verifier
            .edit_file(&path, "hello", "hi", false)
            .unwrap();

        assert!(result.ok);
        assert_eq!(result.replacements, 1);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hi world hello");
    }

    #[test]
    fn test_edit_file_replace_all() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edit.txt");
        fs::write(&path, "hello world hello").unwrap();

        let verifier = EditVerifier::new();
        let result = verifier
            .edit_file(&path, "hello", "hi", true)
            .unwrap();

        assert!(result.ok);
        assert_eq!(result.replacements, 2);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hi world hi");
    }

    #[test]
    fn test_edit_file_old_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edit.txt");
        fs::write(&path, "hello world").unwrap();

        let verifier = EditVerifier::new();
        let result = verifier
            .edit_file(&path, "xyz", "abc", false)
            .unwrap();

        assert!(!result.ok);
        assert_eq!(result.verdict, Verdict::MissingNew);
    }
}
