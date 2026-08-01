//! Native AgentMail integration via x402 Pay pass-through.
//!
//! AgentMail provides disposable email inboxes for AI agents. This module
//! calls `pay curl` to route through the x402 payment layer transparently.
//! Pricing: inbox creation $2.00, all other operations free.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;

const AGENTMAIL_BASE: &str = "https://x402.api.agentmail.to";

// ── types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentMailInbox {
    pub inbox_id: String,
    pub email_address: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentMailThread {
    pub thread_id: String,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub snippet: Option<String>,
    #[serde(default)]
    pub from_addresses: Vec<String>,
    #[serde(default)]
    pub to_addresses: Vec<String>,
    #[serde(default)]
    pub received_at: Option<String>,
    #[serde(default)]
    pub message_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMailThreadDetail {
    pub thread_id: String,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub messages: Vec<AgentMailMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMailMessage {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub from_address: Option<String>,
    #[serde(default)]
    pub to_addresses: Vec<String>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub text_body: Option<String>,
    #[serde(default)]
    pub html_body: Option<String>,
    #[serde(default)]
    pub received_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMailListResponse<T> {
    #[serde(default)]
    pub items: Vec<T>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

// ── pay curl transport ───────────────────────────────────────────────────────

/// Call `pay curl` to make an x402-authenticated HTTP request.
/// Returns raw stdout as a String.
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
        // pay curl handles x402 itself; non-zero exit means payment or
        // transport failure. Surface both streams so the caller can triage.
        bail!(
            "pay curl exited {}: {}",
            output.status,
            stderr.trim().lines().last().unwrap_or(&stdout)
        );
    }

    Ok(String::from_utf8(output.stdout)?)
}

/// Parse JSON response from pay curl output.
/// pay curl may emit x402 status lines before the JSON body — find the
/// first `{` or `[` and parse from there.
fn parse_pay_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T> {
    let json_start = raw.find(|c: char| c == '{' || c == '[').unwrap_or(0);
    let json = &raw[json_start..];
    serde_json::from_str(json).with_context(|| {
        format!(
            "failed to parse pay curl response: {}",
            &json[..json.len().min(200)]
        )
    })
}

// ── public API ───────────────────────────────────────────────────────────────

/// Create a new AgentMail inbox. $2.00 via x402.
pub async fn create_inbox(display_name: Option<&str>) -> Result<AgentMailInbox> {
    let body = serde_json::json!({
        "display_name": display_name.unwrap_or("Aiko Build"),
    });
    let raw = pay_curl("POST", &format!("{AGENTMAIL_BASE}/v0/inboxes"), Some(&body)).await?;
    parse_pay_json::<AgentMailInbox>(&raw)
}

/// List all AgentMail inboxes. Free via x402.
pub async fn list_inboxes() -> Result<AgentMailListResponse<AgentMailInbox>> {
    let raw = pay_curl("GET", &format!("{AGENTMAIL_BASE}/v0/inboxes"), None).await?;
    parse_pay_json::<AgentMailListResponse<AgentMailInbox>>(&raw)
}

/// List email threads for all inboxes. Free via x402.
pub async fn list_threads() -> Result<AgentMailListResponse<AgentMailThread>> {
    let raw = pay_curl("GET", &format!("{AGENTMAIL_BASE}/v0/threads"), None).await?;
    parse_pay_json::<AgentMailListResponse<AgentMailThread>>(&raw)
}

/// Get a thread with all messages. Free via x402.
pub async fn get_thread(thread_id: &str) -> Result<AgentMailThreadDetail> {
    let raw = pay_curl(
        "GET",
        &format!("{AGENTMAIL_BASE}/v0/threads/{thread_id}"),
        None,
    )
    .await?;
    parse_pay_json::<AgentMailThreadDetail>(&raw)
}

/// Get an attachment from a thread. Free via x402.
pub async fn get_attachment(thread_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
    let raw = pay_curl(
        "GET",
        &format!("{AGENTMAIL_BASE}/v0/threads/{thread_id}/attachments/{attachment_id}"),
        None,
    )
    .await?;
    // Attachments may be binary; try to extract base64 or return raw bytes
    let json_start = raw.find(|c: char| c == '{' || c == '[').unwrap_or(0);
    if json_start == 0 {
        Ok(raw.into_bytes())
    } else {
        // pay curl prepended x402 status lines; strip them
        Ok(raw[json_start..].as_bytes().to_vec())
    }
}

/// Poll for a new thread containing a verification code.
/// Returns the thread and extracted 6-digit code if found within timeout.
pub async fn wait_for_verification_code(
    timeout_secs: u64,
    poll_interval_secs: u64,
) -> Result<Option<(AgentMailThreadDetail, String)>> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        let threads = list_threads().await?;
        for thread in &threads.items {
            if let Some(subject) = &thread.subject {
                // Look for verification-signalling subjects
                let subject_lower = subject.to_lowercase();
                if subject_lower.contains("verify")
                    || subject_lower.contains("confirm")
                    || subject_lower.contains("code")
                {
                    let detail = get_thread(&thread.thread_id).await?;
                    for msg in &detail.messages {
                        let body = msg
                            .text_body
                            .as_deref()
                            .or(msg.html_body.as_deref())
                            .unwrap_or("");
                        // Extract 6-digit code
                        if let Some(code) = extract_verification_code(body) {
                            return Ok(Some((detail, code)));
                        }
                    }
                }
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }

        tokio::time::sleep(std::time::Duration::from_secs(poll_interval_secs)).await;
    }
}

/// Extract a 6-digit verification code from message text.
fn extract_verification_code(text: &str) -> Option<String> {
    // Rust's regex engine intentionally has no look-around. Capture six digits
    // with explicit non-digit boundaries and return only the code group.
    let re = regex::Regex::new(r"(?:^|[^0-9])([0-9]{6})(?:[^0-9]|$)").ok()?;
    re.captures(text)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_string())
}

// ── CLI helpers ──────────────────────────────────────────────────────────────

/// Print an inbox as JSON to stdout.
pub fn print_inbox(inbox: &AgentMailInbox) {
    println!(
        "{}",
        serde_json::to_string_pretty(inbox).unwrap_or_default()
    );
}

/// Print inbox list as JSON to stdout.
pub fn print_inbox_list(response: &AgentMailListResponse<AgentMailInbox>) {
    println!(
        "{}",
        serde_json::to_string_pretty(response).unwrap_or_default()
    );
}

/// Print thread list as JSON to stdout.
pub fn print_thread_list(response: &AgentMailListResponse<AgentMailThread>) {
    println!(
        "{}",
        serde_json::to_string_pretty(response).unwrap_or_default()
    );
}

/// Print thread detail as JSON to stdout.
pub fn print_thread_detail(detail: &AgentMailThreadDetail) {
    println!(
        "{}",
        serde_json::to_string_pretty(detail).unwrap_or_default()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_discord_verification_code() {
        let text = "Your Discord verification code is: 482951";
        assert_eq!(extract_verification_code(text), Some("482951".into()));
    }

    #[test]
    fn extract_code_from_html() {
        let html = r#"<td>849201</td>"#;
        assert_eq!(extract_verification_code(html), Some("849201".into()));
    }

    #[test]
    fn ignore_longer_numbers() {
        let text = "Your order #1234567890 has shipped";
        assert_eq!(extract_verification_code(text), None);
    }
}
