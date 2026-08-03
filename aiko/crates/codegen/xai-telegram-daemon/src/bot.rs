//! High-level bot: receives messages, dispatches actions, sends responses.
//!
//! Every incoming message that warrants action is registered as a contract task.
//! Outgoing messages use all available channel affordances: typing indicators,
//! MarkdownV2 formatting, inline keyboards, file uploads, voice.

use crate::api::TelegramApi;
use crate::types::*;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tracing::{info, warn};

const RESPONSE_SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["text","voice","photo","document"]},"text":{"type":["string","null"]},"path":{"type":["string","null"]},"caption":{"type":["string","null"]}}}"#;
const INTERFACE_RULES: &str = "This is an authorized Telegram interface occurrence governed by Contract. Fulfill the user's request with currently authorized tools. Return one typed response. Use kind=text with text for normal replies; use voice/photo/document only when you created or selected a real local file and return its absolute path. Never include secrets. The daemon, not the model, performs the Telegram effect and records provider evidence.";

#[derive(Debug, Deserialize)]
struct AgentResponse {
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    caption: Option<String>,
}

struct ContractTask {
    id: String,
    evidence_path: PathBuf,
}

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

    /// Observe every update before authorization filtering, then dispatch it.
    pub async fn handle_update(&self, update: &Update) {
        let kind = if update.message.is_some() {
            "message"
        } else if update.edited_message.is_some() {
            "edited_message"
        } else if update.callback_query.is_some() {
            "callback_query"
        } else {
            "unknown"
        };
        let parent_id = self.observe_update(update.update_id, kind).await;
        if let Some(ref msg) = update.message {
            self.handle_message(update.update_id, msg, parent_id.as_deref())
                .await;
        } else if let Some(ref edited) = update.edited_message {
            info!(
                "Edited message from chat {} (durably observed)",
                edited.chat.id
            );
        } else if let Some(ref callback) = update.callback_query {
            self.handle_callback(callback).await;
        }
    }

    /// Handle a single incoming message under its observed Contract lineage.
    pub async fn handle_message(&self, update_id: i64, msg: &Message, parent_id: Option<&str>) {
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

        let prompt = if let Some(text) = msg.text.as_deref().filter(|text| !text.trim().is_empty())
        {
            Some(text.to_string())
        } else if let Some(document) = &msg.document {
            self.download_document(document).await.map(|path| {
                format!(
                    "The user sent a document at {}. {}",
                    path.display(),
                    msg.caption
                        .as_deref()
                        .unwrap_or("Inspect it and respond appropriately.")
                )
            })
        } else if let Some(voice) = &msg.voice {
            self.download_voice(voice)
                .await
                .map(|path| format!("The user sent a voice message at {}. Transcribe or inspect it with available tools, fulfill the request, and respond appropriately.", path.display()))
        } else {
            msg.caption.clone()
        };

        let Some(prompt) = prompt else {
            info!("Update {update_id} has no agent-routable content");
            return;
        };
        if let Err(error) = self
            .dispatch_agent_response(update_id, msg, parent_id, &prompt)
            .await
        {
            warn!("Telegram Contract dispatch failed for update {update_id}: {error}");
            let _ = self
                .reply_plain(
                    chat_id,
                    msg.message_id,
                    "I couldn't complete that request. The Contract occurrence remains available for retry.",
                )
                .await;
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

    async fn observe_update(&self, update_id: i64, kind: &str) -> Option<String> {
        let task = self
            .begin_contract_task(
                &format!("Observe Telegram update {update_id} ({kind})"),
                &format!("observe-{update_id}"),
            )
            .await?;
        let evidence = json!({
            "schema_version": 1,
            "source": "telegram",
            "update_id": update_id,
            "kind": kind,
            "observed": true
        });
        if write_evidence(&task.evidence_path, &evidence)
            .await
            .is_err()
        {
            return None;
        }
        self.verify_contract_task(&task.id).await.then_some(task.id)
    }

    async fn dispatch_agent_response(
        &self,
        update_id: i64,
        msg: &Message,
        parent_id: Option<&str>,
        prompt: &str,
    ) -> Result<(), TelegramError> {
        let task = self
            .begin_contract_task(
                &format!("Fulfill authorized Telegram request {update_id}"),
                &format!("response-{update_id}"),
            )
            .await
            .ok_or_else(|| TelegramError::ApiError("could not register Contract task".into()))?;

        let response = self
            .run_aiko_with_typing(msg.chat.id, prompt, parent_id.or(Some(&task.id)))
            .await?;
        let sent = match response.kind.as_str() {
            "voice" => {
                let path = response
                    .path
                    .as_deref()
                    .ok_or_else(|| TelegramError::ApiError("voice response missing path".into()))?;
                self.send_voice_with_indicator(msg.chat.id, path, response.caption.as_deref(), None)
                    .await?
            }
            "photo" => {
                let path = response
                    .path
                    .as_deref()
                    .ok_or_else(|| TelegramError::ApiError("photo response missing path".into()))?;
                self.send_photo_with_indicator(msg.chat.id, path, response.caption.as_deref())
                    .await?
            }
            "document" => {
                let path = response.path.as_deref().ok_or_else(|| {
                    TelegramError::ApiError("document response missing path".into())
                })?;
                self.send_document_with_indicator(msg.chat.id, path, response.caption.as_deref())
                    .await?
            }
            _ => {
                let text = response
                    .text
                    .as_deref()
                    .filter(|text| !text.trim().is_empty())
                    .ok_or_else(|| TelegramError::ApiError("text response missing text".into()))?;
                self.reply_plain(msg.chat.id, msg.message_id, text).await?
            }
        };

        write_evidence(
            &task.evidence_path,
            &json!({
                "schema_version": 1,
                "source": "telegram",
                "update_id": update_id,
                "response_kind": response.kind,
                "provider_message_id": sent.message_id,
                "provider_acknowledged": true
            }),
        )
        .await
        .map_err(|error| TelegramError::ApiError(format!("cannot write evidence: {error}")))?;
        if !self.verify_contract_task(&task.id).await {
            return Err(TelegramError::ApiError(
                "Telegram response sent but Contract verification failed".into(),
            ));
        }
        Ok(())
    }

    async fn run_aiko_with_typing(
        &self,
        chat_id: i64,
        prompt: &str,
        parent_id: Option<&str>,
    ) -> Result<AgentResponse, TelegramError> {
        let aiko = std::env::var("AIKO_BINARY").unwrap_or_else(|_| {
            dirs_home()
                .join("bin")
                .join("aiko")
                .to_string_lossy()
                .into_owned()
        });
        let cwd = std::env::var("AIKO_TELEGRAM_CWD")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home());
        let session_id = conversation_session_id("telegram", chat_id);
        let resume = session_exists(&session_id);
        let mut command = Command::new(aiko);
        command.args([
            "--cwd",
            &cwd.to_string_lossy(),
            "--no-auto-update",
            "--verbatim",
            "--no-subagents",
            "--output-format",
            "json",
            "--json-schema",
            RESPONSE_SCHEMA,
            "--rules",
            INTERFACE_RULES,
        ]);
        if resume {
            command.args(["--resume", &session_id]);
        } else {
            command.args(["--session-id", &session_id]);
        }
        command
            .args(["--single", prompt])
            .env("AIKO_CONTRACT_ROOT_ID", parent_id.unwrap_or(""))
            .env("AIKO_CONTRACT_PARENT_ID", parent_id.unwrap_or(""))
            .env("AIKO_CONTRACT_DEPTH", "1")
            .env("AIKO_CONTRACT_MAX_DEPTH", "4")
            .env("AIKO_CONTRACT_MAX_CHILDREN", "16")
            .env("AIKO_INTERFACE_FAMILY", "messaging")
            .env(
                "AIKO_CONVERSATION_ID",
                format!("messaging:telegram:{chat_id}"),
            )
            .kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|error| TelegramError::ApiError(format!("cannot start Aiko: {error}")))?;
        let output = child.wait_with_output();
        tokio::pin!(output);
        let mut typing = tokio::time::interval(Duration::from_secs(4));
        let output = loop {
            tokio::select! {
                result = &mut output => break result,
                _ = typing.tick() => {
                    let _ = self.api.send_chat_action(chat_id, ChatAction::Typing).await;
                }
            }
        }
        .map_err(|error| TelegramError::ApiError(format!("Aiko process failed: {error}")))?;
        if !output.status.success() {
            return Err(TelegramError::ApiError(format!(
                "Aiko exited with {}",
                output.status
            )));
        }
        parse_agent_response(&output.stdout)
            .ok_or_else(|| TelegramError::ApiError("Aiko returned no valid typed response".into()))
    }

    async fn begin_contract_task(&self, goal: &str, evidence_key: &str) -> Option<ContractTask> {
        let evidence_path = evidence_dir().join(format!("{evidence_key}.json"));
        let check = format!("test -s {}", evidence_path.to_string_lossy());
        let output = Command::new("contract")
            .args(["task", "begin", goal, "--check", &check])
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (id.len() == 8 && id.chars().all(|ch| ch.is_ascii_hexdigit()))
            .then_some(ContractTask { id, evidence_path })
    }

    async fn verify_contract_task(&self, id: &str) -> bool {
        Command::new("contract")
            .args(["task", "verify", id])
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }

    async fn reply_plain(
        &self,
        chat_id: i64,
        reply_to: i64,
        text: &str,
    ) -> Result<Message, TelegramError> {
        self.api
            .send_message(&SendMessageRequest {
                chat_id,
                text: text.to_string(),
                parse_mode: None,
                reply_markup: None,
                reply_to_message_id: Some(reply_to),
                disable_web_page_preview: Some(true),
                disable_notification: None,
                link_preview_options: None,
            })
            .await
    }

    // ── File handling ────────────────────────────────────────────

    async fn download_document(&self, doc: &Document) -> Option<PathBuf> {
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
                    return Some(PathBuf::from(dest));
                }
            }
        }
        None
    }

    async fn download_voice(&self, voice: &Voice) -> Option<PathBuf> {
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
                    return Some(PathBuf::from(dest));
                }
            }
        }
        None
    }

    // ── API access ───────────────────────────────────────────────

    pub fn api(&self) -> &TelegramApi {
        &self.api
    }
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn conversation_session_id(interface: &str, conversation: i64) -> String {
    fn fnv64(bytes: &[u8], seed: u64) -> u64 {
        bytes.iter().fold(seed, |hash, byte| {
            hash.wrapping_mul(0x100000001b3) ^ u64::from(*byte)
        })
    }
    let material = format!("{interface}:{conversation}");
    let high = fnv64(material.as_bytes(), 0xcbf29ce484222325);
    let low = fnv64(material.as_bytes(), 0x84222325cbf29ce4);
    let mut bytes = ((u128::from(high) << 64) | u128::from(low)).to_be_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let value = u128::from_be_bytes(bytes);
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (value >> 96) as u32,
        ((value >> 80) & 0xffff) as u16,
        ((value >> 64) & 0xffff) as u16,
        ((value >> 48) & 0xffff) as u16,
        value & 0xffffffffffff
    )
}

fn session_exists(session_id: &str) -> bool {
    let sessions = xai_grok_config::grok_home().join("sessions");
    std::fs::read_dir(sessions)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path().join(session_id))
        .any(|candidate| candidate.is_dir())
}

fn evidence_dir() -> PathBuf {
    dirs_home().join(".aiko").join("telegram").join("evidence")
}

async fn write_evidence(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_vec(value)?).await
}

fn parse_agent_response(bytes: &[u8]) -> Option<AgentResponse> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let structured = value
        .get("structuredOutput")
        .or_else(|| value.get("structured_output"))
        .unwrap_or(&value);
    serde_json::from_value(structured.clone()).ok()
}

#[cfg(test)]
mod contract_interface_tests {
    use super::*;

    #[test]
    fn parses_structured_text_response() {
        let response = parse_agent_response(
            br#"{"structuredOutput":{"kind":"text","text":"hello","path":null,"caption":null}}"#,
        )
        .expect("typed response");
        assert_eq!(response.kind, "text");
        assert_eq!(response.text.as_deref(), Some("hello"));
    }

    #[test]
    fn rejects_untyped_agent_output() {
        assert!(parse_agent_response(br#"{"text":"not an interface envelope"}"#).is_none());
    }

    #[test]
    fn evidence_paths_are_outside_contract_rows_and_payloads() {
        let path = evidence_dir().join("response-42.json");
        assert!(path.ends_with(".aiko/telegram/evidence/response-42.json"));
    }

    #[test]
    fn conversation_session_identity_is_stable_and_scoped() {
        let first = conversation_session_id("telegram", 108611440);
        assert_eq!(first, conversation_session_id("telegram", 108611440));
        assert_ne!(first, conversation_session_id("telegram", 108611441));
        assert_ne!(first, conversation_session_id("email", 108611440));
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "4");
    }
}
