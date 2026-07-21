//! Self-contained LAN transport baseline for the libp2p/Iroh spike.
//!
//! It deliberately uses only QUIC, mDNS, ping, and connection limits. No DNS,
//! hosted relay, rendezvous, telemetry, or cloud bootstrap is contacted.

use crate::network::PeerTransport;
use crate::wire::{MAX_CHUNK_BYTES, PeerRequest, PeerResponse, WIRE_PROTOCOL};
use crate::{CollectiveStore, SeedSet};
use futures::StreamExt;
use libp2p::{
    Multiaddr, StreamProtocol, SwarmBuilder, autonat, identify, identity, kad, mdns, ping, relay,
    request_response,
    swarm::{NetworkBehaviour, SwarmEvent, behaviour::toggle::Toggle},
};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(NetworkBehaviour)]
struct LanBehaviour {
    mdns: mdns::tokio::Behaviour,
    ping: ping::Behaviour,
    limits: libp2p::memory_connection_limits::Behaviour,
    objects: request_response::cbor::Behaviour<PeerRequest, PeerResponse>,
    identify: identify::Behaviour,
    autonat: autonat::Behaviour,
    relay_server: Toggle<relay::Behaviour>,
    kad: kad::Behaviour<kad::store::MemoryStore>,
}

pub trait PeerRequestHandler: Send + Sync + 'static {
    fn handle(&self, request: PeerRequest) -> PeerResponse;
}

#[derive(Default)]
struct RejectingHandler;

impl PeerRequestHandler for RejectingHandler {
    fn handle(&self, request: PeerRequest) -> PeerResponse {
        match request {
            PeerRequest::Hello { .. } => PeerResponse::Hello {
                protocol: WIRE_PROTOCOL.into(),
            },
            _ => PeerResponse::Rejected {
                code: "not_configured".into(),
            },
        }
    }
}

pub struct StoreRequestHandler {
    store: Arc<CollectiveStore>,
}

impl StoreRequestHandler {
    pub fn new(store: Arc<CollectiveStore>) -> Self {
        Self { store }
    }
}

impl PeerRequestHandler for StoreRequestHandler {
    fn handle(&self, request: PeerRequest) -> PeerResponse {
        match request {
            PeerRequest::Hello { .. } => PeerResponse::Hello {
                protocol: WIRE_PROTOCOL.into(),
            },
            PeerRequest::Providers { .. } => PeerResponse::Providers {
                peer_ids: Vec::new(),
            },
            PeerRequest::GetObject {
                object_id,
                offset,
                max_bytes,
            } => {
                let Ok(bytes) = self.store.read_transport_bytes(&object_id) else {
                    return PeerResponse::NotFound;
                };
                let total_bytes = bytes.len() as u64;
                let Ok(start) = usize::try_from(offset) else {
                    return PeerResponse::Rejected {
                        code: "invalid_offset".into(),
                    };
                };
                if start > bytes.len() {
                    return PeerResponse::Rejected {
                        code: "invalid_offset".into(),
                    };
                }
                let requested = (max_bytes as usize).min(MAX_CHUNK_BYTES);
                let end = start.saturating_add(requested).min(bytes.len());
                PeerResponse::ObjectChunk {
                    object_id,
                    offset,
                    total_bytes,
                    bytes: bytes[start..end].to_vec(),
                }
            }
        }
    }
}

pub struct Libp2pLanTransport {
    listen_address: Multiaddr,
    identity_path: Option<PathBuf>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
    handler: Arc<dyn PeerRequestHandler>,
    commands: Option<tokio::sync::mpsc::UnboundedSender<DriverCommand>>,
    peers: Arc<Mutex<BTreeSet<String>>>,
    listen_addresses: Arc<Mutex<Vec<Multiaddr>>>,
    local_peer_id: Option<libp2p::PeerId>,
    relay_server: bool,
}

enum DriverCommand {
    Dial(Multiaddr),
    Request {
        peer: libp2p::PeerId,
        request: PeerRequest,
        response: mpsc::SyncSender<Result<PeerResponse, String>>,
    },
    Provide {
        object_id: String,
        response: mpsc::SyncSender<Result<(), String>>,
    },
    FindProviders {
        object_id: String,
        response: mpsc::SyncSender<Result<Vec<libp2p::PeerId>, String>>,
    },
    Bootstrap {
        response: mpsc::SyncSender<Result<(), String>>,
    },
}

impl Default for Libp2pLanTransport {
    fn default() -> Self {
        Self {
            listen_address: "/ip4/0.0.0.0/udp/0/quic-v1"
                .parse()
                .expect("static collective QUIC address is valid"),
            identity_path: None,
            shutdown: None,
            worker: None,
            handler: Arc::new(RejectingHandler),
            commands: None,
            peers: Arc::new(Mutex::new(BTreeSet::new())),
            listen_addresses: Arc::new(Mutex::new(Vec::new())),
            local_peer_id: None,
            relay_server: false,
        }
    }
}

impl Libp2pLanTransport {
    pub fn with_listen_address(listen_address: Multiaddr) -> Self {
        Self {
            listen_address,
            identity_path: None,
            shutdown: None,
            worker: None,
            handler: Arc::new(RejectingHandler),
            commands: None,
            peers: Arc::new(Mutex::new(BTreeSet::new())),
            listen_addresses: Arc::new(Mutex::new(Vec::new())),
            local_peer_id: None,
            relay_server: false,
        }
    }

    /// Production constructor. The transport identity survives restarts and
    /// is stored as a private local file; it is never a hosted account key.
    pub fn for_profile(profile_root: impl AsRef<Path>) -> Self {
        Self {
            listen_address: "/ip4/0.0.0.0/udp/0/quic-v1"
                .parse()
                .expect("static collective QUIC address is valid"),
            identity_path: Some(
                profile_root
                    .as_ref()
                    .join("collective/transport-identity.key"),
            ),
            shutdown: None,
            worker: None,
            handler: Arc::new(RejectingHandler),
            commands: None,
            peers: Arc::new(Mutex::new(BTreeSet::new())),
            listen_addresses: Arc::new(Mutex::new(Vec::new())),
            local_peer_id: None,
            relay_server: false,
        }
    }

    pub fn with_handler(mut self, handler: Arc<dyn PeerRequestHandler>) -> Self {
        self.handler = handler;
        self
    }

    /// Opt-in community relay role. It is disabled by default and requires no
    /// hosted Aiko service when enabled on any reachable node.
    pub fn with_relay_server(mut self, enabled: bool) -> Self {
        self.relay_server = enabled;
        self
    }

    pub fn connected_peers(&self) -> Vec<String> {
        self.peers
            .lock()
            .map(|peers| peers.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn local_peer_id(&self) -> Option<libp2p::PeerId> {
        self.local_peer_id
    }

    pub fn listen_addresses(&self) -> Vec<Multiaddr> {
        self.listen_addresses
            .lock()
            .map(|addresses| addresses.clone())
            .unwrap_or_default()
    }

    pub fn dial(&self, address: Multiaddr) -> Result<(), String> {
        self.commands
            .as_ref()
            .ok_or("collective transport is not active")?
            .send(DriverCommand::Dial(address))
            .map_err(|_| "collective transport worker stopped".to_owned())
    }

    pub fn dial_seeds(&self, seeds: &SeedSet) -> Vec<(Multiaddr, Result<(), String>)> {
        seeds
            .addresses()
            .map(|address| {
                let result = self.dial(address.clone());
                (address, result)
            })
            .collect()
    }

    pub fn request(
        &self,
        peer: libp2p::PeerId,
        request: PeerRequest,
        timeout: Duration,
    ) -> Result<PeerResponse, String> {
        request.validate().map_err(|error| error.to_string())?;
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        self.commands
            .as_ref()
            .ok_or("collective transport is not active")?
            .send(DriverCommand::Request {
                peer,
                request,
                response: response_tx,
            })
            .map_err(|_| "collective transport worker stopped".to_owned())?;
        response_rx
            .recv_timeout(timeout)
            .map_err(|_| "collective peer request timed out".to_owned())?
    }

    pub fn announce_provider(&self, object_id: &str) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        self.commands
            .as_ref()
            .ok_or("collective transport is not active")?
            .send(DriverCommand::Provide {
                object_id: object_id.to_owned(),
                response: response_tx,
            })
            .map_err(|_| "collective transport worker stopped".to_owned())?;
        response_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "provider announcement timed out".to_owned())?
    }

    pub fn find_providers(&self, object_id: &str) -> Result<Vec<libp2p::PeerId>, String> {
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        self.commands
            .as_ref()
            .ok_or("collective transport is not active")?
            .send(DriverCommand::FindProviders {
                object_id: object_id.to_owned(),
                response: response_tx,
            })
            .map_err(|_| "collective transport worker stopped".to_owned())?;
        response_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "provider lookup timed out".to_owned())?
    }

    pub fn bootstrap(&self) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        self.commands
            .as_ref()
            .ok_or("collective transport is not active")?
            .send(DriverCommand::Bootstrap {
                response: response_tx,
            })
            .map_err(|_| "collective transport worker stopped".to_owned())?;
        response_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "DHT bootstrap timed out".to_owned())?
    }
}

fn load_or_create_identity(path: Option<&Path>) -> Result<identity::Keypair, String> {
    let Some(path) = path else {
        return Ok(identity::Keypair::generate_ed25519());
    };
    match fs::read(path) {
        Ok(bytes) => identity::Keypair::from_protobuf_encoding(&bytes)
            .map_err(|error| format!("invalid collective transport identity: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let key = identity::Keypair::generate_ed25519();
            let bytes = key
                .to_protobuf_encoding()
                .map_err(|error| error.to_string())?;
            let parent = path.parent().ok_or("identity path has no parent")?;
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            let temporary = parent.join(format!(".transport-identity.{}.tmp", std::process::id()));
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            fs::rename(&temporary, path).map_err(|error| error.to_string())?;
            Ok(key)
        }
        Err(error) => Err(error.to_string()),
    }
}

impl PeerTransport for Libp2pLanTransport {
    type Error = String;

    fn start(&mut self) -> Result<(), Self::Error> {
        if self.is_active() {
            return Ok(());
        }
        let listen_address = self.listen_address.clone();
        let identity = load_or_create_identity(self.identity_path.as_deref())?;
        let local_peer_id = identity.public().to_peer_id();
        let relay_server = self.relay_server;
        let handler = Arc::clone(&self.handler);
        let peers = Arc::clone(&self.peers);
        let listen_addresses = Arc::clone(&self.listen_addresses);
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let worker = thread::Builder::new()
            .name("aiko-collective-lan".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let built = SwarmBuilder::with_existing_identity(identity)
                        .with_tokio()
                        .with_quic()
                        .with_behaviour(|key| {
                            let peer_id = key.public().to_peer_id();
                            let mut kad = kad::Behaviour::new(
                                peer_id,
                                kad::store::MemoryStore::new(peer_id),
                            );
                            kad.set_mode(Some(kad::Mode::Server));
                            Ok(LanBehaviour {
                                mdns: mdns::tokio::Behaviour::new(
                                    mdns::Config::default(),
                                    key.public().to_peer_id(),
                                )?,
                                ping: ping::Behaviour::default(),
                                limits: libp2p::memory_connection_limits::Behaviour::with_max_percentage(
                                    0.05,
                                ),
                                objects: request_response::cbor::Behaviour::new(
                                    [(
                                        StreamProtocol::new(WIRE_PROTOCOL),
                                        request_response::ProtocolSupport::Full,
                                    )],
                                    request_response::Config::default(),
                                ),
                                identify: identify::Behaviour::new(identify::Config::new(
                                    WIRE_PROTOCOL.into(),
                                    key.public(),
                                )),
                                autonat: autonat::Behaviour::new(
                                    key.public().to_peer_id(),
                                    autonat::Config::default(),
                                ),
                                relay_server: Toggle::from(relay_server.then(|| {
                                    relay::Behaviour::new(
                                        key.public().to_peer_id(),
                                        relay::Config::default(),
                                    )
                                })),
                                kad,
                            })
                        });
                    let mut swarm = match built {
                        Ok(builder) => builder.build(),
                        Err(error) => {
                            let _ = ready_tx.send(Err(error.to_string()));
                            return;
                        }
                    };
                    if let Err(error) = swarm.listen_on(listen_address) {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                    let _ = ready_tx.send(Ok(()));
                    tokio::pin!(shutdown_rx);
                    let mut pending = HashMap::new();
                    let mut provider_queries = HashMap::new();
                    loop {
                        tokio::select! {
                            _ = &mut shutdown_rx => break,
                            command = command_rx.recv() => {
                                match command {
                                    Some(DriverCommand::Dial(address)) => {
                                        let mut routing_address = address.clone();
                                        if let Some(libp2p::multiaddr::Protocol::P2p(peer)) =
                                            routing_address.pop()
                                        {
                                            swarm
                                                .behaviour_mut()
                                                .kad
                                                .add_address(&peer, routing_address);
                                        }
                                        let _ = swarm.dial(address);
                                    }
                                    Some(DriverCommand::Request { peer, request, response }) => {
                                        let request_id = swarm
                                            .behaviour_mut()
                                            .objects
                                            .send_request(&peer, request);
                                        pending.insert(request_id, response);
                                    }
                                    Some(DriverCommand::Provide { object_id, response }) => {
                                        let result = swarm
                                            .behaviour_mut()
                                            .kad
                                            .start_providing(kad::RecordKey::new(&object_id))
                                            .map(|_| ())
                                            .map_err(|error| error.to_string());
                                        let _ = response.send(result);
                                    }
                                    Some(DriverCommand::FindProviders { object_id, response }) => {
                                        let query_id = swarm
                                            .behaviour_mut()
                                            .kad
                                            .get_providers(kad::RecordKey::new(&object_id));
                                        provider_queries.insert(query_id, response);
                                    }
                                    Some(DriverCommand::Bootstrap { response }) => {
                                        let result = swarm
                                            .behaviour_mut()
                                            .kad
                                            .bootstrap()
                                            .map(|_| ())
                                            .map_err(|error| error.to_string());
                                        let _ = response.send(result);
                                    }
                                    None => break,
                                }
                            }
                            event = swarm.select_next_some() => {
                                match event {
                                    SwarmEvent::Behaviour(LanBehaviourEvent::Mdns(
                                        mdns::Event::Discovered(discovered),
                                    )) => {
                                        for (peer, address) in discovered {
                                            if let Ok(mut known) = peers.lock() {
                                                known.insert(peer.to_string());
                                            }
                                            swarm.behaviour_mut().kad.add_address(&peer, address.clone());
                                            let _ = swarm.dial(address);
                                        }
                                    }
                                    SwarmEvent::Behaviour(LanBehaviourEvent::Objects(
                                        request_response::Event::Message {
                                            message: request_response::Message::Request {
                                                request,
                                                channel,
                                                ..
                                            },
                                            ..
                                        },
                                    )) => {
                                        let response = if request.validate().is_ok() {
                                            handler.handle(request)
                                        } else {
                                            PeerResponse::Rejected { code: "invalid_request".into() }
                                        };
                                        if response.validate().is_ok() {
                                            let _ = swarm
                                                .behaviour_mut()
                                                .objects
                                                .send_response(channel, response);
                                        }
                                    }
                                    SwarmEvent::Behaviour(LanBehaviourEvent::Objects(
                                        request_response::Event::Message {
                                            message: request_response::Message::Response {
                                                request_id,
                                                response,
                                            },
                                            ..
                                        },
                                    )) => {
                                        if let Some(waiter) = pending.remove(&request_id) {
                                            let result = response
                                                .validate()
                                                .map(|_| response)
                                                .map_err(|error| error.to_string());
                                            let _ = waiter.send(result);
                                        }
                                    }
                                    SwarmEvent::Behaviour(LanBehaviourEvent::Objects(
                                        request_response::Event::OutboundFailure {
                                            request_id,
                                            error,
                                            ..
                                        },
                                    )) => {
                                        if let Some(waiter) = pending.remove(&request_id) {
                                            let _ = waiter.send(Err(error.to_string()));
                                        }
                                    }
                                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                                        if let Ok(mut known) = peers.lock() {
                                            known.insert(peer_id.to_string());
                                        }
                                        swarm.behaviour_mut().kad.add_address(
                                            &peer_id,
                                            endpoint.get_remote_address().clone(),
                                        );
                                    }
                                    SwarmEvent::NewListenAddr { address, .. } => {
                                        if let Ok(mut addresses) = listen_addresses.lock() {
                                            if !addresses.contains(&address) {
                                                addresses.push(address);
                                            }
                                        }
                                    }
                                    SwarmEvent::ConnectionClosed {
                                        peer_id,
                                        num_established,
                                        ..
                                    } if num_established == 0 => {
                                        if let Ok(mut known) = peers.lock() {
                                            known.remove(&peer_id.to_string());
                                        }
                                    }
                                    SwarmEvent::Behaviour(LanBehaviourEvent::Kad(
                                        kad::Event::OutboundQueryProgressed { id, result, .. },
                                    )) => {
                                        match result {
                                            kad::QueryResult::GetProviders(Ok(
                                                kad::GetProvidersOk::FoundProviders { providers, .. },
                                            )) => {
                                                if let Some(waiter) = provider_queries.remove(&id) {
                                                    let _ = waiter.send(Ok(providers.into_iter().collect()));
                                                }
                                            }
                                            kad::QueryResult::GetProviders(Ok(
                                                kad::GetProvidersOk::FinishedWithNoAdditionalRecord { .. },
                                            )) => {
                                                if let Some(waiter) = provider_queries.remove(&id) {
                                                    let _ = waiter.send(Ok(Vec::new()));
                                                }
                                            }
                                            kad::QueryResult::GetProviders(Err(error)) => {
                                                if let Some(waiter) = provider_queries.remove(&id) {
                                                    let _ = waiter.send(Err(error.to_string()));
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                });
            })
            .map_err(|error| error.to_string())?;
        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.shutdown = Some(shutdown_tx);
                self.worker = Some(worker);
                self.commands = Some(command_tx);
                self.local_peer_id = Some(local_peer_id);
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(error) => {
                let _ = worker.join();
                Err(error.to_string())
            }
        }
    }

    fn stop(&mut self) -> Result<(), Self::Error> {
        self.commands.take();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "collective LAN worker panicked".to_owned())?;
        }
        Ok(())
    }

    fn is_active(&self) -> bool {
        self.worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
    }
}

impl Drop for Libp2pLanTransport {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::multiaddr::Protocol;

    #[test]
    fn lan_transport_starts_and_stops_without_any_seed_or_service() {
        let mut transport = Libp2pLanTransport::default();
        transport.start().unwrap();
        assert!(transport.is_active());
        transport.stop().unwrap();
        assert!(!transport.is_active());
    }

    #[test]
    fn relay_role_is_explicit_and_self_hostable() {
        assert!(!Libp2pLanTransport::default().relay_server);
        let mut relay = Libp2pLanTransport::default().with_relay_server(true);
        assert!(relay.relay_server);
        relay.start().unwrap();
        relay.stop().unwrap();
    }

    #[test]
    fn profile_transport_identity_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("collective/transport-identity.key");
        let first = load_or_create_identity(Some(&path)).unwrap();
        let second = load_or_create_identity(Some(&path)).unwrap();
        assert_eq!(first.public().to_peer_id(), second.public().to_peer_id());
    }

    #[test]
    fn two_nodes_exchange_hello_directly_without_internet_or_seed() {
        let localhost: Multiaddr = "/ip4/127.0.0.1/udp/0/quic-v1".parse().unwrap();
        let mut first = Libp2pLanTransport::with_listen_address(localhost.clone());
        let mut second = Libp2pLanTransport::with_listen_address(localhost);
        first.start().unwrap();
        second.start().unwrap();

        let first_address = (0..100)
            .find_map(|_| {
                let address = first.listen_addresses().into_iter().next();
                if address.is_none() {
                    std::thread::sleep(Duration::from_millis(20));
                }
                address
            })
            .expect("first peer must report its local QUIC address");
        let first_peer = first.local_peer_id().unwrap();
        let mut dial_address = first_address;
        dial_address.push(Protocol::P2p(first_peer));
        second.dial(dial_address).unwrap();

        for _ in 0..100 {
            if second.connected_peers().contains(&first_peer.to_string()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(second.connected_peers().contains(&first_peer.to_string()));
        let response = second
            .request(
                first_peer,
                PeerRequest::Hello {
                    protocol: WIRE_PROTOCOL.into(),
                    node_id: second.local_peer_id().unwrap().to_string(),
                },
                Duration::from_secs(3),
            )
            .unwrap();
        assert_eq!(
            response,
            PeerResponse::Hello {
                protocol: WIRE_PROTOCOL.into()
            }
        );
        let object_id = format!("blake3:{}", "a".repeat(64));
        first.announce_provider(&object_id).unwrap();
        let providers = second.find_providers(&object_id).unwrap();
        assert!(providers.contains(&first_peer));
        first.stop().unwrap();
        second.stop().unwrap();
    }

    #[test]
    fn three_node_kad_provider_lookup_survives_original_seed_departure() {
        fn address_of(node: &Libp2pLanTransport) -> Multiaddr {
            (0..100)
                .find_map(|_| {
                    let address = node.listen_addresses().into_iter().next();
                    if address.is_none() {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    address
                })
                .expect("node must publish a local address")
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
            panic!("nodes did not connect");
        }

        let localhost: Multiaddr = "/ip4/127.0.0.1/udp/0/quic-v1".parse().unwrap();
        let mut original_seed = Libp2pLanTransport::with_listen_address(localhost.clone());
        let mut community_replica = Libp2pLanTransport::with_listen_address(localhost.clone());
        let mut unrelated = Libp2pLanTransport::with_listen_address(localhost);
        original_seed.start().unwrap();
        community_replica.start().unwrap();
        unrelated.start().unwrap();
        connect(&community_replica, &original_seed);
        connect(&unrelated, &community_replica);
        community_replica.bootstrap().unwrap();
        unrelated.bootstrap().unwrap();
        std::thread::sleep(Duration::from_millis(250));

        let object_id = format!("blake3:{}", "c".repeat(64));
        original_seed.announce_provider(&object_id).unwrap();
        community_replica.announce_provider(&object_id).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        let community_peer = community_replica.local_peer_id().unwrap();
        original_seed.stop().unwrap();

        let providers = unrelated.find_providers(&object_id).unwrap();
        assert!(providers.contains(&community_peer));
        community_replica.stop().unwrap();
        unrelated.stop().unwrap();
    }
}
