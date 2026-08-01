//! Native Telegram bridge management for Aiko.
//!
//! Owns the canonical read/write paths for Telegram settings
//! (`~/.aiko/user-settings.json`), launchd bridge status, pair-code
//! approval, and bridge log tailing. Every consumer — CLI, HTTP API,
//! Tauri desktop — calls through this module so onboarding is
//! consistent everywhere.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

// ── types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSettings {
    pub bot_token: Option<String>,
    pub approved_user_ids: Vec<u64>,
    pub bridge_running: bool,
    #[serde(default)]
    pub bridge_log: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPairResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserSettings {
    #[serde(default)]
    telegram: Option<TelegramConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelegramConfig {
    #[serde(default)]
    bot_token: Option<String>,
    #[serde(default)]
    approved_user_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TelegramHealth {
    pub bridge_running: bool,
    pub api_reachable: bool,
    pub identity_present: bool,
    pub approved_users: usize,
}

impl TelegramHealth {
    fn response(&self) -> String {
        let healthy = self.bridge_running && self.api_reachable && self.identity_present;
        format!(
            "{} — Telegram API identity {}, bridge {}, and {} approved user{} configured.",
            if healthy { "HEALTHY" } else { "UNHEALTHY" },
            if self.api_reachable && self.identity_present {
                "verified"
            } else {
                "not verified"
            },
            if self.bridge_running {
                "running"
            } else {
                "stopped"
            },
            self.approved_users,
            if self.approved_users == 1 {
                " is"
            } else {
                "s are"
            },
        )
    }
}

// ── paths ────────────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn user_settings_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".aiko").join("user-settings.json"))
}

fn pair_code_file_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".aiko").join("logs").join("telegram-pair-code.txt"))
}

fn bridge_log_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".aiko").join("logs").join("telegram-bridge.log"))
}

fn health_intent(goal: &str) -> bool {
    let goal = goal.to_ascii_lowercase();
    let telegram = goal.contains("telegram") && (goal.contains("bot") || goal.contains("bridge"));
    let health = [
        "health", "healthy", "status", "running", "online", "working",
    ]
    .iter()
    .any(|word| goal.contains(word));
    let requires_reasoning = [
        "diagnose",
        "debug",
        "fix",
        "repair",
        "build",
        "create",
        "implement",
        "send",
        "message",
        "why",
        "how",
    ]
    .iter()
    .any(|word| goal.contains(word));
    telegram && health && !requires_reasoning
}

fn raw_health_settings() -> Result<(String, usize), String> {
    let path = user_settings_path().ok_or("Cannot find home directory.")?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read settings at {}: {e}", path.display()))?;
    let settings: UserSettings =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse settings: {e}"))?;
    let telegram = settings.telegram.ok_or("Telegram is not configured.")?;
    let token = telegram
        .bot_token
        .filter(|token| !token.trim().is_empty())
        .ok_or("Telegram bot token is not configured.")?;
    Ok((token, telegram.approved_user_ids.unwrap_or_default().len()))
}

/// Resolve a narrow Telegram health/status request without model sampling.
/// The raw token never leaves this module and is never included in the result.
pub(crate) async fn telegram_health_fast_path(goal: &str) -> Option<String> {
    if !health_intent(goal) {
        return None;
    }
    let running = bridge_running();
    let Ok((token, approved_users)) = raw_health_settings() else {
        return Some(
            TelegramHealth {
                bridge_running: running,
                api_reachable: false,
                identity_present: false,
                approved_users: 0,
            }
            .response(),
        );
    };
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    let payload = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?
        .get(url)
        .send()
        .await
        .ok()
        .and_then(|response| response.error_for_status().ok());
    let json = match payload {
        Some(response) => response.json::<serde_json::Value>().await.ok(),
        None => None,
    };
    let api_reachable = json.as_ref().is_some_and(|value| value["ok"] == true);
    let identity_present = json
        .as_ref()
        .and_then(|value| value["result"]["username"].as_str())
        .is_some_and(|username| !username.is_empty());
    Some(
        TelegramHealth {
            bridge_running: running,
            api_reachable,
            identity_present,
            approved_users,
        }
        .response(),
    )
}

// ── bridge status ────────────────────────────────────────────────────────────

/// Check whether the Telegram bridge launchd service is running.
#[cfg(target_os = "macos")]
pub fn bridge_running() -> bool {
    let uid = unsafe { libc::getuid() };
    let label = format!("gui/{uid}/net.theclarityproject.aiko.telegram-bridge");
    let output = Command::new("launchctl").args(["print", &label]).output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains("state = running")
        }
        Err(_) => false,
    }
}

/// The bundled Telegram bridge currently uses launchd. Other desktop targets
/// expose the settings but correctly report the service as stopped.
#[cfg(not(target_os = "macos"))]
pub fn bridge_running() -> bool {
    false
}

// ── settings ─────────────────────────────────────────────────────────────────

/// Read Telegram settings from the user-settings file, including live
/// bridge status and recent log lines.
pub fn read_settings() -> Result<TelegramSettings, String> {
    let path = user_settings_path().ok_or("Cannot find home directory.")?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read settings at {}: {e}", path.display()))?;
    let settings: UserSettings =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse settings: {e}"))?;

    let telegram = settings.telegram;
    let running = bridge_running();

    let log_lines = bridge_log_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|content| {
            content
                .lines()
                .rev()
                .take(20)
                .map(|l| l.to_string())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default();

    Ok(TelegramSettings {
        bot_token: telegram
            .as_ref()
            .and_then(|t| t.bot_token.as_ref())
            .map(|t| {
                if t.len() > 12 {
                    format!("{}…{}", &t[..6], &t[t.len() - 6..])
                } else {
                    "••••".to_string()
                }
            }),
        approved_user_ids: telegram
            .and_then(|t| t.approved_user_ids)
            .unwrap_or_default(),
        bridge_running: running,
        bridge_log: log_lines,
    })
}

/// Save (or replace) the Telegram bot token in user settings.
/// Returns the newly stored token (masked) on success.
pub fn save_bot_token(token: &str) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token must not be empty.".to_string());
    }
    if token.len() < 20 {
        return Err("Token looks too short to be a valid bot token.".to_string());
    }

    let path = user_settings_path().ok_or("Cannot find home directory.")?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("Cannot read settings: {e}"))?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse settings: {e}"))?;

    let telegram = settings
        .as_object_mut()
        .ok_or("Settings root is not an object.")?
        .entry("telegram")
        .or_insert(serde_json::json!({}))
        .as_object_mut()
        .ok_or("Telegram settings entry is not an object.")?;

    telegram.insert(
        "botToken".to_string(),
        serde_json::Value::String(token.to_string()),
    );

    let updated = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Cannot serialize settings: {e}"))?;
    fs::write(&path, updated).map_err(|e| format!("Cannot write settings: {e}"))?;

    let masked = if token.len() > 12 {
        format!("{}…{}", &token[..6], &token[token.len() - 6..])
    } else {
        "••••".to_string()
    };
    Ok(masked)
}

/// Write a pairing code to the bridge's pair-code file so the
/// running bridge picks it up and approves the user.
pub fn approve_pair_code(code: &str) -> Result<TelegramPairResult, String> {
    let path = pair_code_file_path().ok_or("Cannot find home directory.")?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create log directory: {e}"))?;
    }

    let normalized = code.trim().to_uppercase();
    if normalized.len() < 4 || normalized.len() > 6 {
        return Err("Pairing code must be 4–6 characters.".to_string());
    }
    if !normalized.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "Pairing code must contain only hexadecimal characters (0–9, A–F).".to_string(),
        );
    }

    fs::write(&path, &normalized).map_err(|e| format!("Cannot write pair code: {e}"))?;

    Ok(TelegramPairResult {
        ok: true,
        user_id: None,
        error: None,
    })
}

/// Return the last `tail_lines` lines from the bridge log.
pub fn read_bridge_log(tail_lines: usize) -> Vec<String> {
    let limit = tail_lines.max(1).min(200);
    let Some(path) = bridge_log_path() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = content
        .lines()
        .rev()
        .take(limit)
        .map(|l| l.to_string())
        .collect();
    lines.reverse();
    lines
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Print settings as JSON to stdout (for CLI use).
pub fn print_settings(settings: &TelegramSettings) {
    println!(
        "{}",
        serde_json::to_string_pretty(settings).unwrap_or_default()
    );
}

/// Print pair result as JSON to stdout.
pub fn print_pair_result(result: &TelegramPairResult) {
    println!(
        "{}",
        serde_json::to_string_pretty(result).unwrap_or_default()
    );
}

#[cfg(test)]
mod telegram_health_fast_path_tests {
    use super::*;

    #[test]
    fn matches_narrow_health_requests_only() {
        assert!(health_intent("is my Telegram bot healthy?"));
        assert!(health_intent("Telegram bridge status"));
        assert!(!health_intent("send a Telegram message"));
        assert!(!health_intent("debug why my Telegram bot is unhealthy"));
        assert!(!health_intent("is the website healthy?"));
    }

    #[test]
    fn response_contains_only_sanitized_sensor_summary() {
        let response = TelegramHealth {
            bridge_running: true,
            api_reachable: true,
            identity_present: true,
            approved_users: 2,
        }
        .response();
        assert_eq!(
            response,
            "HEALTHY — Telegram API identity verified, bridge running, and 2 approved users are configured."
        );
        assert!(!response.contains("token"));
    }
}

/// Print log lines to stdout.
pub fn print_log(lines: &[String]) {
    for line in lines {
        println!("{line}");
    }
}
