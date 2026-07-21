//! Process-lifetime host for Aiko Collective state and networking.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use xai_aiko_collective::{
    CollectiveContract, CollectiveStore, Libp2pLanTransport, NetworkGate, PublicationMode,
    PublicationSettings, StoreRequestHandler,
};

struct Host {
    _contract: CollectiveContract,
    store: Arc<CollectiveStore>,
    settings_path: PathBuf,
    settings: PublicationSettings,
    network: NetworkGate<Libp2pLanTransport>,
}

static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct CollectiveStatus {
    pub available: bool,
    pub participation_enabled: bool,
    pub publication_mode: PublicationMode,
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
    return &["contract.dll", "libcontract.dll"];
    #[cfg(target_os = "macos")]
    return &["libcontract.dylib"];
    #[cfg(all(unix, not(target_os = "macos")))]
    return &["libcontract.so"];
}

fn library_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
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
    let home = xai_grok_config::paths::grok_home();
    for name in library_names() {
        paths.push(home.join("lib").join(name));
        paths.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../contract/libcontract/zig-out/lib")
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
    let home = xai_grok_config::paths::grok_home();
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
    let contract = load_contract()?;
    let store = Arc::new(
        CollectiveStore::open(collective_root.join("store")).map_err(|error| error.to_string())?,
    );
    let transport = Libp2pLanTransport::for_profile(&home)
        .with_handler(Arc::new(StoreRequestHandler::new(Arc::clone(&store))));
    let mut network = NetworkGate::new(transport);
    network
        .apply(&settings)
        .map_err(|error| error.to_string())?;
    Ok(Host {
        _contract: contract,
        store,
        settings_path,
        settings,
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
    host.settings
        .save(&host.settings_path)
        .map_err(|error| error.to_string())?;
    drop(slot);
    Ok(collective_status())
}

pub fn set_collective_publication_mode(mode: PublicationMode) -> Result<CollectiveStatus, String> {
    initialize_collective()?;
    let mut slot = host_slot()
        .lock()
        .map_err(|_| "collective host lock poisoned")?;
    let host = slot.as_mut().expect("initialized collective host");
    host.settings.mode = mode;
    host.settings
        .save(&host.settings_path)
        .map_err(|error| error.to_string())?;
    drop(slot);
    Ok(collective_status())
}

#[cfg(test)]
mod tests {
    use super::*;

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
