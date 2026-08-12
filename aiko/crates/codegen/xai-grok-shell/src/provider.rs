//! Provider configuration — which upstream LLM provider's API is in use.
//!
//! Determines billing URLs, credit-limit messaging, subscription tier display
//! names, and system prompt branding. Resolved from the `AIKO_PROVIDER`
//! environment variable (`codegraff` or `grok`), defaulting to `codegraff`.
//!
//! The gateway proxy (`aiko.theclarityproject.net`) is provider-neutral;
//! this module controls the user-facing surface only — messages, URLs, labels.

use serde::{Deserialize, Serialize};

/// Which upstream LLM provider's API is in use.
///
/// Controls billing URLs, credit-limit messaging, and system prompt branding.
/// Resolved from `AIKO_PROVIDER` env var (default: `codegraff`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Codegraff,
    Grok,
}

impl Provider {
    /// Resolve the active provider from the environment variable `AIKO_PROVIDER`.
    ///
    /// Accepted values: `codegraff`, `grok`. Anything else (including absent)
    /// defaults to `Codegraff`.
    pub fn from_env() -> Self {
        match std::env::var("AIKO_PROVIDER").ok().as_deref() {
            Some("grok") => Provider::Grok,
            _ => Provider::Codegraff,
        }
    }

    /// Human-readable display name — used in system prompt identity, credit
    /// messages, and anywhere the provider is named in user-facing text.
    pub fn display_name(&self) -> &'static str {
        match self {
            Provider::Codegraff => "Codegraff",
            Provider::Grok => "Aiko",
        }
    }

    /// Provider home page URL.
    pub fn home_url(&self) -> &'static str {
        match self {
            Provider::Codegraff => "https://codegraff.com",
            Provider::Grok => "https://grok.com",
        }
    }

    /// URL for upgrading subscription tier / purchasing a plan.
    pub fn upgrade_url(&self) -> &'static str {
        match self {
            Provider::Codegraff => "https://codegraff.com/pricing",
            Provider::Grok => "https://grok.com/supergrok?referrer=grok-build",
        }
    }

    /// URL for managing pay-as-you-go / on-demand spending / purchasing credits.
    pub fn usage_url(&self) -> &'static str {
        match self {
            Provider::Codegraff => "https://codegraff.com/usage",
            Provider::Grok => "https://grok.com?_s=usage",
        }
    }

    /// System prompt identity label: "You are `<label>` released by …".
    pub fn system_prompt_label(&self) -> &'static str {
        self.display_name()
    }

    /// Display name for the premium (non-max) subscription tier.
    pub fn premium_tier_display(&self) -> &'static str {
        match self {
            Provider::Codegraff => "Codegraff Pro",
            Provider::Grok => "SuperGrok",
        }
    }

    /// Display name for the highest subscription tier.
    pub fn max_tier_display(&self) -> &'static str {
        match self {
            Provider::Codegraff => "Codegraff Heavy",
            Provider::Grok => "SuperGrok Heavy",
        }
    }

    /// Free-usage exhaustion user message (shown when free quota runs out).
    /// Includes the upgrade URL inline.
    pub fn free_usage_message(&self) -> String {
        let name = self.display_name();
        let premium = self.premium_tier_display();
        let url = self.upgrade_url();
        format!(
            "You\u{2019}ve reached your free {name} usage limit for now. \
             Get {premium} for much higher limits, or try again later: {url}"
        )
    }

    /// Rate-limit message for OAuth/session-based auth (personal plan upgrade).
    pub fn rate_limited_message_oauth(&self) -> String {
        "You\u{2019}ve hit the rate limit for your plan. \
         Upgrade your account or try again later."
            .to_string()
    }

    /// Rate-limit message for API key / team auth.
    pub fn rate_limited_message_api_key(&self) -> String {
        let name = self.display_name();
        format!(
            "You\u{2019}ve hit your team\u{2019}s API rate limit. \
             Ask a team admin to purchase more credits for higher limits, \
             or try again later. See {}/docs/rate-limits",
            self.home_url()
        )
    }

    /// Whether a server detail string is pushing a consumer subscription upsell
    /// for this provider (i.e., telling a team/API-key user to buy a personal plan).
    pub fn is_consumer_subscription_upsell(&self, detail: &str) -> bool {
        let d = detail.to_ascii_lowercase();
        match self {
            Provider::Codegraff => {
                d.contains("codegraff.com/pricing")
                    || d.contains("upgrade to a codegraff subscription")
            }
            Provider::Grok => {
                d.contains("grok.com/supergrok") || d.contains("upgrade to a grok subscription")
            }
        }
    }

    /// Whether a 403 message indicates a subscription requirement for this provider.
    ///
    /// Matches both Grok and Codegraff patterns regardless of active provider,
    /// since the gateway proxy may return provider-specific messages from its
    /// upstream backend.
    pub fn is_subscription_required(&self, message: &str) -> bool {
        let m = message.to_ascii_lowercase();
        m.contains("requires a grok subscription")
            || m.contains("requires a codegraff subscription")
    }

    /// Stable backend key for the max subscription tier — used to match
    /// against the billing backend's `subscription_tier` field.
    /// The backend may return provider-specific tier keys.
    pub fn max_tier_key(&self) -> &'static str {
        match self {
            Provider::Codegraff => "codegraff_heavy",
            Provider::Grok => "supergrok_heavy",
        }
    }

    /// Check whether a backend subscription tier string matches the max tier.
    pub fn is_max_tier(&self, subscription_tier: Option<&str>) -> bool {
        let Some(t) = subscription_tier else {
            return false;
        };
        let normalized = t.to_ascii_lowercase().replace(' ', "_");
        normalized == self.max_tier_key()
    }
}

impl Default for Provider {
    fn default() -> Self {
        Provider::Codegraff
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_codegraff() {
        assert_eq!(Provider::default(), Provider::Codegraff);
    }

    #[test]
    fn from_env_defaults_to_codegraff() {
        // No env set → Codegraff.
        // SAFETY: test-only, serial_test ensures no concurrent env mutation.
        unsafe { std::env::remove_var("AIKO_PROVIDER") };
        assert_eq!(Provider::from_env(), Provider::Codegraff);
    }

    #[test]
    fn from_env_parses_grok() {
        unsafe { std::env::set_var("AIKO_PROVIDER", "grok") };
        assert_eq!(Provider::from_env(), Provider::Grok);
        unsafe { std::env::remove_var("AIKO_PROVIDER") };
    }

    #[test]
    fn from_env_parses_codegraff() {
        unsafe { std::env::set_var("AIKO_PROVIDER", "codegraff") };
        assert_eq!(Provider::from_env(), Provider::Codegraff);
        unsafe { std::env::remove_var("AIKO_PROVIDER") };
    }

    #[test]
    fn unknown_value_defaults_to_codegraff() {
        unsafe { std::env::set_var("AIKO_PROVIDER", "openai") };
        assert_eq!(Provider::from_env(), Provider::Codegraff);
        unsafe { std::env::remove_var("AIKO_PROVIDER") };
    }

    #[test]
    fn grok_provider_urls() {
        let p = Provider::Grok;
        assert_eq!(p.home_url(), "https://grok.com");
        assert!(p.upgrade_url().contains("grok.com/supergrok"));
        assert!(p.usage_url().contains("grok.com?_s=usage"));
    }

    #[test]
    fn codegraff_provider_urls() {
        let p = Provider::Codegraff;
        assert_eq!(p.home_url(), "https://codegraff.com");
        assert!(p.upgrade_url().contains("codegraff.com/pricing"));
        assert!(p.usage_url().contains("codegraff.com/usage"));
    }

    #[test]
    fn tier_display_names() {
        let g = Provider::Grok;
        assert_eq!(g.premium_tier_display(), "SuperGrok");
        assert_eq!(g.max_tier_display(), "SuperGrok Heavy");

        let c = Provider::Codegraff;
        assert_eq!(c.premium_tier_display(), "Codegraff Pro");
        assert_eq!(c.max_tier_display(), "Codegraff Heavy");
    }

    #[test]
    fn is_max_tier_matches() {
        let g = Provider::Grok;
        assert!(g.is_max_tier(Some("supergrok_heavy")));
        assert!(g.is_max_tier(Some("SuperGrok Heavy"))); // with spaces
        assert!(!g.is_max_tier(Some("supergrok")));
        assert!(!g.is_max_tier(None));

        let c = Provider::Codegraff;
        assert!(c.is_max_tier(Some("codegraff_heavy")));
        assert!(c.is_max_tier(Some("Codegraff Heavy")));
        assert!(!c.is_max_tier(Some("codegraff_pro")));
    }

    #[test]
    fn is_subscription_required_matches_either_provider() {
        let g = Provider::Grok;
        assert!(g.is_subscription_required("requires a Grok subscription"));
        assert!(g.is_subscription_required("requires a Codegraff subscription"));

        let c = Provider::Codegraff;
        assert!(c.is_subscription_required("requires a Codegraff subscription"));
        assert!(c.is_subscription_required("requires a Grok subscription"));

        // Unrelated messages don't match.
        assert!(!g.is_subscription_required("Content violates usage guidelines"));
        assert!(!c.is_subscription_required("SAFETY_CHECK_TYPE_DATA_LEAKAGE"));
    }

    #[test]
    fn is_consumer_subscription_upsell_matches() {
        let g = Provider::Grok;
        assert!(g.is_consumer_subscription_upsell("upgrade to a Grok subscription"));
        assert!(g.is_consumer_subscription_upsell("https://grok.com/supergrok"));
        assert!(!g.is_consumer_subscription_upsell("upgrade to a Codegraff subscription"));

        let c = Provider::Codegraff;
        assert!(c.is_consumer_subscription_upsell("upgrade to a Codegraff subscription"));
        assert!(c.is_consumer_subscription_upsell("https://codegraff.com/pricing"));
        assert!(!c.is_consumer_subscription_upsell("upgrade to a Grok subscription"));
    }

    #[test]
    fn free_usage_message_includes_provider_specific_text() {
        let g_msg = Provider::Grok.free_usage_message();
        assert!(g_msg.contains("Aiko"));
        assert!(g_msg.contains("SuperGrok"));
        assert!(g_msg.contains("grok.com/supergrok"));

        let c_msg = Provider::Codegraff.free_usage_message();
        assert!(c_msg.contains("Codegraff"));
        assert!(c_msg.contains("Codegraff Pro"));
        assert!(c_msg.contains("codegraff.com/pricing"));
    }
}
