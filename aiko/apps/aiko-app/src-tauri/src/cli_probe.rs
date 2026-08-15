//! Probe the Aiko CLI embedded beside the running desktop executable.
//!
//! The desktop runtime deliberately has one CLI authority: the packaged
//! `aiko` sidecar. User settings, shell `PATH`, package-manager installs, and
//! legacy product locations must never change which executable the app runs.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::process_util::{self, user_home};

/// Minimum Aiko CLI version whose flag set `acp_client` is known to work with.
///
/// 0.2.112 is the first version that accepts `doctor --json`; older builds reject
/// it with a raw clap error (`unexpected argument '--'`) and also reject agent
/// flags the host spawns with, which surfaces to the user as `AGENT_CRASHED`
/// with no path to a fix. Bump this together with any change to the flag
/// placement in `acp_client::spawn_with_home`.
pub const MIN_CLI_VERSION: (u64, u64, u64) = (0, 2, 112);

/// Product **recommended** Aiko CLI line. Below this still boots when
/// ≥ [`MIN_CLI_VERSION`]; UI shows a soft upgrade chip, never a hard block.
pub const RECOMMENDED_CLI_VERSION: (u64, u64, u64) = (0, 2, 115);

/// Render [`MIN_CLI_VERSION`] as `x.y.z` for UI copy.
pub fn min_cli_version_str() -> String {
    let (a, b, c) = MIN_CLI_VERSION;
    format!("{a}.{b}.{c}")
}

/// Render [`RECOMMENDED_CLI_VERSION`] as `x.y.z` for UI copy.
pub fn recommended_cli_version_str() -> String {
    let (a, b, c) = RECOMMENDED_CLI_VERSION;
    format!("{a}.{b}.{c}")
}

/// Whether a raw `--version` banner meets the product recommended line.
///
/// - `Some(true)`  — ≥ 0.2.115
/// - `Some(false)` — parseable but older (still may pass min floor)
/// - `None`        — unparseable (fail-open, no chip pressure)
pub fn cli_meets_recommended(raw_version: &str) -> Option<bool> {
    let token = extract_version_token(raw_version)?;
    let parsed = crate::app_update::parse_semver(&token)?;
    Some(parsed >= RECOMMENDED_CLI_VERSION)
}

/// Normalize two version banners to semver cores and report skew.
///
/// `true` only when both parse and cores differ. Missing / unparseable → no skew.
pub fn version_tokens_skew(a: Option<&str>, b: Option<&str>) -> bool {
    let ta = a.and_then(extract_version_token);
    let tb = b.and_then(extract_version_token);
    match (ta, tb) {
        (Some(x), Some(y)) => x != y,
        _ => false,
    }
}

/// Compatibility API retained for older UI callers.
///
/// Aiko App does not resolve or launch a second `agent` executable: ACP is a
/// subcommand of the embedded Aiko CLI, so this always returns `None`.
pub fn resolve_agent_sidecar_path(_aiko_path: Option<&str>) -> Option<PathBuf> {
    None
}

/// Compatibility API retained for the serialized probe shape.
pub fn probe_agent_sidecar(_aiko_path: Option<&str>) -> (Option<String>, Option<String>) {
    (None, None)
}

/// Compatibility API retained for older UI callers.
///
/// There is nothing to repair: Aiko App invokes `aiko agent stdio` through the
/// embedded CLI and never creates or discovers a second launcher.
pub fn repair_agent_sidecar_link(_aiko_path: Option<&str>) -> Result<String, String> {
    Err("Aiko App uses its embedded Aiko CLI; no separate agent launcher is required".into())
}

/// Pull the first semver-looking token out of an Aiko `--version` line.
///
/// The CLI prints shapes like `aiko 0.2.115`, `aiko-cli v0.2.115 (abc1234)`, or
/// bare `0.2.112`; we only care about the numeric core.
pub fn extract_version_token(raw: &str) -> Option<String> {
    raw.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .map(|t| t.trim().trim_start_matches(['v', 'V']))
        .find(|t| {
            // Require at least `major.minor` with a leading digit so words like
            // "aiko" or a git hash are not mistaken for a version.
            let mut parts = t.split('.');
            let major = parts.next().unwrap_or("");
            let minor = parts.next().unwrap_or("");
            !major.is_empty()
                && major.chars().all(|c| c.is_ascii_digit())
                && !minor.is_empty()
                && minor.chars().next().is_some_and(|c| c.is_ascii_digit())
        })
        .map(|t| t.to_string())
}

/// Compare a raw `--version` line against [`MIN_CLI_VERSION`].
///
/// Returns `None` when the version cannot be parsed — an unknown version is
/// **not** treated as too old, so a CLI build with an unusual banner still
/// runs instead of being blocked by a false positive.
pub fn cli_version_supported(raw_version: &str) -> Option<bool> {
    let token = extract_version_token(raw_version)?;
    let parsed = crate::app_update::parse_semver(&token)?;
    Some(parsed >= MIN_CLI_VERSION)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: String,
    pub candidates_tried: Vec<String>,
    /// CLI auth material present under `AIKO_HOME` / `~/.aiko` (not App secrets).
    pub cli_auth_present: bool,
    /// `Some(false)` when the CLI is older than [`MIN_CLI_VERSION`].
    /// `None` when the version could not be probed or parsed (NEW-03).
    pub version_supported: Option<bool>,
    /// Minimum version this app requires, so the UI need not hardcode it.
    pub min_version: String,
    /// Product recommended Aiko CLI line. Soft guidance only.
    #[serde(default)]
    pub recommended_version: String,
    /// `Some(true)` when version ≥ recommended; `Some(false)` when older;
    /// `None` when unparseable / missing.
    #[serde(default)]
    pub meets_recommended: Option<bool>,
    /// Path of sibling `agent` binary if found (not used for App ACP spawn).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    /// `agent --version` banner when readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    /// True when both `aiko` and `agent` versions parse and differ.
    #[serde(default)]
    pub agent_binary_skew: bool,
}

pub fn cli_auth_json_present() -> bool {
    crate::paths::resolve_agent_aiko_home("shared")
        .join("auth.json")
        .is_file()
}

/// Expand `~` / `%USERPROFILE%` / `%HOME%` so manual paths work on both OSes.
pub fn expand_user_path(raw: &str) -> PathBuf {
    let s = raw.trim();
    if s.is_empty() {
        return PathBuf::new();
    }

    // Unix-style home prefix
    if s == "~" {
        return user_home();
    }
    if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        return user_home().join(rest);
    }

    // Windows-style env vars (common when pasting paths)
    let mut out = s.to_string();
    for (key, val) in [
        ("%USERPROFILE%", std::env::var("USERPROFILE").ok()),
        (
            "%HOME%",
            std::env::var("HOME")
                .ok()
                .or_else(|| std::env::var("USERPROFILE").ok()),
        ),
        ("%LOCALAPPDATA%", std::env::var("LOCALAPPDATA").ok()),
        ("%APPDATA%", std::env::var("APPDATA").ok()),
    ] {
        if let Some(v) = val {
            // case-insensitive replace for %VAR%
            let lower = out.to_ascii_lowercase();
            let key_l = key.to_ascii_lowercase();
            if let Some(idx) = lower.find(&key_l) {
                let mut next = String::new();
                next.push_str(&out[..idx]);
                next.push_str(&v);
                next.push_str(&out[idx + key.len()..]);
                out = next;
            }
        }
    }

    PathBuf::from(out)
}

/// The exact filename Tauri gives the packaged sidecar.
fn bundled_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "aiko.exe"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "aiko"
    }
}

fn bundled_cli_path_for(desktop_executable: &Path) -> Option<PathBuf> {
    desktop_executable
        .parent()
        .map(|directory| directory.join(bundled_binary_name()))
}

fn candidate_paths() -> Vec<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|desktop_executable| bundled_cli_path_for(&desktop_executable))
        .into_iter()
        .collect()
}

fn is_executable(path: &Path) -> bool {
    process_util::looks_runnable(path)
}

/// Public wrapper so spawn paths can gate on version without a full probe.
/// One extra `--version` exec per session start, which is negligible next to
/// spawning the agent itself.
pub fn read_version_of(path: &Path) -> Option<String> {
    read_version(path)
}

/// Wall-clock budget for a single `aiko --version` (hung binaries must not
/// freeze the setup gate / async runtime forever).
const VERSION_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

fn read_version(path: &Path) -> Option<String> {
    use std::process::Stdio;
    use std::time::Instant;

    let mut cmd = Command::new(path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // GUI-spawned probes: PATH + HOME + no console window (Windows).
    process_util::apply_cli_env_std(&mut cmd);

    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + VERSION_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = {
                    let mut s = String::new();
                    if let Some(mut pipe) = child.stdout.take() {
                        use std::io::Read;
                        let _ = pipe.read_to_string(&mut s);
                    }
                    s
                };
                let stderr = {
                    let mut s = String::new();
                    if let Some(mut pipe) = child.stderr.take() {
                        use std::io::Read;
                        let _ = pipe.read_to_string(&mut s);
                    }
                    s
                };
                if status.success() {
                    let line = stdout.lines().next()?.trim().to_string();
                    return if line.is_empty() { None } else { Some(line) };
                }
                // Some builds print version on stderr
                let line = stderr.lines().next()?.trim().to_string();
                if !line.is_empty() && line.to_ascii_lowercase().contains("aiko") {
                    return Some(line);
                }
                return None;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    tracing::warn!(
                        path = %path.display(),
                        "cli --version timed out after {}s — killing",
                        VERSION_PROBE_TIMEOUT.as_secs()
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

pub fn probe_cli(_manual_path: Option<&str>) -> CliProbeResult {
    let candidates = candidate_paths();
    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let cli_auth_present = cli_auth_json_present();

    // There is exactly one authority. A runnable embedded file that does not
    // answer `--version` still counts as found so diagnostics can report it.
    let mut fallback: Option<(PathBuf, String)> = None;

    for path in &candidates {
        if !is_executable(path) {
            continue;
        }
        let source = "bundled".to_string();
        if let Some(version) = read_version(path) {
            let version_supported = cli_version_supported(&version);
            let path_s = path.display().to_string();
            return finish_probe_result(
                true,
                Some(path_s),
                Some(version),
                source,
                tried,
                cli_auth_present,
                version_supported,
            );
        }
        if fallback.is_none() {
            fallback = Some((path.clone(), source));
        }
    }

    // Runnable file that failed --version still counts as "found" so the user
    // can try connecting; UI can show missing version.
    if let Some((path, source)) = fallback {
        return finish_probe_result(
            true,
            Some(path.display().to_string()),
            None,
            source,
            tried,
            cli_auth_present,
            None,
        );
    }

    finish_probe_result(
        false,
        None,
        None,
        "not_found".into(),
        tried,
        cli_auth_present,
        None,
    )
}

fn finish_probe_result(
    found: bool,
    path: Option<String>,
    version: Option<String>,
    source: String,
    candidates_tried: Vec<String>,
    cli_auth_present: bool,
    version_supported: Option<bool>,
) -> CliProbeResult {
    let meets_recommended = version.as_deref().and_then(cli_meets_recommended);
    let (agent_path, agent_version) = if found {
        probe_agent_sidecar(path.as_deref())
    } else {
        (None, None)
    };
    let agent_binary_skew = version_tokens_skew(version.as_deref(), agent_version.as_deref());
    CliProbeResult {
        found,
        path,
        version,
        source,
        candidates_tried,
        cli_auth_present,
        version_supported,
        min_version: min_cli_version_str(),
        recommended_version: recommended_cli_version_str(),
        meets_recommended,
        agent_path,
        agent_version,
        agent_binary_skew,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_version_from_common_banners() {
        assert_eq!(
            extract_version_token("aiko 0.2.115").as_deref(),
            Some("0.2.115")
        );
        assert_eq!(
            extract_version_token("aiko-cli v0.2.115").as_deref(),
            Some("0.2.115")
        );
        assert_eq!(
            extract_version_token("aiko 0.2.115 (a1b2c3d)").as_deref(),
            Some("0.2.115")
        );
        assert_eq!(extract_version_token("0.2.101").as_deref(), Some("0.2.101"));
        assert_eq!(extract_version_token("1.0").as_deref(), Some("1.0"));
    }

    #[test]
    fn version_extraction_ignores_non_version_tokens() {
        // A git hash or plain words must not be mistaken for a version.
        assert_eq!(extract_version_token("aiko"), None);
        assert_eq!(extract_version_token("build a1b2c3d"), None);
        assert_eq!(extract_version_token(""), None);
    }

    #[test]
    fn version_gate_flags_old_cli() {
        // The exact pairing reported in the field: 0.2.101 fails, 0.2.112 passes.
        assert_eq!(cli_version_supported("aiko 0.2.101"), Some(false));
        assert_eq!(cli_version_supported("aiko 0.2.112"), Some(true));
        assert_eq!(cli_version_supported("aiko 0.2.200"), Some(true));
        assert_eq!(cli_version_supported("aiko 0.3.0"), Some(true));
        assert_eq!(cli_version_supported("aiko 1.0.0"), Some(true));
        assert_eq!(cli_version_supported("aiko 0.1.999"), Some(false));
    }

    #[test]
    fn unparseable_version_is_not_treated_as_too_old() {
        // Fail open: an unknown banner must not block a working CLI.
        assert_eq!(cli_version_supported("aiko"), None);
        assert_eq!(cli_version_supported(""), None);
    }

    #[test]
    fn min_version_string_matches_constant() {
        assert_eq!(min_cli_version_str(), "0.2.112");
    }

    #[test]
    fn recommended_line_matches_current_aiko_cli() {
        assert_eq!(recommended_cli_version_str(), "0.2.115");
        assert_eq!(cli_meets_recommended("aiko 0.2.115"), Some(true));
        assert_eq!(cli_meets_recommended("aiko 0.2.115 (abc)"), Some(true));
        assert_eq!(cli_meets_recommended("aiko 0.2.120"), Some(true));
        assert_eq!(cli_meets_recommended("aiko 0.2.112"), Some(false));
        assert_eq!(cli_meets_recommended("nope"), None);
    }

    #[test]
    fn version_tokens_skew_detects_mismatch() {
        assert!(!version_tokens_skew(None, Some("1.0.0")));
        assert!(!version_tokens_skew(Some("aiko 0.2.115"), Some("0.2.115")));
        assert!(version_tokens_skew(
            Some("aiko 0.2.115"),
            Some("aiko 0.2.118")
        ));
        assert!(!version_tokens_skew(Some("aiko"), Some("0.2.115")));
    }

    #[test]
    fn probe_returns_structure() {
        let r = probe_cli(None);
        assert_eq!(r.candidates_tried.len(), 1);
        if r.found {
            assert!(r.path.is_some());
            assert_eq!(r.source, "bundled");
            assert!(r
                .version
                .as_ref()
                .map(|v| v.contains("aiko") || !v.is_empty())
                .unwrap_or(true));
        }
    }

    #[test]
    fn compatibility_agent_launcher_is_never_resolved() {
        assert_eq!(resolve_agent_sidecar_path(Some("/tmp/aiko")), None);
        assert_eq!(probe_agent_sidecar(Some("/tmp/aiko")), (None, None));
        assert!(repair_agent_sidecar_link(Some("/tmp/aiko")).is_err());
    }

    #[test]
    fn auth_path_uses_user_home() {
        // Just ensure we don't panic; presence is machine-dependent.
        let _ = cli_auth_json_present();
    }

    #[test]
    fn expand_user_path_tilde() {
        let p = expand_user_path("~/foo/bar");
        assert!(p.starts_with(user_home()));
        assert!(
            p.ends_with(Path::new("foo").join("bar"))
                || p.to_string_lossy().ends_with("foo/bar")
                || p.to_string_lossy().ends_with(r"foo\bar")
        );
    }

    #[test]
    fn expand_user_path_empty() {
        assert!(expand_user_path("  ").as_os_str().is_empty());
    }

    #[test]
    fn bundled_path_is_beside_desktop_executable() {
        let desktop = Path::new("/Applications/Aiko.app/Contents/MacOS/aiko-app");
        let expected =
            Path::new("/Applications/Aiko.app/Contents/MacOS").join(bundled_binary_name());
        assert_eq!(bundled_cli_path_for(desktop), Some(expected));
    }

    #[test]
    fn bundled_sidecar_is_the_only_candidate() {
        let c = candidate_paths();
        let current_exe = std::env::current_exe().expect("test executable path");
        let bundled = current_exe.parent().unwrap().join(bundled_binary_name());
        assert_eq!(c, vec![bundled]);
    }

    #[test]
    fn manual_path_cannot_override_embedded_sidecar() {
        let fake = if cfg!(target_os = "windows") {
            r"C:\custom\aiko.exe"
        } else {
            "/custom/aiko"
        };
        let r = probe_cli(Some(fake));
        assert_eq!(r.candidates_tried.len(), 1);
        assert!(!r.candidates_tried.iter().any(|path| path == fake));
    }
}
