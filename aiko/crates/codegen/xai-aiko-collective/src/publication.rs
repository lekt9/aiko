use crate::contract_bridge::{CollectiveContract, CollectiveError, PublicationVerdict};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PublicationMode {
    #[default]
    Disabled,
    SafePublicShapes,
    ReviewEveryObject,
}

/// Local participation is an independent kill switch. Keeping it separate
/// from publication mode prevents a future transport from interpreting a
/// permissive publication policy as permission to open sockets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, deny_unknown_fields)]
pub struct PublicationSettings {
    pub participation_enabled: bool,
    pub mode: PublicationMode,
    /// Separately opt in to privacy-bucketed outcome attestations. Publishing
    /// capability shapes never implicitly enables execution evidence sharing.
    pub publish_aggregate_attestations: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PublicationIoError {
    #[error("publication settings I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("publication settings are invalid: {0}")]
    Json(#[from] serde_json::Error),
}

impl PublicationSettings {
    pub fn load(path: &Path) -> Result<Self, PublicationIoError> {
        let bytes = fs::read(path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Persist settings atomically. New profiles remain fully offline because
    /// `Default` disables both participation and publication.
    pub fn save(&self, path: &Path) -> Result<(), PublicationIoError> {
        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "settings path has no parent",
            )
        })?;
        fs::create_dir_all(parent)?;
        let temp = parent.join(format!(".collective-settings.{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(self)?;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temp, path)?;
            Ok::<_, std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicationAuditAction {
    Previewed,
    Approved,
    Rejected,
    Revoked,
    Erased,
    ParticipationChanged,
    PublicationModeChanged,
    EvidenceSharingChanged,
}

/// Deliberately excludes descriptors, prompts, paths, request/response bodies,
/// credentials, and peer addresses. It is safe metadata about a local choice,
/// not an execution transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublicationAuditEvent {
    pub timestamp: String,
    pub action: PublicationAuditAction,
    pub object_id: Option<String>,
    pub allowed: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PublicationAuditLog {
    path: PathBuf,
}

impl PublicationAuditLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn append(&self, event: &PublicationAuditEvent) -> Result<(), PublicationIoError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(event)?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(())
    }

    pub fn read_all(&self) -> Result<Vec<PublicationAuditEvent>, PublicationIoError> {
        match OpenOptions::new().read(true).open(&self.path) {
            Ok(file) => BufReader::new(file)
                .lines()
                .filter(|line| line.as_ref().map_or(true, |line| !line.trim().is_empty()))
                .map(|line| Ok(serde_json::from_str(&line?)?))
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PublicationPreview {
    pub mode: PublicationMode,
    pub publish_allowed: bool,
    pub requires_review: bool,
    pub verdict: PublicationVerdict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PublicationReviewItem {
    pub object_id: String,
    pub candidate: serde_json::Value,
    pub queued_at: String,
}

#[derive(Debug, Clone)]
pub struct PublicationReviewQueue {
    root: PathBuf,
}

impl PublicationReviewQueue {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, object_id: &str) -> Result<PathBuf, PublicationIoError> {
        let digest = object_id.strip_prefix("blake3:").filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        digest.map(|digest| self.root.join(digest)).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid review object id").into()
        })
    }

    pub fn enqueue(&self, item: &PublicationReviewItem) -> Result<(), PublicationIoError> {
        let path = self.path(&item.object_id)?;
        fs::create_dir_all(&self.root)?;
        let bytes = serde_json::to_vec(item)?;
        if bytes.is_empty() || bytes.len() > 256 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "review item exceeds its bound",
            )
            .into());
        }
        if path.exists() {
            return Ok(());
        }
        let temporary = self
            .root
            .join(format!(".review.{}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, path)?;
            Ok::<(), std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<PublicationReviewItem>, PublicationIoError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut items = Vec::new();
        for entry in entries.take(4_096) {
            let entry = entry?;
            if !entry.file_type()?.is_file() || entry.metadata()?.len() > 256 * 1024 {
                continue;
            }
            let item: PublicationReviewItem = serde_json::from_slice(&fs::read(entry.path())?)?;
            self.path(&item.object_id)?;
            items.push(item);
        }
        items.sort_unstable_by(|left, right| left.object_id.cmp(&right.object_id));
        Ok(items)
    }

    pub fn get(&self, object_id: &str) -> Result<PublicationReviewItem, PublicationIoError> {
        Ok(serde_json::from_slice(&fs::read(self.path(object_id)?)?)?)
    }

    pub fn remove(&self, object_id: &str) -> Result<bool, PublicationIoError> {
        match fs::remove_file(self.path(object_id)?) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PublicationController {
    mode: PublicationMode,
}

impl PublicationController {
    pub fn new(mode: PublicationMode) -> Self {
        Self { mode }
    }

    pub fn mode(self) -> PublicationMode {
        self.mode
    }

    /// Preview policy only. This function never signs, stores, announces, or
    /// executes a capability.
    pub fn preview(
        self,
        contract: &CollectiveContract,
        candidate: &[u8],
    ) -> Result<PublicationPreview, CollectiveError> {
        let verdict = contract.publication_verdict(candidate)?;
        let contract_publishable = verdict.verdict == "publishable";
        let (publish_allowed, requires_review) = match self.mode {
            PublicationMode::Disabled => (false, false),
            PublicationMode::SafePublicShapes => (contract_publishable, !contract_publishable),
            PublicationMode::ReviewEveryObject => (false, true),
        };
        Ok(PublicationPreview {
            mode: self.mode,
            publish_allowed,
            requires_review,
            verdict,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_is_disabled_by_default() {
        assert_eq!(PublicationMode::default(), PublicationMode::Disabled);
        assert_eq!(
            PublicationController::new(PublicationMode::Disabled).mode(),
            PublicationMode::Disabled
        );
    }

    #[test]
    fn settings_round_trip_and_default_offline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let settings = PublicationSettings::default();
        assert!(!settings.participation_enabled);
        assert!(!settings.publish_aggregate_attestations);
        assert_eq!(settings.mode, PublicationMode::Disabled);
        settings.save(&path).unwrap();
        assert_eq!(PublicationSettings::load(&path).unwrap(), settings);
    }

    #[test]
    fn audit_log_contains_only_bounded_decision_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let log = PublicationAuditLog::new(directory.path().join("publication.jsonl"));
        let event = PublicationAuditEvent {
            timestamp: "2026-07-21T00:00:00Z".into(),
            action: PublicationAuditAction::Rejected,
            object_id: None,
            allowed: false,
            reason_codes: vec!["credential_like_value".into()],
        };
        log.append(&event).unwrap();
        assert_eq!(log.read_all().unwrap(), vec![event]);
        let raw = fs::read_to_string(directory.path().join("publication.jsonl")).unwrap();
        assert!(!raw.contains("descriptor"));
        assert!(!raw.contains("request_body"));
    }

    #[test]
    fn review_queue_is_bounded_restart_safe_and_path_safe() {
        let directory = tempfile::tempdir().unwrap();
        let queue = PublicationReviewQueue::new(directory.path().join("review"));
        let item = PublicationReviewItem {
            object_id: format!("blake3:{}", "a".repeat(64)),
            candidate: serde_json::json!({"kind":"capability"}),
            queued_at: "2026-07-21T00:00:00Z".into(),
        };
        queue.enqueue(&item).unwrap();
        queue.enqueue(&item).unwrap();
        assert_eq!(queue.list().unwrap(), vec![item.clone()]);
        assert_eq!(queue.get(&item.object_id).unwrap(), item);
        assert!(queue.remove(&item.object_id).unwrap());
        assert!(!queue.remove(&item.object_id).unwrap());
        assert!(queue.get("../escape").is_err());
    }
}
