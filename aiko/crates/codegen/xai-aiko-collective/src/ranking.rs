//! Aiko retrieves locally; Contract performs the authoritative final rank.

use crate::{CollectiveContract, CollectiveError, CollectiveStore, SearchHit};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

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
            available: false,
        }
    }
}

#[derive(Debug, Clone)]
struct LatestObservation {
    observed_at: DateTime<Utc>,
    outcome: String,
    latency_bucket_ms: u64,
    capability_version: String,
}

/// Build the public evidence projection from Contract-admitted immutable
/// objects. Aiko performs storage and aggregation; Contract remains the
/// authority for the signed revocation projection and final ranking.
///
/// Attestations are reduced to the latest observation per independent
/// publisher and subject. This prevents a single key from inflating a route by
/// replaying many observations. Revocations from an unrelated publisher are
/// excluded before projection: a valid signature proves who spoke, not that
/// the speaker owns the object they attempted to revoke.
pub fn project_public_evidence(
    store: &CollectiveStore,
    contract: &CollectiveContract,
    now: DateTime<Utc>,
) -> Result<BTreeMap<String, PublicEvidence>, String> {
    let records = store.metadata().all().map_err(|error| error.to_string())?;
    let owners = records
        .iter()
        .map(|record| (record.object_id.clone(), record.publisher.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut latest = BTreeMap::<(String, String), LatestObservation>::new();
    let mut revocation_envelopes = Vec::new();

    for record in &records {
        let stored = match store.read(&record.object_id) {
            Ok(stored) => stored,
            Err(_) => continue,
        };
        let expires_at = stored
            .canonical
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc));
        if expires_at.is_some_and(|expires| expires < now) {
            continue;
        }
        let payload = match stored.canonical.get("payload").and_then(Value::as_object) {
            Some(payload) => payload,
            None => continue,
        };
        match record.kind.as_str() {
            "attestation" => {
                let Some(subject) = payload.get("subject").and_then(Value::as_str) else {
                    continue;
                };
                if !owners.contains_key(subject) {
                    continue;
                }
                let Some(observed_at) = payload
                    .get("observed_bucket")
                    .and_then(Value::as_str)
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc))
                else {
                    continue;
                };
                if observed_at > now {
                    continue;
                }
                let observation = LatestObservation {
                    observed_at,
                    outcome: payload
                        .get("outcome")
                        .and_then(Value::as_str)
                        .unwrap_or("provider_failure")
                        .to_owned(),
                    latency_bucket_ms: payload
                        .get("latency_bucket_ms")
                        .and_then(Value::as_u64)
                        .unwrap_or(60_000),
                    capability_version: payload
                        .get("capability_version")
                        .and_then(Value::as_str)
                        .unwrap_or("1")
                        .to_owned(),
                };
                let key = (subject.to_owned(), record.publisher.clone());
                if latest
                    .get(&key)
                    .is_none_or(|existing| observation.observed_at > existing.observed_at)
                {
                    latest.insert(key, observation);
                }
            }
            "revocation" => {
                let target_kind = payload.get("target_kind").and_then(Value::as_str);
                let target = payload.get("target").and_then(Value::as_str);
                let authorized = match (target_kind, target) {
                    (Some("object"), Some(target)) => owners
                        .get(target)
                        .is_some_and(|owner| owner == &record.publisher),
                    (Some("publisher"), Some(target)) => target == record.publisher,
                    // Delegation authorization needs the delegation projection;
                    // it cannot be inferred safely from local object presence.
                    _ => false,
                };
                if authorized {
                    let target_publisher = match (target_kind, target) {
                        (Some("object"), Some(target)) => owners.get(target),
                        (Some("publisher"), _) => Some(&record.publisher),
                        _ => None,
                    };
                    revocation_envelopes.push(json!({
                        "target_publisher": target_publisher,
                        "envelope": {
                            "protocol": "aiko-collective/1",
                            "object_id": record.object_id,
                            "unsigned": stored.canonical,
                            "signature": format!("ed25519:{}", stored.signature_hex),
                        }
                    }));
                }
            }
            _ => {}
        }
    }

    let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let revocations = contract
        .apply_revocations(&Value::Array(revocation_envelopes), &now_iso)
        .map_err(|error| error.to_string())?;
    let effective = revocations
        .get("effective_projection")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();

    let mut projection = BTreeMap::<String, PublicEvidence>::new();
    let mut latency = BTreeMap::<String, Vec<u64>>::new();
    for ((subject, _publisher), observation) in latest {
        let evidence = projection.entry(subject.clone()).or_default();
        evidence.capability_version = observation.capability_version;
        evidence.independent_publishers = evidence.independent_publishers.saturating_add(1);
        if observation.outcome == "success" {
            evidence.success_count = evidence.success_count.saturating_add(1);
        } else {
            evidence.failure_count = evidence.failure_count.saturating_add(1);
        }
        evidence.freshness_seconds = evidence.freshness_seconds.min(
            now.signed_duration_since(observation.observed_at)
                .num_seconds()
                .max(0) as u64,
        );
        latency
            .entry(subject)
            .or_default()
            .push(observation.latency_bucket_ms);
    }
    for (subject, mut buckets) in latency {
        buckets.sort_unstable();
        if let Some(evidence) = projection.get_mut(&subject) {
            evidence.latency_bucket_ms = buckets[buckets.len() / 2];
        }
    }
    for record in &records {
        if record.kind != "capability" {
            continue;
        }
        let evidence = projection.entry(record.object_id.clone()).or_default();
        if !record.capability_version.is_empty() {
            evidence.capability_version = record.capability_version.clone();
        }
        evidence.revoked = effective.contains(format!("object:{}", record.object_id).as_str())
            || effective.contains(format!("publisher:{}", record.publisher).as_str());
        // Blob possession is not execution availability. The Aiko host may
        // raise this only after matching the capability/version to its private
        // local FECH adapter catalog.
        evidence.available = false;
    }
    Ok(projection)
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
        assert!(!evidence.available);
        assert!(!evidence.revoked);
        assert_eq!(evidence.latency_bucket_ms, 60_000);
    }
}
