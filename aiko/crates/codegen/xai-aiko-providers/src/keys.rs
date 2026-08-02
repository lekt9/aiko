//! Credential management — one optional API key per provider spec entry,
//! read from the environment. Mirrors codegraff's `provider.zig:Keys`.

use crate::provider::{AuthStyle, CredentialSource, Provider, ProviderKind};
use crate::spec::ProviderSpec;
use crate::{builtin_specs, context_window_for};
use std::collections::HashMap;

/// One optional API key per provider spec entry, read from the environment.
/// Mirrors codegraff's `provider.zig:Keys`.
#[derive(Debug, Clone)]
pub struct Keys {
    /// API key per provider id.
    values: HashMap<String, Option<String>>,
    /// Credential source per provider id.
    sources: HashMap<String, CredentialSource>,
    /// ChatGPT account id for the codex provider.
    pub codex_account: String,
}

impl Keys {
    /// Build Keys from the environment — reads each provider's `env_key`
    /// and populates `values`/`sources`.
    pub fn from_env() -> Self {
        let specs = builtin_specs();
        let mut values = HashMap::new();
        let mut sources = HashMap::new();

        for spec in specs {
            // Codex key comes from OAuth, not env — skip CODEX_DISABLED
            let key = if spec.id == "codex" {
                // Try the env var; if it's CODEX_DISABLED or empty, mark as none
                match std::env::var(spec.env_key) {
                    Ok(v) if !v.is_empty() && v != "CODEX_DISABLED" => {
                        sources.insert(spec.id.to_string(), CredentialSource::Environment);
                        Some(v)
                    }
                    _ => None,
                }
            } else {
                match std::env::var(spec.env_key) {
                    Ok(v) if !v.is_empty() => {
                        sources.insert(spec.id.to_string(), CredentialSource::Environment);
                        Some(v)
                    }
                    _ => None,
                }
            };
            values.insert(spec.id.to_string(), key);
            if !sources.contains_key(spec.id) {
                sources.insert(spec.id.to_string(), CredentialSource::None);
            }
        }

        Keys {
            values,
            sources,
            codex_account: String::new(),
        }
    }

    /// Get the API key for a provider.
    pub fn get(&self, provider_id: &str) -> Option<&str> {
        self.values.get(provider_id).and_then(|v| v.as_deref())
    }

    /// Get the credential source for a provider.
    pub fn source(&self, provider_id: &str) -> CredentialSource {
        self.sources
            .get(provider_id)
            .copied()
            .unwrap_or(CredentialSource::None)
    }

    /// Set the API key for a provider (e.g. from OAuth flow).
    pub fn set(&mut self, provider_id: &str, value: String, source: CredentialSource) {
        self.values
            .insert(provider_id.to_string(), Some(value));
        self.sources
            .insert(provider_id.to_string(), source);
    }

    /// Build a resolved Provider from a spec, key, and model.
    /// Mirrors codegraff's `Keys.build()`.
    pub fn build(
        &self,
        spec: &ProviderSpec,
        key: &str,
        model: &str,
    ) -> Provider {
        let is_codex = spec.id == "codex";
        let is_kimi_anthropic = spec.id == "kimi" && crate::kimi_protocol_is_anthropic(model);

        let kind = if is_kimi_anthropic {
            ProviderKind::Anthropic
        } else {
            spec.kind
        };
        let auth = if is_kimi_anthropic {
            AuthStyle::XApiKey
        } else {
            spec.auth
        };
        let url = if is_kimi_anthropic {
            "https://api.kimi.com/coding/v1/messages?beta=true".to_string()
        } else {
            spec.url.to_string()
        };

        Provider {
            id: spec.id.to_string(),
            kind,
            auth,
            url,
            api_key: key.to_string(),
            model: model.to_string(),
            context: context_window_for(spec.id, model),
            account: if is_codex {
                self.codex_account.clone()
            } else {
                String::new()
            },
            source: self.source(spec.id),
        }
    }

    /// Check if any provider has a key.
    pub fn has_any_key(&self) -> bool {
        self.values.values().any(|v| v.is_some())
    }

    /// List provider ids that have keys.
    pub fn keyed_providers(&self) -> Vec<&str> {
        self.values
            .iter()
            .filter_map(|(id, val)| val.as_ref().map(|_| id.as_str()))
            .collect()
    }
}

impl Default for Keys {
    fn default() -> Self {
        Self::from_env()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keys_from_env_empty() {
        // Without env vars set, no keys should be present
        let keys = Keys::from_env();
        // At least some providers should have no key
        assert_eq!(keys.source("codex"), CredentialSource::None);
    }

    #[test]
    fn test_keys_set_and_get() {
        let mut keys = Keys::from_env();
        keys.set("test-provider", "test-key".to_string(), CredentialSource::Session);
        assert_eq!(keys.get("test-provider"), Some("test-key"));
        assert_eq!(keys.source("test-provider"), CredentialSource::Session);
    }

    #[test]
    fn test_keys_build_respects_spec() {
        let keys = Keys::from_env();
        let spec = crate::builtin_specs()
            .iter()
            .find(|s| s.id == "anthropic")
            .unwrap();
        let provider = keys.build(spec, "fake-key", "claude-opus-4-8");
        assert_eq!(provider.id, "anthropic");
        assert_eq!(provider.kind, ProviderKind::Anthropic);
        assert_eq!(provider.auth, AuthStyle::XApiKey);
        assert_eq!(provider.model, "claude-opus-4-8");
        assert!(provider.context > 0);
        assert_eq!(provider.api_key, "fake-key");
    }

    #[test]
    fn test_keys_build_codex_uses_responses_kind() {
        let keys = Keys::from_env();
        let spec = crate::builtin_specs()
            .iter()
            .find(|s| s.id == "codex")
            .unwrap();
        let provider = keys.build(spec, "fake-token", "gpt-5.6-sol");
        assert_eq!(provider.kind, ProviderKind::Responses);
        assert_eq!(provider.account, ""); // no account set
    }
}
