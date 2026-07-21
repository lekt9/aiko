//! Local witness projection for signed public index roots.
//!
//! Transport remains generic object replication. This module records only
//! bounded root observations and detects publisher/generation equivocation;
//! it never stores task text, invocation data, or credentials.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct IndexWitness {
    pub publisher: String,
    pub generation: u64,
    pub root_object_id: String,
    pub witness: String,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Equivocation {
    pub publisher: String,
    pub generation: u64,
    pub conflicting_roots: Vec<String>,
    pub witnesses: Vec<String>,
}

#[derive(Debug, Default)]
pub struct WitnessProjection {
    observations: BTreeSet<IndexWitness>,
}

impl WitnessProjection {
    pub fn observe(&mut self, observation: IndexWitness) {
        self.observations.insert(observation);
    }

    pub fn merge(&mut self, observations: impl IntoIterator<Item = IndexWitness>) {
        self.observations.extend(observations);
    }

    pub fn observations(&self) -> impl Iterator<Item = &IndexWitness> {
        self.observations.iter()
    }

    pub fn equivocations(&self) -> Vec<Equivocation> {
        let mut groups: BTreeMap<(String, u64), (BTreeSet<String>, BTreeSet<String>)> =
            BTreeMap::new();
        for observation in &self.observations {
            let group = groups
                .entry((observation.publisher.clone(), observation.generation))
                .or_default();
            group.0.insert(observation.root_object_id.clone());
            group.1.insert(observation.witness.clone());
        }
        groups
            .into_iter()
            .filter(|(_, (roots, _))| roots.len() > 1)
            .map(
                |((publisher, generation), (roots, witnesses))| Equivocation {
                    publisher,
                    generation,
                    conflicting_roots: roots.into_iter().collect(),
                    witnesses: witnesses.into_iter().collect(),
                },
            )
            .collect()
    }
}

/// Local execution authority is deliberately narrower than public discovery.
/// There is no public score or witness field in this input, so network evidence
/// cannot manufacture an execution grant.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalExecutionAuthority {
    pub local_adapter_available: bool,
    pub locally_enabled: bool,
    pub permission_granted: bool,
    pub revoked: bool,
}

impl LocalExecutionAuthority {
    pub fn allows_execution(self) -> bool {
        self.local_adapter_available
            && self.locally_enabled
            && self.permission_granted
            && !self.revoked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn witness(root: char, peer: char) -> IndexWitness {
        IndexWitness {
            publisher: format!("ed25519:{}", "1".repeat(64)),
            generation: 9,
            root_object_id: format!("blake3:{}", root.to_string().repeat(64)),
            witness: format!("peer:{}", peer.to_string().repeat(8)),
            observed_at: "2026-07-21T00:00:00Z".into(),
        }
    }

    #[test]
    fn witness_merge_is_idempotent_and_detects_equivocation() {
        let mut projection = WitnessProjection::default();
        projection.merge([witness('a', '1'), witness('a', '1'), witness('b', '2')]);
        assert_eq!(projection.observations().count(), 2);
        let conflicts = projection.equivocations();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].conflicting_roots.len(), 2);
        assert_eq!(conflicts[0].witnesses.len(), 2);
    }

    #[test]
    fn global_discovery_evidence_cannot_grant_execution() {
        let no_local_grant = LocalExecutionAuthority {
            local_adapter_available: false,
            locally_enabled: true,
            permission_granted: true,
            revoked: false,
        };
        assert!(!no_local_grant.allows_execution());
        assert!(
            LocalExecutionAuthority {
                local_adapter_available: true,
                ..no_local_grant
            }
            .allows_execution()
        );
    }
}
