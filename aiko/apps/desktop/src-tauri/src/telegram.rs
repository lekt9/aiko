use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSettings {
    pub bot_token: Option<String>,
    pub approved_user_ids: Vec<u64>,
    pub bridge_running: bool,
    pub bridge_log: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPairResult {
    pub ok: bool,
    pub user_id: Option<u64>,
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

#[cfg(target_os = "macos")]
fn bridge_running() -> bool {
    let output = Command::new("launchctl")
        .args([
            "print",
            &format!(
                "gui/{}/net.theclarityproject.aiko.telegram-bridge",
                unsafe { libc::getuid() }
            ),
        ])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains("state = running")
        }
        Err(_) => false,
    }
}

#[cfg(not(target_os = "macos"))]
fn bridge_running() -> bool {
    false
}

#[tauri::command]
pub fn get_telegram_settings() -> Result<TelegramSettings, String> {
    let path = user_settings_path().ok_or("Cannot find home directory.")?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("Cannot read settings: {e}"))?;
    let settings: UserSettings =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse settings: {e}"))?;

    let telegram = settings.telegram;
    let running = bridge_running();

    // Read last 20 lines of bridge log
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
        bot_token: telegram.as_ref().and_then(|t| t.bot_token.as_ref()).map(|t| {
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

#[tauri::command]
pub fn save_telegram_bot_token(token: String) -> Result<(), String> {
    let path = user_settings_path().ok_or("Cannot find home directory.")?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("Cannot read settings: {e}"))?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse settings: {e}"))?;

    let top = settings
        .as_object_mut()
        .ok_or("Settings root is not an object.")?;

    let telegram = top
        .entry("telegram")
        .or_insert(serde_json::json!({}))
        .as_object_mut()
        .ok_or("Telegram settings is not an object.")?;

    telegram.insert("botToken".to_string(), serde_json::Value::String(token));

    let updated = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Cannot serialize settings: {e}"))?;
    fs::write(&path, updated).map_err(|e| format!("Cannot write settings: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn approve_telegram_pair_code(code: String) -> Result<TelegramPairResult, String> {
    let path = pair_code_file_path().ok_or("Cannot find home directory.")?;

    // Ensure parent dir exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create log dir: {e}"))?;
    }

    let normalized = code.trim().to_uppercase();
    fs::write(&path, &normalized).map_err(|e| format!("Cannot write pair code: {e}"))?;

    Ok(TelegramPairResult {
        ok: true,
        user_id: None,
        error: None,
    })
}

#[tauri::command]
pub fn get_telegram_bridge_log(tail_lines: Option<usize>) -> Result<Vec<String>, String> {
    let limit = tail_lines.unwrap_or(20);
    let path = bridge_log_path().ok_or("Cannot find home directory.")?;
    let content = fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<String> = content
        .lines()
        .rev()
        .take(limit)
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Ok(lines)
}
