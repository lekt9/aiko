//! Durable generative UI store under ~/.aiko/ui — **contract-native**.
//!
//! Layout:
//!   ~/.aiko/ui/index.jsonl
//!   ~/.aiko/ui/by-id/<id>/{meta,spec,state,bindings}.json
//!   ~/.aiko/ui/data/<hh>/<sha256>.json
//!   ~/.aiko/ui/routes.json
//!   ~/.aiko/ui/catalog/<Type>.json   (registry component definitions)
//!
//! Pointers:
//!   aiko:ui/<id>
//!   aiko:ui/<id>/spec|state|bindings|meta
//!   aiko:data/<sha256>
//!
//! Contract integration:
//!   - Spec is content-addressed (`aiko:data/<digest>`) so identical surfaces
//!     collapse to one id and re-retrieve the same pointer.
//!   - On put we append ledger rows with action `ui.resolve {…}` (dot binary,
//!     no `shell:` prefix) so `contract recommend` can rank & retrieve them
//!     the same way as `application.snapshot` proven usage.
//!   - Optional `contract task begin/verify` for check-path evidence.
//!   - Catalog types (Card, Table, …) are seeded as `aiko:ui/catalog-<Type>`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiComponentMeta {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    pub spec_digest: String,
    /// Content-addressed pointer to the immutable spec blob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_pointer: Option<String>,
    /// Plan text used for recommend / rank (ui:Title tags …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Proven retrieve command (ui.resolve JSON).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiIndexEntry {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub updated_at: String,
    pub pointer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPutRequest {
    pub title: String,
    pub spec: Value,
    #[serde(default)]
    pub state: Value,
    #[serde(default)]
    pub bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub contract_id: Option<String>,
    /// When true (default), register on the contract ledger for recommend.
    #[serde(default = "default_true")]
    pub register_contract: Option<bool>,
}

fn default_true() -> Option<bool> {
    Some(true)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRankHit {
    pub id: String,
    pub title: String,
    pub pointer: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    pub tags: Vec<String>,
    /// Proven retrieve command for agents / recommend.
    pub action: String,
}

fn home_ui_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory not found".to_string())?;
    Ok(home.join(".aiko").join("ui"))
}

fn contracts_ledger_path() -> Result<PathBuf, String> {
    // Prefer cwd-local ledger when in a repo with .claude; else global.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let local = cwd.join(".claude").join("contracts.jsonl");
    if cwd.join(".claude").is_dir() {
        return Ok(local);
    }
    let home = dirs::home_dir().ok_or_else(|| "home directory not found".to_string())?;
    Ok(home.join(".contracts").join("contracts.jsonl"))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("mkdir {}: {e}", path.display()))
}

fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // ISO-ish without chrono
    format!("{secs}")
}

fn now_iso() -> String {
    // Enough for ledger ts field
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Content-addressed id from spec digest — same UI re-retrieves same pointer.
fn id_from_spec_digest(digest: &str) -> String {
    format!("ui-{}", &digest[..12.min(digest.len())])
}

fn short_contract_id(seed: &str) -> String {
    let h = sha256_hex(seed.as_bytes());
    h[..8].to_string()
}

fn component_dir(root: &Path, id: &str) -> PathBuf {
    root.join("by-id").join(id)
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn put_data_blob(root: &Path, value: &Value) -> Result<String, String> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let digest = sha256_hex(&body);
    let dir = root.join("data").join(&digest[..2]);
    ensure_dir(&dir)?;
    let path = dir.join(format!("{digest}.json"));
    if !path.exists() {
        fs::write(&path, &body).map_err(|e| format!("write data blob: {e}"))?;
    }
    Ok(format!("aiko:data/{digest}"))
}

fn get_data_blob(root: &Path, digest: &str) -> Result<Value, String> {
    if digest.len() < 4 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid data digest".into());
    }
    let path = root
        .join("data")
        .join(&digest[..2])
        .join(format!("{digest}.json"));
    read_json(&path)
}

fn append_index(root: &Path, entry: &UiIndexEntry) -> Result<(), String> {
    ensure_dir(root)?;
    let path = root.join("index.jsonl");
    let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open index: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("append index: {e}"))
}

fn load_index(root: &Path) -> Result<Vec<UiIndexEntry>, String> {
    let path = root.join("index.jsonl");
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut map: BTreeMap<String, UiIndexEntry> = BTreeMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<UiIndexEntry>(line) {
            map.insert(entry.id.clone(), entry);
        }
    }
    let mut items: Vec<_> = map.into_values().collect();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

fn update_routes(root: &Path, route: &str, id: &str) -> Result<(), String> {
    let path = root.join("routes.json");
    let mut routes: BTreeMap<String, String> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        BTreeMap::new()
    };
    routes.insert(route.to_string(), id.to_string());
    write_json(&path, &serde_json::to_value(routes).map_err(|e| e.to_string())?)
}

fn load_component(root: &Path, id: &str) -> Result<Value, String> {
    let dir = component_dir(root, id);
    if !dir.exists() {
        return Err(format!("ui component not found: {id}"));
    }
    let meta = read_json(&dir.join("meta.json"))?;
    let spec = read_json(&dir.join("spec.json"))?;
    let state = read_json(&dir.join("state.json")).unwrap_or_else(|_| json!({}));
    let bindings = read_json(&dir.join("bindings.json")).unwrap_or_else(|_| json!({}));
    Ok(json!({
        "meta": meta,
        "spec": spec,
        "state": state,
        "bindings": bindings,
    }))
}

fn materialize_state(
    root: &Path,
    state: &Value,
    bindings: &BTreeMap<String, String>,
) -> Result<Value, String> {
    let mut out = state.clone();
    if !out.is_object() {
        out = json!({});
    }
    let obj = out.as_object_mut().unwrap();
    for (path, pointer) in bindings {
        let key = path.trim_start_matches('/');
        if key.is_empty() {
            continue;
        }
        let top = key.split('/').next().unwrap_or(key);
        if let Some(v) = resolve_pointer_value(root, pointer)? {
            obj.insert(top.to_string(), v);
        }
    }
    Ok(out)
}

fn resolve_pointer_value(root: &Path, pointer: &str) -> Result<Option<Value>, String> {
    let pointer = pointer.trim();
    if let Some(rest) = pointer.strip_prefix("aiko:data/") {
        let digest = rest.split('#').next().unwrap_or(rest);
        return Ok(Some(get_data_blob(root, digest)?));
    }
    if let Some(rest) = pointer.strip_prefix("aiko:ui/") {
        let (id_part, frag) = match rest.split_once('#') {
            Some((a, b)) => (a, Some(b)),
            None => (rest, None),
        };
        let mut parts = id_part.split('/');
        let id = parts.next().unwrap_or("");
        if id.is_empty() {
            return Err("empty ui id".into());
        }
        let field = parts.next().unwrap_or("");
        let component = load_component(root, id)?;
        let value = if field.is_empty() {
            component
        } else {
            component
                .get(field)
                .cloned()
                .ok_or_else(|| format!("unknown ui field: {field}"))?
        };
        if let Some(fragment) = frag {
            let path = fragment.trim_start_matches('/');
            let mut cur = &value;
            for seg in path.split('/').filter(|s| !s.is_empty()) {
                cur = cur
                    .get(seg)
                    .ok_or_else(|| format!("fragment not found: {fragment}"))?;
            }
            return Ok(Some(cur.clone()));
        }
        return Ok(Some(value));
    }
    if pointer.starts_with('{') || pointer.starts_with('[') {
        return Ok(Some(
            serde_json::from_str(pointer).map_err(|e| e.to_string())?,
        ));
    }
    Ok(None)
}

fn build_plan(title: &str, tags: &[String], description: Option<&str>) -> String {
    let mut parts = vec![format!("ui:{title}")];
    if let Some(d) = description {
        if !d.is_empty() {
            parts.push(d.to_string());
        }
    }
    for t in tags {
        if !t.is_empty() {
            parts.push(t.clone());
        }
    }
    parts.join(" ")
}

fn build_action(id: &str) -> String {
    // Dot binary (not colon) so contract recommend does not filter it.
    format!(
        "ui.resolve {{\"pointer\":\"aiko:ui/{id}\",\"id\":\"{id}\"}}"
    )
}

/// Append declared+satisfied ledger rows so `contract recommend` can rank UI.
fn register_on_ledger(plan: &str, action: &str, proof: &str) -> Result<String, String> {
    let id = short_contract_id(&format!("{plan}|{action}|{proof}"));
    let path = contracts_ledger_path()?;
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let ts = now_iso();
    let declared = json!({
        "event": "declared",
        "id": id,
        "plan": plan,
        "action": action,
        "pointer_type": "cli",
        "layer": 2,
        "cwd": std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".into()),
        "parent_id": null,
        "synapses": [],
        "ts": ts,
        "agent": "aiko-desktop",
        "availability": "runtime_loaded",
        "permission": "read",
    });
    let satisfied = json!({
        "event": "satisfied",
        "id": id,
        "wave": 0,
        "ts": ts,
        "proof": proof,
        "agent": "aiko-desktop",
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open ledger {}: {e}", path.display()))?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&declared).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&satisfied).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;

    // Best-effort: also register a checkable task row for evidence trails.
    let check_path = dirs::home_dir()
        .map(|h| {
            h.join(".aiko")
                .join("ui")
                .join("by-id")
                .join(proof.trim_start_matches("aiko:ui/"))
                .join("spec.json")
        })
        .unwrap_or_else(|| PathBuf::from("spec.json"));
    let _ = Command::new("contract")
        .args([
            "task",
            "begin",
            plan,
            "--check",
            &format!("test -f {}", check_path.display()),
        ])
        .output();

    Ok(id)
}

/// Keyword rank (capability_cells-style priors) over UI index plans/titles/tags.
fn rank_score(query: &str, entry: &UiIndexEntry) -> f64 {
    let q = query.to_lowercase();
    let tokens: Vec<&str> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 1)
        .collect();
    if tokens.is_empty() {
        return 0.0;
    }
    let hay = format!(
        "{} {} {} {} {}",
        entry.title,
        entry.plan.clone().unwrap_or_default(),
        entry.tags.join(" "),
        entry.route.clone().unwrap_or_default(),
        entry.pointer
    )
    .to_lowercase();
    let mut score = 0.05_f64;
    for tok in &tokens {
        if hay.contains(tok) {
            score += if tok.contains(' ') { 0.55 } else { 0.42 };
        }
    }
    // Phrase bonus
    if hay.contains(&q) {
        score += 0.35;
    }
    score.min(0.99)
}

const CATALOG_TYPES: &[(&str, &str, &str)] = &[
    ("Stack", "Flex layout container row/column gap align", "layout flex"),
    ("Grid", "Responsive grid columns gap for dashboard cards", "layout grid dashboard"),
    ("Card", "Surface card title description tone with children", "surface panel"),
    ("Heading", "Section heading text level", "typography title"),
    ("Text", "Body paragraph content muted", "typography prose"),
    ("Metric", "KPI metric label value delta trend hint", "kpi dashboard number"),
    ("Badge", "Status pill label tone", "status tag"),
    ("Progress", "Progress bar value max label", "meter bar"),
    ("List", "Bullet or ordered list of strings", "items bullets playlist"),
    ("Table", "Data table columns rows caption", "grid data playlist tracks"),
    ("BarChart", "Horizontal bar chart labels values", "chart series"),
    ("Divider", "Visual separator optional label", "separator"),
    ("Button", "Interactive button label variant", "action press"),
    ("Code", "Monospace code block content language", "code snippet"),
    ("Callout", "Highlighted notice title content tone", "notice alert"),
    ("Tabs", "Tab strip tabs activeId", "navigation tabs"),
];

fn seed_catalog(root: &Path) -> Result<usize, String> {
    let cat_dir = root.join("catalog");
    ensure_dir(&cat_dir)?;
    let mut n = 0;
    for (name, desc, keywords) in CATALOG_TYPES {
        let id = format!("catalog-{name}");
        let dir = component_dir(root, &id);
        if dir.exists() {
            continue;
        }
        let spec = json!({
            "root": "root",
            "elements": {
                "root": {
                    "type": "Callout",
                    "props": {
                        "title": name,
                        "content": desc,
                        "tone": "info"
                    }
                }
            }
        });
        let spec_bytes = serde_json::to_vec(&spec).map_err(|e| e.to_string())?;
        let digest = sha256_hex(&spec_bytes);
        let spec_ptr = put_data_blob(root, &spec)?;
        let tags: Vec<String> = keywords
            .split_whitespace()
            .map(|s| s.to_string())
            .chain(std::iter::once("catalog".into()))
            .chain(std::iter::once("component".into()))
            .collect();
        let plan = build_plan(
            &format!("catalog {name}"),
            &tags,
            Some(desc),
        );
        let action = build_action(&id);
        let contract_id = register_on_ledger(&plan, &action, &format!("aiko:ui/{id}")).ok();
        let now = now_rfc3339();
        let meta = UiComponentMeta {
            id: id.clone(),
            title: format!("Catalog · {name}"),
            description: Some((*desc).to_string()),
            tags: tags.clone(),
            workspace: None,
            contract_id: contract_id.clone(),
            spec_digest: digest.clone(),
            spec_pointer: Some(spec_ptr),
            plan: Some(plan.clone()),
            action: Some(action),
            created_at: now.clone(),
            updated_at: now.clone(),
            route: Some(format!("/ui/catalog/{name}")),
        };
        ensure_dir(&dir)?;
        write_json(&dir.join("meta.json"), &serde_json::to_value(&meta).unwrap())?;
        write_json(&dir.join("spec.json"), &spec)?;
        write_json(&dir.join("state.json"), &json!({}))?;
        write_json(&dir.join("bindings.json"), &json!({}))?;
        // Also human-readable catalog def
        write_json(
            &cat_dir.join(format!("{name}.json")),
            &json!({
                "type": name,
                "description": desc,
                "keywords": keywords,
                "pointer": format!("aiko:ui/{id}"),
                "contractId": contract_id,
            }),
        )?;
        append_index(
            root,
            &UiIndexEntry {
                id: id.clone(),
                title: meta.title.clone(),
                route: meta.route.clone(),
                tags,
                workspace: None,
                updated_at: now,
                pointer: format!("aiko:ui/{id}"),
                contract_id,
                plan: Some(plan),
                spec_digest: Some(digest),
            },
        )?;
        n += 1;
    }
    Ok(n)
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[command]
pub fn ui_store_list(workspace: Option<String>) -> Result<Vec<UiIndexEntry>, String> {
    let root = home_ui_root()?;
    let _ = seed_catalog(&root);
    let mut items = load_index(&root)?;
    if let Some(ws) = workspace {
        items.retain(|e| e.workspace.as_deref() == Some(ws.as_str()) || e.workspace.is_none());
    }
    Ok(items)
}

#[command]
pub fn ui_store_get(id: String) -> Result<Value, String> {
    let root = home_ui_root()?;
    let mut component = load_component(&root, &id)?;
    let state = component.get("state").cloned().unwrap_or(json!({}));
    let bindings_val = component.get("bindings").cloned().unwrap_or(json!({}));
    let bindings: BTreeMap<String, String> =
        serde_json::from_value(bindings_val).unwrap_or_default();
    let material = materialize_state(&root, &state, &bindings)?;
    if let Some(obj) = component.as_object_mut() {
        obj.insert("state".into(), material);
    }
    Ok(component)
}

#[command]
pub fn ui_store_put(request: UiPutRequest) -> Result<Value, String> {
    let root = home_ui_root()?;
    ensure_dir(&root)?;
    ensure_dir(&root.join("by-id"))?;
    ensure_dir(&root.join("data"))?;
    let _ = seed_catalog(&root);

    let spec_bytes = serde_json::to_vec(&request.spec).map_err(|e| e.to_string())?;
    let spec_digest = sha256_hex(&spec_bytes);
    let spec_pointer = put_data_blob(&root, &request.spec)?;

    let id = request
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id_from_spec_digest(&spec_digest));

    let dir = component_dir(&root, &id);
    let existing_created = dir
        .join("meta.json")
        .exists()
        .then(|| read_json(&dir.join("meta.json")).ok())
        .flatten()
        .and_then(|m| {
            m.get("createdAt")
                .or_else(|| m.get("created_at"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        });
    let existing_contract = dir
        .join("meta.json")
        .exists()
        .then(|| read_json(&dir.join("meta.json")).ok())
        .flatten()
        .and_then(|m| {
            m.get("contractId")
                .or_else(|| m.get("contract_id"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        });

    let now = now_rfc3339();
    let state = if request.state.is_null() {
        json!({})
    } else {
        request.state.clone()
    };
    let mut bindings = request.bindings.clone();
    // Bind the content-addressed spec itself
    bindings
        .entry("/__spec".into())
        .or_insert_with(|| spec_pointer.clone());
    if !state.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        let data_ptr = put_data_blob(&root, &state)?;
        bindings
            .entry("/".into())
            .or_insert_with(|| data_ptr.clone());
        bindings
            .entry("/__snapshot".into())
            .or_insert(data_ptr);
    }

    let mut tags = request.tags.clone();
    if !tags.iter().any(|t| t == "generative") {
        tags.push("generative".into());
    }
    // Extract component types used for ranking keywords
    if let Some(elements) = request.spec.get("elements").and_then(|e| e.as_object()) {
        for el in elements.values() {
            if let Some(t) = el.get("type").and_then(|v| v.as_str()) {
                let tag = t.to_lowercase();
                if !tags.iter().any(|x| x.eq_ignore_ascii_case(&tag)) {
                    tags.push(tag);
                }
            }
        }
    }

    let plan = build_plan(
        &request.title,
        &tags,
        request.description.as_deref(),
    );
    let action = build_action(&id);
    let pointer = format!("aiko:ui/{id}");

    let do_register = request.register_contract.unwrap_or(true);
    let contract_id = if let Some(c) = request.contract_id.clone().or(existing_contract) {
        Some(c)
    } else if do_register {
        register_on_ledger(&plan, &action, &pointer).ok()
    } else {
        None
    };

    let meta = UiComponentMeta {
        id: id.clone(),
        title: request.title.clone(),
        description: request.description.clone(),
        tags: tags.clone(),
        workspace: request.workspace.clone(),
        contract_id: contract_id.clone(),
        spec_digest: spec_digest.clone(),
        spec_pointer: Some(spec_pointer.clone()),
        plan: Some(plan.clone()),
        action: Some(action.clone()),
        created_at: existing_created.unwrap_or_else(|| now.clone()),
        updated_at: now.clone(),
        route: request.route.clone(),
    };

    ensure_dir(&dir)?;
    write_json(&dir.join("meta.json"), &serde_json::to_value(&meta).unwrap())?;
    write_json(&dir.join("spec.json"), &request.spec)?;
    write_json(&dir.join("state.json"), &state)?;
    write_json(
        &dir.join("bindings.json"),
        &serde_json::to_value(&bindings).unwrap(),
    )?;

    if let Some(route) = &request.route {
        update_routes(&root, route, &id)?;
    }

    let entry = UiIndexEntry {
        id: id.clone(),
        title: request.title,
        route: request.route,
        tags,
        workspace: request.workspace,
        updated_at: now,
        pointer: pointer.clone(),
        contract_id: contract_id.clone(),
        plan: Some(plan.clone()),
        spec_digest: Some(spec_digest.clone()),
    };
    append_index(&root, &entry)?;

    let check_path = dir.join("spec.json");
    Ok(json!({
        "meta": meta,
        "pointer": pointer,
        "checkPath": check_path.to_string_lossy(),
        "specDigest": spec_digest,
        "specPointer": spec_pointer,
        "bindings": bindings,
        "plan": plan,
        "action": action,
        "contractId": contract_id,
    }))
}

#[command]
pub fn ui_store_put_data(value: Value) -> Result<Value, String> {
    let root = home_ui_root()?;
    ensure_dir(&root.join("data"))?;
    let pointer = put_data_blob(&root, &value)?;
    Ok(json!({ "pointer": pointer }))
}

#[command]
pub fn ui_store_resolve(pointer: String) -> Result<Value, String> {
    let root = home_ui_root()?;
    match resolve_pointer_value(&root, &pointer)? {
        Some(value) => {
            let kind = if pointer.starts_with("aiko:ui/") {
                "ui"
            } else if pointer.starts_with("aiko:data/") {
                "data"
            } else {
                "fragment"
            };
            Ok(json!({
                "pointer": pointer,
                "kind": kind,
                "value": value,
            }))
        }
        None => Ok(json!({
            "pointer": pointer,
            "kind": "missing",
        })),
    }
}

#[command]
pub fn ui_store_routes() -> Result<Value, String> {
    let root = home_ui_root()?;
    let path = root.join("routes.json");
    if !path.exists() {
        return Ok(json!({}));
    }
    read_json(&path)
}

#[command]
pub fn ui_store_root() -> Result<String, String> {
    home_ui_root().map(|p| p.to_string_lossy().to_string())
}

/// Rank stored surfaces for a goal — same pull/rank/retrieve shape as contract recommend.
#[command]
pub fn ui_store_rank(query: String, limit: Option<usize>) -> Result<Vec<UiRankHit>, String> {
    let root = home_ui_root()?;
    let _ = seed_catalog(&root);
    let items = load_index(&root)?;
    let lim = limit.unwrap_or(8).max(1).min(50);
    let mut scored: Vec<UiRankHit> = items
        .into_iter()
        .map(|e| {
            let score = rank_score(&query, &e);
            let action = build_action(&e.id);
            UiRankHit {
                id: e.id,
                title: e.title,
                pointer: e.pointer,
                score,
                plan: e.plan,
                contract_id: e.contract_id,
                route: e.route,
                tags: e.tags,
                action,
            }
        })
        .filter(|h| h.score > 0.1)
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(lim);
    Ok(scored)
}

/// Ensure catalog component types are contract-registered; returns count seeded.
#[command]
pub fn ui_store_seed_catalog() -> Result<Value, String> {
    let root = home_ui_root()?;
    let n = seed_catalog(&root)?;
    Ok(json!({ "seeded": n, "types": CATALOG_TYPES.len() }))
}
