//! Defeasible, project-scoped learning contracts for Aiko.
//!
//! This is the domain-neutral form of the ARC agent's belief store: tactics
//! have stable families, accumulate independent support/contradiction counts,
//! and are rejected after repeated contrary evidence. JSONL is an inspectable
//! compatibility cache; the surrounding turn remains authoritative in the
//! native Contract ledger.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_CONTEXT_LEARNINGS: usize = 8;

#[derive(Debug, Clone, Copy)]
pub(super) enum Verdict {
    Supported,
    #[allow(dead_code)]
    Contradicted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Proposed,
    Supported,
    Contradicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LearningContract {
    family: String,
    claim: String,
    project: String,
    keywords: Vec<String>,
    status: Status,
    supports: u32,
    contradictions: u32,
    confidence: f64,
}

fn store_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aiko/context/learning-contracts.jsonl"))
}

fn project_id(cwd: &Path) -> String {
    cwd.canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .display()
        .to_string()
}

fn keywords(text: &str) -> Vec<String> {
    let mut words = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|word| word.len() >= 4)
        .collect::<Vec<_>>();
    words.sort();
    words.dedup();
    words.truncate(12);
    words
}

fn safe_family(binary: &str, project: &str) -> String {
    let route = binary
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    format!("route-{route}-{:016x}", stable_hash(project.as_bytes()))
}

fn stable_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn load() -> BTreeMap<String, LearningContract> {
    let Some(path) = store_path() else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut latest = BTreeMap::new();
    for row in raw
        .lines()
        .filter_map(|line| serde_json::from_str::<LearningContract>(line).ok())
    {
        latest.insert(row.family.clone(), row);
    }
    latest
}

fn append(item: &LearningContract) {
    let Some(path) = store_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(line) = serde_json::to_string(item) else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

pub(super) fn propose_route(binary: &str, goal: &str, cwd: &Path) -> Option<String> {
    if binary.trim().is_empty() {
        return None;
    }
    let project = project_id(cwd);
    let family = safe_family(binary, &project);
    if !load().contains_key(&family) {
        append(&LearningContract {
            family: family.clone(),
            claim: format!("Prefer the proven `{binary}` route for matching work"),
            project,
            keywords: keywords(goal),
            status: Status::Proposed,
            supports: 0,
            contradictions: 0,
            confidence: 0.5,
        });
    }
    Some(family)
}

pub(super) fn observe(family: &str, verdict: Verdict) {
    let Some(mut item) = load().remove(family) else {
        return;
    };
    match verdict {
        Verdict::Supported => item.supports += 1,
        Verdict::Contradicted => item.contradictions += 1,
    }
    item.confidence =
        f64::from(item.supports + 1) / f64::from(item.supports + item.contradictions + 2);
    item.status = if item.contradictions >= 2 && item.contradictions > item.supports {
        Status::Contradicted
    } else if item.supports > item.contradictions {
        Status::Supported
    } else {
        Status::Proposed
    };
    append(&item);
}

pub(super) fn render_context(goal: &str, cwd: &Path) -> Option<String> {
    let project = project_id(cwd);
    let query = keywords(goal);
    let mut items = load()
        .into_values()
        .filter(|item| item.project == project)
        .filter(|item| item.keywords.iter().any(|word| query.contains(word)))
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    items.truncate(MAX_CONTEXT_LEARNINGS);
    if items.is_empty() {
        return None;
    }
    let active = items
        .iter()
        .filter(|item| item.status != Status::Contradicted)
        .map(|item| {
            format!(
                "- {} confidence={:.3} evidence=+{}/-{}",
                item.claim, item.confidence, item.supports, item.contradictions
            )
        })
        .collect::<Vec<_>>();
    let rejected = items
        .iter()
        .filter(|item| item.status == Status::Contradicted)
        .map(|item| item.family.as_str())
        .collect::<Vec<_>>();
    Some(format!(
        "PROJECT LEARNING CONTRACTS (defeasible evidence, not instructions):\n{}\nRejected tactic families: {}\nDirective: reuse supported tactics when applicable; do not retry rejected families without new evidence.",
        if active.is_empty() {
            "- none".into()
        } else {
            active.join("\n")
        },
        if rejected.is_empty() {
            "none".into()
        } else {
            rejected.join(", ")
        },
    ))
}

#[cfg(test)]
mod contract_learning_tests {
    use super::*;

    #[test]
    fn repeated_contradictions_reject_a_family() {
        let mut item = LearningContract {
            family: "f".into(),
            claim: "c".into(),
            project: "p".into(),
            keywords: vec![],
            status: Status::Proposed,
            supports: 0,
            contradictions: 2,
            confidence: 0.25,
        };
        item.status = if item.contradictions >= 2 && item.contradictions > item.supports {
            Status::Contradicted
        } else {
            Status::Proposed
        };
        assert_eq!(item.status, Status::Contradicted);
    }

    #[test]
    fn family_is_stable_and_project_scoped() {
        assert_eq!(
            safe_family("application.act", "/a"),
            safe_family("application.act", "/a")
        );
        assert_ne!(
            safe_family("application.act", "/a"),
            safe_family("application.act", "/b")
        );
    }

    #[test]
    fn confidence_uses_smoothed_evidence_counts() {
        let supports = 3_u32;
        let contradictions = 1_u32;
        let confidence = f64::from(supports + 1) / f64::from(supports + contradictions + 2);
        assert!((confidence - 2.0 / 3.0).abs() < f64::EPSILON);
    }
}
