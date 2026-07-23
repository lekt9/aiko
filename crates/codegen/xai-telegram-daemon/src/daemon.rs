//! Long-running daemon: polls Telegram for updates, dispatches to the bot,
//! and survives transient failures.

use crate::bot::TelegramBot;
use crate::types::*;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

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

    // Verify the bot is alive before entering the poll loop.
    bot.verify().await?;

    info!(
        "Daemon started — polling every {}s (limit {})",
        config.poll_timeout, config.poll_limit,
    );

    let mut last_update_id: Option<i64> = None;

    loop {
        match poll_and_dispatch(
            &bot,
            &mut last_update_id,
            config.poll_timeout,
            config.poll_limit,
        )
        .await
        {
            Ok(updates_received) => {
                if updates_received > 0 {
                    info!("Processed {updates_received} updates");
                }
            }
            Err(e) => {
                warn!("Poll error: {e} — retrying in 3s");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

/// A single poll cycle: fetch updates, dispatch to bot, update cursor.
async fn poll_and_dispatch(
    bot: &TelegramBot,
    last_update_id: &mut Option<i64>,
    timeout: u32,
    limit: u32,
) -> Result<usize, TelegramError> {
    let offset = last_update_id.map(|id| id + 1);
    let updates = bot.api().get_updates(offset, timeout, limit).await?;

    let count = updates.len();

    for update in &updates {
        // Update the cursor to the highest seen update_id.
        let current = *last_update_id;
        if current.is_none() || Some(update.update_id) > current {
            *last_update_id = Some(update.update_id);
        }

        bot.handle_update(update).await;
    }

    Ok(count)
}
