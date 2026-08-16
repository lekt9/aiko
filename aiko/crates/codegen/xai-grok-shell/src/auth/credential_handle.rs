//! Contract-bound opaque handles for native account sessions.
//!
//! This module deliberately does not implement a vault. The account secret stays in the
//! existing native Aiko account provider and is resolved only while executing an already
//! admitted effect. Durable callers may retain [`CredentialHandleMetadata`], never a bearer.

use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

use super::{AuthManager, AuthMode, TOKEN_TTL};

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum CredentialHandleError {
    #[error("credential handle field is empty: {0}")]
    Empty(&'static str),
    #[error("account credential provider is unavailable")]
    ProviderUnavailable,
    #[error("API-key credentials cannot cross the account credential boundary")]
    ApiKeyForbidden,
    #[error("credential handle is unknown")]
    Unknown,
    #[error("credential handle binding mismatch: {0}")]
    BindingMismatch(&'static str),
    #[error("credential handle is expired")]
    Expired,
    #[error("credential handle is revoked")]
    Revoked,
    #[error("credential handle was already consumed")]
    Replay,
    #[error("MFA is not satisfied")]
    MfaRequired,
    #[error("destination or redirect is not admitted: {0}")]
    Destination(String),
    #[error("credential registry lock is poisoned")]
    Poisoned,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayPolicy {
    OneShot,
    Reusable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialHandleBinding {
    pub subject: String,
    pub tenant: String,
    pub contract_execution: String,
    pub lease_fence: u64,
    pub audience: String,
    pub destination_host: String,
    pub operation: String,
    pub resource: String,
    pub credential_generation: u64,
    pub expires_at_unix: i64,
    pub mfa_required: bool,
    pub replay_policy: ReplayPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialHandleMetadata {
    pub handle: String,
    #[serde(flatten)]
    pub binding: CredentialHandleBinding,
    pub revoked: bool,
    pub use_count: u64,
}

/// The complete destination history fixed by the HTTP membrane before a secret is resolved.
#[derive(Debug, Clone)]
pub struct DestinationPlan<'a> {
    pub audience: &'a str,
    pub initial: &'a str,
    pub redirects: &'a [&'a str],
    pub final_destination: &'a str,
}

#[derive(Debug, Clone)]
pub struct CredentialUse<'a> {
    pub handle: &'a str,
    pub subject: &'a str,
    pub tenant: &'a str,
    pub contract_execution: &'a str,
    pub lease_fence: u64,
    pub operation: &'a str,
    pub resource: &'a str,
    pub credential_generation: u64,
    pub destination: DestinationPlan<'a>,
}

/// Account session obtained from native Aiko auth. Secret bytes have no public accessor and can
/// only be placed directly on the admitted request boundary.
pub struct NativeAccountSession {
    bearer: Vec<u8>,
    subject: String,
    tenant: String,
    generation: u64,
    expires_at_unix: i64,
    mfa_satisfied: bool,
}

impl std::fmt::Debug for NativeAccountSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeAccountSession")
            .field("bearer", &"<native account credential>")
            .field("subject", &self.subject)
            .field("tenant", &self.tenant)
            .field("generation", &self.generation)
            .field("expires_at_unix", &self.expires_at_unix)
            .finish()
    }
}

impl Drop for NativeAccountSession {
    fn drop(&mut self) {
        self.bearer.fill(0);
    }
}

/// No filesystem fallback is part of this contract. A production implementation delegates to
/// the already-authenticated native account provider; synthetic implementations are test-only.
pub trait NativeAccountCredentialProvider: Send + Sync {
    fn resolve_account_session(&self) -> Result<NativeAccountSession, CredentialHandleError>;
}

/// Adapter for the shell's current account credential provider. Plain API keys are rejected
/// rather than silently promoted to account authority.
pub struct AuthManagerAccountProvider {
    manager: Arc<AuthManager>,
}

impl AuthManagerAccountProvider {
    pub fn new(manager: Arc<AuthManager>) -> Self {
        Self { manager }
    }
}

impl NativeAccountCredentialProvider for AuthManagerAccountProvider {
    fn resolve_account_session(&self) -> Result<NativeAccountSession, CredentialHandleError> {
        let auth = self
            .manager
            .current_or_expired()
            .ok_or(CredentialHandleError::ProviderUnavailable)?;
        if matches!(auth.auth_mode, AuthMode::ApiKey) || !auth.is_session_auth() {
            return Err(CredentialHandleError::ApiKeyForbidden);
        }
        let subject = auth
            .principal_id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| auth.user_id.clone());
        let tenant = auth
            .team_id
            .clone()
            .or(auth.organization_id.clone())
            .filter(|value| !value.is_empty())
            .ok_or(CredentialHandleError::ProviderUnavailable)?;
        let expires_at_unix = auth
            .expires_at
            .unwrap_or(auth.create_time + TOKEN_TTL)
            .timestamp();
        let generation = u64::try_from(auth.create_time.timestamp_millis()).unwrap_or(0);
        Ok(NativeAccountSession {
            bearer: auth.key.into_bytes(),
            subject,
            tenant,
            generation,
            expires_at_unix,
            // Interactive account auth is the native MFA boundary. A provider that cannot make
            // this assertion must supply a different adapter and return false.
            mfa_satisfied: true,
        })
    }
}

#[derive(Clone)]
struct Record {
    metadata: CredentialHandleMetadata,
}

/// In-memory capability registry. Only public metadata is cloneable/serializable; the secret is
/// resolved from native auth under the registry write lease immediately before the effect.
pub struct CredentialHandleBroker<P: NativeAccountCredentialProvider> {
    provider: P,
    records: RwLock<BTreeMap<String, Record>>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl<P: NativeAccountCredentialProvider> CredentialHandleBroker<P> {
    pub fn new(provider: P) -> Self {
        Self::with_clock_and_id(
            provider,
            || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64
            },
            || format!("account:handle:{}", uuid::Uuid::new_v4()),
        )
    }

    pub fn with_clock_and_id(
        provider: P,
        now: impl Fn() -> i64 + Send + Sync + 'static,
        id: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            provider,
            records: RwLock::new(BTreeMap::new()),
            now: Arc::new(now),
            id: Arc::new(id),
        }
    }

    pub fn issue(
        &self,
        binding: CredentialHandleBinding,
    ) -> Result<CredentialHandleMetadata, CredentialHandleError> {
        validate_binding(&binding)?;
        if binding.expires_at_unix <= (self.now)() {
            return Err(CredentialHandleError::Expired);
        }
        let handle = (self.id)();
        if !handle.starts_with("account:handle:") || handle.len() <= "account:handle:".len() {
            return Err(CredentialHandleError::Unknown);
        }
        let metadata = CredentialHandleMetadata {
            handle: handle.clone(),
            binding,
            revoked: false,
            use_count: 0,
        };
        let mut records = self
            .records
            .write()
            .map_err(|_| CredentialHandleError::Poisoned)?;
        if records.contains_key(&handle) {
            return Err(CredentialHandleError::Unknown);
        }
        records.insert(
            handle,
            Record {
                metadata: metadata.clone(),
            },
        );
        Ok(metadata)
    }

    pub fn metadata(
        &self,
        handle: &str,
    ) -> Result<CredentialHandleMetadata, CredentialHandleError> {
        self.records
            .read()
            .map_err(|_| CredentialHandleError::Poisoned)?
            .get(handle)
            .map(|record| record.metadata.clone())
            .ok_or(CredentialHandleError::Unknown)
    }

    pub fn revoke(&self, handle: &str) -> Result<CredentialHandleMetadata, CredentialHandleError> {
        let mut records = self
            .records
            .write()
            .map_err(|_| CredentialHandleError::Poisoned)?;
        let record = records
            .get_mut(handle)
            .ok_or(CredentialHandleError::Unknown)?;
        record.metadata.revoked = true;
        Ok(record.metadata.clone())
    }

    /// Resolve and use a native account session while holding the same exclusive lease that
    /// serializes revoke. The callback is the effect boundary: it receives no bearer payload,
    /// only the ability to apply it directly to the already-fixed request.
    pub fn execute<R>(
        &self,
        use_: &CredentialUse<'_>,
        effect: impl FnOnce(AuthorizedAccountRequest<'_>) -> R,
    ) -> Result<R, CredentialHandleError> {
        let mut records = self
            .records
            .write()
            .map_err(|_| CredentialHandleError::Poisoned)?;
        let record = records
            .get_mut(use_.handle)
            .ok_or(CredentialHandleError::Unknown)?;
        revalidate_metadata(&record.metadata, use_, (self.now)())?;
        validate_destination(&record.metadata.binding, &use_.destination)?;

        // Destination and redirect chain are now fixed. Resolve only after that decision.
        let session = self.provider.resolve_account_session()?;
        revalidate_session(&record.metadata.binding, &session, (self.now)())?;

        // Re-check revoke/expiry/fence immediately before crossing the effect boundary. Because
        // revoke needs this same write lock, it can occur before or after the effect, never in the
        // lease-to-effect gap.
        revalidate_metadata(&record.metadata, use_, (self.now)())?;
        let result = effect(AuthorizedAccountRequest { session: &session });
        record.metadata.use_count = record.metadata.use_count.saturating_add(1);
        Ok(result)
    }
}

pub struct AuthorizedAccountRequest<'a> {
    session: &'a NativeAccountSession,
}

impl AuthorizedAccountRequest<'_> {
    /// The sole secret boundary: directly apply the account bearer to a request whose complete
    /// redirect history has already been admitted. No API-key/string/byte payload is returned.
    pub fn apply(self, request: RequestBuilder) -> Result<RequestBuilder, CredentialHandleError> {
        let bearer = std::str::from_utf8(&self.session.bearer)
            .map_err(|_| CredentialHandleError::ProviderUnavailable)?;
        Ok(request.bearer_auth(bearer))
    }
}

fn validate_binding(binding: &CredentialHandleBinding) -> Result<(), CredentialHandleError> {
    for (name, value) in [
        ("subject", binding.subject.as_str()),
        ("tenant", binding.tenant.as_str()),
        ("contract_execution", binding.contract_execution.as_str()),
        ("audience", binding.audience.as_str()),
        ("destination_host", binding.destination_host.as_str()),
        ("operation", binding.operation.as_str()),
        ("resource", binding.resource.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(CredentialHandleError::Empty(name));
        }
    }
    if binding.lease_fence == 0 || binding.credential_generation == 0 {
        return Err(CredentialHandleError::BindingMismatch(
            "zero generation or lease fence",
        ));
    }
    if binding.destination_host.contains('/') || binding.destination_host.contains('@') {
        return Err(CredentialHandleError::Destination(
            "host is not canonical".into(),
        ));
    }
    Ok(())
}

fn revalidate_metadata(
    metadata: &CredentialHandleMetadata,
    use_: &CredentialUse<'_>,
    now: i64,
) -> Result<(), CredentialHandleError> {
    if metadata.revoked {
        return Err(CredentialHandleError::Revoked);
    }
    if metadata.binding.expires_at_unix <= now {
        return Err(CredentialHandleError::Expired);
    }
    if metadata.binding.replay_policy == ReplayPolicy::OneShot && metadata.use_count != 0 {
        return Err(CredentialHandleError::Replay);
    }
    let checks = [
        (metadata.binding.subject.as_str() == use_.subject, "subject"),
        (metadata.binding.tenant.as_str() == use_.tenant, "tenant"),
        (
            metadata.binding.contract_execution.as_str() == use_.contract_execution,
            "execution",
        ),
        (
            metadata.binding.lease_fence == use_.lease_fence,
            "lease fence",
        ),
        (
            metadata.binding.operation.as_str() == use_.operation,
            "operation",
        ),
        (
            metadata.binding.resource.as_str() == use_.resource,
            "resource",
        ),
        (
            metadata.binding.credential_generation == use_.credential_generation,
            "generation",
        ),
    ];
    for (matches, field) in checks {
        if !matches {
            return Err(CredentialHandleError::BindingMismatch(field));
        }
    }
    Ok(())
}

fn revalidate_session(
    binding: &CredentialHandleBinding,
    session: &NativeAccountSession,
    now: i64,
) -> Result<(), CredentialHandleError> {
    if session.subject != binding.subject {
        return Err(CredentialHandleError::BindingMismatch("provider subject"));
    }
    if session.tenant != binding.tenant {
        return Err(CredentialHandleError::BindingMismatch("provider tenant"));
    }
    if session.generation != binding.credential_generation {
        return Err(CredentialHandleError::BindingMismatch(
            "provider generation",
        ));
    }
    if session.expires_at_unix <= now || binding.expires_at_unix > session.expires_at_unix {
        return Err(CredentialHandleError::Expired);
    }
    if binding.mfa_required && !session.mfa_satisfied {
        return Err(CredentialHandleError::MfaRequired);
    }
    Ok(())
}

fn canonical_host(raw: &str) -> Result<String, CredentialHandleError> {
    let url =
        Url::parse(raw).map_err(|_| CredentialHandleError::Destination("invalid URL".into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(CredentialHandleError::Destination(
            "HTTPS URL without userinfo or fragment required".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CredentialHandleError::Destination("host missing".into()))?;
    Ok(match url.port() {
        Some(port) => format!("{}:{}", host.to_ascii_lowercase(), port),
        None => host.to_ascii_lowercase(),
    })
}

fn validate_destination(
    binding: &CredentialHandleBinding,
    plan: &DestinationPlan<'_>,
) -> Result<(), CredentialHandleError> {
    if plan.audience != binding.audience {
        return Err(CredentialHandleError::BindingMismatch("audience"));
    }
    let mut destinations = Vec::with_capacity(plan.redirects.len() + 2);
    destinations.push(plan.initial);
    destinations.extend_from_slice(plan.redirects);
    destinations.push(plan.final_destination);
    for destination in destinations {
        if canonical_host(destination)? != binding.destination_host.to_ascii_lowercase() {
            return Err(CredentialHandleError::Destination(
                "cross-host redirect refused".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "credential_handle_tests.rs"]
mod credential_handle_tests;
