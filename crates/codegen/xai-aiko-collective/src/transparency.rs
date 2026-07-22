//! Local witness projection for signed public index roots.
//!
//! Transport remains generic object replication. This module records only
//! bounded root observations and detects publisher/generation equivocation;
//! it never stores task text, invocation data, or credentials.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum TransparencyError {
    #[error("invalid bounded witness observation")]
    InvalidObservation,
    #[error("witness log I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("witness log JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct IndexWitness {
    pub publisher: String,
    pub generation: u64,
    pub root_object_id: String,
    pub witness: String,
    pub observed_at: String,
}

impl IndexWitness {
    pub fn validate(&self) -> Result<(), TransparencyError> {
        validate_witness(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Equivocation {
    pub publisher: String,
    pub generation: u64,
    pub conflicting_roots: Vec<String>,
    pub witnesses: Vec<String>,
}

#[derive(Debug, Default)]
pub struct WitnessProjection {
    observations: BTreeSet<IndexWitness>,
}

impl WitnessProjection {
    /// Admit an observation only after the caller has fetched and Contract-
    /// admitted `root_object_id`. Conflicting signed roots are evidence;
    /// this local witness row is never itself execution authority.
    pub fn observe(&mut self, observation: IndexWitness) -> Result<(), TransparencyError> {
        validate_witness(&observation)?;
        self.observations.insert(observation);
        Ok(())
    }

    pub fn merge(
        &mut self,
        observations: impl IntoIterator<Item = IndexWitness>,
    ) -> Result<(), TransparencyError> {
        for observation in observations {
            self.observe(observation)?;
        }
        Ok(())
    }

    pub fn observations(&self) -> impl Iterator<Item = &IndexWitness> {
        self.observations.iter()
    }

    pub fn equivocations(&self) -> Vec<Equivocation> {
        let mut groups: BTreeMap<(String, u64), (BTreeSet<String>, BTreeSet<String>)> =
            BTreeMap::new();
        for observation in &self.observations {
            let group = groups
                .entry((observation.publisher.clone(), observation.generation))
                .or_default();
            group.0.insert(observation.root_object_id.clone());
            group.1.insert(observation.witness.clone());
        }
        groups
            .into_iter()
            .filter(|(_, (roots, _))| roots.len() > 1)
            .map(
                |((publisher, generation), (roots, witnesses))| Equivocation {
                    publisher,
                    generation,
                    conflicting_roots: roots.into_iter().collect(),
                    witnesses: witnesses.into_iter().collect(),
                },
            )
            .collect()
    }
}

fn is_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_witness(witness: &IndexWitness) -> Result<(), TransparencyError> {
    let valid_publisher = witness.publisher.len() == 72
        && witness.publisher.starts_with("ed25519:")
        && is_hex(&witness.publisher[8..]);
    let valid_root = witness.root_object_id.len() == 71
        && witness.root_object_id.starts_with("blake3:")
        && is_hex(&witness.root_object_id[7..]);
    let valid_witness = !witness.witness.is_empty()
        && witness.witness.len() <= 128
        && witness
            .witness
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte));
    let valid_time = witness.observed_at.len() == 20
        && witness.observed_at.ends_with('Z')
        && witness.observed_at.as_bytes().get(4) == Some(&b'-')
        && witness.observed_at.as_bytes().get(10) == Some(&b'T');
    if valid_publisher && valid_root && valid_witness && valid_time {
        Ok(())
    } else {
        Err(TransparencyError::InvalidObservation)
    }
}

/// Restart-safe deterministic witness projection. The log contains only
/// signed-root identifiers and bounded peer/time metadata, never task or
/// invocation content.
#[derive(Debug, Clone)]
pub struct WitnessLog {
    path: PathBuf,
}

impl WitnessLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<WitnessProjection, TransparencyError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Default::default());
            }
            Err(error) => return Err(error.into()),
        };
        let observations = serde_json::from_slice::<Vec<IndexWitness>>(&bytes)?;
        let mut projection = WitnessProjection::default();
        projection.merge(observations)?;
        Ok(projection)
    }

    pub fn save(&self, projection: &WitnessProjection) -> Result<(), TransparencyError> {
        let parent = self.path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "witness path has no parent",
            )
        })?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".witnesses.{}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| {
            serde_json::to_writer(
                &mut file,
                &projection.observations.iter().collect::<Vec<_>>(),
            )?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            Ok::<(), TransparencyError>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Local execution authority is deliberately narrower than public discovery.
/// There is no public score or witness field in this input, so network evidence
/// cannot manufacture an execution grant.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalExecutionAuthority {
    pub local_adapter_available: bool,
    pub locally_enabled: bool,
    pub permission_granted: bool,
    pub revoked: bool,
}

impl LocalExecutionAuthority {
    pub fn allows_execution(self) -> bool {
        self.local_adapter_available
            && self.locally_enabled
            && self.permission_granted
            && !self.revoked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn witness(root: char, peer: char) -> IndexWitness {
        IndexWitness {
            publisher: format!("ed25519:{}", "1".repeat(64)),
            generation: 9,
            root_object_id: format!("blake3:{}", root.to_string().repeat(64)),
            witness: format!("peer:{}", peer.to_string().repeat(8)),
            observed_at: "2026-07-21T00:00:00Z".into(),
        }
    }

    #[test]
    fn witness_merge_is_idempotent_and_detects_equivocation() {
        let mut projection = WitnessProjection::default();
        projection
            .merge([witness('a', '1'), witness('a', '1'), witness('b', '2')])
            .unwrap();
        assert_eq!(projection.observations().count(), 2);
        let conflicts = projection.equivocations();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].conflicting_roots.len(), 2);
        assert_eq!(conflicts[0].witnesses.len(), 2);
    }

    #[test]
    fn witness_projection_is_restart_safe_and_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let log = WitnessLog::new(directory.path().join("witnesses.json"));
        let mut projection = WitnessProjection::default();
        projection.observe(witness('a', '1')).unwrap();
        log.save(&projection).unwrap();
        assert_eq!(log.load().unwrap().observations().count(), 1);

        let mut invalid = witness('b', '2');
        invalid.witness = "private task text has spaces".into();
        assert!(matches!(
            projection.observe(invalid),
            Err(TransparencyError::InvalidObservation)
        ));
    }

    #[test]
    fn global_discovery_evidence_cannot_grant_execution() {
        let no_local_grant = LocalExecutionAuthority {
            local_adapter_available: false,
            locally_enabled: true,
            permission_granted: true,
            revoked: false,
        };
        assert!(!no_local_grant.allows_execution());
        assert!(
            LocalExecutionAuthority {
                local_adapter_available: true,
                ..no_local_grant
            }
            .allows_execution()
        );
    }
}
