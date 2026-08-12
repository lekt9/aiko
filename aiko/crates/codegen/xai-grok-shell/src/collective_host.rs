//! Process-lifetime host for Aiko Collective state and networking.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use xai_aiko_collective::{
    CollectiveContract, CollectiveStore, IndexWitness, Libp2pLanTransport, LocalSearchIndex,
    NativeIdentitySecretStore, NetworkGate, PeerId, PublicEvidence, PublicQuery,
    PublicationAuditAction, PublicationAuditEvent, PublicationAuditLog, PublicationController,
    PublicationMode, PublicationReviewItem, PublicationReviewQueue, PublicationSettings,
    PublisherIdentity, RemoteObjectPeer, SeedSet, StoreRequestHandler, WitnessLog,
    WitnessProjection, build_public_index, ingest_admitted_segment, project_public_evidence,
    rank_local_hits, replicate_object,
};

struct Host {
    _contract: Arc<CollectiveContract>,
    store: Arc<CollectiveStore>,
    search: Arc<Mutex<LocalSearchIndex>>,
    settings_path: PathBuf,
    audit: PublicationAuditLog,
    review: PublicationReviewQueue,
    witness_log: WitnessLog,
    witnesses: Arc<Mutex<WitnessProjection>>,
    local_availability: BTreeSet<(String, String)>,
    settings: PublicationSettings,
    seeds: SeedSet,
    network: NetworkGate<Libp2pLanTransport>,
}

static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();

fn automatic_public_origin(source: &str) -> bool {
    source == "unbrowse"
}

fn refresh_public_index(host: &mut Host, identity: &PublisherIdentity) -> Result<(), String> {
    let records = host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?;
    let mut sequence = 0_u64;
    let mut generation = 0_u64;
    for record in records
        .iter()
        .filter(|record| record.publisher == identity.publisher())
    {
        let Ok(stored) = host.store.read(&record.object_id) else {
            continue;
        };
        sequence = sequence.max(
            stored
                .canonical
                .get("sequence")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
        );
        if record.kind == "index_root" {
            generation = generation.max(
                stored
                    .canonical
                    .pointer("/payload/generation")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default(),
            );
        }
    }
    let generation = generation
        .checked_add(1)
        .ok_or("index generation exhausted")?;
    let sequence_start = sequence
        .checked_add(1)
        .ok_or("publisher sequence exhausted")?;
    let now = chrono::Utc::now();
    let created_at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires_at =
        (now + chrono::Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let built = build_public_index(
        host.store.metadata(),
        &host.store,
        &host._contract,
        identity,
        generation,
        sequence_start,
        &created_at,
        &expires_at,
    )
    .map_err(|error| error.to_string())?;
    for object_id in built
        .segment_object_ids
        .iter()
        .chain(std::iter::once(&built.root_object_id))
    {
        host.store
            .pin(object_id)
            .map_err(|error| error.to_string())?;
        if host.settings.participation_enabled {
            let _ = host.network.transport().announce_provider(object_id);
        }
    }

    let witness = IndexWitness {
        publisher: identity.publisher(),
        generation,
        root_object_id: built.root_object_id,
        witness: host
            .network
            .transport()
            .local_peer_id()
            .map(|peer| format!("peer:{peer}"))
            .unwrap_or_else(|| identity.publisher()),
        observed_at: created_at,
    };
    {
        let mut projection = host
            .witnesses
            .lock()
            .map_err(|_| "collective witness lock poisoned")?;
        projection
            .observe(witness.clone())
            .map_err(|error| error.to_string())?;
        host.witness_log
            .save(&projection)
            .map_err(|error| error.to_string())?;
    }
    if host.settings.participation_enabled {
        for peer in host.network.transport().connected_peers() {
            if let Ok(peer) = peer.parse::<PeerId>() {
                let _ = host.network.transport().request(
                    peer,
                    xai_aiko_collective::PeerRequest::PushWitness {
                        witness: witness.clone(),
                    },
                    std::time::Duration::from_secs(2),
                );
            }
        }
    }
    Ok(())
}

fn refresh_public_checkpoint(host: &mut Host, identity: &PublisherIdentity) -> Result<(), String> {
    let records = host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?;
    let mut sequence = 0_u64;
    let mut previous: Option<(u64, String)> = None;
    let mut object_ids = Vec::new();
    for record in records
        .iter()
        .filter(|record| record.publisher == identity.publisher())
    {
        let Ok(stored) = host.store.read(&record.object_id) else {
            continue;
        };
        let record_sequence = stored
            .canonical
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        sequence = sequence.max(record_sequence);
        if record.kind == "checkpoint" {
            if previous
                .as_ref()
                .is_none_or(|(latest, _)| record_sequence > *latest)
            {
                previous = Some((record_sequence, record.object_id.clone()));
            }
        } else {
            object_ids.push(record.object_id.clone());
        }
    }
    if object_ids.is_empty() {
        return Ok(());
    }
    object_ids.sort_unstable();
    object_ids.dedup();
    let checkpoint = host
        ._contract
        .checkpoint(&object_ids)
        .map_err(|error| error.to_string())?;
    let tree_size = checkpoint
        .get("tree_size")
        .and_then(serde_json::Value::as_u64)
        .ok_or("Contract checkpoint omitted tree_size")?;
    let root_hash = checkpoint
        .get("root_hash")
        .and_then(serde_json::Value::as_str)
        .ok_or("Contract checkpoint omitted root_hash")?;
    // If the newest checkpoint already commits this exact set, do not create
    // a redundant link merely because capability refresh ran again.
    if let Some((_, previous_id)) = &previous
        && let Ok(stored) = host.store.read(previous_id)
        && stored
            .canonical
            .pointer("/payload/root_hash")
            .and_then(serde_json::Value::as_str)
            == Some(root_hash)
        && stored
            .canonical
            .pointer("/payload/tree_size")
            .and_then(serde_json::Value::as_u64)
            == Some(tree_size)
    {
        return Ok(());
    }
    let sequence = sequence
        .checked_add(1)
        .ok_or("publisher sequence exhausted")?;
    let now = chrono::Utc::now();
    let created_at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires_at =
        (now + chrono::Duration::days(90)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let candidate = serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "checkpoint",
        "publisher": identity.publisher(),
        "sequence": sequence,
        "created_at": created_at.clone(),
        "expires_at": expires_at,
        "payload": {
            "tree_size": tree_size,
            "root_hash": root_hash,
            "previous": previous.map(|(_, object_id)| object_id),
        }
    });
    let bytes = serde_json::to_vec(&candidate).map_err(|error| error.to_string())?;
    if host
        ._contract
        .publication_verdict(&bytes)
        .map_err(|error| error.to_string())?
        .verdict
        != "publishable"
    {
        return Err("Contract rejected generated checkpoint".into());
    }
    let signed = identity
        .sign(&host._contract, &bytes)
        .map_err(|error| error.to_string())?;
    host.store
        .verify_and_admit(
            &host._contract,
            &bytes,
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            &created_at,
        )
        .map_err(|error| error.to_string())?;
    host.store
        .pin(&signed.object_id)
        .map_err(|error| error.to_string())?;
    if host.settings.participation_enabled {
        let _ = host
            .network
            .transport()
            .announce_provider(&signed.object_id);
    }
    Ok(())
}

fn replicate_from_peer(host: &mut Host, peer: PeerId, object_id: &str, now: &str) -> bool {
    if host.store.read(object_id).is_ok() {
        return true;
    }
    let mut remote = RemoteObjectPeer::new(host.network.transport(), peer);
    if replicate_object(&mut remote, &host.store, &host._contract, object_id, now).is_ok() {
        return true;
    }
    let Ok(providers) = host.network.transport().find_providers(object_id) else {
        return false;
    };
    providers.into_iter().any(|provider| {
        let mut remote = RemoteObjectPeer::new(host.network.transport(), provider);
        replicate_object(&mut remote, &host.store, &host._contract, object_id, now).is_ok()
    })
}

fn synchronize_peer_indexes(host: &mut Host, peer: PeerId, now: &str) {
    let Ok(xai_aiko_collective::PeerResponse::IndexRoots { object_ids }) =
        host.network.transport().request(
            peer,
            xai_aiko_collective::PeerRequest::GetIndexRoots {
                after_generation: 0,
                limit: 4,
            },
            std::time::Duration::from_secs(3),
        )
    else {
        return;
    };
    let mut remaining_segments = 16_usize;
    for root_id in object_ids {
        if !replicate_from_peer(host, peer, &root_id, now) {
            continue;
        }
        let Ok(root) = host.store.read(&root_id) else {
            continue;
        };
        let Some(publisher) = root
            .canonical
            .get("publisher")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let Some(generation) = root
            .canonical
            .pointer("/payload/generation")
            .and_then(serde_json::Value::as_u64)
        else {
            continue;
        };
        let shard_ids = root
            .canonical
            .pointer("/payload/shards")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|shard| shard.get("object_id").and_then(serde_json::Value::as_str))
            .take(remaining_segments)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for shard_id in shard_ids {
            remaining_segments = remaining_segments.saturating_sub(1);
            if !replicate_from_peer(host, peer, &shard_id, now) {
                continue;
            }
            if let Ok(segment) = host.store.read(&shard_id) {
                let _ = ingest_admitted_segment(host.store.metadata(), &segment.canonical, now);
                let _ = host.store.pin(&shard_id);
                if host.settings.participation_enabled {
                    let _ = host.network.transport().announce_provider(&shard_id);
                }
            }
        }
        let _ = host.store.pin(&root_id);
        if host.settings.participation_enabled {
            let _ = host.network.transport().announce_provider(&root_id);
        }

        let local_witness = IndexWitness {
            publisher: publisher.clone(),
            generation,
            root_object_id: root_id.clone(),
            witness: host
                .network
                .transport()
                .local_peer_id()
                .map(|id| format!("peer:{id}"))
                .unwrap_or_else(|| "local-offline".into()),
            observed_at: now.to_owned(),
        };
        if let Ok(mut projection) = host.witnesses.lock()
            && projection.observe(local_witness.clone()).is_ok()
        {
            let _ = host.witness_log.save(&projection);
        }
        let _ = host.network.transport().request(
            peer,
            xai_aiko_collective::PeerRequest::PushWitness {
                witness: local_witness,
            },
            std::time::Duration::from_secs(2),
        );
        if let Ok(xai_aiko_collective::PeerResponse::Witnesses { observations }) =
            host.network.transport().request(
                peer,
                xai_aiko_collective::PeerRequest::GetWitnesses {
                    publisher,
                    generation,
                    limit: 256,
                },
                std::time::Duration::from_secs(2),
            )
            && let Ok(mut projection) = host.witnesses.lock()
            && projection.merge(observations).is_ok()
        {
            let _ = host.witness_log.save(&projection);
        }
    }
}

fn apply_local_availability(
    host: &Host,
    evidence: &mut BTreeMap<String, PublicEvidence>,
) -> Result<(), String> {
    for record in host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|record| record.kind == "capability")
    {
        evidence.entry(record.object_id).or_default().available = host
            .local_availability
            .contains(&(record.capability_id, record.capability_version));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct CollectiveStatus {
    pub available: bool,
    pub participation_enabled: bool,
    pub publication_mode: PublicationMode,
    pub publish_aggregate_attestations: bool,
    pub connected_peers: usize,
    pub local_peer_id: Option<String>,
    pub objects: u64,
    pub quarantined: u64,
    pub pinned: u64,
    pub object_bytes: u64,
    pub error: Option<String>,
}

fn library_names() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    return &[
        "contract_collective.dll",
        "libcontract_collective.dll",
        "contract.dll",
        "libcontract.dll",
    ];
    #[cfg(target_os = "macos")]
    return &["libcontract.dylib", "libcontract_collective.dylib"];
    #[cfg(all(unix, not(target_os = "macos")))]
    return &["libcontract.so"];
}

fn library_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("AIKO_COLLECTIVE_LIBRARY") {
        paths.push(path.into());
    }
    if let Some(path) = std::env::var_os("AIKO_CONTRACT_LIBRARY") {
        paths.push(path.into());
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(bin) = executable.parent()
    {
        for name in library_names() {
            paths.push(bin.join("../lib").join(name));
            paths.push(bin.join("../Resources/contract").join(name));
            paths.push(bin.join("contract").join(name));
        }
    }
    let home = xai_grok_config::grok_home();
    for name in library_names() {
        paths.push(home.join("lib").join(name));
        paths.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../contract/libcontract/zig-out/lib")
                .join(name),
        );
    }
    // contract-core fallback
    if let Some(home) = dirs::home_dir() {
        for name in library_names() {
            paths.push(
                home.join("Unbrowse/contract-core/libcontract/zig-out/lib")
                    .join(name),
            );
        }
    }
    for name in library_names() {
        paths.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../contract-core/libcontract/zig-out/lib")
                .join(name),
        );
    }
    paths
}

fn load_contract() -> Result<CollectiveContract, String> {
    let mut errors = Vec::new();
    for path in library_candidates() {
        match CollectiveContract::load(&path) {
            Ok(contract) => return Ok(contract),
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
    }
    Err(format!(
        "packaged Contract collective ABI unavailable ({})",
        errors.join("; ")
    ))
}

fn build_host() -> Result<Host, String> {
    let home = xai_grok_config::grok_home();
    let collective_root = home.join("collective");
    let settings_path = collective_root.join("settings.json");
    let settings = match PublicationSettings::load(&settings_path) {
        Ok(settings) => settings,
        Err(xai_aiko_collective::PublicationIoError::Io(error))
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            let settings = PublicationSettings::default();
            settings
                .save(&settings_path)
                .map_err(|error| error.to_string())?;
            settings
        }
        Err(error) => return Err(error.to_string()),
    };
    let contract = Arc::new(load_contract()?);
    let seeds = SeedSet::load(&collective_root.join("seeds.json"))?;
    let store = Arc::new(
        CollectiveStore::open(collective_root.join("store")).map_err(|error| error.to_string())?,
    );
    let search = Arc::new(Mutex::new(
        LocalSearchIndex::open(collective_root.join("search"))
            .map_err(|error| error.to_string())?,
    ));
    let witness_log = WitnessLog::new(collective_root.join("witnesses.json"));
    let witnesses = Arc::new(Mutex::new(
        witness_log.load().map_err(|error| error.to_string())?,
    ));
    let handler = StoreRequestHandler::new(Arc::clone(&store))
        .with_shared_search(Arc::clone(&search))
        .with_contract(Arc::clone(&contract))
        .with_peer_store(collective_root.join("peer-store/addresses"))
        .with_shared_witnesses(witness_log.clone(), Arc::clone(&witnesses));
    let transport = Libp2pLanTransport::for_profile(&home).with_handler(Arc::new(handler));
    let mut network = NetworkGate::new(transport);
    network
        .apply(&settings)
        .map_err(|error| error.to_string())?;
    if settings.participation_enabled {
        let _ = network.transport().dial_seeds(&seeds);
    }
    Ok(Host {
        _contract: contract,
        store,
        search,
        settings_path,
        audit: PublicationAuditLog::new(collective_root.join("publication-audit.jsonl")),
        review: PublicationReviewQueue::new(collective_root.join("publication-review")),
        witness_log,
        witnesses,
        local_availability: BTreeSet::new(),
        settings,
        seeds,
        network,
    })
}

fn host_slot() -> &'static Mutex<Option<Host>> {
    HOST.get_or_init(|| Mutex::new(None))
}

pub fn initialize_collective() -> Result<(), String> {
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    if slot.is_none() {
        *slot = Some(build_host()?);
    }
    Ok(())
}

pub fn collective_status() -> CollectiveStatus {
    if let Err(error) = initialize_collective() {
        return CollectiveStatus {
            available: false,
            participation_enabled: false,
            publication_mode: PublicationMode::Disabled,
            publish_aggregate_attestations: false,
            connected_peers: 0,
            local_peer_id: None,
            objects: 0,
            quarantined: 0,
            pinned: 0,
            object_bytes: 0,
            error: Some(error),
        };
    }
    let Ok(slot) = host_slot().lock() else {
        return CollectiveStatus {
            available: false,
            participation_enabled: false,
            publication_mode: PublicationMode::Disabled,
            publish_aggregate_attestations: false,
            connected_peers: 0,
            local_peer_id: None,
            objects: 0,
            quarantined: 0,
            pinned: 0,
            object_bytes: 0,
            error: Some("collective host lock poisoned".into()),
        };
    };
    let host = slot.as_ref().expect("initialized collective host");
    match host.store.stats() {
        Ok(stats) => CollectiveStatus {
            available: true,
            participation_enabled: host.settings.participation_enabled,
            publication_mode: host.settings.mode,
            publish_aggregate_attestations: host.settings.publish_aggregate_attestations,
            connected_peers: host.network.transport().connected_peers().len(),
            local_peer_id: host
                .network
                .transport()
                .local_peer_id()
                .map(|peer| peer.to_string()),
            objects: stats.objects,
            quarantined: stats.quarantined,
            pinned: stats.pinned,
            object_bytes: stats.object_bytes,
            error: None,
        },
        Err(error) => CollectiveStatus {
            available: false,
            participation_enabled: host.settings.participation_enabled,
            publication_mode: host.settings.mode,
            publish_aggregate_attestations: host.settings.publish_aggregate_attestations,
            connected_peers: 0,
            local_peer_id: None,
            objects: 0,
            quarantined: 0,
            pinned: 0,
            object_bytes: 0,
            error: Some(error.to_string()),
        },
    }
}

pub fn set_collective_participation(enabled: bool) -> Result<CollectiveStatus, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    let previous = host.settings.clone();
    host.settings.participation_enabled = enabled;
    if let Err(error) = host.network.apply(&host.settings) {
        host.settings = previous;
        return Err(error.to_string());
    }
    if enabled {
        let _ = host.network.transport().dial_seeds(&host.seeds);
        if let Ok(object_ids) = host.store.pinned_object_ids() {
            for object_id in object_ids {
                let _ = host.network.transport().announce_provider(&object_id);
            }
        }
    }
    if let Err(error) = host.settings.save(&host.settings_path) {
        host.settings = previous;
        let rollback = host.network.apply(&host.settings);
        return Err(match rollback {
            Ok(()) => error.to_string(),
            Err(rollback) => format!("{error}; network rollback failed: {rollback}"),
        });
    }
    if let Err(error) = host.audit.append(&PublicationAuditEvent {
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: PublicationAuditAction::ParticipationChanged,
        object_id: None,
        allowed: enabled,
        reason_codes: vec![if enabled {
            "user_enabled_participation".into()
        } else {
            "user_disabled_participation".into()
        }],
    }) {
        host.settings = previous;
        let settings_rollback = host.settings.save(&host.settings_path);
        let network_rollback = host.network.apply(&host.settings);
        return Err(format!(
            "{error}; settings rollback: {}; network rollback: {}",
            settings_rollback.map_or_else(|error| error.to_string(), |_| "ok".into()),
            network_rollback.map_or_else(|error| error.to_string(), |_| "ok".into()),
        ));
    }
    drop(slot);
    Ok(collective_status())
}

pub fn set_collective_publication_mode(mode: PublicationMode) -> Result<CollectiveStatus, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    let previous = host.settings.clone();
    host.settings.mode = mode;
    if let Err(error) = host.settings.save(&host.settings_path) {
        host.settings = previous;
        return Err(error.to_string());
    }
    if let Err(error) = host.audit.append(&PublicationAuditEvent {
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: PublicationAuditAction::PublicationModeChanged,
        object_id: None,
        allowed: mode != PublicationMode::Disabled,
        reason_codes: vec![format!(
            "publication_mode_{}",
            match mode {
                PublicationMode::Disabled => "disabled",
                PublicationMode::SafePublicShapes => "safe_public_shapes",
                PublicationMode::ReviewEveryObject => "review_every_object",
            }
        )],
    }) {
        host.settings = previous;
        let rollback = host.settings.save(&host.settings_path);
        return Err(format!(
            "{error}; settings rollback: {}",
            rollback.map_or_else(|error| error.to_string(), |_| "ok".into()),
        ));
    }
    drop(slot);
    Ok(collective_status())
}

pub fn set_collective_evidence_sharing(enabled: bool) -> Result<CollectiveStatus, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    let previous = host.settings.clone();
    host.settings.publish_aggregate_attestations = enabled;
    if let Err(error) = host.settings.save(&host.settings_path) {
        host.settings = previous;
        return Err(error.to_string());
    }
    if let Err(error) = host.audit.append(&PublicationAuditEvent {
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: PublicationAuditAction::EvidenceSharingChanged,
        object_id: None,
        allowed: enabled,
        reason_codes: vec![if enabled {
            "user_enabled_aggregate_attestations".into()
        } else {
            "user_disabled_aggregate_attestations".into()
        }],
    }) {
        host.settings = previous;
        let rollback = host.settings.save(&host.settings_path);
        return Err(format!(
            "{error}; settings rollback: {}",
            rollback.map_or_else(|error| error.to_string(), |_| "ok".into()),
        ));
    }
    drop(slot);
    Ok(collective_status())
}

pub fn collective_publication_audit() -> Result<Vec<PublicationAuditEvent>, String> {
    initialize_collective()?;
    let slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    slot.as_ref()
        .expect("initialized collective host")
        .audit
        .read_all()
        .map_err(|error| error.to_string())
}

pub fn collective_objects() -> Result<Vec<xai_aiko_collective::ObjectMetadata>, String> {
    initialize_collective()?;
    let slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    slot.as_ref()
        .expect("initialized collective host")
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())
}

pub fn collective_equivocations() -> Result<Vec<xai_aiko_collective::Equivocation>, String> {
    initialize_collective()?;
    let slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_ref().expect("initialized collective host");
    let projection = host
        .witnesses
        .lock()
        .map_err(|_| "collective witness lock poisoned")?;
    Ok(projection.equivocations())
}

pub fn query_collective_local(task: &str, limit: u32) -> Result<serde_json::Value, String> {
    if task.len() > 4_096 || limit == 0 || limit > 100 {
        return Err("invalid local Collective query bounds".into());
    }
    initialize_collective()?;
    let slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_ref().expect("initialized collective host");
    let mut search = host
        .search
        .lock()
        .map_err(|_| "collective search lock poisoned")?;
    search
        .rebuild(host.store.metadata())
        .map_err(|error| error.to_string())?;
    let hits = search
        .query(task, limit as usize)
        .map_err(|error| error.to_string())?;
    let mut evidence = project_public_evidence(&host.store, &host._contract, chrono::Utc::now())?;
    apply_local_availability(host, &mut evidence)?;
    rank_local_hits(&host._contract, &hits, &evidence, limit).map_err(|error| error.to_string())
}

pub fn discover_collective(query: PublicQuery, limit: u16) -> Result<serde_json::Value, String> {
    let request = xai_aiko_collective::PeerRequest::FindContracts {
        query: query.clone(),
        limit,
    };
    request.validate().map_err(|error| error.to_string())?;
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    if !host.settings.participation_enabled {
        return Err("Collective participation is disabled".into());
    }
    let peers = host
        .network
        .transport()
        .connected_peers()
        .into_iter()
        .filter_map(|peer| peer.parse::<PeerId>().ok())
        .collect::<Vec<_>>();
    for peer in peers.iter().take(8) {
        if let Ok(xai_aiko_collective::PeerResponse::Peers { addresses }) =
            host.network.transport().request(
                *peer,
                xai_aiko_collective::PeerRequest::PeerExchange { limit: 64 },
                std::time::Duration::from_secs(2),
            )
        {
            for address in addresses {
                if let Ok(address) = address.parse() {
                    let _ = host.network.transport().dial(address);
                }
            }
        }
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    for peer in peers.iter().take(16).copied() {
        synchronize_peer_indexes(host, peer, &now);
    }
    for peer in peers.iter().take(16) {
        let response = host.network.transport().request(
            *peer,
            request.clone(),
            std::time::Duration::from_secs(3),
        );
        let Ok(xai_aiko_collective::PeerResponse::ContractIds { object_ids }) = response else {
            continue;
        };
        for object_id in object_ids.into_iter().take(limit as usize) {
            if host.store.read(&object_id).is_ok() {
                continue;
            }
            let mut remote = RemoteObjectPeer::new(host.network.transport(), *peer);
            if replicate_object(&mut remote, &host.store, &host._contract, &object_id, &now)
                .is_err()
                && let Ok(providers) = host.network.transport().find_providers(&object_id)
            {
                for provider in providers {
                    let mut provider_peer =
                        RemoteObjectPeer::new(host.network.transport(), provider);
                    if replicate_object(
                        &mut provider_peer,
                        &host.store,
                        &host._contract,
                        &object_id,
                        &now,
                    )
                    .is_ok()
                    {
                        break;
                    }
                }
            }
        }
    }

    // Revocations are synchronized independently from search results so a
    // cached capability cannot remain deceptively discoverable after its
    // publisher has withdrawn it. Query several peers to resist simple
    // withholding, but keep the fan-out below the per-peer request budget.
    let publishers = host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|record| record.kind == "capability")
        .map(|record| record.publisher)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(32)
        .collect::<Vec<_>>();
    let mut admitted_revocations = 0_usize;
    'publisher: for publisher in publishers {
        for peer in peers.iter().take(3) {
            let response = host.network.transport().request(
                *peer,
                xai_aiko_collective::PeerRequest::GetRevocations {
                    publisher: publisher.clone(),
                    after_sequence: 0,
                    limit: 256,
                },
                std::time::Duration::from_secs(3),
            );
            let Ok(xai_aiko_collective::PeerResponse::Revocations { signed_envelopes }) = response
            else {
                continue;
            };
            for envelope in signed_envelopes {
                if admitted_revocations >= 256 {
                    break 'publisher;
                }
                if let Ok(path) =
                    host.store
                        .verify_and_admit_envelope(&host._contract, &envelope, &now)
                    && let Some(name) = path.file_name().and_then(|name| name.to_str())
                {
                    let object_id = format!("blake3:{name}");
                    let _ = host.store.pin(&object_id);
                    admitted_revocations += 1;
                }
            }
        }
    }
    let terms = query
        .capability_terms
        .into_iter()
        .chain(query.operations)
        .chain(query.effects)
        .collect::<Vec<_>>()
        .join(" ");
    let mut search = host
        .search
        .lock()
        .map_err(|_| "collective search lock poisoned")?;
    search
        .rebuild(host.store.metadata())
        .map_err(|error| error.to_string())?;
    let hits = search
        .query(&terms, limit as usize)
        .map_err(|error| error.to_string())?;
    let mut evidence = project_public_evidence(&host.store, &host._contract, chrono::Utc::now())?;
    apply_local_availability(host, &mut evidence)?;
    rank_local_hits(&host._contract, &hits, &evidence, limit as u32)
        .map_err(|error| error.to_string())
}

pub fn erase_collective_object(object_id: &str) -> Result<CollectiveStatus, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    let removed = host
        .store
        .erase_local(object_id)
        .map_err(|error| error.to_string())?;
    host.audit
        .append(&PublicationAuditEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: PublicationAuditAction::Erased,
            object_id: Some(object_id.to_owned()),
            allowed: false,
            reason_codes: vec![if removed {
                "local_copy_erased".into()
            } else {
                "local_copy_absent".into()
            }],
        })
        .map_err(|error| error.to_string())?;
    drop(slot);
    Ok(collective_status())
}

pub fn revoke_collective_object(object_id: &str, reason: &str) -> Result<String, String> {
    const ALLOWED_REASONS: &[&str] = &[
        "superseded",
        "compromised",
        "invalid",
        "privacy",
        "publisher_request",
    ];
    if !ALLOWED_REASONS.contains(&reason) {
        return Err("invalid revocation reason".into());
    }
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    let identity = PublisherIdentity::load_or_create(&NativeIdentitySecretStore)
        .map_err(|error| error.to_string())?;
    let target = host
        .store
        .metadata()
        .get(object_id)
        .map_err(|error| error.to_string())?
        .ok_or("collective object is not in the local catalog")?;
    if target.publisher != identity.publisher() {
        return Err("only the original local publisher may revoke this object".into());
    }
    let mut sequence = 0_u64;
    for metadata in host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?
    {
        if metadata.publisher != target.publisher {
            continue;
        }
        if let Ok(stored) = host.store.read(&metadata.object_id) {
            sequence = sequence.max(
                stored
                    .canonical
                    .get("sequence")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default(),
            );
        }
    }
    sequence = sequence
        .checked_add(1)
        .ok_or("publisher sequence exhausted")?;
    let now = chrono::Utc::now();
    let timestamp = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires =
        (now + chrono::Duration::days(3650)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let candidate = serde_json::to_vec(&serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "revocation",
        "publisher": identity.publisher(),
        "sequence": sequence,
        "created_at": timestamp.clone(),
        "expires_at": expires,
        "payload": {
            "target_kind": "object",
            "target": object_id,
            "reason": reason,
            "effective_at": timestamp.clone(),
        }
    }))
    .map_err(|error| error.to_string())?;
    let signed = identity
        .sign(&host._contract, &candidate)
        .map_err(|error| error.to_string())?;
    host.store
        .verify_and_admit(
            &host._contract,
            &candidate,
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            &timestamp,
        )
        .map_err(|error| error.to_string())?;
    host.store
        .pin(&signed.object_id)
        .map_err(|error| error.to_string())?;
    host.audit
        .append(&PublicationAuditEvent {
            timestamp,
            action: PublicationAuditAction::Revoked,
            object_id: Some(object_id.to_owned()),
            allowed: false,
            reason_codes: vec![
                reason.to_owned(),
                format!("revocation:{}", signed.object_id),
            ],
        })
        .map_err(|error| error.to_string())?;
    if host.settings.participation_enabled {
        let _ = host
            .network
            .transport()
            .announce_provider(&signed.object_id);
    }
    refresh_public_checkpoint(host, &identity)?;
    Ok(signed.object_id)
}

fn latency_bucket(duration_ms: u64) -> u64 {
    const BUCKETS: &[u64] = &[
        0, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
    ];
    BUCKETS
        .iter()
        .copied()
        .find(|bucket| duration_ms <= *bucket)
        .unwrap_or(60_000)
}

fn local_environment_class() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-arm64",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-arm64",
        _ => "other",
    }
}

pub fn publish_collective_observation(
    observation: &crate::capability_catalog::CapabilityObservation,
) -> Result<bool, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    if host.settings.mode == PublicationMode::Disabled
        || !host.settings.publish_aggregate_attestations
    {
        return Ok(false);
    }
    let records = host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?;
    let Some(subject) = records
        .iter()
        .find(|record| {
            record.kind == "capability"
                && record.capability_id == observation.capability_id
                && record.capability_version == observation.capability_version
        })
        .map(|record| record.object_id.clone())
    else {
        return Ok(false);
    };
    let identity = PublisherIdentity::load_or_create(&NativeIdentitySecretStore)
        .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now();
    let observed_bucket = now.format("%Y-%m-%dT%H:00:00Z").to_string();
    // At most one public observation per local key, capability version, and
    // hour. Local Contract evidence remains granular; the public layer is
    // deliberately coarse and non-replayable as an activity transcript.
    for record in records
        .iter()
        .filter(|record| record.kind == "attestation" && record.publisher == identity.publisher())
    {
        if let Ok(stored) = host.store.read(&record.object_id)
            && stored
                .canonical
                .pointer("/payload/subject")
                .and_then(serde_json::Value::as_str)
                == Some(subject.as_str())
            && stored
                .canonical
                .pointer("/payload/observed_bucket")
                .and_then(serde_json::Value::as_str)
                == Some(observed_bucket.as_str())
        {
            return Ok(false);
        }
    }
    let sequence = records
        .iter()
        .filter(|record| record.publisher == identity.publisher())
        .filter_map(|record| host.store.read(&record.object_id).ok())
        .filter_map(|stored| stored.canonical.get("sequence")?.as_u64())
        .max()
        .unwrap_or_default()
        .checked_add(1)
        .ok_or("publisher sequence exhausted")?;
    let outcome = if observation.success {
        "success"
    } else {
        match observation.error_class {
            Some(crate::capability_catalog::ObservationError::PermissionDenied) => {
                "permission_denied"
            }
            Some(crate::capability_catalog::ObservationError::ProviderUnavailable) => {
                "provider_unavailable"
            }
            Some(crate::capability_catalog::ObservationError::Timeout) => "timeout",
            Some(crate::capability_catalog::ObservationError::InvalidInput) => "invalid_input",
            _ => "provider_failure",
        }
    };
    let created_at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires_at =
        (now + chrono::Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let candidate = serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "attestation",
        "publisher": identity.publisher(),
        "sequence": sequence,
        "created_at": created_at.clone(),
        "expires_at": expires_at,
        "payload": {
            "subject": subject,
            "capability_version": observation.capability_version.clone(),
            "outcome": outcome,
            "latency_bucket_ms": latency_bucket(observation.duration_ms),
            "environment": local_environment_class(),
            "observed_bucket": observed_bucket,
        }
    });
    let bytes = serde_json::to_vec(&candidate).map_err(|error| error.to_string())?;
    let verdict = host
        ._contract
        .publication_verdict(&bytes)
        .map_err(|error| error.to_string())?;
    if verdict.verdict != "publishable" {
        return Err(format!(
            "Contract rejected aggregate attestation: {}",
            verdict.reason_codes.join(",")
        ));
    }
    let signed = identity
        .sign(&host._contract, &bytes)
        .map_err(|error| error.to_string())?;
    host.store
        .verify_and_admit(
            &host._contract,
            &bytes,
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            &created_at,
        )
        .map_err(|error| error.to_string())?;
    host.store
        .pin(&signed.object_id)
        .map_err(|error| error.to_string())?;
    host.audit
        .append(&PublicationAuditEvent {
            timestamp: created_at,
            action: PublicationAuditAction::Approved,
            object_id: Some(signed.object_id.clone()),
            allowed: true,
            reason_codes: vec!["aggregate_attestation_opt_in".into()],
        })
        .map_err(|error| error.to_string())?;
    if host.settings.participation_enabled {
        let signed_envelope = serde_json::to_vec(&serde_json::json!({
            "protocol": "aiko-collective/1",
            "object_id": signed.object_id.clone(),
            "unsigned": signed.unsigned.clone(),
            "signature": format!("ed25519:{}", signed.signature_hex),
        }))
        .map_err(|error| error.to_string())?;
        for peer in host.network.transport().connected_peers() {
            if let Ok(peer) = peer.parse::<PeerId>() {
                let _ = host.network.transport().request(
                    peer,
                    xai_aiko_collective::PeerRequest::PushAttestation {
                        signed_envelope: signed_envelope.clone(),
                    },
                    std::time::Duration::from_secs(2),
                );
            }
        }
        let _ = host
            .network
            .transport()
            .announce_provider(&signed.object_id);
    }
    refresh_public_checkpoint(host, &identity)?;
    Ok(true)
}

pub fn publish_collective_snapshots(
    snapshots: &[crate::capability_catalog::CatalogSnapshot],
) -> Result<usize, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    host.local_availability = snapshots
        .iter()
        .flat_map(|snapshot| snapshot.descriptors.iter())
        .filter(|descriptor| descriptor.available)
        .map(|descriptor| (descriptor.id.clone(), descriptor.capability_version.clone()))
        .collect();
    if host.settings.mode == PublicationMode::Disabled {
        return Ok(0);
    }
    let identity = PublisherIdentity::load_or_create(&NativeIdentitySecretStore)
        .map_err(|error| error.to_string())?;
    let publisher = identity.publisher();
    let records = host
        .store
        .metadata()
        .all()
        .map_err(|error| error.to_string())?;
    let existing = records
        .iter()
        .filter(|record| record.publisher == publisher && record.kind == "capability")
        .map(|record| {
            (
                record.capability_id.clone(),
                record.capability_version.clone(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut sequence = records
        .iter()
        .filter(|record| record.publisher == publisher)
        .filter_map(|record| host.store.read(&record.object_id).ok())
        .filter_map(|stored| stored.canonical.get("sequence")?.as_u64())
        .max()
        .unwrap_or_default();
    for pending in host.review.list().map_err(|error| error.to_string())? {
        if pending
            .candidate
            .get("publisher")
            .and_then(serde_json::Value::as_str)
            == Some(publisher.as_str())
        {
            sequence = sequence.max(
                pending
                    .candidate
                    .get("sequence")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default(),
            );
        }
    }
    let now = chrono::Utc::now();
    let created_at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires_at =
        (now + chrono::Duration::days(90)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let controller = PublicationController::new(host.settings.mode);
    let mut published = 0;
    for snapshot in snapshots {
        for descriptor in &snapshot.descriptors {
            if existing.contains(&(descriptor.id.clone(), descriptor.capability_version.clone())) {
                continue;
            }
            sequence = sequence
                .checked_add(1)
                .ok_or("publisher sequence exhausted")?;
            let candidate = crate::capability_catalog::collective_candidate(
                descriptor,
                &publisher,
                sequence,
                &created_at,
                &expires_at,
            );
            let bytes = serde_json::to_vec(&candidate).map_err(|error| error.to_string())?;
            let preview = controller
                .preview(&host._contract, &bytes)
                .map_err(|error| error.to_string())?;
            // Possessing local authority is not evidence that a capability is
            // safe to publish. Automatic mode is limited to Unbrowse's
            // sanitized public-internet route shapes; skills, MCPs, binaries,
            // and Aiko-local tools remain private unless explicit per-object
            // review approves an independently Contract-publishable shape.
            let public_origin = automatic_public_origin(&snapshot.source);
            let publish_allowed = preview.publish_allowed && public_origin;
            let queue_for_review = host.settings.mode == PublicationMode::ReviewEveryObject
                && preview.verdict.verdict == "publishable";
            let mut reason_codes = preview.verdict.reason_codes.clone();
            if !public_origin {
                reason_codes.push("local_or_ambiguous_origin_private_by_default".into());
            }
            if queue_for_review {
                reason_codes.push("awaiting_explicit_review".into());
            }
            let canonical = host
                ._contract
                .canonicalize(&bytes)
                .map_err(|error| error.to_string())?;
            host.audit
                .append(&PublicationAuditEvent {
                    timestamp: created_at.clone(),
                    action: PublicationAuditAction::Previewed,
                    object_id: Some(canonical.object_id.clone()),
                    allowed: publish_allowed,
                    reason_codes,
                })
                .map_err(|error| error.to_string())?;
            if queue_for_review {
                host.review
                    .enqueue(&PublicationReviewItem {
                        object_id: canonical.object_id.clone(),
                        candidate: canonical.canonical.clone(),
                        queued_at: created_at.clone(),
                    })
                    .map_err(|error| error.to_string())?;
            }
            if !publish_allowed {
                continue;
            }
            let signed = identity
                .sign(&host._contract, &bytes)
                .map_err(|error| error.to_string())?;
            host.store
                .verify_and_admit(
                    &host._contract,
                    &bytes,
                    &signed.object_id,
                    &signed.signature_hex,
                    &signed.publisher_key_hex,
                    &created_at,
                )
                .map_err(|error| error.to_string())?;
            host.store
                .pin(&signed.object_id)
                .map_err(|error| error.to_string())?;
            host.audit
                .append(&PublicationAuditEvent {
                    timestamp: created_at.clone(),
                    action: PublicationAuditAction::Approved,
                    object_id: Some(signed.object_id.clone()),
                    allowed: true,
                    reason_codes: vec!["contract_publishable".into()],
                })
                .map_err(|error| error.to_string())?;
            if host.settings.participation_enabled {
                let _ = host
                    .network
                    .transport()
                    .announce_provider(&signed.object_id);
            }
            published += 1;
        }
    }
    if published != 0 {
        refresh_public_index(host, &identity)?;
        refresh_public_checkpoint(host, &identity)?;
    }
    Ok(published)
}

pub fn collective_review_queue() -> Result<Vec<PublicationReviewItem>, String> {
    initialize_collective()?;
    let slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    slot.as_ref()
        .expect("initialized collective host")
        .review
        .list()
        .map_err(|error| error.to_string())
}

pub fn approve_collective_review(object_id: &str) -> Result<String, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    if host.settings.mode != PublicationMode::ReviewEveryObject {
        return Err("publication policy is not review_every_object".into());
    }
    let item = host
        .review
        .get(object_id)
        .map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&item.candidate).map_err(|error| error.to_string())?;
    let canonical = host
        ._contract
        .canonicalize(&bytes)
        .map_err(|error| error.to_string())?;
    if canonical.object_id != item.object_id
        || host
            ._contract
            .publication_verdict(&bytes)
            .map_err(|error| error.to_string())?
            .verdict
            != "publishable"
    {
        return Err("review candidate no longer passes Contract publication policy".into());
    }
    let identity = PublisherIdentity::load_or_create(&NativeIdentitySecretStore)
        .map_err(|error| error.to_string())?;
    let signed = identity
        .sign(&host._contract, &bytes)
        .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    host.store
        .verify_and_admit(
            &host._contract,
            &bytes,
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            &now,
        )
        .map_err(|error| error.to_string())?;
    host.store
        .pin(&signed.object_id)
        .map_err(|error| error.to_string())?;
    host.audit
        .append(&PublicationAuditEvent {
            timestamp: now,
            action: PublicationAuditAction::Approved,
            object_id: Some(signed.object_id.clone()),
            allowed: true,
            reason_codes: vec!["explicit_user_review".into()],
        })
        .map_err(|error| error.to_string())?;
    host.review
        .remove(object_id)
        .map_err(|error| error.to_string())?;
    if host.settings.participation_enabled {
        let _ = host
            .network
            .transport()
            .announce_provider(&signed.object_id);
    }
    refresh_public_index(host, &identity)?;
    refresh_public_checkpoint(host, &identity)?;
    Ok(signed.object_id)
}

pub fn reject_collective_review(object_id: &str) -> Result<(), String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    if !host
        .review
        .remove(object_id)
        .map_err(|error| error.to_string())?
    {
        return Err("review candidate was not found".into());
    }
    host.audit
        .append(&PublicationAuditEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: PublicationAuditAction::Rejected,
            object_id: Some(object_id.to_owned()),
            allowed: false,
            reason_codes: vec!["explicit_user_rejection".into()],
        })
        .map_err(|error| error.to_string())
}

pub fn set_collective_publication_mode_name(mode: &str) -> Result<CollectiveStatus, String> {
    let mode = match mode {
        "disabled" => PublicationMode::Disabled,
        "safe_public_shapes" => PublicationMode::SafePublicShapes,
        "review_every_object" => PublicationMode::ReviewEveryObject,
        _ => return Err("invalid collective publication mode".into()),
    };
    set_collective_publication_mode(mode)
}

pub fn cycle_collective_publication_mode() -> Result<CollectiveStatus, String> {
    initialize_collective()?;
    let current = {
        let slot = host_slot()
            .lock()
            .map_err(|_| "collective host lock poisoned")?;
        slot.as_ref()
            .expect("initialized collective host")
            .settings
            .mode
    };
    let next = match current {
        PublicationMode::Disabled => PublicationMode::SafePublicShapes,
        PublicationMode::SafePublicShapes => PublicationMode::ReviewEveryObject,
        PublicationMode::ReviewEveryObject => PublicationMode::Disabled,
    };
    set_collective_publication_mode(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_does_not_imply_shareability() {
        assert!(automatic_public_origin("unbrowse"));
        for private in ["aiko", "skill", "mcp:github", "binary", "local-data"] {
            assert!(!automatic_public_origin(private));
        }
    }

    #[test]
    fn public_latency_is_coarse_and_bounded() {
        assert_eq!(latency_bucket(0), 0);
        assert_eq!(latency_bucket(1), 10);
        assert_eq!(latency_bucket(101), 250);
        assert_eq!(latency_bucket(u64::MAX), 60_000);
    }

    #[test]
    fn packaged_library_search_includes_override_and_platform_bundle() {
        let candidates = library_candidates();
        assert!(!candidates.is_empty());
        assert!(candidates.iter().any(|path| {
            path.to_string_lossy()
                .contains("contract/libcontract/zig-out")
                || path.to_string_lossy().contains("Resources/contract")
        }));
    }
}
