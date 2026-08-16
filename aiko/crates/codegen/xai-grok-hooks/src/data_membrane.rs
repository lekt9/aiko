//! Default-deny data boundary for compatibility hooks.
//!
//! These hooks are observers; this membrane deliberately does not make them a Contract authority
//! or effect choke point. Critical projection belongs to the synchronous, fail-closed Contract path.

use crate::event::{HookEventEnvelope, HookPayload};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default)]
pub struct HookDataPolicy {
    capabilities: BTreeSet<String>,
}

impl HookDataPolicy {
    /// Parse an explicit, comma-separated capability declaration. Unknown
    /// capabilities grant nothing. Hook declarations use the reserved
    /// `GROK_HOOK_DATA_CAPABILITIES` setting; it is never forwarded to a child.
    pub fn parse(value: Option<&str>) -> Self {
        Self {
            capabilities: value
                .into_iter()
                .flat_map(|s| s.split(','))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        }
    }
    pub fn allows(&self, capability: &str) -> bool {
        self.capabilities.contains(capability)
    }
    pub fn allows_env(&self, name: &str) -> bool {
        self.allows("env:*") || self.allows(&format!("env:{name}"))
    }
    pub fn allows_http_host(&self, host: &str) -> bool {
        self.allows("http:*") || self.allows(&format!("http:{host}"))
    }
}

pub const CAPABILITY_ENV: &str = "GROK_HOOK_DATA_CAPABILITIES";

/// Construct the only JSON that may cross an arbitrary hook boundary. The
/// baseline is identifiers and bounded operational metadata, never prose or
/// model/tool payloads. Sensitive fields require separate capabilities.
pub fn minimize_envelope(envelope: &HookEventEnvelope, policy: &HookDataPolicy) -> Value {
    let mut out = Map::new();
    out.insert(
        "hookEventName".into(),
        Value::String(envelope.hook_event_name.to_string()),
    );
    out.insert(
        "sessionId".into(),
        Value::String(envelope.session_id.clone()),
    );
    out.insert(
        "timestamp".into(),
        Value::String(envelope.timestamp.clone()),
    );
    if let Some(v) = &envelope.client_identifier {
        out.insert("clientIdentifier".into(), Value::String(v.clone()));
    }
    if let Some(v) = &envelope.prompt_id {
        out.insert("promptId".into(), Value::String(v.clone()));
    }
    // Paths are narrative, not authority, and reveal host/tenant layout.
    if policy.allows("path:workspace") {
        out.insert("cwd".into(), Value::String(envelope.cwd.clone()));
        out.insert(
            "workspaceRoot".into(),
            Value::String(envelope.workspace_root.clone()),
        );
    }
    if policy.allows("path:transcript") {
        if let Some(v) = &envelope.transcript_path {
            out.insert("transcriptPath".into(), Value::String(v.clone()));
        }
    }
    let mut field = |name: &str, value: Value| {
        out.insert(name.into(), value);
    };
    match &envelope.payload {
        HookPayload::SessionStart {
            source,
            model_id,
            agent_type,
        } => {
            field("source", Value::String(source.clone()));
            if let Some(v) = model_id {
                field("modelId", Value::String(v.clone()));
            }
            if let Some(v) = agent_type {
                field("agentType", Value::String(v.clone()));
            }
        }
        HookPayload::SessionEnd {
            reason: _,
            turn_count,
            tool_call_count,
        } => {
            if let Some(v) = turn_count {
                field("turnCount", (*v).into());
            }
            if let Some(v) = tool_call_count {
                field("toolCallCount", (*v).into());
            }
        }
        HookPayload::Stop { .. } | HookPayload::StopFailure { .. } => {}
        HookPayload::PreToolUse {
            tool_name,
            tool_use_id,
            tool_input,
            tool_input_truncated,
            permission_mode,
            subagent_type,
        } => {
            field("toolName", Value::String(tool_name.clone()));
            field("toolUseId", Value::String(tool_use_id.clone()));
            field("toolInputTruncated", Value::Bool(*tool_input_truncated));
            if let Some(v) = permission_mode {
                field("permissionMode", Value::String(v.clone()));
            }
            if let Some(v) = subagent_type {
                field("subagentType", Value::String(v.clone()));
            }
            if policy.allows("payload:tool_input") {
                field("toolInput", redact_value(tool_input.clone(), policy));
            }
        }
        HookPayload::PostToolUse {
            tool_name,
            tool_use_id,
            tool_input,
            tool_result,
            tool_input_truncated,
            tool_result_truncated,
            duration_ms,
            is_backgrounded,
            subagent_type,
        } => {
            field("toolName", Value::String(tool_name.clone()));
            field("toolUseId", Value::String(tool_use_id.clone()));
            field("toolInputTruncated", Value::Bool(*tool_input_truncated));
            field("toolResultTruncated", Value::Bool(*tool_result_truncated));
            field("isBackgrounded", Value::Bool(*is_backgrounded));
            if let Some(v) = duration_ms {
                field("durationMs", (*v).into());
            }
            if let Some(v) = subagent_type {
                field("subagentType", Value::String(v.clone()));
            }
            if policy.allows("payload:tool_input") {
                field("toolInput", redact_value(tool_input.clone(), policy));
            }
            if policy.allows("payload:tool_result") {
                field("toolResult", redact_value(tool_result.clone(), policy));
            }
        }
        HookPayload::PostToolUseFailure {
            tool_name,
            tool_use_id,
            tool_input,
            tool_input_truncated,
            subagent_type,
            ..
        } => {
            field("toolName", Value::String(tool_name.clone()));
            field("toolUseId", Value::String(tool_use_id.clone()));
            field("toolInputTruncated", Value::Bool(*tool_input_truncated));
            if let Some(v) = subagent_type {
                field("subagentType", Value::String(v.clone()));
            }
            if policy.allows("payload:tool_input") {
                field("toolInput", redact_value(tool_input.clone(), policy));
            }
        }
        HookPayload::PermissionDenied {
            tool_name,
            tool_use_id,
            tool_input,
            tool_input_truncated,
        } => {
            field("toolName", Value::String(tool_name.clone()));
            field("toolUseId", Value::String(tool_use_id.clone()));
            field("toolInputTruncated", Value::Bool(*tool_input_truncated));
            if policy.allows("payload:tool_input") {
                field("toolInput", redact_value(tool_input.clone(), policy));
            }
        }
        HookPayload::UserPromptSubmit { prompt } => {
            if policy.allows("payload:prompt") {
                if let Some(v) = prompt {
                    field("prompt", Value::String(redact_text(v, policy)));
                }
            }
        }
        HookPayload::Notification {
            notification_type,
            level,
            ..
        } => {
            field("notificationType", Value::String(notification_type.clone()));
            if let Some(v) = level {
                field("level", Value::String(v.clone()));
            }
        }
        HookPayload::SubagentStart {
            subagent_id,
            subagent_type,
            ..
        } => {
            field("subagentId", Value::String(subagent_id.clone()));
            field("subagentType", Value::String(subagent_type.clone()));
        }
        HookPayload::SubagentStop {
            subagent_id,
            subagent_type,
            exit_code,
            duration_ms,
            ..
        } => {
            field("subagentId", Value::String(subagent_id.clone()));
            field("subagentType", Value::String(subagent_type.clone()));
            if let Some(v) = exit_code {
                field("exitCode", (*v).into());
            }
            if let Some(v) = duration_ms {
                field("durationMs", (*v).into());
            }
        }
        HookPayload::PreCompact { source } | HookPayload::PostCompact { source } => {
            field("source", Value::String(source.clone()))
        }
    }
    Value::Object(out)
}

fn sensitive_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "credential",
        "cookie",
        "api_key",
        "apikey",
        "private_key",
    ]
    .iter()
    .any(|needle| k.contains(needle))
}
fn redact_value(value: Value, policy: &HookDataPolicy) -> Value {
    match value {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| {
                    if sensitive_key(&k) && !policy.allows("payload:credentials") {
                        (k, Value::String("[redacted]".into()))
                    } else {
                        (k, redact_value(v, policy))
                    }
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(|v| redact_value(v, policy)).collect()),
        Value::String(s) => Value::String(redact_text(&s, policy)),
        other => other,
    }
}
/// Redact common bearer/credential forms before errors, reasons or previews
/// reach logs/results. Exact secret values are never echoed.
pub fn redact_text(text: &str, policy: &HookDataPolicy) -> String {
    if policy.allows("payload:credentials") {
        return text.to_owned();
    }
    let mut words = text
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for i in 0..words.len() {
        let lower = words[i].to_ascii_lowercase();
        if lower == "bearer" && i + 1 < words.len() {
            words[i + 1] = "[redacted]".into();
        }
        if lower.contains("token=")
            || lower.contains("password=")
            || lower.contains("secret=")
            || lower.starts_with("ghp_")
            || lower.starts_with("sk-")
        {
            words[i] = "[redacted]".into();
        }
    }
    words.join(" ")
}
