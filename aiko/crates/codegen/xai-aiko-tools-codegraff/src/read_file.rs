//! Codegraff-style read_file — streaming line windows, binary detection,
//! preview truncation for large files. Ported from codegraff's `read_file.zig`.
//!
//! # Modes
//!
//! 1. **Full read** (no line range): reads the entire file up to `READ_MAX_BYTES`.
//!    Files larger than this get a `Truncated` result with a preview.
//! 2. **Line window** (start/end line): streams through the file in 16KB buffers,
//!    collecting only the requested lines. Never allocates the full file.
//! 3. **Binary detection**: checks the first 4KB for null bytes; if found,
//!    returns `Binary` with the file size.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::{is_binary_ext, READ_MAX_BYTES, PREVIEW_BYTES, STREAM_BUF_SIZE};

/// The result of a graff-style read_file operation.
#[derive(Debug)]
pub enum ReadFileResult {
    /// The complete file contents (up to READ_MAX_BYTES).
    Text(String),
    /// File was too large for a full read; head contains a preview.
    Truncated { head: String, total_bytes: u64 },
    /// File appears to be binary (contains null bytes or has a binary extension).
    Binary { size: u64 },
    /// The requested line range is beyond the file end.
    StartPastEnd,
    /// A single line in the requested range exceeds READ_MAX_BYTES.
    RangeTooLarge,
}

/// Options for a graff-style read.
#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    /// 1-based start line (None = from line 1).
    pub start_line: Option<i64>,
    /// 1-based end line (None = to end of file).
    pub end_line: Option<i64>,
    /// Max bytes for whole-file reads. Default: READ_MAX_BYTES (256KB).
    pub max_bytes: Option<usize>,
}

impl ReadOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_lines(mut self, start: Option<i64>, end: Option<i64>) -> Self {
        self.start_line = start;
        self.end_line = end;
        self
    }
}

/// Normalize 1-based line numbers to 0-based usize bounds.
/// Returns None if the range is invalid (end < start).
fn normalized_bounds(start_opt: Option<i64>, end_opt: Option<i64>) -> Option<(usize, usize)> {
    let start: usize = match start_opt {
        Some(v) if v < 1 => 1,
        Some(v) => v as usize,
        None => 1,
    };
    let end: usize = match end_opt {
        Some(v) if v < 1 => 1,
        Some(v) => v as usize,
        None => usize::MAX,
    };
    if end < start {
        None
    } else {
        Some((start, end))
    }
}

/// Read the first N bytes of a file for binary detection.
fn read_prefix<'a>(file: &mut File, size: u64, buffer: &'a mut [u8]) -> std::io::Result<&'a [u8]> {
    let want = (size as usize).min(buffer.len());
    file.seek(SeekFrom::Start(0))?;
    let n = file.read(&mut buffer[..want])?;
    Ok(&buffer[..n])
}

/// Perform a graff-style read of the file at `path`.
///
/// # Arguments
/// * `path` - Path to the file to read.
/// * `options` - Read options (line range, max bytes).
pub fn graff_read_file<P: AsRef<Path>>(
    path: P,
    options: &ReadOptions,
) -> std::io::Result<ReadFileResult> {
    let path = path.as_ref();
    let max_bytes = options.max_bytes.unwrap_or(READ_MAX_BYTES);

    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return Err(e),
    };

    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "path is not a regular file",
        ));
    }

    let size = metadata.len();

    // Binary extension check
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if is_binary_ext(name) {
            return Ok(ReadFileResult::Binary { size });
        }
    }

    let mut file = File::open(path)?;

    // Binary content check: scan first 4KB for null bytes
    let mut prefix_buf = [0u8; 4096];
    let prefix = read_prefix(&mut file, size, &mut prefix_buf)?;
    if prefix.contains(&0) {
        return Ok(ReadFileResult::Binary { size });
    }

    // Line-window mode
    if options.start_line.is_some() || options.end_line.is_some() {
        return read_window(&mut file, size, options.start_line, options.end_line, max_bytes);
    }

    // Whole-file mode: large files get a preview
    if size > max_bytes as u64 {
        let head_bytes = prefix[..prefix.len().min(PREVIEW_BYTES)].to_vec();
        let head = String::from_utf8_lossy(&head_bytes).into_owned();
        return Ok(ReadFileResult::Truncated {
            head,
            total_bytes: size,
        });
    }

    // Read entire file
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = vec![0u8; size as usize];
    file.read_exact(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(ReadFileResult::Text(text))
}

/// Stream through a file, collecting only lines within the requested range.
/// Uses 16KB read buffers — never allocates the full file.
fn read_window(
    file: &mut File,
    size: u64,
    start_opt: Option<i64>,
    end_opt: Option<i64>,
    max_bytes: usize,
) -> std::io::Result<ReadFileResult> {
    let (target_start, target_end) = match normalized_bounds(start_opt, end_opt) {
        Some(b) => b,
        None => return Ok(ReadFileResult::StartPastEnd),
    };

    if size == 0 {
        return Ok(ReadFileResult::StartPastEnd);
    }

    file.seek(SeekFrom::Start(0))?;
    let reader = BufReader::with_capacity(STREAM_BUF_SIZE, file);
    let mut output = String::with_capacity(8192);
    let mut line: usize = 1;
    let mut reached_start = target_start == 1;

    for line_result in reader.lines() {
        let line_text = line_result?;

        if reached_start {
            let addition = format!("{}\n", line_text);

            if output.len() + addition.len() > max_bytes {
                return Ok(ReadFileResult::RangeTooLarge);
            }
            output.push_str(&addition);
        }

        if line == target_end {
            return Ok(ReadFileResult::Text(output));
        }

        line += 1;
        if line == target_start {
            reached_start = true;
        }
    }

    if !reached_start {
        return Ok(ReadFileResult::StartPastEnd);
    }

    Ok(ReadFileResult::Text(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(content: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, content).unwrap();
        (dir, path)
    }

    #[test]
    fn test_small_whole_read() {
        let (_dir, path) = write_temp("a\nb\nc\nd\n");
        let result = graff_read_file(&path, &ReadOptions::new()).unwrap();
        match result {
            ReadFileResult::Text(text) => assert_eq!(text, "a\nb\nc\nd\n"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn test_line_window() {
        let (_dir, path) = write_temp("a\nb\nc\nd\n");
        let opts = ReadOptions::new().with_lines(Some(2), Some(3));
        let result = graff_read_file(&path, &opts).unwrap();
        match result {
            ReadFileResult::Text(text) => assert_eq!(text, "b\nc\n"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn test_line_window_single() {
        let (_dir, path) = write_temp("a\nb\nc\nd\n");
        let opts = ReadOptions::new().with_lines(Some(3), Some(3));
        let result = graff_read_file(&path, &opts).unwrap();
        match result {
            ReadFileResult::Text(text) => assert_eq!(text, "c\n"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn test_line_window_last() {
        let (_dir, path) = write_temp("a\nb\nc\nd");
        let opts = ReadOptions::new().with_lines(Some(4), Some(4));
        let result = graff_read_file(&path, &opts).unwrap();
        match result {
            ReadFileResult::Text(text) => assert_eq!(text, "d\n"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn test_start_past_end() {
        let (_dir, path) = write_temp("a\nb\n");
        let opts = ReadOptions::new().with_lines(Some(99), Some(100));
        let result = graff_read_file(&path, &opts).unwrap();
        assert!(matches!(result, ReadFileResult::StartPastEnd));
    }

    #[test]
    fn test_binary_detection_by_ext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, b"not really an image").unwrap();
        let result = graff_read_file(&path, &ReadOptions::new()).unwrap();
        assert!(matches!(result, ReadFileResult::Binary { .. }));
    }

    #[test]
    fn test_binary_detection_by_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.bin");
        let mut content = vec![b'a'; 100];
        content[50] = 0; // null byte = binary
        std::fs::write(&path, &content).unwrap();
        let result = graff_read_file(&path, &ReadOptions::new()).unwrap();
        assert!(matches!(result, ReadFileResult::Binary { .. }));
    }

    #[test]
    fn test_large_file_preview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        let content = "x".repeat(READ_MAX_BYTES + 64);
        std::fs::write(&path, &content).unwrap();

        let result = graff_read_file(&path, &ReadOptions::new()).unwrap();
        match result {
            ReadFileResult::Truncated { head, total_bytes } => {
                assert_eq!(total_bytes, (READ_MAX_BYTES + 64) as u64);
                assert!(head.len() <= PREVIEW_BYTES);
                assert!(!head.is_empty());
            }
            other => panic!("expected Truncated, got {:?}", other),
        }
    }

    #[test]
    fn test_large_file_line_window_still_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        let mut content = "x\n".repeat(READ_MAX_BYTES / 2);
        content.push_str("target\nlast\n");
        std::fs::write(&path, &content).unwrap();

        // Line window should work even on large files
        let line_count = content.lines().count();
        let opts = ReadOptions::new().with_lines(
            Some((line_count - 1) as i64),
            Some(line_count as i64),
        );
        let result = graff_read_file(&path, &opts).unwrap();
        match result {
            ReadFileResult::Text(text) => assert_eq!(text, "target\nlast\n"),
            other => panic!("expected Text in line window, got {:?}", other),
        }
    }
}
