//! Stable, privacy-bounded events shared by desktop and TUI adapters.

use crate::{GcReport, PublicationMode, StoreStats};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CollectiveEvent {
    ParticipationChanged {
        enabled: bool,
        publication_mode: PublicationMode,
    },
    PublicationPreviewed {
        object_id: Option<String>,
        allowed: bool,
        requires_review: bool,
        reason_codes: Vec<String>,
    },
    ObjectQuarantined {
        quarantine_id: String,
        bytes: u64,
    },
    ObjectAdmitted {
        object_id: String,
    },
    ObjectRejected {
        claimed_object_id: Option<String>,
        reason_codes: Vec<String>,
    },
    PackImported {
        admitted_objects: u64,
    },
    GarbageCollected(GcReport),
    StoreStats(StoreStats),
}

impl CollectiveEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ParticipationChanged { .. } => "participation_changed",
            Self::PublicationPreviewed { .. } => "publication_previewed",
            Self::ObjectQuarantined { .. } => "object_quarantined",
            Self::ObjectAdmitted { .. } => "object_admitted",
            Self::ObjectRejected { .. } => "object_rejected",
            Self::PackImported { .. } => "pack_imported",
            Self::GarbageCollected(_) => "garbage_collected",
            Self::StoreStats(_) => "store_stats",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_wire_shape_has_no_raw_payload_escape_hatch() {
        let event = CollectiveEvent::ObjectRejected {
            claimed_object_id: None,
            reason_codes: vec!["forbidden_field".into()],
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "object_rejected");
        let encoded = json.to_string();
        for forbidden in ["descriptor", "prompt", "credential", "request_body"] {
            assert!(!encoded.contains(forbidden));
        }
    }
}
