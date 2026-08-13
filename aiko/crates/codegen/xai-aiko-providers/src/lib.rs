//! Unified provider abstraction — ported from [codegraff](https://github.com/justrach/codegraff)
//! (`src/provider.zig`, `src/providers.zig`).
//!
//! # Architecture
//!
//! ```text
//! ProviderSpec (declarative config: id, kind, auth, url, env_key, default_model)
//!     │
//!     ▼
//! Keys (credential management: reads API keys from environment)
//!     │
//!     ▼
//! Provider (resolved connection: kind, auth, url, api_key, model, context_window)
//!     │
//!     ▼
//! ProviderRouter (routes model names → providers, with failover)
//! ```
//!
//! # Wire formats
//!
//! Three provider kinds map to three API shapes:
//!
//! | Kind        | Wire format              | Example providers          |
//! |-------------|--------------------------|----------------------------|
//! | `Anthropic` | Messages API              | Anthropic, MiniMax, Kimi   |
//! | `OpenAi`    | Chat Completions API      | OpenAI, xAI (Grok), DeepSeek |
//! | `Responses` | Codex Responses API       | Codex (ChatGPT)            |
//!
//! # Provider routing
//!
//! Aiko routes to Codegraff and nothing else. The gateway is reachable two
//! ways, and they do not share a model id:
//!
//! 1. **`codegraff`** — the Aiko session proxy (`AIKO_ACCESS_TOKEN`). Publishes
//!    [`GATEWAY_MODEL`] and rebinds it server-side.
//! 2. **`surplus`** — a direct Codegraff key (`SURPLUS_API_KEY` /
//!    `CODEGRAFF_API_KEY`). Names [`GATEWAY_UPSTREAM_MODEL`] outright.
//! 3. **Catalogued but unkeyed fails with `MissingKey`**; anything else fails
//!    with `InvalidModel`. There is no heuristic fallback — guessing a provider
//!    would send a request to a host the catalog never advertised.

mod keys;
mod provider;
mod router;
mod spec;

pub use keys::{Keys, codegraff_key, surplus_key};
pub use provider::{AuthStyle, CredentialSource, Provider, ProviderKind};
pub use router::{ProviderRouter, RouterError};
pub use spec::ProviderSpec;

/// OpenAI-compatible Codegraff gateway — the upstream behind both Aiko paths.
pub const CODEGRAFF_API_BASE_URL: &str = "https://gateway.codegraff.com/v1";
/// Codegraff live model catalog.
pub const CODEGRAFF_MODELS_URL: &str = "https://gateway.codegraff.com/v1/models";
/// Fully-qualified chat-completions endpoint.
pub const CODEGRAFF_CHAT_COMPLETIONS_URL: &str =
    "https://gateway.codegraff.com/v1/chat/completions";

/// Aliases kept for the call sites that still name the gateway role "surplus".
pub const SURPLUS_API_BASE_URL: &str = CODEGRAFF_API_BASE_URL;
/// Alias for [`CODEGRAFF_MODELS_URL`].
pub const SURPLUS_MODELS_URL: &str = CODEGRAFF_MODELS_URL;
/// Alias for [`CODEGRAFF_CHAT_COMPLETIONS_URL`].
pub const SURPLUS_CHAT_COMPLETIONS_URL: &str = CODEGRAFF_CHAT_COMPLETIONS_URL;

/// The single model id the **Aiko session gateway** publishes.
///
/// A session client never names an upstream slug. `best` is bound to
/// [`GATEWAY_UPSTREAM_MODEL`] inside the worker (`DEFAULT_MODEL` in the
/// proxy's `wrangler.jsonc`), so moving to a newer model is a worker deploy
/// that every installed client follows without updating. A client that
/// hard-coded the upstream slug would keep pinning yesterday's model after the
/// binding moved.
pub const GATEWAY_MODEL: &str = "best";
/// The upstream slug `best` currently resolves to.
///
/// This is what a **direct** Codegraff key must name: `best` exists only inside
/// the Aiko worker, so sending it straight to `gateway.codegraff.com` is a 400.
/// Keep this in step with `DEFAULT_MODEL` in the proxy's `wrangler.jsonc`.
pub const GATEWAY_UPSTREAM_MODEL: &str = "muse-spark-1.2-contributor";
/// Context window for the bound model when the live `/v1/models` catalog is
/// unavailable. The gateway's own `contextWindow` wins when present.
pub const GATEWAY_CONTEXT_WINDOW: u64 = 1_048_576;

/// The built-in provider catalog — one entry per supported provider.
/// Mirrors codegraff's `provider_specs` const array.
pub fn builtin_specs() -> &'static [ProviderSpec] {
    &[
        // Aiko Cloudflare API proxy — session JWT path onto Codegraff (the
        // server holds the key). Publishes `best`.
        ProviderSpec {
            id: "codegraff",
            display_name: "Aiko Session Proxy",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://aiko.theclarityproject.net/v1/chat/completions",
            env_key: "AIKO_ACCESS_TOKEN",
            default_model: GATEWAY_MODEL,
        },
        // Codegraff — direct-key path. Names the upstream slug outright.
        ProviderSpec {
            id: "surplus",
            display_name: "Codegraff",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: CODEGRAFF_CHAT_COMPLETIONS_URL,
            env_key: "SURPLUS_API_KEY",
            default_model: GATEWAY_UPSTREAM_MODEL,
        },
    ]
}

/// Context window (tokens) for a model on the Codegraff gateway.
///
/// Both gateway ids resolve to the same upstream model, so they share a window.
/// The live `/v1/models` catalog wins when present; this is the offline answer.
pub fn context_window_for(provider_id: &str, model: &str) -> u64 {
    if provider_id == "surplus" || provider_id == "codegraff" {
        match model {
            GATEWAY_MODEL | GATEWAY_UPSTREAM_MODEL => return GATEWAY_CONTEXT_WINDOW,
            _ => {}
        }
    }
    // Unknown model — conservative default
    32_000
}

/// Is this a known model in the catalog?
///
/// Only the two gateway ids are. Aiko routes to Codegraff and nothing else, so
/// there is no second provider a stray model name could belong to.
pub fn is_known_model(_provider_id: &str, model: &str) -> bool {
    model == GATEWAY_MODEL || model == GATEWAY_UPSTREAM_MODEL
}

/// Is this model in the catalog under any provider?
pub fn model_in_catalog(model: &str) -> bool {
    is_known_model("", model)
}

/// Does this provider serve this model?
///
/// The two paths do not share an id. `codegraff` is the Aiko session proxy and
/// publishes only [`GATEWAY_MODEL`]; `surplus` is a direct Codegraff key, where
/// `best` does not exist and the upstream slug must be named outright. Claiming
/// an id the endpoint would then reject turns a routing decision into a 400 the
/// user cannot act on.
pub fn provider_model_in_catalog(provider_id: &str, model: &str) -> bool {
    match provider_id {
        "codegraff" => model == GATEWAY_MODEL,
        "surplus" => model == GATEWAY_UPSTREAM_MODEL,
        _ => false,
    }
}

/// Default model for a provider, resolving aliases.
pub fn provider_default_model<'a>(provider_id: &str, fallback: &'a str) -> &'a str {
    match provider_id {
        "codegraff" => GATEWAY_MODEL,
        "surplus" => GATEWAY_UPSTREAM_MODEL,
        _ => fallback,
    }
}

/// Catalog providers that serve a given model.
pub fn catalog_providers_for(model: &str) -> Vec<&'static str> {
    let mut result = Vec::new();
    for spec in builtin_specs() {
        if provider_model_in_catalog(spec.id, model) {
            result.push(spec.id);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Aiko routes to Codegraff and nothing else. The catalog is the mechanism:
    /// a provider absent from it can never be selected, keyed, or failed over
    /// to, whatever env vars happen to be set on the machine.
    #[test]
    fn the_catalog_holds_only_codegraff_paths() {
        let ids: Vec<&str> = builtin_specs().iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["codegraff", "surplus"]);

        for spec in builtin_specs() {
            let host = spec.url.split('/').nth(2).expect("spec url has a host");
            assert!(
                host == "gateway.codegraff.com" || host == "aiko.theclarityproject.net",
                "{} routes to {host}, which is not Codegraff or the Aiko proxy",
                spec.id
            );
        }
    }

    /// The removed providers must not creep back in through a helper that
    /// still answers for them — that is how a "removed" provider keeps working.
    #[test]
    fn removed_providers_are_unroutable() {
        for (provider, model) in [
            ("codex", "gpt-5.6-sol"),
            ("openai", "gpt-5.6"),
            ("anthropic", "claude-opus-4-8"),
            ("xai", "grok-4.3"),
            ("deepseek", "deepseek-v4-pro"),
            ("kimi", "k3"),
            ("minimax", "MiniMax-M3"),
            ("zai", "glm-5.2"),
            ("fireworks", "accounts/fireworks/models/deepseek-v4-pro"),
            ("mlx", "mlx-community/Qwen3.6-27B-OptiQ-4bit"),
        ] {
            assert!(
                !provider_model_in_catalog(provider, model),
                "{provider} must not serve {model}"
            );
            assert!(!is_known_model(provider, model), "{model} must be unknown");
            assert!(
                catalog_providers_for(model).is_empty(),
                "{model} must have no provider"
            );
            assert_eq!(provider_default_model(provider, "fallback"), "fallback");
        }
    }

    #[test]
    fn codegraff_is_the_direct_key_path() {
        let spec = builtin_specs()
            .iter()
            .find(|spec| spec.id == "surplus")
            .expect("direct-key gateway spec");

        assert_eq!(spec.url, CODEGRAFF_CHAT_COMPLETIONS_URL);
        assert_eq!(spec.env_key, "SURPLUS_API_KEY");
        assert!(spec.url.contains("gateway.codegraff.com"));
        // A direct key must name a slug Codegraff actually serves.
        assert_eq!(spec.default_model, GATEWAY_UPSTREAM_MODEL);
        assert_ne!(spec.default_model, GATEWAY_MODEL);
    }

    #[test]
    fn codegraff_id_is_session_proxy() {
        let spec = builtin_specs()
            .iter()
            .find(|spec| spec.id == "codegraff")
            .expect("session proxy provider spec");

        assert_eq!(
            spec.url,
            "https://aiko.theclarityproject.net/v1/chat/completions"
        );
        assert_eq!(spec.env_key, "AIKO_ACCESS_TOKEN");
        assert_eq!(spec.default_model, GATEWAY_MODEL);
    }

    #[test]
    fn both_paths_share_the_bound_model_context_window() {
        assert_eq!(
            context_window_for("codegraff", GATEWAY_MODEL),
            GATEWAY_CONTEXT_WINDOW
        );
        assert_eq!(
            context_window_for("surplus", GATEWAY_UPSTREAM_MODEL),
            GATEWAY_CONTEXT_WINDOW
        );
    }

    #[test]
    fn test_context_window_unknown_fallback() {
        assert_eq!(context_window_for("unknown", "some-model"), 32_000);
    }

    #[test]
    fn never_routes_directly_to_openrouter() {
        assert!(
            builtin_specs()
                .iter()
                .all(|spec| !spec.url.contains("openrouter.ai")),
            "Aiko must never route directly to OpenRouter"
        );
    }
}
