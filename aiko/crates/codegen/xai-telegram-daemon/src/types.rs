//! Telegram Bot API types — the subset needed for full channel occupancy.
//!
//! Covers: messages, chat actions, files, voice, inline keyboards, updates.

use serde::{Deserialize, Serialize};

// ── Update / long-polling ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct Update {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<Message>,
    #[serde(default)]
    pub edited_message: Option<Message>,
    #[serde(default)]
    pub callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetUpdatesResponse {
    pub ok: bool,
    #[serde(default)]
    pub result: Vec<Update>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub error_code: Option<i64>,
}

// ── Message ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub message_id: i64,
    pub date: i64,
    pub chat: Chat,
    #[serde(default)]
    pub from: Option<User>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub photo: Option<Vec<PhotoSize>>,
    #[serde(default)]
    pub document: Option<Document>,
    #[serde(default)]
    pub voice: Option<Voice>,
    #[serde(default)]
    pub audio: Option<Audio>,
    #[serde(default)]
    pub video: Option<Video>,
    #[serde(default)]
    pub sticker: Option<Sticker>,
    #[serde(default)]
    pub reply_to_message: Option<Box<Message>>,
    #[serde(default)]
    pub entities: Option<Vec<MessageEntity>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct User {
    pub id: i64,
    pub is_bot: bool,
    pub first_name: String,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub language_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageEntity {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub offset: usize,
    pub length: usize,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub user: Option<User>,
}

// ── Media types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct PhotoSize {
    pub file_id: String,
    pub file_unique_id: String,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Document {
    pub file_id: String,
    pub file_unique_id: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Voice {
    pub file_id: String,
    pub file_unique_id: String,
    pub duration: i64,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Audio {
    pub file_id: String,
    pub file_unique_id: String,
    pub duration: i64,
    #[serde(default)]
    pub performer: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Video {
    pub file_id: String,
    pub file_unique_id: String,
    pub width: i64,
    pub height: i64,
    pub duration: i64,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sticker {
    pub file_id: String,
    pub file_unique_id: String,
    #[serde(rename = "type")]
    pub sticker_type: String,
    pub width: i64,
    pub height: i64,
    pub is_animated: bool,
    pub is_video: bool,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct File {
    pub file_id: String,
    pub file_unique_id: String,
    #[serde(default)]
    pub file_size: Option<i64>,
    #[serde(default)]
    pub file_path: Option<String>,
}

// ── Callback queries ───────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct CallbackQuery {
    pub id: String,
    pub from: User,
    #[serde(default)]
    pub message: Option<Message>,
    #[serde(default)]
    pub inline_message_id: Option<String>,
    pub chat_instance: String,
    #[serde(default)]
    pub data: Option<String>,
}

// ── Send API request types ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SendMessageRequest {
    pub chat_id: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<ReplyMarkup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_web_page_preview: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_notification: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_preview_options: Option<LinkPreviewOptions>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkPreviewOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_disabled: Option<bool>,
}

// ── Reply markups ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ReplyMarkup {
    InlineKeyboard(InlineKeyboardMarkup),
    ReplyKeyboard(ReplyKeyboardMarkup),
    ReplyKeyboardRemove(ReplyKeyboardRemove),
    ForceReply(ForceReply),
}

#[derive(Debug, Clone, Serialize)]
pub struct InlineKeyboardMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InlineKeyboardButton {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_app: Option<WebAppInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebAppInfo {
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplyKeyboardMarkup {
    pub keyboard: Vec<Vec<KeyboardButton>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resize_keyboard: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_time_keyboard: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_field_placeholder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyboardButton {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_contact: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_location: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplyKeyboardRemove {
    pub remove_keyboard: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selective: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForceReply {
    pub force_reply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_field_placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selective: Option<bool>,
}

// ── Chat action (typing indicators) ────────────────────────────────

/// Actions sent via `sendChatAction` to show status in the chat UI.
#[derive(Debug, Clone, Copy)]
pub enum ChatAction {
    Typing,
    UploadPhoto,
    RecordVideo,
    UploadVideo,
    RecordVoice,
    UploadVoice,
    UploadDocument,
    ChooseSticker,
    FindLocation,
    RecordVideoNote,
    UploadVideoNote,
}

impl ChatAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatAction::Typing => "typing",
            ChatAction::UploadPhoto => "upload_photo",
            ChatAction::RecordVideo => "record_video",
            ChatAction::UploadVideo => "upload_video",
            ChatAction::RecordVoice => "record_voice",
            ChatAction::UploadVoice => "upload_voice",
            ChatAction::UploadDocument => "upload_document",
            ChatAction::ChooseSticker => "choose_sticker",
            ChatAction::FindLocation => "find_location",
            ChatAction::RecordVideoNote => "record_video_note",
            ChatAction::UploadVideoNote => "upload_video_note",
        }
    }
}

// ── API response wrappers ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
pub struct ApiResponse<T> {
    pub ok: bool,
    #[serde(default)]
    pub result: Option<T>,
    #[serde(default)]
    pub description: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn into_result(self) -> Result<T, TelegramError> {
        if self.ok {
            self.result.ok_or(TelegramError::MissingResult)
        } else {
            // Surface Telegram's description, including HTTP status hints.
            // Keep the message bounded (~400 chars) for log readability.
            let raw = self
                .description
                .unwrap_or_else(|| "unknown API error".into());
            let bounded: String = raw.chars().take(400).collect();
            Err(TelegramError::ApiError(bounded))
        }
    }
}

/// Lightweight check: does a raw HTTP body look like a GetUpdates JSON envelope?
/// Used to distinguish transient non-JSON (gateway HTML) from real API errors.
pub fn is_likely_get_updates_json(body: &str) -> bool {
    let trimmed = body.trim();
    trimmed.starts_with('{') && trimmed.contains("\"ok\"")
}

#[derive(Debug, thiserror::Error)]
pub enum TelegramError {
    #[error("API error: {0}")]
    ApiError(String),
    #[error("missing result in successful response")]
    MissingResult,
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BotCommand {
    pub command: String,
    pub description: String,
}

/// Shorthand for sendMessage response (returns the sent Message).
pub type SendMessageResponse = ApiResponse<Message>;
