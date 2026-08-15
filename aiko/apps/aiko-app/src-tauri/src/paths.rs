//! App data roots: Aiko-owned UI store (`~/.aiko-app` fallback).
//! Shared sessions follow the Aiko CLI's canonical `AIKO_HOME` / `~/.aiko`
//! resolution, with an existing `~/.grok` identity retained for migration.

use std::fs;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;

#[cfg(test)]
pub(crate) static APP_HOME_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn app_data_root() -> PathBuf {
    if let Ok(custom) = std::env::var("AIKO_APP_HOME") {
        return PathBuf::from(custom);
    }
    if let Some(proj) = ProjectDirs::from("ai", "aiko", "desktop") {
        return proj.data_dir().to_path_buf();
    }
    // Fallback
    dirs_fallback()
}

fn dirs_fallback() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("aiko-app");
        }
    }
    crate::process_util::user_home().join(".aiko-app")
}

pub fn ensure_app_dirs() -> std::io::Result<PathBuf> {
    let root = app_data_root();
    std::fs::create_dir_all(root.join("projects"))?;
    std::fs::create_dir_all(root.join("sessions"))?;
    std::fs::create_dir_all(root.join("logs"))?;
    // Agent profile (config.toml / optional auth) when session_data_mode=independent.
    std::fs::create_dir_all(root.join("agent-home"))?;
    // Clipboard paste / picker-written attachment files.
    std::fs::create_dir_all(root.join("attachments").join("paste"))?;
    // Multi-account auth snapshots.
    std::fs::create_dir_all(root.join("accounts"))?;
    // Default workspace for chats with no user-picked project (agent file I/O).
    std::fs::create_dir_all(general_workspace_dir())?;
    // Wallpaper library (X downloads + Imagine outputs).
    std::fs::create_dir_all(root.join("wallpapers").join("x"))?;
    std::fs::create_dir_all(root.join("wallpapers").join("imagine"))?;
    std::fs::create_dir_all(root.join("wallpapers").join("library"))?;
    // Chat video cover frames (ffmpeg / client canvas JPEG).
    std::fs::create_dir_all(root.join("cache").join("video-posters"))?;
    // Chat image thumbs (resized JPEG for virtual-list remounts).
    std::fs::create_dir_all(root.join("cache").join("image-thumbs"))?;
    Ok(root)
}

/// Disk cache for chat video posters: `{app_data}/cache/video-posters`.
pub fn video_posters_dir() -> PathBuf {
    let dir = app_data_root().join("cache").join("video-posters");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Disk cache for chat image thumbs: `{app_data}/cache/image-thumbs`.
pub fn image_thumbs_dir() -> PathBuf {
    let dir = app_data_root().join("cache").join("image-thumbs");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Stable cwd for orphan / unassigned chats — under app data so agents can
/// create/edit files without binding a user folder.
///
/// `{app_data}/workspaces/general`
pub fn general_workspace_dir() -> PathBuf {
    app_data_root().join("workspaces").join("general")
}

/// Directory for pasted / saved composer attachments (absolute paths for `@path` refs).
pub fn attachments_paste_dir() -> PathBuf {
    let dir = app_data_root().join("attachments").join("paste");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// CLI home for independent mode: Aiko App-owned agent profile.
pub fn agent_home_dir() -> PathBuf {
    app_data_root().join("agent-home")
}

pub fn agent_config_toml() -> PathBuf {
    agent_home_dir().join("config.toml")
}

fn shared_cli_home(aiko_home: Option<PathBuf>, user_home: &Path) -> PathBuf {
    if let Some(path) = aiko_home {
        return path;
    }
    let preferred = user_home.join(".aiko");
    let legacy = user_home.join(".grok");
    let has_identity =
        |root: &Path| root.join("config.toml").exists() || root.join("auth.json").exists();
    if !has_identity(&preferred) && has_identity(&legacy) {
        legacy
    } else {
        preferred
    }
}

/// Resolve the CLI home used by an Aiko agent process. Shared mode mirrors the
/// Aiko CLI's canonical precedence: `AIKO_HOME`, an existing legacy identity,
/// then `~/.aiko` for new installs. The app never exports the deprecated
/// `GROK_HOME` alias to an Aiko CLI process.
pub fn resolve_agent_aiko_home(session_data_mode: &str) -> PathBuf {
    if session_data_mode == "shared" {
        return shared_cli_home(
            std::env::var_os("AIKO_HOME").map(PathBuf::from),
            &crate::process_util::user_home(),
        );
    }
    let _ = ensure_app_dirs();
    agent_home_dir()
}

pub fn projects_file() -> PathBuf {
    app_data_root().join("projects.json")
}

pub fn sessions_index_file() -> PathBuf {
    app_data_root().join("sessions_index.json")
}

pub fn settings_file() -> PathBuf {
    app_data_root().join("settings.json")
}

/// On-disk secrets metadata (+ API-key fallback when OS keychain is unavailable).
/// Sensitive keys prefer the OS keychain; see [`crate::secrets`].
pub fn secrets_file() -> PathBuf {
    app_data_root().join("secrets.json")
}

pub fn session_dir(session_id: &str) -> PathBuf {
    app_data_root().join("sessions").join(session_id)
}

/// Host-side scheduled automations (shell list; execution via agent sessions).
pub fn automations_file() -> PathBuf {
    app_data_root().join("automations.json")
}

/// App MCP/Skills enable prefs (`extensions.json`).
pub fn extensions_file() -> PathBuf {
    app_data_root().join("extensions.json")
}

/// Percent-encode a path the way the current Aiko CLI names session folders
/// under its compatible `AIKO_HOME/sessions/` layout.
pub fn percent_encode_path_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0xf) as usize]));
            }
        }
    }
    out
}

/// Locate the on-disk agent session directory for a given agent session id.
/// Layout: `{AIKO_HOME}/sessions/{percent-encoded-cwd}/{agent_session_id}/`
///
/// `cwd_hint` (project path) avoids a directory scan when known.
pub fn find_agent_session_dir(
    agent_session_id: &str,
    cwd_hint: Option<&str>,
    session_data_mode: &str,
) -> Option<PathBuf> {
    if agent_session_id.is_empty() {
        return None;
    }
    let home = resolve_agent_aiko_home(session_data_mode);
    let sessions = home.join("sessions");
    if !sessions.is_dir() {
        return None;
    }

    if let Some(cwd) = cwd_hint.filter(|s| !s.is_empty()) {
        let encoded = percent_encode_path_component(cwd);
        let candidate = sessions.join(encoded).join(agent_session_id);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    // Fallback: scan cwd folders for this agent session id
    let Ok(entries) = fs::read_dir(&sessions) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let candidate = path.join(agent_session_id);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// Join agent session root + relative path like `images/1.jpg`.
/// Rejects `..` segments. Returns None if the resolved file is missing.
pub fn resolve_session_relative_media(session_root: &Path, relative: &str) -> Option<PathBuf> {
    let rel = relative.trim().trim_start_matches("./");
    if rel.is_empty() {
        return None;
    }
    if Path::new(rel).is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for comp in Path::new(rel).components() {
        use std::path::Component;
        match comp {
            Component::Normal(s) => clean.push(s),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return None;
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return None;
    }
    let full = session_root.join(clean);
    if full.is_file() {
        Some(full)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_root_is_absolute_or_relative_path() {
        let p = app_data_root();
        assert!(!p.as_os_str().is_empty());
    }

    #[test]
    fn aiko_app_home_is_the_only_env_override() {
        let _lock = APP_HOME_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_aiko = std::env::var_os("AIKO_APP_HOME");
        let base = std::env::temp_dir().join(format!("aiko-app-root-test-{}", std::process::id()));
        let aiko = base.join("aiko");
        std::env::set_var("AIKO_APP_HOME", &aiko);
        assert_eq!(app_data_root(), aiko);

        match previous_aiko {
            Some(value) => std::env::set_var("AIKO_APP_HOME", value),
            None => std::env::remove_var("AIKO_APP_HOME"),
        }
    }

    #[test]
    fn fallback_root_is_aiko_owned() {
        assert!(dirs_fallback().ends_with(".aiko-app") || dirs_fallback().ends_with("aiko-app"));
    }

    #[test]
    fn shared_cli_home_matches_aiko_precedence_and_legacy_migration() {
        let base = std::env::temp_dir().join(format!(
            "aiko-shared-home-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed")
        ));
        let preferred = base.join(".aiko");
        let legacy = base.join(".grok");
        let explicit_aiko = base.join("explicit-aiko");
        assert_eq!(shared_cli_home(None, &base), preferred);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("auth.json"), "{}").unwrap();
        assert_eq!(shared_cli_home(None, &base), legacy);
        std::fs::create_dir_all(&preferred).unwrap();
        std::fs::write(preferred.join("config.toml"), "").unwrap();
        assert_eq!(shared_cli_home(None, &base), preferred);
        assert_eq!(
            shared_cli_home(Some(explicit_aiko.clone()), &base),
            explicit_aiko
        );

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn percent_encode_matches_encode_uri_component_style() {
        let cwd = "/Users/me/Downloads/5 天 course";
        let enc = percent_encode_path_component(cwd);
        assert!(enc.starts_with("%2FUsers%2Fme%2FDownloads%2F5%20"));
        assert!(enc.contains("%E5%A4%A9") || enc.contains("%"));
        assert!(!enc.contains('/'));
    }

    #[test]
    fn resolve_session_relative_rejects_parent() {
        let root = PathBuf::from("/tmp/session");
        assert!(resolve_session_relative_media(&root, "../etc/passwd").is_none());
        assert!(resolve_session_relative_media(&root, "/etc/passwd").is_none());
    }
}
