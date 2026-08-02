//! Bridge between `xai-aiko-providers` and `xai-grok-sampler` types.
//! Free conversion functions (orphan rule prevents `impl From` across crates).

use xai_aiko_providers::{AuthStyle, CredentialSource, Provider, ProviderKind, ProviderRouter, RouterError};
use xai_grok_sampler::SamplerConfig;
use xai_grok_sampling_types::ApiBackend;

/// Convert a Provider to a SamplerConfig.
pub fn provider_to_sampler_config(p: &Provider) -> SamplerConfig {
    SamplerConfig {
        api_key: Some(p.api_key.clone()),
        base_url: p.url.clone(),
        model: p.model.clone(),
        api_backend: match p.kind {
            ProviderKind::OpenAi => ApiBackend::ChatCompletions,
            ProviderKind::Responses => ApiBackend::Responses,
            ProviderKind::Anthropic => ApiBackend::Messages,
        },
        auth_scheme: match p.auth {
            AuthStyle::Bearer => xai_grok_sampler::AuthScheme::Bearer,
            AuthStyle::XApiKey => xai_grok_sampler::AuthScheme::XApiKey,
        },
        context_window: p.context,
        ..Default::default()
    }
}

/// Convert a SamplerConfig to a Provider.
pub fn sampler_config_to_provider(cfg: &SamplerConfig) -> Provider {
    Provider {
        id: String::new(),
        kind: match cfg.api_backend {
            ApiBackend::ChatCompletions => ProviderKind::OpenAi,
            ApiBackend::Responses => ProviderKind::Responses,
            ApiBackend::Messages => ProviderKind::Anthropic,
        },
        auth: match cfg.auth_scheme {
            xai_grok_sampler::AuthScheme::Bearer => AuthStyle::Bearer,
            xai_grok_sampler::AuthScheme::XApiKey => AuthStyle::XApiKey,
        },
        url: cfg.base_url.clone(),
        api_key: cfg.api_key.clone().unwrap_or_default(),
        model: cfg.model.clone(),
        context: cfg.context_window,
        account: String::new(),
        source: CredentialSource::Environment,
    }
}

/// Resolve a model to a SamplerConfig via the provider router.
pub fn resolve_to_sampler_config(
    router: &ProviderRouter,
    model: &str,
) -> Result<SamplerConfig, RouterError> {
    let provider = router.provider_for(model)?;
    Ok(provider_to_sampler_config(&provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_to_config_codex() {
        let p = Provider {
            id: "codex".into(),
            kind: ProviderKind::Responses,
            auth: AuthStyle::Bearer,
            url: "https://chatgpt.com/backend-api/codex/responses".into(),
            api_key: "token".into(),
            model: "gpt-5.6-sol".into(),
            context: 270_000,
            account: String::new(),
            source: CredentialSource::Environment,
        };

        let cfg = provider_to_sampler_config(&p);
        assert_eq!(cfg.api_key, Some("token".into()));
        assert_eq!(cfg.base_url, "https://chatgpt.com/backend-api/codex/responses");
        assert_eq!(cfg.model, "gpt-5.6-sol");
        assert_eq!(cfg.api_backend, ApiBackend::Responses);
        assert_eq!(cfg.context_window, 270_000);
    }

    #[test]
    fn test_provider_to_config_grok() {
        let p = Provider {
            id: "xai".into(),
            kind: ProviderKind::OpenAi,
            auth: AuthStyle::Bearer,
            url: "https://api.x.ai/v1/chat/completions".into(),
            api_key: "xai-key".into(),
            model: "grok-4.3".into(),
            context: 1_000_000,
            account: String::new(),
            source: CredentialSource::Environment,
        };

        let cfg = provider_to_sampler_config(&p);
        assert_eq!(cfg.api_backend, ApiBackend::ChatCompletions);
        assert_eq!(cfg.model, "grok-4.3");
        assert_eq!(cfg.context_window, 1_000_000);
    }

    #[test]
    fn test_config_to_provider_roundtrip() {
        let cfg = SamplerConfig {
            api_key: Some("key".into()),
            base_url: "https://api.anthropic.com/v1".into(),
            model: "claude-opus-4-8".into(),
            api_backend: ApiBackend::Messages,
            auth_scheme: xai_grok_sampler::AuthScheme::XApiKey,
            context_window: 200_000,
            ..Default::default()
        };

        let p = sampler_config_to_provider(&cfg);
        assert_eq!(p.kind, ProviderKind::Anthropic);
        assert_eq!(p.auth, AuthStyle::XApiKey);
        assert_eq!(p.url, "https://api.anthropic.com/v1");
        assert_eq!(p.context, 200_000);

        // Roundtrip
        let cfg2 = provider_to_sampler_config(&p);
        assert_eq!(cfg2.api_backend, ApiBackend::Messages);
        assert_eq!(cfg2.model, "claude-opus-4-8");
    }

    #[test]
    fn test_resolve_to_sampler_config_requires_env_keys() {
        let keys = xai_aiko_providers::Keys::from_env();
        let router = ProviderRouter::new(keys);
        let result = resolve_to_sampler_config(&router, "gpt-5.6-sol");
        assert!(result.is_err());
    }
}
