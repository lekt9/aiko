//! Smithers gateway status — read-only discovery for the welcome screen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const GATEWAY_RUNTIME_DIR_NAME: &str = "smithers-gateway";
const CACHE_TTL: Duration = Duration::from_secs(2);
const CACHE_CAP: usize = 64;

#[derive(Debug, Clone, serde::Deserialize)]
struct GatewayRuntimeJson {
    pid: Option<u32>,
    url: Option<String>,
    port: Option<u16>,
    host: Option<String>,
    #[serde(rename = "workspaceRoot")]
    workspace_root: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SmithersGatewayInfo {
    pub url: String,
    pub port: u16,
    pub host: String,
    pub pid: u32,
    pub workspace_root: String,
}

fn default_gateway_runtime_dir() -> PathBuf {
    if cfg!(target_os = "linux") {
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            if !xdg.is_empty() {
                return PathBuf::from(xdg).join(GATEWAY_RUNTIME_DIR_NAME);
            }
        }
        if let Some(uid) = current_uid() {
            return std::env::temp_dir().join(format!("{GATEWAY_RUNTIME_DIR_NAME}-{uid}"));
        }
    }
    if let Ok(dir) = std::env::var("SMITHERS_GATEWAY_STATE_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::temp_dir().join(GATEWAY_RUNTIME_DIR_NAME)
}

fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    { Some(unsafe { libc::getuid() }) }
    #[cfg(not(unix))]
    { None }
}

fn canonical_workspace_path(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn resolve_workspace_root(cwd: &Path) -> PathBuf {
    if let Ok(pinned) = std::env::var("SMITHERS_WORKSPACE_ROOT") {
        if !pinned.is_empty() {
            return PathBuf::from(pinned);
        }
    }
    // Walk up to nearest .smithers/ pack, then smithers.db — mirrors
    // aiko-flow/packages/tui/src/gatewayRuntimeState.ts resolveMonitorWorkspaceRoot.
    let dir = canonical_workspace_path(cwd);
    let mut probe = dir.clone();
    loop {
        if probe.join(".smithers").is_dir() {
            return probe;
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => break,
        }
    }
    probe = dir.clone();
    loop {
        if probe.join("smithers.db").is_file() {
            return probe;
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => break,
        }
    }
    dir
}

fn gateway_state_file(workspace: &Path) -> PathBuf {
    let root = default_gateway_runtime_dir();
    let canon = canonical_workspace_path(&resolve_workspace_root(workspace));
    let hash = Sha256::digest(canon.to_string_lossy().as_bytes());
    let key = hex::encode(&hash)[..32].to_string();
    root.join(format!("{key}.json"))
}

mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::with_capacity(bytes.len() * 2);
        for &b in bytes { s.push(HEX[(b >> 4) as usize] as char); s.push(HEX[(b & 0xf) as usize] as char); }
        s
    }
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as i32, 0) };
        rc == 0 || { let err = std::io::Error::last_os_error(); err.raw_os_error() == Some(libc::EPERM) }
    }
    #[cfg(not(unix))]
    { let _ = pid; true }
}

fn read_gateway_state(workspace: &Path) -> Option<SmithersGatewayInfo> {
    let file = gateway_state_file(workspace);
    let data = std::fs::read_to_string(&file).ok()?;
    let parsed: GatewayRuntimeJson = serde_json::from_str(&data).ok()?;
    let pid = parsed.pid?;
    if !pid_alive(pid) { return None; }
    let url = parsed.url?;
    let port = parsed.port.unwrap_or_else(|| url.rsplit_once(':').and_then(|(_, p)| p.trim_end_matches('/').parse::<u16>().ok()).unwrap_or(7331));
    Some(SmithersGatewayInfo { url: url.clone(), port, host: parsed.host.unwrap_or_else(|| "127.0.0.1".to_string()), pid, workspace_root: parsed.workspace_root.unwrap_or_else(|| workspace.to_string_lossy().to_string()) })
}

type CacheEntry = (Option<SmithersGatewayInfo>, Instant);
static CACHE: LazyLock<Mutex<HashMap<PathBuf, CacheEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cache_insert(cache: &mut HashMap<PathBuf, CacheEntry>, key: PathBuf, entry: CacheEntry) {
    if cache.len() >= CACHE_CAP && !cache.contains_key(&key) {
        if let Some(oldest) = cache.iter().min_by_key(|(_, (_, ts))| *ts).map(|(k, _)| k.clone()) { cache.remove(&oldest); }
    }
    cache.insert(key, entry);
}

pub fn smithers_gateway_info_lazy(workspace: &Path) -> Option<SmithersGatewayInfo> {
    let mut cache = CACHE.lock().ok()?;
    let (cached, needs_refresh) = match cache.get(workspace) { Some((info, ts)) => (info.clone(), ts.elapsed() >= CACHE_TTL), None => (None, true) };
    if needs_refresh {
        cache_insert(&mut *cache, workspace.to_path_buf(), (cached.clone(), Instant::now()));
        drop(cache);
        let fresh = read_gateway_state(workspace);
        if let Ok(mut c) = CACHE.lock() { cache_insert(&mut *c, workspace.to_path_buf(), (fresh.clone(), Instant::now())); }
        return fresh;
    }
    cached
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn hex_encode() { assert_eq!(hex::encode(&[0x00, 0xff, 0xab]), "00ffab"); }
    #[test] fn gateway_state_file_is_deterministic() { let a = gateway_state_file(Path::new("/tmp/ws-a")); let b = gateway_state_file(Path::new("/tmp/ws-a")); assert_eq!(a, b); }
    #[test] fn gateway_state_file_differs_per_workspace() { let a = gateway_state_file(Path::new("/tmp/ws-a")); let b = gateway_state_file(Path::new("/tmp/ws-b")); assert_ne!(a, b); }
}
