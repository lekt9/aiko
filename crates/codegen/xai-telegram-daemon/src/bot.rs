//! High-level bot: receives messages, dispatches actions, sends responses.
//!
//! Every incoming message that warrants action is registered as a contract task.
//! Outgoing messages use all available channel affordances: typing indicators,
//! MarkdownV2 formatting, inline keyboards, file uploads, voice.

use crate::api::TelegramApi;
use crate::types::*;
use std::process::Command;
use tracing::{info, warn};

/// The main bot: owns the API client and dispatch logic.
pub struct TelegramBot {
    api: TelegramApi,
    /// Chat IDs authorized to interact with this bot.
    authorized_chats: Vec<i64>,
}

impl TelegramBot {
    pub fn new(token: String, authorized_chats: Vec<i64>) -> Self {
        Self {
            api: TelegramApi::new(token),
            authorized_chats,
        }
    }

    /// Verify the bot identity and log it.
    pub async fn verify(&self) -> Result<(), TelegramError> {
        let me = self.api.get_me().await?;
        info!(
            "Bot verified: @{} (id: {}, name: {})",
            me.username.as_deref().unwrap_or("unknown"),
            me.id,
            me.first_name,
        );
        Ok(())
    }

    /// Check if a chat is authorized.
    pub fn is_authorized(&self, chat_id: i64) -> bool {
        self.authorized_chats.contains(&chat_id)
    }

    /// Handle a single incoming message. Returns true if we should continue polling.
    pub async fn handle_message(&self, msg: &Message) {
        let chat_id = msg.chat.id;
        if !self.is_authorized(chat_id) {
            warn!("Unauthorized chat {} attempted interaction", chat_id);
            return;
        }

        let user_name = msg
            .from
            .as_ref()
            .map(|u| u.first_name.clone())
            .unwrap_or_else(|| "unknown".to_string());

        info!("Message from {user_name} (chat {chat_id})");

        // Register as a contract task if it looks like a substantive request.
        if let Some(ref text) = msg.text {
            if text.len() > 3 && !text.starts_with('/') {
                self.register_contract_task(chat_id, text).await;
            }
        }

        // Handle file uploads: download and register.
        if let Some(ref document) = msg.document {
            self.handle_document(chat_id, document).await;
        }
        if let Some(ref voice) = msg.voice {
            self.handle_voice(chat_id, voice).await;
        }
    }

    /// Handle a callback query (inline button press).
    pub async fn handle_callback(&self, cb: &CallbackQuery) {
        let chat_id = cb.message.as_ref().map(|m| m.chat.id);
        let Some(chat_id) = chat_id else { return };

        if !self.is_authorized(chat_id) {
            return;
        }

        if let Some(ref data) = cb.data {
            info!("Callback from chat {chat_id}: {data}");
            // Acknowledge immediately so the button spinner stops.
            let _ = self
                .api
                .answer_callback_query(&cb.id, Some("Processing..."), false)
                .await;
        }
    }

    // ── Channel occupancy: typing indicators ─────────────────────

    /// Send a typing indicator then the message, with a natural-feeling delay.
    pub async fn send_with_typing(
        &self,
        chat_id: i64,
        text: &str,
        markup: Option<ReplyMarkup>,
    ) -> Result<Message, TelegramError> {
        // Fire-and-forget the typing indicator — if it fails we still send the message.
        let _ = self.api.send_chat_action(chat_id, ChatAction::Typing).await;

        // Brief delay so the indicator is visible (Telegram shows it for ~5s or until message).
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        self.api
            .send_message(&SendMessageRequest {
                chat_id,
                text: text.to_string(),
                parse_mode: Some("MarkdownV2".to_string()),
                reply_markup: markup,
                reply_to_message_id: None,
                disable_web_page_preview: Some(true),
                disable_notification: None,
                link_preview_options: None,
            })
            .await
    }

    /// Send a quick text message (no typing indicator, no markdown).
    pub async fn send_quick(&self, chat_id: i64, text: &str) -> Result<Message, TelegramError> {
        self.api
            .send_message(&SendMessageRequest {
                chat_id,
                text: text.to_string(),
                parse_mode: None,
                reply_markup: None,
                reply_to_message_id: None,
                disable_web_page_preview: Some(true),
                disable_notification: None,
                link_preview_options: None,
            })
            .await
    }

    /// Reply to a specific message with typing indicator and optional markup.
    pub async fn reply_with_typing(
        &self,
        chat_id: i64,
        reply_to: i64,
        text: &str,
        markup: Option<ReplyMarkup>,
    ) -> Result<Message, TelegramError> {
        let _ = self.api.send_chat_action(chat_id, ChatAction::Typing).await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        self.api
            .send_message(&SendMessageRequest {
                chat_id,
                text: text.to_string(),
                parse_mode: Some("MarkdownV2".to_string()),
                reply_markup: markup,
                reply_to_message_id: Some(reply_to),
                disable_web_page_preview: Some(true),
                disable_notification: None,
                link_preview_options: None,
            })
            .await
    }

    /// Indicate file upload, then send a photo.
    pub async fn send_photo_with_indicator(
        &self,
        chat_id: i64,
        photo_path: &str,
        caption: Option<&str>,
    ) -> Result<Message, TelegramError> {
        let _ = self
            .api
            .send_chat_action(chat_id, ChatAction::UploadPhoto)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        self.api
            .send_photo(chat_id, photo_path, caption, false)
            .await
    }

    /// Indicate document upload, then send a document.
    pub async fn send_document_with_indicator(
        &self,
        chat_id: i64,
        doc_path: &str,
        caption: Option<&str>,
    ) -> Result<Message, TelegramError> {
        let _ = self
            .api
            .send_chat_action(chat_id, ChatAction::UploadDocument)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        self.api
            .send_document(chat_id, doc_path, caption, false)
            .await
    }

    /// Indicate voice recording, then send a voice message.
    pub async fn send_voice_with_indicator(
        &self,
        chat_id: i64,
        voice_path: &str,
        caption: Option<&str>,
        duration: Option<i64>,
    ) -> Result<Message, TelegramError> {
        let _ = self
            .api
            .send_chat_action(chat_id, ChatAction::RecordVoice)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        self.api
            .send_voice(chat_id, voice_path, caption, duration)
            .await
    }

    /// Edit a message (for progressive updates).
    pub async fn edit_message(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
        markup: Option<ReplyMarkup>,
    ) -> Result<Message, TelegramError> {
        self.api
            .edit_message_text(
                chat_id,
                message_id,
                text,
                Some("MarkdownV2"),
                markup.as_ref(),
            )
            .await
    }

    // ── Inline keyboard builders ─────────────────────────────────

    /// Build a simple inline keyboard from a list of (label, callback_data) pairs.
    pub fn inline_keyboard(buttons: &[(&str, &str)]) -> ReplyMarkup {
        let rows: Vec<Vec<InlineKeyboardButton>> = buttons
            .chunks(2)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|(label, data)| InlineKeyboardButton {
                        text: label.to_string(),
                        url: None,
                        callback_data: Some(data.to_string()),
                        web_app: None,
                    })
                    .collect()
            })
            .collect();

        ReplyMarkup::InlineKeyboard(InlineKeyboardMarkup {
            inline_keyboard: rows,
        })
    }

    /// Build a reply keyboard (replaces the user's keyboard).
    pub fn reply_keyboard(buttons: &[&str], placeholder: Option<&str>) -> ReplyMarkup {
        let rows: Vec<Vec<KeyboardButton>> = buttons
            .chunks(3)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|label| KeyboardButton {
                        text: label.to_string(),
                        request_contact: None,
                        request_location: None,
                    })
                    .collect()
            })
            .collect();

        ReplyMarkup::ReplyKeyboard(ReplyKeyboardMarkup {
            keyboard: rows,
            resize_keyboard: Some(true),
            one_time_keyboard: Some(false),
            input_field_placeholder: placeholder.map(|s| s.to_string()),
        })
    }

    // ── Contract substrate ───────────────────────────────────────

    /// Register an incoming message as a contract task.
    async fn register_contract_task(&self, chat_id: i64, text: &str) {
        let goal = truncate_for_shell(text, 80);
        let check = format!("echo 'chat {chat_id} task registered'");

        match Command::new("contract")
            .args(["task", "begin", &goal, "--check", &check])
            .output()
        {
            Ok(out) => {
                if out.status.success() {
                    info!("Contract task registered: {goal}");
                } else {
                    warn!(
                        "Contract task registration failed: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                }
            }
            Err(e) => warn!("contract binary not available: {e}"),
        }
    }

    // ── File handling ────────────────────────────────────────────

    async fn handle_document(&self, chat_id: i64, doc: &Document) {
        info!(
            "Received document: {} ({} bytes)",
            doc.file_name.as_deref().unwrap_or("unnamed"),
            doc.file_size.unwrap_or(0),
        );

        if let Ok(file) = self.api.get_file(&doc.file_id).await {
            if let Some(ref file_path) = file.file_path {
                let dest = format!(
                    "/tmp/telegram_daemon_{}",
                    file_path.rsplit('/').next().unwrap_or("file")
                );
                if let Err(e) = self.api.download_file(file_path, &dest).await {
                    warn!("Failed to download document: {e}");
                } else {
                    info!("Document saved to {dest}");
                    let _ = self
                        .send_quick(chat_id, &format!("📎 Received: `{dest}`"))
                        .await;
                }
            }
        }
    }

    async fn handle_voice(&self, chat_id: i64, voice: &Voice) {
        info!(
            "Received voice message: {}s ({} bytes)",
            voice.duration,
            voice.file_size.unwrap_or(0),
        );

        if let Ok(file) = self.api.get_file(&voice.file_id).await {
            if let Some(ref file_path) = file.file_path {
                let dest = format!(
                    "/tmp/telegram_daemon_voice_{}",
                    file_path.rsplit('/').next().unwrap_or("voice.ogg")
                );
                if let Err(e) = self.api.download_file(file_path, &dest).await {
                    warn!("Failed to download voice message: {e}");
                } else {
                    info!("Voice saved to {dest}");
                    let _ = self
                        .send_quick(
                            chat_id,
                            &format!("🎤 Received voice message ({:.0}s)", voice.duration as f64),
                        )
                        .await;
                }
            }
        }
    }

    // ── API access ───────────────────────────────────────────────

    pub fn api(&self) -> &TelegramApi {
        &self.api
    }
}

/// Truncate a string for use as a shell argument (contract task goal).
fn truncate_for_shell(text: &str, max_len: usize) -> String {
    let cleaned: String = text
        .chars()
        .take(max_len)
        .map(|c| {
            if c == '"' || c == '\'' || c == '\\' || c == '`' {
                ' '
            } else {
                c
            }
        })
        .collect();
    cleaned.trim().to_string()
}
