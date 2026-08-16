//! Compose admitted Contract Skills into one typed Neuron connectome.

use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

const MAX_GRAPH_NODES: usize = 16;

#[derive(Debug, Clone, Serialize)]
pub struct ContractSkillPlan {
    pub schema_version: u32,
    pub core_admitted: bool,
    pub selected: Vec<RankedContractSkill>,
    pub children: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct ResolvedScript {
    pub path: PathBuf,
    pub skill_root: PathBuf,
}

fn core_rank(skill: LoadedContractSkill) -> RankedContractSkill {
    RankedContractSkill {
        id: skill.manifest.id.clone(),
        version: skill.manifest.version.clone(),
        source: skill.source,
        energy: 0,
        matched_triggers: vec!["activation:core".into()],
        skill,
    }
}

fn render_node(goal: &str, ranked: &RankedContractSkill, node: &SkillNode) -> Value {
    let key = format!("{}--{}", ranked.id, node.key);
    let dependencies = node
        .depends_on
        .iter()
        .map(|dependency| format!("{}--{}", ranked.id, dependency))
        .collect::<Vec<_>>();
    let script_digest = node.script.as_ref().and_then(|relative| {
        let path = ranked.skill.directory.join(relative);
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_SCRIPT_BYTES
        {
            return None;
        }
        std::fs::read(path)
            .ok()
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
    });
    json!({
        "key": key,
        "plan": node.plan.replace("{{goal}}", goal),
        "action": format!("skill:{}@{}:{}", ranked.id, ranked.version, node.worker),
        "depends_on": dependencies,
        "input_bindings": node.input_bindings.iter().map(|(name, source)| {
            let (dependency, output) = source.split_once('.').unwrap_or((source, ""));
            (name.clone(), format!("{}--{}.{}", ranked.id, dependency, output))
        }).collect::<BTreeMap<_, _>>(),
        "requires_authorization": node.requires_authority,
        "authorization": if node.requires_authority { "pending_authorization" } else { "approved" },
        "effect_scope": node.effect,
        "read_only": node.read_only,
        "reversible": node.reversible,
        "timeout_ms": node.timeout_ms,
        "skill_id": ranked.id,
        "skill_version": ranked.version,
        "worker": node.worker,
        "adapter": node.adapter,
        "script": node.script,
        "script_digest": script_digest,
        "evidence": node.evidence,
        "writes": node.writes,
        "capabilities": node.capabilities,
        "research": node.research,
        "witness": node.witness,
        "activation": ranked.skill.manifest.activation,
        "admission": ranked.skill.admission,
    })
}

fn append_dependency(child: &mut Value, dependency: &str) {
    let Some(dependencies) = child.get_mut("depends_on").and_then(Value::as_array_mut) else {
        return;
    };
    if !dependencies
        .iter()
        .any(|value| value.as_str() == Some(dependency))
    {
        dependencies.push(Value::String(dependency.to_owned()));
    }
}

fn limb_ports(selected: &[RankedContractSkill]) -> (Vec<String>, Vec<(String, Vec<String>)>) {
    let mut roots = Vec::new();
    let mut leaves = Vec::new();
    for ranked in selected
        .iter()
        .filter(|ranked| ranked.skill.manifest.activation == SkillActivation::Matched)
    {
        let depended_on = ranked
            .skill
            .manifest
            .nodes
            .iter()
            .flat_map(|node| node.depends_on.iter().cloned())
            .collect::<BTreeSet<_>>();
        for node in &ranked.skill.manifest.nodes {
            let key = format!("{}--{}", ranked.id, node.key);
            if node.depends_on.is_empty() {
                roots.push(key.clone());
            }
            if !depended_on.contains(&node.key) {
                leaves.push((key, node.evidence.clone()));
            }
        }
    }
    (roots, leaves)
}

fn append_binding(child: &mut Value, name: String, source: String) {
    let Some(bindings) = child
        .get_mut("input_bindings")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    bindings.insert(name, Value::String(source));
}

fn compose_ports(selected: &[RankedContractSkill], children: &mut [Value]) {
    let Some(core) = selected
        .iter()
        .find(|ranked| ranked.skill.manifest.activation == SkillActivation::Core)
    else {
        return;
    };
    let Some(composition) = core.skill.manifest.composition.as_ref() else {
        return;
    };
    let attach = format!("{}--{}", core.id, composition.attach_children_at);
    let join = format!("{}--{}", core.id, composition.join_children_at);
    let (roots, leaves) = limb_ports(selected);

    for root in roots {
        if let Some(child) = children
            .iter_mut()
            .find(|child| child.get("key").and_then(Value::as_str) == Some(&root))
        {
            append_dependency(child, &attach);
            // Composition is a data edge, not only an ordering edge: the limb
            // root receives the exact route evidence that selected it.
            append_binding(
                child,
                "core_route".into(),
                format!("{attach}.selected_skill_refs"),
            );
        }
    }
    if let Some(join_node) = children
        .iter_mut()
        .find(|child| child.get("key").and_then(Value::as_str) == Some(&join))
    {
        for (leaf, evidence) in leaves {
            append_dependency(join_node, &leaf);
            for (index, output) in evidence.into_iter().enumerate() {
                let input = format!(
                    "limb_{}_{}_{}",
                    leaf.replace('-', "_"),
                    output.replace('-', "_"),
                    index,
                );
                append_binding(join_node, input, format!("{leaf}.{output}"));
            }
        }
    }
}

/// jesus-graph discovery-as-data, ported to the planner: `capabilities` and
/// `research` requests declared on rendered children become explicit,
/// deduplicated discovery nodes that produce one durable artifact each.
/// Consumers gain a real dependency edge and an input binding to the artifact,
/// so the lookup is visible to Kahn ordering instead of hidden in a prompt.
/// Discovery never installs anything (`auto_install: false`); the executor
/// validates the artifact against `aiko.discovery/v1` at settlement, and an
/// invalid or missing artifact keeps the node unsettled — reopening it exactly
/// like a red witness.
pub const DISCOVERY_SCHEMA: &str = "aiko.discovery/v1";

fn discovery_slug(query: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true;
    for c in query.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug.chars().take(48).collect()
}

fn inject_discovery_nodes(children: &mut Vec<Value>, max_nodes: usize) {
    // (kind, slug) -> (query, consumer keys), first-seen order, deduplicated.
    let mut order: Vec<(String, String)> = Vec::new();
    let mut specs: BTreeMap<(String, String), (String, Vec<String>)> = BTreeMap::new();
    for child in children.iter() {
        let Some(child_key) = child.get("key").and_then(Value::as_str) else {
            continue;
        };
        for (field, kind) in [("capabilities", "skill"), ("research", "research")] {
            let Some(queries) = child.get(field).and_then(Value::as_array) else {
                continue;
            };
            for query in queries.iter().filter_map(Value::as_str) {
                let slug = discovery_slug(query);
                if slug.is_empty() {
                    continue;
                }
                let dedup = (kind.to_string(), slug);
                let spec = specs
                    .entry(dedup.clone())
                    .or_insert_with(|| (query.to_string(), Vec::new()));
                if !spec.1.iter().any(|consumer| consumer == child_key) {
                    spec.1.push(child_key.to_string());
                }
                if !order.contains(&dedup) {
                    order.push(dedup);
                }
            }
        }
    }
    if order.is_empty() {
        return;
    }

    // Fail-closed budget: discovery nodes count against the same graph-node
    // ceiling as admitted limbs. Requests past the budget stay declared on
    // their consumers (visible gaps) but get no generated node this pass.
    let budget = max_nodes.saturating_sub(children.len());
    let mut used_keys: BTreeSet<String> = children
        .iter()
        .filter_map(|child| child.get("key").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut generated: Vec<Value> = Vec::new();
    for (kind, slug) in order.into_iter().take(budget) {
        let Some((query, consumers)) = specs.get(&(kind.clone(), slug.clone())) else {
            continue;
        };
        let mut key = format!("discover-{}-{}", kind, slug);
        let mut suffix = 2usize;
        while used_keys.contains(&key) {
            key = format!("discover-{}-{}-{}", kind, slug, suffix);
            suffix += 1;
        }
        used_keys.insert(key.clone());
        let artifact = format!("state/discovery/{}-{}.json", kind, slug);
        generated.push(json!({
            "key": key,
            "plan": match kind.as_str() {
                "skill" => format!(
                    "Discover an admitted skill for '{}' and write the verdict to {} per {}. \
                     Inspect installed skills first; never install anything.",
                    query, artifact, DISCOVERY_SCHEMA,
                ),
                _ => format!(
                    "Research '{}' from current primary sources and write findings to {} per {}. \
                     Keep inference distinct from findings.",
                    query, artifact, DISCOVERY_SCHEMA,
                ),
            },
            "action": "skill:aiko-meta-agent@1.0.0:aiko",
            "depends_on": [],
            "input_bindings": {},
            "requires_authorization": false,
            "authorization": "approved",
            "effect_scope": "local_reversible",
            "read_only": false,
            "reversible": true,
            "timeout_ms": 120000,
            "skill_id": "aiko-discovery",
            "skill_version": "1.0.0",
            "worker": "aiko",
            "adapter": null,
            "script": null,
            "script_digest": null,
            "evidence": ["artifact"],
            "writes": [artifact],
            "capabilities": [],
            "research": [],
            "witness": null,
            "discovery": {
                "kind": kind,
                "query": query,
                "artifact": artifact,
                "schema": DISCOVERY_SCHEMA,
                "auto_install": false,
            },
            "activation": "generated",
            "admission": "generated",
        }));
        // Consumers gain a real dependency edge and an artifact input binding.
        for consumer_key in consumers {
            let Some(child) = children.iter_mut().find(|child| {
                child.get("key").and_then(Value::as_str) == Some(consumer_key.as_str())
            }) else {
                continue;
            };
            append_dependency(child, &key);
            append_binding(
                child,
                format!("discovery_{}", slug.replace('-', "_")),
                format!("{}.artifact", key),
            );
        }
    }
    children.extend(generated);
}

pub fn plan(goal: &str, cwd: &Path) -> ContractSkillPlan {
    plan_bounded(goal, cwd, MAX_GRAPH_NODES)
}

/// IsolatedLocal first profile cannot admit network, secrets, or
/// runtime-authorization nodes. Drop those skills (and their dependents)
/// rather than refuse the whole turn. Core stays.
pub fn retain_isolated_local_skills(mut plan: ContractSkillPlan) -> ContractSkillPlan {
    let drop_ids: BTreeSet<String> = plan
        .selected
        .iter()
        .filter(|ranked| {
            ranked.skill.manifest.activation != SkillActivation::Core
                && !ranked
                    .skill
                    .manifest
                    .nodes
                    .iter()
                    .all(isolated_local_skill_node)
        })
        .map(|ranked| ranked.id.clone())
        .collect();
    if drop_ids.is_empty() {
        return plan;
    }
    plan.selected
        .retain(|ranked| !drop_ids.contains(&ranked.id));
    plan.children.retain(|child| {
        child
            .get("skill_id")
            .and_then(Value::as_str)
            .map(|id| !drop_ids.contains(id))
            .unwrap_or(true)
    });
    loop {
        let keys: BTreeSet<String> = plan
            .children
            .iter()
            .filter_map(|child| child.get("key").and_then(Value::as_str).map(str::to_string))
            .collect();
        let before = plan.children.len();
        plan.children.retain(|child| {
            child
                .get("depends_on")
                .and_then(Value::as_array)
                .map(|deps| {
                    deps.iter()
                        .all(|dep| dep.as_str().is_some_and(|key| keys.contains(key)))
                })
                .unwrap_or(true)
        });
        if plan.children.len() == before {
            break;
        }
    }
    plan
}

fn isolated_local_skill_node(node: &SkillNode) -> bool {
    if node.requires_authority || !node.capabilities.is_empty() {
        return false;
    }
    let read_only = node.read_only && node.effect == "read_only" && node.writes.is_empty();
    let workspace_reversible = node.worker == "aiko"
        && !node.read_only
        && node.reversible
        && node.effect == "local_reversible"
        && node.writes.len() == 1
        && node.writes[0] == super::super::graph_harness::WORKSPACE_AUTHORITY;
    read_only || workspace_reversible
}

pub fn plan_bounded(goal: &str, cwd: &Path, max_nodes: usize) -> ContractSkillPlan {
    let discovered = discover(cwd);
    let core = discovered
        .iter()
        .find(|skill| {
            skill.source == SkillSource::Embedded
                && skill.manifest.activation == SkillActivation::Core
        })
        .cloned();
    let Some(core) = core else {
        return ContractSkillPlan {
            schema_version: 2,
            core_admitted: false,
            selected: vec![],
            children: vec![],
        };
    };

    let mut remaining_nodes = max_nodes.min(MAX_GRAPH_NODES);
    let core_nodes = core.manifest.nodes.len();
    if core_nodes > remaining_nodes {
        return ContractSkillPlan {
            schema_version: 2,
            core_admitted: false,
            selected: vec![],
            children: vec![],
        };
    }
    remaining_nodes -= core_nodes;

    let mut selected = vec![core_rank(core)];
    for ranked in rank(goal, discovered) {
        let count = ranked.skill.manifest.nodes.len();
        if count <= remaining_nodes {
            remaining_nodes -= count;
            selected.push(ranked);
        }
    }
    let mut children = selected
        .iter()
        .flat_map(|ranked| {
            ranked
                .skill
                .manifest
                .nodes
                .iter()
                .map(|node| render_node(goal, ranked, node))
        })
        .collect::<Vec<_>>();
    compose_ports(&selected, &mut children);
    inject_discovery_nodes(&mut children, max_nodes.min(MAX_GRAPH_NODES));
    ContractSkillPlan {
        schema_version: 2,
        core_admitted: true,
        selected,
        children,
    }
}

pub fn dry_run(goal: &str, cwd: &Path) -> Value {
    serde_json::to_value(plan(goal, cwd)).unwrap_or_else(|_| {
        json!({
            "schema_version": 2,
            "core_admitted": false,
            "selected": [],
            "children": [],
        })
    })
}

pub fn core_guidance() -> &'static str {
    EMBEDDED_CORE_GUIDANCE
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n").map(|(_, body)| body))
        .unwrap_or(EMBEDDED_CORE_GUIDANCE)
}

/// Resolve a script only through the same admitted registry entry and node
/// manifest that produced the Contract graph. Arbitrary occurrence paths are
/// never executable.
pub fn resolve_script(
    cwd: &Path,
    skill_id: &str,
    skill_version: &str,
    node_key: &str,
    relative_script: &str,
    expected_digest: &str,
) -> Option<ResolvedScript> {
    let skill = discover(cwd)
        .into_iter()
        .find(|skill| skill.manifest.id == skill_id && skill.manifest.version == skill_version)?;
    let node = skill.manifest.nodes.iter().find(|node| {
        node.key == node_key || format!("{}--{}", skill.manifest.id, node.key) == node_key
    })?;
    if node.worker != "script"
        || node.adapter.as_deref() != Some("aiko.neuron-json-stdio/v1")
        || node.script.as_deref() != Some(relative_script)
    {
        return None;
    }
    let path = skill.directory.join(relative_script);
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_SCRIPT_BYTES
    {
        return None;
    }
    let observed = format!("{:x}", Sha256::digest(std::fs::read(&path).ok()?));
    (observed == expected_digest).then_some(ResolvedScript {
        path,
        skill_root: skill.directory,
    })
}

/// Resolve only explicit outputs of direct dependencies. Ambient prior text is
/// never an input to a Neuron Skill node.
pub fn resolve_input_bindings(
    node: &SkillNode,
    settled_evidence: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let mut resolved = BTreeMap::new();
    for (input, source) in &node.input_bindings {
        let (dependency, output) = source
            .split_once('.')
            .ok_or_else(|| format!("invalid binding source: {source}"))?;
        if !node.depends_on.iter().any(|item| item == dependency) {
            return Err(format!("{dependency} is not a direct dependency"));
        }
        let evidence = settled_evidence
            .get(dependency)
            .ok_or_else(|| format!("dependency {dependency} has not settled"))?;
        let value = evidence
            .get(output)
            .cloned()
            .ok_or_else(|| format!("dependency {dependency} has no evidence output {output}"))?;
        resolved.insert(input.clone(), value);
    }
    Ok(resolved)
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
                "activation": skill.manifest.activation,
                "platforms": skill.manifest.platforms,
                "triggers": skill.manifest.triggers,
                "nodes": skill.manifest.nodes.len(),
            })
        })
        .collect::<Vec<_>>();
    json!({ "schema_version": 2, "items": items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn admitted_core_composes_existing_limbs_through_typed_ports() {
        let temporary = tempfile::tempdir().unwrap();
        let planned = plan(
            "Inspect this project repository and run tests.",
            temporary.path(),
        );
        assert!(planned.core_admitted);
        assert_eq!(planned.selected[0].id, "aiko-meta-agent");
        assert_eq!(planned.selected[0].source, SkillSource::Embedded);
        assert!(
            planned
                .selected
                .iter()
                .any(|skill| skill.id == "inspect-project")
        );
        assert!(
            planned
                .selected
                .iter()
                .any(|skill| skill.id == "build-and-test-project")
        );
        assert!(planned.children.iter().all(|node| {
            node.get("action")
                .and_then(Value::as_str)
                .is_none_or(|action| action != "agent:aiko")
        }));
        let inspect_root = planned
            .children
            .iter()
            .find(|node| node["key"] == "inspect-project--git-state")
            .unwrap();
        assert!(
            inspect_root["depends_on"]
                .as_array()
                .unwrap()
                .iter()
                .any(|dependency| dependency == "aiko-meta-agent--route")
        );
        let join = planned
            .children
            .iter()
            .find(|node| node["key"] == "aiko-meta-agent--verify")
            .unwrap();
        let dependencies = join["depends_on"].as_array().unwrap();
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency == "inspect-project--summarize")
        );
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency == "build-and-test-project--verify")
        );
        assert!(core_guidance().contains("Grow a generative limb"));
    }

    fn write_discovery_limb(root: &Path) {
        let directory = root.join(".aiko/skills/test-discovery-limb");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("contract-skill.json"),
            r#"{
              "schema_version": 1,
              "id": "test-discovery-limb",
              "version": "1.0.0",
              "description": "Limb that declares capability and research gaps.",
              "platforms": ["all"],
              "triggers": ["xyzzy discovery"],
              "activation": "matched",
              "input_schema": {"type": "object"},
              "output_schema": {"type": "object"},
              "nodes": [
                {
                  "key": "build",
                  "plan": "Build the thing for {{goal}}.",
                  "worker": "aiko",
                  "depends_on": [],
                  "can_parallel": false,
                  "timeout_ms": 120000,
                  "effect": "local_reversible",
                  "reversible": true,
                  "read_only": false,
                  "requires_authority": false,
                  "evidence": ["result"],
                  "writes": ["src/"],
                  "capabilities": ["SwiftUI accessibility", "SwiftUI accessibility"],
                  "research": ["current ARC scoring"]
                }
              ],
              "examples": []
            }"#,
        )
        .unwrap();
    }

    #[test]
    fn declared_gaps_generate_deduplicated_discovery_nodes_with_real_edges() {
        let temporary = tempfile::tempdir().unwrap();
        write_discovery_limb(temporary.path());
        let planned = plan("xyzzy discovery for the demo", temporary.path());
        assert!(planned.core_admitted);

        // One discovery node per unique (kind, query) — the doubled capability
        // request collapses into a single generated node.
        let discoveries = planned
            .children
            .iter()
            .filter(|child| child.get("discovery").and_then(Value::as_object).is_some())
            .collect::<Vec<_>>();
        assert_eq!(discoveries.len(), 2);

        let skill_node = discoveries
            .iter()
            .find(|child| child["discovery"]["kind"] == "skill")
            .unwrap();
        let skill_key = skill_node["key"].as_str().unwrap();
        assert!(skill_key.starts_with("discover-skill-"));
        assert_eq!(skill_node["worker"], "aiko");
        assert_eq!(skill_node["effect_scope"], "local_reversible");
        assert_eq!(skill_node["evidence"], json!(["artifact"]));
        assert_eq!(skill_node["discovery"]["schema"], DISCOVERY_SCHEMA);
        assert_eq!(skill_node["discovery"]["auto_install"], false);
        let artifact = skill_node["discovery"]["artifact"].as_str().unwrap();
        assert!(
            skill_node["writes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|scope| scope == artifact)
        );

        let research_node = discoveries
            .iter()
            .find(|child| child["discovery"]["kind"] == "research")
            .unwrap();
        let research_key = research_node["key"].as_str().unwrap();
        assert!(research_key.starts_with("discover-research-"));

        // The consumer gains a real dependency edge and an artifact binding —
        // the lookup is visible to Kahn ordering, not hidden in a prompt.
        let consumer = planned
            .children
            .iter()
            .find(|child| child["key"] == "test-discovery-limb--build")
            .unwrap();
        let dependencies = consumer["depends_on"].as_array().unwrap();
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency == skill_key)
        );
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency == research_key)
        );
        let bindings = consumer["input_bindings"].as_object().unwrap();
        assert!(
            bindings
                .values()
                .any(|source| source == &format!("{skill_key}.artifact"))
        );
        assert!(
            bindings
                .values()
                .any(|source| source == &format!("{research_key}.artifact"))
        );
    }

    #[test]
    fn discovery_generation_respects_the_graph_node_budget() {
        let temporary = tempfile::tempdir().unwrap();
        write_discovery_limb(temporary.path());
        // Core is 7 nodes, the limb is 1, so a budget of 9 leaves room for
        // exactly one of the two requested discoveries.
        let planned = plan_bounded("xyzzy discovery for the demo", temporary.path(), 9);
        assert!(planned.core_admitted);
        assert!(planned.children.len() <= 9);
        let discoveries = planned
            .children
            .iter()
            .filter(|child| child.get("discovery").and_then(Value::as_object).is_some())
            .count();
        assert_eq!(discoveries, 1);
    }

    /// The pinned phase-two witness runs this alone because Contract discovers
    /// its ledger from process CWD. It proves the native substrate admits and
    /// persists the typed Skill node fields, not merely the Rust-side plan.
    #[test]
    #[ignore = "run via scripts/witness-meta-agent-neuron-graph.sh"]
    #[serial_test::serial]
    fn native_contract_materializes_typed_skill_nodes_and_rejects_forgery() {
        struct RestoreCwd(PathBuf);
        impl Drop for RestoreCwd {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }

        let native = super::super::super::NativeContract::load()
            .expect("load the pinned Contract native library");
        let project = tempfile::tempdir().expect("temporary graph project");
        std::fs::create_dir(project.path().join(".claude")).expect("temporary ledger directory");
        let restore = RestoreCwd(std::env::current_dir().expect("current directory"));
        std::env::set_current_dir(project.path()).expect("enter temporary project");

        let request = super::super::super::claim_cell_request(
            "caf00d01",
            "reply to the paired chat",
            &project.path().to_string_lossy(),
        );
        let graph = native
            .expand_graph(&request)
            .expect("native Contract must materialize the graph");
        assert_eq!(graph["children"].as_array().unwrap().len(), 7);
        assert!(graph["waves"].as_array().unwrap().len() >= 6);

        let ledger = std::fs::read_to_string(project.path().join(".claude/contracts.jsonl"))
            .expect("read temporary Contract ledger");
        let rows = ledger
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("valid ledger row"))
            .collect::<Vec<_>>();
        let nodes = rows
            .iter()
            .filter(|row| row["execution_model"] == "typed_neuron_skill_node")
            .collect::<Vec<_>>();
        assert_eq!(nodes.len(), 7);
        assert!(nodes.iter().all(|row| row["pointer_type"] == "neuron"));
        assert!(nodes.iter().all(|row| row["skill_id"] == "aiko-meta-agent"));
        assert!(nodes.iter().all(|row| row["skill_version"] == "1.0.0"));
        assert!(
            nodes
                .iter()
                .any(|row| row["effect_scope"] == "local_reversible")
        );
        for row in &nodes {
            let bindings = serde_json::from_str::<Value>(
                row["input_bindings"]
                    .as_str()
                    .expect("typed binding JSON string"),
            )
            .expect("valid typed binding JSON");
            assert!(bindings.is_object());
            let evidence = serde_json::from_str::<Value>(
                row["evidence_requirements"]
                    .as_str()
                    .expect("evidence requirement JSON string"),
            )
            .expect("valid evidence requirement JSON");
            assert!(!evidence.as_array().unwrap().is_empty());
            assert_ne!(row["action"], "agent:aiko");
        }

        let mut forged_action = super::super::super::claim_cell_request(
            "caf00d02",
            "forged worker",
            &project.path().to_string_lossy(),
        );
        forged_action["children"][0]["worker"] = Value::String("aiko".into());
        assert!(native.expand_graph(&forged_action).is_none());

        let mut forged_binding = super::super::super::claim_cell_request(
            "caf00d03",
            "forged dependency",
            &project.path().to_string_lossy(),
        );
        forged_binding["children"][1]["input_bindings"]["context_references"] =
            Value::String("not-a-direct-dependency.output".into());
        assert!(native.expand_graph(&forged_binding).is_none());
        drop(restore);
    }

    /// Generated bytes are never executable merely because they exist in the
    /// content-addressed store. Discovery follows Contract's state projection.
    #[test]
    #[ignore = "run via scripts/witness-contract-interface-generator.sh"]
    #[serial_test::serial]
    fn generated_skill_is_inert_until_contract_activation_and_retirement_is_immediate() {
        use super::super::super::neuron_bridge::{
            SkillAdmissionGates, SkillProofs, SkillTransitionRequest, generated_skill_artifact,
        };
        use sha2::{Digest, Sha256};

        struct RestoreCwd(PathBuf);
        impl Drop for RestoreCwd {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }
        fn write(path: &Path, contents: &str) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
        fn file_digest(path: &Path) -> String {
            format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
        }

        let native = super::super::super::NativeContract::load()
            .expect("load the pinned Contract native library");
        let project = tempfile::tempdir().expect("temporary lifecycle project");
        std::fs::create_dir(project.path().join(".claude")).unwrap();
        let candidate = project.path().join("candidate");
        write(
            &candidate.join("SKILL.md"),
            "---\nname: lifecycle-limb\ndescription: lifecycle routing proof\n---\nRun the admitted proof.\n",
        );
        write(
            &candidate.join("contract-skill.json"),
            r#"{"schema_version":1,"id":"lifecycle-limb","version":"1.0.0","description":"lifecycle routing proof","platforms":["all"],"triggers":["lifecycle proof"],"activation":"matched","input_schema":{"type":"object"},"output_schema":{"type":"object"},"nodes":[{"key":"execute","plan":"Prove {{goal}}","worker":"aiko","script":null,"depends_on":[],"input_bindings":{},"can_parallel":false,"timeout_ms":30000,"effect":"read_only","reversible":false,"read_only":true,"requires_authority":false,"evidence":["result"]}],"examples":[]}"#,
        );
        write(
            &candidate.join("agents/openai.yaml"),
            "interface:\n  display_name: Lifecycle limb\n",
        );
        write(&candidate.join("evals/evals.json"), r#"{"evals":[]}"#);
        write(&candidate.join("tests/cases.json"), r#"{"cases":[]}"#);
        write(&candidate.join("tests/witness.py"), "raise SystemExit(0)\n");
        let artifact = generated_skill_artifact(&candidate, "lifecycle-limb", "1.0.0")
            .expect("canonical generated Skill artifact");
        let objects = project.path().join(".aiko/neuron-skills/objects");
        std::fs::create_dir_all(&objects).unwrap();
        std::fs::rename(&candidate, objects.join(&artifact.digest)).unwrap();
        let object = objects.join(&artifact.digest);
        let proofs = SkillProofs {
            manifest_digest: file_digest(&object.join("contract-skill.json")),
            instructions_digest: file_digest(&object.join("SKILL.md")),
            eval_digest: file_digest(&object.join("evals/evals.json")),
            witness_digest: file_digest(&object.join("tests/witness.py")),
        };
        let gates = SkillAdmissionGates {
            manifest_valid: true,
            instructions_valid: true,
            evals_passed: true,
            witness_passed: true,
            provenance_valid: true,
            privacy_valid: true,
            replay_valid: true,
            rollback_ready: true,
        };
        let transition = |action: &str, authority: bool| SkillTransitionRequest {
            schema: "contract.neuron-skill.transition/v1",
            stimulus_id: format!("lifecycle-limb-{action}"),
            artifact: artifact.clone(),
            action: action.to_owned(),
            proofs: proofs.clone(),
            gates: gates.clone(),
            actor_digest: "a".repeat(64),
            authority,
            supersedes_digest: None,
            now_ms: 1,
        };

        let restore = RestoreCwd(std::env::current_dir().unwrap());
        std::env::set_current_dir(project.path()).unwrap();
        assert_eq!(
            native
                .transition_skill(&transition("stage", false))
                .unwrap()
                .state,
            super::super::super::neuron_bridge::SkillLifecycleState::Candidate
        );
        assert!(
            !discover(project.path())
                .iter()
                .any(|skill| skill.manifest.id == "lifecycle-limb")
        );
        native
            .transition_skill(&transition("admit", false))
            .unwrap();
        native
            .transition_skill(&transition("activate", true))
            .unwrap();

        let discovered = discover(project.path());
        let admitted = discovered
            .iter()
            .find(|skill| skill.manifest.id == "lifecycle-limb")
            .expect("active generated limb is discoverable");
        assert_eq!(admitted.admission, SkillAdmission::LedgerActivated);
        let planned = plan("run the lifecycle proof", project.path());
        let selected = planned
            .selected
            .iter()
            .find(|skill| skill.id == "lifecycle-limb")
            .expect("active generated limb is routable");
        assert_eq!(selected.skill.admission, SkillAdmission::LedgerActivated);
        let node = planned
            .children
            .iter()
            .find(|node| node["key"] == "lifecycle-limb--execute")
            .unwrap();
        assert_eq!(node["admission"], "ledger_activated");
        assert_eq!(node["action"], "skill:lifecycle-limb@1.0.0:aiko");

        native
            .transition_skill(&transition("retire", true))
            .unwrap();
        assert!(
            !discover(project.path())
                .iter()
                .any(|skill| skill.manifest.id == "lifecycle-limb")
        );
        drop(restore);
    }
}
