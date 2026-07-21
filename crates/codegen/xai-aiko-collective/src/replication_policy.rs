//! Deterministic local replication and seed policy.
//!
//! Seed origins are labels, never authorities: user, repository, DNS,
//! community, and Aiko-operated lists enter the same deduplicated set. An
//! empty set is valid because mDNS/direct invitations remain sufficient.

use crate::{CollectiveStore, StoreError};
use libp2p::Multiaddr;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SeedOrigin {
    User,
    Repository,
    Dns,
    Community,
    Aiko,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SeedAddress {
    pub origin: SeedOrigin,
    pub address: String,
}

#[derive(Debug, Default, Clone)]
pub struct SeedSet {
    // Address is the sole key: origin never changes routing priority.
    addresses: BTreeMap<String, Vec<SeedOrigin>>,
}

impl SeedSet {
    pub fn extend(&mut self, seeds: impl IntoIterator<Item = SeedAddress>) -> Result<(), String> {
        for seed in seeds {
            seed.address
                .parse::<Multiaddr>()
                .map_err(|error| format!("invalid collective seed: {error}"))?;
            let origins = self.addresses.entry(seed.address).or_default();
            if !origins.contains(&seed.origin) {
                origins.push(seed.origin);
                origins.sort_unstable();
            }
        }
        Ok(())
    }

    pub fn addresses(&self) -> impl Iterator<Item = Multiaddr> + '_ {
        self.addresses
            .keys()
            .filter_map(|address| address.parse().ok())
    }

    pub fn is_empty(&self) -> bool {
        self.addresses.is_empty()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ReplicationPolicy {
    pub desired_replicas: u16,
    pub rarity_pin_threshold: u16,
    pub max_automatic_pins: u64,
}

impl Default for ReplicationPolicy {
    fn default() -> Self {
        Self {
            desired_replicas: 3,
            rarity_pin_threshold: 2,
            max_automatic_pins: 10_000,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ReplicationDecision {
    pub announce: bool,
    pub pin: bool,
    pub desired_replicas: u16,
    pub reason: &'static str,
}

impl ReplicationPolicy {
    pub fn decide(
        self,
        provider_count: usize,
        currently_pinned: u64,
        admitted_public: bool,
    ) -> ReplicationDecision {
        if !admitted_public {
            return ReplicationDecision {
                announce: false,
                pin: false,
                desired_replicas: self.desired_replicas,
                reason: "not_admitted_public",
            };
        }
        let rare = provider_count < self.rarity_pin_threshold as usize;
        ReplicationDecision {
            announce: true,
            pin: rare && currently_pinned < self.max_automatic_pins,
            desired_replicas: self.desired_replicas,
            reason: if rare {
                "rare_public_object"
            } else {
                "sufficient_providers"
            },
        }
    }

    pub fn apply_pin(
        self,
        store: &CollectiveStore,
        object_id: &str,
        provider_count: usize,
    ) -> Result<ReplicationDecision, StoreError> {
        let stats = store.stats()?;
        let decision = self.decide(provider_count, stats.pinned, true);
        if decision.pin {
            store.pin(object_id)?;
        }
        Ok(decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_origins_are_deduplicated_without_privileged_aiko_priority() {
        let address = "/ip4/127.0.0.1/udp/9000/quic-v1";
        let mut seeds = SeedSet::default();
        seeds
            .extend([
                SeedAddress {
                    origin: SeedOrigin::Aiko,
                    address: address.into(),
                },
                SeedAddress {
                    origin: SeedOrigin::Community,
                    address: address.into(),
                },
            ])
            .unwrap();
        assert_eq!(seeds.addresses().count(), 1);
    }

    #[test]
    fn rare_admitted_objects_are_pinned_but_private_objects_never_announce() {
        let policy = ReplicationPolicy::default();
        assert!(policy.decide(0, 0, true).pin);
        assert!(!policy.decide(5, 0, true).pin);
        let private = policy.decide(0, 0, false);
        assert!(!private.pin && !private.announce);
    }
}
