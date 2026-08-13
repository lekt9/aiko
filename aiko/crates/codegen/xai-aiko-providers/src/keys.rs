//! Credential management — one optional API key per provider spec entry,
//! read from the environment. Mirrors codegraff's `provider.zig:Keys`.

use crate::provider::{CredentialSource, Provider};
use crate::spec::ProviderSpec;
use crate::{builtin_specs, context_window_for};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const CODEGRAFF_AUTH_PATH_ENV: &str = "CODEGRAFF_AUTH_PATH";
const SURPLUS_AUTH_PATH_ENV: &str = "SURPLUS_AUTH_PATH";

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

/// Resolve the Surplus Intelligence bearer credential.
///
/// Precedence: `SURPLUS_API_KEY`, then `SURPLUS_AUTH_PATH` / `~/.aiko/surplus-auth.json`,
/// then legacy Codegraff locations (env / device-login / forge) so existing
/// installs keep working while the gateway is Surplus.
pub fn surplus_key() -> Option<String> {
    if let Some(key) = nonempty_env("SURPLUS_API_KEY") {
        return Some(key);
    }
    if let Some(path) = std::env::var_os(SURPLUS_AUTH_PATH_ENV) {
        if let Some(key) = simple_harness_key(Path::new(&path)) {
            return Some(key);
        }
    }
    if let Some(home) = home_dir() {
        if let Some(key) = simple_harness_key(&home.join(".aiko/surplus-auth.json")) {
            return Some(key);
        }
    }
    // Legacy Codegraff credential locations (transitional).
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

/// Back-compat alias: the multi-model gateway credential is Surplus now.
pub fn codegraff_key() -> Option<String> {
    surplus_key()
}

/// One optional API key per provider spec entry, read from the environment.
/// Mirrors codegraff's `provider.zig:Keys`.
#[derive(Debug, Clone)]
pub struct Keys {
    /// API key per provider id.
    values: HashMap<String, Option<String>>,
    /// Credential source per provider id.
    sources: HashMap<String, CredentialSource>,
}

impl Keys {
    /// Build Keys from the environment — reads each provider's `env_key`
    /// and populates `values`/`sources`.
    pub fn from_env() -> Self {
        let specs = builtin_specs();
        let mut values = HashMap::new();
        let mut sources = HashMap::new();

        for spec in specs {
            let key = match std::env::var(spec.env_key) {
                Ok(v) if !v.is_empty() => {
                    sources.insert(spec.id.to_string(), CredentialSource::Environment);
                    Some(v)
                }
                _ => None,
            };
            values.insert(spec.id.to_string(), key);
            if !sources.contains_key(spec.id) {
                sources.insert(spec.id.to_string(), CredentialSource::None);
            }
        }

        // Surplus secondary gateway: env + auth files (including transitional
        // Codegraff key locations via `surplus_key()`).
        // Do NOT copy this key onto `codegraff` — that id is the Aiko session
        // proxy and expects an aiko JWT (`AIKO_ACCESS_TOKEN`), not a cg_sk/inf key.
        if values.get("surplus").and_then(Option::as_ref).is_none()
            && let Some(key) = surplus_key()
        {
            values.insert("surplus".to_string(), Some(key));
            sources.insert("surplus".to_string(), CredentialSource::Login);
        }

        Keys { values, sources }
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
        self.values.insert(provider_id.to_string(), Some(value));
        self.sources.insert(provider_id.to_string(), source);
    }

    /// Build a resolved Provider from a spec, key, and model.
    /// Mirrors codegraff's `Keys.build()`.
    /// Every spec in the catalog is a Codegraff path, so the resolved provider
    /// is the spec verbatim — no per-provider protocol switching to apply.
    pub fn build(&self, spec: &ProviderSpec, key: &str, model: &str) -> Provider {
        Provider {
            id: spec.id.to_string(),
            kind: spec.kind,
            auth: spec.auth,
            url: spec.url.to_string(),
            api_key: key.to_string(),
            model: model.to_string(),
            context: context_window_for(spec.id, model),
            account: String::new(),
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

impl Keys {
    /// Empty key set (no providers keyed). Useful for unit tests that must not
    /// pick up machine-local `SURPLUS_API_KEY` / auth files.
    pub fn empty() -> Self {
        Self {
            values: HashMap::new(),
            sources: HashMap::new(),
        }
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
        keys.set(
            "test-provider",
            "test-key".to_string(),
            CredentialSource::Session,
        );
        assert_eq!(keys.get("test-provider"), Some("test-key"));
        assert_eq!(keys.source("test-provider"), CredentialSource::Session);
    }

    #[test]
    fn test_keys_build_respects_spec() {
        let keys = Keys::from_env();
        let spec = crate::builtin_specs()
            .iter()
            .find(|s| s.id == "surplus")
            .unwrap();
        let provider = keys.build(spec, "fake-key", crate::GATEWAY_UPSTREAM_MODEL);
        assert_eq!(provider.id, "surplus");
        assert_eq!(provider.kind, spec.kind);
        assert_eq!(provider.auth, spec.auth);
        assert_eq!(provider.url, spec.url);
        assert_eq!(provider.model, crate::GATEWAY_UPSTREAM_MODEL);
        assert_eq!(provider.context, crate::GATEWAY_CONTEXT_WINDOW);
        assert_eq!(provider.api_key, "fake-key");
    }

    /// Every catalog entry is a Codegraff path, so `build` must reproduce the
    /// spec verbatim — no protocol rewrite can fire for some provider id.
    #[test]
    fn build_never_rewrites_a_specs_protocol() {
        let keys = Keys::empty();
        for spec in crate::builtin_specs() {
            let provider = keys.build(spec, "k", spec.default_model);
            assert_eq!(provider.kind, spec.kind);
            assert_eq!(provider.auth, spec.auth);
            assert_eq!(provider.url, spec.url);
            assert_eq!(provider.account, "");
        }
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
