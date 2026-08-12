//! Thin connectivity adapter from Telegram into Aiko's native agent/session mail.
//!
//! This module does not implement an agent. It speaks authenticated ACP to the
//! already-running Aiko leader, preserving Aiko's tools, Contract routing,
//! session continuity, permissions, and structured terminal response.

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const DISCOVERY_SCHEMA: &str = "aiko.native.v1";
const ACP_PROTOCOL: &str = "aiko.acp.v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    schema: String,
    agent_mail_url: String,
    authorization: Authorization,
}

#[derive(Debug, Deserialize)]
struct Authorization {
    #[serde(rename = "type")]
    kind: String,
    token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentMailError {
    #[error("Aiko native discovery is unavailable: {0}")]
    Discovery(String),
    #[error("Aiko native discovery is incompatible")]
    IncompatibleDiscovery,
    #[error("Aiko agent-mail connection failed: {0}")]
    Connection(String),
    #[error("Aiko agent-mail protocol failed: {message}")]
    Protocol {
        message: String,
        code: Option<String>,
    },
    #[error("Aiko agent returned no valid typed response")]
    InvalidResponse,
}

fn protocol(message: impl Into<String>) -> AgentMailError {
    AgentMailError::Protocol {
        message: message.into(),
        code: None,
    }
}

fn discovery_path() -> Result<PathBuf, AgentMailError> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| AgentMailError::Discovery("HOME is unavailable".into()))?;
    Ok(home.join(".aiko").join("native").join("api.json"))
}

fn read_discovery() -> Result<Discovery, AgentMailError> {
    let path = discovery_path()?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| AgentMailError::Discovery(format!("{}: {error}", path.display())))?;
    let discovery: Discovery = serde_json::from_str(&raw)
        .map_err(|error| AgentMailError::Discovery(format!("{}: {error}", path.display())))?;
    let url = reqwest::Url::parse(&discovery.agent_mail_url)
        .map_err(|_| AgentMailError::IncompatibleDiscovery)?;
    let loopback = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|address| address.is_loopback());
    if discovery.schema != DISCOVERY_SCHEMA
        || discovery.authorization.kind != "bearer"
        || discovery.authorization.token.is_empty()
        || url.scheme() != "ws"
        || !loopback
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/v1/agent-mail"
    {
        return Err(AgentMailError::IncompatibleDiscovery);
    }
    Ok(discovery)
}

fn unknown_session(error: &AgentMailError) -> bool {
    matches!(
        error,
        AgentMailError::Protocol { code: Some(code), .. } if code == "FS_NOT_FOUND"
    )
}

fn reverse_response(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method")?.as_str()?;
    if method == "session/request_permission" {
        let options = message
            .pointer("/params/options")
            .and_then(Value::as_array)?;
        let offered = options.iter().find_map(|option| {
            let kind = option.get("kind").and_then(Value::as_str);
            let option_id = option
                .get("optionId")
                .or_else(|| option.get("option_id"))
                .and_then(Value::as_str)?;
            matches!(
                kind,
                Some("allow_once") | Some("allow-once") | Some("AllowOnce")
            )
            .then_some(option_id)
        });
        return Some(match offered {
            Some(option_id) => json!({
                "jsonrpc": "2.0", "id": id,
                "result": {"outcome": {"outcome": "selected", "optionId": option_id}}
            }),
            None => json!({
                "jsonrpc": "2.0", "id": id,
                "result": {"outcome": {"outcome": "cancelled"}}
            }),
        });
    }
    if matches!(method, "x.ai/ask_user_question" | "_x.ai/ask_user_question") {
        return Some(json!({
            "jsonrpc": "2.0", "id": id,
            "result": {"outcome": "cancelled"}
        }));
    }
    Some(json!({
        "jsonrpc": "2.0", "id": id,
        "error": {"code": -32601, "message": format!("Unhandled reverse request: {method}")}
    }))
}

async fn send_json<S>(socket: &mut S, value: Value) -> Result<(), AgentMailError>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|error| protocol(error.to_string()))
}

async fn request<S>(
    socket: &mut S,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, AgentMailError>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    send_json(
        socket,
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .await?;
    loop {
        let frame = tokio::time::timeout_at(deadline, socket.next())
            .await
            .map_err(|_| protocol(format!("{method} timed out")))?
            .ok_or_else(|| protocol("Aiko agent-mail closed"))?
            .map_err(|error| protocol(error.to_string()))?;
        let Message::Text(text) = frame else { continue };
        let message: Value = serde_json::from_str(text.as_ref())
            .map_err(|error| protocol(format!("invalid JSON: {error}")))?;
        if message.get("id").is_some() && message.get("method").is_some() {
            if let Some(response) = reverse_response(&message) {
                send_json(socket, response).await?;
            }
            continue;
        }
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            let detail = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown ACP error");
            let code = error
                .pointer("/data/code")
                .and_then(Value::as_str)
                .map(str::to_owned);
            return Err(AgentMailError::Protocol {
                message: detail.to_string(),
                code,
            });
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| protocol(format!("{method} returned no result")));
    }
}

/// Deliver one Telegram turn to the full Aiko agent through its native ACP
/// membrane. The final typed response is returned; streamed prose is never
/// mistaken for settlement.
pub async fn prompt(
    session_id: &str,
    cwd: &Path,
    text: &str,
    response_schema: &Value,
    rules: &str,
    contract_parent_id: Option<&str>,
    conversation_id: &str,
) -> Result<Value, AgentMailError> {
    if !cwd.is_dir() {
        return Err(protocol(format!(
            "Telegram workspace does not exist: {}",
            cwd.display()
        )));
    }
    let discovery = read_discovery()?;
    let mut websocket_request = discovery
        .agent_mail_url
        .into_client_request()
        .map_err(|error| AgentMailError::Connection(error.to_string()))?;
    websocket_request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", discovery.authorization.token))
            .map_err(|error| AgentMailError::Connection(error.to_string()))?,
    );
    websocket_request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(ACP_PROTOCOL),
    );
    let (mut socket, response) = tokio_tungstenite::connect_async(websocket_request)
        .await
        .map_err(|error| AgentMailError::Connection(error.to_string()))?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        != Some(ACP_PROTOCOL)
    {
        return Err(AgentMailError::Connection(
            "Aiko did not negotiate the ACP subprotocol".into(),
        ));
    }

    request(
        &mut socket,
        1,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {"readTextFile": false, "writeTextFile": false},
                "terminal": false
            },
            "_meta": {"clientType": "aiko-telegram", "clientVersion": env!("CARGO_PKG_VERSION")}
        }),
    )
    .await?;

    let cwd = cwd.to_string_lossy();
    let load = request(
        &mut socket,
        2,
        "session/load",
        json!({
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": [],
            "_meta": {"rules": rules}
        }),
    )
    .await;
    if let Err(error) = &load {
        if unknown_session(error) {
            let created = request(
                &mut socket,
                3,
                "session/new",
                json!({
                    "cwd": cwd,
                    "mcpServers": [],
                    "_meta": {"sessionId": session_id, "rules": rules}
                }),
            )
            .await?;
            if created.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                return Err(protocol("Aiko created a different session identity"));
            }
        } else {
            return load.map(|_| Value::Null);
        }
    } else {
        load?;
    }

    let result = request(
        &mut socket,
        4,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{
                "type": "text",
                "text": text,
                "_meta": {
                    "aikoContractParentId": contract_parent_id,
                    "aikoContractRootId": contract_parent_id,
                    "aikoContractDepth": 1,
                    "aikoConversationId": conversation_id
                }
            }],
            "_meta": {
                "clientIdentifier": "aiko-telegram",
                "outputSchema": response_schema
            }
        }),
    )
    .await?;
    typed_terminal_response(&result)
}

fn typed_terminal_response(result: &Value) -> Result<Value, AgentMailError> {
    if result.get("stopReason").and_then(Value::as_str) != Some("end_turn")
        || result
            .pointer("/_meta/structuredOutputError")
            .is_some_and(|value| !value.is_null())
    {
        return Err(AgentMailError::InvalidResponse);
    }
    result
        .pointer("/_meta/structuredOutput")
        .cloned()
        .ok_or(AgentMailError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_fallback_is_narrow() {
        let missing = AgentMailError::Protocol {
            message: "Path not found".into(),
            code: Some("FS_NOT_FOUND".into()),
        };
        let auth = AgentMailError::Protocol {
            message: "authentication failed".into(),
            code: Some("UNAUTHORIZED".into()),
        };
        assert!(unknown_session(&missing));
        assert!(!unknown_session(&auth));
        assert!(!unknown_session(&protocol("leader unavailable")));
    }

    #[test]
    fn only_typed_terminal_settlement_can_cross_the_effector() {
        let settled = json!({
            "stopReason": "end_turn",
            "_meta": {"structuredOutput": {
                "kind": "text", "text": "done", "path": null, "caption": null
            }}
        });
        assert_eq!(typed_terminal_response(&settled).unwrap()["text"], "done");
        for refused in [
            json!({"stopReason": "end_turn", "_meta": {}}),
            json!({"stopReason": "cancelled", "_meta": {"structuredOutput": {}}}),
            json!({"stopReason": "end_turn", "_meta": {
                "structuredOutput": {}, "structuredOutputError": "invalid"
            }}),
        ] {
            assert!(matches!(
                typed_terminal_response(&refused),
                Err(AgentMailError::InvalidResponse)
            ));
        }
    }

    /// Live witness for the installed Aiko native membrane and leader. It is
    /// ignored in the hermetic suite because it requires a signed-in provider.
    #[tokio::test]
    #[ignore = "requires running aiko-leader and aiko-native services"]
    async fn live_native_agent_mail_returns_typed_terminal_response() {
        let schema = json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "text", "path", "caption"],
            "properties": {
                "kind": {"type": "string", "enum": ["text"]},
                "text": {"type": ["string", "null"]},
                "path": {"type": ["string", "null"]},
                "caption": {"type": ["string", "null"]}
            }
        });
        let output = prompt(
            "3268ecf4-90b0-4f46-8ef4-03c8d6879521",
            Path::new("/tmp"),
            "Reply with exactly: typed Aiko agent connected",
            &schema,
            "You are the full Aiko agent. Return the requested typed response.",
            None,
            "messaging:telegram:live-witness",
        )
        .await
        .expect("live ACP prompt");
        assert_eq!(output["kind"], "text");
        assert!(
            output["text"]
                .as_str()
                .is_some_and(|text| text.contains("typed Aiko agent connected"))
        );
    }

    #[test]
    fn reverse_requests_preserve_ids_and_fail_closed() {
        let permission = reverse_response(&json!({
            "id": 41,
            "method": "session/request_permission",
            "params": {"options": [
                {"optionId": "deny", "kind": "reject_once"},
                {"optionId": "offered-allow", "kind": "allow_once"}
            ]}
        }))
        .unwrap();
        assert_eq!(permission["id"], 41);
        assert_eq!(permission["result"]["outcome"]["optionId"], "offered-allow");

        let question = reverse_response(&json!({
            "id": "q", "method": "x.ai/ask_user_question"
        }))
        .unwrap();
        assert_eq!(question["result"]["outcome"], "cancelled");

        let unknown = reverse_response(&json!({"id": 9, "method": "other"})).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }
}
