use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

const MANIFEST_NAME: &str = "contract-skill.json";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SKILLS: usize = 256;
const MAX_SELECTED_SKILLS: usize = 4;
const MAX_NODES_PER_SKILL: usize = 16;

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
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Value,
    #[serde(default)]
    pub nodes: Vec<SkillNode>,
    #[serde(default)]
    pub examples: Vec<SkillExample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillNode {
    pub key: String,
    pub plan: String,
    #[serde(default = "default_worker")]
    pub worker: String,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Bundled,
    User,
    Project,
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

#[derive(Debug, Clone, Serialize)]
pub struct ContractSkillPlan {
    pub schema_version: u32,
    pub selected: Vec<RankedContractSkill>,
    pub children: Vec<Value>,
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
    if manifest.triggers.is_empty() || manifest.triggers.len() > 64 {
        return Err("triggers must contain 1..64 entries".into());
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
        match (&node.worker[..], &node.script) {
            ("script", Some(script)) if safe_relative_path(script) => {
                let script_path = directory.join(script);
                if !script_path.is_file() {
                    return Err(format!("node {} script does not exist", node.key));
                }
            }
            ("script", _) => return Err(format!("node {} has an unsafe script path", node.key)),
            (_, Some(_)) => {
                return Err(format!(
                    "node {} declares a script for a non-script worker",
                    node.key
                ));
            }
            _ => {}
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

fn platform_matches(platforms: &[String]) -> bool {
    platforms.is_empty()
        || platforms.iter().any(|platform| {
            platform == "all"
                || platform == std::env::consts::OS
                || (platform == "unix" && cfg!(unix))
        })
}

fn root_candidates(cwd: &Path) -> Vec<(SkillSource, PathBuf)> {
    let mut roots = Vec::new();
    // Lowest precedence first; later inserts replace equal IDs.
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.agents/skills");
    roots.push((SkillSource::Bundled, bundled));
    if let Some(home) = dirs::home_dir() {
        roots.push((SkillSource::User, home.join(".grok/skills")));
        roots.push((SkillSource::User, home.join(".aiko/skills")));
        roots.push((SkillSource::User, home.join(".agents/skills")));
    }
    roots.push((SkillSource::Project, cwd.join(".grok/skills")));
    roots.push((SkillSource::Project, cwd.join(".aiko/skills")));
    roots.push((SkillSource::Project, cwd.join(".agents/skills")));
    roots
}

pub fn discover(cwd: &Path) -> Vec<LoadedContractSkill> {
    let mut selected = BTreeMap::<String, LoadedContractSkill>::new();
    for (source, root) in root_candidates(cwd) {
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
            selected.insert(
                manifest.id.clone(),
                LoadedContractSkill {
                    manifest,
                    directory,
                    source,
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

pub fn plan(goal: &str, cwd: &Path) -> ContractSkillPlan {
    // Reserve two children for the substrate's generic observe/verify spine.
    let mut remaining_nodes = 14_usize;
    let selected = rank(goal, discover(cwd))
        .into_iter()
        .filter(|ranked| {
            let count = ranked.skill.manifest.nodes.len();
            if count > remaining_nodes {
                return false;
            }
            remaining_nodes -= count;
            true
        })
        .collect::<Vec<_>>();
    let mut children = Vec::new();
    for ranked in &selected {
        for node in &ranked.skill.manifest.nodes {
            let key = format!("{}--{}", ranked.id, node.key);
            let dependencies = node
                .depends_on
                .iter()
                .map(|dependency| format!("{}--{}", ranked.id, dependency))
                .collect::<Vec<_>>();
            children.push(json!({
                "key": key,
                "plan": node.plan.replace("{{goal}}", goal),
                "action": format!("skill:{}@{}:{}", ranked.id, ranked.version, node.worker),
                "depends_on": dependencies,
                "requires_authorization": node.requires_authority,
                "authorization": if node.requires_authority { "pending_authorization" } else { "approved" },
                "effect_scope": node.effect,
                "read_only": node.read_only,
                "reversible": node.reversible,
                "timeout_ms": node.timeout_ms,
                "skill_id": ranked.id,
                "skill_version": ranked.version,
                "worker": node.worker,
                "script": node.script,
                "evidence": node.evidence,
            }));
        }
    }
    ContractSkillPlan {
        schema_version: 1,
        selected,
        children,
    }
}

pub fn dry_run(goal: &str, cwd: &Path) -> Value {
    serde_json::to_value(plan(goal, cwd)).unwrap_or_else(|_| {
        json!({
            "schema_version": 1,
            "selected": [],
            "children": [],
        })
    })
}

pub fn catalog(cwd: &Path) -> Value {
    let items = discover(cwd)
        .into_iter()
        .map(|skill| {
            json!({
                "id": skill.manifest.id,
                "version": skill.manifest.version,
                "description": skill.manifest.description,
                "source": skill.source,
                "platforms": skill.manifest.platforms,
                "triggers": skill.manifest.triggers,
                "nodes": skill.manifest.nodes.len(),
            })
        })
        .collect::<Vec<_>>();
    json!({ "schema_version": 1, "items": items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ContractSkillManifest {
        ContractSkillManifest {
            schema_version: 1,
            id: "inspect-project".into(),
            version: "1.0.0".into(),
            description: "Inspect a project".into(),
            platforms: vec!["all".into()],
            triggers: vec!["inspect project".into(), "git status".into()],
            input_schema: json!({"type":"object"}),
            output_schema: json!({"type":"object"}),
            nodes: vec![
                SkillNode {
                    key: "git-state".into(),
                    plan: "Inspect Git state for {{goal}}".into(),
                    worker: "host".into(),
                    script: None,
                    depends_on: Vec::new(),
                    can_parallel: true,
                    timeout_ms: 1_000,
                    effect: "read_only".into(),
                    reversible: false,
                    read_only: true,
                    requires_authority: false,
                    evidence: vec!["exit_status".into()],
                },
                SkillNode {
                    key: "summarize".into(),
                    plan: "Summarize".into(),
                    worker: "aiko".into(),
                    script: None,
                    depends_on: vec!["git-state".into()],
                    can_parallel: false,
                    timeout_ms: 10_000,
                    effect: "read_only".into(),
                    reversible: false,
                    read_only: true,
                    requires_authority: false,
                    evidence: Vec::new(),
                },
            ],
            examples: Vec::new(),
        }
    }

    #[test]
    fn accepts_bounded_acyclic_manifest() {
        assert_eq!(validate_manifest(&manifest(), Path::new(".")), Ok(()));
    }

    #[test]
    fn rejects_cycles_and_unsafe_effects() {
        let mut cyclic = manifest();
        cyclic.nodes[0].depends_on = vec!["summarize".into()];
        assert!(
            validate_manifest(&cyclic, Path::new("."))
                .unwrap_err()
                .contains("cycle")
        );

        let mut unsafe_manifest = manifest();
        unsafe_manifest.nodes[0].effect = "publish".into();
        unsafe_manifest.nodes[0].read_only = false;
        assert!(
            validate_manifest(&unsafe_manifest, Path::new("."))
                .unwrap_err()
                .contains("ungoverned")
        );
    }

    #[test]
    fn ranks_matching_skill_and_namespaces_pointer_graph() {
        let skill = LoadedContractSkill {
            manifest: manifest(),
            directory: PathBuf::from("."),
            source: SkillSource::Bundled,
        };
        let ranked = rank("please inspect project git status", vec![skill.clone()]);
        assert_eq!(ranked[0].id, "inspect-project");
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join(".agents/skills/inspect-project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(MANIFEST_NAME),
            serde_json::to_vec(&skill.manifest).unwrap(),
        )
        .unwrap();
        let planned = plan("inspect project", temporary.path());
        assert_eq!(planned.selected[0].source, SkillSource::Project);
        assert_eq!(
            planned.children[1]["depends_on"][0],
            "inspect-project--git-state"
        );
    }
}
