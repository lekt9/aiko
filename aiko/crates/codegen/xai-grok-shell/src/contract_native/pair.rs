//! Paired contracts: every work contract gets a witness contract that
//! mechanically re-runs its check. Like `await Promise.all([build, verify])`.
//!
//! ## Pattern
//!
//! ```text
//! contract pair "add codex login" --check "~/bin/aiko login codex 2>&1 | grep auth.openai.com"
//!   → work:    abc123 "add codex login"
//!   → witness: def456 "witness: add codex login"
//!
//! contract pair verify abc123
//!   → abc123: check passes → satisfied
//!   → def456: check passes → satisfied
//! ```
//!
//! The witness contract:
//! - Has the same `--check` as the work contract
//! - Is tagged as a witness (prefix `witness:` in the goal)
//! - Is independently verifiable (anyone can run `contract task verify <witness_id>`)
//! - Survives cache refreshes (pairing stored on disk)

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

/// A paired contract: one work task, one witness task.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContractPair {
    pub work_id: String,
    pub witness_id: String,
    pub goal: String,
    pub check: String,
}

/// On-disk pairing store: `~/.aiko/contract_pairs.json`.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct PairStore {
    /// work_id → ContractPair
    pairs: HashMap<String, ContractPair>,
}

/// Write a paired contract store to disk.
fn pair_store_path() -> PathBuf {
    crate::util::grok_home::grok_home().join("contract_pairs.json")
}

fn load_store() -> PairStore {
    let path = pair_store_path();
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => PairStore::default(),
    }
}

fn save_store(store: &PairStore) {
    let path = pair_store_path();
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = std::fs::write(&path, json);
    }
}

/// Invoke the `contract` CLI binary. Returns (stdout, stderr, exit_code).
fn contract(args: &[&str]) -> std::io::Result<(String, String, i32)> {
    let output = Command::new("contract").args(args).output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(-1);
    Ok((stdout, stderr, exit_code))
}

/// Parse a task id from contract CLI output. The contract binary prints
/// the id on its own line after "open:" or "Task registered:".
fn extract_task_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(id) = trimmed.strip_prefix("open:") {
            return Some(id.trim().to_string());
        }
        // Also try digits-only (some versions print bare id)
        if trimmed.len() == 8 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Create a paired contract: one work task + one witness task.
///
/// Returns the pair on success, or an error string.
pub fn create_pair(goal: &str, check: &str) -> Result<ContractPair, String> {
    // 1. Create the work contract
    let (stdout, stderr, code) = contract(&["task", "begin", goal, "--check", check])
        .map_err(|e| format!("failed to run contract: {e}"))?;

    if code != 0 {
        return Err(format!(
            "work contract failed (exit {code}): {stderr}"
        ));
    }

    let work_id = extract_task_id(&stdout)
        .ok_or_else(|| format!("could not parse work task id from: {stdout}"))?;

    eprintln!("work:    {work_id} \"{goal}\"");

    // 2. Create the witness contract with the same check
    let witness_goal = format!("witness: {goal}");
    let (wstdout, wstderr, wcode) =
        contract(&["task", "begin", &witness_goal, "--check", check])
            .map_err(|e| format!("failed to run contract witness: {e}"))?;

    if wcode != 0 {
        return Err(format!(
            "witness contract failed (exit {wcode}): {wstderr}"
        ));
    }

    let witness_id = extract_task_id(&wstdout)
        .ok_or_else(|| format!("could not parse witness task id from: {wstdout}"))?;

    eprintln!("witness: {witness_id} \"{witness_goal}\"");

    // 3. Persist the pair
    let pair = ContractPair {
        work_id: work_id.clone(),
        witness_id: witness_id.clone(),
        goal: goal.to_string(),
        check: check.to_string(),
    };

    let mut store = load_store();
    store.pairs.insert(work_id.clone(), pair.clone());
    save_store(&store);

    Ok(pair)
}

/// Verify both contracts in a pair (work + witness).
/// Returns (work_satisfied, witness_satisfied, summary).
pub fn verify_pair(work_id: &str) -> Result<(bool, bool, String), String> {
    let store = load_store();
    let pair = store
        .pairs
        .get(work_id)
        .ok_or_else(|| format!("no pair found for work_id '{work_id}'"))?;

    let mut results = Vec::new();
    let mut work_ok = true;
    let mut witness_ok = true;

    for (label, id, flag) in [
        ("work", &pair.work_id, &mut work_ok),
        ("witness", &pair.witness_id, &mut witness_ok),
    ] {
        let (_stdout, stderr, code) = contract(&["task", "verify", id])
            .map_err(|e| format!("failed to verify {label} contract {id}: {e}"))?;

        let ok = code == 0;
        if !ok {
            *flag = false;
        }
        let status = if ok { "satisfied" } else { "FAILED" };
        results.push(format!("{label}: {id} — {status}"));
        if !stderr.is_empty() {
            results.push(format!("  {stderr}"));
        }
    }

    Ok((work_ok, witness_ok, results.join("\n")))
}

/// List all paired contracts.
pub fn list_pairs() -> Vec<ContractPair> {
    let store = load_store();
    store.pairs.into_values().collect()
}

/// Get the pair for a work_id, if it exists.
pub fn get_pair(work_id: &str) -> Option<ContractPair> {
    let store = load_store();
    store.pairs.get(work_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_task_id_from_open_line() {
        let stdout = "some output\nopen: abc12345\nmore output";
        assert_eq!(extract_task_id(stdout), Some("abc12345".to_string()));
    }

    #[test]
    fn test_extract_task_id_hex_digit() {
        let stdout = "a1b2c3d4";
        assert_eq!(extract_task_id(stdout), Some("a1b2c3d4".to_string()));
    }

    #[test]
    fn test_extract_task_id_none() {
        assert_eq!(extract_task_id("no id here"), None);
    }

    #[test]
    fn test_pair_store_roundtrip() {
        // Use a temp path for testing
        let dir = tempfile::tempdir().unwrap();
        // (We can't override grok_home in tests easily, so this is a
        // structural test — the store serialize/deserialize roundtrips.)

        let mut store = PairStore::default();
        let pair = ContractPair {
            work_id: "work-1".into(),
            witness_id: "wit-1".into(),
            goal: "test goal".into(),
            check: "echo ok".into(),
        };
        store.pairs.insert("work-1".into(), pair.clone());

        let json = serde_json::to_string(&store).unwrap();
        let restored: PairStore = serde_json::from_str(&json).unwrap();
        let restored_pair = restored.pairs.get("work-1").unwrap();
        assert_eq!(restored_pair.work_id, "work-1");
        assert_eq!(restored_pair.witness_id, "wit-1");
        assert_eq!(restored_pair.goal, "test goal");
        assert_eq!(restored_pair.check, "echo ok");
    }

    #[test]
    fn test_get_pair_missing_returns_none() {
        // With no store file on disk, all lookups return None
        let store = load_store();
        assert!(store.pairs.is_empty());
    }
}
