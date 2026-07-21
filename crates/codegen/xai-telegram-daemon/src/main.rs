//! Telegram daemon binary entry point.
//!
//! Reads configuration from environment variables:
//! - `TELEGRAM_BOT_TOKEN` (required): Bot token from @BotFather
//! - `TELEGRAM_AUTHORIZED_CHATS` (required): Comma-separated chat IDs
//! - `TELEGRAM_POLL_TIMEOUT` (optional, default 30): Long-poll timeout in seconds
//! - `TELEGRAM_POLL_LIMIT` (optional, default 10): Max updates per poll

use std::env;
use tracing_subscriber::EnvFilter;
use xai_telegram_daemon::daemon::{self, DaemonConfig};

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

    let token = env::var("TELEGRAM_BOT_TOKEN")
        .map_err(|_| anyhow::anyhow!("TELEGRAM_BOT_TOKEN environment variable is required"))?;

    let chats_raw = env::var("TELEGRAM_AUTHORIZED_CHATS").map_err(|_| {
        anyhow::anyhow!("TELEGRAM_AUTHORIZED_CHATS environment variable is required")
    })?;

    let authorized_chats: Vec<i64> = chats_raw
        .split(',')
        .map(|s| {
            s.trim()
                .parse::<i64>()
                .map_err(|_| anyhow::anyhow!("invalid chat ID: {s}"))
        })
        .collect::<Result<_, _>>()?;

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
