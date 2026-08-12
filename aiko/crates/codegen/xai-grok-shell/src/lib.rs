#![allow(
    unused_imports,
    unused_variables,
    unused_mut,
    unreachable_code,
    dead_code
)]
pub(crate) use xai_grok_telemetry::unified_log;
pub use xai_tracing_macros::{teprintln, timed, tprintln};
pub mod active_sessions;
pub mod agent;
pub mod agentmail_native;
pub mod auth;
pub mod builtin;
pub mod bundle;
pub mod capability_catalog;
pub mod captcha_native;
pub mod claude_import;
pub mod claude_import_state;
pub mod cli_models;
pub mod collective_host;
pub mod config;
pub mod contract_native;
pub mod telegram_native;
pub use xai_grok_shell_base::cpu_profile;
pub use xai_grok_shell_base::env;
pub mod extensions;
pub use xai_grok_workspace::foreign_sessions;
pub mod heap_profile;
pub use xai_grok_http as http;
pub mod inspect;
pub mod instrumentation;
pub mod leader;
pub mod managed_config;
pub mod mcp_doctor;
pub use xai_grok_models as models;
pub mod plugin;
pub mod provider;

pub mod relay;
pub mod remote;
pub mod sampling;
pub mod session;
pub mod terminal;
#[cfg(test)]
pub(crate) mod test_support;
pub mod tier;
pub mod tools;
pub mod trace_classifier;
pub mod upload;
pub mod util;

/// Versioned machine surface for GraphHarness workflow operations.
///
/// The host supplies `cwd`, identity, conversation, and state roots. Those are
/// deliberately absent from the request so a caller cannot select verifier,
/// signer, Cell, rollout, or filesystem authority.
pub mod graph_harness_service {
    use std::path::Path;

    use agent_client_protocol as acp;
    use serde::{Deserialize, Serialize};
    use serde_json::{Value, json};
    use xai_grok_sampling_types::ConversationItem;

    use crate::contract_native;
    use crate::contract_native::graph_harness::{
        EmbeddedCompiler, PreparedGraph, RouteReason, WorkflowRequestFacts, WorkflowRoute,
        classify_workflow,
    };

    pub const API_VERSION: &str = "aiko.workflow/v1";

    /// Return the deployment-owned state root used by status/inspect callers.
    /// The request never carries this path.
    pub fn deployment_state_root(cwd: &Path) -> Result<std::path::PathBuf, String> {
        contract_native::graph_harness_state_root_bootstrap(cwd)
    }

    /// Versioned CLI schema response, sourced from the exact MCP catalog so
    /// the two public surfaces cannot advertise different operations.
    pub fn schema(operation: Option<&str>) -> Value {
        let selected = xai_grok_mcp::graph_harness_tools::tool_catalog()
            .into_iter()
            .filter(|tool| {
                operation.is_none_or(|name| tool.name.strip_prefix("workflow_") == Some(name))
            })
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                    "read_only": tool.read_only
                })
            })
            .collect::<Vec<_>>();
        json!({
            "api_version": API_VERSION,
            "operation": "schema",
            "ok": true,
            "result": {"tools": selected}
        })
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct WorkflowOperationRequest {
        pub api_version: String,
        pub operation: WorkflowOperation,
        #[serde(default)]
        pub goal: Option<String>,
        #[serde(default)]
        pub bundle_ref: Option<String>,
        #[serde(default)]
        pub acceptance_mode: Option<String>,
        #[serde(default)]
        pub query: Option<String>,
    }

    #[derive(Debug, Clone, Copy, Deserialize, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum WorkflowOperation {
        Route,
        Prepare,
        Submit,
        Status,
        Inspect,
        Find,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct WorkflowOperationResponse {
        pub api_version: &'static str,
        pub operation: WorkflowOperation,
        pub ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub error: Option<WorkflowOperationError>,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct WorkflowOperationError {
        pub code: &'static str,
        pub message: String,
        pub retryable: bool,
    }

    impl WorkflowOperationResponse {
        fn ok(operation: WorkflowOperation, result: Value) -> Self {
            Self {
                api_version: API_VERSION,
                operation,
                ok: true,
                result: Some(result),
                error: None,
            }
        }

        fn refuse(
            operation: WorkflowOperation,
            code: &'static str,
            message: impl Into<String>,
        ) -> Self {
            Self {
                api_version: API_VERSION,
                operation,
                ok: false,
                result: None,
                error: Some(WorkflowOperationError {
                    code,
                    message: message.into(),
                    retryable: false,
                }),
            }
        }
    }

    /// Dispatch a native MCP GraphHarness tool into [`execute`]. The MCP
    /// crate owns the closed schemas while this shell remains the sole owner
    /// of Contract access, avoiding both a dependency cycle and a second
    /// workflow implementation.
    pub async fn execute_mcp(
        tool_name: &str,
        input: Value,
        cwd: &Path,
        identity_scope: &str,
        conversation: &[ConversationItem],
        state_root: &Path,
    ) -> Value {
        xai_grok_mcp::graph_harness_tools::dispatch(tool_name, input, |machine_request| async move {
            match serde_json::from_value::<WorkflowOperationRequest>(machine_request) {
                Ok(request) => serde_json::to_value(execute(request, cwd, identity_scope, conversation, state_root).await)
                    .unwrap_or_else(|error| json!({
                        "api_version": API_VERSION,
                        "ok": false,
                        "error": {"code": "workflow_response_encoding_failed", "message": error.to_string(), "retryable": false}
                    })),
                Err(error) => json!({
                    "api_version": API_VERSION,
                    "ok": false,
                    "error": {"code": "workflow_request_invalid", "message": error.to_string(), "retryable": false}
                }),
            }
        }).await
    }

    /// Bind the production MCP server to this service with deployment-owned
    /// context. MCP callers can provide only the closed tool arguments; they
    /// cannot replace any captured path, identity, or Contract authority.
    pub fn mcp_server(
        cwd: &Path,
        identity_scope: &str,
        conversation: &[ConversationItem],
        state_root: &Path,
    ) -> xai_grok_mcp::graph_harness_tools::GraphHarnessMcpServer {
        let cwd = cwd.to_path_buf();
        let identity_scope = identity_scope.to_owned();
        let conversation = conversation.to_vec();
        let state_root = state_root.to_path_buf();
        xai_grok_mcp::graph_harness_tools::GraphHarnessMcpServer::new(std::sync::Arc::new(
            move |tool_name, input| {
                let tool_name = tool_name.to_owned();
                let cwd = cwd.clone();
                let identity_scope = identity_scope.clone();
                let conversation = conversation.clone();
                let state_root = state_root.clone();
                Box::pin(async move {
                    execute_mcp(
                        &tool_name,
                        input,
                        &cwd,
                        &identity_scope,
                        &conversation,
                        &state_root,
                    )
                    .await
                })
            },
        ))
    }

    /// Execute one machine operation through the embedded contract-native
    /// service. `submit` enters the same `ground_turn` membrane used by prompt,
    /// headless, and ACP turns; it never invokes `bin/aiko-harness`.
    pub async fn execute(
        request: WorkflowOperationRequest,
        cwd: &Path,
        identity_scope: &str,
        conversation: &[ConversationItem],
        state_root: &Path,
    ) -> WorkflowOperationResponse {
        let operation = request.operation;
        if request.api_version != API_VERSION {
            return WorkflowOperationResponse::refuse(
                operation,
                "workflow_api_version_unsupported",
                format!("expected {API_VERSION}"),
            );
        }
        match operation {
            WorkflowOperation::Route => {
                let Some(goal) = nonempty(request.goal) else {
                    return missing(operation, "goal");
                };
                let route = classify_workflow(
                    &WorkflowRequestFacts {
                        explicit_workflow: true,
                        ..Default::default()
                    },
                    None,
                );
                match route {
                    WorkflowRoute::GraphHarnessRequired { reasons } => {
                        WorkflowOperationResponse::ok(
                            operation,
                            json!({
                                "goal": goal,
                                "route": "graph_harness_required",
                                "reasons": reasons.into_iter().map(route_reason).collect::<Vec<_>>()
                            }),
                        )
                    }
                    WorkflowRoute::DirectAllowed { .. } => WorkflowOperationResponse::refuse(
                        operation,
                        "workflow_route_invariant",
                        "an explicit workflow was not routed through GraphHarness",
                    ),
                    WorkflowRoute::CompatibilityEscape { .. } => WorkflowOperationResponse::refuse(
                        operation,
                        "workflow_compatibility_escape_unconfigured",
                        "request-selected compatibility is forbidden",
                    ),
                    WorkflowRoute::Refused { code } => WorkflowOperationResponse::refuse(
                        operation,
                        "workflow_route_refused",
                        format!("{code:?}"),
                    ),
                }
            }
            WorkflowOperation::Submit => {
                let Some(acceptance_mode) = nonempty(request.acceptance_mode) else {
                    return missing(operation, "acceptance_mode");
                };
                if acceptance_mode != contract_native::graph_harness::SUBJECTIVE_ACCEPTANCE_PROFILE
                {
                    return WorkflowOperationResponse::refuse(
                        operation,
                        "workflow_acceptance_profile_unsupported",
                        "objective workflows require an admitted bounded acceptance profile; only explicit subjective-independent-edge-review/v1 is currently supported",
                    );
                }
                let Some(goal) = nonempty(request.goal) else {
                    return missing(operation, "goal");
                };
                let prepared_reuse = match nonempty(request.bundle_ref) {
                    Some(bundle_ref) => {
                        match PreparedGraph::load_persisted(state_root, &bundle_ref).and_then(
                            |prepared| {
                                EmbeddedCompiler::inspect(&prepared)?;
                                Ok(prepared)
                            },
                        ) {
                            Ok(prepared)
                                if prepared
                                    .envelope
                                    .pointer("/package/metadata/labels/acceptance_profile")
                                    .and_then(Value::as_str)
                                    == Some(acceptance_mode.as_str()) =>
                            {
                                Some(prepared)
                            }
                            Ok(_) => {
                                return WorkflowOperationResponse::refuse(
                                    operation,
                                    "workflow_prepared_reuse_refused",
                                    "prepared bundle acceptance profile differs from the typed request",
                                );
                            }
                            Err(error) => {
                                return WorkflowOperationResponse::refuse(
                                    operation,
                                    "workflow_prepared_reuse_refused",
                                    error.to_string(),
                                );
                            }
                        }
                    }
                    None => None,
                };
                let reusing = prepared_reuse.is_some();
                let blocks = vec![acp::ContentBlock::Text(acp::TextContent::new(goal))];
                match contract_native::ground_turn_with_facts_and_prepared(
                    &blocks,
                    cwd,
                    identity_scope,
                    conversation,
                    WorkflowRequestFacts {
                        explicit_workflow: true,
                        reuse_or_publish: reusing,
                        ..Default::default()
                    },
                    prepared_reuse,
                )
                .await
                {
                    Ok(grounded) => match submission_receipt(&grounded, state_root) {
                        Ok(receipt) => WorkflowOperationResponse::ok(operation, receipt),
                        Err(message) => WorkflowOperationResponse::refuse(
                            operation,
                            "workflow_submit_receipt_missing",
                            message,
                        ),
                    },
                    Err(message) => WorkflowOperationResponse::refuse(
                        operation,
                        "workflow_submit_refused",
                        message,
                    ),
                }
            }
            WorkflowOperation::Status | WorkflowOperation::Inspect => {
                let Some(bundle_ref) = nonempty(request.bundle_ref) else {
                    return missing(operation, "bundle_ref");
                };
                match bundle_lifecycle(
                    state_root,
                    &bundle_ref,
                    matches!(operation, WorkflowOperation::Inspect),
                ) {
                    Ok(lifecycle) => WorkflowOperationResponse::ok(operation, lifecycle),
                    Err(error) => WorkflowOperationResponse::refuse(
                        operation,
                        "workflow_bundle_not_inspectable",
                        error,
                    ),
                }
            }
            WorkflowOperation::Prepare => unsupported(
                operation,
                "prepare requires a typed bounded plan; prompt preparation occurs inside ground_turn",
            ),
            WorkflowOperation::Find => unsupported(
                operation,
                "registry discovery is not yet available in the embedded Rust host",
            ),
        }
    }

    fn bundle_lifecycle(
        state_root: &Path,
        bundle_ref: &str,
        detailed: bool,
    ) -> Result<Value, String> {
        let prepared = PreparedGraph::load_persisted(state_root, bundle_ref)
            .map_err(|error| error.to_string())?;
        EmbeddedCompiler::inspect(&prepared).map_err(|error| error.to_string())?;

        let roots_dir = state_root.join("roots");
        let mut root_ids = Vec::new();
        match std::fs::symlink_metadata(&roots_dir) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("workflow roots store is not a real directory".into());
                }
                for (index, entry) in std::fs::read_dir(&roots_dir)
                    .map_err(|error| format!("cannot read workflow roots: {error}"))?
                    .enumerate()
                {
                    if index >= 4096 {
                        return Err("workflow roots store exceeds the bounded scan".into());
                    }
                    let entry =
                        entry.map_err(|error| format!("cannot read workflow root: {error}"))?;
                    let metadata = entry
                        .file_type()
                        .map_err(|error| format!("cannot inspect workflow root: {error}"))?;
                    let full = entry.path();
                    let bounded = std::fs::symlink_metadata(&full)
                        .map_err(|error| format!("cannot inspect workflow root: {error}"))?;
                    if metadata.is_symlink() || !metadata.is_file() || bounded.len() > 64 * 1024 {
                        return Err("workflow root receipt is not a bounded regular file".into());
                    }
                    let value: Value = serde_json::from_slice(
                        &std::fs::read(&full)
                            .map_err(|error| format!("cannot read workflow root: {error}"))?,
                    )
                    .map_err(|error| format!("workflow root receipt is malformed: {error}"))?;
                    if value.get("schema").and_then(Value::as_str)
                        != Some("aiko.graph-harness-root/v1")
                    {
                        return Err("workflow root receipt has an unknown schema".into());
                    }
                    if value.get("bundle_digest").and_then(Value::as_str)
                        == Some(prepared.bundle_digest.as_str())
                    {
                        if value.get("identity")
                            != serde_json::to_value(&prepared.identity).ok().as_ref()
                        {
                            return Err(
                                "workflow root receipt changed the prepared identity".into()
                            );
                        }
                        let root_id = value
                            .get("root_id")
                            .and_then(Value::as_str)
                            .filter(|id| {
                                !id.is_empty()
                                    && id.len() <= 128
                                    && id.bytes().all(|byte| {
                                        byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
                                    })
                            })
                            .ok_or_else(|| {
                                "workflow root receipt has an unsafe root id".to_owned()
                            })?;
                        root_ids.push(root_id.to_owned());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect workflow roots: {error}")),
        }
        root_ids.sort();
        root_ids.dedup();

        let admitted_path = state_root
            .join("admitted")
            .join(&prepared.identity.subject_digest);
        let admitted = match std::fs::symlink_metadata(&admitted_path) {
            Ok(_) => {
                let verifier =
                    contract_native::graph_harness::DeploymentVerifier::from_environment()
                        .map_err(|error| {
                            format!("admitted workflow cannot be authenticated: {error}")
                        })?;
                Some(
                    contract_native::graph_harness::load_admitted(
                        state_root, bundle_ref, &verifier,
                    )
                    .map_err(|error| {
                        format!("admitted workflow cannot be authenticated: {error}")
                    })?,
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("cannot inspect admitted workflow: {error}")),
        };
        let state = if admitted.is_some() {
            "admitted"
        } else if root_ids.is_empty() {
            "prepared"
        } else {
            "submitted"
        };
        let mut result = json!({
            "state": state,
            "bundle_ref": bundle_ref,
            "identity": prepared.identity,
            "bundle_digest": prepared.bundle_digest,
            "acceptance_profile": prepared.envelope.pointer("/package/metadata/labels/acceptance_profile"),
            "root_ids": root_ids,
            "reuse_policy": "contract_revalidation_no_admission_shortcut"
        });
        if detailed && let Some(admitted) = admitted {
            result["admission"] = json!({
                "authenticated": true,
                "owner": admitted.attestation.owner,
                "ledger_ref": admitted.attestation.ledger_ref,
                "key_id": admitted.attestation.authentication.key_id,
                "verdict_count": admitted.attestation.verdicts.len(),
            });
        }
        Ok(result)
    }

    fn submission_receipt(
        grounded: &contract_native::GroundedTurn,
        state_root: &Path,
    ) -> Result<Value, String> {
        let root_id = grounded
            .graph_root_id()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            })
            .ok_or_else(|| {
                "GraphHarness submission returned no safe Contract root id".to_owned()
            })?;
        let path = state_root.join("roots").join(format!("{root_id}.json"));
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot read Contract root receipt: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 64 * 1024 {
            return Err("Contract root receipt is not a bounded regular file".into());
        }
        let receipt: Value = serde_json::from_slice(
            &std::fs::read(&path)
                .map_err(|error| format!("cannot read Contract root receipt: {error}"))?,
        )
        .map_err(|error| format!("Contract root receipt is malformed: {error}"))?;
        let object = receipt
            .as_object()
            .ok_or_else(|| "Contract root receipt is not an object".to_owned())?;
        if object.get("schema").and_then(Value::as_str) != Some("aiko.graph-harness-root/v1")
            || object.get("root_id").and_then(Value::as_str) != Some(root_id)
        {
            return Err("Contract root receipt identity does not match the submitted root".into());
        }
        let bundle_digest = object
            .get("bundle_digest")
            .and_then(Value::as_str)
            .filter(|digest| {
                digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .ok_or_else(|| "Contract root receipt has no valid bundle digest".to_owned())?;
        let graph_digest = object
            .get("graph_digest")
            .and_then(Value::as_str)
            .filter(|digest| {
                digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .ok_or_else(|| "Contract root receipt has no valid graph digest".to_owned())?;
        let prepared = PreparedGraph::load_persisted(state_root, &format!("cas:{bundle_digest}"))
            .map_err(|error| format!("submitted bundle read-back failed: {error}"))?;
        EmbeddedCompiler::inspect(&prepared)
            .map_err(|error| format!("submitted bundle read-back failed: {error}"))?;
        if object.get("identity") != serde_json::to_value(&prepared.identity).ok().as_ref() {
            return Err("Contract root receipt changed the prepared identity".into());
        }
        Ok(json!({
            "state": "submitted",
            "owner": "contract_native",
            "root_id": root_id,
            "graph_digest": graph_digest,
            "bundle_ref": format!("cas:{bundle_digest}"),
            "identity": prepared.identity,
            "acceptance_profile": prepared.envelope.pointer("/package/metadata/labels/acceptance_profile"),
        }))
    }

    fn nonempty(value: Option<String>) -> Option<String> {
        value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
    }

    fn missing(operation: WorkflowOperation, field: &'static str) -> WorkflowOperationResponse {
        WorkflowOperationResponse::refuse(
            operation,
            "workflow_request_invalid",
            format!("missing non-empty {field}"),
        )
    }

    fn unsupported(
        operation: WorkflowOperation,
        detail: &'static str,
    ) -> WorkflowOperationResponse {
        WorkflowOperationResponse::refuse(operation, "workflow_operation_not_supported", detail)
    }

    fn route_reason(reason: RouteReason) -> &'static str {
        match reason {
            RouteReason::ExplicitWorkflow => "explicit_workflow",
            RouteReason::ReuseOrPublish => "reuse_or_publish",
            RouteReason::MoreThanOneLogicalNode => "more_than_one_logical_node",
            RouteReason::Dependency => "dependency",
            RouteReason::JoinOrIndependentJudge => "join_or_independent_judge",
            RouteReason::Generated => "generated",
            RouteReason::ScheduledOrDurable => "scheduled_or_durable",
            RouteReason::Reactive => "reactive",
            RouteReason::ExternalEffect => "external_effect",
            RouteReason::Recursive => "recursive",
            RouteReason::WorkflowCompatibilityFlag => "workflow_compatibility_flag",
            RouteReason::OpaqueOrHostComposition => "opaque_or_host_composition",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn workflow_route_is_versioned_and_has_no_authority_fields() {
            let response = execute(
                WorkflowOperationRequest {
                    api_version: API_VERSION.into(),
                    operation: WorkflowOperation::Route,
                    goal: Some("join two independently judged results".into()),
                    bundle_ref: None,
                    acceptance_mode: None,
                    query: None,
                },
                Path::new("."),
                "test",
                &[],
                Path::new("."),
            )
            .await;
            let value = serde_json::to_value(response).unwrap();
            assert_eq!(value["result"]["route"], "graph_harness_required");
        }

        #[tokio::test]
        async fn workflow_mcp_route_uses_the_same_machine_service() {
            let value = execute_mcp(
                "workflow_route",
                json!({"api_version": API_VERSION, "goal": "join two results"}),
                Path::new("."),
                "test",
                &[],
                Path::new("."),
            )
            .await;
            assert_eq!(value["result"]["route"], "graph_harness_required");
        }

        #[test]
        fn unknown_authority_field_is_refused_by_deserializer() {
            let error = serde_json::from_value::<WorkflowOperationRequest>(json!({
                "api_version": API_VERSION,
                "operation": "submit",
                "goal": "x",
                "signer": "/tmp/key"
            }))
            .unwrap_err();
            assert!(error.to_string().contains("unknown field"));
        }
    }
}
