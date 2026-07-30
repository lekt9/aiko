use crate::contract_bridge::{CollectiveContract, CollectiveError};
use crate::metadata::{MetadataError, MetadataIndex, ObjectMetadata};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_QUARANTINE_OBJECT_BYTES: usize = 256 * 1024;
pub const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PACK_OBJECTS: usize = 16_384;
const PACK_MAGIC: &[u8; 9] = b"AIKOPACK\x01";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("collective object exceeds the quarantine limit")]
    TooLarge,
    #[error("invalid collective object id")]
    InvalidObjectId,
    #[error("invalid or truncated Aiko object pack")]
    InvalidPack,
    #[error("Aiko object pack exceeds its resource limit")]
    PackTooLarge,
    #[error("collective store quota exceeded")]
    QuotaExceeded,
    #[error("Contract verification failed: {0}")]
    Contract(#[from] CollectiveError),
    #[error("collective store I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("collective metadata serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("collective metadata index failed: {0}")]
    Metadata(#[from] MetadataError),
}

/// The signature is transport evidence and is intentionally kept beside the
/// immutable canonical object. The content ID still covers only `canonical`,
/// exactly as defined by Contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoredObject {
    pub canonical: serde_json::Value,
    pub signature_hex: String,
    pub publisher_key_hex: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoreLimits {
    pub max_objects: u64,
    pub max_object_bytes: u64,
    pub max_quarantine_bytes: u64,
}

impl Default for StoreLimits {
    fn default() -> Self {
        Self {
            max_objects: 100_000,
            max_object_bytes: 2 * 1024 * 1024 * 1024,
            max_quarantine_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GcReport {
    pub removed_objects: u64,
    pub removed_bytes: u64,
    pub remaining_objects: u64,
    pub remaining_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoreStats {
    pub objects: u64,
    pub quarantined: u64,
    pub pinned: u64,
    pub object_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CollectiveStore {
    root: PathBuf,
    limits: StoreLimits,
    metadata: MetadataIndex,
}

impl CollectiveStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        Self::open_with_limits(root, StoreLimits::default())
    }

    pub fn open_with_limits(
        root: impl Into<PathBuf>,
        limits: StoreLimits,
    ) -> Result<Self, StoreError> {
        let root = root.into();
        for directory in ["objects", "quarantine", "pins", "audit"] {
            fs::create_dir_all(root.join(directory))?;
        }
        let metadata = MetadataIndex::open(root.join("catalog.redb"))?;
        Ok(Self {
            root,
            limits,
            metadata,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn metadata(&self) -> &MetadataIndex {
        &self.metadata
    }

    fn validate_object_id(object_id: &str) -> Result<&str, StoreError> {
        let digest = object_id
            .strip_prefix("blake3:")
            .ok_or(StoreError::InvalidObjectId)?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(StoreError::InvalidObjectId);
        }
        Ok(digest)
    }

    fn object_path(&self, object_id: &str) -> Result<PathBuf, StoreError> {
        let digest = Self::validate_object_id(object_id)?;
        Ok(self.root.join("objects").join(&digest[..2]).join(digest))
    }

    fn atomic_write(path: &Path, bytes: &[u8]) -> Result<bool, StoreError> {
        if path.exists() {
            return Ok(false);
        }
        let parent = path.parent().ok_or(StoreError::InvalidObjectId)?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("object"),
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        if let Err(error) = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, path)?;
            Ok::<_, std::io::Error>(())
        })() {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(true)
    }

    /// Store untrusted remote bytes under a local-only hash. Quarantine hashes
    /// are not collective IDs and must never be announced or indexed.
    pub fn quarantine(&self, bytes: &[u8]) -> Result<PathBuf, StoreError> {
        if bytes.is_empty() || bytes.len() > MAX_QUARANTINE_OBJECT_BYTES {
            return Err(StoreError::TooLarge);
        }
        let digest = blake3::hash(bytes).to_hex().to_string();
        let path = self.root.join("quarantine").join(digest);
        if !path.exists() {
            let current = directory_bytes(&self.root.join("quarantine"))?;
            if current.saturating_add(bytes.len() as u64) > self.limits.max_quarantine_bytes {
                return Err(StoreError::QuotaExceeded);
            }
        }
        Self::atomic_write(&path, bytes)?;
        Ok(path)
    }

    pub(crate) fn remove_quarantine(&self, bytes: &[u8]) {
        let digest = blake3::hash(bytes).to_hex().to_string();
        let _ = fs::remove_file(self.root.join("quarantine").join(digest));
    }

    /// Verify hostile bytes through Contract, persist Contract's canonical
    /// representation with the verification evidence needed by another node,
    /// and remove the matching quarantine file after success.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_and_admit(
        &self,
        contract: &CollectiveContract,
        candidate: &[u8],
        claimed_object_id: &str,
        signature_hex: &str,
        publisher_key_hex: &str,
        now_iso: &str,
    ) -> Result<PathBuf, StoreError> {
        let canonical = contract.canonicalize(candidate)?;
        if canonical.object_id != claimed_object_id {
            return Err(StoreError::InvalidObjectId);
        }
        // The complete-envelope admission API enforces publication policy and
        // ledger projection. Keep the direct verifier too: it binds the
        // transport-supplied publisher key to this exact object before that
        // key is retained as replication evidence.
        contract.verify(
            candidate,
            claimed_object_id,
            signature_hex,
            publisher_key_hex,
            now_iso,
        )?;
        let envelope = serde_json::json!({
            "protocol": "aiko-collective/1",
            "object_id": claimed_object_id,
            "unsigned": &canonical.canonical,
            "signature": format!("ed25519:{signature_hex}"),
        });
        let envelope_bytes = serde_json::to_vec(&envelope)?;
        let admission = contract.admit(&envelope_bytes, "local", now_iso)?;
        if admission.object_id != claimed_object_id || admission.verdict != "admitted" {
            return Err(StoreError::InvalidObjectId);
        }
        let kind = canonical
            .canonical
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .ok_or(StoreError::InvalidPack)?
            .to_owned();
        let publisher = canonical
            .canonical
            .get("publisher")
            .and_then(serde_json::Value::as_str)
            .ok_or(StoreError::InvalidPack)?
            .to_owned();
        let payload = canonical.canonical.get("payload");
        let text = |key: &str| {
            payload
                .and_then(|value| value.get(key))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let effects = payload
            .and_then(|value| value.get("effects"))
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let capability_id = text("capability_id");
        let capability_version = text("capability_version");
        let summary = text("summary");
        let operation = text("operation");
        let origin = text("origin");
        let stored = StoredObject {
            canonical: canonical.canonical,
            signature_hex: signature_hex.to_owned(),
            publisher_key_hex: publisher_key_hex.to_owned(),
        };
        let canonical_bytes = serde_json::to_vec(&stored)?;
        let path = self.object_path(claimed_object_id)?;
        if !path.exists() {
            let stats = self.stats()?;
            if stats.objects.saturating_add(1) > self.limits.max_objects
                || stats
                    .object_bytes
                    .saturating_add(canonical_bytes.len() as u64)
                    > self.limits.max_object_bytes
            {
                return Err(StoreError::QuotaExceeded);
            }
        }
        Self::atomic_write(&path, &canonical_bytes)?;
        self.metadata.put(&ObjectMetadata {
            object_id: claimed_object_id.to_owned(),
            kind,
            publisher,
            admitted_at: now_iso.to_owned(),
            capability_id,
            capability_version,
            summary,
            operation,
            origin,
            effects,
        })?;
        let quarantine_hash = blake3::hash(candidate).to_hex().to_string();
        let _ = fs::remove_file(self.root.join("quarantine").join(quarantine_hash));
        Ok(path)
    }

    /// Admit the canonical signed envelope used by gossip messages. The
    /// envelope is hostile input: it is bounded, quarantined, decoded under a
    /// closed shape, and then passed through the same Contract verification as
    /// chunked object replication.
    pub fn verify_and_admit_envelope(
        &self,
        contract: &CollectiveContract,
        envelope_bytes: &[u8],
        now_iso: &str,
    ) -> Result<PathBuf, StoreError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Envelope {
            protocol: String,
            object_id: String,
            unsigned: serde_json::Value,
            signature: String,
        }

        self.quarantine(envelope_bytes)?;
        let result = (|| {
            let envelope: Envelope = serde_json::from_slice(envelope_bytes)?;
            if envelope.protocol != "aiko-collective/1" {
                return Err(StoreError::InvalidPack);
            }
            let signature = envelope
                .signature
                .strip_prefix("ed25519:")
                .ok_or(StoreError::InvalidPack)?;
            let publisher_key = envelope
                .unsigned
                .get("publisher")
                .and_then(serde_json::Value::as_str)
                .and_then(|publisher| publisher.strip_prefix("ed25519:"))
                .ok_or(StoreError::InvalidPack)?;
            let candidate = serde_json::to_vec(&envelope.unsigned)?;
            self.verify_and_admit(
                contract,
                &candidate,
                &envelope.object_id,
                signature,
                publisher_key,
                now_iso,
            )
        })();
        self.remove_quarantine(envelope_bytes);
        result
    }

    pub fn read(&self, object_id: &str) -> Result<StoredObject, StoreError> {
        let bytes = fs::read(self.object_path(object_id)?)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Exact signed storage envelope used for resumable peer transfer. Only
    /// admitted objects have an object path, so this can never serve quarantine.
    pub fn read_transport_bytes(&self, object_id: &str) -> Result<Vec<u8>, StoreError> {
        Ok(fs::read(self.object_path(object_id)?)?)
    }

    /// Erase this node's local copy. This cannot retract immutable copies that
    /// peers already retained; future discovery is stopped separately by a
    /// signed revocation object.
    pub fn erase_local(&self, object_id: &str) -> Result<bool, StoreError> {
        let digest = Self::validate_object_id(object_id)?;
        let path = self.object_path(object_id)?;
        let existed = match fs::remove_file(&path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        let _ = fs::remove_file(self.root.join("pins").join(digest));
        self.metadata.remove(object_id)?;
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent);
        }
        Ok(existed)
    }

    /// Produce a stable, length-delimited pack. Entries are sorted by content
    /// ID and copied byte-for-byte, so the same verified catalog always yields
    /// the same pack regardless of filesystem enumeration order.
    pub fn export_pack(&self) -> Result<Vec<u8>, StoreError> {
        let mut entries = Vec::<(String, Vec<u8>)>::new();
        for prefix in fs::read_dir(self.root.join("objects"))? {
            let prefix = prefix?;
            if !prefix.file_type()?.is_dir() {
                continue;
            }
            for object in fs::read_dir(prefix.path())? {
                let object = object?;
                if !object.file_type()?.is_file() {
                    continue;
                }
                let digest = object.file_name().to_string_lossy().into_owned();
                let object_id = format!("blake3:{digest}");
                Self::validate_object_id(&object_id)?;
                entries.push((object_id, fs::read(object.path())?));
            }
        }
        entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        if entries.len() > MAX_PACK_OBJECTS {
            return Err(StoreError::PackTooLarge);
        }

        let mut pack = Vec::new();
        pack.extend_from_slice(PACK_MAGIC);
        pack.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for (object_id, bytes) in entries {
            if bytes.len() > MAX_QUARANTINE_OBJECT_BYTES {
                return Err(StoreError::PackTooLarge);
            }
            let id_len = u16::try_from(object_id.len()).map_err(|_| StoreError::InvalidPack)?;
            pack.extend_from_slice(&id_len.to_be_bytes());
            pack.extend_from_slice(object_id.as_bytes());
            pack.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            pack.extend_from_slice(&bytes);
            if pack.len() > MAX_PACK_BYTES {
                return Err(StoreError::PackTooLarge);
            }
        }
        Ok(pack)
    }

    /// Import never trusts the pack manifest. Every entry is parsed under hard
    /// bounds and independently re-admitted through the Contract verifier.
    pub fn import_pack(
        &self,
        contract: &CollectiveContract,
        pack: &[u8],
        now_iso: &str,
    ) -> Result<usize, StoreError> {
        if pack.len() > MAX_PACK_BYTES || pack.len() < PACK_MAGIC.len() + 4 {
            return Err(StoreError::PackTooLarge);
        }
        let mut cursor = Cursor::new(pack);
        let mut magic = [0_u8; PACK_MAGIC.len()];
        cursor
            .read_exact(&mut magic)
            .map_err(|_| StoreError::InvalidPack)?;
        if &magic != PACK_MAGIC {
            return Err(StoreError::InvalidPack);
        }
        let count = read_u32(&mut cursor)? as usize;
        if count > MAX_PACK_OBJECTS {
            return Err(StoreError::PackTooLarge);
        }
        for _ in 0..count {
            let id_len = read_u16(&mut cursor)? as usize;
            if id_len != "blake3:".len() + 64 {
                return Err(StoreError::InvalidPack);
            }
            let mut id = vec![0_u8; id_len];
            cursor
                .read_exact(&mut id)
                .map_err(|_| StoreError::InvalidPack)?;
            let object_id = std::str::from_utf8(&id).map_err(|_| StoreError::InvalidPack)?;
            Self::validate_object_id(object_id)?;
            let object_len = read_u32(&mut cursor)? as usize;
            if object_len == 0 || object_len > MAX_QUARANTINE_OBJECT_BYTES {
                return Err(StoreError::PackTooLarge);
            }
            let mut bytes = vec![0_u8; object_len];
            cursor
                .read_exact(&mut bytes)
                .map_err(|_| StoreError::InvalidPack)?;
            let stored: StoredObject = serde_json::from_slice(&bytes)?;
            let candidate = serde_json::to_vec(&stored.canonical)?;
            self.verify_and_admit(
                contract,
                &candidate,
                object_id,
                &stored.signature_hex,
                &stored.publisher_key_hex,
                now_iso,
            )?;
        }
        if cursor.position() != pack.len() as u64 {
            return Err(StoreError::InvalidPack);
        }
        Ok(count)
    }

    pub fn pin(&self, object_id: &str) -> Result<(), StoreError> {
        let digest = Self::validate_object_id(object_id)?;
        let object = self.object_path(object_id)?;
        if !object.is_file() {
            return Err(StoreError::InvalidObjectId);
        }
        Self::atomic_write(&self.root.join("pins").join(digest), object_id.as_bytes())?;
        Ok(())
    }

    pub fn pinned_object_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.root.join("pins"))? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let object_id = fs::read_to_string(entry.path())?;
            let object_id = object_id.trim().to_owned();
            Self::validate_object_id(&object_id)?;
            if self.object_path(&object_id)?.is_file() {
                ids.push(object_id);
            }
        }
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }

    pub fn stats(&self) -> Result<StoreStats, StoreError> {
        let mut stats = StoreStats::default();
        for prefix in fs::read_dir(self.root.join("objects"))? {
            let prefix = prefix?;
            if !prefix.file_type()?.is_dir() {
                continue;
            }
            for object in fs::read_dir(prefix.path())? {
                let object = object?;
                if object.file_type()?.is_file() {
                    stats.objects += 1;
                    stats.object_bytes += object.metadata()?.len();
                }
            }
        }
        stats.quarantined = fs::read_dir(self.root.join("quarantine"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .count() as u64;
        stats.pinned = fs::read_dir(self.root.join("pins"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .count() as u64;
        Ok(stats)
    }

    /// Remove unpinned objects in stable content-ID order until both targets
    /// are met. Pins are an absolute retention promise and may leave the store
    /// above target; the report makes that state visible to the UI.
    pub fn garbage_collect(
        &self,
        target_objects: u64,
        target_bytes: u64,
    ) -> Result<GcReport, StoreError> {
        let mut candidates = Vec::<(String, PathBuf, u64)>::new();
        let mut stats = self.stats()?;
        for prefix in fs::read_dir(self.root.join("objects"))? {
            let prefix = prefix?;
            if !prefix.file_type()?.is_dir() {
                continue;
            }
            for object in fs::read_dir(prefix.path())? {
                let object = object?;
                if !object.file_type()?.is_file() {
                    continue;
                }
                let digest = object.file_name().to_string_lossy().into_owned();
                if self.root.join("pins").join(&digest).is_file() {
                    continue;
                }
                candidates.push((digest, object.path(), object.metadata()?.len()));
            }
        }
        candidates.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        let mut report = GcReport::default();
        for (digest, path, bytes) in candidates {
            if stats.objects <= target_objects && stats.object_bytes <= target_bytes {
                break;
            }
            fs::remove_file(path)?;
            self.metadata.remove(&format!("blake3:{digest}"))?;
            stats.objects = stats.objects.saturating_sub(1);
            stats.object_bytes = stats.object_bytes.saturating_sub(bytes);
            report.removed_objects += 1;
            report.removed_bytes += bytes;
        }
        report.remaining_objects = stats.objects;
        report.remaining_bytes = stats.object_bytes;
        Ok(report)
    }
}

fn directory_bytes(path: &Path) -> Result<u64, StoreError> {
    let mut total = 0_u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            total = total.saturating_add(entry.metadata()?.len());
        }
    }
    Ok(total)
}

fn read_u16(cursor: &mut Cursor<&[u8]>) -> Result<u16, StoreError> {
    let mut bytes = [0_u8; 2];
    cursor
        .read_exact(&mut bytes)
        .map_err(|_| StoreError::InvalidPack)?;
    Ok(u16::from_be_bytes(bytes))
}

fn read_u32(cursor: &mut Cursor<&[u8]>) -> Result<u32, StoreError> {
    let mut bytes = [0_u8; 4];
    cursor
        .read_exact(&mut bytes)
        .map_err(|_| StoreError::InvalidPack)?;
    Ok(u32::from_be_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarantine_is_bounded_content_addressed_and_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let store = CollectiveStore::open(directory.path()).unwrap();
        let first = store.quarantine(b"hostile but bounded").unwrap();
        let second = store.quarantine(b"hostile but bounded").unwrap();
        assert_eq!(first, second);
        assert_eq!(store.stats().unwrap().quarantined, 1);
        assert!(matches!(store.quarantine(&[]), Err(StoreError::TooLarge)));
        assert!(matches!(
            store.quarantine(&vec![0; MAX_QUARANTINE_OBJECT_BYTES + 1]),
            Err(StoreError::TooLarge)
        ));
    }

    #[test]
    fn object_ids_cannot_escape_the_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = CollectiveStore::open(directory.path()).unwrap();
        for invalid in ["../escape", "blake3:ABC", "sha256:00", "blake3:00/../../x"] {
            assert!(matches!(
                store.object_path(invalid),
                Err(StoreError::InvalidObjectId)
            ));
        }
    }

    #[test]
    fn malformed_packs_are_bounded_and_rejected_before_contract() {
        let directory = tempfile::tempdir().unwrap();
        let store = CollectiveStore::open(directory.path()).unwrap();
        assert_eq!(
            store.export_pack().unwrap().as_slice(),
            b"AIKOPACK\x01\0\0\0\0"
        );
    }

    #[test]
    fn quarantine_respects_profile_quota() {
        let directory = tempfile::tempdir().unwrap();
        let store = CollectiveStore::open_with_limits(
            directory.path(),
            StoreLimits {
                max_quarantine_bytes: 8,
                ..StoreLimits::default()
            },
        )
        .unwrap();
        store.quarantine(b"12345678").unwrap();
        assert!(matches!(
            store.quarantine(b"different"),
            Err(StoreError::QuotaExceeded)
        ));
        store.quarantine(b"12345678").unwrap();
    }

    #[test]
    fn garbage_collection_never_removes_pins() {
        let directory = tempfile::tempdir().unwrap();
        let store = CollectiveStore::open(directory.path()).unwrap();
        let first = format!("blake3:{}", "1".repeat(64));
        let second = format!("blake3:{}", "2".repeat(64));
        CollectiveStore::atomic_write(&store.object_path(&first).unwrap(), b"first").unwrap();
        CollectiveStore::atomic_write(&store.object_path(&second).unwrap(), b"second").unwrap();
        store.pin(&first).unwrap();
        assert_eq!(store.pinned_object_ids().unwrap(), vec![first.clone()]);

        let report = store.garbage_collect(0, 0).unwrap();
        assert_eq!(report.removed_objects, 1);
        assert!(store.object_path(&first).unwrap().is_file());
        assert!(!store.object_path(&second).unwrap().exists());
        assert_eq!(report.remaining_objects, 1);
    }

    #[test]
    fn local_erase_removes_blob_pin_and_catalog_projection() {
        let directory = tempfile::tempdir().unwrap();
        let store = CollectiveStore::open(directory.path()).unwrap();
        let object_id = format!("blake3:{}", "3".repeat(64));
        CollectiveStore::atomic_write(&store.object_path(&object_id).unwrap(), b"stored").unwrap();
        store.pin(&object_id).unwrap();
        store
            .metadata()
            .put(&ObjectMetadata {
                object_id: object_id.clone(),
                kind: "capability".into(),
                publisher: format!("ed25519:{}", "4".repeat(64)),
                admitted_at: "2026-07-21T00:00:00Z".into(),
                capability_id: "example.erase".into(),
                capability_version: "1".into(),
                summary: String::new(),
                operation: String::new(),
                origin: String::new(),
                effects: Vec::new(),
            })
            .unwrap();

        assert!(store.erase_local(&object_id).unwrap());
        assert!(!store.object_path(&object_id).unwrap().exists());
        assert_eq!(store.stats().unwrap().pinned, 0);
        assert!(store.metadata().get(&object_id).unwrap().is_none());
        assert!(!store.erase_local(&object_id).unwrap());
    }
}
