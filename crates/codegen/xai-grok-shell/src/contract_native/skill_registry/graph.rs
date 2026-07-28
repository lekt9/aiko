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

pub fn plan(goal: &str, cwd: &Path) -> ContractSkillPlan {
    plan_bounded(goal, cwd, MAX_GRAPH_NODES)
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
