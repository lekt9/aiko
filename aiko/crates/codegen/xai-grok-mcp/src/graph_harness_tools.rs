//! Stable MCP catalog for Aiko's embedded GraphHarness service.
//!
//! This crate owns MCP transport but not workflow authority. A host binds
//! [`dispatch`] to `xai_grok_shell::graph_harness_service::execute`; the tools
//! never accept verifier, signer, Cell paths, state roots, or rollout policy.

use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc};

use rmcp::{
    ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, ContentBlock, ErrorData, JsonObject,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
    },
};
use serde_json::{Value, json};

pub const API_VERSION: &str = "aiko.workflow/v1";
pub const SERVER_NAME: &str = "aiko_workflow";

#[derive(Debug, Clone, PartialEq)]
pub struct GraphHarnessToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub read_only: bool,
}

/// The implemented versioned operations exposed by the native Aiko MCP server.
pub fn tool_catalog() -> Vec<GraphHarnessToolSpec> {
    vec![
        spec(
            "workflow_route",
            "Classify an explicit workflow for the GraphHarness main path",
            "goal",
            true,
        ),
        submit_spec(),
        spec(
            "workflow_status",
            "Read the validated state of a persisted workflow bundle",
            "bundle_ref",
            true,
        ),
        spec(
            "workflow_inspect",
            "Inspect and revalidate a persisted workflow bundle",
            "bundle_ref",
            true,
        ),
    ]
}

fn submit_spec() -> GraphHarnessToolSpec {
    GraphHarnessToolSpec {
        name: "workflow_submit",
        description: "Submit a new workflow or re-evaluate an immutable prepared bundle through fresh Contract occurrences",
        input_schema: json!({
            "type":"object",
            "additionalProperties":false,
            "properties":{
                "api_version":{"type":"string","const":API_VERSION},
                "goal":{"type":"string","minLength":1},
                "acceptance_mode":{"type":"string","const":"subjective-independent-edge-review/v1"},
                "bundle_ref":{"type":"string","pattern":"^cas:[0-9a-f]{64}$"}
            },
            "required":["api_version","goal","acceptance_mode"]
        }),
        read_only: false,
    }
}

fn spec(
    name: &'static str,
    description: &'static str,
    field: &'static str,
    read_only: bool,
) -> GraphHarnessToolSpec {
    GraphHarnessToolSpec {
        name,
        description,
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "api_version": {"type": "string", "const": API_VERSION},
                field: {"type": "string", "minLength": 1}
            },
            "required": ["api_version", field]
        }),
        read_only,
    }
}

/// Validate an MCP call and translate it into the one machine-service request
/// shape consumed by the shell. The supplied callback is the only execution
/// seam; this module does not validate, schedule, sign, or subprocess.
pub async fn dispatch<F, Fut>(tool_name: &str, input: Value, service: F) -> Value
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let Some(_spec) = tool_catalog()
        .into_iter()
        .find(|spec| spec.name == tool_name)
    else {
        return error(
            "workflow_tool_unknown",
            format!("unknown GraphHarness tool {tool_name}"),
        );
    };
    let Some(object) = input.as_object() else {
        return error("workflow_request_invalid", "tool input must be an object");
    };
    let operation = tool_name
        .strip_prefix("workflow_")
        .expect("catalog invariant");
    let field = match operation {
        "route" | "prepare" | "submit" => "goal",
        "status" | "inspect" => "bundle_ref",
        "find" => "query",
        _ => {
            return error(
                "workflow_tool_unknown",
                "catalog operation is not dispatchable",
            );
        }
    };
    let allowed = if operation == "submit" {
        vec!["api_version", "goal", "acceptance_mode", "bundle_ref"]
    } else {
        vec!["api_version", field]
    };
    if let Some(name) = object.keys().find(|name| !allowed.contains(&name.as_str())) {
        return error("workflow_request_invalid", format!("unknown field {name}"));
    }
    if object.get("api_version").and_then(Value::as_str) != Some(API_VERSION) {
        return error(
            "workflow_api_version_unsupported",
            format!("expected {API_VERSION}"),
        );
    }
    let Some(value) = object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return error(
            "workflow_request_invalid",
            format!("missing non-empty {field}"),
        );
    };
    let mut machine_request = json!({
        "api_version": API_VERSION,
        "operation": operation,
        field: value
    });
    if operation == "submit" {
        let Some(acceptance_mode) = object.get("acceptance_mode").and_then(Value::as_str) else {
            return error("workflow_request_invalid", "missing acceptance_mode");
        };
        if acceptance_mode != "subjective-independent-edge-review/v1" {
            return error(
                "workflow_acceptance_profile_unsupported",
                "objective workflows require an admitted bounded acceptance profile",
            );
        }
        machine_request["acceptance_mode"] = Value::String(acceptance_mode.to_owned());
    }
    if operation == "submit"
        && let Some(bundle_ref) = object.get("bundle_ref")
    {
        let Some(bundle_ref) = bundle_ref.as_str().map(str::trim).filter(|value| {
            value.strip_prefix("cas:").is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            })
        }) else {
            return error(
                "workflow_request_invalid",
                "bundle_ref must be cas:<lowercase-sha256>",
            );
        };
        machine_request["bundle_ref"] = Value::String(bundle_ref.to_owned());
    }
    service(machine_request).await
}

fn error(code: &'static str, message: impl Into<String>) -> Value {
    json!({
        "api_version": API_VERSION,
        "ok": false,
        "error": {"code": code, "message": message.into(), "retryable": false}
    })
}

/// The callback installed by the shell composition root.  It owns cwd,
/// identity, conversation, Contract state, and every deployment authority.
pub type GraphHarnessService =
    Arc<dyn Fn(&str, Value) -> Pin<Box<dyn Future<Output = Value> + Send + 'static>> + Send + Sync>;

/// Production MCP server for the embedded Aiko workflow namespace.
///
/// This is intentionally a real `rmcp::ServerHandler`, not a catalog helper.
/// Its `tools/list` and `tools/call` methods both traverse the same registry,
/// and the only call seam is the shell-bound GraphHarness service callback.
#[derive(Clone)]
pub struct GraphHarnessMcpServer {
    tools: Arc<Vec<Tool>>,
    service: GraphHarnessService,
}

impl GraphHarnessMcpServer {
    pub fn new(service: GraphHarnessService) -> Self {
        let tools = tool_catalog()
            .into_iter()
            .map(|spec| {
                let schema: JsonObject = serde_json::from_value(spec.input_schema)
                    .expect("GraphHarness catalog schemas are objects");
                let mut tool = Tool::new(
                    Cow::Borrowed(spec.name),
                    Cow::Borrowed(spec.description),
                    Arc::new(schema),
                );
                let mut annotations = rmcp::model::ToolAnnotations::default();
                annotations.read_only_hint = Some(spec.read_only);
                tool.annotations = Some(annotations);
                tool
            })
            .collect();
        Self {
            tools: Arc::new(tools),
            service,
        }
    }

    async fn invoke(&self, request: CallToolRequestParams) -> Result<CallToolResult, ErrorData> {
        if !self.tools.iter().any(|tool| tool.name == request.name) {
            return Err(ErrorData::invalid_params(
                format!("unknown Aiko workflow tool {}", request.name),
                None,
            ));
        }
        let input = Value::Object(request.arguments.unwrap_or_default());
        let output = (self.service)(request.name.as_ref(), input).await;
        let encoded = serde_json::to_string(&output).map_err(|error| {
            ErrorData::internal_error(
                format!("could not encode Aiko workflow response: {error}"),
                None,
            )
        })?;
        Ok(CallToolResult::success(vec![ContentBlock::text(encoded)]))
    }
}

impl ServerHandler for GraphHarnessMcpServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info.name = SERVER_NAME.to_owned();
        info.server_info.version = API_VERSION.to_owned();
        info
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        let tools = self.tools.clone();
        async move {
            Ok(ListToolsResult {
                tools: (*tools).clone(),
                next_cursor: None,
                meta: None,
            })
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.invoke(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_public_operations_and_has_closed_schemas() {
        let catalog = tool_catalog();
        assert_eq!(catalog.len(), 4);
        assert_eq!(
            catalog.iter().map(|s| s.name).collect::<Vec<_>>(),
            vec![
                "workflow_route",
                "workflow_submit",
                "workflow_status",
                "workflow_inspect"
            ]
        );
        for tool in catalog {
            assert_eq!(tool.input_schema["additionalProperties"], false);
            let text = tool.input_schema.to_string();
            for forbidden in [
                "verifier",
                "signer",
                "cell_path",
                "state_root",
                "rollout",
                "legacy",
            ] {
                assert!(!text.contains(forbidden));
            }
        }
    }

    #[tokio::test]
    async fn dispatch_rejects_request_selected_authority_before_service() {
        let output = dispatch(
            "workflow_submit",
            json!({"api_version": API_VERSION, "goal": "x", "signer": "/tmp/key"}),
            |_| async { panic!("invalid input reached service") },
        )
        .await;
        assert_eq!(output["error"]["code"], "workflow_request_invalid");
    }

    #[tokio::test]
    async fn all_tools_converge_on_one_service_request_shape() {
        for (tool, field) in [
            ("workflow_route", "goal"),
            ("workflow_submit", "goal"),
            ("workflow_status", "bundle_ref"),
            ("workflow_inspect", "bundle_ref"),
        ] {
            let mut input = json!({"api_version": API_VERSION, field: "value"});
            if tool == "workflow_submit" {
                input["acceptance_mode"] =
                    Value::String("subjective-independent-edge-review/v1".into());
            }
            let output = dispatch(tool, input, |request| async move { request }).await;
            assert_eq!(output["api_version"], API_VERSION);
            assert_eq!(output["operation"], tool.trim_start_matches("workflow_"));
        }
    }

    #[tokio::test]
    async fn production_server_registry_calls_bound_service_and_refuses_authority() {
        use rmcp::model::CallToolRequestParams;

        let server = GraphHarnessMcpServer::new(Arc::new(|tool, input| {
            let tool = tool.to_owned();
            Box::pin(async move {
                let response_tool = tool.clone();
                dispatch(&tool, input, |request| async move {
                    json!({"tool": response_tool, "input": request})
                })
                .await
            })
        }));
        assert_eq!(server.tools.len(), 4);
        assert_eq!(server.tools[0].name.as_ref(), "workflow_route");

        let called = server
            .invoke(
                CallToolRequestParams::new("workflow_route").with_arguments(
                    json!({"api_version": API_VERSION, "goal": "join results"})
                        .as_object()
                        .cloned()
                        .unwrap(),
                ),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_str(&called.content[0].as_text().unwrap().text).unwrap();
        assert_eq!(value["tool"], "workflow_route");

        let refused = server
            .invoke(
                CallToolRequestParams::new("workflow_submit").with_arguments(
                    json!({"api_version": API_VERSION, "goal": "x", "signer": "/tmp/key"})
                        .as_object()
                        .cloned()
                        .unwrap(),
                ),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_str(&refused.content[0].as_text().unwrap().text).unwrap();
        assert_eq!(value["error"]["code"], "workflow_request_invalid");
    }

    #[tokio::test]
    async fn rmcp_transport_lists_and_calls_production_server() {
        use rmcp::{
            ServiceExt,
            model::{CallToolRequestParams, PaginatedRequestParams},
        };

        let server = GraphHarnessMcpServer::new(Arc::new(|tool, input| {
            let tool = tool.to_owned();
            Box::pin(async move { dispatch(&tool, input, |request| async move { request }).await })
        }));
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(async move {
            server
                .serve(server_io)
                .await
                .expect("server handshake")
                .waiting()
                .await
                .expect("server transport task");
        });
        let client = ().serve(client_io).await.expect("client handshake");

        let listed = client
            .list_tools(Some(PaginatedRequestParams::default()))
            .await
            .expect("tools/list");
        assert_eq!(
            listed
                .tools
                .iter()
                .map(|tool| tool.name.as_ref())
                .collect::<Vec<_>>(),
            vec![
                "workflow_route",
                "workflow_submit",
                "workflow_status",
                "workflow_inspect"
            ]
        );

        let called = client
            .call_tool(
                CallToolRequestParams::new("workflow_route").with_arguments(
                    json!({"api_version": API_VERSION, "goal": "join results"})
                        .as_object()
                        .cloned()
                        .unwrap(),
                ),
            )
            .await
            .expect("tools/call");
        let response: Value =
            serde_json::from_str(&called.content[0].as_text().expect("JSON text").text).unwrap();
        assert_eq!(response["operation"], "route");
        assert_eq!(response["goal"], "join results");

        client.cancel().await.expect("client cancel");
        server_task.await.expect("server task join");
    }
}

// -- Admitted AikoAgent capability lifecycle ---------------------------------

pub const ADMITTED_TOOL_API_VERSION: &str = "aiko.admitted-tools/v1";

/// Public MCP projection of the AikoAgent capability protocol. Authority facts
/// are deliberately absent: the authenticated shell composition root supplies
/// current Contract and credential projections on every call.
pub fn admitted_tool_catalog() -> Vec<GraphHarnessToolSpec> {
    let identity = || {
        json!({
            "api_version":{"const":ADMITTED_TOOL_API_VERSION},
            "name":{"type":"string","minLength":1},
            "digest":{"type":"string","pattern":"^[0-9a-f]{64}$"}
        })
    };
    let closed = |properties: Value, required: Vec<&str>| json!({"type":"object","additionalProperties":false,"properties":properties,"required":required});
    vec![
        GraphHarnessToolSpec {
            name: "capability_list",
            description: "List generated package bytes inert under their SHA-256 identity",
            input_schema: closed(
                {
                    let mut p = identity();
                    p.as_object_mut().unwrap().insert("package_bytes".into(),json!({"type":"array","items":{"type":"integer","minimum":0,"maximum":255},"minItems":1}));
                    p
                },
                vec!["api_version", "name", "digest", "package_bytes"],
            ),
            read_only: false,
        },
        GraphHarnessToolSpec {
            name: "capability_admit",
            description: "Admit the currently listed package digest",
            input_schema: closed(identity(), vec!["api_version", "name", "digest"]),
            read_only: false,
        },
        GraphHarnessToolSpec {
            name: "capability_attach",
            description: "Attach an admitted package to an explicit attenuated grant",
            input_schema: closed(
                {
                    let mut p = identity();
                    p.as_object_mut().unwrap().insert("grant".into(),json!({"type":"object","additionalProperties":false,"properties":{"subject":{"type":"string","minLength":1},"tenant":{"type":"string","minLength":1},"effect":{"type":"string","minLength":1},"resource_prefix":{"type":"string","minLength":1},"credential_audience":{"type":"string","minLength":1},"credential_generation":{"type":"integer","minimum":1}},"required":["subject","tenant","effect","resource_prefix","credential_audience","credential_generation"]}));
                    p
                },
                vec!["api_version", "name", "digest", "grant"],
            ),
            read_only: false,
        },
        GraphHarnessToolSpec {
            name: "capability_use",
            description: "Claim and immediately dispatch an attached capability under fresh authority",
            input_schema: closed(
                {
                    let mut p = identity();
                    for (k, v) in [
                        ("effect", json!({"type":"string","minLength":1})),
                        ("resource", json!({"type":"string","minLength":1})),
                        ("cost", json!({"type":"integer","minimum":0})),
                    ] {
                        p.as_object_mut().unwrap().insert(k.into(), v);
                    }
                    p
                },
                vec![
                    "api_version",
                    "name",
                    "digest",
                    "effect",
                    "resource",
                    "cost",
                ],
            ),
            read_only: false,
        },
        GraphHarnessToolSpec {
            name: "capability_revoke",
            description: "Revoke a package and advance its revocation generation",
            input_schema: closed(identity(), vec!["api_version", "name", "digest"]),
            read_only: false,
        },
        GraphHarnessToolSpec {
            name: "capability_detach",
            description: "Detach a revoked package and advance its attachment generation",
            input_schema: closed(identity(), vec!["api_version", "name", "digest"]),
            read_only: false,
        },
        GraphHarnessToolSpec {
            name: "capability_collect",
            description: "Collect detached revoked package bytes",
            input_schema: closed(identity(), vec!["api_version", "name", "digest"]),
            read_only: false,
        },
    ]
}

pub async fn dispatch_admitted_tool<F, Fut>(tool_name: &str, input: Value, service: F) -> Value
where
    F: FnOnce(&str, Value) -> Fut,
    Fut: Future<Output = Value>,
{
    let Some(spec) = admitted_tool_catalog()
        .into_iter()
        .find(|s| s.name == tool_name)
    else {
        return json!({"api_version":ADMITTED_TOOL_API_VERSION,"ok":false,"error":{"code":"capability_unlisted","message":"unknown or unlisted capability operation"}});
    };
    let Some(object) = input.as_object() else {
        return json!({"api_version":ADMITTED_TOOL_API_VERSION,"ok":false,"error":{"code":"invalid_request","message":"tool input must be an object"}});
    };
    if object.get("api_version").and_then(Value::as_str) != Some(ADMITTED_TOOL_API_VERSION) {
        return json!({"api_version":ADMITTED_TOOL_API_VERSION,"ok":false,"error":{"code":"invalid_request","message":"unsupported api_version"}});
    }
    let allowed = spec.input_schema["properties"].as_object().expect("schema");
    if object.keys().any(|k| !allowed.contains_key(k)) {
        return json!({"api_version":ADMITTED_TOOL_API_VERSION,"ok":false,"error":{"code":"invalid_request","message":"unknown request field"}});
    }
    service(tool_name, input).await
}

pub type AdmittedCapabilityService =
    Arc<dyn Fn(&str, Value) -> Pin<Box<dyn Future<Output = Value> + Send + 'static>> + Send + Sync>;

#[derive(Clone)]
pub struct AdmittedCapabilityMcpServer {
    tools: Arc<Vec<Tool>>,
    service: AdmittedCapabilityService,
}
impl AdmittedCapabilityMcpServer {
    pub fn new(service: AdmittedCapabilityService) -> Self {
        let tools = admitted_tool_catalog()
            .into_iter()
            .map(|s| {
                let schema: JsonObject =
                    serde_json::from_value(s.input_schema).expect("object schema");
                Tool::new(
                    Cow::Borrowed(s.name),
                    Cow::Borrowed(s.description),
                    Arc::new(schema),
                )
            })
            .collect();
        Self {
            tools: Arc::new(tools),
            service,
        }
    }
    async fn invoke_admitted(
        &self,
        request: CallToolRequestParams,
    ) -> Result<CallToolResult, ErrorData> {
        if !self.tools.iter().any(|t| t.name == request.name) {
            return Err(ErrorData::invalid_params(
                "unlisted capability operation",
                None,
            ));
        }
        let input = Value::Object(request.arguments.unwrap_or_default());
        let value = dispatch_admitted_tool(request.name.as_ref(), input, |name, input| {
            (self.service)(name, input)
        })
        .await;
        let encoded = serde_json::to_string(&value)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(encoded)]))
    }
}
impl ServerHandler for AdmittedCapabilityMcpServer {
    fn get_info(&self) -> ServerInfo {
        let mut i = ServerInfo::default();
        i.capabilities = ServerCapabilities::builder().enable_tools().build();
        i.server_info.name = "aiko_admitted_capabilities".into();
        i.server_info.version = ADMITTED_TOOL_API_VERSION.into();
        i
    }
    fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        let tools = self.tools.clone();
        async move {
            Ok(ListToolsResult {
                tools: (*tools).clone(),
                next_cursor: None,
                meta: None,
            })
        }
    }
    async fn call_tool(
        &self,
        r: CallToolRequestParams,
        _: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.invoke_admitted(r).await
    }
}

#[cfg(test)]
mod admitted_tests {
    use super::*;
    #[test]
    fn seven_lifecycle_calls_are_public_and_authority_is_not_payload() {
        let c = admitted_tool_catalog();
        assert_eq!(
            c.iter().map(|s| s.name).collect::<Vec<_>>(),
            vec![
                "capability_list",
                "capability_admit",
                "capability_attach",
                "capability_use",
                "capability_revoke",
                "capability_detach",
                "capability_collect"
            ]
        );
        for s in c {
            assert_eq!(s.input_schema["additionalProperties"], false);
            let text = s.input_schema.to_string();
            for forbidden in [
                "lease_fence",
                "remaining_budget",
                "subject_verified",
                "tenant_verified",
                "home",
                "env",
            ] {
                assert!(!text.contains(forbidden));
            }
        }
    }
    #[tokio::test]
    async fn unknown_direct_call_refuses_before_service() {
        let v =
            dispatch_admitted_tool("capability_direct", json!({}), |_, _| async { panic!() }).await;
        assert_eq!(v["error"]["code"], "capability_unlisted");
    }
}
