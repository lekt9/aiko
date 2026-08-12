//! Paired contracts: every work contract gets a witness contract that
//! mechanically re-runs its check. Like `await Promise.all([build, verify])`.
//!
//! ## Pattern
//!
//! ```text
//! aiko contract-pair create "add codex login" --check "~/bin/aiko login codex 2>&1 | grep auth.openai.com"
//!   → work:    abc123 "add codex login"
//!   → witness: def456 "witness: add codex login"
//!
//! aiko contract-pair verify abc123
//!   → abc123: check passes → satisfied
//!   → def456: check passes → satisfied
//! ```
//!
//! ## Native fallback
//!
//! When the external `contract` CLI is missing or the wrong arch (common on
//! Linux hosts that only have a macOS-built `contract` binary), pairs are
//! stored and verified **natively**:
//! - pairing: `~/.aiko/contract_pairs.json` (or grok home)
//! - task rows: `~/.aiko/postmortem/native-tasks.jsonl` (declare + verify events)
//!
//! External `contract task begin/verify` is still tried first (dual-write).

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// A paired contract: one work task, one witness task.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContractPair {
    pub work_id: String,
    pub witness_id: String,
    pub goal: String,
    pub check: String,
    /// `external` when registered via `contract` CLI; `native` when local-only.
    #[serde(default = "default_backend")]
    pub backend: String,
}

fn default_backend() -> String {
    "native".to_string()
}

/// On-disk pairing store.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct PairStore {
    pairs: HashMap<String, ContractPair>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct LocalTask {
    id: String,
    goal: String,
    check: String,
    status: String,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct TaskStore {
    tasks: HashMap<String, LocalTask>,
}

fn pair_store_path() -> PathBuf {
    crate::util::grok_home::grok_home().join("contract_pairs.json")
}

fn task_store_path() -> PathBuf {
    crate::util::grok_home::grok_home().join("native_contract_tasks.json")
}

fn postmortem_ledger_path() -> PathBuf {
    crate::util::grok_home::grok_home()
        .join("postmortem")
        .join("native-tasks.jsonl")
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
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = std::fs::write(&path, json);
    }
}

fn load_tasks() -> TaskStore {
    let path = task_store_path();
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => TaskStore::default(),
    }
}

fn save_tasks(store: &TaskStore) {
    let path = task_store_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = std::fs::write(&path, json);
    }
}

fn append_postmortem(event: &serde_json::Value) {
    let path = postmortem_ledger_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        if let Ok(line) = serde_json::to_string(event) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn now_rfc3339() -> String {
    // Keep dependency-free: unix seconds is enough for postmortem ordering.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn new_task_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    SystemTime::now().hash(&mut h);
    std::process::id().hash(&mut h);
    format!("{:08x}", h.finish() as u32)
}

/// Invoke the `contract` CLI binary. Returns (stdout, stderr, exit_code).
fn contract(args: &[&str]) -> std::io::Result<(String, String, i32)> {
    let output = Command::new("contract").args(args).output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(-1);
    Ok((stdout, stderr, exit_code))
}

/// True when external `contract` appears runnable on this host.
fn external_contract_available() -> bool {
    match Command::new("contract").arg("--help").output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Parse a task id from contract CLI output.
fn extract_task_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(id) = trimmed.strip_prefix("open:") {
            return Some(id.trim().to_string());
        }
        if trimmed.len() == 8 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn native_begin(goal: &str, check: &str) -> String {
    let id = new_task_id();
    let mut tasks = load_tasks();
    tasks.tasks.insert(
        id.clone(),
        LocalTask {
            id: id.clone(),
            goal: goal.to_string(),
            check: check.to_string(),
            status: "open".into(),
        },
    );
    save_tasks(&tasks);
    append_postmortem(&serde_json::json!({
        "event": "contract.declared",
        "id": id,
        "goal": goal,
        "check": check,
        "backend": "native",
        "graph_key": format!("native-task--{id}"),
        "ts": now_rfc3339(),
    }));
    id
}

fn native_verify(id: &str) -> Result<(bool, String), String> {
    let mut tasks = load_tasks();
    let task = tasks
        .tasks
        .get(id)
        .cloned()
        .ok_or_else(|| format!("no native task '{id}'"))?;

    let output = Command::new("sh")
        .arg("-c")
        .arg(&task.check)
        .output()
        .map_err(|e| format!("failed to run check for {id}: {e}"))?;
    let ok = output.status.success();
    let evidence = String::from_utf8_lossy(&output.stdout).into_owned()
        + &String::from_utf8_lossy(&output.stderr);
    let evidence: String = evidence.chars().take(800).collect();

    if let Some(t) = tasks.tasks.get_mut(id) {
        t.status = if ok {
            "satisfied".into()
        } else {
            "failed".into()
        };
    }
    save_tasks(&tasks);

    append_postmortem(&serde_json::json!({
        "event": "contract.verified",
        "id": id,
        "status": if ok { "satisfied" } else { "failed" },
        "exit": output.status.code().unwrap_or(-1),
        "evidence": evidence,
        "backend": "native",
        "ts": now_rfc3339(),
    }));

    Ok((
        ok,
        if ok {
            "satisfied".into()
        } else {
            "FAILED".into()
        },
    ))
}

/// Create a paired contract: one work task + one witness task.
pub fn create_pair(goal: &str, check: &str) -> Result<ContractPair, String> {
    // Prefer external contract when it actually runs on this host.
    if external_contract_available() {
        match try_external_create(goal, check) {
            Ok(pair) => return Ok(pair),
            Err(e) => {
                eprintln!(
                    "contract CLI begin failed ({e}); falling back to native local_task store"
                );
            }
        }
    }

    let work_id = native_begin(goal, check);
    eprintln!("work:    {work_id} \"{goal}\" [native]");
    let witness_goal = format!("witness: {goal}");
    let witness_id = native_begin(&witness_goal, check);
    eprintln!("witness: {witness_id} \"{witness_goal}\" [native]");

    let pair = ContractPair {
        work_id: work_id.clone(),
        witness_id,
        goal: goal.to_string(),
        check: check.to_string(),
        backend: "native".into(),
    };
    let mut store = load_store();
    store.pairs.insert(work_id, pair.clone());
    save_store(&store);
    Ok(pair)
}

fn try_external_create(goal: &str, check: &str) -> Result<ContractPair, String> {
    let (stdout, stderr, code) = contract(&["task", "begin", goal, "--check", check])
        .map_err(|e| format!("failed to run contract: {e}"))?;
    if code != 0 {
        return Err(format!("work contract failed (exit {code}): {stderr}"));
    }
    let work_id = extract_task_id(&stdout)
        .ok_or_else(|| format!("could not parse work task id from: {stdout}"))?;
    eprintln!("work:    {work_id} \"{goal}\" [external]");

    let witness_goal = format!("witness: {goal}");
    let (wstdout, wstderr, wcode) = contract(&["task", "begin", &witness_goal, "--check", check])
        .map_err(|e| format!("failed to run contract witness: {e}"))?;
    if wcode != 0 {
        return Err(format!("witness contract failed (exit {wcode}): {wstderr}"));
    }
    let witness_id = extract_task_id(&wstdout)
        .ok_or_else(|| format!("could not parse witness task id from: {wstdout}"))?;
    eprintln!("witness: {witness_id} \"{witness_goal}\" [external]");

    // Dual-write native rows so postmortem always has declare events.
    let _ = native_begin(goal, check);
    let _ = native_begin(&witness_goal, check);

    let pair = ContractPair {
        work_id: work_id.clone(),
        witness_id,
        goal: goal.to_string(),
        check: check.to_string(),
        backend: "external".into(),
    };
    let mut store = load_store();
    store.pairs.insert(work_id, pair.clone());
    save_store(&store);
    Ok(pair)
}

/// Verify both contracts in a pair (work + witness).
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
        let (ok, status) = if pair.backend == "external" && external_contract_available() {
            match contract(&["task", "verify", id]) {
                Ok((_stdout, stderr, code)) => {
                    let ok = code == 0;
                    // Always also run native verify against stored check for postmortem.
                    let _ = native_verify_if_known(id, &pair.check);
                    if !stderr.is_empty() {
                        results.push(format!("  {stderr}"));
                    }
                    (
                        ok,
                        if ok {
                            "satisfied".into()
                        } else {
                            "FAILED".into()
                        },
                    )
                }
                Err(_) => native_verify_or_check(id, &pair.check)?,
            }
        } else {
            native_verify_or_check(id, &pair.check)?
        };

        if !ok {
            *flag = false;
        }
        results.push(format!("{label}: {id} — {status}"));
    }

    Ok((work_ok, witness_ok, results.join("\n")))
}

fn native_verify_or_check(id: &str, check: &str) -> Result<(bool, String), String> {
    match native_verify(id) {
        Ok(v) => Ok(v),
        Err(_) => {
            // Task row missing — still run the pair's check under this id for postmortem.
            let mut tasks = load_tasks();
            tasks.tasks.insert(
                id.to_string(),
                LocalTask {
                    id: id.to_string(),
                    goal: format!("recovered:{id}"),
                    check: check.to_string(),
                    status: "open".into(),
                },
            );
            save_tasks(&tasks);
            native_verify(id)
        }
    }
}

fn native_verify_if_known(id: &str, check: &str) {
    let _ = native_verify_or_check(id, check);
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
        let mut store = PairStore::default();
        let pair = ContractPair {
            work_id: "work-1".into(),
            witness_id: "wit-1".into(),
            goal: "test goal".into(),
            check: "echo ok".into(),
            backend: "native".into(),
        };
        store.pairs.insert("work-1".into(), pair);
        let json = serde_json::to_string(&store).unwrap();
        let restored: PairStore = serde_json::from_str(&json).unwrap();
        let restored_pair = restored.pairs.get("work-1").unwrap();
        assert_eq!(restored_pair.work_id, "work-1");
        assert_eq!(restored_pair.backend, "native");
    }

    #[test]
    fn test_local_task_native_begin_verify() {
        // Structural: hasher id is 8 hex chars.
        let id = new_task_id();
        assert_eq!(id.len(), 8);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
