use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use super::neuron_bridge::{generated_skill_artifact, generated_skill_is_active};

mod graph;

pub use graph::{
    ContractSkillPlan, DISCOVERY_SCHEMA, ResolvedScript, catalog, core_guidance, dry_run, plan,
    plan_bounded, resolve_input_bindings, resolve_script,
};

const MANIFEST_NAME: &str = "contract-skill.json";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
const MAX_SKILLS: usize = 256;
const MAX_SELECTED_SKILLS: usize = 4;
const MAX_NODES_PER_SKILL: usize = 16;
const EMBEDDED_CORE_MANIFEST: &str =
    include_str!("../../../../../.agents/skills/aiko-meta-agent/contract-skill.json");
const EMBEDDED_CORE_GUIDANCE: &str =
    include_str!("../../../../../.agents/skills/aiko-meta-agent/SKILL.md");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractSkillManifest {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default)]
    pub activation: SkillActivation,
    #[serde(default)]
    pub composition: Option<SkillComposition>,
    #[serde(default)]
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Value,
    #[serde(default)]
    pub nodes: Vec<SkillNode>,
    #[serde(default)]
    pub examples: Vec<SkillExample>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillActivation {
    #[default]
    Matched,
    Core,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillComposition {
    pub attach_children_at: String,
    pub join_children_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillNode {
    pub key: String,
    pub plan: String,
    #[serde(default = "default_worker")]
    pub worker: String,
    /// Versioned implementation protocol for deterministic host/script
    /// workers. Model-backed `aiko` nodes intentionally have no adapter.
    #[serde(default)]
    pub adapter: Option<String>,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Named inputs resolved from dependency evidence (`node-key.output-name`).
    /// This is the Contract-native replacement for ambient `{{prev}}` text.
    #[serde(default)]
    pub input_bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub can_parallel: bool,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_effect")]
    pub effect: String,
    #[serde(default)]
    pub reversible: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub requires_authority: bool,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// Declared write footprint (jesus-graph `writes`): scopes this node may
    /// mutate. The graph verdict intersects these across nodes to surface
    /// collisions before fan-out; empty means the node writes nothing.
    #[serde(default)]
    pub writes: Vec<String>,
    /// Capability gaps this node needs discovered before it can run
    /// (jesus-graph `capabilities`): each becomes a generated discovery node.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Research questions this node needs answered from primary sources
    /// (jesus-graph `research`): each becomes a generated discovery node.
    #[serde(default)]
    pub research: Vec<String>,
    /// Runnable witness command (jesus-graph `witness`): when declared, the
    /// node settles only while this command exits 0. A red witness fails the
    /// settlement so the next walk reopens the node.
    #[serde(default)]
    pub witness: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillExample {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub expect: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoadedContractSkill {
    pub manifest: ContractSkillManifest,
    pub directory: PathBuf,
    pub source: SkillSource,
    pub admission: SkillAdmission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Embedded,
    Bundled,
    User,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillAdmission {
    BuildEmbedded,
    ManifestValidated,
    LedgerActivated,
}

#[derive(Debug, Clone, Serialize)]
pub struct RankedContractSkill {
    pub id: String,
    pub version: String,
    pub source: SkillSource,
    pub energy: u32,
    pub matched_triggers: Vec<String>,
    #[serde(skip)]
    pub skill: LoadedContractSkill,
}

fn default_worker() -> String {
    "aiko".into()
}

fn default_timeout() -> u64 {
    30_000
}

fn default_effect() -> String {
    "read_only".into()
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn safe_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && !value.is_empty()
        && path.components().all(|component| {
            matches!(component, Component::Normal(_))
                && !component.as_os_str().to_string_lossy().starts_with('.')
        })
}

fn safe_adapter(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'-' | b'_' | b'/' | b':')
        })
}

fn known_host_adapter(value: &str) -> bool {
    matches!(
        value,
        "aiko.meta.observe/v1"
            | "aiko.meta.recall/v1"
            | "aiko.meta.route/v1"
            | "aiko.meta.settle/v1"
    )
}

fn known_effect(effect: &str) -> bool {
    matches!(
        effect,
        "read_only"
            | "local_reversible"
            | "local_write"
            | "external_message"
            | "purchase"
            | "job_application"
            | "credential_access"
            | "delete"
            | "publish"
            | "permission_change"
            | "account_mutation"
            | "process_spawn"
    )
}

fn validate_schema(schema: &Value, field: &str) -> Result<(), String> {
    let object = schema
        .as_object()
        .ok_or_else(|| format!("{field} must be a JSON Schema object"))?;
    if object.get("type").and_then(Value::as_str) != Some("object") {
        return Err(format!("{field}.type must be object"));
    }
    Ok(())
}

pub fn validate_manifest(manifest: &ContractSkillManifest, directory: &Path) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("schema_version must be 1".into());
    }
    if !safe_id(&manifest.id) {
        return Err("id must be lower-case hyphen-case".into());
    }
    if !safe_version(&manifest.version) {
        return Err("version must be numeric semver".into());
    }
    // A `core` skill is the always-on connectome: it is never keyword-routed
    // by `rank`, so it legitimately has no triggers. Only a `matched` limb
    // skill, which is only ever selected via trigger overlap, requires one.
    if manifest.triggers.len() > 64 {
        return Err("triggers must contain 0..64 entries".into());
    }
    if manifest.activation == SkillActivation::Matched && manifest.triggers.is_empty() {
        return Err("matched skills must declare at least one trigger".into());
    }
    validate_schema(&manifest.input_schema, "input_schema")?;
    validate_schema(&manifest.output_schema, "output_schema")?;
    if manifest.nodes.is_empty() || manifest.nodes.len() > MAX_NODES_PER_SKILL {
        return Err(format!(
            "nodes must contain 1..{MAX_NODES_PER_SKILL} entries"
        ));
    }

    let mut keys = BTreeSet::new();
    for node in &manifest.nodes {
        if !safe_id(&node.key) || !keys.insert(node.key.clone()) {
            return Err(format!("invalid or duplicate node key: {}", node.key));
        }
        if node.plan.trim().is_empty() || node.plan.len() > 2_000 {
            return Err(format!("node {} has invalid plan", node.key));
        }
        if !matches!(node.worker.as_str(), "aiko" | "script" | "host" | "tool") {
            return Err(format!("node {} has unknown worker", node.key));
        }
        if !known_effect(&node.effect) {
            return Err(format!("node {} has unknown effect", node.key));
        }
        if node.timeout_ms == 0 || node.timeout_ms > 3_600_000 {
            return Err(format!("node {} timeout is outside bounds", node.key));
        }
        if node.effect != "read_only"
            && !node.requires_authority
            && !node.reversible
            && !node.read_only
        {
            return Err(format!(
                "node {} declares an ungoverned non-read-only effect",
                node.key
            ));
        }
        match (&node.worker[..], node.adapter.as_deref(), &node.script) {
            ("aiko", None, None) => {}
            ("host", Some(adapter), None)
                if safe_adapter(adapter) && known_host_adapter(adapter) => {}
            ("script", Some("aiko.neuron-json-stdio/v1"), Some(script))
                if safe_relative_path(script) =>
            {
                if node.effect != "local_reversible" || node.read_only || !node.reversible {
                    return Err(format!(
                        "node {} script must be local_reversible, reversible, and kernel-sandboxed",
                        node.key
                    ));
                }
                let script_path = directory.join(script);
                let metadata = std::fs::symlink_metadata(&script_path)
                    .map_err(|_| format!("node {} script does not exist", node.key))?;
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.len() > MAX_SCRIPT_BYTES
                {
                    return Err(format!(
                        "node {} script must be a bounded regular file",
                        node.key
                    ));
                }
            }
            ("tool", _, _) => {
                return Err(format!(
                    "node {} names an unpinned tool worker; use an aiko node until a typed adapter exists",
                    node.key
                ));
            }
            ("host", _, _) => {
                return Err(format!("node {} has an unknown host adapter", node.key));
            }
            ("script", _, _) => {
                return Err(format!(
                    "node {} must use the pinned JSON-stdio script protocol",
                    node.key
                ));
            }
            _ => {
                return Err(format!(
                    "node {} has an invalid worker implementation",
                    node.key
                ));
            }
        }
        for source in node.input_bindings.values() {
            let Some((dependency, output)) = source.split_once('.') else {
                return Err(format!("node {} has invalid input binding", node.key));
            };
            if output.is_empty() || !node.depends_on.iter().any(|item| item == dependency) {
                return Err(format!(
                    "node {} input binding must reference a direct dependency",
                    node.key
                ));
            }
        }
    }
    for node in &manifest.nodes {
        for dependency in &node.depends_on {
            if dependency == &node.key || !keys.contains(dependency) {
                return Err(format!(
                    "node {} has invalid dependency {dependency}",
                    node.key
                ));
            }
        }
    }
    ensure_acyclic(&manifest.nodes)?;
    match (manifest.activation, manifest.composition.as_ref()) {
        (SkillActivation::Core, Some(composition)) => {
            if composition.attach_children_at == composition.join_children_at
                || !keys.contains(&composition.attach_children_at)
                || !keys.contains(&composition.join_children_at)
            {
                return Err("core composition ports must name two distinct nodes".into());
            }
            if !depends_transitively(
                &manifest.nodes,
                &composition.join_children_at,
                &composition.attach_children_at,
            ) {
                return Err("core join port must be downstream of its attach port".into());
            }
        }
        (SkillActivation::Core, None) => {
            return Err("core skills require typed composition ports".into());
        }
        (SkillActivation::Matched, Some(_)) => {
            return Err("matched limb skills cannot declare core composition ports".into());
        }
        (SkillActivation::Matched, None) => {}
    }
    Ok(())
}

fn ensure_acyclic(nodes: &[SkillNode]) -> Result<(), String> {
    let dependencies = nodes
        .iter()
        .map(|node| (node.key.as_str(), node.depends_on.as_slice()))
        .collect::<BTreeMap<_, _>>();
    fn visit<'a>(
        key: &'a str,
        dependencies: &BTreeMap<&'a str, &'a [String]>,
        visiting: &mut BTreeSet<&'a str>,
        visited: &mut BTreeSet<&'a str>,
    ) -> bool {
        if visited.contains(key) {
            return true;
        }
        if !visiting.insert(key) {
            return false;
        }
        for dependency in dependencies.get(key).copied().unwrap_or_default() {
            if !visit(dependency, dependencies, visiting, visited) {
                return false;
            }
        }
        visiting.remove(key);
        visited.insert(key);
        true
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for key in dependencies.keys() {
        if !visit(key, &dependencies, &mut visiting, &mut visited) {
            return Err("contract skill graph contains a dependency cycle".into());
        }
    }
    Ok(())
}

fn depends_transitively(nodes: &[SkillNode], from: &str, target: &str) -> bool {
    let dependencies = nodes
        .iter()
        .map(|node| (node.key.as_str(), node.depends_on.as_slice()))
        .collect::<BTreeMap<_, _>>();
    fn walk<'a>(
        key: &'a str,
        target: &str,
        dependencies: &BTreeMap<&'a str, &'a [String]>,
        visited: &mut BTreeSet<&'a str>,
    ) -> bool {
        if key == target {
            return true;
        }
        if !visited.insert(key) {
            return false;
        }
        dependencies
            .get(key)
            .copied()
            .unwrap_or_default()
            .iter()
            .any(|dependency| walk(dependency, target, dependencies, visited))
    }
    walk(from, target, &dependencies, &mut BTreeSet::new())
}

fn platform_matches(platforms: &[String]) -> bool {
    platforms.is_empty()
        || platforms.iter().any(|platform| {
            platform == "all"
                || platform == std::env::consts::OS
                || (platform == "unix" && cfg!(unix))
        })
}

fn root_candidates(cwd: &Path) -> Vec<(SkillSource, SkillAdmission, PathBuf)> {
    let mut roots = Vec::new();
    // Lowest precedence first; later inserts replace equal IDs.
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.agents/skills");
    roots.push((
        SkillSource::Bundled,
        SkillAdmission::ManifestValidated,
        bundled,
    ));
    if let Some(home) = dirs::home_dir() {
        roots.push((
            SkillSource::User,
            SkillAdmission::LedgerActivated,
            home.join(".aiko/neuron-skills/objects"),
        ));
        roots.push((
            SkillSource::User,
            SkillAdmission::ManifestValidated,
            home.join(".grok/skills"),
        ));
        roots.push((
            SkillSource::User,
            SkillAdmission::ManifestValidated,
            home.join(".aiko/skills"),
        ));
        roots.push((
            SkillSource::User,
            SkillAdmission::ManifestValidated,
            home.join(".agents/skills"),
        ));
    }
    roots.push((
        SkillSource::Project,
        SkillAdmission::LedgerActivated,
        cwd.join(".aiko/neuron-skills/objects"),
    ));
    roots.push((
        SkillSource::Project,
        SkillAdmission::ManifestValidated,
        cwd.join(".grok/skills"),
    ));
    roots.push((
        SkillSource::Project,
        SkillAdmission::ManifestValidated,
        cwd.join(".aiko/skills"),
    ));
    roots.push((
        SkillSource::Project,
        SkillAdmission::ManifestValidated,
        cwd.join(".agents/skills"),
    ));
    roots
}

fn embedded_core_skill() -> Option<LoadedContractSkill> {
    let directory =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.agents/skills/aiko-meta-agent");
    let manifest = serde_json::from_str::<ContractSkillManifest>(EMBEDDED_CORE_MANIFEST).ok()?;
    validate_manifest(&manifest, &directory).ok()?;
    Some(LoadedContractSkill {
        manifest,
        directory,
        source: SkillSource::Embedded,
        admission: SkillAdmission::BuildEmbedded,
    })
}

pub fn discover(cwd: &Path) -> Vec<LoadedContractSkill> {
    let mut selected = BTreeMap::<String, LoadedContractSkill>::new();
    if let Some(core) = embedded_core_skill() {
        selected.insert(core.manifest.id.clone(), core);
    }
    for (source, admission, root) in root_candidates(cwd) {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten().take(MAX_SKILLS) {
            let directory = entry.path();
            if !directory.is_dir() || directory.is_symlink() {
                continue;
            }
            let path = directory.join(MANIFEST_NAME);
            let Ok(metadata) = path.metadata() else {
                continue;
            };
            if metadata.len() > MAX_MANIFEST_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_slice::<ContractSkillManifest>(&bytes) else {
                continue;
            };
            if !platform_matches(&manifest.platforms)
                || validate_manifest(&manifest, &directory).is_err()
            {
                continue;
            }
            if admission == SkillAdmission::LedgerActivated {
                if !directory.join("SKILL.md").is_file()
                    || !directory.join("evals/evals.json").is_file()
                    || !directory.join("tests/cases.json").is_file()
                {
                    continue;
                }
                let Some(artifact) =
                    generated_skill_artifact(&directory, &manifest.id, &manifest.version)
                else {
                    continue;
                };
                if directory.file_name().and_then(|name| name.to_str())
                    != Some(artifact.digest.as_str())
                    || !generated_skill_is_active(&artifact)
                {
                    continue;
                }
            }
            // The always-on connectome is build-admitted and embedded in the
            // binary. Filesystem layers may add matched limbs, but cannot
            // shadow or self-declare a core.
            if manifest.activation == SkillActivation::Core
                || selected
                    .get(&manifest.id)
                    .is_some_and(|existing| existing.source == SkillSource::Embedded)
            {
                continue;
            }
            selected.insert(
                manifest.id.clone(),
                LoadedContractSkill {
                    manifest,
                    directory,
                    source,
                    admission,
                },
            );
        }
    }
    selected.into_values().collect()
}

fn normalized_tokens(value: &str) -> BTreeSet<String> {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 2)
        .map(str::to_ascii_lowercase)
        .collect()
}

pub fn rank(goal: &str, skills: Vec<LoadedContractSkill>) -> Vec<RankedContractSkill> {
    let goal_tokens = normalized_tokens(goal);
    let goal_lower = goal.to_ascii_lowercase();
    let mut ranked = skills
        .into_iter()
        .filter_map(|skill| {
            if skill.manifest.activation != SkillActivation::Matched {
                return None;
            }
            let matched_triggers = skill
                .manifest
                .triggers
                .iter()
                .filter(|trigger| {
                    let trigger_lower = trigger.to_ascii_lowercase();
                    goal_lower.contains(&trigger_lower)
                        || normalized_tokens(trigger)
                            .iter()
                            .all(|token| goal_tokens.contains(token))
                })
                .cloned()
                .collect::<Vec<_>>();
            if matched_triggers.is_empty() {
                return None;
            }
            let source_penalty = match skill.source {
                SkillSource::Embedded => 0,
                SkillSource::Project => 0,
                SkillSource::User => 2,
                SkillSource::Bundled => 4,
            };
            let energy = 100_u32
                .saturating_sub((matched_triggers.len() as u32).saturating_mul(20))
                .saturating_add(source_penalty);
            Some(RankedContractSkill {
                id: skill.manifest.id.clone(),
                version: skill.manifest.version.clone(),
                source: skill.source,
                energy,
                matched_triggers,
                skill,
            })
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        left.energy
            .cmp(&right.energy)
            .then_with(|| right.source.cmp(&left.source))
            .then_with(|| left.id.cmp(&right.id))
    });
    ranked.truncate(MAX_SELECTED_SKILLS);
    ranked
}

#[cfg(test)]
mod tests;
