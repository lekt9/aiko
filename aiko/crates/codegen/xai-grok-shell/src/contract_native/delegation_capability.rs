//! Opaque Contract delegation for subagents.
//!
//! Lineage environment variables are routing metadata. Authority enters this
//! module only as a driver-verified parent lease, is intersected with the
//! spawn request and policy, and is adopted again from Contract's durable
//! journal before a child model or tool is allowed to run.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifiedParentAuthority {
    pub subject: String,
    pub tenant: String,
    pub root_id: String,
    pub parent_occurrence: String,
    pub execution_id: String,
    pub lease_id: String,
    pub fence: u64,
    pub expires_at_ms: u64,
    pub max_effects: u64,
    pub read_only: bool,
    pub effect_scopes: Vec<String>,
    pub resource_scopes: Vec<String>,
    pub credential_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DelegationPolicy {
    pub max_expires_at_ms: u64,
    pub max_effects: u64,
    #[serde(default)]
    pub force_read_only: bool,
    pub effect_scopes: Vec<String>,
    pub resource_scopes: Vec<String>,
    pub max_credential_generation: u64,
}

#[derive(Debug, Clone)]
pub struct BoundParentAuthority {
    pub parent: VerifiedParentAuthority,
    pub policy: DelegationPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChildRequest {
    pub audience: String,
    pub purpose: String,
    pub expires_at_ms: u64,
    pub max_effects: u64,
    pub read_only: bool,
    pub effect_scopes: Vec<String>,
    pub resource_scopes: Vec<String>,
    pub credential_generation: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueEnvelope<'a> {
    pub verified_parent: &'a VerifiedParentAuthority,
    pub request: &'a ChildRequest,
    pub policy: &'a DelegationPolicy,
    pub now_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IssuedRow {
    pub grant_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdoptionRequest {
    pub grant_id: String,
    pub subject: String,
    pub tenant: String,
    pub root_id: String,
    pub parent_occurrence: String,
    pub audience: String,
    pub now_ms: u64,
    pub current_execution_id: String,
    pub current_lease_id: String,
    pub current_fence: u64,
    pub credential_generation: u64,
    pub effects_already_used: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AdoptedGrant {
    pub grant_id: String,
    pub audience: String,
    pub purpose: String,
    pub read_only: bool,
    pub max_effects: u64,
    pub effect_scopes: Vec<String>,
    pub resource_scopes: Vec<String>,
    pub credential_generation: u64,
}

#[derive(Debug, Clone)]
pub struct DelegatedChildAuthority {
    pub adoption: AdoptionRequest,
    pub expected: ChildRequest,
}

fn unique_valid(items: &[String]) -> bool {
    let mut seen = BTreeSet::new();
    items.iter().all(|item| {
        !item.is_empty() && item.len() <= 512 && !item.contains('\n') && seen.insert(item.as_str())
    })
}

fn intersection(left: &[String], right: &[String]) -> Vec<String> {
    let right: BTreeSet<&str> = right.iter().map(String::as_str).collect();
    left.iter()
        .filter(|item| right.contains(item.as_str()))
        .cloned()
        .collect()
}

pub fn validate_parent_binding(
    binding: &BoundParentAuthority,
    root_id: &str,
    now_ms: u64,
) -> Result<(), &'static str> {
    let p = &binding.parent;
    let q = &binding.policy;
    if p.root_id != root_id {
        return Err("parent root mismatch");
    }
    if [
        p.subject.as_str(),
        p.tenant.as_str(),
        p.root_id.as_str(),
        p.parent_occurrence.as_str(),
        p.execution_id.as_str(),
        p.lease_id.as_str(),
    ]
    .iter()
    .any(|v| v.is_empty() || v.contains('\n'))
    {
        return Err("invalid verified parent identity");
    }
    if p.fence == 0 || p.expires_at_ms <= now_ms || q.max_expires_at_ms <= now_ms {
        return Err("expired or unfenced parent");
    }
    if !unique_valid(&p.effect_scopes)
        || !unique_valid(&p.resource_scopes)
        || !unique_valid(&q.effect_scopes)
        || !unique_valid(&q.resource_scopes)
    {
        return Err("invalid scope");
    }
    Ok(())
}

/// Produce the exact intersection. No caller-controlled fallback budget exists:
/// an empty intersection grants no effects/resources rather than meaning all.
pub fn attenuate(
    binding: &BoundParentAuthority,
    audience: String,
    purpose: String,
    now_ms: u64,
) -> Result<ChildRequest, &'static str> {
    validate_parent_binding(binding, &binding.parent.root_id, now_ms)?;
    if audience.is_empty()
        || purpose.is_empty()
        || audience.contains('\n')
        || purpose.contains('\n')
    {
        return Err("invalid child audience or purpose");
    }
    let parent = &binding.parent;
    let policy = &binding.policy;
    let read_only = parent.read_only || policy.force_read_only;
    let mut effect_scopes = intersection(&parent.effect_scopes, &policy.effect_scopes);
    let resource_scopes = intersection(&parent.resource_scopes, &policy.resource_scopes);
    let mut max_effects = parent.max_effects.min(policy.max_effects);
    if read_only {
        max_effects = 0;
        effect_scopes.clear();
    }
    Ok(ChildRequest {
        audience,
        purpose,
        expires_at_ms: parent.expires_at_ms.min(policy.max_expires_at_ms),
        max_effects,
        read_only,
        effect_scopes,
        resource_scopes,
        credential_generation: parent
            .credential_generation
            .min(policy.max_credential_generation),
    })
}

/// Match a tool against the adopted effect scope. Generic read/write scopes
/// and explicit tool names are supported; an empty scope never means ambient
/// access.
pub fn allows_tool(request: &ChildRequest, tool_name: &str, read_only: bool) -> bool {
    if tool_name.is_empty() || tool_name.contains('\n') {
        return false;
    }
    let class = if read_only { "tool:read" } else { "tool:write" };
    let exact = format!("tool:{tool_name}");
    request
        .effect_scopes
        .iter()
        .any(|scope| scope == class || scope == "tool:*" || scope == &exact)
}

pub fn adoption_request(
    parent: &VerifiedParentAuthority,
    request: &ChildRequest,
    grant_id: String,
    now_ms: u64,
) -> AdoptionRequest {
    AdoptionRequest {
        grant_id,
        subject: parent.subject.clone(),
        tenant: parent.tenant.clone(),
        root_id: parent.root_id.clone(),
        parent_occurrence: parent.parent_occurrence.clone(),
        audience: request.audience.clone(),
        now_ms,
        current_execution_id: parent.execution_id.clone(),
        current_lease_id: parent.lease_id.clone(),
        current_fence: parent.fence,
        credential_generation: request.credential_generation,
        effects_already_used: 0,
    }
}

pub fn validate_adoption(
    adopted: &AdoptedGrant,
    expected: &ChildRequest,
) -> Result<(), &'static str> {
    if adopted.grant_id.len() != 64 || !adopted.grant_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Contract returned a non-opaque grant id");
    }
    if adopted.audience != expected.audience
        || adopted.purpose != expected.purpose
        || adopted.read_only != expected.read_only
        || adopted.max_effects != expected.max_effects
        || adopted.effect_scopes != expected.effect_scopes
        || adopted.resource_scopes != expected.resource_scopes
        || adopted.credential_generation != expected.credential_generation
    {
        return Err("adopted authority differs from attenuated authority");
    }
    Ok(())
}

fn parents() -> &'static Mutex<HashMap<String, BoundParentAuthority>> {
    static PARENTS: OnceLock<Mutex<HashMap<String, BoundParentAuthority>>> = OnceLock::new();
    PARENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn children() -> &'static Mutex<HashMap<String, DelegatedChildAuthority>> {
    static CHILDREN: OnceLock<Mutex<HashMap<String, DelegatedChildAuthority>>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The Contract driver calls this with data read from a durable occurrence and
/// its current lease. Environment values are deliberately not consulted.
pub fn bind_verified_parent(
    session_id: &str,
    active_root: &str,
    authority: BoundParentAuthority,
    now_ms: u64,
) -> Result<(), &'static str> {
    if session_id.is_empty() {
        return Err("missing session");
    }
    validate_parent_binding(&authority, active_root, now_ms)?;
    parents()
        .lock()
        .map_err(|_| "delegation registry poisoned")?
        .insert(session_id.to_owned(), authority);
    Ok(())
}

pub fn parent_for_session(session_id: &str) -> Option<BoundParentAuthority> {
    parents().lock().ok()?.get(session_id).cloned()
}

pub fn remember_child(
    root_id: String,
    authority: DelegatedChildAuthority,
) -> Result<(), &'static str> {
    if root_id.is_empty() {
        return Err("missing child root");
    }
    children()
        .lock()
        .map_err(|_| "delegation registry poisoned")?
        .insert(root_id, authority);
    Ok(())
}

pub fn child_for_root(root_id: &str) -> Option<DelegatedChildAuthority> {
    children().lock().ok()?.get(root_id).cloned()
}

pub fn adoption_for_effect(
    root_id: &str,
    now_ms: u64,
    write_effect: bool,
) -> Result<DelegatedChildAuthority, &'static str> {
    let mut child = child_for_root(root_id).ok_or("no delegated capability for child root")?;
    if write_effect && child.expected.read_only {
        return Err("read-only delegated capability");
    }
    if write_effect && child.adoption.effects_already_used >= child.expected.max_effects {
        return Err("delegated effect budget exhausted");
    }
    child.adoption.now_ms = now_ms;
    Ok(child)
}

pub fn record_effect(root_id: &str) -> Result<(), &'static str> {
    let mut children = children()
        .lock()
        .map_err(|_| "delegation registry poisoned")?;
    let child = children
        .get_mut(root_id)
        .ok_or("no delegated capability for child root")?;
    child.adoption.effects_already_used = child.adoption.effects_already_used.saturating_add(1);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> BoundParentAuthority {
        BoundParentAuthority {
            parent: VerifiedParentAuthority {
                subject: "subject-7".into(),
                tenant: "tenant-a".into(),
                root_id: "deadbeef".into(),
                parent_occurrence: "cafebabe".into(),
                execution_id: "execution-1".into(),
                lease_id: "lease-1".into(),
                fence: 9,
                expires_at_ms: 10_000,
                max_effects: 12,
                read_only: false,
                effect_scopes: vec!["tool:read".into(), "tool:write".into()],
                resource_scopes: vec!["workspace:/repo".into(), "network:api".into()],
                credential_generation: 4,
            },
            policy: DelegationPolicy {
                max_expires_at_ms: 8_000,
                max_effects: 3,
                force_read_only: false,
                effect_scopes: vec!["tool:read".into()],
                resource_scopes: vec!["workspace:/repo".into()],
                max_credential_generation: 3,
            },
        }
    }

    #[test]
    fn authority_is_the_parent_request_policy_intersection() {
        let child = attenuate(
            &binding(),
            "subagent:research".into(),
            "inspect repository".into(),
            1,
        )
        .unwrap();
        assert_eq!(child.expires_at_ms, 8_000);
        assert_eq!(child.max_effects, 3);
        assert_eq!(child.effect_scopes, ["tool:read"]);
        assert_eq!(child.resource_scopes, ["workspace:/repo"]);
        assert_eq!(child.credential_generation, 3);
    }

    #[test]
    fn read_only_parent_cannot_be_widened() {
        let mut bound = binding();
        bound.parent.read_only = true;
        let child = attenuate(&bound, "subagent:review".into(), "review".into(), 1).unwrap();
        assert!(child.read_only);
        assert_eq!(child.max_effects, 0);
        assert!(child.effect_scopes.is_empty());
    }

    #[test]
    fn adoption_rejects_scope_or_credential_substitution() {
        let expected =
            attenuate(&binding(), "subagent:research".into(), "inspect".into(), 1).unwrap();
        let mut adopted = AdoptedGrant {
            grant_id: "a".repeat(64),
            audience: expected.audience.clone(),
            purpose: expected.purpose.clone(),
            read_only: expected.read_only,
            max_effects: expected.max_effects,
            effect_scopes: expected.effect_scopes.clone(),
            resource_scopes: expected.resource_scopes.clone(),
            credential_generation: expected.credential_generation,
        };
        assert!(validate_adoption(&adopted, &expected).is_ok());
        adopted.credential_generation += 1;
        assert_eq!(
            validate_adoption(&adopted, &expected),
            Err("adopted authority differs from attenuated authority")
        );
    }

    #[test]
    fn tool_scope_is_enforced_without_empty_scope_widening() {
        let child = attenuate(&binding(), "subagent:research".into(), "inspect".into(), 1).unwrap();
        assert!(allows_tool(&child, "read_file", true));
        assert!(!allows_tool(&child, "write_file", false));

        let mut exact = child.clone();
        exact.effect_scopes = vec!["tool:write_file".into()];
        assert!(allows_tool(&exact, "write_file", false));
        exact.effect_scopes.clear();
        assert!(!allows_tool(&exact, "read_file", true));
    }

    #[test]
    fn root_and_expiry_are_not_routing_metadata_authority() {
        let mut bound = binding();
        assert_eq!(
            validate_parent_binding(&bound, "cafefeed", 1),
            Err("parent root mismatch")
        );
        bound.parent.expires_at_ms = 1;
        assert_eq!(
            attenuate(&bound, "child".into(), "work".into(), 1),
            Err("expired or unfenced parent")
        );
    }
}
