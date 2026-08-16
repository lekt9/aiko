//! Contract-fenced admitted capability surface for the production Aiko agent.
//!
//! Generated package bytes enter this registry inert.  They can reach an
//! effector only through list -> admit -> attach -> claim -> immediate use.
//! Authority is a fresh verified projection supplied by Contract; request JSON
//! never supplies identity, leases, credentials, or budgets.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const API_VERSION: &str = "aiko.admitted-tools/v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityGrant {
    pub subject: String,
    pub tenant: String,
    pub effect: String,
    pub resource_prefix: String,
    pub credential_audience: String,
    pub credential_generation: u64,
}

/// Facts verified outside request payloads from the current Contract lease and
/// destination credential store.  A value is intentionally single-use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifiedDispatchAuthority {
    pub subject: String,
    pub tenant: String,
    pub subject_verified: bool,
    pub tenant_verified: bool,
    pub lease_current: bool,
    pub lease_fence: u64,
    pub credential_valid: bool,
    pub credential_audience: String,
    pub credential_generation: u64,
    pub remaining_budget: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolUseRequest {
    pub effect: String,
    pub resource: String,
    pub cost: u64,
}

/// The sole process envelope generated packages may receive.  In particular
/// there is no inherited environment and no HOME fallback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct InertExecutionEnvelope {
    pub env: BTreeMap<String, String>,
    pub home: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleAction {
    List,
    Admit,
    Attach,
    Claim,
    Use,
    Revoke,
    Detach,
    Collect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LifecycleReceipt {
    pub api_version: String,
    pub sequence: u64,
    pub action: LifecycleAction,
    pub allowed: bool,
    pub reason: String,
    pub name: String,
    pub digest: String,
    pub admission_generation: u64,
    pub attachment_generation: u64,
    pub revocation_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolClaim {
    name: String,
    digest: String,
    admission_generation: u64,
    attachment_generation: u64,
    revocation_generation: u64,
    lease_fence: u64,
    credential_generation: u64,
    request: ToolUseRequest,
    claim_generation: u64,
    seal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DispatchReceipt<T> {
    pub lifecycle: LifecycleReceipt,
    pub output: Option<T>,
}

#[derive(Debug, Clone)]
struct Package {
    bytes: Vec<u8>,
    digest: String,
    admitted: bool,
    attached: bool,
    revoked: bool,
    admission_generation: u64,
    attachment_generation: u64,
    revocation_generation: u64,
    claim_generation: u64,
    active_claim: Option<String>,
    grant: Option<CapabilityGrant>,
}

#[derive(Debug, Default)]
pub struct AikoAgentCapabilitySurface {
    packages: BTreeMap<String, Package>,
    sequence: u64,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
fn valid_text(value: &str) -> bool {
    !value.is_empty() && !value.contains(['\n', '\r'])
}

impl AikoAgentCapabilitySurface {
    pub fn new() -> Self {
        Self::default()
    }

    /// List bytes under their precomputed identity.  This stores no executable
    /// handle and therefore cannot dispatch the generated package.
    pub fn list(&mut self, name: &str, bytes: Vec<u8>, digest: &str) -> LifecycleReceipt {
        if !valid_text(name) || bytes.is_empty() || !valid_digest(digest) {
            return self.refusal(LifecycleAction::List, "invalid_package", name, digest);
        }
        if sha256(&bytes) != digest {
            return self.refusal(LifecycleAction::List, "wrong_digest", name, digest);
        }
        if self.packages.contains_key(name) {
            return self.refusal(LifecycleAction::List, "already_listed", name, digest);
        }
        self.packages.insert(
            name.to_owned(),
            Package {
                bytes,
                digest: digest.to_owned(),
                admitted: false,
                attached: false,
                revoked: false,
                admission_generation: 0,
                attachment_generation: 0,
                revocation_generation: 0,
                claim_generation: 0,
                active_claim: None,
                grant: None,
            },
        );
        self.receipt(LifecycleAction::List, true, "ok", name, digest)
    }

    pub fn catalog(&self) -> Vec<(String, String, bool, bool, bool)> {
        self.packages
            .iter()
            .map(|(n, p)| {
                (
                    n.clone(),
                    p.digest.clone(),
                    p.admitted,
                    p.attached,
                    p.revoked,
                )
            })
            .collect()
    }

    pub fn admit(&mut self, name: &str, digest: &str) -> LifecycleReceipt {
        let Some(p) = self.packages.get_mut(name) else {
            return self.refusal(LifecycleAction::Admit, "unlisted", name, digest);
        };
        if p.digest != digest || sha256(&p.bytes) != digest {
            return self.refusal(LifecycleAction::Admit, "wrong_digest", name, digest);
        }
        if p.revoked {
            return self.refusal(LifecycleAction::Admit, "revoked", name, digest);
        }
        p.admitted = true;
        p.admission_generation += 1;
        p.active_claim = None;
        self.receipt(LifecycleAction::Admit, true, "ok", name, digest)
    }

    pub fn attach(&mut self, name: &str, digest: &str, grant: CapabilityGrant) -> LifecycleReceipt {
        let Some(p) = self.packages.get_mut(name) else {
            return self.refusal(LifecycleAction::Attach, "unlisted", name, digest);
        };
        if p.digest != digest || sha256(&p.bytes) != digest {
            return self.refusal(LifecycleAction::Attach, "wrong_digest", name, digest);
        }
        if !p.admitted {
            return self.refusal(LifecycleAction::Attach, "not_admitted", name, digest);
        }
        if p.revoked {
            return self.refusal(LifecycleAction::Attach, "revoked", name, digest);
        }
        if p.attached {
            return self.refusal(LifecycleAction::Attach, "already_attached", name, digest);
        }
        if ![
            &grant.subject,
            &grant.tenant,
            &grant.effect,
            &grant.resource_prefix,
            &grant.credential_audience,
        ]
        .into_iter()
        .all(|v| valid_text(v))
        {
            return self.refusal(LifecycleAction::Attach, "invalid_grant", name, digest);
        }
        p.grant = Some(grant);
        p.attached = true;
        p.attachment_generation += 1;
        p.active_claim = None;
        self.receipt(LifecycleAction::Attach, true, "ok", name, digest)
    }

    pub fn claim(
        &mut self,
        name: &str,
        digest: &str,
        request: ToolUseRequest,
        authority: &VerifiedDispatchAuthority,
    ) -> Result<ToolClaim, LifecycleReceipt> {
        let Some(p) = self.packages.get(name) else {
            return Err(self.refusal(LifecycleAction::Claim, "unlisted", name, digest));
        };
        if p.digest != digest || sha256(&p.bytes) != digest {
            return Err(self.refusal(LifecycleAction::Claim, "wrong_digest", name, digest));
        }
        if !p.admitted {
            return Err(self.refusal(LifecycleAction::Claim, "not_admitted", name, digest));
        }
        if p.revoked {
            return Err(self.refusal(LifecycleAction::Claim, "revoked", name, digest));
        }
        if !p.attached {
            return Err(self.refusal(LifecycleAction::Claim, "not_attached", name, digest));
        }
        if let Err(reason) = authorize(
            p.grant.as_ref().expect("attached grant"),
            &request,
            authority,
        ) {
            return Err(self.refusal(LifecycleAction::Claim, reason, name, digest));
        }
        let p = self.packages.get_mut(name).unwrap();
        p.claim_generation += 1;
        let mut claim = ToolClaim {
            name: name.to_owned(),
            digest: digest.to_owned(),
            admission_generation: p.admission_generation,
            attachment_generation: p.attachment_generation,
            revocation_generation: p.revocation_generation,
            lease_fence: authority.lease_fence,
            credential_generation: authority.credential_generation,
            request,
            claim_generation: p.claim_generation,
            seal: String::new(),
        };
        claim.seal = claim_seal(&claim);
        p.active_claim = Some(claim.seal.clone());
        Ok(claim)
    }

    /// Revalidates every fact immediately before invoking the effector. The
    /// fresh authority callback is called after claim creation, never cached.
    pub fn use_tool<T, A, D>(
        &mut self,
        name: &str,
        digest: &str,
        request: ToolUseRequest,
        authority_at_claim: VerifiedDispatchAuthority,
        refresh_authority: A,
        dispatch: D,
    ) -> DispatchReceipt<T>
    where
        A: FnOnce() -> Result<VerifiedDispatchAuthority, String>,
        D: FnOnce(&[u8], &ToolUseRequest, &InertExecutionEnvelope) -> T,
    {
        let claim = match self.claim(name, digest, request, &authority_at_claim) {
            Ok(c) => c,
            Err(r) => {
                return DispatchReceipt {
                    lifecycle: r,
                    output: None,
                };
            }
        };
        let fresh = match refresh_authority() {
            Ok(v) => v,
            Err(reason) => {
                return DispatchReceipt {
                    lifecycle: self.refusal(LifecycleAction::Use, &reason, name, digest),
                    output: None,
                };
            }
        };
        let reason = self.validate_use(&claim, &fresh);
        if let Err(reason) = reason {
            return DispatchReceipt {
                lifecycle: self.refusal(LifecycleAction::Use, reason, name, digest),
                output: None,
            };
        }
        let bytes = self.packages.get(name).unwrap().bytes.clone();
        let envelope = InertExecutionEnvelope::default();
        let output = dispatch(&bytes, &claim.request, &envelope);
        DispatchReceipt {
            lifecycle: self.receipt(LifecycleAction::Use, true, "ok", name, digest),
            output: Some(output),
        }
    }

    fn validate_use(
        &self,
        claim: &ToolClaim,
        authority: &VerifiedDispatchAuthority,
    ) -> Result<(), &'static str> {
        let p = self.packages.get(&claim.name).ok_or("unlisted")?;
        if p.digest != claim.digest || sha256(&p.bytes) != claim.digest {
            return Err("wrong_digest");
        }
        if !p.admitted {
            return Err("not_admitted");
        }
        if p.revoked {
            return Err("revoked");
        }
        if !p.attached {
            return Err("not_attached");
        }
        if claim.admission_generation != p.admission_generation
            || claim.attachment_generation != p.attachment_generation
            || claim.revocation_generation != p.revocation_generation
            || claim.claim_generation != p.claim_generation
            || p.active_claim.as_deref() != Some(&claim.seal)
            || claim_seal(claim) != claim.seal
        {
            return Err("stale_claim");
        }
        if claim.lease_fence != authority.lease_fence {
            return Err("stale_lease_fence");
        }
        if claim.credential_generation != authority.credential_generation {
            return Err("credential_generation_stale");
        }
        authorize(p.grant.as_ref().unwrap(), &claim.request, authority)
    }

    pub fn revoke(&mut self, name: &str, digest: &str) -> LifecycleReceipt {
        let Some(p) = self.packages.get_mut(name) else {
            return self.refusal(LifecycleAction::Revoke, "unlisted", name, digest);
        };
        if p.digest != digest {
            return self.refusal(LifecycleAction::Revoke, "wrong_digest", name, digest);
        }
        p.revoked = true;
        p.revocation_generation += 1;
        p.active_claim = None;
        self.receipt(LifecycleAction::Revoke, true, "ok", name, digest)
    }
    pub fn detach(&mut self, name: &str, digest: &str) -> LifecycleReceipt {
        let Some(p) = self.packages.get_mut(name) else {
            return self.refusal(LifecycleAction::Detach, "unlisted", name, digest);
        };
        if p.digest != digest {
            return self.refusal(LifecycleAction::Detach, "wrong_digest", name, digest);
        }
        if !p.attached {
            return self.refusal(LifecycleAction::Detach, "not_attached", name, digest);
        }
        p.attached = false;
        p.attachment_generation += 1;
        p.active_claim = None;
        self.receipt(LifecycleAction::Detach, true, "ok", name, digest)
    }
    pub fn collect(&mut self, name: &str, digest: &str) -> LifecycleReceipt {
        let Some(p) = self.packages.get(name) else {
            return self.refusal(LifecycleAction::Collect, "unlisted", name, digest);
        };
        if p.digest != digest {
            return self.refusal(LifecycleAction::Collect, "wrong_digest", name, digest);
        }
        if p.attached {
            return self.refusal(LifecycleAction::Collect, "detach_first", name, digest);
        }
        if !p.revoked {
            return self.refusal(LifecycleAction::Collect, "revoke_first", name, digest);
        }
        let receipt = self.receipt(LifecycleAction::Collect, true, "ok", name, digest);
        self.packages.remove(name);
        receipt
    }

    fn refusal(
        &mut self,
        action: LifecycleAction,
        reason: &str,
        name: &str,
        digest: &str,
    ) -> LifecycleReceipt {
        self.receipt(action, false, reason, name, digest)
    }
    fn receipt(
        &mut self,
        action: LifecycleAction,
        allowed: bool,
        reason: &str,
        name: &str,
        digest: &str,
    ) -> LifecycleReceipt {
        self.sequence += 1;
        let (a, t, r) = self
            .packages
            .get(name)
            .map(|p| {
                (
                    p.admission_generation,
                    p.attachment_generation,
                    p.revocation_generation,
                )
            })
            .unwrap_or((0, 0, 0));
        LifecycleReceipt {
            api_version: API_VERSION.to_owned(),
            sequence: self.sequence,
            action,
            allowed,
            reason: reason.to_owned(),
            name: name.to_owned(),
            digest: digest.to_owned(),
            admission_generation: a,
            attachment_generation: t,
            revocation_generation: r,
        }
    }
}

fn authorize(
    grant: &CapabilityGrant,
    request: &ToolUseRequest,
    a: &VerifiedDispatchAuthority,
) -> Result<(), &'static str> {
    if !a.subject_verified || !a.tenant_verified {
        return Err("verified_identity_required");
    }
    if a.subject != grant.subject {
        return Err("subject_denied");
    }
    if a.tenant != grant.tenant {
        return Err("tenant_denied");
    }
    if !a.lease_current || a.lease_fence == 0 {
        return Err("current_lease_required");
    }
    if request.effect != grant.effect {
        return Err("effect_denied");
    }
    if !request.resource.starts_with(&grant.resource_prefix) {
        return Err("resource_denied");
    }
    if !a.credential_valid {
        return Err("credential_required");
    }
    if a.credential_audience != grant.credential_audience {
        return Err("credential_audience_denied");
    }
    if a.credential_generation != grant.credential_generation {
        return Err("credential_generation_stale");
    }
    if request.cost > a.remaining_budget {
        return Err("budget_exhausted");
    }
    Ok(())
}
fn claim_seal(c: &ToolClaim) -> String {
    let bytes = serde_json::to_vec(&(
        "aiko.capability-claim/v1",
        &c.name,
        &c.digest,
        c.admission_generation,
        c.attachment_generation,
        c.revocation_generation,
        c.lease_fence,
        c.credential_generation,
        &c.request,
        c.claim_generation,
    ))
    .expect("claim serialization");
    sha256(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn auth() -> VerifiedDispatchAuthority {
        VerifiedDispatchAuthority {
            subject: "worker".into(),
            tenant: "tenant".into(),
            subject_verified: true,
            tenant_verified: true,
            lease_current: true,
            lease_fence: 7,
            credential_valid: true,
            credential_audience: "api.example".into(),
            credential_generation: 3,
            remaining_budget: 2,
        }
    }
    fn grant() -> CapabilityGrant {
        CapabilityGrant {
            subject: "worker".into(),
            tenant: "tenant".into(),
            effect: "send".into(),
            resource_prefix: "https://api.example/t/".into(),
            credential_audience: "api.example".into(),
            credential_generation: 3,
        }
    }
    fn request() -> ToolUseRequest {
        ToolUseRequest {
            effect: "send".into(),
            resource: "https://api.example/t/1".into(),
            cost: 2,
        }
    }
    fn ready() -> (AikoAgentCapabilitySurface, String) {
        let b = b"generated".to_vec();
        let d = sha256(&b);
        let mut s = AikoAgentCapabilitySurface::new();
        assert!(s.list("tool", b, d.as_str()).allowed);
        assert!(s.admit("tool", &d).allowed);
        assert!(s.attach("tool", &d, grant()).allowed);
        (s, d)
    }
    #[test]
    fn bytes_are_inert_and_direct_unlisted_use_refuses() {
        let mut s = AikoAgentCapabilitySurface::new();
        let r = s.use_tool(
            "x",
            &"0".repeat(64),
            request(),
            auth(),
            || Ok(auth()),
            |_, _, _| panic!("dispatched"),
        );
        assert_eq!(r.lifecycle.reason, "unlisted");
        let b = b"generated".to_vec();
        let d = sha256(&b);
        assert!(s.list("tool", b, &d).allowed);
        let r = s.use_tool(
            "tool",
            &d,
            request(),
            auth(),
            || Ok(auth()),
            |_, _, _| panic!("listed bytes executed"),
        );
        assert_eq!(r.lifecycle.reason, "not_admitted");
    }
    #[test]
    fn fresh_fence_credential_and_budget_are_checked_before_dispatch() {
        for reason in [
            "stale_lease_fence",
            "credential_generation_stale",
            "budget_exhausted",
        ] {
            let (mut s, d) = ready();
            let mut fresh = auth();
            match reason {
                "stale_lease_fence" => fresh.lease_fence += 1,
                "credential_generation_stale" => fresh.credential_generation += 1,
                _ => fresh.remaining_budget = 1,
            };
            let r = s.use_tool(
                "tool",
                &d,
                request(),
                auth(),
                || Ok(fresh),
                |_, _, _| panic!("dispatched"),
            );
            assert_eq!(r.lifecycle.reason, reason);
        }
    }
    #[test]
    fn successful_dispatch_has_no_ambient_env_or_home() {
        let (mut s, d) = ready();
        let r = s.use_tool(
            "tool",
            &d,
            request(),
            auth(),
            || Ok(auth()),
            |bytes, _, e| {
                assert_eq!(bytes, b"generated");
                assert!(e.env.is_empty());
                assert_eq!(e.home, None);
                "sent"
            },
        );
        assert!(r.lifecycle.allowed);
        assert_eq!(r.output, Some("sent"));
    }
    #[test]
    fn revoke_generation_invalidates_and_collect_requires_detach() {
        let (mut s, d) = ready();
        let rev = s.revoke("tool", &d);
        assert_eq!(rev.revocation_generation, 1);
        let r = s.use_tool(
            "tool",
            &d,
            request(),
            auth(),
            || Ok(auth()),
            |_, _, _| panic!(),
        );
        assert_eq!(r.lifecycle.reason, "revoked");
        assert_eq!(s.collect("tool", &d).reason, "detach_first");
        assert!(s.detach("tool", &d).allowed);
        assert!(s.collect("tool", &d).allowed);
        assert!(s.catalog().is_empty());
    }
    #[test]
    fn digest_and_all_authority_dimensions_fail_closed() {
        let (mut s, d) = ready();
        let mut cases = Vec::new();
        let mut a = auth();
        a.subject_verified = false;
        cases.push((a, "verified_identity_required"));
        let mut a = auth();
        a.tenant = "other".into();
        cases.push((a, "tenant_denied"));
        let mut a = auth();
        a.lease_current = false;
        cases.push((a, "current_lease_required"));
        let mut a = auth();
        a.credential_audience = "other".into();
        cases.push((a, "credential_audience_denied"));
        for (a, want) in cases {
            let r = s.use_tool(
                "tool",
                &d,
                request(),
                a.clone(),
                || Ok(a),
                |_, _, _| panic!(),
            );
            assert_eq!(r.lifecycle.reason, want);
        }
        assert_eq!(s.admit("tool", &"0".repeat(64)).reason, "wrong_digest");
    }
}
