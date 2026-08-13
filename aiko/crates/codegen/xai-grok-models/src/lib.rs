//! Default model IDs loaded from `default_models.json` at runtime.
//! Edit that JSON file to change them.
//!
//! At runtime each model is resolved via:
//!   CLI flag > ENV var > config.toml > remote settings > these defaults

use std::sync::LazyLock;

/// The raw JSON, embedded at compile time. Re-exported through the
/// `xai_grok_shell::models` facade and consumed by `agent::config`, so it must
/// be `pub` (was `pub(crate)` when this lived inside the shell crate).
pub const DEFAULT_MODELS_JSON: &str = include_str!("../default_models.json");

#[derive(serde::Deserialize)]
struct DefaultModels {
    default: String,
    /// Falls back to `default` if not specified in JSON.
    web_search: Option<String>,
    /// Falls back to `default` if not specified in JSON.
    image_description: Option<String>,
    /// Falls back to `default` if not specified in JSON.
    session_summary: Option<String>,
    models: Vec<DefaultModelEntry>,
}

#[derive(serde::Deserialize)]
struct DefaultModelEntry {
    model: String,
}

static DEFAULTS: LazyLock<DefaultModels> = LazyLock::new(|| {
    let defaults: DefaultModels = serde_json::from_str(DEFAULT_MODELS_JSON)
        .expect("default_models.json: invalid JSON or missing 'default' field");

    // Baked-in JSON — a mismatch here is a developer error, not a runtime condition.
    let model_ids: Vec<&str> = defaults.models.iter().map(|m| m.model.as_str()).collect();
    assert!(
        model_ids.contains(&defaults.default.as_str()),
        "default_models.json: 'default' is '{}' but 'models' array only has {model_ids:?}",
        defaults.default,
    );

    defaults
});

/// Primary model for coding tasks and general fallback.
pub fn default_model() -> &'static str {
    &DEFAULTS.default
}

/// Model for web search tool synthesis. Falls back to default model.
pub fn default_web_search_model() -> &'static str {
    DEFAULTS.web_search.as_deref().unwrap_or(&DEFAULTS.default)
}

/// Model for image describe. Falls back to default model.
pub fn default_image_description_model() -> &'static str {
    DEFAULTS
        .image_description
        .as_deref()
        .unwrap_or(&DEFAULTS.default)
}

/// Model for session title generation. Falls back to default model.
pub fn default_session_summary_model() -> &'static str {
    DEFAULTS
        .session_summary
        .as_deref()
        .unwrap_or(&DEFAULTS.default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forces the `DEFAULTS` LazyLock, which is where the embedded catalog's
    /// self-consistency assert lives. Without a test that touches it, a
    /// `default` naming a model the array does not contain would only surface
    /// on a user's first run.
    #[test]
    fn every_default_role_resolves_to_the_gateway_model() {
        assert_eq!(default_model(), xai_aiko_providers::GATEWAY_MODEL);
        assert_eq!(
            default_web_search_model(),
            xai_aiko_providers::GATEWAY_MODEL
        );
        assert_eq!(
            default_image_description_model(),
            xai_aiko_providers::GATEWAY_MODEL
        );
        assert_eq!(
            default_session_summary_model(),
            xai_aiko_providers::GATEWAY_MODEL
        );
    }

    /// Aiko routes to Codegraff and nothing else, so the embedded catalog is
    /// one entry. A second entry here would put a model in the picker that the
    /// gateway's `/v1/models` does not publish and its gate would refuse.
    #[test]
    fn the_embedded_catalog_holds_only_the_gateway_model() {
        let defaults: serde_json::Value = serde_json::from_str(DEFAULT_MODELS_JSON).unwrap();
        let models = defaults["models"].as_array().unwrap();

        assert_eq!(
            models.len(),
            1,
            "embedded catalog must hold exactly one model"
        );
        assert_eq!(models[0]["model"], xai_aiko_providers::GATEWAY_MODEL);
        assert_eq!(
            models[0]["api_backend"], "chat_completions",
            "the gateway speaks Chat Completions; a Responses entry would need a provider we no longer carry"
        );
    }
}
