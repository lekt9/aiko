//! Resumable, transport-neutral verified object transfer.
//!
//! libp2p owns peer reachability and framing. This module owns the bounded
//! GET_OBJECT state machine and never admits received bytes without Contract.

use crate::object_store::MAX_QUARANTINE_OBJECT_BYTES;
use crate::{
    CollectiveContract, CollectiveStore, Libp2pLanTransport, PeerRequest, PeerResponse, StoreError,
    StoredObject,
};
use std::time::Duration;

pub trait ObjectPeer {
    type Error;
    fn request(&mut self, request: PeerRequest) -> Result<PeerResponse, Self::Error>;
}

pub struct StorePeer<'a> {
    store: &'a CollectiveStore,
}

impl<'a> StorePeer<'a> {
    pub fn new(store: &'a CollectiveStore) -> Self {
        Self { store }
    }
}

impl ObjectPeer for StorePeer<'_> {
    type Error = StoreError;

    fn request(&mut self, request: PeerRequest) -> Result<PeerResponse, Self::Error> {
        let PeerRequest::GetObject {
            object_id,
            offset,
            max_bytes,
        } = request
        else {
            return Ok(PeerResponse::Rejected {
                code: "unsupported_request".into(),
            });
        };
        let bytes = match self.store.read_transport_bytes(&object_id) {
            Ok(bytes) => bytes,
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PeerResponse::NotFound);
            }
            Err(error) => return Err(error),
        };
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        if start >= bytes.len() || max_bytes == 0 {
            return Ok(PeerResponse::Rejected {
                code: "invalid_range".into(),
            });
        }
        let end = start.saturating_add(max_bytes as usize).min(bytes.len());
        Ok(PeerResponse::ObjectChunk {
            object_id,
            offset,
            total_bytes: bytes.len() as u64,
            bytes: bytes[start..end].to_vec(),
        })
    }
}

pub struct RemoteObjectPeer<'a> {
    transport: &'a Libp2pLanTransport,
    peer: libp2p::PeerId,
    timeout: Duration,
}

impl<'a> RemoteObjectPeer<'a> {
    pub fn new(transport: &'a Libp2pLanTransport, peer: libp2p::PeerId) -> Self {
        Self {
            transport,
            peer,
            timeout: Duration::from_secs(10),
        }
    }
}

impl ObjectPeer for RemoteObjectPeer<'_> {
    type Error = String;

    fn request(&mut self, request: PeerRequest) -> Result<PeerResponse, Self::Error> {
        self.transport.request(self.peer, request, self.timeout)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ReplicationError<E> {
    #[error("peer transfer failed")]
    Peer(E),
    #[error("peer returned an invalid object transfer")]
    InvalidTransfer,
    #[error("peer does not provide the requested object")]
    NotFound,
    #[error("received object was rejected: {0}")]
    Store(#[from] StoreError),
    #[error("received object wrapper is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

fn valid_chunk(
    requested_id: &str,
    expected_offset: u64,
    expected_total: Option<u64>,
    returned_id: &str,
    returned_offset: u64,
    total_bytes: u64,
    bytes_len: usize,
) -> bool {
    returned_id == requested_id
        && returned_offset == expected_offset
        && total_bytes != 0
        && total_bytes as usize <= MAX_QUARANTINE_OBJECT_BYTES
        && expected_total.is_none_or(|expected| expected == total_bytes)
        && bytes_len != 0
        && expected_offset.saturating_add(bytes_len as u64) <= total_bytes
}

pub fn replicate_object<P: ObjectPeer>(
    peer: &mut P,
    store: &CollectiveStore,
    contract: &CollectiveContract,
    object_id: &str,
    now_iso: &str,
) -> Result<(), ReplicationError<P::Error>> {
    let mut offset = 0_u64;
    let mut expected_total = None;
    let mut received = Vec::new();
    loop {
        let response = peer
            .request(PeerRequest::GetObject {
                object_id: object_id.to_owned(),
                offset,
                max_bytes: crate::wire::MAX_CHUNK_BYTES as u32,
            })
            .map_err(ReplicationError::Peer)?;
        response
            .validate()
            .map_err(|_| ReplicationError::InvalidTransfer)?;
        let PeerResponse::ObjectChunk {
            object_id: returned_id,
            offset: returned_offset,
            total_bytes,
            bytes,
        } = response
        else {
            return match response {
                PeerResponse::NotFound => Err(ReplicationError::NotFound),
                _ => Err(ReplicationError::InvalidTransfer),
            };
        };
        if !valid_chunk(
            object_id,
            offset,
            expected_total,
            &returned_id,
            returned_offset,
            total_bytes,
            bytes.len(),
        ) {
            return Err(ReplicationError::InvalidTransfer);
        }
        expected_total = Some(total_bytes);
        received.extend_from_slice(&bytes);
        offset += bytes.len() as u64;
        if offset == total_bytes {
            break;
        }
    }

    // The full hostile wrapper is quarantined before any semantic parsing.
    store.quarantine(&received)?;
    let stored: StoredObject = serde_json::from_slice(&received)?;
    let candidate = serde_json::to_vec(&stored.canonical)?;
    store.verify_and_admit(
        contract,
        &candidate,
        object_id,
        &stored.signature_hex,
        &stored.publisher_key_hex,
        now_iso,
    )?;
    store.remove_quarantine(&received);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_rejects_offset_replay_before_contract() {
        let object_id = format!("blake3:{}", "a".repeat(64));
        assert!(!valid_chunk(&object_id, 0, None, &object_id, 1, 2, 1));
        assert!(!valid_chunk(&object_id, 1, Some(2), &object_id, 1, 3, 1));
        assert!(valid_chunk(&object_id, 0, None, &object_id, 0, 2, 1));
    }
}
