//! Telegram daemon binary entry point.
//!
//! Reads configuration from environment variables or ~/.aiko/user-settings.json:
//! - `TELEGRAM_BOT_TOKEN`: Bot token from @BotFather
//! - `TELEGRAM_AUTHORIZED_CHATS`: Comma-separated chat IDs
//! - `TELEGRAM_POLL_TIMEOUT` (optional, default 30): Long-poll timeout in seconds
//! - `TELEGRAM_POLL_LIMIT` (optional, default 10): Max updates per poll

use std::env;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;
use xai_telegram_daemon::daemon::{self, DaemonConfig};

fn settings_path() -> anyhow::Result<PathBuf> {
    let home = env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is unavailable"))?;
    Ok(PathBuf::from(home).join(".aiko").join("user-settings.json"))
}

fn load_file_settings() -> anyhow::Result<(String, Vec<i64>)> {
    let path = settings_path()?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| anyhow::anyhow!("cannot read {}: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let telegram = value
        .get("telegram")
        .ok_or_else(|| anyhow::anyhow!("Telegram is not configured"))?;
    let token = telegram
        .get("botToken")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("Telegram bot token is not configured"))?
        .to_string();
    let chats = telegram
        .get("approvedUserIds")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|id| i64::try_from(id).ok()))
        })
        .collect();
    Ok((token, chats))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing with RUST_LOG control.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,telegram_daemon=debug")),
        )
        .with_target(false)
        .init();

    let file_settings = load_file_settings();
    let token = env::var("TELEGRAM_BOT_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .or_else(|| file_settings.as_ref().ok().map(|(token, _)| token.clone()))
        .ok_or_else(|| anyhow::anyhow!("Telegram bot token is not configured"))?;
    let authorized_chats = match env::var("TELEGRAM_AUTHORIZED_CHATS") {
        Ok(chats_raw) => chats_raw
            .split(',')
            .map(|value| {
                value
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| anyhow::anyhow!("invalid chat ID"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Err(_) => file_settings.map(|(_, chats)| chats).unwrap_or_default(),
    };

    let poll_timeout: u32 = env::var("TELEGRAM_POLL_TIMEOUT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);

    let poll_limit: u32 = env::var("TELEGRAM_POLL_LIMIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let config = DaemonConfig {
        token,
        authorized_chats,
        poll_timeout,
        poll_limit,
    };

    daemon::run_daemon(config).await
}
