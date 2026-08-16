//! Public Aiko MCP tools for the Contract-owned webhook surface.
//! Calls carry lifecycle declarations only; authentication and secret resolution stay in the host.
use serde_json::{Value, json};

pub const API_VERSION: &str = "aiko.contract-webhooks/v1";
#[derive(Debug, Clone, PartialEq)]
pub struct ContractWebhookToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}
fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
pub fn tool_catalog() -> Vec<ContractWebhookToolSpec> {
    vec![
        spec(
            "contract_webhook_create",
            "Create an opaque, generation-fenced Contract webhook endpoint",
            schema(
                json!({"api_version":{"const":API_VERSION},"declaration":{"type":"object"}}),
                &["api_version", "declaration"],
            ),
        ),
        spec(
            "contract_webhook_list",
            "List Contract webhook endpoints in the authenticated tenant",
            schema(
                json!({"api_version":{"const":API_VERSION}}),
                &["api_version"],
            ),
        ),
        spec(
            "contract_webhook_inspect",
            "Inspect one opaque Contract webhook endpoint",
            endpoint_schema(false),
        ),
        spec(
            "contract_webhook_rotate",
            "Rotate an endpoint to the next credential-handle generation",
            endpoint_schema(true),
        ),
        spec(
            "contract_webhook_pause",
            "Pause an endpoint with compare-and-swap fencing",
            endpoint_schema(true),
        ),
        spec(
            "contract_webhook_revoke",
            "Terminally revoke an endpoint with compare-and-swap fencing",
            endpoint_schema(true),
        ),
    ]
}
fn spec(
    name: &'static str,
    description: &'static str,
    input_schema: Value,
) -> ContractWebhookToolSpec {
    ContractWebhookToolSpec {
        name,
        description,
        input_schema,
    }
}
fn endpoint_schema(generation: bool) -> Value {
    let mut p = json!({"api_version":{"const":API_VERSION},"endpoint_id":{"type":"string","pattern":"^wh_[A-Za-z0-9-]{16,255}$"}});
    let mut required = vec!["api_version", "endpoint_id"];
    if generation {
        p["expected_generation"] = json!({"type":"integer","minimum":1});
        required.push("expected_generation");
    }
    schema(p, &required)
}

/// Validate the closed MCP envelope, then forward to the host's Gateway client. The host supplies authenticated authority.
pub async fn dispatch<F, Fut>(tool: &str, input: Value, gateway: F) -> Value
where
    F: FnOnce(&str, Value) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let Some(spec) = tool_catalog().into_iter().find(|s| s.name == tool) else {
        return error("method_not_found", "unknown Contract webhook tool");
    };
    let Some(object) = input.as_object() else {
        return error("invalid_request", "tool input must be an object");
    };
    if object.get("api_version").and_then(Value::as_str) != Some(API_VERSION) {
        return error("invalid_request", "unsupported api_version");
    }
    let allowed = spec.input_schema["properties"]
        .as_object()
        .expect("schema invariant");
    if object.keys().any(|key| !allowed.contains_key(key)) {
        return error("invalid_request", "unknown request field");
    }
    let method = tool.replacen("contract_webhook_", "contractWebhooks.", 1);
    gateway(&method, input).await
}
fn error(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_tools_are_registered_and_closed() {
        let c = tool_catalog();
        assert_eq!(c.len(), 6);
        assert!(
            c.iter()
                .all(|x| x.input_schema["additionalProperties"] == false)
        );
        assert!(
            c.iter()
                .all(|x| !x.input_schema.to_string().contains("secret"))
        );
    }
}
