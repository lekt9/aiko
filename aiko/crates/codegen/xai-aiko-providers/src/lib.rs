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
//! # Provider routing (from codegraff providers.zig)
//!
//! 1. **Codegraff is primary** when its key and model are available.
//! 2. **Direct providers are fallback routes** when Codegraff is unavailable or
//!    does not serve the requested model.
//! 3. **Catalogued models with no keyed provider fail with `MissingKey`** — they
//!    don't silently route to the gateway (codegraff issue #294).
//! 4. **Genuinely unknown models fall back**: `claude*` → Anthropic, everything
//!    else → codegraff gateway.

mod keys;
mod provider;
mod router;
mod spec;

pub use keys::Keys;
pub use provider::{AuthStyle, CredentialSource, Provider, ProviderKind};
pub use router::{ProviderRouter, RouterError};
pub use spec::ProviderSpec;

/// The built-in provider catalog — one entry per supported provider.
/// Mirrors codegraff's `provider_specs` const array.
pub fn builtin_specs() -> &'static [ProviderSpec] {
    &[
        // Aiko Cloudflare API proxy — forwards to Codegraff server-side.
        // Clients authenticate with their Aiko OAuth access token and never
        // receive or send the upstream CODEGRAFF_API_KEY.
        ProviderSpec {
            id: "codegraff",
            display_name: "Codegraff",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://aiko.theclarityproject.net/v1/chat/completions",
            env_key: "AIKO_ACCESS_TOKEN",
            default_model: "deepseek-v4-pro",
        },
        // Anthropic — Messages API, x-api-key auth
        ProviderSpec {
            id: "anthropic",
            display_name: "Anthropic",
            kind: ProviderKind::Anthropic,
            auth: AuthStyle::XApiKey,
            url: "https://api.anthropic.com/v1/messages",
            env_key: "ANTHROPIC_API_KEY",
            default_model: "claude-opus-4-8",
        },
        // DeepSeek — OpenAI-compatible
        ProviderSpec {
            id: "deepseek",
            display_name: "DeepSeek",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.deepseek.com/chat/completions",
            env_key: "DEEPSEEK_API_KEY",
            default_model: "deepseek-v4-pro",
        },
        // OpenAI — Chat Completions API
        ProviderSpec {
            id: "openai",
            display_name: "OpenAI",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.openai.com/v1/chat/completions",
            env_key: "OPENAI_API_KEY",
            default_model: "gpt-5.6",
        },
        // MiniMax — Anthropic-format
        ProviderSpec {
            id: "minimax",
            display_name: "MiniMax",
            kind: ProviderKind::Anthropic,
            auth: AuthStyle::Bearer,
            url: "https://api.minimax.io/anthropic/v1/messages",
            env_key: "MINIMAX_API_KEY",
            default_model: "MiniMax-M3",
        },
        // Xiaomi — OpenAI-compatible
        ProviderSpec {
            id: "xiaomi",
            display_name: "Xiaomi",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.xiaomimimo.com/v1/chat/completions",
            env_key: "XIAOMI_API_KEY",
            default_model: "mimo-v2.5-pro",
        },
        // Kimi — OpenAI-compatible (native); switches to Anthropic per-model
        ProviderSpec {
            id: "kimi",
            display_name: "Kimi",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.kimi.com/coding/v1/chat/completions",
            env_key: "KIMI_API_KEY",
            default_model: "k3",
        },
        // Moonshot — Kimi Open Platform
        ProviderSpec {
            id: "moonshot",
            display_name: "Moonshot",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.moonshot.ai/v1/chat/completions",
            env_key: "MOONSHOT_API_KEY",
            default_model: "kimi-latest",
        },
        // xAI (Grok) — OpenAI-compatible
        ProviderSpec {
            id: "xai",
            display_name: "xAI",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.x.ai/v1/chat/completions",
            env_key: "XAI_API_KEY",
            default_model: "grok-4.3",
        },
        // Z.AI (GLM) — OpenAI-compatible
        ProviderSpec {
            id: "zai",
            display_name: "Z.AI",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.z.ai/api/paas/v4/chat/completions",
            env_key: "ZAI_API_KEY",
            default_model: "glm-5.2",
        },
        // Sakana AI (Fugu) — OpenAI-compatible
        ProviderSpec {
            id: "fugu",
            display_name: "fugu",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.sakana.ai/v1/chat/completions",
            env_key: "FUGU_API_KEY",
            default_model: "fugu-ultra",
        },
        // Fireworks — OpenAI-compatible
        ProviderSpec {
            id: "fireworks",
            display_name: "fireworks",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.fireworks.ai/inference/v1/chat/completions",
            env_key: "FIREWORKS_API_KEY",
            default_model: "accounts/fireworks/models/deepseek-v4-pro",
        },
        // MLX — local model server (Apple Silicon), OpenAI-compatible
        ProviderSpec {
            id: "mlx",
            display_name: "mlx",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "http://127.0.0.1:8080/v1/chat/completions",
            env_key: "MLX_API_KEY",
            default_model: "mlx-community/Qwen3.6-27B-OptiQ-4bit",
        },
        // LM Studio — local model server, OpenAI-compatible
        ProviderSpec {
            id: "lmstudio",
            display_name: "lmstudio",
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "http://127.0.0.1:1234/v1/chat/completions",
            env_key: "LMSTUDIO_API_KEY",
            default_model: "lmstudio",
        },
        // Codex (ChatGPT) — Responses API, bearer auth (OAuth token)
        ProviderSpec {
            id: "codex",
            display_name: "Codex (ChatGPT)",
            kind: ProviderKind::Responses,
            auth: AuthStyle::Bearer,
            url: "https://chatgpt.com/backend-api/codex/responses",
            env_key: "CODEX_DISABLED", // key comes from OAuth, not env
            default_model: "gpt-5.6-sol",
        },
    ]
}

/// Context windows for known models (tokens). Mirrors codegraff's pricing.zig context table.
/// Key: "provider_id:model_name" → context_window_tokens.
pub fn context_window_for(provider_id: &str, model: &str) -> u64 {
    let _key = (provider_id, model);
    // Codex/OpenAI models
    if provider_id == "codex" || provider_id == "openai" {
        match model {
            "gpt-5.6" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" => return 270_000,
            "gpt-5.5" | "gpt-5.5-codex" => return 270_000,
            "gpt-5.4" | "gpt-5.4-mini" => return 270_000,
            "gpt-5.3-codex" => return 270_000,
            "gpt-5.2" | "gpt-5-codex" => return 270_000,
            _ => {}
        }
    }
    // Claude models
    if provider_id == "anthropic" {
        match model {
            "claude-opus-4-8" | "claude-opus-4.8" => return 200_000,
            "claude-sonnet-4-6" | "claude-sonnet-4.6" => return 200_000,
            "claude-haiku-4-5" => return 200_000,
            _ => {}
        }
    }
    // Grok models (xAI)
    if provider_id == "xai" {
        match model {
            "grok-4.3" => return 1_000_000,
            "grok-build" => return 1_000_000,
            _ => {}
        }
    }
    // DeepSeek
    if provider_id == "deepseek" || provider_id == "codegraff" {
        match model {
            "deepseek-v4-pro" | "deepseek-v4-flash" => return 1_000_000,
            _ => {}
        }
    }
    // Kimi
    if provider_id == "kimi" {
        match model {
            "kimi-k2.7" | "kimi-k2.6" | "k3" => return 256_000,
            _ => {}
        }
    }
    // MiniMax
    if provider_id == "minimax" {
        if model == "MiniMax-M3" || model == "minimax-m3" {
            return 1_000_000;
        }
    }
    // GLM (Z.AI)
    if provider_id == "zai" {
        match model {
            "glm-5.2" | "glm-5" | "glm-4.7" | "glm-4.5" => return 128_000,
            _ => {}
        }
    }
    // Xiaomi
    if provider_id == "xiaomi" {
        match model {
            "mimo-v2.5-pro" | "mimo-v2.5" => return 256_000,
            _ => {}
        }
    }
    // Fugu
    if provider_id == "fugu" {
        if model == "fugu-ultra" {
            return 128_000;
        }
    }
    // Unknown model — conservative default
    32_000
}

/// Is this a known model in the catalog? Used so that only genuinely unknown
/// models fall through to the gateway fallback (codegraff issue #294).
pub fn is_known_model(_provider_id: &str, model: &str) -> bool {
    // Check if a model appears in any provider's context table
    let providers = ["codex", "openai", "anthropic", "xai", "deepseek", "codegraff", "kimi", "minimax", "zai", "xiaomi", "fugu"];
    for pid in &providers {
        let ctx = context_window_for(pid, model);
        // If the context window is not the default 32_000, it's a known model
        if ctx != 32_000 {
            return true;
        }
    }
    // Also check common aliases
    matches!(model,
        | "claude-opus-4-8" | "claude-opus-4.8"
        | "claude-sonnet-4-6" | "claude-sonnet-4.6"
        | "claude-haiku-4-5"
        | "gpt-5.6" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna"
        | "gpt-5.5" | "gpt-5.5-codex" | "gpt-5.4" | "gpt-5.4-mini"
        | "gpt-5.3-codex" | "gpt-5.2" | "gpt-5-codex"
        | "deepseek-v4-pro" | "deepseek-v4-flash"
        | "grok-4.3" | "grok-build"
        | "mimo-v2.5-pro" | "mimo-v2.5"
        | "glm-5.2" | "glm-5" | "glm-4.7" | "glm-4.5"
        | "kimi-k2.7" | "kimi-k2.6" | "kimi-k2-thinking" | "kimi-k2.5" | "k3"
        | "MiniMax-M3" | "minimax-m3"
        | "fugu-ultra"
        | "kimi-latest"
        | "lmstudio"
    )
}

/// Whether a model is catalogued under any provider.
pub fn model_in_catalog(model: &str) -> bool {
    is_known_model("", model)
}

/// Whether a specific (provider, model) pair exists in the catalog.
/// Uses a proper per-provider model catalog to avoid false positives
/// (e.g., gpt-5.6-sol must only match under codex).
pub fn provider_model_in_catalog(provider_id: &str, model: &str) -> bool {
    match provider_id {
        "codex" => matches!(model,
            "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna"
            | "gpt-5.5-codex" | "gpt-5.4" | "gpt-5.4-mini"
            | "gpt-5.3-codex" | "gpt-5.2" | "gpt-5-codex"
        ),
        "openai" => matches!(model,
            "gpt-5.6" | "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini"
            | "gpt-5.2"
        ),
        "anthropic" => matches!(model,
            "claude-opus-4-8" | "claude-opus-4.8"
            | "claude-sonnet-4-6" | "claude-sonnet-4.6"
            | "claude-haiku-4-5"
        ),
        "xai" => matches!(model, "grok-4.3" | "grok-build"),
        "deepseek" => matches!(model, "deepseek-v4-pro" | "deepseek-v4-flash"),
        "kimi" => matches!(model,
            "kimi-k2.7" | "kimi-k2.6" | "kimi-k2-thinking"
            | "kimi-k2.5" | "k3" | "kimi-latest"
        ),
        "minimax" => matches!(model, "MiniMax-M3" | "minimax-m3"),
        "xiaomi" => matches!(model, "mimo-v2.5-pro" | "mimo-v2.5"),
        "zai" => matches!(model, "glm-5.2" | "glm-5" | "glm-4.7" | "glm-4.5"),
        "fugu" => matches!(model, "fugu-ultra"),
        "moonshot" => matches!(model, "kimi-latest"),
        "codegraff" => matches!(model,
            "deepseek-v4-pro" | "deepseek-v4-flash"
            | "gpt-5.6" | "gpt-5.5" | "gpt-5.4"
            | "claude-opus-4-8" | "claude-sonnet-4-6"
            | "grok-4.3" | "grok-build"
            | "mimo-v2.5-pro" | "glm-5.2"
            | "kimi-k2.7" | "MiniMax-M3" | "fugu-ultra"
        ),
        // Local providers only match their known model prefixes
        "mlx" => model.starts_with("mlx-community/"),
        "lmstudio" => model == "lmstudio" || model.contains('/'),
        // Fireworks uses full model paths
        "fireworks" => model.contains('/'),
        _ => false,
    }
}

/// Default model for a provider, resolving aliases.
pub fn provider_default_model<'a>(provider_id: &str, fallback: &'a str) -> &'a str {
    match provider_id {
        "codex" => "gpt-5.6-sol",
        "openai" => "gpt-5.6",
        "anthropic" => "claude-opus-4-8",
        "xai" => "grok-4.3",
        "deepseek" => "deepseek-v4-pro",
        "kimi" => "k3",
        "zai" => "glm-5.2",
        "minimax" => "MiniMax-M3",
        "xiaomi" => "mimo-v2.5-pro",
        "fugu" => "fugu-ultra",
        "moonshot" => "kimi-latest",
        "codegraff" => "deepseek-v4-pro",
        _ => fallback,
    }
}

/// Kimi-specific: does this model use the Anthropic protocol?
pub fn kimi_protocol_is_anthropic(_model: &str) -> bool {
    // Currently no Kimi models use Anthropic protocol by default;
    // this is a placeholder for future catalog-driven switching.
    false
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

    #[test]
    fn test_builtin_specs_count() {
        let specs = builtin_specs();
        assert!(specs.len() >= 15, "expected at least 15 builtin providers");
        // Verify key providers exist
        let ids: Vec<&str> = specs.iter().map(|s| s.id).collect();
        assert!(ids.contains(&"codex"), "codex provider must exist");
        assert!(ids.contains(&"xai"), "xAI provider must exist");
        assert!(ids.contains(&"anthropic"), "Anthropic provider must exist");
        assert!(ids.contains(&"openai"), "OpenAI provider must exist");
    }

    #[test]
    fn codegraff_uses_cloudflare_proxy() {
        let spec = builtin_specs()
            .iter()
            .find(|spec| spec.id == "codegraff")
            .expect("Codegraff provider spec");

        assert_eq!(
            spec.url,
            "https://aiko.theclarityproject.net/v1/chat/completions"
        );
        assert_eq!(spec.env_key, "AIKO_ACCESS_TOKEN");
        assert!(!spec.url.contains("gateway.codegraff.com"));
    }

    #[test]
    fn test_context_window_known_models() {
        assert_eq!(context_window_for("codex", "gpt-5.6-sol"), 270_000);
        assert_eq!(context_window_for("xai", "grok-4.3"), 1_000_000);
        assert_eq!(context_window_for("anthropic", "claude-opus-4-8"), 200_000);
    }

    #[test]
    fn test_context_window_unknown_fallback() {
        assert_eq!(context_window_for("unknown", "some-model"), 32_000);
    }

    #[test]
    fn test_is_known_model() {
        assert!(is_known_model("codex", "gpt-5.6-sol"));
        assert!(is_known_model("xai", "grok-4.3"));
        assert!(!is_known_model("unknown", "totally-made-up"));
    }

    #[test]
    fn test_provider_default_model() {
        assert_eq!(provider_default_model("codex", ""), "gpt-5.6-sol");
        assert_eq!(provider_default_model("xai", ""), "grok-4.3");
        assert_eq!(provider_default_model("unknown", "fallback"), "fallback");
    }

    #[test]
    fn test_codex_responses_kind() {
        let codex_spec = builtin_specs()
            .iter()
            .find(|s| s.id == "codex")
            .expect("codex spec must exist");
        assert_eq!(codex_spec.kind, ProviderKind::Responses);
        assert_eq!(codex_spec.url, "https://chatgpt.com/backend-api/codex/responses");
    }

    #[test]
    fn test_grok_is_openai_compatible() {
        let xai_spec = builtin_specs()
            .iter()
            .find(|s| s.id == "xai")
            .expect("xAI spec must exist");
        assert_eq!(xai_spec.kind, ProviderKind::OpenAi);
        assert_eq!(xai_spec.default_model, "grok-4.3");
    }
}
