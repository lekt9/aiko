use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn manifest() -> ContractSkillManifest {
    ContractSkillManifest {
        schema_version: 1,
        id: "inspect-project".into(),
        version: "1.0.0".into(),
        description: "Inspect a project".into(),
        platforms: vec!["all".into()],
        triggers: vec!["inspect project".into(), "git status".into()],
        activation: SkillActivation::Matched,
        composition: None,
        input_schema: json!({"type":"object"}),
        output_schema: json!({"type":"object"}),
        nodes: vec![
            SkillNode {
                key: "git-state".into(),
                plan: "Inspect Git state for {{goal}}".into(),
                worker: "aiko".into(),
                adapter: None,
                script: None,
                depends_on: Vec::new(),
                input_bindings: BTreeMap::new(),
                can_parallel: true,
                timeout_ms: 1_000,
                effect: "read_only".into(),
                reversible: false,
                read_only: true,
                requires_authority: false,
                evidence: vec!["exit_status".into()],
                writes: Vec::new(),
                capabilities: Vec::new(),
                research: Vec::new(),
                witness: None,
            },
            SkillNode {
                key: "summarize".into(),
                plan: "Summarize".into(),
                worker: "aiko".into(),
                adapter: None,
                script: None,
                depends_on: vec!["git-state".into()],
                input_bindings: BTreeMap::from([("inspection".into(), "git-state.result".into())]),
                can_parallel: false,
                timeout_ms: 10_000,
                effect: "read_only".into(),
                reversible: false,
                read_only: true,
                requires_authority: false,
                evidence: Vec::new(),
                writes: Vec::new(),
                capabilities: Vec::new(),
                research: Vec::new(),
                witness: None,
            },
        ],
        examples: Vec::new(),
    }
}

#[test]
fn accepts_bounded_acyclic_manifest() {
    assert_eq!(validate_manifest(&manifest(), Path::new(".")), Ok(()));
    assert!(known_effect("process_spawn"));
    assert!(!known_effect("untyped_effect"));
}

#[test]
fn rejects_cycles_unsafe_effects_and_invalid_core_ports() {
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

    let mut invalid_core = manifest();
    invalid_core.activation = SkillActivation::Core;
    assert!(
        validate_manifest(&invalid_core, Path::new("."))
            .unwrap_err()
            .contains("composition")
    );

    let mut unpinned_tool = manifest();
    unpinned_tool.nodes[0].worker = "tool".into();
    assert!(
        validate_manifest(&unpinned_tool, Path::new("."))
            .unwrap_err()
            .contains("unpinned tool")
    );

    let mut unknown_host = manifest();
    unknown_host.nodes[0].worker = "host".into();
    unknown_host.nodes[0].adapter = Some("unknown/v1".into());
    assert!(
        validate_manifest(&unknown_host, Path::new("."))
            .unwrap_err()
            .contains("unknown host adapter")
    );

    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("worker"), "#!/bin/sh\n").unwrap();
    let mut ambient_script = manifest();
    ambient_script.nodes[0].worker = "script".into();
    ambient_script.nodes[0].adapter = Some("aiko.neuron-json-stdio/v1".into());
    ambient_script.nodes[0].script = Some("worker".into());
    assert!(
        validate_manifest(&ambient_script, directory.path())
            .unwrap_err()
            .contains("local_reversible")
    );
    ambient_script.nodes[0].effect = "local_reversible".into();
    ambient_script.nodes[0].read_only = false;
    ambient_script.nodes[0].reversible = true;
    assert_eq!(validate_manifest(&ambient_script, directory.path()), Ok(()));
    std::fs::write(
        directory.path().join("worker"),
        vec![b'x'; MAX_SCRIPT_BYTES as usize + 1],
    )
    .unwrap();
    assert!(
        validate_manifest(&ambient_script, directory.path())
            .unwrap_err()
            .contains("bounded regular file")
    );
}

#[test]
fn resolves_only_named_dependency_evidence() {
    let manifest = manifest();
    let node = &manifest.nodes[1];
    let evidence = BTreeMap::from([(
        "git-state".into(),
        json!({"result": {"branch": "main"}, "ambient": "must not leak"}),
    )]);
    let resolved = resolve_input_bindings(node, &evidence).unwrap();
    assert_eq!(resolved["inspection"]["branch"], "main");
    assert!(!resolved.contains_key("ambient"));
    assert!(resolve_input_bindings(node, &BTreeMap::new()).is_err());
}

#[test]
fn ranks_matching_skill_and_namespaces_pointer_graph() {
    let skill = LoadedContractSkill {
        manifest: manifest(),
        directory: PathBuf::from("."),
        source: SkillSource::Bundled,
        admission: SkillAdmission::ManifestValidated,
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
    assert!(planned.core_admitted);
    assert_eq!(planned.selected[0].source, SkillSource::Embedded);
    assert_eq!(
        planned
            .selected
            .iter()
            .find(|skill| skill.id == "inspect-project")
            .unwrap()
            .source,
        SkillSource::Project
    );
    let summarize = planned
        .children
        .iter()
        .find(|node| node["key"] == "inspect-project--summarize")
        .unwrap();
    assert_eq!(summarize["depends_on"][0], "inspect-project--git-state");
    assert_eq!(
        summarize["input_bindings"]["inspection"],
        "inspect-project--git-state.result"
    );
}

#[test]
fn schedule_follow_up_declares_named_evidence_for_each_dependency() {
    let temporary = tempfile::tempdir().unwrap();
    let skill_root = temporary.path().join(".agents/skills/schedule-follow-up");
    std::fs::create_dir_all(&skill_root).unwrap();
    std::fs::write(
        skill_root.join(MANIFEST_NAME),
        include_str!("../../../../../../.agents/skills/schedule-follow-up/contract-skill.json"),
    )
    .unwrap();
    let planned = plan("Remind me tomorrow to check the build.", temporary.path());
    assert!(
        planned
            .selected
            .iter()
            .any(|skill| skill.id == "schedule-follow-up")
    );

    let deduplicate = planned
        .children
        .iter()
        .find(|node| node["key"] == "schedule-follow-up--deduplicate")
        .unwrap();
    assert_eq!(
        deduplicate["input_bindings"]["cadence"],
        "schedule-follow-up--parse-cadence.structured_result"
    );

    let schedule = planned
        .children
        .iter()
        .find(|node| node["key"] == "schedule-follow-up--schedule")
        .unwrap();
    assert_eq!(
        schedule["input_bindings"]["deduplication"],
        "schedule-follow-up--deduplicate.structured_result"
    );
    assert_eq!(schedule["effect_scope"], "local_reversible");
    assert_eq!(schedule["writes"], json!(["workspace://**"]));
    let preview = super::super::project_plan_preview(&planned).unwrap();
    let state_root = temporary.path().join("graph-state");
    std::fs::create_dir(&state_root).unwrap();
    let policy = super::super::graph_harness::EvaluationPolicy {
        mode: super::super::graph_harness::EvaluationMode::IsolatedLocal,
        max_authority: super::super::graph_harness::Authority {
            filesystem: vec![
                super::super::graph_harness::WORKSPACE_AUTHORITY.into(),
                super::super::graph_harness::EXECUTOR_SCRATCH_AUTHORITY.into(),
            ],
            network: vec![],
            process: vec![super::super::graph_harness::SANDBOXED_NEURON_PROCESS.into()],
            secrets: vec![],
        },
        allow_external_effects: false,
        state_root,
        workspace_root: temporary.path().to_path_buf(),
        deadline_ms: 3_600_000,
        signer_policy_id: "schedule-follow-up-regression".into(),
    };
    let runtime_digest =
        super::super::graph_harness::pinned_executable_digest(&std::env::current_exe().unwrap())
            .unwrap();
    let profile = super::super::graph_harness::embedded_host_profile(
        &preview,
        planned
            .selected
            .iter()
            .map(|skill| format!("skill:{}@{}", skill.id, skill.version))
            .collect(),
        &runtime_digest,
    );
    super::super::graph_harness::PreparedGraphAdapter::prepare(
        "Remind me tomorrow to check the build.",
        &preview,
        &profile,
        &policy,
    )
    .expect("schedule-follow-up must pass explicit GraphHarness binding admission");
}

/// Contract owns graph progress: only ready nodes are leased, exact evidence
/// unlocks dependents, and the Rust bridge cannot bypass ownership or replay.
#[test]
#[ignore = "run via scripts/witness-neuron-node-execution.sh"]
#[serial_test::serial]
fn native_node_execution_runs_the_meta_agent_fixed_point_without_opaque_agent() {
    use super::super::{
        NativeContract, NeuronSkillNodeSettlement, NeuronSkillWaveStatus, claim_cell_request,
    };

    struct RestoreCwd(PathBuf);
    impl Drop for RestoreCwd {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    let native = NativeContract::load().expect("load Contract ABI 13");
    assert_eq!(native.abi_version, 12);
    assert!(native.skill_node_claim.is_some());
    assert!(native.skill_node_settle.is_some());
    let project = tempfile::tempdir().expect("temporary execution project");
    std::fs::create_dir(project.path().join(".claude")).unwrap();
    let restore = RestoreCwd(std::env::current_dir().unwrap());
    std::env::set_current_dir(project.path()).unwrap();

    let root = "caf00d09";
    let occurrence = "once:ffi";
    let owner = "aiko-test-worker";
    let request = claim_cell_request(
        root,
        "unmatched-neuron-fixed-point",
        &project.path().to_string_lossy(),
    );
    let graph = native.expand_graph(&request).expect("admit graph");
    assert_eq!(graph["children"].as_array().unwrap().len(), 7);
    assert!(graph["graph_digest"].as_str().is_some());

    let mut now = 1_000_u64;
    let mut firings = 0usize;
    let mut observed_named_injection = false;
    loop {
        let wave = native
            .claim_skill_nodes(root, occurrence, owner, now, 10_000, 4)
            .expect("claim next wave");
        now += 1;
        match wave.status {
            NeuronSkillWaveStatus::Complete => {
                assert_eq!(
                    wave.terminal_evidence.unwrap()["settlement"]["completed"],
                    true
                );
                break;
            }
            NeuronSkillWaveStatus::Wave => {
                assert!(!wave.nodes.is_empty());
                assert!(wave.nodes.iter().all(|node| {
                    if node.worker == "host" {
                        node.adapter.as_deref().is_some_and(|adapter| {
                            adapter.starts_with("aiko.meta.") && adapter.ends_with("/v1")
                        })
                    } else {
                        node.adapter.is_none()
                    }
                }));
                assert!(
                    wave.nodes
                        .iter()
                        .all(|node| node.script.is_none() && node.script_digest.is_none())
                );
                if firings == 0 {
                    let competing = native
                        .claim_skill_nodes(root, occurrence, "other-worker", now, 10_000, 4)
                        .expect("competing claim response");
                    assert_eq!(competing.status, NeuronSkillWaveStatus::Waiting);
                }
                for node in wave.nodes {
                    if node.key == "aiko-meta-agent--recall" {
                        assert_eq!(
                            node.inputs["context_references"],
                            "private-node-evidence-marker"
                        );
                        observed_named_injection = true;
                    }
                    let mut evidence = serde_json::Map::new();
                    for requirement in &node.evidence_requirements {
                        let value = if requirement == "context_references" {
                            json!("private-node-evidence-marker")
                        } else if requirement == "settlement" {
                            json!({
                                "completed": true,
                                "retryable": false,
                                "evidence": "private-terminal-proof",
                            })
                        } else {
                            json!({"producer": node.key, "output": requirement})
                        };
                        evidence.insert(requirement.clone(), value);
                    }
                    let evidence = Value::Object(evidence);
                    let decision = super::super::neuron_bridge::skill_node_decision(
                        &node,
                        "satisfied",
                        &evidence,
                        now,
                    )
                    .expect("canonical Neuron decision");
                    let settlement = NeuronSkillNodeSettlement {
                        root_id: root.into(),
                        root_occurrence: occurrence.into(),
                        owner: owner.into(),
                        execution_id: node.execution_id.clone(),
                        attempt: node.attempt,
                        outcome: "satisfied".into(),
                        evidence,
                        detail: "private-node-detail".into(),
                        decision,
                    };
                    if firings == 0 {
                        let mut forged = settlement.clone();
                        forged.owner = "other-worker".into();
                        assert!(native.settle_skill_node(&forged, now).is_none());
                        let mut missing = settlement.clone();
                        missing.evidence = json!({});
                        assert!(native.settle_skill_node(&missing, now).is_none());
                    }
                    let committed = native
                        .settle_skill_node(&settlement, now)
                        .expect("settle exact evidence");
                    assert_eq!(committed.status, "committed");
                    if firings == 0 {
                        let replay = native
                            .settle_skill_node(&settlement, now + 20_000)
                            .expect("replay after lease expiry");
                        assert_eq!(replay.status, "replayed");
                        assert_eq!(replay.firing_id, committed.firing_id);
                    }
                    firings += 1;
                    now += 1;
                }
            }
            status => panic!("unexpected graph status: {status:?}"),
        }
    }
    assert_eq!(firings, 7);
    assert!(observed_named_injection);
    let ledger = std::fs::read_to_string(project.path().join(".claude/contracts.jsonl")).unwrap();
    assert_eq!(
        ledger.matches("\"event\":\"neuron_transaction\"").count(),
        7
    );
    assert_eq!(ledger.matches("\"event\":\"neuron_fired\"").count(), 7);
    assert_eq!(
        ledger
            .matches("\"event\":\"neuron_skill_node_settled\"")
            .count(),
        7
    );
    assert!(ledger.contains("private-node-evidence-marker"));
    assert!(ledger.contains("private-terminal-proof"));
    assert!(ledger.contains("\"evidence_payload\""));
    assert!(!ledger.contains("agent:aiko"));
    drop(restore);
}
