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
        "no credentials configured — run `aiko login`, or set SURPLUS_API_KEY / CODEGRAFF_API_KEY"
    )]
    NoCredentials,
}

/// Routes model names to providers.
pub struct ProviderRouter {
    keys: Keys,
}

impl ProviderRouter {
    /// Create a new router with the given keys.
    pub fn new(keys: Keys) -> Self {
        Self { keys }
    }

    /// Route a model to the Codegraff path that serves it: the session proxy
    /// for [`crate::GATEWAY_MODEL`], a direct key for
    /// [`crate::GATEWAY_UPSTREAM_MODEL`].
    ///
    /// There is no heuristic fallback for an unrecognised model. Aiko routes to
    /// Codegraff and nothing else, so "unknown model" has exactly one honest
    /// answer — refuse. Guessing a provider would send the request somewhere the
    /// catalog never advertised, and the caller would learn about it as a 400
    /// from a host they did not choose.
    pub fn provider_for(&self, model: &str) -> Result<Provider, RouterError> {
        for spec in builtin_specs() {
            if !provider_model_in_catalog(spec.id, model) {
                continue;
            }
            let Some(key) = self.keys.get(spec.id) else {
                continue;
            };
            return Ok(self.build_provider(spec, key, model));
        }

        // Catalogued but unkeyed is a credential problem; anything else is not
        // a model this build can serve at all.
        if model_in_catalog(model) {
            Err(RouterError::MissingKey {
                model: model.to_string(),
            })
        } else {
            Err(RouterError::InvalidModel(model.to_string()))
        }
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

    fn build_provider(&self, spec: &ProviderSpec, key: &str, model: &str) -> Provider {
        self.keys.build(spec, key, model)
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
    fn each_gateway_path_routes_to_its_own_id() {
        let router = mock_router();

        // `best` exists only on the session proxy, which rebinds it.
        let best = router.provider_for(crate::GATEWAY_MODEL).unwrap();
        assert_eq!(best.id, "codegraff");
        assert_eq!(best.model, crate::GATEWAY_MODEL);
        assert_eq!(best.kind, ProviderKind::OpenAi);

        // The direct-key path names the upstream slug outright — sending
        // `best` to gateway.codegraff.com would be a 400.
        let direct = router.provider_for(crate::GATEWAY_UPSTREAM_MODEL).unwrap();
        assert_eq!(direct.id, "surplus");
        assert_eq!(direct.model, crate::GATEWAY_UPSTREAM_MODEL);
    }

    /// The removed providers must not come back through the router's fallback.
    /// A heuristic that guessed "claude* → anthropic" would resolve a provider
    /// the catalog no longer contains, and the request would leave for a host
    /// the user never configured.
    #[test]
    fn no_model_escapes_to_a_removed_provider() {
        let router = mock_router();
        for model in [
            "gpt-5.6-sol",
            "grok-4.3",
            "claude-opus-4-8",
            "claude-does-not-exist",
            "deepseek-v4-pro",
            "totally-made-up-model",
        ] {
            let err = router
                .provider_for(model)
                .expect_err("must not resolve to any provider");
            assert!(
                matches!(err, RouterError::InvalidModel(_)),
                "{model} produced {err:?}, expected InvalidModel"
            );
        }
    }

    #[test]
    fn missing_key_is_distinct_from_unknown_model() {
        let router = ProviderRouter::new(Keys::empty());
        // Catalogued but unkeyed — a credential problem the user can fix.
        let err = router.provider_for(crate::GATEWAY_MODEL).unwrap_err();
        assert!(matches!(err, RouterError::MissingKey { .. }), "{err:?}");
        // Not in the catalog at all — no credential would help.
        let err = router.provider_for("grok-4.3").unwrap_err();
        assert!(matches!(err, RouterError::InvalidModel(_)), "{err:?}");
    }

    #[test]
    fn test_default_provider() {
        let router = mock_router();
        let p = router.default_provider().unwrap();
        assert_eq!(p.id, "codegraff");
        assert_eq!(p.model, crate::GATEWAY_MODEL);
    }

    #[test]
    fn test_no_credentials() {
        // Use an empty key set so machine-local Codegraff auth cannot satisfy this.
        let router = ProviderRouter::new(Keys::empty());
        let err = router.default_provider().unwrap_err();
        assert!(matches!(err, RouterError::NoCredentials));
    }

    #[test]
    fn test_provider_by_id() {
        let router = mock_router();
        let p = router
            .provider_by_id("codegraff", crate::GATEWAY_MODEL)
            .unwrap();
        assert_eq!(p.id, "codegraff");
        assert_eq!(p.model, crate::GATEWAY_MODEL);
    }

    #[test]
    fn test_provider_by_id_unknown_falls_back_to_model_routing() {
        let router = mock_router();
        let p = router
            .provider_by_id("no-such-provider", crate::GATEWAY_MODEL)
            .unwrap();
        assert_eq!(p.id, "codegraff");
        assert_eq!(p.model, crate::GATEWAY_MODEL);
    }

    #[test]
    fn test_failover_eligible_auth() {
        assert!(ProviderRouter::failover_eligible("surplus", "Unauthorized"));
        assert!(ProviderRouter::failover_eligible(
            "surplus",
            "access token has expired"
        ));
        assert!(ProviderRouter::failover_eligible(
            "surplus",
            "model_not_found: rollout ended"
        ));
    }

    #[test]
    fn test_failover_not_eligible_transient() {
        assert!(!ProviderRouter::failover_eligible(
            "surplus",
            "network error: HttpConnectionClosing"
        ));
        assert!(!ProviderRouter::failover_eligible(
            "surplus",
            "rate limited (429)"
        ));
        assert!(!ProviderRouter::failover_eligible(
            "surplus",
            "maximum context length exceeded"
        ));
        assert!(!ProviderRouter::failover_eligible(
            "surplus",
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
            // A billing error from a directly-keyed provider is the user's
            // own account problem, not a failover signal.
            assert!(
                !ProviderRouter::failover_eligible("unkeyed-direct", detail),
                "direct billing '{detail}' should not be eligible"
            );
        }
    }
}
