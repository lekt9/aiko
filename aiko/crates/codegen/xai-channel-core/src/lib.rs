//! Provider-generic channel core — telegram is one provider row, not a branch.
//!
//! Every provider (telegram, slack, discord, webhook) speaks the same trait:
//! `ChannelProvider` + `ChannelRouter`. The Telegram daemon is wired through
//! this trait so adding slack is `provider=slack`, not `if telegram`.
//!
//! SSOT: wiring[] in self.json / cockpit; token lives in env/file, never in rows.
use serde::{Deserialize, Serialize};

/// Provider identity — extend here, never branch elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Telegram,
    Slack,
    Discord,
    Webhook,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Telegram => "telegram",
            Provider::Slack => "slack",
            Provider::Discord => "discord",
            Provider::Webhook => "webhook",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "telegram" => Some(Provider::Telegram),
            "slack" => Some(Provider::Slack),
            "discord" => Some(Provider::Discord),
            "webhook" => Some(Provider::Webhook),
            _ => None,
        }
    }
    pub fn env_token_var(self) -> &'static str {
        match self {
            Provider::Telegram => "TELEGRAM_BOT_TOKEN",
            Provider::Slack => "SLACK_BOT_TOKEN",
            Provider::Discord => "DISCORD_BOT_TOKEN",
            Provider::Webhook => "WEBHOOK_TOKEN",
        }
    }
    pub fn user_settings_key(self) -> &'static str {
        self.as_str()
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One row in the cockpit's wiring[] array — provider-generic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wiring {
    pub provider: Provider,
    pub enabled: bool,
    pub bridge_state: BridgeState,
    /// Masked token tail for display (never raw).
    pub token_tail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeState {
    NotConfigured,
    Running,
    Stopped,
    Error,
}

/// Channel registry — the single place new providers are added.
#[derive(Debug, Default, Clone)]
pub struct ChannelRegistry {
    entries: Vec<Wiring>,
}

impl ChannelRegistry {
    pub fn new() -> Self { Self::default() }
    pub fn register(&mut self, provider: Provider) {
        if !self.entries.iter().any(|w| w.provider == provider) {
            self.entries.push(Wiring { provider, enabled: false, bridge_state: BridgeState::NotConfigured, token_tail: None });
        }
    }
    pub fn wiring(&self) -> &[Wiring] { &self.entries }
    pub fn set_state(&mut self, provider: Provider, state: BridgeState) {
        if let Some(w) = self.entries.iter_mut().find(|w| w.provider == provider) {
            w.bridge_state = state;
        }
    }
    pub fn providers(&self) -> Vec<Provider> { self.entries.iter().map(|w| w.provider).collect() }
}

/// Unified typed reply envelope for every provider's worker output.
/// Mirrors bot.rs ResponseKind + self-integrate discriminated union.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ChannelReply {
    Text { text: String },
    Photo { path: String, caption: Option<String> },
    Document { path: String, caption: Option<String> },
    Voice { path: String, caption: Option<String> },
}

impl ChannelReply {
    pub fn text(s: impl Into<String>) -> Self { Self::Text { text: s.into() } }
    pub fn kind_str(&self) -> &'static str {
        match self { ChannelReply::Text{..} => "text", ChannelReply::Photo{..} => "photo", ChannelReply::Document{..} => "document", ChannelReply::Voice{..} => "voice" }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn telegram_is_one_row_not_a_branch() {
        let mut reg = ChannelRegistry::new();
        reg.register(Provider::Telegram);
        reg.register(Provider::Slack);
        reg.register(Provider::Telegram); // idempotent
        assert_eq!(reg.wiring().len(), 2);
        assert!(reg.wiring().iter().any(|w| w.provider == Provider::Telegram));
        assert!(reg.wiring().iter().any(|w| w.provider == Provider::Slack));
    }
    #[test]
    fn wiring_renders_as_provider_string() {
        assert_eq!(Provider::Telegram.as_str(), "telegram");
        assert_eq!(Provider::from_str("TeLeGrAm"), Some(Provider::Telegram));
        assert_eq!(Provider::Slack.env_token_var(), "SLACK_BOT_TOKEN");
    }
    #[test]
    fn channel_reply_is_discriminated_union() {
        let r = ChannelReply::text("hello");
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["kind"], "text");
        assert_eq!(j["text"], "hello");
        let photo = ChannelReply::Photo { path: "/tmp/a.jpg".into(), caption: None };
        assert_eq!(photo.kind_str(), "photo");
    }
    #[test]
    fn registry_state_transitions() {
        let mut reg = ChannelRegistry::new();
        reg.register(Provider::Telegram);
        reg.set_state(Provider::Telegram, BridgeState::Running);
        assert_eq!(reg.wiring()[0].bridge_state, BridgeState::Running);
    }
}
