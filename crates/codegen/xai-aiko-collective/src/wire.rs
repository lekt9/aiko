//! Bounded Aiko Collective request/response messages. Transport framing is
//! owned by Aiko; object validity remains exclusively owned by Contract.

use crate::transparency::IndexWitness;
use serde::{Deserialize, Serialize};

pub const WIRE_PROTOCOL: &str = "/aiko/collective/1";
pub const MAX_HELLO_PROVIDERS: usize = 256;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_QUERY_TERMS: usize = 32;
pub const MAX_QUERY_RESULTS: usize = 256;
pub const MAX_RECORD_BYTES: usize = 256 * 1024;
pub const MAX_PEER_ADDRESSES: usize = 256;
pub const MAX_WITNESSES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicQuery {
    #[serde(default)]
    pub capability_terms: Vec<String>,
    #[serde(default)]
    pub operations: Vec<String>,
    #[serde(default)]
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum PeerRequest {
    Hello {
        protocol: String,
        node_id: String,
    },
    GetObject {
        object_id: String,
        offset: u64,
        max_bytes: u32,
    },
    Providers {
        object_id: String,
    },
    AnnounceProvider {
        signed_record: Vec<u8>,
    },
    FindContracts {
        query: PublicQuery,
        limit: u16,
    },
    GetIndexRoots {
        after_generation: u64,
        limit: u16,
    },
    GetIndexSegment {
        object_id: String,
        offset: u64,
        max_bytes: u32,
    },
    PushAttestation {
        signed_envelope: Vec<u8>,
    },
    GetRevocations {
        publisher: String,
        after_sequence: u64,
        limit: u16,
    },
    PeerExchange {
        limit: u16,
    },
    PushWitness {
        witness: IndexWitness,
    },
    GetWitnesses {
        publisher: String,
        generation: u64,
        limit: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum PeerResponse {
    Hello {
        protocol: String,
    },
    ObjectChunk {
        object_id: String,
        offset: u64,
        total_bytes: u64,
        bytes: Vec<u8>,
    },
    Providers {
        peer_ids: Vec<String>,
    },
    ContractIds {
        object_ids: Vec<String>,
    },
    IndexRoots {
        object_ids: Vec<String>,
    },
    Revocations {
        signed_envelopes: Vec<Vec<u8>>,
    },
    Peers {
        addresses: Vec<String>,
    },
    Witnesses {
        observations: Vec<IndexWitness>,
    },
    Accepted,
    NotFound,
    Rejected {
        code: String,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("unsupported collective wire protocol")]
    UnsupportedProtocol,
    #[error("wire message exceeds a bound")]
    LimitExceeded,
    #[error("wire object id is malformed")]
    InvalidObjectId,
    #[error("wire query contains an invalid public feature")]
    InvalidQuery,
}

fn valid_object_id(id: &str) -> bool {
    id.strip_prefix("blake3:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

impl PeerRequest {
    pub fn validate(&self) -> Result<(), WireError> {
        match self {
            Self::Hello { protocol, node_id } => {
                if protocol != WIRE_PROTOCOL {
                    return Err(WireError::UnsupportedProtocol);
                }
                if node_id.is_empty() || node_id.len() > 128 {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::GetObject {
                object_id,
                max_bytes,
                ..
            } => {
                if !valid_object_id(object_id) {
                    return Err(WireError::InvalidObjectId);
                }
                if *max_bytes == 0 || *max_bytes as usize > MAX_CHUNK_BYTES {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::Providers { object_id } if !valid_object_id(object_id) => {
                return Err(WireError::InvalidObjectId);
            }
            Self::Providers { .. } => {}
            Self::AnnounceProvider { signed_record }
            | Self::PushAttestation {
                signed_envelope: signed_record,
            } => {
                if signed_record.is_empty() || signed_record.len() > MAX_RECORD_BYTES {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::FindContracts { query, limit } => {
                if *limit == 0 || *limit as usize > MAX_QUERY_RESULTS {
                    return Err(WireError::LimitExceeded);
                }
                validate_query(query)?;
            }
            Self::GetIndexRoots { limit, .. } => {
                if *limit == 0 || *limit as usize > MAX_QUERY_RESULTS {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::GetIndexSegment {
                object_id,
                max_bytes,
                ..
            } => {
                if !valid_object_id(object_id) {
                    return Err(WireError::InvalidObjectId);
                }
                if *max_bytes == 0 || *max_bytes as usize > MAX_CHUNK_BYTES {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::GetRevocations {
                publisher, limit, ..
            } => {
                if publisher.len() != 72
                    || !publisher.starts_with("ed25519:")
                    || *limit == 0
                    || *limit as usize > MAX_QUERY_RESULTS
                {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::PeerExchange { limit } => {
                if *limit == 0 || *limit as usize > MAX_PEER_ADDRESSES {
                    return Err(WireError::LimitExceeded);
                }
            }
            Self::PushWitness { witness } => {
                witness.validate().map_err(|_| WireError::InvalidQuery)?
            }
            Self::GetWitnesses {
                publisher, limit, ..
            } => {
                if !valid_publisher(publisher) || *limit == 0 || *limit as usize > MAX_WITNESSES {
                    return Err(WireError::LimitExceeded);
                }
            }
        }
        Ok(())
    }
}

impl PeerResponse {
    pub fn validate(&self) -> Result<(), WireError> {
        match self {
            Self::Hello { protocol } if protocol != WIRE_PROTOCOL => {
                Err(WireError::UnsupportedProtocol)
            }
            Self::ObjectChunk {
                object_id,
                offset,
                total_bytes,
                bytes,
            } => {
                if !valid_object_id(object_id) {
                    Err(WireError::InvalidObjectId)
                } else if bytes.is_empty()
                    || bytes.len() > MAX_CHUNK_BYTES
                    || *total_bytes == 0
                    || *total_bytes as usize > MAX_RECORD_BYTES
                    || offset.saturating_add(bytes.len() as u64) > *total_bytes
                {
                    Err(WireError::LimitExceeded)
                } else {
                    Ok(())
                }
            }
            Self::Providers { peer_ids }
                if peer_ids.len() > MAX_HELLO_PROVIDERS
                    || peer_ids.iter().any(|peer| {
                        peer.len() > 128 || peer.parse::<libp2p::PeerId>().is_err()
                    }) =>
            {
                Err(WireError::LimitExceeded)
            }
            Self::ContractIds { object_ids } | Self::IndexRoots { object_ids } => {
                if object_ids.len() > MAX_QUERY_RESULTS {
                    return Err(WireError::LimitExceeded);
                }
                if object_ids.iter().any(|id| !valid_object_id(id)) {
                    return Err(WireError::InvalidObjectId);
                }
                Ok(())
            }
            Self::Revocations { signed_envelopes } => {
                if signed_envelopes.len() > MAX_QUERY_RESULTS
                    || signed_envelopes
                        .iter()
                        .any(|bytes| bytes.is_empty() || bytes.len() > MAX_RECORD_BYTES)
                {
                    Err(WireError::LimitExceeded)
                } else {
                    Ok(())
                }
            }
            Self::Peers { addresses } => {
                if addresses.len() > MAX_PEER_ADDRESSES
                    || addresses.iter().any(|address| {
                        address.len() > 512
                            || address
                                .parse::<libp2p::Multiaddr>()
                                .ok()
                                .is_none_or(|parsed| {
                                    !parsed.iter().any(|part| {
                                        matches!(part, libp2p::multiaddr::Protocol::P2p(_))
                                    })
                                })
                    })
                {
                    Err(WireError::LimitExceeded)
                } else {
                    Ok(())
                }
            }
            Self::Witnesses { observations } => {
                if observations.len() > MAX_WITNESSES
                    || observations
                        .iter()
                        .any(|witness| witness.validate().is_err())
                {
                    Err(WireError::LimitExceeded)
                } else {
                    Ok(())
                }
            }
            Self::Rejected { code } => {
                if code.is_empty()
                    || code.len() > 64
                    || !code.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                {
                    Err(WireError::LimitExceeded)
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }
}

fn valid_publisher(publisher: &str) -> bool {
    publisher.len() == 72
        && publisher.starts_with("ed25519:")
        && publisher[8..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_query(query: &PublicQuery) -> Result<(), WireError> {
    for terms in [&query.capability_terms, &query.operations, &query.effects] {
        if terms.len() > MAX_QUERY_TERMS {
            return Err(WireError::LimitExceeded);
        }
        if terms.iter().any(|term| {
            term.is_empty()
                || term.len() > 64
                || !term.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._:-".contains(&byte)
                })
        }) {
            return Err(WireError::InvalidQuery);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_fail_closed_on_protocol_and_resource_bounds() {
        assert_eq!(
            PeerRequest::Hello {
                protocol: "old".into(),
                node_id: "n".into()
            }
            .validate(),
            Err(WireError::UnsupportedProtocol)
        );
        assert_eq!(
            PeerRequest::GetObject {
                object_id: format!("blake3:{}", "a".repeat(64)),
                offset: 0,
                max_bytes: (MAX_CHUNK_BYTES + 1) as u32,
            }
            .validate(),
            Err(WireError::LimitExceeded)
        );
    }

    #[test]
    fn public_lookup_is_structured_bounded_and_contains_no_task_text() {
        let request = PeerRequest::FindContracts {
            query: PublicQuery {
                capability_terms: vec!["com.example.search".into()],
                operations: vec!["search".into()],
                effects: vec!["read_only".into()],
            },
            limit: 64,
        };
        request.validate().unwrap();
        let encoded = serde_json::to_string(&request).unwrap();
        assert!(!encoded.contains("task_text"));
        let invalid = PeerRequest::FindContracts {
            query: PublicQuery {
                capability_terms: vec!["send me my private prompt".into()],
                operations: vec![],
                effects: vec![],
            },
            limit: 1,
        };
        assert_eq!(invalid.validate(), Err(WireError::InvalidQuery));
    }

    #[test]
    fn witness_sync_is_bounded_and_contains_only_public_root_metadata() {
        let witness = IndexWitness {
            publisher: format!("ed25519:{}", "1".repeat(64)),
            generation: 4,
            root_object_id: format!("blake3:{}", "a".repeat(64)),
            witness: "peer:12d3koo".into(),
            observed_at: "2026-07-21T00:00:00Z".into(),
        };
        let request = PeerRequest::PushWitness {
            witness: witness.clone(),
        };
        request.validate().unwrap();
        let encoded = serde_json::to_string(&request).unwrap();
        assert!(!encoded.contains("task_text"));
        assert!(!encoded.contains("invocation"));
        PeerResponse::Witnesses {
            observations: vec![witness],
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn hostile_response_metadata_is_rejected_before_dispatch() {
        assert_eq!(
            PeerResponse::Rejected {
                code: "X".repeat(65)
            }
            .validate(),
            Err(WireError::LimitExceeded)
        );
        assert_eq!(
            PeerResponse::Peers {
                addresses: vec!["/ip4/127.0.0.1/tcp/1".into()],
            }
            .validate(),
            Err(WireError::LimitExceeded)
        );
        assert_eq!(
            PeerResponse::ObjectChunk {
                object_id: format!("blake3:{}", "a".repeat(64)),
                offset: 5,
                total_bytes: 5,
                bytes: vec![1],
            }
            .validate(),
            Err(WireError::LimitExceeded)
        );
    }
}
