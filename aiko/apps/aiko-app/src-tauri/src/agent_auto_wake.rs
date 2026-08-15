//! Auto-wake (CLI config `auto_wake_enabled`) — agent-home config.toml sync.
//!
//! When enabled, Aiko may inject a synthetic turn after background work
//! completes (bash / monitor / task completion, scheduled loops). Behavior is
//! entirely CLI-side.
//!
//! Config key (top-level, agent-home independent mode):
//! - `auto_wake_enabled` (bool)
//!
//! No dedicated CLI flag. Env `GROK_AUTO_WAKE` is pattern-shaped in the binary
//! (wildcards) — this module does **not** invent 0/1 env overrides.
//! Shared mode never rewrites `~/.aiko/config.toml`. Soft-respawn after write
//! so the next agent process reloads config. Older CLIs that ignore the key
//! soft-fail.

#![allow(dead_code)] // residual-clippy: normalize_enabled
use crate::agent_home_config::{set_top_level_bool, update_config_toml_if_independent};

pub const CONFIG_KEY: &str = "auto_wake_enabled";

/// Normalize enable toggle (App default off / opt-in).
pub fn normalize_enabled(raw: bool) -> bool {
    raw
}

/// Upsert `auto_wake_enabled` into a TOML-ish text blob.
pub fn set_auto_wake_in_toml(text: &str, enabled: bool) -> String {
    set_top_level_bool(text, CONFIG_KEY, enabled)
}

/// Write the config key into App agent-home (independent AIKO_HOME only).
pub fn sync_auto_wake_to_agent_profile(
    session_data_mode: &str,
    enabled: bool,
) -> Result<(), String> {
    let path = update_config_toml_if_independent(session_data_mode, |existing| {
        set_auto_wake_in_toml(existing, enabled)
    })?;
    if let Some(path) = path {
        tracing::info!(
            "agent_auto_wake: synced {}={} → {}",
            CONFIG_KEY,
            enabled,
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize() {
        assert!(!normalize_enabled(false));
        assert!(normalize_enabled(true));
    }

    #[test]
    fn upserts_top_level_key() {
        let t = set_auto_wake_in_toml("", true);
        assert!(t.contains("auto_wake_enabled = true"));

        let existing = "[ui]\nyolo = false\n\n[subagents]\nenabled = true\n";
        let next = set_auto_wake_in_toml(existing, false);
        assert!(next.contains("auto_wake_enabled = false"));
        let ui_pos = next.find("[ui]").unwrap();
        let key_pos = next.find("auto_wake_enabled").unwrap();
        assert!(key_pos < ui_pos);
        assert!(next.contains("[subagents]"));
        assert!(next.contains("yolo = false"));

        let again = set_auto_wake_in_toml(&next, true);
        assert!(again.contains("auto_wake_enabled = true"));
        assert_eq!(again.matches("auto_wake_enabled").count(), 1);
    }
}
