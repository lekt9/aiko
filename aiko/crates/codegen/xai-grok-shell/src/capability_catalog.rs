//! FECH adapters for Aiko's four capability inventories.
//!
//! This module deliberately emits capability facts only. Paths, URLs,
//! credentials, examples, prompts, arguments, results, and mutable usage data
//! never appear in a descriptor.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use xai_grok_tools::types::definition::ToolDefinition;

const MAX_DESCRIPTION: usize = 512;
const MAX_SKILL_BYTES: u64 = 512 * 1024;
const MAX_UNBROWSE_SKILL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BINARY_DIRECTORIES: usize = 64;
const MAX_BINARY_CAPABILITIES: usize = 1_024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CapabilityDescriptor {
    pub schema_version: u8,
    pub id: String,
    pub capability_version: String,
    pub provider: String,
    pub tool: String,
    pub action: String,
    pub description: String,
    pub input_schema: Map<String, Value>,
    pub output_schema: Map<String, Value>,
    pub requires: Vec<String>,
    pub permission: Permission,
    pub effects: Vec<Effect>,
    /// Limb-cell roles this capability explicitly declares it can fill.
    /// Roles are declared by the adapter that owns the capability, never
    /// inferred from names or descriptions. An empty list means the
    /// capability can never be composed into a self-growing limb cell.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<CellRole>,
    pub available: bool,
}

/// A position in the receptor → predictor → planner → executor → sensor
/// limb sequence. Declared explicitly on each capability descriptor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CellRole {
    Receptor,
    Predictor,
    Planner,
    Executor,
    Sensor,
}

impl CellRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            CellRole::Receptor => "receptor",
            CellRole::Predictor => "predictor",
            CellRole::Planner => "planner",
            CellRole::Executor => "executor",
            CellRole::Sensor => "sensor",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Read,
    Write,
    Network,
    Purchase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    ReadOnly,
    LocalWrite,
    NetworkRead,
    NetworkWrite,
    MessageSend,
    Purchase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CapabilityAvailability {
    pub capability_id: String,
    pub capability_version: String,
    pub available: bool,
    pub reason: AvailabilityReason,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AvailabilityReason {
    Ready,
    ProviderDisconnected,
    RouteUnavailable,
    PermissionUnavailable,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CapabilityObservation {
    pub schema_version: u8,
    pub capability_id: String,
    pub capability_version: String,
    pub success: bool,
    pub duration_ms: u64,
    pub permission_result: PermissionResult,
    pub error_class: Option<ObservationError>,
    pub result_shape: ResultShape,
    pub observed_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionResult {
    Allowed,
    Denied,
    NotRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservationError {
    PermissionDenied,
    ProviderUnavailable,
    Timeout,
    InvalidInput,
    ProviderFailure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResultShape {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object,
}

#[derive(Debug, Clone)]
pub struct CatalogSnapshot {
    pub source: String,
    pub descriptors: Vec<CapabilityDescriptor>,
    pub availability: Vec<CapabilityAvailability>,
}

/// Provenance attached to code or research discovered outside the machine.
/// Discovery is not installation: remote artifacts remain quarantined until a
/// pinned revision, compatible license, isolated build, and independent
/// witness are recorded locally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExternalArtifactCandidate {
    pub registry: ExternalRegistry,
    pub stable_id: String,
    pub revision: String,
    pub title: String,
    pub summary: String,
    pub license: Option<String>,
    pub artifact_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalRegistry {
    Github,
    Arxiv,
}

/// Convert FECH's private local descriptor into Contract's deliberately
/// smaller public shape. Execution strings, paths, examples, availability,
/// arguments, and provider-specific values are never copied across this gate.
pub fn collective_candidate(
    descriptor: &CapabilityDescriptor,
    publisher: &str,
    sequence: u64,
    created_at: &str,
    expires_at: &str,
) -> Value {
    let public_read = descriptor
        .effects
        .iter()
        .all(|effect| matches!(effect, Effect::ReadOnly | Effect::NetworkRead));
    let permission = if public_read && descriptor.effects.contains(&Effect::NetworkRead) {
        "network"
    } else if public_read {
        "read"
    } else {
        // Contract's closed enum rejects this at stage two. Keeping an
        // explicit invalid value avoids accidentally downgrading a mutation.
        "mutation"
    };
    let effects: Vec<&str> = descriptor
        .effects
        .iter()
        .map(|effect| match effect {
            Effect::ReadOnly => "read_only",
            Effect::NetworkRead => "network_read",
            _ => "mutation",
        })
        .collect();
    let origin = descriptor
        .provider
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-') {
                ch
            } else {
                '.'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_owned();
    let operation = descriptor
        .id
        .rsplit('.')
        .next()
        .map(segment)
        .unwrap_or_else(|| "invoke".into());
    json!({
        "protocol": "aiko-collective/1",
        "kind": "capability",
        "publisher": publisher,
        "sequence": sequence,
        "created_at": created_at,
        "expires_at": expires_at,
        "payload": {
            "capability_id": descriptor.id,
            "capability_version": descriptor.capability_version,
            "origin": if origin.is_empty() { "aiko.local" } else { origin.as_str() },
            "operation": operation,
            "summary": descriptor.description,
            "input_shape": collective_shape(&descriptor.input_schema),
            "output_shape": collective_shape(&descriptor.output_schema),
            "permission": permission,
            "effects": effects,
            "requires": [],
            "sanitizer_version": 1
        }
    })
}

fn collective_shape(schema: &Map<String, Value>) -> Value {
    let required: BTreeSet<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return json!({});
    };
    Value::Object(
        properties
            .iter()
            .take(128)
            .filter_map(|(name, definition)| {
                if sensitive_schema_name(name) {
                    return None;
                }
                let kind = definition
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("object");
                let kind = match kind {
                    "null" | "boolean" | "integer" | "number" | "string" | "array" | "object" => {
                        kind
                    }
                    _ => "object",
                };
                let mut field = serde_json::Map::new();
                field.insert("type".into(), Value::String(kind.into()));
                field.insert(
                    "required".into(),
                    Value::Bool(required.contains(name.as_str())),
                );
                if kind == "array" {
                    let item_kind = definition
                        .get("items")
                        .and_then(|items| items.get("type"))
                        .and_then(Value::as_str)
                        .filter(|kind| {
                            matches!(
                                *kind,
                                "null" | "boolean" | "integer" | "number" | "string" | "object"
                            )
                        })
                        .unwrap_or("object");
                    field.insert("items_type".into(), Value::String(item_kind.into()));
                }
                Some((segment(name), Value::Object(field)))
            })
            .collect(),
    )
}

pub fn preview_collective_snapshot(
    snapshot: &CatalogSnapshot,
    contract: &xai_aiko_collective::CollectiveContract,
    controller: xai_aiko_collective::PublicationController,
    publisher: &str,
    created_at: &str,
    expires_at: &str,
) -> Vec<(
    String,
    Result<xai_aiko_collective::PublicationPreview, xai_aiko_collective::CollectiveError>,
)> {
    snapshot
        .descriptors
        .iter()
        .enumerate()
        .map(|(index, descriptor)| {
            let candidate =
                collective_candidate(descriptor, publisher, index as u64, created_at, expires_at);
            let bytes =
                serde_json::to_vec(&candidate).expect("collective candidate is JSON serializable");
            (descriptor.id.clone(), controller.preview(contract, &bytes))
        })
        .collect()
}

/// Split the model-visible tool inventory into Aiko-native and MCP provider
/// snapshots. MCP names use the runtime's canonical `server__tool` identity.
pub fn normalize_tool_definitions(tools: &[ToolDefinition]) -> Vec<CatalogSnapshot> {
    let mut by_source: BTreeMap<String, Vec<CapabilityDescriptor>> = BTreeMap::new();
    for definition in tools {
        let qualified = definition.function.name.as_str();
        let (source, tool) = match qualified.split_once("__") {
            Some((server, tool)) if !server.is_empty() && !tool.is_empty() => {
                (format!("mcp:{}", segment(server)), segment(tool))
            }
            _ => ("aiko".to_owned(), segment(qualified)),
        };
        let action = "invoke".to_owned();
        let (permission, effects) = infer_tool_effects(qualified);
        let input_schema = object_or_empty(definition.function.parameters.clone());
        let description = bounded_description(
            definition
                .function
                .description
                .as_deref()
                .unwrap_or("Invoke this Aiko capability."),
        );
        let id = format!("{}.{}.{}", source, tool, action);
        let version = semantic_version(&[
            qualified.as_bytes(),
            serde_json::to_string(&input_schema)
                .unwrap_or_default()
                .as_bytes(),
            format!("{permission:?}{effects:?}").as_bytes(),
        ]);
        by_source
            .entry(source.clone())
            .or_default()
            .push(CapabilityDescriptor {
                schema_version: 1,
                id,
                capability_version: version,
                provider: source,
                tool,
                action,
                description,
                input_schema,
                output_schema: object_or_empty(json!({ "type": "object" })),
                requires: Vec::new(),
                permission,
                effects,
                // Tool definitions carry no role declarations yet; the
                // registration-time declaration surface is a follow-up.
                // Until then tools inform the deliberate node but never
                // bind as limb cells.
                roles: Vec::new(),
                available: true,
            });
    }
    by_source
        .into_iter()
        .map(|(source, descriptors)| snapshot(source, descriptors, AvailabilityReason::Ready))
        .collect()
}

/// Discover installed `SKILL.md` metadata without copying skill prose or
/// filesystem paths into Contract. Skills remain instructions, not direct
/// executable interfaces; the action is Aiko's existing `use_skill` dispatch.
pub fn discover_skill_snapshot(cwd: &Path) -> CatalogSnapshot {
    let mut roots = vec![
        cwd.join(".aiko/skills"),
        cwd.join(".agents/skills"),
        cwd.join(".claude/skills"),
        cwd.join(".grok/skills"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.extend([
            home.join(".aiko/skills"),
            home.join(".agents/skills"),
            home.join(".claude/skills"),
            home.join(".grok/skills"),
        ]);
    }
    normalize_skill_paths(&roots)
}

/// Index executable names as private, conservatively mutating local
/// capabilities. Discovery never runs a binary, reads its contents, or puts a
/// filesystem path in FECH/Collective metadata. Normal permission checks still
/// apply when the existing terminal adapter executes one.
pub fn discover_binary_snapshot(command_tool: Option<&str>) -> CatalogSnapshot {
    let roots = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .take(MAX_BINARY_DIRECTORIES)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    normalize_binary_paths(&roots, command_tool)
}

pub fn normalize_binary_paths(roots: &[PathBuf], command_tool: Option<&str>) -> CatalogSnapshot {
    let mut names = BTreeSet::new();
    for root in roots.iter().take(MAX_BINARY_DIRECTORIES) {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten().take(MAX_BINARY_CAPABILITIES) {
            if names.len() == MAX_BINARY_CAPABILITIES {
                break;
            }
            let path = entry.path();
            if !path.is_file() || !is_executable(&path) {
                continue;
            }
            let Some(raw_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let command = executable_command_name(raw_name);
            if safe_cli_id(command) {
                names.insert(command.to_owned());
            }
        }
    }
    let descriptors = names
        .into_iter()
        .map(|command| {
            let id = format!("binary.{}.invoke", segment(&command));
            CapabilityDescriptor {
                schema_version: 1,
                capability_version: semantic_version(&[command.as_bytes(), b"local-binary-v1"]),
                id,
                provider: "binary".into(),
                tool: command_tool.unwrap_or("Bash").into(),
                action: command.clone(),
                description: format!("Run the locally installed {command} command."),
                input_schema: object_or_empty(json!({
                    "type": "object",
                    "properties": { "arguments": { "type": "array", "items": { "type": "string" } } }
                })),
                output_schema: object_or_empty(json!({ "type": "object" })),
                requires: Vec::new(),
                permission: Permission::Write,
                effects: vec![Effect::LocalWrite],
                // A binary capability IS an action route: it runs a local
                // command as the limb's effect.
                roles: vec![CellRole::Executor],
                available: command_tool.is_some(),
            }
        })
        .collect();
    snapshot(
        "binary".into(),
        descriptors,
        if command_tool.is_some() {
            AvailabilityReason::Ready
        } else {
            AvailabilityReason::PermissionUnavailable
        },
    )
}

fn executable_command_name(name: &str) -> &str {
    #[cfg(windows)]
    for suffix in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(command) = name.strip_suffix(suffix) {
            return command;
        }
    }
    name
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "exe" | "cmd" | "bat" | "ps1"
                )
            })
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.is_file()
    }
}

pub fn normalize_skill_paths(roots: &[PathBuf]) -> CatalogSnapshot {
    let mut descriptors = BTreeMap::<String, CapabilityDescriptor>::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(root)
            .max_depth(4)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_SKILL_BYTES {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let fields = frontmatter(&contents);
            let fallback = entry
                .path()
                .parent()
                .and_then(Path::file_name)
                .and_then(|v| v.to_str())
                .unwrap_or("skill");
            let name = segment(fields.get("name").map(String::as_str).unwrap_or(fallback));
            let description = bounded_description(
                fields
                    .get("description")
                    .map(String::as_str)
                    .unwrap_or("Use this installed Aiko skill."),
            );
            let tool = "Skill".to_owned();
            let action = name.clone();
            let id = format!("skill.skill.{}", action);
            // Skill prose is guidance, not an executable ABI. Wording-only
            // edits therefore do not invalidate its identity/evidence.
            let version = semantic_version(&[name.as_bytes(), b"skill-guidance-v1"]);
            descriptors
                .entry(id.clone())
                .or_insert(CapabilityDescriptor {
                    schema_version: 1,
                    id,
                    capability_version: version,
                    provider: "skill".to_owned(),
                    tool,
                    action,
                    description,
                    input_schema: object_or_empty(json!({ "type": "object", "properties": {} })),
                    output_schema: object_or_empty(json!({ "type": "object" })),
                    requires: Vec::new(),
                    permission: Permission::Read,
                    effects: vec![Effect::ReadOnly],
                    // Skill prose is guidance for the deliberate node, not
                    // an executable ABI — it never binds as a limb cell.
                    roles: Vec::new(),
                    available: true,
                });
        }
    }
    snapshot(
        "skill".to_owned(),
        descriptors.into_values().collect(),
        AvailabilityReason::Ready,
    )
}

/// Normalize the locally-owned Unbrowse route cache. Cache paths and endpoint
/// URLs are used only to read route metadata and are intentionally discarded.
pub fn discover_unbrowse_snapshot(command_tool: Option<&str>) -> CatalogSnapshot {
    let Some(home) = dirs::home_dir() else {
        return snapshot(
            "unbrowse".to_owned(),
            Vec::new(),
            AvailabilityReason::RouteUnavailable,
        );
    };
    normalize_unbrowse_cache(&home.join(".unbrowse/route-cache.json"), command_tool)
}

/// Register governed discovery receptors for public implementation and
/// research registries. These descriptors only search and traverse metadata;
/// they never clone, compile, install, or execute discovered code.
/// One snapshot per registry: Contract keys a snapshot by its provider, so a
/// source carrying descriptors from two providers is unregistrable and the
/// whole inventory silently disappears from routing.
pub fn discover_external_registry_snapshots(tools: &[ToolDefinition]) -> Vec<CatalogSnapshot> {
    let web_tool = tools.iter().find_map(|definition| {
        let name = definition.function.name.as_str();
        matches!(
            name.to_ascii_lowercase().as_str(),
            "web_search" | "search_web" | "search_tool" | "use_tool"
        )
        .then_some(name.to_owned())
    });
    let github_tool = tools.iter().find_map(|definition| {
        let name = definition.function.name.as_str();
        let lower = name.to_ascii_lowercase();
        (lower.contains("github") || lower == "use_tool").then_some(name.to_owned())
    });
    let mut by_provider = BTreeMap::<String, Vec<CapabilityDescriptor>>::new();
    let mut add = |id: &str,
                   provider: &str,
                   tool: Option<&String>,
                   action: &str,
                   description: &str,
                   input_schema: Value,
                   output_schema: Value,
                   requires: Vec<String>| {
        let available = tool.is_some();
        by_provider
            .entry(provider.to_owned())
            .or_default()
            .push(CapabilityDescriptor {
                schema_version: 1,
                id: id.into(),
                capability_version: semantic_version(&[
                    id.as_bytes(),
                    serde_json::to_string(&input_schema)
                        .unwrap_or_default()
                        .as_bytes(),
                    b"external-registry-v1",
                ]),
                provider: provider.into(),
                tool: tool.cloned().unwrap_or_else(|| "unavailable".into()),
                action: action.into(),
                description: bounded_description(description),
                input_schema: object_or_empty(input_schema),
                output_schema: object_or_empty(output_schema),
                requires,
                permission: Permission::Network,
                effects: vec![Effect::NetworkRead],
                // These adapters are governed discovery receptors by design:
                // they search and traverse metadata, nothing else.
                roles: vec![CellRole::Receptor],
                available,
            });
    };
    // Contract requires `id` to be namespaced by its provider, exactly as the
    // quarantined-artifact adapter below does.
    add(
        "registry:github.search",
        "registry:github",
        github_tool.as_ref().or(web_tool.as_ref()),
        "search_repositories",
        "Search public GitHub repositories for candidate implementations; results remain quarantined and non-executable.",
        json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}),
        json!({"type":"object","properties":{"repositories":{"type":"array","items":{"type":"object"}}}}),
        vec![],
    );
    add(
        "registry:github.traverse_tree",
        "registry:github",
        github_tool.as_ref().or(web_tool.as_ref()),
        "traverse_pinned_tree",
        "Traverse a public GitHub repository tree at an immutable revision without executing its contents.",
        json!({"type":"object","properties":{"repository":{"type":"string"},"revision":{"type":"string"}},"required":["repository","revision"]}),
        json!({"type":"object","properties":{"files":{"type":"array","items":{"type":"object"}}}}),
        vec!["registry:github.search".into()],
    );
    add(
        "registry:arxiv.search",
        "registry:arxiv",
        web_tool.as_ref(),
        "search_papers",
        "Search arXiv metadata for research that can inform a capability design; papers are evidence, never executable cells.",
        json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}),
        json!({"type":"object","properties":{"papers":{"type":"array","items":{"type":"object"}}}}),
        vec![],
    );
    add(
        "registry:arxiv.read",
        "registry:arxiv",
        web_tool.as_ref(),
        "read_pinned_paper",
        "Read a specific arXiv revision as design evidence without treating claims as verified implementation.",
        json!({"type":"object","properties":{"paper_id":{"type":"string"},"revision":{"type":"string"}},"required":["paper_id","revision"]}),
        json!({"type":"object","properties":{"evidence":{"type":"object"}}}),
        vec!["registry:arxiv.search".into()],
    );
    let reason = if web_tool.is_some() || github_tool.is_some() {
        AvailabilityReason::Ready
    } else {
        AvailabilityReason::ProviderDisconnected
    };
    by_provider
        .into_iter()
        .map(|(provider, descriptors)| snapshot(provider, descriptors, reason))
        .collect()
}

/// Convert discovered artifacts into quarantined catalog entries. Even with a
/// hash and license, these are intentionally unavailable until the local
/// promotion loop produces an isolated build and independent witness.
pub fn normalize_external_candidates(candidates: &[ExternalArtifactCandidate]) -> CatalogSnapshot {
    let descriptors = candidates
        .iter()
        .take(256)
        .filter(|candidate| {
            !candidate.stable_id.trim().is_empty() && !candidate.revision.trim().is_empty()
        })
        .map(|candidate| {
            let provider = match candidate.registry {
                ExternalRegistry::Github => "artifact:github",
                ExternalRegistry::Arxiv => "evidence:arxiv",
            };
            let id = format!("{}.{}.inspect", provider, segment(&candidate.stable_id));
            CapabilityDescriptor {
                schema_version: 1,
                capability_version: semantic_version(&[
                    candidate.stable_id.as_bytes(),
                    candidate.revision.as_bytes(),
                    candidate
                        .artifact_hash
                        .as_deref()
                        .unwrap_or("unhashed")
                        .as_bytes(),
                ]),
                id,
                provider: provider.into(),
                tool: "quarantine".into(),
                action: "inspect_only".into(),
                description: bounded_description(&format!(
                    "{} — {}",
                    candidate.title, candidate.summary
                )),
                input_schema: object_or_empty(json!({"type":"object"})),
                output_schema: object_or_empty(json!({"type":"object"})),
                requires: vec![
                    "pinned_revision".into(),
                    "license_compatible".into(),
                    "isolated_build".into(),
                    "independent_witness".into(),
                ],
                permission: Permission::Read,
                effects: vec![Effect::ReadOnly],
                // Quarantined artifacts are evidence, never executable cells.
                roles: Vec::new(),
                available: false,
            }
        })
        .collect();
    snapshot(
        "external-artifacts".into(),
        descriptors,
        AvailabilityReason::RouteUnavailable,
    )
}

pub fn normalize_unbrowse_cache(cache_path: &Path, command_tool: Option<&str>) -> CatalogSnapshot {
    let runtime_available = command_tool.is_some() && command_available("unbrowse");
    let Ok(raw) = std::fs::read(cache_path) else {
        return snapshot(
            "unbrowse".to_owned(),
            Vec::new(),
            AvailabilityReason::RouteUnavailable,
        );
    };
    let Ok(cache) = serde_json::from_slice::<BTreeMap<String, UnbrowseCacheEntry>>(&raw) else {
        return snapshot(
            "unbrowse".to_owned(),
            Vec::new(),
            AvailabilityReason::RouteUnavailable,
        );
    };
    let mut descriptors = BTreeMap::<String, CapabilityDescriptor>::new();
    for cached in cache.into_values() {
        let path = PathBuf::from(cached.local_skill_path);
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_UNBROWSE_SKILL_BYTES {
            continue;
        }
        let Ok(raw_skill) = std::fs::read(&path) else {
            continue;
        };
        let Ok(skill) = serde_json::from_slice::<UnbrowseSkill>(&raw_skill) else {
            continue;
        };
        let raw_skill_id = if skill.skill_id.is_empty() {
            &cached.skill_id
        } else {
            &skill.skill_id
        };
        if !safe_cli_id(raw_skill_id) {
            continue;
        }
        let skill_id = segment(raw_skill_id);
        for endpoint in skill.endpoints {
            if !safe_cli_id(&endpoint.endpoint_id) {
                continue;
            }
            let raw_endpoint_id = endpoint.endpoint_id;
            let endpoint_id = segment(&raw_endpoint_id);
            let id = format!("unbrowse.{}.{}", skill_id, endpoint_id);
            let method = endpoint.method.to_ascii_uppercase();
            let (permission, effects) = if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
                (Permission::Network, vec![Effect::NetworkRead])
            } else {
                (Permission::Network, vec![Effect::NetworkWrite])
            };
            // The HTTP method declares the role: read endpoints observe
            // world state (they can open a limb or verify its outcome);
            // write endpoints act on the world.
            let roles = if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
                vec![CellRole::Receptor, CellRole::Sensor]
            } else {
                vec![CellRole::Executor]
            };
            let description = bounded_description(&endpoint.description);
            let response = object_or_empty(
                endpoint
                    .response_schema
                    .unwrap_or_else(|| json!({ "type": "object" })),
            );
            let action =
                format!("unbrowse execute --skill {raw_skill_id} --endpoint {raw_endpoint_id}");
            let version = semantic_version(&[
                skill.version.as_bytes(),
                endpoint_id.as_bytes(),
                method.as_bytes(),
                serde_json::to_string(&response)
                    .unwrap_or_default()
                    .as_bytes(),
            ]);
            descriptors.insert(
                id.clone(),
                CapabilityDescriptor {
                    schema_version: 1,
                    id,
                    capability_version: version,
                    provider: "unbrowse".to_owned(),
                    tool: command_tool.unwrap_or("Bash").to_owned(),
                    action,
                    description,
                    input_schema: object_or_empty(json!({
                        "type": "object",
                        "properties": { "command": { "type": "string" } },
                        "required": ["command"]
                    })),
                    output_schema: response,
                    requires: Vec::new(),
                    permission,
                    effects,
                    roles,
                    available: runtime_available,
                },
            );
        }
    }
    snapshot(
        "unbrowse".to_owned(),
        descriptors.into_values().collect(),
        if runtime_available {
            AvailabilityReason::Ready
        } else {
            AvailabilityReason::RouteUnavailable
        },
    )
}

fn command_available(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|directory| {
            let candidate = directory.join(name);
            candidate.is_file()
        })
    })
}

fn safe_cli_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn snapshot(
    source: String,
    descriptors: Vec<CapabilityDescriptor>,
    reason: AvailabilityReason,
) -> CatalogSnapshot {
    let availability = descriptors
        .iter()
        .map(|descriptor| CapabilityAvailability {
            capability_id: descriptor.id.clone(),
            capability_version: descriptor.capability_version.clone(),
            available: descriptor.available,
            reason,
        })
        .collect();
    CatalogSnapshot {
        source,
        descriptors,
        availability,
    }
}

fn object_or_empty(value: Value) -> Map<String, Value> {
    match sanitize_schema_value(value) {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

fn sanitize_schema_value(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .filter(|(key, _)| {
                    !sensitive_schema_name(key)
                        && !matches!(
                            key.as_str(),
                            "default"
                                | "example"
                                | "examples"
                                | "$comment"
                                | "contentEncoding"
                                | "contentMediaType"
                        )
                })
                .map(|(key, value)| {
                    let value = if key == "required" {
                        match value {
                            Value::Array(items) => Value::Array(
                                items
                                    .into_iter()
                                    .filter(|item| {
                                        item.as_str()
                                            .is_none_or(|name| !sensitive_schema_name(name))
                                    })
                                    .map(sanitize_schema_value)
                                    .collect(),
                            ),
                            other => sanitize_schema_value(other),
                        }
                    } else {
                        sanitize_schema_value(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .filter(|item| item.as_str().is_none_or(|text| !sensitive_free_text(text)))
                .map(sanitize_schema_value)
                .collect(),
        ),
        Value::String(text) if sensitive_free_text(&text) => Value::String("redacted".to_owned()),
        scalar => scalar,
    }
}

fn sensitive_schema_name(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "api_key",
        "apikey",
        "password",
        "passwd",
        "credential",
        "secret",
        "private_key",
        "access_token",
        "refresh_token",
        "authorization",
        "cookie",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn sensitive_free_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("://")
        || lower.contains("bearer ")
        || lower.contains("cg_sk_")
        || lower.contains("sk-")
        || sensitive_schema_name(&lower)
}

fn semantic_version(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    let encoded = format!("{:x}", digest.finalize());
    encoded[..16].to_owned()
}

fn segment(value: &str) -> String {
    let normalized: String = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = normalized.trim_matches('_');
    if trimmed.is_empty() {
        "capability".to_owned()
    } else {
        trimmed.chars().take(96).collect()
    }
}

fn bounded_description(value: &str) -> String {
    let compact = value
        .split_whitespace()
        .filter(|word| !sensitive_free_text(word))
        .collect::<Vec<_>>()
        .join(" ");
    let compact = if compact.is_empty() {
        "Invoke this Aiko capability."
    } else {
        compact.as_str()
    };
    compact.chars().take(MAX_DESCRIPTION).collect()
}

fn infer_tool_effects(name: &str) -> (Permission, Vec<Effect>) {
    let lower = name.to_ascii_lowercase();
    if lower.contains("purchase") || lower.contains("checkout") || lower.contains("payment") {
        return (Permission::Purchase, vec![Effect::Purchase]);
    }
    if lower.contains("send_message") || lower.contains("send_email") || lower.contains("publish") {
        return (Permission::Network, vec![Effect::MessageSend]);
    }
    let read_markers = [
        "read", "get", "list", "search", "find", "inspect", "status", "view", "snapshot",
        "observe", "query", "fetch",
    ];
    if read_markers.iter().any(|marker| lower.contains(marker)) {
        let network = lower.contains("web")
            || lower.contains("http")
            || lower.contains("mcp")
            || lower.contains("fetch");
        return if network {
            (Permission::Network, vec![Effect::NetworkRead])
        } else {
            (Permission::Read, vec![Effect::ReadOnly])
        };
    }
    (Permission::Write, vec![Effect::LocalWrite])
}

fn frontmatter(contents: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut lines = contents.lines();
    if lines.next().map(str::trim) != Some("---") {
        return fields;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if matches!(key.trim(), "name" | "description") {
            fields.insert(
                key.trim().to_owned(),
                value.trim().trim_matches(['\'', '"']).to_owned(),
            );
        }
    }
    fields
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnbrowseCacheEntry {
    #[serde(default)]
    skill_id: String,
    local_skill_path: String,
}

#[derive(Debug, Deserialize)]
struct UnbrowseSkill {
    #[serde(default)]
    skill_id: String,
    #[serde(default = "default_version")]
    version: String,
    #[serde(default)]
    endpoints: Vec<UnbrowseEndpoint>,
}

#[derive(Debug, Deserialize)]
struct UnbrowseEndpoint {
    endpoint_id: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    response_schema: Option<Value>,
}

fn default_version() -> String {
    "1".to_owned()
}
fn default_method() -> String {
    "GET".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_and_mcp_tools_are_source_qualified_and_versioned() {
        let tools = vec![
            ToolDefinition::function("read_file", Some("Read a file"), json!({"type":"object"})),
            ToolDefinition::function(
                "github__list_issues",
                Some("List issues"),
                json!({"type":"object"}),
            ),
        ];
        let snapshots = normalize_tool_definitions(&tools);
        assert_eq!(snapshots.len(), 2);
        assert!(
            snapshots
                .iter()
                .any(|s| s.source == "aiko" && s.descriptors[0].id == "aiko.read_file.invoke")
        );
        assert!(
            snapshots.iter().any(|s| s.source == "mcp:github"
                && s.descriptors[0].id == "mcp:github.list_issues.invoke")
        );
    }

    #[test]
    fn skill_adapter_emits_metadata_without_paths_or_body() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("deploy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: deploy\ndescription: Deploy safely\n---\nSECRET_BODY",
        )
        .unwrap();
        let snapshot = normalize_skill_paths(&[temp.path().to_path_buf()]);
        let encoded = serde_json::to_string(&snapshot.descriptors).unwrap();
        assert_eq!(snapshot.descriptors[0].id, "skill.skill.deploy");
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!encoded.contains("SECRET_BODY"));
    }

    #[test]
    fn unbrowse_adapter_discards_paths_urls_and_route_values() {
        let temp = tempfile::tempdir().unwrap();
        let skill_path = temp.path().join("route.json");
        std::fs::write(&skill_path, serde_json::to_vec(&json!({
            "skill_id":"github", "version":"2", "endpoints":[{
                "endpoint_id":"issues_list", "method":"GET", "description":"List issues",
                "url_template":"https://secret.example/{token}", "response_schema":{"type":"array"}
            }]
        })).unwrap()).unwrap();
        let cache = temp.path().join("cache.json");
        std::fs::write(
            &cache,
            serde_json::to_vec(&json!({"intent":{"skillId":"github","localSkillPath":skill_path}}))
                .unwrap(),
        )
        .unwrap();
        let snapshot = normalize_unbrowse_cache(&cache, Some("Bash"));
        let encoded = serde_json::to_string(&snapshot.descriptors).unwrap();
        assert_eq!(snapshot.descriptors[0].id, "unbrowse.github.issues_list");
        assert_eq!(
            snapshot.descriptors[0].action,
            "unbrowse execute --skill github --endpoint issues_list"
        );
        assert!(!encoded.contains("secret.example"));
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!encoded.contains("token"));
    }

    #[test]
    fn github_and_arxiv_are_read_only_discovery_registries() {
        let tools = vec![ToolDefinition::function(
            "web_search",
            Some("Search the web"),
            json!({"type":"object"}),
        )];
        let snapshots = discover_external_registry_snapshots(&tools);
        assert_eq!(
            snapshots
                .iter()
                .map(|snapshot| snapshot.source.as_str())
                .collect::<Vec<_>>(),
            vec!["registry:arxiv", "registry:github"]
        );
        // Contract keys a snapshot by its provider and namespaces every id
        // under it. Violating either rule makes the whole source unregistrable
        // — which is invisible until routing is already gone.
        for snapshot in &snapshots {
            for descriptor in &snapshot.descriptors {
                assert_eq!(descriptor.provider, snapshot.source);
                assert!(descriptor.id.starts_with(&format!("{}.", snapshot.source)));
                assert!(descriptor.available);
                assert_eq!(descriptor.permission, Permission::Network);
                assert_eq!(descriptor.effects, vec![Effect::NetworkRead]);
            }
        }
        let descriptors = snapshots
            .iter()
            .flat_map(|snapshot| snapshot.descriptors.iter())
            .collect::<Vec<_>>();
        assert_eq!(descriptors.len(), 4);
        let tree = descriptors
            .iter()
            .find(|descriptor| descriptor.id == "registry:github.traverse_tree")
            .expect("GitHub traversal receptor");
        assert_eq!(tree.requires, vec!["registry:github.search"]);
        let paper = descriptors
            .iter()
            .find(|descriptor| descriptor.id == "registry:arxiv.read")
            .expect("arXiv evidence receptor");
        assert!(paper.description.contains("evidence"));
    }

    #[test]
    fn remote_artifacts_stay_quarantined_until_local_promotion() {
        let snapshot = normalize_external_candidates(&[
            ExternalArtifactCandidate {
                registry: ExternalRegistry::Github,
                stable_id: "owner/repository".into(),
                revision: "0123456789abcdef".into(),
                title: "Reusable adapter".into(),
                summary: "Candidate implementation".into(),
                license: Some("Apache-2.0".into()),
                artifact_hash: Some("sha256:abc".into()),
            },
            ExternalArtifactCandidate {
                registry: ExternalRegistry::Arxiv,
                stable_id: "2601.00001".into(),
                revision: "v2".into(),
                title: "Typed composition".into(),
                summary: "Research evidence".into(),
                license: None,
                artifact_hash: None,
            },
        ]);
        assert_eq!(snapshot.descriptors.len(), 2);
        assert!(
            snapshot
                .descriptors
                .iter()
                .all(|descriptor| !descriptor.available)
        );
        let github = snapshot
            .descriptors
            .iter()
            .find(|descriptor| descriptor.provider == "artifact:github")
            .expect("GitHub artifact");
        assert!(github.requires.contains(&"pinned_revision".into()));
        assert!(github.requires.contains(&"isolated_build".into()));
        assert!(github.requires.contains(&"independent_witness".into()));
    }

    #[test]
    fn descriptor_rejects_unknown_secret_fields() {
        let invalid = json!({
            "schema_version":1,"id":"aiko.read_file.invoke","capability_version":"1",
            "provider":"aiko","tool":"read_file","action":"invoke","description":"Read",
            "input_schema":{},"output_schema":{},"requires":[],"permission":"read",
            "effects":["read_only"],"available":true,"credential":"secret"
        });
        assert!(serde_json::from_value::<CapabilityDescriptor>(invalid).is_err());
    }

    #[test]
    fn tool_schema_value_annotations_are_removed_before_registration() {
        let tools = vec![ToolDefinition::function(
            "remote_search",
            Some("Search remotely"),
            json!({
                "type":"object",
                "properties":{"token":{"type":"string","default":"secret-value","examples":["secret-value"]}}
            }),
        )];
        let snapshots = normalize_tool_definitions(&tools);
        let encoded = serde_json::to_string(&snapshots[0].descriptors).unwrap();
        assert!(!encoded.contains("secret-value"));
        assert!(!encoded.contains("\"default\""));
        assert!(!encoded.contains("\"examples\""));
    }

    #[test]
    fn descriptor_sanitizer_removes_credentials_urls_and_secret_schema_fields() {
        let sanitized = sanitize_schema_value(json!({
            "type": "object",
            "description": "Fetch https://private.example/items with cg_sk_secret",
            "properties": {
                "query": {"type": "string"},
                "api_key": {"type": "string", "default": "cg_sk_secret"}
            },
            "required": ["query", "api_key"]
        }));
        let encoded = serde_json::to_string(&sanitized).unwrap();
        assert!(!encoded.contains("https://"));
        assert!(!encoded.contains("cg_sk_"));
        assert!(!encoded.contains("api_key"));
        assert!(encoded.contains("query"));
    }

    #[test]
    fn collective_gate_discards_execution_and_preserves_only_public_shape() {
        let descriptor = CapabilityDescriptor {
            schema_version: 1,
            id: "unbrowse.github.issues_list".into(),
            capability_version: "abc123".into(),
            provider: "unbrowse".into(),
            tool: "Bash".into(),
            action: "unbrowse execute --skill github --endpoint issues_list".into(),
            description: "List public issues".into(),
            input_schema: object_or_empty(json!({
                "type":"object",
                "properties":{"query":{"type":"string"},"api_key":{"type":"string"}},
                "required":["query","api_key"]
            })),
            output_schema: object_or_empty(
                json!({"type":"object","properties":{"items":{"type":"array","items":{"type":"object"}}}}),
            ),
            requires: vec![],
            permission: Permission::Network,
            effects: vec![Effect::NetworkRead],
            roles: vec![CellRole::Receptor],
            available: true,
        };
        let candidate = collective_candidate(
            &descriptor,
            &format!("ed25519:{}", "1".repeat(64)),
            1,
            "2026-07-21T00:00:00Z",
            "2026-08-21T00:00:00Z",
        );
        let encoded = candidate.to_string();
        assert!(encoded.contains("issues_list"));
        assert!(encoded.contains("network_read"));
        assert!(!encoded.contains("execute --skill"));
        assert!(!encoded.contains("api_key"));
        assert!(!encoded.contains("available"));
    }

    #[cfg(unix)]
    #[test]
    fn binary_discovery_indexes_names_without_paths_and_stays_private_by_shape() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("example-tool");
        std::fs::write(&binary, b"not executed").unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&binary, permissions).unwrap();

        let snapshot = normalize_binary_paths(&[directory.path().to_path_buf()], Some("Bash"));
        assert_eq!(snapshot.source, "binary");
        assert_eq!(snapshot.descriptors.len(), 1);
        let descriptor = &snapshot.descriptors[0];
        assert_eq!(descriptor.tool, "Bash");
        assert_eq!(descriptor.action, "example-tool");
        assert_eq!(descriptor.effects, vec![Effect::LocalWrite]);
        let encoded = serde_json::to_string(descriptor).unwrap();
        assert!(!encoded.contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn rust_consumes_the_canonical_contract_golden_fixtures() {
        let descriptor = include_str!(
            "../../../../../contract/libcontract/src/fixtures/fech-valid-descriptor.json"
        );
        let observation = include_str!(
            "../../../../../contract/libcontract/src/fixtures/fech-valid-observation.json"
        );
        let invalid = include_str!(
            "../../../../../contract/libcontract/src/fixtures/fech-invalid-secret-observation.json"
        );
        assert!(serde_json::from_str::<CapabilityDescriptor>(descriptor).is_ok());
        assert!(serde_json::from_str::<CapabilityObservation>(observation).is_ok());
        assert!(serde_json::from_str::<CapabilityObservation>(invalid).is_err());
    }

    #[test]
    fn canonical_json_schema_validates_descriptor_and_observation_contracts() {
        let mut schema: Value = serde_json::from_str(include_str!(
            "../../../../../contract/fixtures/fech/capability.schema.json"
        ))
        .unwrap();
        let descriptor: Value = serde_json::from_str(include_str!(
            "../../../../../contract/libcontract/src/fixtures/fech-valid-descriptor.json"
        ))
        .unwrap();
        let observation: Value = serde_json::from_str(include_str!(
            "../../../../../contract/libcontract/src/fixtures/fech-valid-observation.json"
        ))
        .unwrap();
        let invalid: Value = serde_json::from_str(include_str!(
            "../../../../../contract/libcontract/src/fixtures/fech-invalid-secret-observation.json"
        ))
        .unwrap();

        schema["$ref"] = Value::String("#/$defs/descriptor".to_owned());
        let descriptor_validator = jsonschema::validator_for(&schema).unwrap();
        assert!(descriptor_validator.is_valid(&descriptor));

        schema["$ref"] = Value::String("#/$defs/observation".to_owned());
        let observation_validator = jsonschema::validator_for(&schema).unwrap();
        assert!(observation_validator.is_valid(&observation));
        assert!(!observation_validator.is_valid(&invalid));
    }
}
