//! Aiko MCP tools for Contract-owned execution lifecycle control.
//! Every tool forwards to authenticated Gateway RPC; none opens Contract storage.
use serde_json::{Value, json};

pub const API_VERSION: &str = "aiko.contract-lifecycle/v1";
#[derive(Debug, Clone, PartialEq)]
pub struct ContractLifecycleToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}
fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
fn common(extra: Value, required: &[&str]) -> Value {
    let mut properties =
        json!({"api_version":{"const":API_VERSION},"run_id":{"type":"string","minLength":1}});
    properties
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let mut all = vec!["api_version", "run_id"];
    all.extend_from_slice(required);
    schema(properties, &all)
}
fn generation(extra: Value, required: &[&str]) -> Value {
    let mut fields = json!({"expected_generation":{"type":"integer","minimum":1}});
    fields
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let mut all = vec!["expected_generation"];
    all.extend_from_slice(required);
    common(fields, &all)
}
fn spec(
    name: &'static str,
    description: &'static str,
    input_schema: Value,
) -> ContractLifecycleToolSpec {
    ContractLifecycleToolSpec {
        name,
        description,
        input_schema,
    }
}
pub fn tool_catalog() -> Vec<ContractLifecycleToolSpec> {
    vec![
        spec(
            "contract_lifecycle_inspect",
            "Inspect a tenant- and owner-scoped Contract run",
            common(json!({}), &[]),
        ),
        spec(
            "contract_lifecycle_pause",
            "Block new claims and durably drain or park in-flight claims",
            generation(json!({}), &[]),
        ),
        spec(
            "contract_lifecycle_resume",
            "Resume the same root/run only after all pins revalidate",
            generation(json!({}), &[]),
        ),
        spec(
            "contract_lifecycle_cancel",
            "Terminally cancel a run",
            generation(
                json!({"reason":{"type":"string","minLength":1}}),
                &["reason"],
            ),
        ),
        spec(
            "contract_lifecycle_revoke",
            "Generation-CAS revoke a tool or credential",
            generation(
                json!({"kind":{"enum":["tool","credential"]},"id":{"type":"string","minLength":1},"reason":{"type":"string","minLength":1}}),
                &["kind", "id", "reason"],
            ),
        ),
        spec(
            "contract_lifecycle_semantic_rollback",
            "Append invalidation and compensation occurrences without deleting settlement",
            generation(
                json!({"target_occurrence_id":{"type":"string","minLength":1},"reason":{"type":"string","minLength":1}}),
                &["target_occurrence_id", "reason"],
            ),
        ),
        spec(
            "contract_lifecycle_time_travel_fork",
            "Create an operational-only fork; never erase or resend crossed effects",
            generation(
                json!({"frame_no":{"type":"integer","minimum":0}}),
                &["frame_no"],
            ),
        ),
    ]
}
pub async fn dispatch<F, Fut>(tool: &str, input: Value, gateway: F) -> Value
where
    F: FnOnce(&str, Value) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let Some(spec) = tool_catalog().into_iter().find(|s| s.name == tool) else {
        return error("method_not_found", "unknown Contract lifecycle tool");
    };
    let Some(object) = input.as_object() else {
        return error("invalid_request", "tool input must be an object");
    };
    if object.get("api_version").and_then(Value::as_str) != Some(API_VERSION) {
        return error("invalid_request", "unsupported api_version");
    }
    let allowed = spec.input_schema["properties"].as_object().unwrap();
    if object.keys().any(|key| !allowed.contains_key(key)) {
        return error("invalid_request", "unknown request field");
    }
    let suffix = tool.strip_prefix("contract_lifecycle_").unwrap();
    let method = match suffix {
        "semantic_rollback" => "contractLifecycle.semanticRollback".to_string(),
        "time_travel_fork" => "contractLifecycle.timeTravelFork".to_string(),
        other => format!("contractLifecycle.{other}"),
    };
    gateway(&method, wire(input)).await
}
fn wire(mut input: Value) -> Value {
    if let Some(o) = input.as_object_mut() {
        o.remove("api_version");
        for (a, b) in [
            ("run_id", "runId"),
            ("expected_generation", "expectedGeneration"),
            ("target_occurrence_id", "targetOccurrenceId"),
            ("frame_no", "frameNo"),
        ] {
            if let Some(v) = o.remove(a) {
                o.insert(b.into(), v);
            }
        }
    }
    input
}
fn error(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_is_closed_and_public() {
        let c = tool_catalog();
        assert_eq!(c.len(), 7);
        assert!(
            c.iter()
                .all(|x| x.input_schema["additionalProperties"] == false)
        );
        assert!(!format!("{c:?}").contains("database"));
    }
}
