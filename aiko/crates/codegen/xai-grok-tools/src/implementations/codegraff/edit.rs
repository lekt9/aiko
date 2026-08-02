//! Codegraff `edit` tool — verified file edits with write locks and post-write
//! byte-comparison. Ported from codegraff's `edit_verify.zig`.
//!
//! # What this solves (codegraff issue #337)
//!
//! `edit_file` was reporting "replaced 1 occurrence(s)" over files it had left
//! byte-identical. A loud failure costs one retry; a confident false success
//! corrupts everything built on top of it.
//!
//! # How it works
//!
//! 1. **Write lock**: Striped mutex per file hash — serializes concurrent edits
//! 2. **Post-write re-read**: Every "success" path re-reads the file from disk
//! 3. **Verification**: Byte-compares against expected output

use std::path::PathBuf;
use std::sync::LazyLock;

use xai_aiko_tools_codegraff::edit_file::EditVerifier;

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

const DESCRIPTION: &str = r#"Replace an exact string in a file with post-write verification.

- Read the file with ${{ tools.by_kind.read }} before editing it.
- `old_string` must match exactly one place in the file. If it appears more than once,
  add surrounding lines to make it unique, or set `replace_all` to change every occurrence.
- After writing, this tool re-reads the file from disk and byte-compares against the expected
  result. If the write did not persist or produced the wrong bytes, the tool reports the
  specific failure (unchanged, mismatch, missing new, partial, stale old) instead of lying."#;

// ─── Shared verifier ─────────────────────────────────────────────────

static EDIT_VERIFIER: LazyLock<EditVerifier> = LazyLock::new(EditVerifier::new);

// ─── Input ──────────────────────────────────────────────────────────

/// Input for the codegraff `edit` tool.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct CodegraffEditInput {
    /// Path to the file to modify.
    #[schemars(description = "The path to the file to modify.")]
    pub file_path: String,

    /// The text to replace.
    #[schemars(description = "The text to replace")]
    pub old_string: String,

    /// The text to replace it with.
    #[schemars(description = "The text to replace it with (must be different from old_string)")]
    pub new_string: String,

    /// Replace all occurrences (default false).
    #[serde(
        default,
        deserialize_with = "crate::types::schema::deserialize_lenient_bool"
    )]
    #[schemars(description = "Replace all occurrences of old_string (default false)")]
    pub replace_all: bool,
}

// ─── ToolInput conversions ──────────────────────────────────────────

impl TryFrom<ToolInput> for CodegraffEditInput {
    type Error = String;
    fn try_from(value: ToolInput) -> Result<Self, Self::Error> {
        match value {
            ToolInput::Dynamic(v) => {
                serde_json::from_value(v).map_err(|e| format!("CodegraffEditInput: {e}"))
            }
            _ => Err("expected Dynamic variant for CodegraffEditInput".into()),
        }
    }
}

impl From<CodegraffEditInput> for ToolInput {
    fn from(value: CodegraffEditInput) -> Self {
        ToolInput::Dynamic(
            serde_json::to_value(value).expect("CodegraffEditInput serializes to JSON"),
        )
    }
}

/// Codegraff `edit` tool — verified file edits with write locks.
#[derive(Debug, Default)]
pub struct CodegraffEditTool;

impl crate::types::tool_metadata::ToolMetadata for CodegraffEditTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Edit
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

impl xai_tool_runtime::Tool for CodegraffEditTool {
    type Args = CodegraffEditInput;
    type Output = SearchReplaceOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("edit").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "edit",
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

    #[tracing::instrument(name = "tool.codegraff.edit", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: CodegraffEditInput,
    ) -> Result<SearchReplaceOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::{resolve_cwd, shared_resources};
        let resources = shared_resources(&ctx)?;

        // Validate
        if input.old_string == input.new_string {
            return Ok(SearchReplaceOutput::InvalidInput(
                "Old string and new string are the same".to_owned(),
            ));
        }

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
                return Ok(SearchReplaceOutput::FileNotFound(format!(
                    "File not found: {}",
                    resolved.display()
                )));
            }
            Err(e) => {
                return Ok(SearchReplaceOutput::InvalidInput(format!(
                    "Failed to resolve path {}: {e}",
                    resolved.display()
                )));
            }
        };

        // Perform the verified edit
        match EDIT_VERIFIER.edit_file(&path, &input.old_string, &input.new_string, input.replace_all) {
            Ok(result) => {
                if result.ok {
                    let edit = SearchReplaceEditDetail {
                        old_string: input.old_string.clone(),
                        old_line: 0, // codegraff doesn't track line numbers
                        new_string: input.new_string.clone(),
                        new_line: 0,
                        context_before: String::new(),
                        context_after: String::new(),
                        line_prefix: String::new(),
                    };
                    let msg = if input.replace_all {
                        format!(
                            "The file {} has been updated. All {} occurrences were replaced (codegraff verified).",
                            input.file_path, result.replacements
                        )
                    } else {
                        format!(
                            "The file {} has been updated successfully (codegraff verified).",
                            input.file_path
                        )
                    };
                    Ok(SearchReplaceOutput::EditsApplied(SearchReplaceEditsApplied {
                        old_string: input.old_string.clone(),
                        new_string: input.new_string.clone(),
                        tool_output_for_prompt: msg.clone(),
                        tool_output_for_prompt_concise: Some(msg),
                        absolute_path: path,
                        edits: SearchReplaceEditContextInformation {
                            details: vec![edit],
                        },
                        patch: None,
                        unicode_normalized: false,
                    }))
                } else {
                    Ok(SearchReplaceOutput::InvalidInput(format!(
                        "edit_file failed: {} (verdict: {:?})",
                        result.message, result.verdict
                    )))
                }
            }
            Err(e) => Ok(SearchReplaceOutput::InvalidInput(format!(
                "Failed to edit {}: {e}",
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
    async fn basic_replacement() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("edit_test.txt");
        std::fs::write(&file_path, "hello world hello\n").unwrap();

        let tool = CodegraffEditTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffEditInput {
            file_path: file_path.to_string_lossy().to_string(),
            old_string: "hello".to_string(),
            new_string: "hi".to_string(),
            replace_all: false,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert!(applied.tool_output_for_prompt.contains("verified"));
                let content = std::fs::read_to_string(&file_path).unwrap();
                assert_eq!(content, "hi world hello\n");
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn replace_all() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("replace_all.txt");
        std::fs::write(&file_path, "hello world hello\n").unwrap();

        let tool = CodegraffEditTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffEditInput {
            file_path: file_path.to_string_lossy().to_string(),
            old_string: "hello".to_string(),
            new_string: "hi".to_string(),
            replace_all: true,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert!(applied.tool_output_for_prompt.contains("verified"));
                let content = std::fs::read_to_string(&file_path).unwrap();
                assert_eq!(content, "hi world hi\n");
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn old_string_not_found() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("not_found.txt");
        std::fs::write(&file_path, "hello world\n").unwrap();

        let tool = CodegraffEditTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffEditInput {
            file_path: file_path.to_string_lossy().to_string(),
            old_string: "xyz".to_string(),
            new_string: "abc".to_string(),
            replace_all: false,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::InvalidInput(msg) => {
                assert!(msg.contains("MissingNew") || msg.contains("not found"));
            }
            other => panic!("Expected InvalidInput, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn old_and_new_are_same() {
        let tmp = TempDir::new().unwrap();
        let canonical_tmp = dunce::canonicalize(tmp.path()).unwrap();
        let file_path = canonical_tmp.join("same.txt");
        std::fs::write(&file_path, "hello world\n").unwrap();

        let tool = CodegraffEditTool;
        let resources = test_resources(&canonical_tmp);

        let input = CodegraffEditInput {
            file_path: file_path.to_string_lossy().to_string(),
            old_string: "hello".to_string(),
            new_string: "hello".to_string(),
            replace_all: false,
        };

        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();
        match result {
            SearchReplaceOutput::InvalidInput(msg) => {
                assert!(msg.contains("same"));
            }
            other => panic!("Expected InvalidInput, got {:?}", other),
        }
    }
}
