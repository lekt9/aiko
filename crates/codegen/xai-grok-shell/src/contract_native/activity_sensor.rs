use super::reflex_policy;
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn event_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aiko/contract/activity.jsonl"))
}

fn clean_application(application: &str) -> Option<String> {
    let cleaned = application
        .chars()
        // Never let a window title or other newline-delimited payload hitch a
        // ride on an application identity supplied by an OS adapter.
        .take_while(|character| !character.is_control())
        .take(128)
        .collect::<String>();
    (!cleaned.trim().is_empty()).then_some(cleaned)
}

fn last_application() -> &'static Mutex<Option<String>> {
    static LAST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn prune_expired(path: &std::path::Path, retention_days: u32) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let cutoff = now_unix().saturating_sub(u64::from(retention_days) * 86_400);
    let retained = raw
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|row| row.get("observed_unix").and_then(Value::as_u64))
                .is_some_and(|observed| observed >= cutoff)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let temporary = path.with_extension("jsonl.tmp");
    if std::fs::write(
        &temporary,
        if retained.is_empty() {
            retained
        } else {
            retained + "\n"
        },
    )
    .is_ok()
    {
        let _ = std::fs::rename(temporary, path);
    }
}

pub fn observe_frontmost(application: Option<&str>) -> bool {
    let policy = reflex_policy::load();
    if !policy.activity_sensors_enabled {
        return false;
    }
    let Some(application) = application.and_then(clean_application) else {
        return false;
    };
    if policy.excluded_applications.contains(&application) {
        return false;
    }
    let Ok(mut last) = last_application().lock() else {
        return false;
    };
    if last.as_deref() == Some(&application) {
        return false;
    }
    *last = Some(application.clone());
    let Some(path) = event_path() else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    prune_expired(&path, policy.retention_days);
    let row = json!({
        "schema": 1,
        "event": "foreground_application",
        "application": application,
        "observed_unix": now_unix(),
    });
    let Ok(encoded) = serde_json::to_vec(&row) else {
        return false;
    };
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return false;
    };
    file.write_all(&encoded).is_ok() && file.write_all(b"\n").is_ok()
}

pub fn inspect(limit: usize) -> Value {
    let policy = reflex_policy::load();
    let cutoff = now_unix().saturating_sub(u64::from(policy.retention_days) * 86_400);
    let events = event_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| {
            raw.lines()
                .rev()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|event| {
                    event
                        .get("observed_unix")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        >= cutoff
                })
                .take(limit.min(1000))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({ "enabled": policy.activity_sensors_enabled, "events": events })
}

pub fn clear() -> std::io::Result<()> {
    if let Some(path) = event_path() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if let Ok(mut last) = last_application().lock() {
        *last = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_names_are_bounded_and_content_free() {
        assert_eq!(
            clean_application("Notes\nprivate title"),
            Some("Notes".into())
        );
        assert_eq!(clean_application(""), None);
        assert!(clean_application(&"a".repeat(500)).unwrap().len() <= 128);
    }
}
