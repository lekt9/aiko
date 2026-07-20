//! Contract-routed browser and Electron application tools.
//!
//! The underlying CDP transport, accessibility refs, and actions live in
//! Aiko's `xai-application-runtime` crate. No external browser automation
//! package, CLI, daemon, socket protocol, or MCP adapter is involved.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use xai_application_runtime::EmbeddedRuntime;

use crate::types::output::ToolOutput;
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::types::tool_io::ToolInput;
use crate::types::tool_metadata::shared_resources;

const OBSERVE_DESCRIPTION: &str = r#"Observe a browser or Electron application through its native CDP accessibility surface.

Use `attach` with a CDP URL or port for an already-running browser/Electron app, then `snapshot` to obtain stable accessibility refs. This tool is read-only and can inspect snapshots, DOM/application structure, React trees, text, tabs, console output, and the application's own HTTP/API request and response stream."#;

const ACT_DESCRIPTION: &str = r#"Act on a browser or Electron application through its native CDP accessibility surface.

Use refs returned by application_observe snapshots. Supports launching a browser, navigation, clicks, form entry, keyboard input, scrolling, tab changes, and evaluated calls into APIs exposed by an Electron preload. The runtime rejects commands outside Aiko's closed application capability surface, while execution permissions remain owned by Aiko and Contract."#;

static RUNTIME: OnceLock<Arc<EmbeddedRuntime>> = OnceLock::new();

fn runtime() -> &'static Arc<EmbeddedRuntime> {
    RUNTIME.get_or_init(|| Arc::new(EmbeddedRuntime::new()))
}

/// Prompt-scoped Contract decision installed by the shell before the first
/// model sample and consumed by the application dispatcher at execution time.
#[derive(Debug, Clone, Default)]
pub struct ApplicationCapabilityRoute {
    pub prompt_id: String,
    pub route: Option<Value>,
}

impl ApplicationCapabilityRoute {
    fn decision_for(&self, action: &str) -> Option<Value> {
        let cells = self.route.as_ref()?.get("cells")?.as_array()?;
        let capability = format!("application.{action}");
        let selected = cells
            .iter()
            .find(|cell| cell.get("id").and_then(Value::as_str) == Some(&capability))?;
        Some(serde_json::json!({
            "prompt_id": self.prompt_id,
            "selected": selected,
            "automatic": self.route.as_ref()?.get("automatic").cloned().unwrap_or(Value::Bool(false)),
            "confidence": self.route.as_ref()?.get("confidence").cloned().unwrap_or(Value::Null),
            "margin": self.route.as_ref()?.get("margin").cloned().unwrap_or(Value::Null),
            "local_evidence": self.route.as_ref()?.get("local_evidence").cloned().unwrap_or(Value::Null),
        }))
    }
}

fn response_succeeded(response: &Value) -> bool {
    response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn cdp_port_from_decision(decision: &Value) -> Option<u16> {
    let target = decision
        .get("local_evidence")?
        .get("cdp_targets")?
        .as_array()?
        .first()?
        .as_str()?;
    let authority = target.split_whitespace().next()?;
    authority
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse().ok())
}

fn application_from_decision(decision: Option<&Value>) -> Option<&str> {
    decision?
        .get("local_evidence")?
        .get("frontmost_application")?
        .as_str()
}

async fn routed_decision(ctx: &xai_tool_runtime::ToolCallContext, action: &str) -> Option<Value> {
    let resources = shared_resources(ctx).ok()?;
    let resources = resources.lock().await;
    let mut decision = resources
        .get::<ApplicationCapabilityRoute>()
        .and_then(|route| route.decision_for(action))?;
    drop(resources);

    let sequence = decision
        .get("selected")
        .and_then(|cell| cell.get("sequence"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requires_attach = action != "attach"
        && sequence
            .iter()
            .any(|step| step.as_str() == Some("application.attach"));
    let requires_snapshot = action != "snapshot"
        && sequence
            .iter()
            .any(|step| step.as_str() == Some("application.snapshot"));
    let mut prerequisites = Vec::new();

    if requires_attach {
        let session = runtime()
            .execute(Value::Object(command("session_info")))
            .await;
        if !response_succeeded(&session) {
            if let Some(port) = cdp_port_from_decision(&decision) {
                let mut attach = command("launch");
                attach.insert("cdpPort".into(), port.into());
                let response = runtime().execute(Value::Object(attach)).await;
                prerequisites.push(serde_json::json!({
                    "capability": "application.attach",
                    "automatic": true,
                    "success": response_succeeded(&response),
                }));
            }
        } else {
            prerequisites.push(serde_json::json!({
                "capability": "application.attach",
                "automatic": true,
                "success": true,
                "reused": true,
            }));
        }
    }
    if requires_snapshot {
        let response = runtime().execute(Value::Object(command("snapshot"))).await;
        prerequisites.push(serde_json::json!({
            "capability": "application.snapshot",
            "automatic": true,
            "success": response_succeeded(&response),
        }));
    }
    if let Some(object) = decision.as_object_mut() {
        object.insert("prerequisites".into(), Value::Array(prerequisites));
    }
    Some(decision)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObserveAction {
    Attach,
    Snapshot,
    Url,
    Title,
    Text,
    Attribute,
    Tabs,
    Console,
    Errors,
    SessionInfo,
    Inspect,
    ReactTree,
    Requests,
    RequestDetail,
    ResponseBody,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ApplicationObserveInput {
    /// Short statement of the user's current intent, used for learned routing.
    pub intent: String,
    pub action: ObserveAction,
    /// Stable application identity (bundle id or product name) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    /// CDP websocket/HTTP URL used by `attach`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
    /// CDP port used by `attach`, commonly 9222 for Electron.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_port: Option<u16>,
    /// Exact CDP page target id used by `attach` when an endpoint has multiple tabs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// Accessibility ref such as `e12`, used by text/attribute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<String>,
    /// Network request id for request_detail or response_body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Optional URL/resource filter for requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// Include interactive elements only in snapshots.
    #[serde(default)]
    pub interactive: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActAction {
    Launch,
    Navigate,
    Click,
    DoubleClick,
    Fill,
    Type,
    Press,
    Hover,
    Scroll,
    Select,
    Check,
    Uncheck,
    Back,
    Forward,
    Reload,
    NewTab,
    SwitchTab,
    CloseTab,
    Close,
    /// Execute JavaScript in the attached page/Electron renderer. This can
    /// call APIs intentionally exposed by the application's preload bridge.
    Evaluate,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ApplicationActInput {
    /// Short statement of the user's current intent, used for learned routing.
    pub intent: String,
    pub action: ActAction,
    /// Stable application identity (bundle id or product name) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Accessibility ref such as `e12`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// Text for fill/type, key for press, option for select, or tab id for switch_tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(default)]
    pub headed: bool,
    /// JavaScript expression for evaluate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
}

macro_rules! dynamic_io {
    ($ty:ty, $label:literal) => {
        impl TryFrom<ToolInput> for $ty {
            type Error = String;
            fn try_from(value: ToolInput) -> Result<Self, Self::Error> {
                match value {
                    ToolInput::Dynamic(v) => {
                        serde_json::from_value(v).map_err(|e| format!(concat!($label, ": {}"), e))
                    }
                    _ => Err(concat!("expected Dynamic input for ", $label).into()),
                }
            }
        }
        impl From<$ty> for ToolInput {
            fn from(value: $ty) -> Self {
                ToolInput::Dynamic(serde_json::to_value(value).expect("input serializes"))
            }
        }
    };
}

dynamic_io!(ApplicationObserveInput, "ApplicationObserveInput");
dynamic_io!(ApplicationActInput, "ApplicationActInput");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApplicationOutput {
    pub tool_output_for_prompt: String,
    pub success: bool,
    pub action: String,
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_route: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_outcome: Option<Value>,
}

impl xai_tool_runtime::ToolOutput for ApplicationOutput {}

impl From<ApplicationOutput> for ToolOutput {
    fn from(output: ApplicationOutput) -> Self {
        ToolOutput::Text(output.tool_output_for_prompt.into())
    }
}

fn command(action: &str) -> Map<String, Value> {
    let mut command = Map::new();
    command.insert("action".into(), Value::String(action.into()));
    command
}

fn output(
    action: &str,
    intent: &str,
    shape: Value,
    response: Value,
    capability_route: Option<Value>,
    application: Option<&str>,
    permission: &str,
    permission_outcome: &str,
    duration: Duration,
) -> ApplicationOutput {
    let success = response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let metadata = serde_json::json!({
        "application": application.unwrap_or("unknown"),
        "permission": permission,
        "permission_outcome": permission_outcome,
        "duration_ms": duration.as_millis().min(u128::from(u64::MAX)) as u64,
        "availability": "runtime_loaded",
        "result_schema": {
            "type": "object",
            "fields": ["success", "action", "data"]
        }
    });
    let contract_outcome = record_contract_outcome(intent, action, &shape, &metadata, success);
    ApplicationOutput {
        tool_output_for_prompt: serde_json::to_string_pretty(&response)
            .unwrap_or_else(|_| response.to_string()),
        success,
        action: action.to_owned(),
        data: response,
        capability_route,
        contract_outcome,
    }
}

fn contract_library_candidates() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("AIKO_CONTRACT_LIBRARY") {
        paths.push(path.into());
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(bin_dir) = executable.parent()
    {
        paths.push(bin_dir.join("../lib/libcontract.dylib"));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".aiko/lib/libcontract.dylib"));
    }
    paths.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../contract/libcontract/zig-out/lib/libcontract.dylib"),
    );
    paths
}

fn record_contract_outcome(
    intent: &str,
    action: &str,
    shape: &Value,
    metadata: &Value,
    success: bool,
) -> Option<Value> {
    use std::ffi::{CStr, CString, c_char};

    type RecordV2Fn = unsafe extern "C" fn(
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        bool,
    ) -> *mut c_char;
    type AbiVersionFn = unsafe extern "C" fn() -> u32;
    type FreeFn = unsafe extern "C" fn(*mut c_char);

    struct OutcomeAbi {
        _library: libloading::Library,
        record: RecordV2Fn,
        free: FreeFn,
    }

    fn outcome_abi() -> Option<&'static OutcomeAbi> {
        static ABI: OnceLock<Option<OutcomeAbi>> = OnceLock::new();
        ABI.get_or_init(|| {
            for path in contract_library_candidates() {
                // SAFETY: copied function pointers remain valid because the
                // owning library is retained in the process-global ABI.
                let Ok(library) = (unsafe { libloading::Library::new(path) }) else {
                    continue;
                };
                let Ok(abi_version) =
                    (unsafe { library.get::<AbiVersionFn>(b"contract_abi_version\0") })
                else {
                    continue;
                };
                if !(2..=3).contains(&unsafe { abi_version() }) {
                    continue;
                }
                let Ok(record) = (unsafe {
                    library.get::<RecordV2Fn>(b"contract_record_capability_outcome_v2\0")
                }) else {
                    continue;
                };
                let Ok(free) = (unsafe { library.get::<FreeFn>(b"contract_free\0") }) else {
                    continue;
                };
                return Some(OutcomeAbi {
                    record: *record,
                    free: *free,
                    _library: library,
                });
            }
            None
        })
        .as_ref()
    }

    let context = CString::new(intent).ok()?;
    let capability = CString::new(format!("application.{action}")).ok()?;
    let exemplar = CString::new(shape.to_string()).ok()?;
    let metadata = CString::new(metadata.to_string()).ok()?;
    let abi = outcome_abi()?;
    let ptr = unsafe {
        (abi.record)(
            context.as_ptr(),
            capability.as_ptr(),
            exemplar.as_ptr(),
            metadata.as_ptr(),
            success,
        )
    };
    if ptr.is_null() {
        return None;
    }
    let result = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { (abi.free)(ptr) };
    serde_json::from_str(&result).ok()
}

#[derive(Debug, Default)]
pub struct ApplicationObserveTool;

impl crate::types::tool_metadata::ToolMetadata for ApplicationObserveTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }
    fn description_template(&self) -> &str {
        OBSERVE_DESCRIPTION
    }
}

impl xai_tool_runtime::Tool for ApplicationObserveTool {
    type Args = ApplicationObserveInput;
    type Output = ApplicationOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("application_observe").expect("valid tool id")
    }

    fn description(
        &self,
        _: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new("application_observe", OBSERVE_DESCRIPTION)
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: Self::Args,
    ) -> Result<Self::Output, xai_tool_runtime::ToolError> {
        let (action, runtime_action) = match input.action {
            ObserveAction::Attach => ("attach", "launch"),
            ObserveAction::Snapshot => ("snapshot", "snapshot"),
            ObserveAction::Url => ("url", "url"),
            ObserveAction::Title => ("title", "title"),
            ObserveAction::Text => ("text", "gettext"),
            ObserveAction::Attribute => ("attribute", "getattribute"),
            ObserveAction::Tabs => ("tabs", "tab_list"),
            ObserveAction::Console => ("console", "console"),
            ObserveAction::Errors => ("errors", "errors"),
            ObserveAction::SessionInfo => ("session_info", "session_info"),
            ObserveAction::Inspect => ("inspect", "inspect"),
            ObserveAction::ReactTree => ("react_tree", "react_tree"),
            ObserveAction::Requests => ("requests", "requests"),
            ObserveAction::RequestDetail => ("request_detail", "request_detail"),
            ObserveAction::ResponseBody => ("response_body", "responsebody"),
        };
        let mut cmd = command(runtime_action);
        let capability_route = routed_decision(&ctx, action).await;
        let routed_application =
            application_from_decision(capability_route.as_ref()).map(str::to_owned);
        let started = Instant::now();
        let shape = serde_json::json!({
            "action": action,
            "has_cdp_url": input.cdp_url.is_some(),
            "has_cdp_port": input.cdp_port.is_some(),
            "has_target_id": input.target_id.is_some(),
            "has_ref": input.reference.is_some(),
            "has_request_id": input.request_id.is_some(),
            "has_filter": input.filter.is_some(),
            "interactive": input.interactive,
        });
        if let Some(v) = input.cdp_url {
            cmd.insert("cdpUrl".into(), v.into());
        }
        if let Some(v) = input.cdp_port {
            cmd.insert("cdpPort".into(), v.into());
        } else if runtime_action == "launch"
            && let Some(port) = capability_route.as_ref().and_then(cdp_port_from_decision)
        {
            cmd.insert("cdpPort".into(), port.into());
        }
        if let Some(v) = input.target_id {
            cmd.insert("targetId".into(), v.into());
        }
        if let Some(v) = input.reference {
            cmd.insert("selector".into(), v.into());
        }
        if let Some(v) = input.attribute {
            cmd.insert("attribute".into(), v.into());
        }
        if let Some(v) = input.request_id {
            cmd.insert("requestId".into(), v.into());
        }
        if let Some(v) = input.filter {
            cmd.insert("filter".into(), v.into());
        }
        if input.interactive {
            cmd.insert("interactive".into(), true.into());
        }
        let response = runtime().execute(Value::Object(cmd)).await;
        Ok(output(
            action,
            &input.intent,
            shape,
            response,
            capability_route,
            input
                .application
                .as_deref()
                .or(routed_application.as_deref()),
            "read",
            "not_required",
            started.elapsed(),
        ))
    }
}

#[derive(Debug, Default)]
pub struct ApplicationActTool;

impl crate::types::tool_metadata::ToolMetadata for ApplicationActTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Execute
    }
    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }
    fn description_template(&self) -> &str {
        ACT_DESCRIPTION
    }
}

impl xai_tool_runtime::Tool for ApplicationActTool {
    type Args = ApplicationActInput;
    type Output = ApplicationOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("application_act").expect("valid tool id")
    }

    fn description(
        &self,
        _: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new("application_act", ACT_DESCRIPTION)
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: Self::Args,
    ) -> Result<Self::Output, xai_tool_runtime::ToolError> {
        let (action, runtime_action) = match input.action {
            ActAction::Launch => ("launch", "launch"),
            ActAction::Navigate => ("navigate", "navigate"),
            ActAction::Click => ("click", "click"),
            ActAction::DoubleClick => ("double_click", "dblclick"),
            ActAction::Fill => ("fill", "fill"),
            ActAction::Type => ("type", "type"),
            ActAction::Press => ("press", "press"),
            ActAction::Hover => ("hover", "hover"),
            ActAction::Scroll => ("scroll", "scroll"),
            ActAction::Select => ("select", "select"),
            ActAction::Check => ("check", "check"),
            ActAction::Uncheck => ("uncheck", "uncheck"),
            ActAction::Back => ("back", "back"),
            ActAction::Forward => ("forward", "forward"),
            ActAction::Reload => ("reload", "reload"),
            ActAction::NewTab => ("new_tab", "tab_new"),
            ActAction::SwitchTab => ("switch_tab", "tab_switch"),
            ActAction::CloseTab => ("close_tab", "tab_close"),
            ActAction::Close => ("close", "close"),
            ActAction::Evaluate => ("evaluate", "evaluate"),
        };
        let capability_route = routed_decision(&ctx, action).await;
        let routed_application =
            application_from_decision(capability_route.as_ref()).map(str::to_owned);
        let started = Instant::now();
        let shape = serde_json::json!({
            "action": action,
            "has_url": input.url.is_some(),
            "has_ref": input.reference.is_some(),
            "has_value": input.value.is_some(),
            "has_direction": input.direction.is_some(),
            "has_amount": input.amount.is_some(),
            "headed": input.headed,
            "has_expression": input.expression.is_some(),
        });
        let mut cmd = command(runtime_action);
        if let Some(v) = input.url {
            cmd.insert("url".into(), v.into());
        }
        if let Some(v) = input.reference {
            cmd.insert("selector".into(), v.into());
        }
        if let Some(v) = input.value {
            let key = match runtime_action {
                "press" => "key",
                "tab_switch" | "tab_close" => "target",
                "select" => "values",
                _ => "value",
            };
            let value = if runtime_action == "select" {
                Value::Array(vec![v.into()])
            } else {
                v.into()
            };
            cmd.insert(key.into(), value);
        }
        if let Some(v) = input.direction {
            cmd.insert("direction".into(), v.into());
        }
        if let Some(v) = input.amount {
            cmd.insert("amount".into(), v.into());
        }
        if input.headed {
            cmd.insert("headed".into(), true.into());
        }
        if let Some(v) = input.expression {
            cmd.insert("script".into(), v.into());
        }
        let response = runtime().execute(Value::Object(cmd)).await;
        Ok(output(
            action,
            &input.intent,
            shape,
            response,
            capability_route,
            input
                .application
                .as_deref()
                .or(routed_application.as_deref()),
            "write",
            "approved",
            started.elapsed(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_scoped_route_selects_the_exact_typed_cell() {
        let route = ApplicationCapabilityRoute {
            prompt_id: "p-1".into(),
            route: Some(serde_json::json!({
                "automatic": true,
                "confidence": 0.93,
                "margin": 0.21,
                "local_evidence": {"cdp_targets": ["127.0.0.1:9222 (Chrome)"]},
                "cells": [{
                    "id": "application.click",
                    "sequence": [
                        "application.attach",
                        "application.snapshot",
                        "application.click"
                    ]
                }]
            })),
        };
        let decision = route.decision_for("click").expect("click is routed");
        assert_eq!(decision["prompt_id"], "p-1");
        assert_eq!(decision["selected"]["sequence"][1], "application.snapshot");
        assert!(route.decision_for("fill").is_none());
        assert_eq!(cdp_port_from_decision(&decision), Some(9222));
    }
}
