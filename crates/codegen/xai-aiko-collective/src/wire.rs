//! Bounded Aiko Collective request/response messages. Transport framing is
//! owned by Aiko; object validity remains exclusively owned by Contract.

use serde::{Deserialize, Serialize};

pub const WIRE_PROTOCOL: &str = "/aiko/collective/1";
pub const MAX_HELLO_PROVIDERS: usize = 256;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
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
                object_id, bytes, ..
            } => {
                if !valid_object_id(object_id) {
                    Err(WireError::InvalidObjectId)
                } else if bytes.len() > MAX_CHUNK_BYTES {
                    Err(WireError::LimitExceeded)
                } else {
                    Ok(())
                }
            }
            Self::Providers { peer_ids } if peer_ids.len() > MAX_HELLO_PROVIDERS => {
                Err(WireError::LimitExceeded)
            }
            _ => Ok(()),
        }
    }
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
}
