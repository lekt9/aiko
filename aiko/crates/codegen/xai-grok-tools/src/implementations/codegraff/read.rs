//! Codegraff `read` tool — bounded, streaming file reads with binary detection.
//!
//! Wraps `xai_aiko_tools_codegraff::graff_read_file`:
//! - Whole-file reads capped at 256KB (larger files get a preview)
//! - Line-range reads stream through 16KB buffers — never allocates the full file
//! - Binary detection via extension AND null-byte content scan
//!
//! This is a drop-in primitive replacement for the default read_file tool,
//! suitable when bounded resource usage matters more than PDF/PPTX/image support.

use std::path::PathBuf;

use xai_aiko_tools_codegraff::{ReadOptions, graff_read_file};

use crate::types::output::{FileContent, ReadFileOutput};
use crate::types::requirements::Expr;
#[allow(unused_imports)]
use crate::types::resources::{Cwd, DisplayCwd, FileSystem, SharedResources, resolve_model_path};
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::types::tool_io::ToolInput;

// ─── Constants ──────────────────────────────────────────────────────

const DESCRIPTION: &str = r#"Read a file using bounded, streaming Codegraff primitives.

Usage:
- The target_file parameter can be a relative path in the workspace or an absolute path
- Whole-file reads are capped at 256KB; larger files get a preview with the total byte count
- Line-range reads use streaming 16KB buffers and never allocate the full file
- Binary files are detected by extension AND content scan (null bytes in first 4KB)
- Results are returned with line numbers starting at 1. The format is: LINE_NUMBER→LINE_CONTENT
- This is a bounded, hard-capped read — prefer it when resource discipline matters over
  rich format support (no PDF, PPTX, or image decoding)."#;

// ─── Input ──────────────────────────────────────────────────────────

/// Input for the codegraff `read` tool.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct CodegraffReadInput {
    /// Path to the file to read.
    #[schemars(description = "The path of the file to read.")]
    pub target_file: String,

    /// 1-based start line (optional — from beginning if None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "The line number to start reading from.")]
    pub offset: Option<i64>,

    /// 1-based end line (optional — to end of file if None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "The last line number to read (inclusive).")]
    pub end_line: Option<i64>,

    /// Maximum bytes for whole-file reads. Defaults to 256KB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Max bytes for whole-file reads. Default: 256KB.")]
    pub max_bytes: Option<usize>,
}

// ─── ToolInput conversions ──────────────────────────────────────────

impl TryFrom<ToolInput> for CodegraffReadInput {
    type Error = String;
    fn try_from(value: ToolInput) -> Result<Self, Self::Error> {
        match value {
            ToolInput::Dynamic(v) => {
                serde_json::from_value(v).map_err(|e| format!("CodegraffReadInput: {e}"))
            }
            _ => Err("expected Dynamic variant for CodegraffReadInput".into()),
        }
    }
}

impl From<CodegraffReadInput> for ToolInput {
    fn from(value: CodegraffReadInput) -> Self {
        ToolInput::Dynamic(
            serde_json::to_value(value).expect("CodegraffReadInput serializes to JSON"),
        )
    }
}

/// Codegraff `read` tool — bounded, streaming, binary-aware file reads.
#[derive(Debug, Default)]
pub struct CodegraffReadTool;

impl crate::types::tool_metadata::ToolMetadata for CodegraffReadTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::Codegraff
    }

    fn description_template(&self) -> &str {
        DESCRIPTION
    }

    fn requires_expr(&self) -> Expr<crate::types::requirements::ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for CodegraffReadTool {
    type Args = CodegraffReadInput;
    type Output = ReadFileOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("read").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "read",
            crate::types::tool_metadata::ToolMetadata::description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "tool.codegraff.read", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: CodegraffReadInput,
    ) -> Result<ReadFileOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::{resolve_cwd, shared_resources};
        let resources = shared_resources(&ctx)?;

        // Resolve path
        let cwd = resolve_cwd(&ctx, &resources).await?;
        let display_cwd: Option<PathBuf> = {
            let res = resources.lock().await;
            res.get::<DisplayCwd>().map(|d| d.0.clone())
        };
        let resolved = resolve_model_path(&cwd, display_cwd.as_deref(), &input.target_file);
        let path: PathBuf = match crate::util::fs::try_canonicalize(&resolved).await {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ReadFileOutput::FileReadError(format!(
                    "File not found: {}",
                    resolved.display()
                )));
            }
            Err(_) => resolved,
        };

        // Build read options
        let opts = ReadOptions {
            start_line: input.offset,
            end_line: input.end_line,
            max_bytes: input.max_bytes,
        };

        // Perform the graff read
        match graff_read_file(&path, &opts) {
            Ok(result) => match result {
                xai_aiko_tools_codegraff::ReadFileResult::Text(text) => {
                    let total_lines = if text.is_empty() {
                        0
                    } else {
                        text.lines().count()
                    };
                    let content = format_codegraff_output(&path, &text, input.offset.map(|o| o as usize));
                    Ok(ReadFileOutput::FileContent(FileContent {
                        content,
                        content_concise: None,
                        absolute_path: path,
                        offset: input.offset.map(|o| o as usize),
                        limit: input.end_line.map(|e| e as usize),
                        raw_output: text,
                        total_lines,
                        extracted_images: Vec::new(),
                    }))
                }
                xai_aiko_tools_codegraff::ReadFileResult::Truncated { head, total_bytes } => {
                    let total_lines = if head.is_empty() {
                        0
                    } else {
                        head.lines().count()
                    };
                    let content = format!(
                        "{} (truncated — file is {total_bytes} bytes, showing first {} bytes preview)\n{}",
                        path.display(),
                        head.len(),
                        format_codegraff_output(&path, &head, None)
                    );
                    Ok(ReadFileOutput::FileContent(FileContent {
                        content,
                        content_concise: None,
                        absolute_path: path,
                        offset: input.offset.map(|o| o as usize),
                        limit: input.end_line.map(|e| e as usize),
                        raw_output: head,
                        total_lines,
                        extracted_images: Vec::new(),
                    }))
                }
                xai_aiko_tools_codegraff::ReadFileResult::Binary { size } => {
                    Ok(ReadFileOutput::FileReadError(format!(
                        "Cannot read binary file: {} ({} bytes)",
                        path.display(),
                        size
                    )))
                }
                xai_aiko_tools_codegraff::ReadFileResult::StartPastEnd => {
                    Ok(ReadFileOutput::FileReadError(format!(
                        "Requested line range starts past the end of {}",
                        path.display()
                    )))
                }
                xai_aiko_tools_codegraff::ReadFileResult::RangeTooLarge => {
                    Ok(ReadFileOutput::FileReadError(format!(
                        "Requested line range exceeds the maximum read size for {}",
                        path.display()
                    )))
                }
            },
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Ok(ReadFileOutput::FileReadError(format!(
                        "File not found: {}",
                        path.display()
                    )))
                } else {
                    Ok(ReadFileOutput::FileReadError(format!(
                        "Failed to read {}: {e}",
                        path.display()
                    )))
                }
            }
        }
    }
}

/// Format codegraff read output with line numbers (matching the standard read_file format).
fn format_codegraff_output(
    path: &std::path::Path,
    text: &str,
    offset: Option<usize>,
) -> String {
    let start_line = offset.unwrap_or(1);
    let mut out = String::with_capacity(text.len() + 256);
    for (i, line) in text.lines().enumerate() {
        let line_num = start_line + i;
        out.push_str(&format!("{line_num:>6}→{line}\n"));
    }
    // Drop trailing newline for consistency
    if out.ends_with('\n') {
        let _ = out.pop();
    }
    let _ = path; // path is implicit in the operation context
    out
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::local::LocalFs;
    use crate::notification::types::ToolNotificationHandle;
    use crate::types::resources::{NotificationHandle, Resources};
    use crate::types::tool_metadata::test_ctx;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn test_resources(cwd: &std::path::Path) -> Resources {
        let mut resources = Resources::new();
        resources.insert(Cwd(cwd.to_path_buf()));
        resources.insert(FileSystem(Arc::new(LocalFs)));
        resources.insert(NotificationHandle(ToolNotificationHandle::noop()));
        resources
    }

    #[tokio::test]
    async fn read_text_file_basic() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("test.txt");
        std::fs::write(&file_path, "line1\nline2\nline3\n").unwrap();

        let tool = CodegraffReadTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffReadInput {
            target_file: file_path.to_string_lossy().to_string(),
            offset: None,
            end_line: None,
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            ReadFileOutput::FileContent(fc) => {
                assert!(fc.raw_output.contains("line1"));
                assert!(fc.raw_output.contains("line3"));
            }
            other => panic!("Expected FileContent, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn read_with_line_range() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("multi.txt");
        let content: String = (1..=100)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&file_path, &content).unwrap();

        let tool = CodegraffReadTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffReadInput {
            target_file: file_path.to_string_lossy().to_string(),
            offset: Some(10),
            end_line: Some(15),
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            ReadFileOutput::FileContent(fc) => {
                assert!(fc.raw_output.contains("line 10"));
                assert!(fc.raw_output.contains("line 15"));
            }
            other => panic!("Expected FileContent, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn binary_file_rejected() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("data.bin");
        let mut data = vec![b'a'; 200];
        data[50] = 0; // null byte = binary
        std::fs::write(&file_path, &data).unwrap();

        let tool = CodegraffReadTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffReadInput {
            target_file: file_path.to_string_lossy().to_string(),
            offset: None,
            end_line: None,
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            ReadFileOutput::FileReadError(msg) => {
                assert!(msg.contains("Cannot read binary file"));
            }
            other => panic!("Expected FileReadError, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn large_file_preview() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("large.txt");

        // Create a file larger than READ_MAX_BYTES (256KB)
        let content = "x".repeat(300 * 1024);
        std::fs::write(&file_path, &content).unwrap();

        let tool = CodegraffReadTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffReadInput {
            target_file: file_path.to_string_lossy().to_string(),
            offset: None,
            end_line: None,
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            ReadFileOutput::FileContent(fc) => {
                assert!(fc.content.contains("truncated"));
            }
            other => panic!("Expected FileContent (truncated), got {:?}", other),
        }
    }

    #[tokio::test]
    async fn file_not_found() {
        let tmp = TempDir::new().unwrap();
        let tool = CodegraffReadTool;
        let resources = test_resources(tmp.path());

        let input = CodegraffReadInput {
            target_file: "nonexistent.txt".to_string(),
            offset: None,
            end_line: None,
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            ReadFileOutput::FileReadError(msg) => {
                assert!(msg.contains("File not found") || msg.contains("not a regular file") || msg.contains("Failed to read"));
            }
            other => panic!("Expected FileReadError, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn binary_extension_rejected() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("image.png");
        std::fs::write(&file_path, b"not really a png, but has .png ext").unwrap();

        let tool = CodegraffReadTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffReadInput {
            target_file: file_path.to_string_lossy().to_string(),
            offset: None,
            end_line: None,
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            ReadFileOutput::FileReadError(msg) => {
                assert!(msg.contains("Cannot read binary file"));
            }
            other => panic!("Expected FileReadError, got {:?}", other),
        }
    }
}
