//! Resolved provider — the concrete connection a request is sent with.
//! Mirrors codegraff's `provider.zig:Provider`.

/// Wire format kind. Mirrors codegraff's `Provider.Kind`.
/// - `Anthropic`: Messages API (`/v1/messages`)
/// - `OpenAi`: Chat Completions API (`/v1/chat/completions`)
/// - `Responses`: Codex Responses API (input items, not chat messages)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderKind {
    Anthropic,
    OpenAi,
    Responses,
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Anthropic => write!(f, "anthropic"),
            Self::OpenAi => write!(f, "openai"),
            Self::Responses => write!(f, "responses"),
        }
    }
}

/// Auth header style. Mirrors codegraff's `Provider.Auth`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStyle {
    /// `x-api-key: <key>`
    XApiKey,
    /// `Authorization: Bearer <key>`
    Bearer,
}

/// Where the API key came from. Mirrors codegraff's `Keys.CredentialSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    /// No credential found.
    None,
    /// Read from environment variable.
    Environment,
    /// Obtained via OAuth/login flow.
    Login,
    /// From secure store.
    Stored,
    /// Set this session only.
    Session,
}

impl CredentialSource {
    pub fn label(&self) -> &'static str {
        match self {
            Self::None => "missing",
            Self::Environment => "environment",
            Self::Login => "OAuth/login",
            Self::Stored => "secure store",
            Self::Session => "this session",
        }
    }
}

/// A resolved provider — the concrete connection a request is sent with.
/// Mirrors codegraff's `provider.zig:Provider`.
#[derive(Debug, Clone)]
pub struct Provider {
    /// Provider id (e.g. "codex", "xai", "anthropic").
    pub id: String,
    /// Wire format kind.
    pub kind: ProviderKind,
    /// Auth header style.
    pub auth: AuthStyle,
    /// API endpoint URL (may be overridden by GRAFF_CODEX_URL for codex).
    pub url: String,
    /// The API key.
    pub api_key: String,
    /// Selected model name.
    pub model: String,
    /// Context window in tokens.
    pub context: u64,
    /// ChatGPT account id (codex/responses only).
    pub account: String,
    /// How the api_key was obtained.
    pub source: CredentialSource,
}

impl Provider {
    /// Auto-compact threshold: the number of tokens past which the
    /// conversation should be compacted (default 80% of context window).
    /// Mirrors codegraff's `Provider.compactAt()`.
    pub fn compact_at(&self, pct_override: Option<u8>) -> u64 {
        let pct: u64 = pct_override.unwrap_or(80).min(100) as u64;
        self.context / 100 * pct
    }

    /// Whether the token count is near the context limit (95%).
    /// Mirrors codegraff's `Provider.nearContextLimit()`.
    pub fn near_context_limit(&self, tokens: u64) -> bool {
        if self.context == 0 {
            return false;
        }
        tokens >= self.context - (self.context / 20)
    }

    /// Absolute ceiling for a single tool output (bytes), regardless of window size.
    /// Mirrors codegraff's `Provider.perOutputCap()`.
    pub fn per_output_cap(&self) -> usize {
        const ABS_CAP: usize = 256 * 1024;
        if self.context == 0 {
            return 0;
        }
        let proportional: usize = (self.context / 2) as usize;
        proportional.min(ABS_CAP)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_provider() -> Provider {
        Provider {
            id: "test".into(),
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://example.com".into(),
            api_key: "key".into(),
            model: "test-model".into(),
            context: 100_000,
            account: String::new(),
            source: CredentialSource::Environment,
        }
    }

    #[test]
    fn test_compact_at_default() {
        let p = test_provider();
        assert_eq!(p.compact_at(None), 80_000);
    }

    #[test]
    fn test_compact_at_custom() {
        let p = test_provider();
        assert_eq!(p.compact_at(Some(70)), 70_000);
        assert_eq!(p.compact_at(Some(95)), 95_000);
        // Clamped to 100%
        assert_eq!(p.compact_at(Some(150)), 100_000);
    }

    #[test]
    fn test_compact_at_zero_context() {
        let mut p = test_provider();
        p.context = 0;
        assert_eq!(p.compact_at(None), 0);
    }

    #[test]
    fn test_near_context_limit() {
        let p = test_provider();
        assert!(!p.near_context_limit(94_999));
        assert!(p.near_context_limit(95_000));
        assert!(p.near_context_limit(u64::MAX));
    }

    #[test]
    fn test_near_context_limit_zero() {
        let mut p = test_provider();
        p.context = 0;
        assert!(!p.near_context_limit(u64::MAX));
    }

    #[test]
    fn test_per_output_cap() {
        let p = test_provider();
        assert_eq!(p.per_output_cap(), 50_000); // context/2 = 50000

        let mut big = test_provider();
        big.context = 4_000_000;
        assert_eq!(big.per_output_cap(), 256 * 1024); // absolute cap

        let mut zero = test_provider();
        zero.context = 0;
        assert_eq!(zero.per_output_cap(), 0); // disabled
    }

    #[test]
    fn test_credential_source_labels() {
        assert_eq!(CredentialSource::None.label(), "missing");
        assert_eq!(CredentialSource::Environment.label(), "environment");
        assert_eq!(CredentialSource::Login.label(), "OAuth/login");
        assert_eq!(CredentialSource::Stored.label(), "secure store");
        assert_eq!(CredentialSource::Session.label(), "this session");
    }

    #[test]
    fn test_provider_kind_display() {
        assert_eq!(ProviderKind::Anthropic.to_string(), "anthropic");
        assert_eq!(ProviderKind::OpenAi.to_string(), "openai");
        assert_eq!(ProviderKind::Responses.to_string(), "responses");
    }
}
