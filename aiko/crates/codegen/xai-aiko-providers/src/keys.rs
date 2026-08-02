//! Credential management — one optional API key per provider spec entry,
//! read from the environment. Mirrors codegraff's `provider.zig:Keys`.

use crate::provider::{AuthStyle, CredentialSource, Provider, ProviderKind};
use crate::spec::ProviderSpec;
use crate::{builtin_specs, context_window_for};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const CODEGRAFF_AUTH_PATH_ENV: &str = "CODEGRAFF_AUTH_PATH";

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn read_json_bounded(path: &Path, max_bytes: u64) -> Option<serde_json::Value> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn simple_harness_key(path: &Path) -> Option<String> {
    let value = read_json_bounded(path, 64 * 1024)?;
    value
        .get("api_key")
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

fn forge_key(path: &Path) -> Option<String> {
    let value = read_json_bounded(path, 256 * 1024)?;
    value.as_array()?.iter().find_map(|entry| {
        (entry.get("id").and_then(serde_json::Value::as_str) == Some("codegraff"))
            .then(|| {
                entry
                    .get("auth_details")
                    .and_then(|details| details.get("api_key"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned)
            })
            .flatten()
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Resolve the Codegraff bearer credential with upstream-compatible precedence:
/// `CODEGRAFF_API_KEY`, then the device-login file, then Graff's credential store.
///
/// `CODEGRAFF_AUTH_PATH` is an authoritative override for the device-login file;
/// it also gives tests and managed installs a way to isolate credential lookup.
pub fn codegraff_key() -> Option<String> {
    if let Some(key) = nonempty_env("CODEGRAFF_API_KEY") {
        return Some(key);
    }
    if let Some(path) = std::env::var_os(CODEGRAFF_AUTH_PATH_ENV) {
        return simple_harness_key(Path::new(&path));
    }
    let home = home_dir()?;
    simple_harness_key(&home.join(".simple-harness-codegraff.json"))
        .or_else(|| forge_key(&home.join("forge/.credentials.json")))
}

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

        if values.get("codegraff").and_then(Option::as_ref).is_none()
            && let Some(key) = codegraff_key()
        {
            values.insert("codegraff".to_string(), Some(key));
            sources.insert("codegraff".to_string(), CredentialSource::Login);
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

    #[test]
    fn codegraff_device_login_file_is_loaded_without_exposing_the_key() {
        let dir =
            std::env::temp_dir().join(format!("aiko-codegraff-key-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let auth_path = dir.join("auth.json");
        std::fs::write(&auth_path, r#"{"api_key":"cg_test"}"#).unwrap();
        assert_eq!(simple_harness_key(&auth_path).as_deref(), Some("cg_test"));
        let _ = std::fs::remove_file(auth_path);
        let _ = std::fs::remove_dir(dir);
    }
}
