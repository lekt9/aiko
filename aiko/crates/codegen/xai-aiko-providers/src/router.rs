//! Provider router — routes model names to providers with catalog-aware
//! fallback and failover. Mirrors codegraff's `provider.zig:Keys.providerFor()`
//! and `providers.zig`.

use crate::keys::Keys;
use crate::provider::Provider;
use crate::spec::ProviderSpec;
use crate::{builtin_specs, model_in_catalog, provider_default_model, provider_model_in_catalog};

/// Error types for provider routing.
#[derive(Debug, thiserror::Error)]
pub enum RouterError {
    /// No API key found for any provider that serves this model.
    #[error("no credential found for model '{model}'")]
    MissingKey { model: String },
    /// The requested provider is not in the catalog.
    #[error("unknown provider '{0}'")]
    InvalidProvider(String),
    /// The model is not recognized.
    #[error("unknown model '{0}'")]
    InvalidModel(String),
    /// No credential found for any provider at all.
    #[error(
        "no API keys configured — set at least one provider env var (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY)"
    )]
    NoCredentials,
}

/// Routes model names to providers.
pub struct ProviderRouter {
    keys: Keys,
    /// URL override for the Codex endpoint (GRAFF_CODEX_URL).
    pub codex_url_override: Option<String>,
}

impl ProviderRouter {
    /// Create a new router with the given keys.
    pub fn new(keys: Keys) -> Self {
        Self {
            keys,
            codex_url_override: None,
        }
    }

    /// Route a model to a provider: first catalog row whose provider has a
    /// key wins (spec order breaks ties). Unknown claude* models go to
    /// Anthropic; any other unknown model goes to the Codegraff session proxy
    /// (or Surplus if that is the only gateway keyed).
    ///
    /// Two-pass routing: Codegraff (then Surplus) is the primary multi-model
    /// gateway path when keyed and the model is served. Direct providers are
    /// fallback.
    pub fn provider_for(&self, model: &str) -> Result<Provider, RouterError> {
        // Two-pass: gateways first (codegraff before surplus in spec order),
        // direct providers as fallback.
        for allow_gateway in [true, false] {
            for spec in builtin_specs() {
                let is_gateway = spec.id == "codegraff" || spec.id == "surplus";
                if is_gateway != allow_gateway {
                    continue;
                }
                let key = match self.keys.get(spec.id) {
                    Some(k) => k,
                    None => continue,
                };
                if provider_model_in_catalog(spec.id, model) {
                    return Ok(self.build_provider(spec, key, model));
                }
            }
        }

        // #294: a catalogued model with no keyed provider fails instead of
        // routing to the gateway.
        if model_in_catalog(model) {
            return Err(RouterError::MissingKey {
                model: model.to_string(),
            });
        }

        // Genuinely unknown model — fall back to heuristics
        let fallback_id = if model.starts_with("claude") {
            "anthropic"
        } else if self.keys.get("codegraff").is_some() {
            "codegraff"
        } else {
            "surplus"
        };
        let spec = builtin_specs()
            .iter()
            .find(|s| s.id == fallback_id)
            .ok_or(RouterError::InvalidProvider(fallback_id.to_string()))?;
        let key = self.keys.get(fallback_id).ok_or(RouterError::MissingKey {
            model: model.to_string(),
        })?;
        Ok(self.build_provider(spec, key, model))
    }

    /// The startup default: the first provider (in spec order) with a key,
    /// on its default model.
    pub fn default_provider(&self) -> Result<Provider, RouterError> {
        for spec in builtin_specs() {
            if let Some(key) = self.keys.get(spec.id) {
                let model = provider_default_model(spec.id, spec.default_model);
                return Ok(self.build_provider(spec, key, model));
            }
        }
        Err(RouterError::NoCredentials)
    }

    /// Rebuild a provider from a saved session's (id, model). Falls back to
    /// model-based routing if the id is unknown.
    pub fn provider_by_id(&self, id: &str, model: &str) -> Result<Provider, RouterError> {
        if let Some(spec) = builtin_specs().iter().find(|s| s.id == id) {
            let key = self.keys.get(id).ok_or(RouterError::MissingKey {
                model: model.to_string(),
            })?;
            return Ok(self.build_provider(spec, key, model));
        }
        // Unknown provider id — fall back to model routing
        self.provider_for(model)
    }

    /// Walk configured providers in stable priority order, beginning after
    /// the failed provider and wrapping once. Skips providers without
    /// credentials and ids already attempted.
    /// Mirrors codegraff's `providers.zig:nextFallbackProvider()`.
    pub fn next_fallback(
        &self,
        after_id: &str,
        tried: &[&str],
        allow: &[&str],
    ) -> Option<Provider> {
        let specs = builtin_specs();
        let count = specs.len();

        // Find start position (after the failed provider)
        let mut start: usize = 0;
        for (i, spec) in specs.iter().enumerate() {
            if spec.id == after_id {
                start = (i + 1) % count;
                break;
            }
        }

        for offset in 0..count {
            let spec = &specs[(start + offset) % count];
            let key = self.keys.get(spec.id)?;
            if tried.contains(&spec.id) {
                continue;
            }
            if !allow.contains(&spec.id) {
                continue;
            }
            let model = provider_default_model(spec.id, spec.default_model);
            return Some(self.build_provider(spec, key, model));
        }
        None
    }

    /// Whether an API error is eligible for provider failover.
    /// Only auth/model/credential failures qualify; network flakes,
    /// rate limits, and context overflow stay on the selected provider.
    /// Mirrors codegraff's `providers.zig:failoverEligible()`.
    pub fn failover_eligible(provider_id: &str, detail: &str) -> bool {
        let detail_lower = detail.to_lowercase();

        // Auth needles (provider-agnostic)
        let auth_needles = [
            "unauthorized",
            "authentication_error",
            "authentication token",
            "authentication failed",
            "invalid api key",
            "invalid_api_key",
            "invalid x-api-key",
            "incorrect api key",
            "api key not valid",
            "invalid token",
            "token expired",
            "expired token",
            "access token has expired",
            "401",
            "403",
            "forbidden",
            "access denied",
            "permission denied",
            "permission_denied",
        ];

        for needle in &auth_needles {
            if detail_lower.contains(needle) {
                return true;
            }
        }

        // Model needles (provider-agnostic)
        let model_needles = [
            "model_not_found",
            "model not found",
            "model is not available",
            "model unavailable",
            "model does not exist",
            "does not exist or you do not have access",
            "you do not have access to model",
            "you do not have access to this model",
        ];

        for needle in &model_needles {
            if detail_lower.contains(needle) {
                return true;
            }
        }

        // Billing needles — only for the gateway (codegraff issue #294).
        // A billing error from a directly-keyed provider is the user's own
        // account problem, not a failover signal.
        if provider_id == "surplus" || provider_id == "codegraff" {
            let gateway_billing = [
                "insufficient_quota",
                "quota exceeded",
                "credits exhausted",
                "insufficient credits",
                "credit balance",
                "no credits",
                "billing limit",
            ];
            for needle in &gateway_billing {
                if detail_lower.contains(needle) {
                    return true;
                }
            }
        }

        false
    }

    /// Build a provider, applying codex URL override if set.
    fn build_provider(&self, spec: &ProviderSpec, key: &str, model: &str) -> Provider {
        let mut provider = self.keys.build(spec, key, model);
        // Apply codex URL override (e.g. for local mocks)
        if spec.id == "codex" {
            if let Some(ref override_url) = self.codex_url_override {
                provider.url = override_url.clone();
            }
        }
        provider
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProviderKind;

    fn mock_keys() -> Keys {
        let mut keys = Keys::from_env();
        // Set all providers with a mock key for testing
        for spec in builtin_specs() {
            keys.set(
                spec.id,
                "mock-key".to_string(),
                crate::provider::CredentialSource::Session,
            );
        }
        keys
    }

    fn mock_router() -> ProviderRouter {
        ProviderRouter::new(mock_keys())
    }

    #[test]
    fn test_provider_for_known_model() {
        let router = mock_router();
        let p = router.provider_for("gpt-5.6-sol").unwrap();
        assert_eq!(p.id, "codex"); // codex comes first in spec order for this model
        assert_eq!(p.model, "gpt-5.6-sol");
        assert_eq!(p.kind, ProviderKind::Responses);
    }

    #[test]
    fn test_provider_for_grok() {
        let router = mock_router();
        let p = router.provider_for("grok-4.3").unwrap();
        // Codegraff (session proxy) is primary for shared multi-model routes.
        assert_eq!(p.id, "codegraff");
        assert_eq!(p.model, "grok-4.3");
        assert_eq!(p.kind, ProviderKind::OpenAi);
    }

    #[test]
    fn codegraff_is_primary_for_shared_models() {
        let router = mock_router();
        for model in ["grok-4.3", "gpt-5.6", "claude-opus-4-8"] {
            assert_eq!(router.provider_for(model).unwrap().id, "codegraff");
        }
    }

    #[test]
    fn surplus_used_when_only_surplus_gateway_keyed() {
        let mut keys = Keys::empty();
        keys.set(
            "surplus",
            "mock-key".to_string(),
            crate::provider::CredentialSource::Session,
        );
        let router = ProviderRouter::new(keys);
        assert_eq!(router.provider_for("grok-4.3").unwrap().id, "surplus");
    }

    #[test]
    fn direct_provider_used_when_only_xai_keyed() {
        // When the gateway has no key and only xAI does, shared models go direct.
        let mut keys = Keys::empty();
        keys.set(
            "xai",
            "mock-key".to_string(),
            crate::provider::CredentialSource::Session,
        );
        let router = ProviderRouter::new(keys);
        let id = router.provider_for("grok-4.3").unwrap().id;
        assert_eq!(id, "xai", "expected xai (direct) when no gateway keyed, got {id}");
    }

    #[test]
    fn test_provider_for_unknown_claude() {
        let router = mock_router();
        let p = router.provider_for("claude-does-not-exist").unwrap();
        assert_eq!(p.id, "anthropic");
    }

    #[test]
    fn test_provider_for_unknown_other() {
        let router = mock_router();
        let p = router.provider_for("totally-made-up-model").unwrap();
        assert_eq!(p.id, "codegraff");
    }

    #[test]
    fn test_missing_key_for_catalogued_model() {
        let router = ProviderRouter::new(Keys::empty());
        // gpt-5.6-sol is catalogued only under codex
        assert!(provider_model_in_catalog("codex", "gpt-5.6-sol"));
        let err = router.provider_for("gpt-5.6-sol").unwrap_err();
        assert!(matches!(err, RouterError::MissingKey { .. }));
    }

    #[test]
    fn test_default_provider() {
        let router = mock_router();
        let p = router.default_provider().unwrap();
        assert_eq!(p.id, "codegraff");
        assert_eq!(p.model, "deepseek-v4-pro");
    }

    #[test]
    fn test_no_credentials() {
        // Use an empty key set so machine-local Surplus auth cannot satisfy this.
        let router = ProviderRouter::new(Keys::empty());
        let err = router.default_provider().unwrap_err();
        assert!(matches!(err, RouterError::NoCredentials));
    }

    #[test]
    fn test_provider_by_id() {
        let router = mock_router();
        let p = router
            .provider_by_id("anthropic", "claude-opus-4-8")
            .unwrap();
        assert_eq!(p.id, "anthropic");
        assert_eq!(p.model, "claude-opus-4-8");
    }

    #[test]
    fn test_provider_by_id_unknown_falls_back() {
        let router = mock_router();
        let p = router
            .provider_by_id("no-such-provider", "gpt-5.5")
            .unwrap();
        // Falls back to model routing: gpt-5.5 routes to openai or codex
        assert_eq!(p.model, "gpt-5.5");
    }

    #[test]
    fn test_failover_eligible_auth() {
        assert!(ProviderRouter::failover_eligible("codex", "Unauthorized"));
        assert!(ProviderRouter::failover_eligible(
            "codex",
            "access token has expired"
        ));
        assert!(ProviderRouter::failover_eligible(
            "codex",
            "model_not_found: rollout ended"
        ));
    }

    #[test]
    fn test_failover_not_eligible_transient() {
        assert!(!ProviderRouter::failover_eligible(
            "codex",
            "network error: HttpConnectionClosing"
        ));
        assert!(!ProviderRouter::failover_eligible(
            "codex",
            "rate limited (429)"
        ));
        assert!(!ProviderRouter::failover_eligible(
            "codex",
            "maximum context length exceeded"
        ));
        assert!(!ProviderRouter::failover_eligible(
            "codex",
            "unparseable response"
        ));
    }

    #[test]
    fn test_failover_billing_gateway_only() {
        let billing_errors = [
            "your credit balance is too low",
            "insufficient credits",
            "credits exhausted",
            "no credits remaining",
            "billing limit reached",
            "quota exceeded for this account",
            "insufficient_quota",
        ];
        for detail in &billing_errors {
            // Gateway billing errors ARE eligible
            assert!(
                ProviderRouter::failover_eligible("codegraff", detail),
                "gateway billing '{detail}' should be eligible"
            );
            // Direct provider billing errors are NOT eligible
            assert!(
                !ProviderRouter::failover_eligible("anthropic", detail),
                "anthropic billing '{detail}' should not be eligible"
            );
            assert!(
                !ProviderRouter::failover_eligible("codex", detail),
                "codex billing '{detail}' should not be eligible"
            );
        }
    }

    #[test]
    fn test_codex_url_override() {
        let mut router = mock_router();
        router.codex_url_override = Some("http://127.0.0.1:8765/responses".to_string());
        let p = router.provider_for("gpt-5.6-sol").unwrap();
        assert_eq!(p.id, "codex");
        assert_eq!(p.url, "http://127.0.0.1:8765/responses");
    }
}
