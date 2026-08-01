//! Deterministic, signed, replicable public index segments.

use crate::{
    CanonicalObject, CollectiveContract, CollectiveError, CollectiveStore, IdentityError,
    MetadataError, MetadataIndex, ObjectMetadata, PublisherIdentity, StoreError,
};
use serde::{Deserialize, Serialize};

const MAX_SEGMENT_ENTRIES: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum IndexBuildError {
    #[error(transparent)]
    Metadata(#[from] MetadataError),
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Contract(#[from] CollectiveError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("Contract rejected a generated index object")]
    Rejected,
    #[error("index generation contains too many sequence values")]
    SequenceOverflow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuiltIndex {
    pub root_object_id: String,
    pub segment_object_ids: Vec<String>,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IndexEntry {
    pub object_id: String,
    pub publisher: String,
    pub capability_id: String,
    pub capability_version: String,
    pub summary: String,
    pub operation: String,
    pub origin: String,
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexBuild {
    pub segments: Vec<CanonicalObject>,
    pub root: CanonicalObject,
}

fn entries(metadata: &MetadataIndex) -> Result<Vec<IndexEntry>, MetadataError> {
    Ok(metadata
        .all()?
        .into_iter()
        .filter(|record| record.kind == "capability" && !record.capability_id.is_empty())
        .map(|record| IndexEntry {
            object_id: record.object_id,
            publisher: record.publisher,
            capability_id: record.capability_id,
            capability_version: record.capability_version,
            summary: record.summary,
            operation: record.operation,
            origin: record.origin,
            effects: record.effects,
        })
        .collect())
}

/// Build canonical unsigned index objects. A caller may compare these bytes,
/// preview them, and then sign them with `PublisherIdentity`; this function has
/// no persistence or publication side effect.
pub fn build_index(
    metadata: &MetadataIndex,
    contract: &CollectiveContract,
    publisher: &str,
    generation: u64,
    sequence_start: u64,
    created_at: &str,
    expires_at: &str,
) -> Result<IndexBuild, IndexBuildError> {
    let entries = entries(metadata)?;
    let mut segments = Vec::new();
    let mut shards = Vec::new();
    for (index, chunk) in entries.chunks(MAX_SEGMENT_ENTRIES).enumerate() {
        let sequence = sequence_start
            .checked_add(index as u64)
            .ok_or(IndexBuildError::SequenceOverflow)?;
        let prefix = chunk
            .first()
            .and_then(|entry| entry.object_id.strip_prefix("blake3:"))
            .map(|digest| &digest[..2])
            .unwrap_or("empty");
        let candidate = serde_json::json!({
            "protocol": "aiko-collective/1",
            "kind": "index_segment",
            "publisher": publisher,
            "sequence": sequence,
            "created_at": created_at,
            "expires_at": expires_at,
            "payload": {"generation": generation, "prefix": prefix, "entries": chunk}
        });
        let canonical =
            contract.canonicalize(&serde_json::to_vec(&candidate).map_err(StoreError::Json)?)?;
        shards.push(serde_json::json!({
            "prefix": prefix,
            "object_id": canonical.object_id,
            "count": chunk.len()
        }));
        segments.push(canonical);
    }
    let root_sequence = sequence_start
        .checked_add(segments.len() as u64)
        .ok_or(IndexBuildError::SequenceOverflow)?;
    let root = serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "index_root",
        "publisher": publisher,
        "sequence": root_sequence,
        "created_at": created_at,
        "expires_at": expires_at,
        "payload": {"generation": generation, "schema_version": 1, "shards": shards}
    });
    Ok(IndexBuild {
        segments,
        root: contract.canonicalize(&serde_json::to_vec(&root).map_err(StoreError::Json)?)?,
    })
}

/// Project an already Contract-admitted segment into a rebuildable local
/// catalog. Network callers must perform admission before calling this.
pub fn ingest_admitted_segment(
    metadata: &MetadataIndex,
    canonical: &serde_json::Value,
    admitted_at: &str,
) -> Result<usize, IndexBuildError> {
    if canonical.get("kind").and_then(serde_json::Value::as_str) != Some("index_segment") {
        return Err(IndexBuildError::Rejected);
    }
    let entries: Vec<IndexEntry> = serde_json::from_value(
        canonical
            .get("payload")
            .and_then(|payload| payload.get("entries"))
            .cloned()
            .ok_or(IndexBuildError::Rejected)?,
    )
    .map_err(MetadataError::Json)?;
    for entry in &entries {
        metadata.put(&ObjectMetadata {
            object_id: entry.object_id.clone(),
            kind: "capability".into(),
            publisher: entry.publisher.clone(),
            admitted_at: admitted_at.to_owned(),
            capability_id: entry.capability_id.clone(),
            capability_version: entry.capability_version.clone(),
            summary: entry.summary.clone(),
            operation: entry.operation.clone(),
            origin: entry.origin.clone(),
            effects: entry.effects.clone(),
        })?;
    }
    Ok(entries.len())
}

pub fn build_public_index(
    metadata: &MetadataIndex,
    output: &CollectiveStore,
    contract: &CollectiveContract,
    identity: &PublisherIdentity,
    generation: u64,
    sequence_start: u64,
    created_at: &str,
    expires_at: &str,
) -> Result<BuiltIndex, IndexBuildError> {
    let records = metadata
        .all()?
        .into_iter()
        .filter(|record| record.kind == "capability" && !record.capability_id.is_empty())
        .collect::<Vec<_>>();
    let mut shards = Vec::new();
    let mut segment_object_ids = Vec::new();
    for (index, chunk) in records.chunks(MAX_SEGMENT_ENTRIES).enumerate() {
        let sequence = sequence_start
            .checked_add(index as u64)
            .ok_or(IndexBuildError::SequenceOverflow)?;
        let prefix = chunk
            .first()
            .and_then(|entry| entry.object_id.strip_prefix("blake3:"))
            .map(|digest| &digest[..2])
            .unwrap_or("empty");
        let entries = chunk
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "object_id": entry.object_id,
                    "publisher": entry.publisher,
                    "capability_id": entry.capability_id,
                    "capability_version": entry.capability_version,
                    "summary": entry.summary,
                    "operation": entry.operation,
                    "origin": entry.origin,
                    "effects": entry.effects
                })
            })
            .collect::<Vec<_>>();
        let candidate = serde_json::json!({
            "protocol": "aiko-collective/1",
            "kind": "index_segment",
            "publisher": identity.publisher(),
            "sequence": sequence,
            "created_at": created_at,
            "expires_at": expires_at,
            "payload": {"generation": generation, "prefix": prefix, "entries": entries}
        });
        let candidate = serde_json::to_vec(&candidate).map_err(StoreError::Json)?;
        if contract.publication_verdict(&candidate)?.verdict != "publishable" {
            return Err(IndexBuildError::Rejected);
        }
        let signed = identity.sign(contract, &candidate)?;
        output.verify_and_admit(
            contract,
            &serde_json::to_vec(&signed.unsigned).map_err(StoreError::Json)?,
            &signed.object_id,
            &signed.signature_hex,
            &signed.publisher_key_hex,
            created_at,
        )?;
        shards.push(serde_json::json!({
            "prefix": prefix,
            "object_id": signed.object_id,
            "count": chunk.len()
        }));
        segment_object_ids.push(signed.object_id);
    }

    let root_sequence = sequence_start
        .checked_add(segment_object_ids.len() as u64)
        .ok_or(IndexBuildError::SequenceOverflow)?;
    let root = serde_json::json!({
        "protocol": "aiko-collective/1",
        "kind": "index_root",
        "publisher": identity.publisher(),
        "sequence": root_sequence,
        "created_at": created_at,
        "expires_at": expires_at,
        "payload": {"generation": generation, "schema_version": 1, "shards": shards}
    });
    let root = serde_json::to_vec(&root).map_err(StoreError::Json)?;
    if contract.publication_verdict(&root)?.verdict != "publishable" {
        return Err(IndexBuildError::Rejected);
    }
    let signed_root = identity.sign(contract, &root)?;
    output.verify_and_admit(
        contract,
        &serde_json::to_vec(&signed_root.unsigned).map_err(StoreError::Json)?,
        &signed_root.object_id,
        &signed_root.signature_hex,
        &signed_root.publisher_key_hex,
        created_at,
    )?;
    Ok(BuiltIndex {
        root_object_id: signed_root.object_id,
        segment_object_ids,
        entry_count: records.len(),
    })
}
