
fn parse_plugin_list_json(
    raw: &str,
    disabled: &std::collections::HashSet<String>,
    inspect_extra: &std::collections::HashMap<String, InspectPluginExtra>,
) -> Result<Vec<PluginDto>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Failed to parse plugin list JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "plugin list JSON is not an array".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let version = item
            .get("version")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let source = item
            .get("source")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let marketplace = item
            .get("marketplace")
            .and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str()
                }
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let repo_key = item
            .get("repo_key")
            .or_else(|| item.get("repoKey"))
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        // Preserve CLI install status verbatim (do not invent "disabled" status).
        let status = item
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("installed")
            .trim()
            .to_string();
        let status = if status.is_empty() {
            "installed".to_string()
        } else {
            status
        };
        let enabled = !plugin_matches_disabled(&name, repo_key.as_deref(), disabled);

        // Prefer path-keyed inspect row, then name.
        let extra = path
            .as_ref()
            .and_then(|p| inspect_extra.get(&format!("path:{p}")))
            .or_else(|| inspect_extra.get(&name));

        // Scope: inspect first, else marketplace name, else "user" for installed-plugins paths.
        let scope = extra
            .and_then(|e| e.scope.clone())
            .or_else(|| marketplace.clone())
            .or_else(|| {
                path.as_ref().and_then(|p| {
                    if p.contains("installed-plugins") {
                        Some("user".into())
                    } else {
                        None
                    }
                })
            });

        out.push(PluginDto {
            name,
            version,
            source,
            marketplace,
            path,
            status,
            enabled,
            repo_key,
            scope,
            provides: extra.and_then(|e| e.provides.clone()),
        });
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| {
                a.repo_key
                    .as_deref()
                    .unwrap_or("")
                    .cmp(b.repo_key.as_deref().unwrap_or(""))
            })
    });
    Ok(out)
}

fn collect_plugins_list() -> Result<Vec<PluginDto>, String> {
    // Parallel: install inventory + inspect enrich (scope/provides).
    let list_handle = std::thread::spawn(|| {
        run_aiko_cli_args(&["plugin", "list", "--json"], PLUGIN_CMD_TIMEOUT_SECS)
    });
    let inspect_handle =
        std::thread::spawn(|| run_aiko_cli_args(&["inspect", "--json"], INSPECT_TIMEOUT_SECS));

    let list_result = list_handle
        .join()
        .map_err(|_| "plugin list worker panicked".to_string())?;
    let (stdout, stderr, ok) = list_result?;
    if !ok {
        let msg: String = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "aiko plugin list failed".into()
        };
        return Err(msg);
    }
    if stdout.is_empty() {
        return Ok(Vec::new());
    }
    let disabled = load_disabled_plugin_entries();
    // Best-effort inspect enrich. Failures leave scope/provides empty.
    let inspect_extra = match inspect_handle.join() {
        Ok(Ok((body, _, true))) if !body.is_empty() => {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => parse_inspect_plugins_map(&v),
                Err(_) => std::collections::HashMap::new(),
            }
        }
        _ => std::collections::HashMap::new(),
    };
    parse_plugin_list_json(&stdout, &disabled, &inspect_extra)
}

/// List installed plugins (Aiko inventory + enable state + inspect extras).
/// Always returns Ok; on CLI missing / failure, `plugins` is empty and `error` is set.
#[tauri::command]
pub async fn plugins_list() -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(collect_plugins_list)
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(plugins) => Ok(serde_json::json!({ "plugins": plugins })),
        Err(e) => Ok(serde_json::json!({
            "plugins": [],
            "error": e,
        })),
    }
}

/// Enable a plugin by name (`aiko plugin enable <name>`). Soft-respawns agent.
#[tauri::command]
pub async fn plugin_enable(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_aiko_cli_args(
            &["plugin", "enable", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to enable plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Disable a plugin by name (`aiko plugin disable <name>`). Soft-respawns agent.
#[tauri::command]
pub async fn plugin_disable(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_aiko_cli_args(
            &["plugin", "disable", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to disable plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Uninstall a plugin by name. Soft-respawns agent on success.
#[tauri::command]
pub async fn plugin_uninstall(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_aiko_cli_args(
            &["plugin", "uninstall", &name_for_cmd, "--confirm"],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to uninstall plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Plugin component inventory text (`aiko plugin details <name>`).
#[tauri::command]
pub async fn plugin_details(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_aiko_cli_args(
            &["plugin", "details", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to load details for {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    Ok(serde_json::json!({
        "name": name,
        "details": stdout,
    }))
}

/// Trim install source; reject empty. Accepts path, git URL, or GitHub shorthand.
pub fn normalize_plugin_install_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("plugin source required".into());
    }
    Ok(s.to_string())
}

/// Optional update target: empty / whitespace → update all (`None`).
pub fn normalize_plugin_update_name(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Best-effort plugin name for `plugin enable` after install.
/// Handles `name`, `name@marketplace`, `owner/repo[@ref]`, git URLs, and paths.
/// Strips `#fragment` (monorepo subdir pins like `#codex`) before taking the leaf.
pub fn plugin_name_from_install_source(source: &str) -> Option<String> {
    let raw = source.trim();
    if raw.is_empty() {
        return None;
    }
    // Strip URL/path fragment first so `…/agent-plugin#codex` does not yield
    // `agent-plugin#codex` as the enable name. Prefer a simple fragment id when
    // present (ChatCut `#codex`); otherwise parse the base locator.
    let (base, fragment) = match raw.split_once('#') {
        Some((b, f)) => (b.trim(), f.split('?').next().unwrap_or("").trim()),
        None => (raw, ""),
    };
    if !fragment.is_empty()
        && !fragment.contains('/')
        && !fragment.contains('\\')
        && !fragment.contains(':')
    {
        return Some(fragment.to_string());
    }
    let s = base;
    if s.is_empty() {
        return None;
    }
    // git@host:path/repo.git
    if s.starts_with("git@") {
        let leaf = s.rsplit([':', '/']).next().unwrap_or("");
        let name = leaf.trim_end_matches(".git");
        return if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    // https://…/repo.git
    if s.contains("://") {
        let leaf = s.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let name = leaf.trim_end_matches(".git");
        return if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    // Absolute / home / Windows path
    let looks_like_path = s.starts_with('/')
        || s.starts_with('~')
        || (s.len() >= 3
            && s.as_bytes()[1] == b':'
            && (s.as_bytes()[2] == b'\\' || s.as_bytes()[2] == b'/'));
    if looks_like_path {
        let trimmed = s.trim_end_matches(['/', '\\']);
        let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
        return if leaf.is_empty() {
            None
        } else {
            Some(leaf.to_string())
        };
    }
    // name@marketplace or owner/repo@ref
    if let Some((left, _right)) = s.split_once('@') {
        if left.is_empty() {
            return None;
        }
        if !left.contains('/') {
            return Some(left.to_string());
        }
        let leaf = left.rsplit('/').next().unwrap_or("");
        return if leaf.is_empty() {
            None
        } else {
            Some(leaf.to_string())
        };
    }
    // bare name
    if !s.contains('/') {
        return Some(s.to_string());
    }
    // owner/repo
    let leaf = s.rsplit('/').next().unwrap_or("");
    if leaf.is_empty() {
        None
    } else {
        Some(leaf.to_string())
    }
}

/// Install from path / git URL / GitHub shorthand / marketplace name
/// (`aiko plugin install <source> --trust`), then enable, then soft-respawn.
/// `--trust` is required for non-interactive UI; enable so skills/MCP load without a second step.
#[tauri::command]
pub async fn plugin_install(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    source: String,
) -> Result<serde_json::Value, String> {
    let source = normalize_plugin_install_source(&source)?;
    let source_for_cmd = source.clone();
    let enable_name = plugin_name_from_install_source(&source);
    let enable_name_for_cmd = enable_name.clone();
    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, String, bool, Option<String>), String> {
            let (stdout, stderr, ok) = run_aiko_cli_args(
                &["plugin", "install", &source_for_cmd, "--trust"],
                PLUGIN_MUTATE_TIMEOUT_SECS,
            )?;
            if !ok {
                return Ok((stdout, stderr, false, None));
            }
            // Plugins stay off until enabled — enable so the install is usable immediately.
            let mut enable_msg: Option<String> = None;
            if let Some(name) = enable_name_for_cmd {
                match run_aiko_cli_args(
                    &["plugin", "enable", &name],
                    PLUGIN_CMD_TIMEOUT_SECS,
                ) {
                    Ok((e_out, e_err, e_ok)) => {
                        if e_ok {
                            enable_msg = Some(if e_out.is_empty() {
                                format!("enabled {name}")
                            } else {
                                e_out
                            });
                        } else {
                            // Install succeeded; surface enable failure as soft note.
                            let note = if !e_err.is_empty() {
                                e_err
                            } else if !e_out.is_empty() {
                                e_out
                            } else {
                                format!("installed but failed to enable {name}")
                            };
                            enable_msg = Some(note);
                        }
                    }
                    Err(e) => {
                        enable_msg = Some(format!("installed but enable failed: {e}"));
                    }
                }
            }
            Ok((stdout, stderr, true, enable_msg))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok, enable_msg) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to install plugin from {source}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    let mut message = stdout.chars().take(400).collect::<String>();
    if let Some(em) = enable_msg {
        if !message.is_empty() {
            message.push_str(" · ");
        }
        message.push_str(&em.chars().take(200).collect::<String>());
    }
    Ok(serde_json::json!({
        "ok": true,
        "name": enable_name.unwrap_or(source),
        "message": message,
    }))
}

/// Update one plugin by name, or all when `name` is null/empty (`aiko plugin update [name]`).
/// Soft-respawns agent on success.
#[tauri::command]
pub async fn plugin_update(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let target = normalize_plugin_update_name(name.as_deref());
    let target_for_cmd = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match target_for_cmd.as_deref() {
        Some(n) => run_aiko_cli_args(&["plugin", "update", n], PLUGIN_MUTATE_TIMEOUT_SECS),
        None => run_aiko_cli_args(&["plugin", "update"], PLUGIN_MUTATE_TIMEOUT_SECS),
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let label = target.as_deref().unwrap_or("all");
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to update plugin(s): {label}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": target.unwrap_or_default(),
        "message": stdout.chars().take(400).collect::<String>(),
    }))
}

// ── plugin validate (`aiko plugin validate [path]`) ─────────────────────────

/// Split stdout + stderr into non-empty lines (stderr first, de-duped).
pub fn parse_plugin_validate_messages(stdout: &str, stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in [stderr, stdout] {
        for line in part.lines() {
            let t = line.trim();
            if t.is_empty() || seen.contains(t) {
                continue;
            }
            seen.insert(t.to_string());
            out.push(t.to_string());
        }
    }
    out
}

/// Old CLI rejects `plugin validate` as an unknown subcommand (clap-style).
pub fn looks_like_unsupported_plugin_validate(stderr: &str, stdout: &str) -> bool {
    let s = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    if s.trim().is_empty() {
        return false;
    }
    if s.contains("unrecognized subcommand")
        || s.contains("unknown subcommand")
        || s.contains("unexpected subcommand")
        || s.contains("invalid subcommand")
    {
        return true;
    }
    if s.contains("validate")
        && (s.contains("unexpected argument")
            || s.contains("unrecognized")
            || s.contains("unknown command")
            || s.contains("unknown argument"))
    {
        return true;
    }
    false
}

/// True when `s` looks like a filesystem path (not a bare plugin name / owner/repo).
pub fn looks_like_plugin_validate_path(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.starts_with("git@") || s.contains("://") {
        return false;
    }
    if s.starts_with('/')
        || s.starts_with('~')
        || s.starts_with("./")
        || s.starts_with("../")
        || s.starts_with(".\\")
        || s.starts_with("..\\")
    {
        return true;
    }
    // Windows drive: C:\… or D:/…
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // Relative path segments with separators
    s.contains('/') || s.contains('\\')
}

/// Normalize optional path/name; empty → None (CLI defaults to `.`).
pub fn normalize_plugin_validate_target(path_or_name: Option<&str>) -> Option<String> {
    path_or_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Resolve bare plugin name to installed path via `plugin list --json` (best-effort).
fn resolve_installed_plugin_path(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let (stdout, _stderr, ok) =
        run_aiko_cli_args(&["plugin", "list", "--json"], PLUGIN_CMD_TIMEOUT_SECS).ok()?;
    if !ok || stdout.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let arr = value.as_array()?;
    // Prefer exact name match with a path; if several, first with path.
    let mut fallback: Option<String> = None;
    for item in arr {
        let n = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if n != name {
            continue;
        }
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        if let Some(p) = path {
            return Some(p);
        }
        if fallback.is_none() {
            fallback = Some(name.to_string());
        }
    }
    fallback
}

/// Resolve validate target: path as-is; bare name → installed path when known.
pub fn resolve_plugin_validate_path(path_or_name: Option<&str>) -> Option<String> {
    let raw = normalize_plugin_validate_target(path_or_name)?;
    if looks_like_plugin_validate_path(&raw) {
        return Some(raw);
    }
    // Bare name (or name@market) — strip @marketplace for list match
    let name = raw.split_once('@').map(|(l, _)| l).unwrap_or(&raw).trim();
    if name.is_empty() {
        return Some(raw);
    }
    resolve_installed_plugin_path(name).or(Some(if name == raw {
        raw
    } else {
        name.to_string()
    }))
}

/// Validate a plugin manifest via `aiko plugin validate [path]`.
///
/// - `path_or_name`: local path, installed plugin name, or omit (CLI default `.`)
/// - Always returns an envelope `{ ok, messages[] }` (never hard-fails on CLI-too-old)
/// - Soft-fail: older CLIs without `plugin validate` → `ok: false`, `reason: "cli_too_old"`
#[tauri::command]
pub async fn plugin_validate(
    path_or_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let path_or_name_owned = path_or_name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_plugin_validate_path(path_or_name_owned.as_deref());
        let run = match resolved.as_deref() {
            Some(p) => run_aiko_cli_args(
                &["plugin", "validate", p],
                PLUGIN_CMD_TIMEOUT_SECS,
            ),
            None => run_aiko_cli_args(&["plugin", "validate"], PLUGIN_CMD_TIMEOUT_SECS),
        };
        (resolved, run)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (resolved, run) = result;
    match run {
        Err(e) => {
            // CLI missing / spawn failure — surface as envelope so UI can show in-panel.
            let msg = e;
            let reason = if msg.to_ascii_lowercase().contains("not found") {
                Some("cli_missing")
            } else {
                None
            };
            Ok(serde_json::json!({
                "ok": false,
                "messages": [msg],
                "path": resolved,
                "reason": reason,
            }))
        }
        Ok((stdout, stderr, exit_ok)) => {
            if looks_like_unsupported_plugin_validate(&stderr, &stdout) {
                return Ok(serde_json::json!({
                    "ok": false,
                    "messages": [
                        format!(
                            "This Aiko CLI does not support `plugin validate`; version {} or newer is required. Run `aiko update`, then fully restart the app.",
                            crate::cli_probe::min_cli_version_str()
                        )
                    ],
                    "path": resolved,
                    "reason": "cli_too_old",
                }));
            }
            let messages = parse_plugin_validate_messages(&stdout, &stderr);
            let messages = if messages.is_empty() {
                if exit_ok {
                    vec!["Plugin manifest is valid.".to_string()]
                } else {
                    vec!["Plugin validation failed.".to_string()]
                }
            } else {
                messages
            };
            Ok(serde_json::json!({
                "ok": exit_ok,
                "messages": messages,
                "path": resolved,
                "reason": serde_json::Value::Null,
            }))
        }
    }
}

#[cfg(test)]
mod plugin_config_tests {
    use super::*;

    #[test]
    fn parse_disabled_single_line() {
        let toml = r#"
[plugins]
enabled = ["a", "b"]
disabled = ["chrome-devtools-mcp", "x"]
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("chrome-devtools-mcp"));
        assert!(set.contains("x"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_disabled_multiline() {
        let toml = r#"
[plugins]
enabled = [
    "cloudflare",
]
disabled = [
    "chrome-devtools-mcp",
    "playwright",
]

[marketplace]
foo = 1
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("chrome-devtools-mcp"));
        assert!(set.contains("playwright"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_disabled_empty() {
        let set = parse_plugins_disabled_names("[plugins]\ndisabled = []\n");
        assert!(set.is_empty());
    }

    #[test]
    fn parse_disabled_ignores_other_sections() {
        let toml = r#"
[other]
disabled = ["nope"]

[plugins]
disabled = ["yes"]
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("yes"));
        assert!(!set.contains("nope"));
    }

    #[test]
    fn matches_full_plugin_id_like_grok_build() {
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("user/a0b23c68/chrome-devtools-mcp".into());
        assert!(plugin_matches_disabled(
            "chrome-devtools-mcp",
            Some("chrome-devtools-mcp-a0b23c68"),
            &disabled
        ));
        assert!(!plugin_matches_disabled("other", None, &disabled));
    }

    #[test]
    fn list_json_keeps_cli_status_and_config_enabled() {
        let raw = r#"[
          {"status":"installed","name":"demo","repo_key":"demo-abc","version":"1.0.0","path":"/tmp/demo","source":"https://example.com/demo","marketplace":null}
        ]"#;
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("demo".into());
        let empty = std::collections::HashMap::new();
        let plugins = parse_plugin_list_json(raw, &disabled, &empty).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].status, "installed"); // CLI install status preserved
        assert!(!plugins[0].enabled); // config disabled
    }

    #[test]
    fn merges_inspect_scope_and_provides() {
        let raw = r#"[
          {"status":"installed","name":"superpowers","repo_key":"superpowers-599","version":"6.1.1","path":"/p/superpowers","source":"https://github.com/obra/superpowers","marketplace":null}
        ]"#;
        let disabled = std::collections::HashSet::new();
        let mut extra = std::collections::HashMap::new();
        extra.insert(
            "path:/p/superpowers".into(),
            InspectPluginExtra {
                scope: Some("user".into()),
                provides: Some(PluginProvidesDto {
                    skills: 14,
                    agents: 0,
                    hooks: true,
                    mcp_servers: 0,
                }),
            },
        );
        let plugins = parse_plugin_list_json(raw, &disabled, &extra).unwrap();
        assert_eq!(plugins[0].scope.as_deref(), Some("user"));
        assert_eq!(plugins[0].provides.as_ref().unwrap().skills, 14);
        assert!(plugins[0].provides.as_ref().unwrap().hooks);
        assert!(plugins[0].enabled);
    }

    #[test]
    fn normalize_install_source_trims_and_rejects_empty() {
        assert_eq!(
            normalize_plugin_install_source("  owner/repo  ").unwrap(),
            "owner/repo"
        );
        assert_eq!(
            normalize_plugin_install_source("https://github.com/a/b.git").unwrap(),
            "https://github.com/a/b.git"
        );
        assert_eq!(
            normalize_plugin_install_source("/tmp/my-plugin").unwrap(),
            "/tmp/my-plugin"
        );
        assert!(normalize_plugin_install_source("").is_err());
        assert!(normalize_plugin_install_source("   ").is_err());
    }

    #[test]
    fn plugin_name_from_install_source_variants() {
        assert_eq!(
            plugin_name_from_install_source("vercel@xAI Official").as_deref(),
            Some("vercel")
        );
        assert_eq!(
            plugin_name_from_install_source("vercel").as_deref(),
            Some("vercel")
        );
        assert_eq!(
            plugin_name_from_install_source("owner/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(
            plugin_name_from_install_source("owner/repo@v1").as_deref(),
            Some("repo")
        );
        // Monorepo subdir pin: prefer #fragment as enable name (ChatCut #codex).
        assert_eq!(
            plugin_name_from_install_source(
                "https://github.com/ChatCut-Inc/agent-plugin#codex"
            )
            .as_deref(),
            Some("codex")
        );
        assert_eq!(
            plugin_name_from_install_source("https://github.com/a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(
            plugin_name_from_install_source("git@github.com:a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(
            plugin_name_from_install_source("/tmp/my-plugin").as_deref(),
            Some("my-plugin")
        );
    }

    #[test]
    fn normalize_update_name_empty_means_all() {
        assert_eq!(
            normalize_plugin_update_name(Some("  chrome-devtools-mcp ")).as_deref(),
            Some("chrome-devtools-mcp")
        );
        assert_eq!(normalize_plugin_update_name(Some("")), None);
        assert_eq!(normalize_plugin_update_name(Some("   ")), None);
        assert_eq!(normalize_plugin_update_name(None), None);
    }

    #[test]
    fn parse_validate_messages_stderr_first_dedupe() {
        let msgs = parse_plugin_validate_messages(
            "Plugin manifest is valid.\n  name: demo\n",
            "  name: demo\n",
        );
        assert_eq!(
            msgs,
            vec![
                "name: demo".to_string(),
                "Plugin manifest is valid.".to_string()
            ]
        );
    }

    #[test]
    fn looks_like_unsupported_validate_clap() {
        assert!(looks_like_unsupported_plugin_validate(
            "error: unrecognized subcommand 'validate'\n\nUsage: aiko plugin …",
            ""
        ));
        assert!(looks_like_unsupported_plugin_validate(
            "error: unexpected argument 'validate' found",
            ""
        ));
        assert!(!looks_like_unsupported_plugin_validate(
            "Error: Not a directory: /nope",
            ""
        ));
        assert!(!looks_like_unsupported_plugin_validate(
            "Error: Failed to load manifest: missing field `name`",
            ""
        ));
    }

    #[test]
    fn looks_like_validate_path_variants() {
        assert!(looks_like_plugin_validate_path("/tmp/my-plugin"));
        assert!(looks_like_plugin_validate_path("~/code/plugin"));
        assert!(looks_like_plugin_validate_path("./plugin"));
        assert!(looks_like_plugin_validate_path("C:\\Users\\a\\plugin"));
        assert!(looks_like_plugin_validate_path("owner/repo")); // has slash → path-ish for CLI
        assert!(!looks_like_plugin_validate_path("chrome-devtools-mcp"));
        assert!(!looks_like_plugin_validate_path("https://github.com/a/b.git"));
        assert!(!looks_like_plugin_validate_path("git@github.com:a/b.git"));
    }

    #[test]
    fn normalize_validate_target_empty() {
        assert_eq!(normalize_plugin_validate_target(None), None);
        assert_eq!(normalize_plugin_validate_target(Some("")), None);
        assert_eq!(normalize_plugin_validate_target(Some("  ")), None);
        assert_eq!(
            normalize_plugin_validate_target(Some("  /tmp/p  ")).as_deref(),
            Some("/tmp/p")
        );
    }
}
