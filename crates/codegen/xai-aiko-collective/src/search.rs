//! Rebuildable local lexical retrieval. Task text is evaluated only against
//! downloaded local metadata; it is never sent to the DHT or arbitrary peers.

use crate::MetadataIndex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, STORED, STRING, Schema, TEXT, TantivyDocument, Value};
use tantivy::{Index, IndexReader, Term};

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("local collective index failed: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("local collective metadata failed: {0}")]
    Metadata(#[from] crate::MetadataError),
    #[error("local collective index I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHit {
    pub object_id: String,
    pub semantic_score_bps: u16,
}

pub struct LocalSearchIndex {
    path: PathBuf,
    index: Index,
    reader: IndexReader,
    object_id: Field,
    searchable: Vec<Field>,
}

fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("object_id", STRING | STORED);
    builder.add_text_field("capability_id", TEXT);
    builder.add_text_field("summary", TEXT);
    builder.add_text_field("operation", TEXT);
    builder.add_text_field("origin", TEXT);
    builder.add_text_field("effects", TEXT);
    builder.build()
}

impl LocalSearchIndex {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SearchError> {
        let path = path.into();
        std::fs::create_dir_all(&path)?;
        let index = if path.join("meta.json").is_file() {
            Index::open_in_dir(&path)?
        } else {
            Index::create_in_dir(&path, schema())?
        };
        let schema = index.schema();
        let object_id = schema.get_field("object_id")?;
        let searchable = ["capability_id", "summary", "operation", "origin", "effects"]
            .iter()
            .map(|name| schema.get_field(name))
            .collect::<Result<Vec<_>, _>>()?;
        let reader = index.reader()?;
        Ok(Self {
            path,
            index,
            reader,
            object_id,
            searchable,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn rebuild(&mut self, metadata: &MetadataIndex) -> Result<usize, SearchError> {
        let records = metadata.all()?;
        let schema = self.index.schema();
        let capability_id = schema.get_field("capability_id")?;
        let summary = schema.get_field("summary")?;
        let operation = schema.get_field("operation")?;
        let origin = schema.get_field("origin")?;
        let effects = schema.get_field("effects")?;
        let mut writer: tantivy::IndexWriter<TantivyDocument> = self.index.writer(20_000_000)?;
        writer.delete_all_documents()?;
        for record in &records {
            let mut document = TantivyDocument::default();
            document.add_text(self.object_id, &record.object_id);
            document.add_text(capability_id, &record.capability_id);
            document.add_text(summary, &record.summary);
            document.add_text(operation, &record.operation);
            document.add_text(origin, &record.origin);
            document.add_text(effects, record.effects.join(" "));
            writer.add_document(document)?;
        }
        writer.commit()?;
        self.reader.reload()?;
        Ok(records.len())
    }

    pub fn remove(&mut self, object_id: &str) -> Result<(), SearchError> {
        let mut writer: tantivy::IndexWriter<TantivyDocument> = self.index.writer(20_000_000)?;
        writer.delete_term(Term::from_field_text(self.object_id, object_id));
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    pub fn query(&self, task: &str, limit: usize) -> Result<Vec<SearchHit>, SearchError> {
        if task.trim().is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let parser = QueryParser::for_index(&self.index, self.searchable.clone());
        let (query, _) = parser.parse_query_lenient(task);
        let searcher = self.reader.searcher();
        let matches = searcher.search(&query, &TopDocs::with_limit(limit).order_by_score())?;
        let max_score = matches.first().map(|(score, _)| *score).unwrap_or(0.0);
        let mut hits = Vec::with_capacity(matches.len());
        for (score, address) in matches {
            let document: TantivyDocument = searcher.doc(address)?;
            let Some(object_id) = document
                .get_first(self.object_id)
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let normalized = if max_score > 0.0 {
                ((score / max_score) * 10_000.0)
                    .round()
                    .clamp(0.0, 10_000.0) as u16
            } else {
                0
            };
            hits.push(SearchHit {
                object_id: object_id.to_owned(),
                semantic_score_bps: normalized,
            });
        }
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ObjectMetadata;

    #[test]
    fn local_query_uses_only_rebuildable_public_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let metadata = MetadataIndex::open(directory.path().join("catalog.redb")).unwrap();
        metadata
            .put(&ObjectMetadata {
                object_id: format!("blake3:{}", "a".repeat(64)),
                kind: "capability".into(),
                publisher: format!("ed25519:{}", "b".repeat(64)),
                admitted_at: "2026-07-21T00:00:00Z".into(),
                capability_id: "unbrowse.packages.search".into(),
                capability_version: "1".into(),
                summary: "Search public package metadata".into(),
                operation: "search".into(),
                origin: "registry.example".into(),
                effects: vec!["network_read".into(), "read_only".into()],
            })
            .unwrap();
        let mut search = LocalSearchIndex::open(directory.path().join("search")).unwrap();
        assert_eq!(search.rebuild(&metadata).unwrap(), 1);
        let hits = search.query("package registry", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].semantic_score_bps, 10_000);
    }
}
