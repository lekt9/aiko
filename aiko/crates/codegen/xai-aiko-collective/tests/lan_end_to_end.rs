//! Three-node, cloud-free acceptance path: publish a Contract-admitted object,
//! replicate it over QUIC, take the publisher offline, replicate again from a
//! community peer, query/rank locally, and cross the execution boundary only
//! when a private local adapter grant is present.

use libp2p::{Multiaddr, multiaddr::Protocol};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use xai_aiko_collective::{
    CollectiveContract, CollectiveStore, IdentityError, IdentitySecretStore, Libp2pLanTransport,
    LocalExecutionAuthority, LocalSearchIndex, PeerTransport, PublicEvidence, PublisherIdentity,
    RemoteObjectPeer, StoreRequestHandler, rank_local_hits, replicate_object,
};

struct FixedSecret;

impl IdentitySecretStore for FixedSecret {
    fn get(&self) -> Result<Option<String>, IdentityError> {
        Ok(Some("29".repeat(32)))
    }

    fn set(&self, _: &str) -> Result<(), IdentityError> {
        unreachable!()
    }
}

fn contract_library() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("AIKO_COLLECTIVE_TEST_LIBRARY") {
        return path.into();
    }
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../contract/libcontract");
    #[cfg(target_os = "macos")]
    return root.join("zig-out/lib/libcontract.dylib");
    #[cfg(target_os = "windows")]
    return root.join("zig-out-windows/bin/contract.dll");
    #[cfg(all(unix, not(target_os = "macos")))]
    return root.join("zig-out/lib/libcontract.so");
}

fn address_of(node: &Libp2pLanTransport) -> Multiaddr {
    (0..100)
        .find_map(|_| {
            let address = node.listen_addresses().into_iter().next();
            if address.is_none() {
                std::thread::sleep(Duration::from_millis(20));
            }
            address
        })
        .expect("node must publish a local QUIC address")
}

fn connect(client: &Libp2pLanTransport, server: &Libp2pLanTransport) {
    let peer = server.local_peer_id().unwrap();
    let mut address = address_of(server);
    address.push(Protocol::P2p(peer));
    client.dial(address).unwrap();
    for _ in 0..100 {
        if client.connected_peers().contains(&peer.to_string()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("LAN peers did not connect");
}

#[test]
fn three_aikos_publish_retain_discover_rank_and_execute_without_cloud() {
    let contract = Arc::new(CollectiveContract::load(contract_library()).unwrap());
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

    let one_dir = tempfile::tempdir().unwrap();
    let two_dir = tempfile::tempdir().unwrap();
    let three_dir = tempfile::tempdir().unwrap();
    let one_store = Arc::new(CollectiveStore::open(one_dir.path()).unwrap());
    let two_store = Arc::new(CollectiveStore::open(two_dir.path()).unwrap());
    let three_store = Arc::new(CollectiveStore::open(three_dir.path()).unwrap());
    one_store
        .verify_and_admit(
            &contract,
            &serde_json::to_vec(&signed.unsigned).unwrap(),
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            "2026-07-22T00:00:00Z",
        )
        .unwrap();

    let localhost: Multiaddr = "/ip4/127.0.0.1/udp/0/quic-v1".parse().unwrap();
    let mut one =
        Libp2pLanTransport::with_listen_address(localhost.clone()).with_handler(Arc::new(
            StoreRequestHandler::new(Arc::clone(&one_store)).with_contract(Arc::clone(&contract)),
        ));
    let mut two =
        Libp2pLanTransport::with_listen_address(localhost.clone()).with_handler(Arc::new(
            StoreRequestHandler::new(Arc::clone(&two_store)).with_contract(Arc::clone(&contract)),
        ));
    let mut three = Libp2pLanTransport::with_listen_address(localhost).with_handler(Arc::new(
        StoreRequestHandler::new(Arc::clone(&three_store)).with_contract(Arc::clone(&contract)),
    ));
    one.start().unwrap();
    two.start().unwrap();
    three.start().unwrap();
    connect(&two, &one);
    connect(&three, &two);

    let one_peer = one.local_peer_id().unwrap();
    let mut source = RemoteObjectPeer::new(&two, one_peer);
    replicate_object(
        &mut source,
        &two_store,
        &contract,
        &signed.object_id,
        "2026-07-22T00:00:00Z",
    )
    .unwrap();
    two.announce_provider(&signed.object_id).unwrap();
    one.stop().unwrap();

    let two_peer = two.local_peer_id().unwrap();
    let mut retained = RemoteObjectPeer::new(&three, two_peer);
    replicate_object(
        &mut retained,
        &three_store,
        &contract,
        &signed.object_id,
        "2026-07-22T00:00:00Z",
    )
    .unwrap();
    assert!(three_store.read(&signed.object_id).is_ok());

    let mut search = LocalSearchIndex::open(three_dir.path().join("search")).unwrap();
    search.rebuild(three_store.metadata()).unwrap();
    let hits = search.query("package search", 5).unwrap();
    assert_eq!(hits[0].object_id, signed.object_id);
    let mut evidence = BTreeMap::new();
    evidence.insert(
        signed.object_id.clone(),
        PublicEvidence {
            available: true,
            ..Default::default()
        },
    );
    let ranked = rank_local_hits(&contract, &hits, &evidence, 5).unwrap();
    assert_eq!(ranked["candidates"][0]["object_id"], signed.object_id);

    let local_gate = LocalExecutionAuthority {
        local_adapter_available: true,
        locally_enabled: true,
        permission_granted: true,
        revoked: false,
    };
    let result = local_gate
        .allows_execution()
        .then(|| "local adapter executed");
    assert_eq!(result, Some("local adapter executed"));
    two.stop().unwrap();
    three.stop().unwrap();
}
