//! Deterministic abuse simulations for the boundaries that do not require a
//! public network. Real QUIC/Kademlia departure is covered by the three-node
//! transport test; these cases exercise poisoning, spam, Sybil pressure, and
//! eclipse recovery policy at the public/private authority boundary.

use xai_aiko_collective::{
    IndexWitness, LocalExecutionAuthority, PeerRequest, ReplicationPolicy, WitnessProjection,
};

fn witness(peer: usize, root: char) -> IndexWitness {
    IndexWitness {
        publisher: format!("ed25519:{}", "1".repeat(64)),
        generation: 7,
        root_object_id: format!("blake3:{}", root.to_string().repeat(64)),
        witness: format!("peer:{peer:04}"),
        observed_at: "2026-07-21T00:00:00Z".into(),
    }
}

#[test]
fn spam_simulation_rejects_oversized_frames_before_admission() {
    let request = PeerRequest::PushAttestation {
        signed_envelope: vec![b'x'; 2 * 1024 * 1024],
    };
    assert!(request.validate().is_err());
}

#[test]
fn sybil_simulation_cannot_turn_public_consensus_into_execution_authority() {
    let mut witnesses = WitnessProjection::default();
    for peer in 0..1_000 {
        witnesses.observe(witness(peer, 'a')).unwrap();
    }
    assert!(witnesses.equivocations().is_empty());
    assert_eq!(witnesses.observations().count(), 1_000);

    let authority = LocalExecutionAuthority {
        local_adapter_available: false,
        locally_enabled: true,
        permission_granted: true,
        revoked: false,
    };
    assert!(!authority.allows_execution());
}

#[test]
fn poisoning_simulation_exposes_conflicting_signed_roots_to_witnesses() {
    let mut witnesses = WitnessProjection::default();
    witnesses.observe(witness(1, 'a')).unwrap();
    witnesses.observe(witness(2, 'b')).unwrap();
    let conflicts = witnesses.equivocations();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].conflicting_roots.len(), 2);
    assert_eq!(conflicts[0].witnesses.len(), 2);
}

#[test]
fn eclipse_simulation_pins_rare_public_objects_without_privileged_seed() {
    let policy = ReplicationPolicy::default();
    let isolated = policy.decide(0, 0, true);
    assert!(isolated.announce);
    assert!(isolated.pin);
    assert_eq!(isolated.reason, "rare_public_object");

    let private = policy.decide(0, 0, false);
    assert!(!private.announce);
    assert!(!private.pin);
}
