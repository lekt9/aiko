use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use thiserror::Error;

const DISCOVERY_SCHEMA: &str = "aiko.native.v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequest {
    path: String,
    method: String,
    body: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Discovery {
    schema: String,
    api_version: u8,
    pub(crate) base_url: String,
    pub(crate) agent_mail_url: String,
    pub(crate) authorization: Authorization,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Authorization {
    #[serde(rename = "type")]
    kind: String,
    pub(crate) token: String,
}

#[derive(Debug, Error)]
enum BridgeError {
    #[error("Aiko runtime discovery was not found. Start Aiko and try again.")]
    DiscoveryMissing,
    #[error("Aiko runtime discovery could not be read: {0}")]
    DiscoveryRead(String),
    #[error("Aiko runtime discovery is incompatible.")]
    DiscoveryIncompatible,
    #[error("The requested native API path is not allowed.")]
    PathRejected,
    #[error("The requested HTTP method is not allowed.")]
    MethodRejected,
    #[error("Aiko runtime request failed: {0}")]
    Request(String),
    #[error("Aiko runtime returned HTTP {status}: {message}")]
    Response { status: u16, message: String },
}

#[derive(Debug, Serialize)]
pub(crate) struct CommandError {
    code: &'static str,
    message: String,
}

impl From<BridgeError> for CommandError {
    fn from(error: BridgeError) -> Self {
        let code = match error {
            BridgeError::DiscoveryMissing => "discovery_missing",
            BridgeError::DiscoveryRead(_) => "discovery_read_failed",
            BridgeError::DiscoveryIncompatible => "discovery_incompatible",
            BridgeError::PathRejected => "path_rejected",
            BridgeError::MethodRejected => "method_rejected",
            BridgeError::Request(_) => "runtime_request_failed",
            BridgeError::Response { .. } => "runtime_response_failed",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

fn discovery_path() -> Result<PathBuf, BridgeError> {
    dirs::home_dir()
        .map(|home| home.join(".aiko").join("native").join("api.json"))
        .ok_or(BridgeError::DiscoveryMissing)
}

fn read_discovery() -> Result<Discovery, BridgeError> {
    let path = discovery_path()?;
    let raw = std::fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BridgeError::DiscoveryMissing
        } else {
            BridgeError::DiscoveryRead(error.to_string())
        }
    })?;
    let discovery: Discovery =
        serde_json::from_str(&raw).map_err(|error| BridgeError::DiscoveryRead(error.to_string()))?;
    if discovery.schema != DISCOVERY_SCHEMA
        || discovery.api_version != 1
        || discovery.authorization.kind != "bearer"
        || discovery.authorization.token.is_empty()
    {
        return Err(BridgeError::DiscoveryIncompatible);
    }
    let url = reqwest::Url::parse(&discovery.base_url)
        .map_err(|_| BridgeError::DiscoveryIncompatible)?;
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        return Err(BridgeError::DiscoveryIncompatible);
    }
    Ok(discovery)
}

pub(crate) async fn runtime_available() -> bool {
    let Ok(discovery) = read_discovery() else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(&discovery.base_url)
        .and_then(|base| base.join("v1/health"))
    else {
        return false;
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(750))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(url)
        .bearer_auth(discovery.authorization.token)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

fn validate_path(path: &str) -> Result<(), BridgeError> {
    if !path.starts_with("/v1/") || path.contains("..") || path.contains('?') || path.contains('#') {
        return Err(BridgeError::PathRejected);
    }
    Ok(())
}

#[tauri::command]
pub async fn native_api_request(request: NativeRequest) -> Result<Value, CommandError> {
    validate_path(&request.path)?;
    let method = match request.method.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        _ => return Err(BridgeError::MethodRejected.into()),
    };
    let discovery = read_discovery()?;
    let url = reqwest::Url::parse(&discovery.base_url)
        .and_then(|base| base.join(request.path.trim_start_matches('/')))
        .map_err(|error| BridgeError::Request(error.to_string()))?;
    let client = reqwest::Client::new();
    let mut outbound = client
        .request(method, url)
        .bearer_auth(discovery.authorization.token);
    if let Some(body) = request.body {
        outbound = outbound.json(&body);
    }
    let response = outbound
        .send()
        .await
        .map_err(|error| BridgeError::Request(error.to_string()))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| BridgeError::Request(error.to_string()))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("The Aiko runtime rejected the request.")
            .to_owned();
        return Err(BridgeError::Response {
            status: status.as_u16(),
            message,
        }
        .into());
    }
    Ok(body)
}

#[tauri::command]
pub fn native_agent_mail_url() -> Result<String, CommandError> {
    let discovery = read_discovery()?;
    let mut url = reqwest::Url::parse(&discovery.agent_mail_url)
        .map_err(|_| BridgeError::DiscoveryIncompatible)?;
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        return Err(BridgeError::DiscoveryIncompatible.into());
    }
    url.query_pairs_mut()
        .append_pair("token", &discovery.authorization.token);
    Ok(url.to_string())
}

#[tauri::command]
pub fn reveal_runtime_help() -> String {
    "Run `aiko native serve`, then reopen Aiko Desktop.".to_owned()
}

#[cfg(test)]
mod tests {
    use super::validate_path;

    #[test]
    fn accepts_versioned_native_paths() {
        assert!(validate_path("/v1/health").is_ok());
        assert!(validate_path("/v1/contracts/example/retry").is_ok());
    }

    #[test]
    fn rejects_path_escape_and_queries() {
        assert!(validate_path("/v1/../secrets").is_err());
        assert!(validate_path("/v1/health?token=bad").is_err());
        assert!(validate_path("https://example.com/v1/health").is_err());
    }
}
