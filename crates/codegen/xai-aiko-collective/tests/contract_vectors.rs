use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use xai_aiko_collective::{
    CollectiveContract, CollectiveError, CollectiveStore, Libp2pLanTransport, LocalSearchIndex,
    MetadataIndex, ObjectMetadata, ObjectPeer, PeerRequest, PeerResponse, PeerTransport,
    PublicEvidence, PublisherIdentity, RemoteObjectPeer, StorePeer, StoreRequestHandler,
    StoredObject, build_public_index, ingest_admitted_segment, rank_local_hits, replicate_object,
};

struct FixedSecret;

impl xai_aiko_collective::IdentitySecretStore for FixedSecret {
    fn get(&self) -> Result<Option<String>, xai_aiko_collective::IdentityError> {
        Ok(Some("17".repeat(32)))
    }
    fn set(&self, _: &str) -> Result<(), xai_aiko_collective::IdentityError> {
        unreachable!()
    }
}

struct BytesPeer {
    bytes: Vec<u8>,
}

impl ObjectPeer for BytesPeer {
    type Error = std::convert::Infallible;

    fn request(&mut self, request: PeerRequest) -> Result<PeerResponse, Self::Error> {
        let PeerRequest::GetObject {
            object_id,
            offset,
            max_bytes,
        } = request
        else {
            unreachable!()
        };
        let start = offset as usize;
        let end = start
            .saturating_add(max_bytes as usize)
            .min(self.bytes.len());
        Ok(PeerResponse::ObjectChunk {
            object_id,
            offset,
            total_bytes: self.bytes.len() as u64,
            bytes: self.bytes[start..end].to_vec(),
        })
    }
}

fn contract_library() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../contract/libcontract");
    #[cfg(target_os = "macos")]
    return root.join("zig-out/lib/libcontract.dylib");
    #[cfg(target_os = "windows")]
    return root.join("zig-out/bin/contract.dll");
    #[cfg(all(unix, not(target_os = "macos")))]
    return root.join("zig-out/lib/libcontract.so");
}

#[test]
fn rust_consumes_contracts_normative_collective_vectors() {
    let library = contract_library();
    assert!(
        library.is_file(),
        "build Contract before this conformance test: {}",
        library.display()
    );
    let contract = CollectiveContract::load(&library).expect("collective ABI must load");
    let vectors_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../contract/fixtures/collective/golden-vectors.json");
    let vectors: Value = serde_json::from_slice(
        &std::fs::read(&vectors_path).expect("Contract collective vectors must exist"),
    )
    .unwrap();
    for vector in vectors["vectors"].as_array().unwrap() {
        let input = serde_json::to_vec(&vector["input_unsigned"]).unwrap();
        let result = contract.canonicalize(&input).unwrap();
        assert_eq!(
            result.canonical.to_string(),
            vector["canonical_unsigned"].as_str().unwrap()
        );
        assert_eq!(
            result.object_id,
            vector["expected_object_id"].as_str().unwrap()
        );
    }
}

#[test]
fn rust_observes_contracts_fail_closed_privacy_verdict() {
    let contract = CollectiveContract::load(contract_library()).unwrap();
    let invalid = br#"{"credential":"never-public"}"#;
    assert!(matches!(
        contract.canonicalize(invalid),
        Err(CollectiveError::Rejected(_))
    ));
}

#[test]
fn independent_index_builders_match_and_unrelated_node_queries_locally() {
    let contract = CollectiveContract::load(contract_library()).unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    let source = MetadataIndex::open(source_dir.path().join("catalog.redb")).unwrap();
    for (digest, capability, summary) in [
        (
            'a',
            "unbrowse.packages.search",
            "Search public package metadata",
        ),
        ('b', "unbrowse.issues.list", "List public project issues"),
    ] {
        source
            .put(&ObjectMetadata {
                object_id: format!("blake3:{}", digest.to_string().repeat(64)),
                kind: "capability".into(),
                publisher: format!("ed25519:{}", "3".repeat(64)),
                admitted_at: "2026-07-21T00:00:00Z".into(),
                capability_id: capability.into(),
                capability_version: "1".into(),
                summary: summary.into(),
                operation: capability.rsplit('.').next().unwrap().into(),
                origin: "registry.example".into(),
                effects: vec!["network_read".into(), "read_only".into()],
            })
            .unwrap();
    }
    let identity = PublisherIdentity::load_or_create(&FixedSecret).unwrap();
    let first_dir = tempfile::tempdir().unwrap();
    let first_store = CollectiveStore::open(first_dir.path()).unwrap();
    let first = build_public_index(
        &source,
        &first_store,
        &contract,
        &identity,
        10,
        1,
        "2026-07-21T00:00:00Z",
        "2026-08-21T00:00:00Z",
    )
    .unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let second_store = CollectiveStore::open(second_dir.path()).unwrap();
    let second = build_public_index(
        &source,
        &second_store,
        &contract,
        &identity,
        10,
        1,
        "2026-07-21T00:00:00Z",
        "2026-08-21T00:00:00Z",
    )
    .unwrap();
    assert_eq!(first, second);

    let unrelated_dir = tempfile::tempdir().unwrap();
    let unrelated = MetadataIndex::open(unrelated_dir.path().join("catalog.redb")).unwrap();
    for object_id in &first.segment_object_ids {
        let segment = first_store.read(object_id).unwrap();
        ingest_admitted_segment(&unrelated, &segment.canonical, "2026-07-22T00:00:00Z").unwrap();
    }
    let mut local = LocalSearchIndex::open(unrelated_dir.path().join("search")).unwrap();
    local.rebuild(&unrelated).unwrap();
    let hits = local.query("project issues", 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(
        unrelated
            .get(&hits[0].object_id)
            .unwrap()
            .unwrap()
            .capability_id,
        "unbrowse.issues.list"
    );
    let ranked = rank_local_hits(
        &contract,
        &hits,
        &BTreeMap::<String, PublicEvidence>::new(),
        5,
    )
    .unwrap();
    assert_eq!(
        ranked["candidates"][0]["object_id"],
        Value::String(hits[0].object_id.clone())
    );
}

#[test]
fn native_publisher_signer_uses_contract_payload_and_verifies() {
    let contract = CollectiveContract::load(contract_library()).unwrap();
    let identity = PublisherIdentity::load_or_create(&FixedSecret).unwrap();
    let candidate = serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "capability",
        "publisher": identity.publisher(),
        "sequence": 1,
        "created_at": "2026-07-21T00:00:00Z",
        "expires_at": "2026-08-20T00:00:00Z",
        "payload": {
            "capability_id": "unbrowse.registry.search",
            "capability_version": "1",
            "summary": "Search public package metadata",
            "operation": "search",
            "origin": "registry.example",
            "input_shape": {"query": {"required": true, "type": "string"}},
            "output_shape": {"items": {"required": true, "type": "array", "items_type": "object"}},
            "effects": ["network_read", "read_only"],
            "requires": [],
            "sanitizer_version": 1,
            "permission": "network"
        }
    });
    let signed = identity
        .sign(&contract, &serde_json::to_vec(&candidate).unwrap())
        .unwrap();
    contract
        .verify(
            &serde_json::to_vec(&signed.unsigned).unwrap(),
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            "2026-07-22T00:00:00Z",
        )
        .unwrap();
}

#[test]
fn rust_uses_contract_for_rank_checkpoint_and_merge_semantics() {
    let contract = CollectiveContract::load(contract_library()).unwrap();
    let a = format!("blake3:{}", "a".repeat(64));
    let b = format!("blake3:{}", "b".repeat(64));
    let candidates = serde_json::json!([
        {
            "object_id": a.clone(),
            "capability_version": "1",
            "evidence_version": "1",
            "semantic_score_bps": 7000,
            "success_count": 8,
            "failure_count": 2,
            "independent_publishers": 3,
            "freshness_seconds": 100,
            "latency_bucket_ms": 100,
            "revoked": false,
            "available": true
        },
        {
            "object_id": b.clone(),
            "capability_version": "1",
            "evidence_version": "1",
            "semantic_score_bps": 9000,
            "success_count": 1,
            "failure_count": 0,
            "independent_publishers": 1,
            "freshness_seconds": 100,
            "latency_bucket_ms": 10,
            "revoked": true,
            "available": true
        }
    ]);
    let ranked = contract.rank(&candidates, 2).unwrap();
    assert_eq!(ranked["candidates"][0]["object_id"], a);
    assert_eq!(ranked["candidates"][1]["status"], "revoked");

    let first = contract
        .checkpoint(&[b.clone(), a.clone(), a.clone()])
        .unwrap();
    let second = contract.checkpoint(&[a.clone(), b.clone()]).unwrap();
    assert_eq!(first, second);
    assert_eq!(first["tree_size"], 2);

    let publisher = format!("ed25519:{}", "1".repeat(64));
    let merged = contract
        .merge(&serde_json::json!([
            {"object_id": a, "publisher": publisher.clone(), "kind": "capability", "sequence": 1},
            {"object_id": b, "publisher": publisher, "kind": "capability", "sequence": 1}
        ]))
        .unwrap();
    assert_eq!(merged["admitted"].as_array().unwrap().len(), 0);
    assert_eq!(
        merged["quarantined_equivocations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |byte: u8| match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => panic!("invalid Contract hex"),
            };
            (nibble(pair[0]) << 4) | nibble(pair[1])
        })
        .collect()
}

#[test]
fn verified_catalog_has_deterministic_offline_round_trip() {
    let contract = CollectiveContract::load(contract_library()).unwrap();
    let key = Ed25519KeyPair::from_seed_unchecked(&[23_u8; 32]).unwrap();
    let publisher_key_hex = key
        .public_key()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let candidate = serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "capability",
        "publisher": format!("ed25519:{publisher_key_hex}"),
        "sequence": 1,
        "created_at": "2026-07-21T00:00:00Z",
        "expires_at": "2026-08-20T00:00:00Z",
        "payload": {
            "capability_id": "unbrowse.registry.search",
            "capability_version": "1",
            "summary": "Search public package metadata",
            "operation": "search",
            "origin": "registry.example",
            "input_shape": {"query": {"required": true, "type": "string"}},
            "output_shape": {"items": {"required": true, "type": "array", "items_type": "object"}},
            "effects": ["network_read", "read_only"],
            "requires": [],
            "sanitizer_version": 1,
            "permission": "network"
        }
    });
    let candidate = serde_json::to_vec(&candidate).unwrap();
    let canonical = contract.canonicalize(&candidate).unwrap();
    let signing = contract.signing_payload(&candidate).unwrap();
    let payload = decode_hex(signing["payload_hex"].as_str().unwrap());
    let signature_hex = key
        .sign(&payload)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let source_dir = tempfile::tempdir().unwrap();
    let source = CollectiveStore::open(source_dir.path()).unwrap();
    source
        .verify_and_admit(
            &contract,
            &candidate,
            &canonical.object_id,
            &signature_hex,
            &publisher_key_hex,
            "2026-07-22T00:00:00Z",
        )
        .unwrap();
    let first_pack = source.export_pack().unwrap();

    let destination_dir = tempfile::tempdir().unwrap();
    let destination = CollectiveStore::open(destination_dir.path()).unwrap();
    assert_eq!(
        destination
            .import_pack(&contract, &first_pack, "2026-07-22T00:00:00Z")
            .unwrap(),
        1
    );
    assert_eq!(destination.export_pack().unwrap(), first_pack);
    assert_eq!(
        destination.read(&canonical.object_id).unwrap(),
        source.read(&canonical.object_id).unwrap()
    );

    // The same verified wrapper can traverse the transport-neutral resumable
    // GET_OBJECT state machine. The receiver quarantines it and asks Contract
    // for fresh admission before moving it into the catalog.
    let replicated_dir = tempfile::tempdir().unwrap();
    let replicated = CollectiveStore::open(replicated_dir.path()).unwrap();
    let mut peer = StorePeer::new(&source);
    replicate_object(
        &mut peer,
        &replicated,
        &contract,
        &canonical.object_id,
        "2026-07-22T00:00:00Z",
    )
    .unwrap();
    assert_eq!(replicated.export_pack().unwrap(), first_pack);
    assert_eq!(replicated.stats().unwrap().quarantined, 0);

    let valid_stored = source.read(&canonical.object_id).unwrap();
    let forged = StoredObject {
        signature_hex: "00".repeat(64),
        ..valid_stored.clone()
    };
    let forged_dir = tempfile::tempdir().unwrap();
    let forged_store = CollectiveStore::open(forged_dir.path()).unwrap();
    assert!(
        replicate_object(
            &mut BytesPeer {
                bytes: serde_json::to_vec(&forged).unwrap()
            },
            &forged_store,
            &contract,
            &canonical.object_id,
            "2026-07-22T00:00:00Z",
        )
        .is_err()
    );
    assert_eq!(forged_store.stats().unwrap().objects, 0);

    let mut corrupt_bytes = serde_json::to_vec(&valid_stored).unwrap();
    let middle = corrupt_bytes.len() / 2;
    corrupt_bytes[middle] ^= 0x01;
    let corrupt_dir = tempfile::tempdir().unwrap();
    let corrupt_store = CollectiveStore::open(corrupt_dir.path()).unwrap();
    assert!(
        replicate_object(
            &mut BytesPeer {
                bytes: corrupt_bytes
            },
            &corrupt_store,
            &contract,
            &canonical.object_id,
            "2026-07-22T00:00:00Z",
        )
        .is_err()
    );
    assert_eq!(corrupt_store.stats().unwrap().objects, 0);

    let expired_dir = tempfile::tempdir().unwrap();
    let expired_store = CollectiveStore::open(expired_dir.path()).unwrap();
    assert!(
        replicate_object(
            &mut StorePeer::new(&source),
            &expired_store,
            &contract,
            &canonical.object_id,
            "2026-08-20T00:00:00Z",
        )
        .is_err()
    );
    assert_eq!(expired_store.stats().unwrap().objects, 0);

    // Three independent LAN nodes use direct QUIC request/response with no
    // seed, DNS, relay, account, or internet service. Both receivers still
    // pass the bytes through the same Contract admission gate.
    let localhost: libp2p::Multiaddr = "/ip4/127.0.0.1/udp/0/quic-v1".parse().unwrap();
    let mut serving = Libp2pLanTransport::with_listen_address(localhost.clone()).with_handler(
        std::sync::Arc::new(StoreRequestHandler::new(std::sync::Arc::new(
            source.clone(),
        ))),
    );
    let mut first_client = Libp2pLanTransport::with_listen_address(localhost.clone());
    let mut second_client = Libp2pLanTransport::with_listen_address(localhost);
    serving.start().unwrap();
    first_client.start().unwrap();
    second_client.start().unwrap();
    let serving_peer = serving.local_peer_id().unwrap();
    let mut serving_address = (0..100)
        .find_map(|_| {
            let address = serving.listen_addresses().into_iter().next();
            if address.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            address
        })
        .unwrap();
    serving_address.push(libp2p::multiaddr::Protocol::P2p(serving_peer));
    first_client.dial(serving_address.clone()).unwrap();
    second_client.dial(serving_address).unwrap();
    for _ in 0..100 {
        if first_client
            .connected_peers()
            .contains(&serving_peer.to_string())
            && second_client
                .connected_peers()
                .contains(&serving_peer.to_string())
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let first_network_dir = tempfile::tempdir().unwrap();
    let second_network_dir = tempfile::tempdir().unwrap();
    let first_network = CollectiveStore::open(first_network_dir.path()).unwrap();
    let second_network = CollectiveStore::open(second_network_dir.path()).unwrap();
    replicate_object(
        &mut RemoteObjectPeer::new(&first_client, serving_peer),
        &first_network,
        &contract,
        &canonical.object_id,
        "2026-07-22T00:00:00Z",
    )
    .unwrap();
    replicate_object(
        &mut RemoteObjectPeer::new(&second_client, serving_peer),
        &second_network,
        &contract,
        &canonical.object_id,
        "2026-07-22T00:00:00Z",
    )
    .unwrap();
    assert_eq!(first_network.export_pack().unwrap(), first_pack);
    assert_eq!(second_network.export_pack().unwrap(), first_pack);
    serving.stop().unwrap();
    first_client.stop().unwrap();
    second_client.stop().unwrap();

    drop(first_network);
    let reopened = CollectiveStore::open(first_network_dir.path()).unwrap();
    assert_eq!(reopened.export_pack().unwrap(), first_pack);

    let localhost: libp2p::Multiaddr = "/ip4/127.0.0.1/udp/0/quic-v1".parse().unwrap();
    let mut restarted_replica = Libp2pLanTransport::with_listen_address(localhost.clone())
        .with_handler(std::sync::Arc::new(StoreRequestHandler::new(
            std::sync::Arc::new(reopened),
        )));
    let mut fresh_client = Libp2pLanTransport::with_listen_address(localhost);
    restarted_replica.start().unwrap();
    fresh_client.start().unwrap();
    let replica_peer = restarted_replica.local_peer_id().unwrap();
    let mut replica_address = (0..100)
        .find_map(|_| {
            let address = restarted_replica.listen_addresses().into_iter().next();
            if address.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            address
        })
        .unwrap();
    replica_address.push(libp2p::multiaddr::Protocol::P2p(replica_peer));
    fresh_client.dial(replica_address).unwrap();
    for _ in 0..100 {
        if fresh_client
            .connected_peers()
            .contains(&replica_peer.to_string())
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let recovered_dir = tempfile::tempdir().unwrap();
    let recovered = CollectiveStore::open(recovered_dir.path()).unwrap();
    replicate_object(
        &mut RemoteObjectPeer::new(&fresh_client, replica_peer),
        &recovered,
        &contract,
        &canonical.object_id,
        "2026-07-22T00:00:00Z",
    )
    .unwrap();
    assert_eq!(recovered.export_pack().unwrap(), first_pack);
    restarted_replica.stop().unwrap();
    fresh_client.stop().unwrap();
}
