//! Local host for the decentralized Aiko Collective.
//!
//! Contract owns deterministic identity, policy, verification, and ranking.
//! This crate owns machine state and I/O: quarantine, verified blobs, pins,
//! publication controls, indexing, and the peer swarm. No caller
//! may move remote bytes into the admitted store without a Contract verdict.

pub mod contract_bridge;
pub mod events;
pub mod identity;
pub mod index_segments;
pub mod libp2p_transport;
pub mod metadata;
pub mod network;
pub mod object_store;
pub mod publication;
pub mod ranking;
pub mod replication;
pub mod replication_policy;
pub mod search;
pub mod transparency;
pub mod wire;

pub use contract_bridge::{
    AdmissionVerdict, CanonicalObject, CollectiveContract, CollectiveError, PublicationVerdict,
    VerificationVerdict,
};
pub use events::CollectiveEvent;
pub use identity::{
    IdentityError, IdentitySecretStore, NativeIdentitySecretStore, PublisherIdentity,
    SignedCollectiveObject,
};
pub use index_segments::{
    BuiltIndex, IndexBuild, IndexBuildError, IndexEntry, build_index, build_public_index,
    ingest_admitted_segment,
};
pub use libp2p::PeerId;
pub use libp2p_transport::{Libp2pLanTransport, PeerRequestHandler, StoreRequestHandler};
pub use metadata::{MetadataError, MetadataIndex, ObjectMetadata};
pub use network::{NetworkGate, NetworkGateError, PeerTransport};
pub use object_store::{
    CollectiveStore, GcReport, StoreError, StoreLimits, StoreStats, StoredObject,
};
pub use publication::{
    PublicationAuditAction, PublicationAuditEvent, PublicationAuditLog, PublicationController,
    PublicationIoError, PublicationMode, PublicationPreview, PublicationReviewItem,
    PublicationReviewQueue, PublicationSettings,
};
pub use ranking::{PublicEvidence, project_public_evidence, rank_local_hits};
pub use replication::{
    ObjectPeer, RemoteObjectPeer, ReplicationError, StorePeer, replicate_object,
};
pub use replication_policy::{
    ReplicationDecision, ReplicationPolicy, SeedAddress, SeedOrigin, SeedSet,
};
pub use search::{LocalSearchIndex, SearchError, SearchHit};
pub use transparency::{
    Equivocation, IndexWitness, LocalExecutionAuthority, TransparencyError, WitnessLog,
    WitnessProjection,
};
pub use wire::{PeerRequest, PeerResponse, PublicQuery, WIRE_PROTOCOL, WireError};
