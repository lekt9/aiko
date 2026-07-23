use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ReflexPolicy {
    pub reflexes_enabled: bool,
    pub activity_sensors_enabled: bool,
    pub retention_days: u32,
    pub max_automatic_cost: f64,
    pub capabilities: BTreeMap<String, bool>,
    pub excluded_applications: BTreeSet<String>,
}

impl Default for ReflexPolicy {
    fn default() -> Self {
        Self {
            reflexes_enabled: true,
            activity_sensors_enabled: false,
            retention_days: 30,
            max_automatic_cost: 0.0,
            capabilities: BTreeMap::new(),
            excluded_applications: [
                "1Password".to_owned(),
                "Keychain Access".to_owned(),
                "Password Manager".to_owned(),
            ]
            .into_iter()
            .collect(),
        }
    }
}

fn policy_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aiko/contract/reflex-policy.json"))
}

pub fn load() -> ReflexPolicy {
    let Some(path) = policy_path() else {
        return ReflexPolicy::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(policy: &ReflexPolicy) -> std::io::Result<()> {
    let path = policy_path().ok_or_else(|| std::io::Error::other("home directory unavailable"))?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("invalid policy path"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".reflex-policy.{}.tmp", std::process::id()));
    let encoded = serde_json::to_vec_pretty(policy)?;
    {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
    }
    std::fs::rename(temporary, path)
}

pub fn update(mutator: impl FnOnce(&mut ReflexPolicy)) -> std::io::Result<ReflexPolicy> {
    let mut policy = load();
    mutator(&mut policy);
    policy.retention_days = policy.retention_days.clamp(1, 3650);
    if !policy.max_automatic_cost.is_finite() || policy.max_automatic_cost < 0.0 {
        policy.max_automatic_cost = 0.0;
    }
    save(&policy)?;
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_local_safe_and_sensors_are_opt_in() {
        let policy = ReflexPolicy::default();
        assert!(policy.reflexes_enabled);
        assert!(!policy.activity_sensors_enabled);
        assert_eq!(policy.max_automatic_cost, 0.0);
        assert!(policy.excluded_applications.contains("Keychain Access"));
        assert!(policy.capabilities.is_empty());
    }
}
