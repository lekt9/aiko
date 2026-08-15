//! Load trusted projects from Aiko App `projects.json`.

use super::types::TrustedProject;
use crate::paths::app_data_root;
use std::fs;
use std::path::PathBuf;

pub fn load_trusted_projects() -> Vec<TrustedProject> {
    let roots = [
        app_data_root(),
        PathBuf::from(std::env::var("AIKO_APP_HOME").unwrap_or_default()),
    ];
    for root in roots {
        if root.as_os_str().is_empty() {
            continue;
        }
        let file = root.join("projects.json");
        if !file.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(arr) = v.as_array() else {
            continue;
        };
        let mut out = Vec::new();
        for p in arr {
            let trusted = p.get("trusted").and_then(|x| x.as_bool()).unwrap_or(false);
            if !trusted {
                continue;
            }
            let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|x| x.as_str()).unwrap_or("");
            if id.is_empty() || path.is_empty() {
                continue;
            }
            let name = p
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(id)
                .to_string();
            out.push(TrustedProject {
                id: id.to_string(),
                name,
                path: path.to_string(),
            });
        }
        return out;
    }
    Vec::new()
}

/// Default work dir from instance project_scope JSON.
pub fn default_work_dir(project_scope: &serde_json::Value) -> String {
    // { mode: "all_trusted" | "whitelist", projectIds: [] }
    let projects = load_trusted_projects();
    if projects.is_empty() {
        return std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
    }
    let mode = project_scope
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("all_trusted");
    if mode == "whitelist" {
        if let Some(ids) = project_scope.get("projectIds").and_then(|x| x.as_array()) {
            for id in ids {
                if let Some(s) = id.as_str() {
                    if let Some(p) = projects.iter().find(|p| p.id == s) {
                        return p.path.clone();
                    }
                }
            }
        }
    }
    projects[0].path.clone()
}
