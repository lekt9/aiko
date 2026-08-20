//! Native `contract_declare_turn_context_json` projection for mandatory ingress.

use serde_json::json;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use xai_grok_hooks::contract_projection::{
    DeclareTurnProjection, IngressChokePoint, IngressRequest, ProjectionReceipt,
};

pub(crate) struct NativeDeclareProjection;

impl DeclareTurnProjection for NativeDeclareProjection {
    fn declare_turn_context(&self, request: &IngressRequest) -> Result<ProjectionReceipt, String> {
        let native = super::native_contract().ok_or_else(|| "abi_unavailable".to_owned())?;
        if native.declare_turn_context.is_none() {
            return Err("abi_unavailable".to_owned());
        }
        let depth = u32::from(request.contract_parent.is_some());
        let value = native
            .declare_context(&json!({
                "plan": request.plan,
                "cwd": request.verified.workspace().to_string_lossy(),
                "parent_id": request.contract_parent,
                "root_id": request.contract_root,
                "depth": depth,
                "max_depth": super::DEFAULT_CONTRACT_MAX_DEPTH,
                "max_children": super::DEFAULT_CONTRACT_MAX_CHILDREN,
                "max_total_children": super::DEFAULT_CONTRACT_MAX_TOTAL_CHILDREN,
                "max_concurrency": super::DEFAULT_CONTRACT_MAX_CONCURRENCY,
                // Auditable identity pins. Contract remains the only ledger.
                "verified_ingress": {
                    "transport": request.verified.transport().as_str(),
                    "authenticated_subject": request.verified.subject(),
                    "verified_tenant": request.verified.tenant(),
                    "audience": request.verified.audience(),
                    "granted_scopes": request.verified.scopes(),
                    "canonical_request_digest": request.verified.request_digest(),
                }
            }))
            .ok_or_else(|| "projection_failed".to_owned())?;
        let occurrence_id = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| super::valid_contract_id(id))
            .ok_or_else(|| "malformed_abi".to_owned())?;
        let root_id = value
            .get("root_id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| super::valid_contract_id(id))
            .ok_or_else(|| "malformed_abi".to_owned())?;
        Ok(ProjectionReceipt {
            occurrence_id: occurrence_id.to_owned(),
            root_id: root_id.to_owned(),
        })
    }
}

pub(crate) fn shared_ingress() -> &'static IngressChokePoint<NativeDeclareProjection> {
    static SHARED: OnceLock<IngressChokePoint<NativeDeclareProjection>> = OnceLock::new();
    // Telegram + heavy Contract graphs can exceed 10s on cold libcontract load
    // or under contention (the mutex covers projection). 30s keeps the daemon
    // responsive while avoiding the "ProjectionTimeout → Internal error" hole
    // that previously surfaced as the user-visible Contract retry message.
    SHARED.get_or_init(|| {
        IngressChokePoint::new(Arc::new(NativeDeclareProjection), Duration::from_secs(30))
    })
}
