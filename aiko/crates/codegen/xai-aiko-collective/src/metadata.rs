//! Rebuildable local metadata index. Immutable collective bytes remain in the
//! verified blob store; redb contains only machine-local catalog projections.

use redb::{Database, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const OBJECTS: TableDefinition<&str, &[u8]> = TableDefinition::new("collective_objects_v1");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ObjectMetadata {
    pub object_id: String,
    pub kind: String,
    pub publisher: String,
    pub admitted_at: String,
    #[serde(default)]
    pub capability_id: String,
    #[serde(default)]
    pub capability_version: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub operation: String,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub effects: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum MetadataError {
    #[error("collective metadata database failed: {0}")]
    Database(String),
    #[error("collective metadata value is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct MetadataIndex {
    path: PathBuf,
}

impl MetadataIndex {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, MetadataError> {
        let index = Self { path: path.into() };
        let database = Database::create(&index.path)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let write = database
            .begin_write()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        {
            write
                .open_table(OBJECTS)
                .map_err(|error| MetadataError::Database(error.to_string()))?;
        }
        write
            .commit()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        Ok(index)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn put(&self, metadata: &ObjectMetadata) -> Result<(), MetadataError> {
        let database = Database::create(&self.path)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let write = database
            .begin_write()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        {
            let mut table = write
                .open_table(OBJECTS)
                .map_err(|error| MetadataError::Database(error.to_string()))?;
            let bytes = serde_json::to_vec(metadata)?;
            table
                .insert(metadata.object_id.as_str(), bytes.as_slice())
                .map_err(|error| MetadataError::Database(error.to_string()))?;
        }
        write
            .commit()
            .map_err(|error| MetadataError::Database(error.to_string()))
    }

    pub fn get(&self, object_id: &str) -> Result<Option<ObjectMetadata>, MetadataError> {
        let database = Database::create(&self.path)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let read = database
            .begin_read()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let table = read
            .open_table(OBJECTS)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let value = table
            .get(object_id)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        value
            .map(|bytes| serde_json::from_slice(bytes.value()).map_err(MetadataError::from))
            .transpose()
    }

    pub fn remove(&self, object_id: &str) -> Result<bool, MetadataError> {
        let database = Database::create(&self.path)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let write = database
            .begin_write()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let removed = {
            let mut table = write
                .open_table(OBJECTS)
                .map_err(|error| MetadataError::Database(error.to_string()))?;
            table
                .remove(object_id)
                .map_err(|error| MetadataError::Database(error.to_string()))?
                .is_some()
        };
        write
            .commit()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        Ok(removed)
    }

    pub fn all(&self) -> Result<Vec<ObjectMetadata>, MetadataError> {
        let database = Database::create(&self.path)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let read = database
            .begin_read()
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let table = read
            .open_table(OBJECTS)
            .map_err(|error| MetadataError::Database(error.to_string()))?;
        let mut result = Vec::new();
        for entry in table
            .iter()
            .map_err(|error| MetadataError::Database(error.to_string()))?
        {
            let (_, value) = entry.map_err(|error| MetadataError::Database(error.to_string()))?;
            result.push(serde_json::from_slice(value.value())?);
        }
        result
            .sort_unstable_by(|left: &ObjectMetadata, right| left.object_id.cmp(&right.object_id));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_typed_and_reopenable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.redb");
        let index = MetadataIndex::open(&path).unwrap();
        let metadata = ObjectMetadata {
            object_id: format!("blake3:{}", "a".repeat(64)),
            kind: "capability".into(),
            publisher: format!("ed25519:{}", "b".repeat(64)),
            admitted_at: "2026-07-21T00:00:00Z".into(),
            capability_id: "unbrowse.search".into(),
            capability_version: "1".into(),
            summary: "Search public routes".into(),
            operation: "search".into(),
            origin: "example.test".into(),
            effects: vec!["read_only".into()],
        };
        index.put(&metadata).unwrap();
        drop(index);
        let reopened = MetadataIndex::open(&path).unwrap();
        assert_eq!(reopened.get(&metadata.object_id).unwrap(), Some(metadata));
        assert_eq!(reopened.all().unwrap().len(), 1);
    }
}
