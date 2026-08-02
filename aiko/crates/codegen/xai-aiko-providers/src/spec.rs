//! Provider specification — declarative config for each provider.
//! Mirrors codegraff's `ProviderSpec` struct.

use crate::provider::{AuthStyle, ProviderKind};

/// One built-in or workspace-configured provider entry.
/// Mirrors codegraff's `provider.zig:ProviderSpec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSpec {
    /// Unique provider id (e.g. "codex", "xai", "anthropic").
    pub id: &'static str,
    /// Human-readable display name.
    pub display_name: &'static str,
    /// Wire format kind.
    pub kind: ProviderKind,
    /// Auth header style.
    pub auth: AuthStyle,
    /// API endpoint URL.
    pub url: &'static str,
    /// Environment variable that holds the API key.
    pub env_key: &'static str,
    /// Default model for this provider.
    pub default_model: &'static str,
}

impl ProviderSpec {
    /// Whether this provider URL points to localhost.
    pub fn is_local(&self) -> bool {
        self.url.starts_with("http://127.0.0.1")
            || self.url.starts_with("http://localhost")
            || self.url.starts_with("http://[::1]")
    }
}
