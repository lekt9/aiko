//! Aiko retrieves locally; Contract performs the authoritative final rank.

use crate::{CollectiveContract, CollectiveError, SearchHit};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct PublicEvidence {
    pub capability_version: String,
    pub evidence_version: String,
    pub success_count: u64,
    pub failure_count: u64,
    pub independent_publishers: u64,
    pub freshness_seconds: u64,
    pub latency_bucket_ms: u64,
    pub revoked: bool,
    pub available: bool,
}

impl Default for PublicEvidence {
    fn default() -> Self {
        Self {
            capability_version: "1".into(),
            evidence_version: "1".into(),
            success_count: 0,
            failure_count: 0,
            independent_publishers: 0,
            freshness_seconds: u64::MAX,
            latency_bucket_ms: 60_000,
            revoked: false,
            available: true,
        }
    }
}

pub fn rank_local_hits(
    contract: &CollectiveContract,
    hits: &[SearchHit],
    evidence: &BTreeMap<String, PublicEvidence>,
    limit: u32,
) -> Result<Value, CollectiveError> {
    let candidates = hits
        .iter()
        .map(|hit| {
            let public = evidence.get(&hit.object_id).cloned().unwrap_or_default();
            json!({
                "object_id": hit.object_id,
                "capability_version": public.capability_version,
                "evidence_version": public.evidence_version,
                "semantic_score_bps": hit.semantic_score_bps,
                "success_count": public.success_count.min(1_000_000_000),
                "failure_count": public.failure_count.min(1_000_000_000),
                "independent_publishers": public.independent_publishers.min(1_000_000),
                "freshness_seconds": public.freshness_seconds.min(3_155_760_000),
                "latency_bucket_ms": public.latency_bucket_ms.min(60_000),
                "revoked": public.revoked,
                "available": public.available
            })
        })
        .collect::<Vec<_>>();
    contract.rank(&Value::Array(candidates), limit.min(100))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_start_evidence_is_conservative_and_bounded() {
        let evidence = PublicEvidence::default();
        assert_eq!(evidence.success_count, 0);
        assert_eq!(evidence.failure_count, 0);
        assert!(evidence.available);
        assert!(!evidence.revoked);
        assert_eq!(evidence.latency_bucket_ms, 60_000);
    }
}
