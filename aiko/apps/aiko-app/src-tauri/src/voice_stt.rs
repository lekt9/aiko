//! Speech-to-text for Composer dictation (xAI STT).
//!
//! POST https://api.x.ai/v1/stt with Bearer token from official OAuth (`auth.json`)
//! or configured official API key. Relay-only installs report `not_available`.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::account;
use crate::providers::{self, ActiveRoute};
use crate::secrets;
use crate::voice_auth;

const STT_URL: &str = "https://api.x.ai/v1/stt";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatusDto {
    pub available: bool,
    /// Stable class when unavailable: `not_available`, …
    pub reason: Option<String>,
    pub auth_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscribeResult {
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
    pub error_class: Option<String>,
}

/// Resolve Bearer token for xAI STT (official only — not relay).
pub fn speech_auth_token() -> Option<(String, &'static str)> {
    if let Some(t) = account::speech_access_token() {
        return Some((t, "oauth"));
    }
    let secrets = secrets::load_secrets();
    if let Some(k) = secrets
        .official_api_key
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        return Some((k.clone(), "api_key"));
    }
    None
}

pub fn voice_status() -> VoiceStatusDto {
    // Custom / third-party providers cannot use xAI speech endpoints.
    if matches!(providers::active_route(), ActiveRoute::Custom { .. }) {
        return VoiceStatusDto {
            available: false,
            reason: Some("not_available".into()),
            auth_source: None,
        };
    }
    match speech_auth_token() {
        Some((_, src)) => VoiceStatusDto {
            available: true,
            reason: None,
            auth_source: Some(src.into()),
        },
        None => VoiceStatusDto {
            available: false,
            reason: Some("not_available".into()),
            auth_source: None,
        },
    }
}

/// Transcribe base64 audio via xAI STT. `filename` should include extension (e.g. audio.webm).
pub async fn voice_transcribe(
    audio_base64: String,
    filename: Option<String>,
    mime: Option<String>,
) -> VoiceTranscribeResult {
    let Some((token, _)) = speech_auth_token() else {
        return VoiceTranscribeResult {
            ok: false,
            text: None,
            error: Some("no speech auth (official login or API key required)".into()),
            error_class: Some("not_available".into()),
        };
    };

    let bytes = match base64::engine::general_purpose::STANDARD.decode(audio_base64.trim()) {
        Ok(b) => b,
        Err(e) => {
            return VoiceTranscribeResult {
                ok: false,
                text: None,
                error: Some(format!("invalid audio encoding: {e}")),
                error_class: Some("unknown".into()),
            };
        }
    };
    if bytes.is_empty() {
        return VoiceTranscribeResult {
            ok: false,
            text: None,
            error: Some("empty audio".into()),
            error_class: Some("no_speech".into()),
        };
    }

    let fname = filename
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "audio.webm".into());
    let mime = mime
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| guess_mime(&fname).into());

    let client = match crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(format!(
            "AikoApp/{} (desktop; voice-stt)",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return VoiceTranscribeResult {
                ok: false,
                text: None,
                error: Some(format!("http client: {e}")),
                error_class: Some("network".into()),
            };
        }
    };

    let part = match reqwest::multipart::Part::bytes(bytes)
        .file_name(fname.clone())
        .mime_str(&mime)
    {
        Ok(p) => p,
        Err(e) => {
            return VoiceTranscribeResult {
                ok: false,
                text: None,
                error: Some(format!("multipart: {e}")),
                error_class: Some("unknown".into()),
            };
        }
    };
    let form = reqwest::multipart::Form::new().part("file", part);

    let res = match client
        .post(STT_URL)
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let class = if e.is_timeout() { "timeout" } else { "network" };
            return VoiceTranscribeResult {
                ok: false,
                text: None,
                error: Some(format!("stt request: {e}")),
                error_class: Some(class.into()),
            };
        }
    };

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let class = if status.as_u16() == 401 || status.as_u16() == 403 {
            "auth"
        } else if status.as_u16() == 408 || status.as_u16() == 504 {
            "timeout"
        } else if status.is_server_error() {
            "network"
        } else {
            "unknown"
        };
        // Never echo full body if it might contain secrets; keep short.
        let snippet: String = body.chars().take(180).collect();
        return VoiceTranscribeResult {
            ok: false,
            text: None,
            error: Some(format!("stt HTTP {}: {snippet}", status.as_u16())),
            error_class: Some(class.into()),
        };
    }

    let text = extract_transcript(&body);
    if text.trim().is_empty() {
        return VoiceTranscribeResult {
            ok: false,
            text: None,
            error: Some("empty transcript".into()),
            error_class: Some("no_speech".into()),
        };
    }

    VoiceTranscribeResult {
        ok: true,
        text: Some(text.trim().to_string()),
        error: None,
        error_class: None,
    }
}

fn guess_mime(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".mp4") || lower.ends_with(".m4a") {
        "audio/mp4"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/webm"
    }
}

/// Parse STT JSON body for transcript text (several plausible shapes).
pub fn extract_transcript(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        // Plain text response
        return body.trim().to_string();
    };
    if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
        return t.to_string();
    }
    if let Some(t) = v.get("transcript").and_then(|x| x.as_str()) {
        return t.to_string();
    }
    if let Some(t) = v
        .pointer("/results/0/alternatives/0/transcript")
        .and_then(|x| x.as_str())
    {
        return t.to_string();
    }
    if let Some(arr) = v.get("segments").and_then(|x| x.as_array()) {
        let mut parts = Vec::new();
        for seg in arr {
            if let Some(t) = seg.get("text").and_then(|x| x.as_str()) {
                parts.push(t.trim());
            }
        }
        if !parts.is_empty() {
            return parts.join(" ");
        }
    }
    String::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttResult {
    pub text: String,
    pub duration: Option<f64>,
    pub language: Option<String>,
}

/// Transcribe a base64-encoded audio blob (wav/webm/mp3). Used by live voice / host.
pub async fn transcribe_base64(
    audio_b64: &str,
    mime: Option<&str>,
    language: Option<&str>,
) -> Result<SttResult, String> {
    if std::env::var("AIKO_APP_VOICE")
        .map(|v| v == "mock")
        .unwrap_or(false)
    {
        return Ok(SttResult {
            text: "mock transcript from voice dictation".into(),
            duration: Some(1.0),
            language: Some("en".into()),
        });
    }

    let token = voice_auth::resolve_bearer_token()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_b64.trim())
        .map_err(|e| format!("invalid audio base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty audio".into());
    }

    let (filename, content_type) = match mime.unwrap_or("") {
        m if m.contains("webm") => ("audio.webm", "audio/webm"),
        m if m.contains("ogg") => ("audio.ogg", "audio/ogg"),
        m if m.contains("mpeg") || m.contains("mp3") => ("audio.mp3", "audio/mpeg"),
        m if m.contains("mp4") || m.contains("m4a") => ("audio.m4a", "audio/mp4"),
        _ => ("audio.wav", "audio/wav"),
    };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(content_type)
        .map_err(|e| format!("multipart: {e}"))?;

    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(lang) = language.filter(|s| !s.is_empty()) {
        form = form
            .text("language", lang.to_string())
            .text("format", "true");
    }

    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(STT_URL)
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("STT request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("STT read body: {e}"))?;
    if !status.is_success() {
        let snippet: String = body.chars().take(240).collect();
        return Err(format!("STT HTTP {status}: {snippet}"));
    }

    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("STT JSON: {e}; body={body}"))?;
    let text = v
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(SttResult {
        text,
        duration: v.get("duration").and_then(|x| x.as_f64()),
        language: v
            .get("language")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_transcript_text_field() {
        assert_eq!(
            extract_transcript(r#"{"text":"hello world"}"#),
            "hello world"
        );
    }

    #[test]
    fn extract_transcript_segments() {
        let body = r#"{"segments":[{"text":"foo"},{"text":"bar"}]}"#;
        assert_eq!(extract_transcript(body), "foo bar");
    }

    #[test]
    fn extract_empty_object() {
        assert!(extract_transcript("{}").is_empty());
    }

    #[test]
    fn guess_mime_webm() {
        assert_eq!(guess_mime("a.webm"), "audio/webm");
        assert_eq!(guess_mime("a.mp3"), "audio/mpeg");
    }

    #[tokio::test]
    async fn transcribe_without_auth_is_not_available() {
        // When this machine has no official speech token, STT must fail closed.
        // If a token is present we only assert the call returns a structured result.
        let r = voice_transcribe("AAAA".into(), Some("t.webm".into()), None).await;
        if speech_auth_token().is_none() {
            assert!(!r.ok);
            assert_eq!(r.error_class.as_deref(), Some("not_available"));
        } else {
            // Invalid tiny base64 audio should not panic; either no_speech or decode/network.
            assert!(r.error_class.is_some() || r.ok);
        }
    }

    #[tokio::test]
    async fn mock_stt() {
        std::env::set_var("AIKO_APP_VOICE", "mock");
        let r = transcribe_base64("AAAA", Some("audio/wav"), Some("en"))
            .await
            .unwrap();
        assert!(r.text.contains("mock"));
        std::env::remove_var("AIKO_APP_VOICE");
    }
}
