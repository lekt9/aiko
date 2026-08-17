//! Long-running daemon: polls Telegram for updates, dispatches to the bot,
//! and survives transient failures.
//!
//! SSOT is the Contract ledger (contract/libcontract) — the Telegram offset
//! file is an ephemeral cursor, NOT a ledger. The only durable fact is the
//! Contract task + evidence under `contract task begin/verify`; the offset
//! merely avoids redundant getUpdates after a restart. Never promote the
//! offset, message text, or local history into a second durable store.
//!
//! Self-updating contract: the Telegram offset (next update_id) is persisted to
//! ~/.aiko/telegram/offset — the same file watcher.sh uses — so a daemon
//! restart or a native leader rotation (new ~/.aiko/native/api.json pid/token)
//! does not replay the same update with a stale Contract occurrence. The file
//! is the single shared cursor; both pollers cannot ACK past each other's
//! reservation.

use crate::bot::TelegramBot;
use crate::types::*;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

fn telegram_offset_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from).map(|home| home.join(".aiko").join("telegram").join("offset"))
}

fn read_persisted_offset() -> Option<i64> {
    let path = telegram_offset_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { return None; }
    let next: i64 = trimmed.parse().ok()?;
    if next <= 0 { return None; }
    Some(next - 1)
}

fn persist_offset(last_id: Option<i64>) {
    let Some(path) = telegram_offset_path() else { return; };
    let Some(last) = last_id else { return; };
    let next = last + 1;
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    let tmp = path.with_extension(format!("offset.tmp.{}", std::process::id()));
    if std::fs::write(&tmp, format!("{next}\n")).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    } else { let _ = std::fs::remove_file(&tmp); }
}

/// Configuration for the daemon.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Telegram bot token.
    pub token: String,
    /// Authorized chat IDs.
    pub authorized_chats: Vec<i64>,
    /// Long-poll timeout in seconds (Telegram max is ~100).
    pub poll_timeout: u32,
    /// How many updates to fetch at once.
    pub poll_limit: u32,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            token: String::new(),
            authorized_chats: vec![],
            poll_timeout: 30,
            poll_limit: 10,
        }
    }
}

/// Run the long-polling daemon. Spawns the bot and loops forever.
pub async fn run_daemon(config: DaemonConfig) -> anyhow::Result<()> {
    let bot = Arc::new(TelegramBot::new(config.token, config.authorized_chats));
    bot.verify().await?;
    info!("Daemon started — polling every {}s (limit {})", config.poll_timeout, config.poll_limit,);
    let mut last_update_id: Option<i64> = read_persisted_offset();
    if let Some(last) = last_update_id { info!("Resumed from persisted offset {}", last + 1); }
    loop {
        match poll_and_dispatch(&bot, &mut last_update_id, config.poll_timeout, config.poll_limit).await {
            Ok(updates_received) => {
                if updates_received > 0 { info!("Processed {updates_received} updates"); }
                persist_offset(last_update_id);
            }
            Err(e) => {
                warn!("Poll error: {e} — retrying in 3s");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

/// A single poll cycle: fetch updates, dispatch to bot, update cursor.
async fn poll_and_dispatch(bot: &TelegramBot, last_update_id: &mut Option<i64>, timeout: u32, limit: u32) -> Result<usize, TelegramError> {
    let offset = last_update_id.map(|id| id + 1);
    let updates = bot.api().get_updates(offset, timeout, limit).await?;
    let count = updates.len();
    for update in &updates {
        let current = *last_update_id;
        if current.is_none() || Some(update.update_id) > current {
            *last_update_id = Some(update.update_id);
        }
        persist_offset(*last_update_id);
        bot.handle_update(update).await;
        persist_offset(*last_update_id);
    }
    Ok(count)
}
