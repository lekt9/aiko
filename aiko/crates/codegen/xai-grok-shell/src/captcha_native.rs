//! Native 2Captcha integration via x402 Pay pass-through and direct API.
//!
//! 2Captcha provides human-powered CAPTCHA solving. This module offers two
//! transports:
//!  - `pay curl` → x402 payment layer (~$0.01/solve via PaySponge gateway)
//!  - Direct API  → calls `api.2captcha.com` with the user's own API key

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

const TWOCAPTCHA_BASE: &str = "https://2captcha.x402.paysponge.com";
const TWOCAPTCHA_API_BASE: &str = "https://api.2captcha.com";

// ── types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaSolveRequest {
    #[serde(rename = "type")]
    pub captcha_type: String,
    pub websiteURL: String,
    pub websiteKey: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isInvisible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minScore: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxyConfig: Option<CaptchaProxyConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaProxyConfig {
    pub proxyType: String,
    pub proxyAddress: String,
    pub proxyPort: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxyLogin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxyPassword: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaCreateResponse {
    #[serde(default)]
    pub errorId: Option<i32>,
    #[serde(default)]
    pub errorCode: Option<String>,
    #[serde(default)]
    pub errorDescription: Option<String>,
    #[serde(default)]
    pub taskId: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaResultRequest {
    #[serde(rename = "type")]
    pub result_type: String,
    pub taskId: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaResultResponse {
    #[serde(default)]
    pub errorId: Option<i32>,
    #[serde(default)]
    pub errorCode: Option<String>,
    #[serde(default)]
    pub errorDescription: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub solution: Option<CaptchaSolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaSolution {
    #[serde(default)]
    pub gRecaptchaResponse: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

// ── pay curl transport ───────────────────────────────────────────────────────

/// Call `pay curl` to make an x402-authenticated HTTP request.
async fn pay_curl(method: &str, url: &str, body: Option<&Value>) -> Result<String> {
    let mut cmd = Command::new("pay");
    cmd.arg("curl")
        .arg("-X")
        .arg(method)
        .arg(url)
        .arg("-H")
        .arg("Content-Type: application/json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(body) = body {
        let body_str = serde_json::to_string(body)?;
        cmd.arg("-d").arg(&body_str);
    }

    let output = cmd.output().await.context("failed to spawn `pay curl`")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        bail!(
            "pay curl exited {}: {}",
            output.status,
            stderr.trim().lines().last().unwrap_or(&stdout)
        );
    }

    Ok(String::from_utf8(output.stdout)?)
}

/// Parse JSON from pay curl output, skipping any x402 status prefix lines.
fn parse_pay_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T> {
    let json_start = raw.find(|c: char| c == '{' || c == '[').unwrap_or(0);
    let json = &raw[json_start..];
    serde_json::from_str(json).with_context(|| {
        format!(
            "failed to parse 2Captcha response: {}",
            &json[..json.len().min(200)]
        )
    })
}

// ── public API ───────────────────────────────────────────────────────────────

/// Submit a CAPTCHA solve task. $0.01 via x402.
pub async fn solve_captcha(
    captcha_type: &str,
    site_key: &str,
    page_url: &str,
    invisible: Option<bool>,
    min_score: Option<f64>,
) -> Result<CaptchaCreateResponse> {
    let body = serde_json::json!({
        "type": captcha_type,
        "websiteURL": page_url,
        "websiteKey": site_key,
        "isInvisible": invisible,
        "minScore": min_score,
    });
    let raw = pay_curl(
        "POST",
        &format!("{TWOCAPTCHA_BASE}/createTask"),
        Some(&body),
    )
    .await?;
    let response: CaptchaCreateResponse = parse_pay_json(&raw)?;

    if response.errorId == Some(0) || response.errorId.is_none() {
        Ok(response)
    } else {
        bail!(
            "2Captcha error {}: {}",
            response.errorCode.as_deref().unwrap_or("unknown"),
            response
                .errorDescription
                .as_deref()
                .unwrap_or("no description"),
        )
    }
}

/// Poll for a CAPTCHA solve result. Free via x402.
pub async fn get_captcha_result(task_id: u64) -> Result<CaptchaResultResponse> {
    let body = serde_json::json!({
        "type": "getTaskResult",
        "taskId": task_id,
    });
    let raw = pay_curl(
        "POST",
        &format!("{TWOCAPTCHA_BASE}/getTaskResult"),
        Some(&body),
    )
    .await?;
    parse_pay_json::<CaptchaResultResponse>(&raw)
}

/// Block until a CAPTCHA is solved, polling at the given interval.
/// Returns the solution token, or an error on timeout.
pub async fn wait_for_solution(
    task_id: u64,
    timeout_secs: u64,
    poll_interval_secs: u64,
) -> Result<CaptchaResultResponse> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        let result = get_captcha_result(task_id).await?;

        if result.status.as_deref() == Some("ready") {
            return Ok(result);
        }

        if let Some(error) = &result.errorCode {
            if error != "ERROR_NO_SLOT_AVAILABLE" {
                bail!(
                    "2Captcha error {}: {}",
                    error,
                    result
                        .errorDescription
                        .as_deref()
                        .unwrap_or("no description"),
                );
            }
        }

        if tokio::time::Instant::now() >= deadline {
            bail!("timed out waiting for CAPTCHA solution (task {task_id})");
        }

        tokio::time::sleep(std::time::Duration::from_secs(poll_interval_secs)).await;
    }
}

/// Extract the solution token from a result response.
pub fn extract_token(result: &CaptchaResultResponse) -> Option<&str> {
    result
        .solution
        .as_ref()
        .and_then(|s| s.gRecaptchaResponse.as_deref().or(s.token.as_deref()))
}

// ── CLI helpers ──────────────────────────────────────────────────────────────

/// Print a solve response as JSON.
pub fn print_solve_response(response: &CaptchaCreateResponse) {
    println!(
        "{}",
        serde_json::to_string_pretty(response).unwrap_or_default()
    );
}

/// Print a result response as JSON.
pub fn print_result_response(response: &CaptchaResultResponse) {
    println!(
        "{}",
        serde_json::to_string_pretty(response).unwrap_or_default()
    );
}

// ── direct 2Captcha API (no x402) ────────────────────────────────────────────

/// Map the x402 task-type string to the 2Captcha `method` param used by the
/// direct `in.php` endpoint.
fn direct_method(captcha_type: &str) -> &str {
    match captcha_type {
        "HCaptchaTaskProxyless" => "hcaptcha",
        "RecaptchaV2TaskProxyless" => "userrecaptcha",
        "RecaptchaV3TaskProxyless" => "userrecaptcha",
        other => other,
    }
}

/// Resolve the 2Captcha API key from (in order):
///  1. request-body `api_key`
///  2. `TWOCAPTCHA_API_KEY` env var
///  3. `~/.aiko/native/2captcha_key` file
pub fn resolve_2captcha_key(api_key: Option<&str>) -> Option<String> {
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        return Some(key.trim().to_string());
    }
    if let Ok(key) = std::env::var("TWOCAPTCHA_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    let path = twocaptcha_key_path();
    if let Ok(key) = std::fs::read_to_string(&path) {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    None
}

/// Save a 2Captcha API key to `~/.aiko/native/2captcha_key`.
pub fn save_2captcha_key(key: &str) -> Result<()> {
    let path = twocaptcha_key_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, key.trim())?;
    Ok(())
}

fn twocaptcha_key_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aiko/native/2captcha_key")
}

/// Submit a CAPTCHA solve directly to 2Captcha (no x402 markup).
pub async fn solve_captcha_direct(
    api_key: &str,
    captcha_type: &str,
    site_key: &str,
    page_url: &str,
    invisible: Option<bool>,
    min_score: Option<f64>,
) -> Result<CaptchaCreateResponse> {
    let method = direct_method(captcha_type);
    let client = reqwest::Client::new();
    let mut form = vec![
        ("key", api_key.to_string()),
        ("method", method.to_string()),
        ("sitekey", site_key.to_string()),
        ("pageurl", page_url.to_string()),
        ("json", "1".to_string()),
        ("header_acao", "1".to_string()),
    ];
    if invisible.unwrap_or(false) {
        form.push(("invisible", "1".to_string()));
    }
    if let Some(score) = min_score {
        form.push(("min_score", format!("{score:.1}")));
    }

    let resp = client
        .post(format!("{TWOCAPTCHA_API_BASE}/in.php"))
        .form(&form)
        .send()
        .await
        .context("2Captcha direct submit failed")?;

    let raw = resp
        .text()
        .await
        .context("2Captcha direct response read failed")?;

    let parsed: Value =
        serde_json::from_str(&raw).context("2Captcha direct response not valid JSON")?;

    if parsed.get("status").and_then(Value::as_u64) == Some(1) {
        Ok(CaptchaCreateResponse {
            errorId: Some(0),
            errorCode: None,
            errorDescription: None,
            taskId: parsed["request"].as_str().and_then(|s| s.parse().ok()),
        })
    } else {
        let err = parsed
            .get("request")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        bail!("2Captcha direct error: {err}");
    }
}

/// Poll for a CAPTCHA solve result from the direct 2Captcha API.
pub async fn get_captcha_result_direct(
    api_key: &str,
    task_id: u64,
) -> Result<CaptchaResultResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!(
            "{TWOCAPTCHA_API_BASE}/res.php?key={api_key}&action=get&id={task_id}&json=1&header_acao=1"
        ))
        .send()
        .await
        .context("2Captcha direct poll failed")?;

    let raw = resp
        .text()
        .await
        .context("2Captcha direct poll response read failed")?;

    let parsed: Value =
        serde_json::from_str(&raw).context("2Captcha direct poll response not valid JSON")?;

    if parsed.get("status").and_then(Value::as_u64) == Some(1) {
        Ok(CaptchaResultResponse {
            errorId: Some(0),
            errorCode: None,
            errorDescription: None,
            status: Some("ready".to_string()),
            solution: Some(CaptchaSolution {
                gRecaptchaResponse: parsed["request"].as_str().map(String::from),
                token: parsed["request"].as_str().map(String::from),
            }),
        })
    } else {
        let request = parsed["request"].as_str().unwrap_or("CAPCHA_NOT_READY");
        if request == "CAPCHA_NOT_READY" {
            Ok(CaptchaResultResponse {
                errorId: Some(0),
                errorCode: Some("ERROR_NO_SLOT_AVAILABLE".to_string()),
                errorDescription: None,
                status: Some("processing".to_string()),
                solution: None,
            })
        } else {
            bail!("2Captcha direct error: {request}");
        }
    }
}

/// Block until a CAPTCHA is solved via the direct 2Captcha API.
pub async fn wait_for_solution_direct(
    api_key: &str,
    task_id: u64,
    timeout_secs: u64,
    poll_interval_secs: u64,
) -> Result<CaptchaResultResponse> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        let result = get_captcha_result_direct(api_key, task_id).await?;

        if result.status.as_deref() == Some("ready") {
            return Ok(result);
        }

        if let Some(error) = &result.errorCode {
            if error != "ERROR_NO_SLOT_AVAILABLE" {
                bail!(
                    "2Captcha error {}: {}",
                    error,
                    result
                        .errorDescription
                        .as_deref()
                        .unwrap_or("no description"),
                );
            }
        }

        if tokio::time::Instant::now() >= deadline {
            bail!("timed out waiting for CAPTCHA solution (task {task_id})");
        }

        tokio::time::sleep(std::time::Duration::from_secs(poll_interval_secs)).await;
    }
}
