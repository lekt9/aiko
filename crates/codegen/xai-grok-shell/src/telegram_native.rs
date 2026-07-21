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

/// Print log lines to stdout.
pub fn print_log(lines: &[String]) {
    for line in lines {
        println!("{line}");
    }
}
