//! Raw Telegram Bot API HTTP client.
//!
//! Every method maps 1:1 to a Bot API endpoint. Multipart uploads for files,
//! JSON for everything else. No retry logic here — the daemon loop handles that.

use crate::types::*;
use reqwest::multipart;

const API_BASE: &str = "https://api.telegram.org";

pub struct TelegramApi {
    token: String,
    client: reqwest::Client,
}

impl TelegramApi {
    pub fn new(token: String) -> Self {
        Self {
            token,
            client: reqwest::Client::new(),
        }
    }

    fn endpoint(&self, method: &str) -> String {
        format!("{API_BASE}/bot{}/{}", self.token, method)
    }

    // ── Core messaging ──────────────────────────────────────────

    /// Send a text message with optional parse mode and reply markup.
    pub async fn send_message(&self, req: &SendMessageRequest) -> Result<Message, TelegramError> {
        let resp: SendMessageResponse = self
            .client
            .post(self.endpoint("sendMessage"))
            .json(req)
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Send a chat action (typing indicator, upload notification, etc.).
    pub async fn send_chat_action(
        &self,
        chat_id: i64,
        action: ChatAction,
    ) -> Result<bool, TelegramError> {
        let resp: ApiResponse<bool> = self
            .client
            .post(self.endpoint("sendChatAction"))
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "action": action.as_str(),
            }))
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Answer a callback query (removes the loading spinner on inline buttons).
    pub async fn answer_callback_query(
        &self,
        callback_query_id: &str,
        text: Option<&str>,
        show_alert: bool,
    ) -> Result<bool, TelegramError> {
        let mut body = serde_json::json!({
            "callback_query_id": callback_query_id,
        });
        if let Some(t) = text {
            body["text"] = serde_json::json!(t);
            body["show_alert"] = serde_json::json!(show_alert);
        }
        let resp: ApiResponse<bool> = self
            .client
            .post(self.endpoint("answerCallbackQuery"))
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    // ── File uploads ────────────────────────────────────────────

    /// Send a photo from a local file path or by file_id.
    pub async fn send_photo(
        &self,
        chat_id: i64,
        photo: &str,
        caption: Option<&str>,
        is_file_id: bool,
    ) -> Result<Message, TelegramError> {
        if is_file_id {
            let resp: ApiResponse<Message> = self
                .client
                .post(self.endpoint("sendPhoto"))
                .json(&serde_json::json!({
                    "chat_id": chat_id,
                    "photo": photo,
                    "caption": caption.unwrap_or(""),
                }))
                .send()
                .await?
                .json()
                .await?;
            resp.into_result()
        } else {
            let file_bytes = tokio::fs::read(photo)
                .await
                .map_err(|e| TelegramError::ApiError(format!("failed to read photo file: {e}")))?;
            let part = multipart::Part::bytes(file_bytes)
                .file_name(photo.rsplit('/').next().unwrap_or("photo.jpg").to_string());
            let mut form = multipart::Form::new()
                .text("chat_id", chat_id.to_string())
                .part("photo", part);
            if let Some(c) = caption {
                form = form.text("caption", c.to_string());
            }
            let resp: ApiResponse<Message> = self
                .client
                .post(self.endpoint("sendPhoto"))
                .multipart(form)
                .send()
                .await?
                .json()
                .await?;
            resp.into_result()
        }
    }

    /// Send a document from a local file path or by file_id.
    pub async fn send_document(
        &self,
        chat_id: i64,
        document: &str,
        caption: Option<&str>,
        is_file_id: bool,
    ) -> Result<Message, TelegramError> {
        if is_file_id {
            let resp: ApiResponse<Message> = self
                .client
                .post(self.endpoint("sendDocument"))
                .json(&serde_json::json!({
                    "chat_id": chat_id,
                    "document": document,
                    "caption": caption.unwrap_or(""),
                }))
                .send()
                .await?
                .json()
                .await?;
            resp.into_result()
        } else {
            let file_bytes = tokio::fs::read(document).await.map_err(|e| {
                TelegramError::ApiError(format!("failed to read document file: {e}"))
            })?;
            let filename = document.rsplit('/').next().unwrap_or("file");
            let part = multipart::Part::bytes(file_bytes).file_name(filename.to_string());
            let mut form = multipart::Form::new()
                .text("chat_id", chat_id.to_string())
                .part("document", part);
            if let Some(c) = caption {
                form = form.text("caption", c.to_string());
            }
            let resp: ApiResponse<Message> = self
                .client
                .post(self.endpoint("sendDocument"))
                .multipart(form)
                .send()
                .await?
                .json()
                .await?;
            resp.into_result()
        }
    }

    /// Send a voice message (OGG/OPUS) from a local file path.
    pub async fn send_voice(
        &self,
        chat_id: i64,
        voice: &str,
        caption: Option<&str>,
        duration: Option<i64>,
    ) -> Result<Message, TelegramError> {
        let file_bytes = tokio::fs::read(voice)
            .await
            .map_err(|e| TelegramError::ApiError(format!("failed to read voice file: {e}")))?;
        let filename = voice.rsplit('/').next().unwrap_or("voice.ogg");
        let part = multipart::Part::bytes(file_bytes).file_name(filename.to_string());
        let mut form = multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part("voice", part);
        if let Some(c) = caption {
            form = form.text("caption", c.to_string());
        }
        if let Some(d) = duration {
            form = form.text("duration", d.to_string());
        }
        let resp: ApiResponse<Message> = self
            .client
            .post(self.endpoint("sendVoice"))
            .multipart(form)
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Send an audio file from a local path.
    pub async fn send_audio(
        &self,
        chat_id: i64,
        audio: &str,
        caption: Option<&str>,
        title: Option<&str>,
        performer: Option<&str>,
    ) -> Result<Message, TelegramError> {
        let file_bytes = tokio::fs::read(audio)
            .await
            .map_err(|e| TelegramError::ApiError(format!("failed to read audio file: {e}")))?;
        let filename = audio.rsplit('/').next().unwrap_or("audio.mp3");
        let part = multipart::Part::bytes(file_bytes).file_name(filename.to_string());
        let mut form = multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part("audio", part);
        if let Some(c) = caption {
            form = form.text("caption", c.to_string());
        }
        if let Some(t) = title {
            form = form.text("title", t.to_string());
        }
        if let Some(p) = performer {
            form = form.text("performer", p.to_string());
        }
        let resp: ApiResponse<Message> = self
            .client
            .post(self.endpoint("sendAudio"))
            .multipart(form)
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Send a video from a local file path or by file_id.
    pub async fn send_video(
        &self,
        chat_id: i64,
        video: &str,
        caption: Option<&str>,
        is_file_id: bool,
    ) -> Result<Message, TelegramError> {
        if is_file_id {
            let resp: ApiResponse<Message> = self
                .client
                .post(self.endpoint("sendVideo"))
                .json(&serde_json::json!({
                    "chat_id": chat_id,
                    "video": video,
                    "caption": caption.unwrap_or(""),
                }))
                .send()
                .await?
                .json()
                .await?;
            resp.into_result()
        } else {
            let file_bytes = tokio::fs::read(video)
                .await
                .map_err(|e| TelegramError::ApiError(format!("failed to read video file: {e}")))?;
            let filename = video.rsplit('/').next().unwrap_or("video.mp4");
            let part = multipart::Part::bytes(file_bytes).file_name(filename.to_string());
            let mut form = multipart::Form::new()
                .text("chat_id", chat_id.to_string())
                .part("video", part);
            if let Some(c) = caption {
                form = form.text("caption", c.to_string());
            }
            let resp: ApiResponse<Message> = self
                .client
                .post(self.endpoint("sendVideo"))
                .multipart(form)
                .send()
                .await?
                .json()
                .await?;
            resp.into_result()
        }
    }

    // ── Edit / delete ───────────────────────────────────────────

    /// Edit an existing message text.
    pub async fn edit_message_text(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
        parse_mode: Option<&str>,
        reply_markup: Option<&ReplyMarkup>,
    ) -> Result<Message, TelegramError> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
        });
        if let Some(pm) = parse_mode {
            body["parse_mode"] = serde_json::json!(pm);
        }
        if let Some(rm) = reply_markup {
            body["reply_markup"] = serde_json::to_value(rm).unwrap_or_default();
        }
        let resp: ApiResponse<Message> = self
            .client
            .post(self.endpoint("editMessageText"))
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Delete a message.
    pub async fn delete_message(
        &self,
        chat_id: i64,
        message_id: i64,
    ) -> Result<bool, TelegramError> {
        let resp: ApiResponse<bool> = self
            .client
            .post(self.endpoint("deleteMessage"))
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "message_id": message_id,
            }))
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    // ── File download ───────────────────────────────────────────

    /// Get file info (including download path).
    pub async fn get_file(&self, file_id: &str) -> Result<File, TelegramError> {
        let resp: ApiResponse<File> = self
            .client
            .post(self.endpoint("getFile"))
            .json(&serde_json::json!({ "file_id": file_id }))
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Download a file to a local path given its telegram file_path.
    pub async fn download_file(
        &self,
        file_path: &str,
        destination: &str,
    ) -> Result<(), TelegramError> {
        let url = format!("{API_BASE}/file/bot{}/{}", self.token, file_path);
        let bytes = self.client.get(&url).send().await?.bytes().await?;
        tokio::fs::write(destination, &bytes).await.map_err(|e| {
            TelegramError::ApiError(format!("failed to write downloaded file: {e}"))
        })?;
        Ok(())
    }

    // ── Long-polling ────────────────────────────────────────────

    /// Get updates via long-polling. Blocks until updates arrive or timeout.
    /// Hardened: Telegram occasionally returns non-JSON (502 HTML, empty body,
    /// nginx errors) which previously surfaced as "error decoding response body"
    /// every 3s. This now reads the body as text, logs a snippet, and treats
    /// empty/transient HTML as an empty poll rather than a hard decode error.
    pub async fn get_updates(
        &self,
        offset: Option<i64>,
        timeout: u32,
        limit: u32,
    ) -> Result<Vec<Update>, TelegramError> {
        let mut params = vec![
            ("timeout", timeout.to_string()),
            ("limit", limit.to_string()),
        ];
        if let Some(o) = offset {
            params.push(("offset", o.to_string()));
        }
        let http_resp = self
            .client
            .post(self.endpoint("getUpdates"))
            .form(&params)
            .send()
            .await?;
        let status = http_resp.status();
        let body = http_resp.text().await.map_err(|e| {
            TelegramError::ApiError(format!("getUpdates read body failed: {e}"))
        })?;
        // Attempt to parse the body as JSON; Telegram always returns JSON on success.
        match serde_json::from_str::<GetUpdatesResponse>(&body) {
            Ok(parsed) => {
                if parsed.ok {
                    Ok(parsed.result)
                } else {
                    let desc = parsed
                        .description
                        .unwrap_or_else(|| format!("getUpdates failed: HTTP {}", status));
                    // 409 Conflict means another getUpdates holder (e.g. leaked token
                    // being polled elsewhere). Treat as transient empty poll with
                    // jitter — don't spin a tight 3s error loop and don't lose offset.
                    if desc.contains("Conflict") || status.as_u16() == 409 {
                        // Another getUpdates holder (self-wire Smithers host,
                        // desktop bridge, or a leaked token elsewhere) owns
                        // the slot. Sleep before the daemon loops or we tight-
                        // poll 409s and starve the inbox.
                        tracing::warn!("getUpdates Conflict (another poller holds slot) — backing off 15s");
                        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                        return Ok(Vec::new());
                    }
                    Err(TelegramError::ApiError(desc))
                }
            }
            Err(parse_err) => {
                let snippet: String = body.chars().take(400).collect();
                tracing::warn!(
                    "getUpdates non-JSON body (status {}): snippet={:?} parse_err={}",
                    status,
                    snippet,
                    parse_err
                );
                // Empty body or HTML gateway errors are transient — treat as empty poll
                // so the daemon doesn't spin a tight error loop. Real API errors
                // (invalid token etc.) will be JSON with ok=false and are handled above.
                if body.trim().is_empty() || body.trim_start().starts_with('<') {
                    Ok(Vec::new())
                } else {
                    Err(TelegramError::ApiError(format!(
                        "getUpdates decode failed (status {}): {} — snippet: {}",
                        status, parse_err, snippet
                    )))
                }
            }
        }
    }

    // ── Bot info ────────────────────────────────────────────────

    /// Verify the bot token and get bot identity.
    pub async fn get_me(&self) -> Result<User, TelegramError> {
        let resp: ApiResponse<User> = self
            .client
            .get(self.endpoint("getMe"))
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Register slash commands for autocomplete.
    pub async fn set_my_commands(&self, commands: &[(&str, &str)]) -> Result<bool, TelegramError> {
        let body = serde_json::json!({
            "commands": commands.iter().map(|(c, d)| serde_json::json!({"command": c, "description": d})).collect::<Vec<_>>()
        });
        let resp: ApiResponse<bool> = self
            .client
            .post(self.endpoint("setMyCommands"))
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Fetch currently registered commands.
    pub async fn get_my_commands(&self) -> Result<Vec<BotCommand>, TelegramError> {
        let resp: ApiResponse<Vec<BotCommand>> = self
            .client
            .get(self.endpoint("getMyCommands"))
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }

    /// Remove webhook (switch to polling).
    pub async fn delete_webhook(&self) -> Result<bool, TelegramError> {
        let resp: ApiResponse<bool> = self
            .client
            .post(self.endpoint("deleteWebhook"))
            .json(&serde_json::json!({}))
            .send()
            .await?
            .json()
            .await?;
        resp.into_result()
    }
}
