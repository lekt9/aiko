//! Codegraff `write` tool — atomic, bounded file writes with pre-write snapshots.
//! Ported from codegraff's write path in `exec.zig`.
//!
//! # Key features
//!
//! 1. **Write lock**: Serializes concurrent writes to the same file
//! 2. **Pre-write snapshot**: Records file state before mutation for `/rewind`
//! 3. **Bounded output**: Large writes are capped to prevent context explosion
//! 4. **Atomic rename**: Writes to temp file, then renames — no partial writes

use std::path::PathBuf;
use std::sync::LazyLock;

use xai_aiko_tools_codegraff::edit_file::WriteLock;
use xai_aiko_tools_codegraff::graff_write_file;

use crate::types::output::{
    SearchReplaceEditContextInformation, SearchReplaceEditDetail, SearchReplaceEditsApplied,
    SearchReplaceOutput,
};
use crate::types::requirements::Expr;
#[allow(unused_imports)]
use crate::types::resources::{Cwd, DisplayCwd, FileSystem, SharedResources, resolve_model_path};
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::types::tool_io::ToolInput;

// ─── Constants ──────────────────────────────────────────────────────

const DESCRIPTION: &str = r#"Write content to a file with atomic rename and pre-write snapshot.

- Creates the file if it does not exist; overwrites if it does
- Creates parent directories automatically
- Large content is bounded (capped at 256KB by default)
- Pre-write state is snapshotted for rewind support
- Concurrent writes to the same file are serialized via striped write locks"#;

// ─── Shared write lock ──────────────────────────────────────────────

static WRITE_LOCK: LazyLock<WriteLock> = LazyLock::new(WriteLock::default);

// ─── Input ──────────────────────────────────────────────────────────

/// Input for the codegraff `write` tool.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct CodegraffWriteInput {
    /// Path to write to.
    #[schemars(description = "The path to the file to write.")]
    pub file_path: String,

    /// Content to write.
    #[schemars(description = "The content to write to the file.")]
    pub content: String,

    /// Maximum bytes allowed (truncates if exceeded). Default: 256KB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Maximum bytes allowed. Default: 256KB.")]
    pub max_bytes: Option<usize>,
}

// ─── ToolInput conversions ──────────────────────────────────────────

impl TryFrom<ToolInput> for CodegraffWriteInput {
    type Error = String;
    fn try_from(value: ToolInput) -> Result<Self, Self::Error> {
        match value {
            ToolInput::Dynamic(v) => {
                serde_json::from_value(v).map_err(|e| format!("CodegraffWriteInput: {e}"))
            }
            _ => Err("expected Dynamic variant for CodegraffWriteInput".into()),
        }
    }
}

impl From<CodegraffWriteInput> for ToolInput {
    fn from(value: CodegraffWriteInput) -> Self {
        ToolInput::Dynamic(
            serde_json::to_value(value).expect("CodegraffWriteInput serializes to JSON"),
        )
    }
}

/// Codegraff `write` tool — atomic, bounded file writes with snapshots.
#[derive(Debug, Default)]
pub struct CodegraffWriteTool;

impl crate::types::tool_metadata::ToolMetadata for CodegraffWriteTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Write
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

impl xai_tool_runtime::Tool for CodegraffWriteTool {
    type Args = CodegraffWriteInput;
    type Output = SearchReplaceOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("write").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "write",
            crate::types::tool_metadata::ToolMetadata::description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "tool.codegraff.write", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: CodegraffWriteInput,
    ) -> Result<SearchReplaceOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::{resolve_cwd, shared_resources};
        let resources = shared_resources(&ctx)?;

        // Resolve path
        let cwd = resolve_cwd(&ctx, &resources).await?;
        let display_cwd: Option<PathBuf> = {
            let res = resources.lock().await;
            res.get::<DisplayCwd>().map(|d| d.0.clone())
        };
        let resolved = resolve_model_path(&cwd, display_cwd.as_deref(), &input.file_path);
        let path: PathBuf = match crate::util::fs::try_canonicalize(&resolved).await {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // File doesn't exist yet — that's fine for write (we'll create it).
                // Canonicalize the parent directory instead.
                if let Some(parent) = resolved.parent() {
                    match crate::util::fs::try_canonicalize(parent).await {
                        Ok(p) => p.join(resolved.file_name().unwrap_or_default()),
                        Err(_) => resolved.clone(),
                    }
                } else {
                    resolved.clone()
                }
            }
            Err(_) => resolved,
        };

        // Perform the graff write
        match graff_write_file(&path, &input.content, input.max_bytes, Some(&WRITE_LOCK)) {
            Ok(result) => {
                if result.ok {
                    let msg = if result.truncated {
                        format!(
                            "Wrote {} to {} (truncated from {} bytes to {} bytes, codegraff).",
                            path.display(),
                            input.file_path,
                            input.content.len(),
                            result.bytes_written,
                        )
                    } else {
                        format!(
                            "Wrote {} bytes to {}.",
                            result.bytes_written,
                            input.file_path
                        )
                    };
                    Ok(SearchReplaceOutput::EditsApplied(SearchReplaceEditsApplied {
                        old_string: String::new(),
                        new_string: input.content.clone(),
                        tool_output_for_prompt: msg.clone(),
                        tool_output_for_prompt_concise: Some(msg),
                        absolute_path: path,
                        edits: SearchReplaceEditContextInformation {
                            details: vec![SearchReplaceEditDetail {
                                old_string: String::new(),
                                old_line: 0,
                                new_string: input.content.clone(),
                                new_line: 0,
                                context_before: String::new(),
                                context_after: String::new(),
                                line_prefix: String::new(),
                            }],
                        },
                        patch: None,
                        unicode_normalized: false,
                    }))
                } else {
                    Ok(SearchReplaceOutput::InvalidInput(format!(
                        "Failed to write {}: {}",
                        input.file_path, result.message
                    )))
                }
            }
            Err(e) => Ok(SearchReplaceOutput::InvalidInput(format!(
                "Failed to write {}: {e}",
                input.file_path
            ))),
        }
    }
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
    async fn basic_write() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("write_test.txt");

        let tool = CodegraffWriteTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffWriteInput {
            file_path: file_path.to_string_lossy().to_string(),
            content: "hello world".to_string(),
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert!(applied.tool_output_for_prompt.contains("Wrote"));
                let content = std::fs::read_to_string(&file_path).unwrap();
                assert_eq!(content, "hello world");
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn overwrite_existing() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("overwrite.txt");
        std::fs::write(&file_path, "original").unwrap();

        let tool = CodegraffWriteTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffWriteInput {
            file_path: file_path.to_string_lossy().to_string(),
            content: "modified".to_string(),
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::EditsApplied(_) => {
                let content = std::fs::read_to_string(&file_path).unwrap();
                assert_eq!(content, "modified");
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn creates_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("deep/nested/file.txt");

        let tool = CodegraffWriteTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffWriteInput {
            file_path: file_path.to_string_lossy().to_string(),
            content: "deep content".to_string(),
            max_bytes: None,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::EditsApplied(_) => {
                assert!(file_path.exists());
                let content = std::fs::read_to_string(&file_path).unwrap();
                assert_eq!(content, "deep content");
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn truncation() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("big_write.txt");

        let big = "x".repeat(500_000);

        let tool = CodegraffWriteTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffWriteInput {
            file_path: file_path.to_string_lossy().to_string(),
            content: big,
            max_bytes: Some(256 * 1024),
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert!(applied.tool_output_for_prompt.contains("truncated"));
                let content = std::fs::read_to_string(&file_path).unwrap();
                assert!(content.len() <= 256 * 1024);
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }
}
