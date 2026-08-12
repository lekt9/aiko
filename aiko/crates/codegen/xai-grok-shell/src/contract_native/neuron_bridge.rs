//! Typed Aiko host adapter for Contract's canonical Neuron ABI.
//!
//! This module is intentionally only a bridge. Contract remains the interpreter
//! and ledger; the existing Aiko turn is wrapped as a legacy Neuron until its
//! admitted Skill replacement passes the parity and rollback gates.

use super::{NativeContract, valid_contract_id};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CString, c_char};
use std::path::{Path, PathBuf};

#[path = "typed_neuron_wire.rs"]
mod typed_neuron_wire;
pub(super) use typed_neuron_wire::NeuronDecision;
use typed_neuron_wire::{
    CAPS_SCHEMA as NEURON_CAPS_SCHEMA, CORE_VERSION as NEURON_CORE_VERSION,
    DECISION_VECTOR as NEURON_DECISION_VECTOR, FIRE_SCHEMA as NEURON_FIRE_SCHEMA,
    FIRING_VECTOR as NEURON_FIRING_VECTOR, HASH_PROFILE as NEURON_HASH_PROFILE, NeuronCaps,
    NeuronControl, NeuronEffect, NeuronEvidence, NeuronFireRequest, NeuronFireResult,
    NeuronFireStatus, NeuronIdentity, NeuronStimulus, PACKAGE_DIGEST as NEURON_PACKAGE_DIGEST,
    RESULT_SCHEMA as NEURON_RESULT_SCHEMA, SCHEMA_DIGEST as NEURON_SCHEMA_DIGEST,
};

const NEURON_NATIVE_ENV: &str = "AIKO_NEURON_NATIVE";
const SKILL_TRANSITION_SCHEMA: &str = "contract.neuron-skill.transition/v1";
const SKILL_TRANSITION_RESULT_SCHEMA: &str = "contract.neuron-skill.transition-result/v1";
const SKILL_STATE_SCHEMA: &str = "contract.neuron-skill.state/v1";
const SKILL_STATE_RESULT_SCHEMA: &str = "contract.neuron-skill.state-result/v1";
const NODE_CLAIM_SCHEMA: &str = "contract.neuron-skill-node.claim/v1";
const NODE_CLAIM_RESULT_SCHEMA: &str = "contract.neuron-skill-node.claim-result/v1";
const NODE_SETTLE_SCHEMA: &str = "contract.neuron-skill-node.settle/v1";
const NODE_SETTLE_RESULT_SCHEMA: &str = "contract.neuron-skill-node.settle-result/v1";
const MIN_CONTRACT_ABI: u32 = 2;
const MAX_SKILL_ARTIFACT_BYTES: usize = 1024 * 1024;
const MAX_SKILL_ARTIFACT_FILES: usize = 256;
pub(super) const NEURON_FIRE_ABI_VERSION: u32 = 12;
pub(super) const SKILL_LIFECYCLE_ABI_VERSION: u32 = 8;
pub(super) const SKILL_EXECUTION_ABI_VERSION: u32 = 12;
pub(super) const CONTRACT_ABI_VERSION: u32 = 13;

#[derive(Debug, Clone)]
pub(super) struct ToolEffectAdmission {
    pub firing_id: String,
    pub effect_index: u64,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct SkillArtifact {
    pub id: String,
    pub version: String,
    pub digest: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(super) struct SkillProofs {
    pub manifest_digest: String,
    pub instructions_digest: String,
    pub eval_digest: String,
    pub witness_digest: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(super) struct SkillAdmissionGates {
    pub manifest_valid: bool,
    pub instructions_valid: bool,
    pub evals_passed: bool,
    pub witness_passed: bool,
    pub provenance_valid: bool,
    pub privacy_valid: bool,
    pub replay_valid: bool,
    pub rollback_ready: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(super) struct SkillTransitionRequest {
    pub schema: &'static str,
    pub stimulus_id: String,
    pub artifact: SkillArtifact,
    pub action: String,
    pub proofs: SkillProofs,
    pub gates: SkillAdmissionGates,
    pub actor_digest: String,
    pub authority: bool,
    pub supersedes_digest: Option<String>,
    pub now_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum SkillLifecycleState {
    Absent,
    Candidate,
    Admitted,
    Active,
    Retired,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(super) struct SkillTransitionResult {
    schema: String,
    status: String,
    transition_id: String,
    request_digest: String,
    pub state: SkillLifecycleState,
    pub active_digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(super) struct SkillStateResult {
    schema: String,
    skill_id: String,
    skill_version: String,
    skill_digest: String,
    pub state: SkillLifecycleState,
    pub active_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NeuronSkillWaveStatus {
    Wave,
    Waiting,
    Held,
    Failed,
    Complete,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphHarnessClaimIdentity {
    pub api_version: String,
    pub state: String,
    pub subject_digest: String,
    pub transitive_digest: String,
    pub adapter: String,
    pub bundle_ref: String,
    pub evaluation_policy: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NeuronSkillNodeOccurrence {
    pub execution_id: String,
    pub attempt: u32,
    pub node_id: String,
    pub key: String,
    pub plan: String,
    pub action: String,
    pub worker: String,
    pub adapter: Option<String>,
    pub script: Option<String>,
    pub script_digest: Option<String>,
    #[serde(default)]
    pub cell_digest: Option<String>,
    #[serde(default)]
    pub witness_id: Option<String>,
    #[serde(default)]
    pub witness_digest: Option<String>,
    #[serde(default)]
    pub judge_digest: Option<String>,
    pub effect_scope: String,
    pub read_only: bool,
    pub reversible: bool,
    pub timeout_ms: u64,
    pub sandbox: String,
    pub skill_id: String,
    pub skill_version: String,
    pub inputs: serde_json::Value,
    pub evidence_requirements: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NeuronSkillWave {
    schema: String,
    abi_version: u32,
    pub status: NeuronSkillWaveStatus,
    pub root_id: String,
    pub graph_digest: String,
    #[serde(default)]
    pub graph_harness: Option<GraphHarnessClaimIdentity>,
    pub terminal_evidence: Option<serde_json::Value>,
    pub nodes: Vec<NeuronSkillNodeOccurrence>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NeuronSkillNodeSettlement {
    pub root_id: String,
    pub root_occurrence: String,
    pub owner: String,
    pub execution_id: String,
    pub attempt: u32,
    pub outcome: String,
    pub evidence: serde_json::Value,
    pub detail: String,
    pub decision: NeuronDecision,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NeuronSkillNodeSettlementResult {
    schema: String,
    abi_version: u32,
    pub status: String,
    pub execution_id: String,
    pub outcome: String,
    pub evidence_digest: String,
    pub firing_id: String,
}

pub(super) type NeuronFireFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
pub(super) type NeuronEffectSettleFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
pub(super) type SkillTransitionFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
pub(super) type SkillStateFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
pub(super) type SkillNodeClaimFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
pub(super) type SkillNodeSettleFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;

/// Contract's ABI is additive: every version keeps the older exports and adds
/// new ones. A library NEWER than this build is therefore usable at the subset
/// this build knows — refusing it outright turned one stale binary into a total
/// substrate blackout (no route, no muscle, no neuron, every turn "degraded").
/// The structural signal for a capability is the presence of its symbol, not a
/// version number, so only the floor is a real bound.
pub(super) fn supported_contract_abi(version: u32) -> bool {
    version >= MIN_CONTRACT_ABI
}

/// The ABI actually spoken with a loaded library: what it offers, capped by
/// what this build understands.
pub(super) fn negotiated_contract_abi(library_version: u32) -> u32 {
    library_version.min(CONTRACT_ABI_VERSION)
}

fn neuron_native_enabled() -> bool {
    let configured = std::env::var(NEURON_NATIVE_ENV).ok();
    neuron_native_enabled_from(configured.as_deref())
}

fn neuron_native_enabled_from(configured: Option<&str>) -> bool {
    !configured.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "off" | "false" | "legacy"
        )
    })
}

fn sha256_hex(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical_node_evidence(
    node: &NeuronSkillNodeOccurrence,
    outcome: &str,
    evidence: &serde_json::Value,
) -> Option<Vec<u8>> {
    if outcome != "satisfied" {
        return Some(b"{}".to_vec());
    }
    let object = evidence.as_object()?;
    if object.len() != node.evidence_requirements.len() {
        return None;
    }
    let mut canonical = String::from("{");
    for (index, requirement) in node.evidence_requirements.iter().enumerate() {
        let value = object.get(requirement)?;
        if index > 0 {
            canonical.push(',');
        }
        canonical.push_str(&serde_json::to_string(requirement).ok()?);
        canonical.push(':');
        canonical.push_str(&serde_json::to_string(value).ok()?);
    }
    canonical.push('}');
    Some(canonical.into_bytes())
}

pub(super) fn skill_node_decision(
    node: &NeuronSkillNodeOccurrence,
    outcome: &str,
    evidence: &serde_json::Value,
    now_ms: u64,
) -> Option<NeuronDecision> {
    let canonical = canonical_node_evidence(node, outcome, evidence)?;
    let evidence_digest = sha256_bytes(&canonical);
    let payload_digest = sha256_hex(&[
        "contract.neuron-skill-node.stimulus/v1",
        &node.execution_id,
        &node.attempt.to_string(),
    ]);
    let mut effects = vec![NeuronEffect {
        kind: "write".into(),
        target: format!("artifact:{evidence_digest}"),
        schema: "contract.neuron-skill-node-effect/v1".into(),
        payload_digest: evidence_digest.clone(),
        bytes: canonical.len() as u64,
        idempotency_key: format!("{}/{}/0", node.execution_id, node.attempt),
    }];
    if outcome == "satisfied" && !node.read_only {
        let kind = match node.effect_scope.as_str() {
            "external_message" | "publish" => "send",
            "process_spawn" => "spawn",
            _ => "write",
        };
        effects.push(NeuronEffect {
            kind: kind.into(),
            target: format!("scope:{}", node.effect_scope),
            schema: "contract.neuron-skill-node-effect/v1".into(),
            payload_digest: evidence_digest.clone(),
            bytes: 0,
            idempotency_key: format!("{}/{}/1", node.execution_id, node.attempt),
        });
    }
    Some(NeuronDecision {
        control: NeuronControl {
            kind: "continue".into(),
            value: outcome.into(),
        },
        effects,
        evidence: vec![NeuronEvidence {
            claim: "typed Skill node returned its declared evidence shape".into(),
            sources: vec![payload_digest],
            method: "Aiko Neuron execution adapter".into(),
            digest: evidence_digest,
            producer: format!("skill/{}/{}", node.skill_id, node.key),
            observed_at_ms: now_ms,
            confidence_milli: if outcome == "satisfied" { 1000 } else { 0 },
        }],
    })
}

fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Adapt the provider's terminal event without persisting prompt text.
///
/// This is an explicit host-boundary adapter, not an agent or a task-execution
/// node. Contract sees only the stable adapter identity and SHA-256 commitments;
/// the admitted Meta-Agent Skill graph owns the actual task topology.
fn turn_terminal_adapter_firing(contract_id: &str, goal: &str) -> Option<NeuronFireRequest> {
    if !valid_contract_id(contract_id) || goal.trim().is_empty() {
        return None;
    }
    let payload_digest = sha256_hex(&[
        "aiko.turn-terminal/v1",
        contract_id,
        goal,
        "provider_end_turn",
    ]);
    let verdict_digest = sha256_hex(&[
        "aiko.contract-verdict/v1",
        contract_id,
        &payload_digest,
        "grounded_children",
    ]);
    let observed_at_ms = unix_now_ms();
    let evidence_digest = sha256_hex(&[
        "neuron.evidence/v1",
        &payload_digest,
        "adapter/aiko-turn-terminal",
        "provider_end_turn",
    ]);
    Some(NeuronFireRequest {
        schema: NEURON_FIRE_SCHEMA.into(),
        neuron: NeuronIdentity {
            id: "adapter/aiko-turn-terminal".into(),
            version: "2".into(),
            digest: sha256_hex(&["aiko.neuron.turn-terminal-adapter/v1"]),
        },
        stimulus: NeuronStimulus {
            id: format!("aiko-turn-{contract_id}"),
            schema: "aiko.turn-terminal/v1".into(),
            payload_digest: payload_digest.clone(),
            read_digests: vec![],
            messages: vec![],
            now_ms: observed_at_ms,
            deadline_ms: None,
            random_digest: None,
            adapter_versions: vec![format!("aiko/{NEURON_CORE_VERSION}/{NEURON_SCHEMA_DIGEST}")],
        },
        caps: NeuronCaps {
            schema: NEURON_CAPS_SCHEMA.into(),
            fingerprint: sha256_hex(&[
                "aiko.neuron.caps/v1",
                "write",
                "max_effects=1",
                "max_bytes=0",
            ]),
            grants: vec![],
            effects: vec!["write".into()],
            max_effects: 1,
            max_bytes: 0,
            max_cost_micros: 0,
        },
        decision: NeuronDecision {
            control: NeuronControl {
                kind: "terminate".into(),
                value: "provider_end_turn".into(),
            },
            effects: vec![NeuronEffect {
                kind: "write".into(),
                target: format!("contract:{contract_id}"),
                schema: "aiko.contract-verdict/v1".into(),
                payload_digest: verdict_digest,
                bytes: 0,
                idempotency_key: format!("aiko-turn-{contract_id}/0"),
            }],
            evidence: vec![NeuronEvidence {
                claim: "the provider reached Aiko's typed terminal boundary".into(),
                sources: vec![payload_digest],
                method: "host adapter over the provider-owned turn terminal".into(),
                digest: evidence_digest,
                producer: "adapter/aiko-turn-terminal".into(),
                observed_at_ms,
                confidence_milli: 1000,
            }],
        },
    })
}

impl NativeContract {
    pub(super) fn fire_neuron(&self, request: &NeuronFireRequest) -> Option<NeuronFireResult> {
        let fire = self.neuron_fire?;
        let expected_effects = request.decision.effects.len() as u64;
        let encoded = CString::new(serde_json::to_vec(request).ok()?).ok()?;
        let raw = self.take_string(unsafe { fire(encoded.as_ptr()) })?;
        let result: NeuronFireResult = serde_json::from_str(&raw).ok()?;
        (result.schema == NEURON_RESULT_SCHEMA
            && result.abi_version == self.abi_version
            && valid_sha256_hex(&result.firing_id)
            && valid_sha256_hex(&result.decision_digest)
            && result.effects_admitted == expected_effects)
            .then_some(result)
    }

    pub(super) fn transition_skill(
        &self,
        request: &SkillTransitionRequest,
    ) -> Option<SkillTransitionResult> {
        let transition = self.skill_transition?;
        let encoded = CString::new(serde_json::to_vec(request).ok()?).ok()?;
        let raw = self.take_string(unsafe { transition(encoded.as_ptr()) })?;
        let result: SkillTransitionResult = serde_json::from_str(&raw).ok()?;
        (result.schema == SKILL_TRANSITION_RESULT_SCHEMA
            && matches!(result.status.as_str(), "committed" | "replayed")
            && valid_sha256_hex(&result.transition_id)
            && valid_sha256_hex(&result.request_digest)
            && result.active_digest.as_deref().is_none_or(valid_sha256_hex))
        .then_some(result)
    }

    pub(super) fn admit_tool_effect(
        &self,
        root_id: &str,
        execution_id: &str,
        call_id: &str,
        tool_name: &str,
        raw_arguments: &str,
        read_only: bool,
        now_ms: u64,
    ) -> Option<Option<ToolEffectAdmission>> {
        if !valid_contract_id(root_id)
            || !valid_sha256_hex(execution_id)
            || call_id.trim().is_empty()
            || tool_name.trim().is_empty()
        {
            return None;
        }
        let payload_digest = sha256_bytes(raw_arguments.as_bytes());
        let idempotency_key = sha256_hex(&[
            "aiko.tool-effect/v1",
            execution_id,
            call_id,
            &payload_digest,
        ]);
        let evidence_digest = sha256_hex(&[
            "neuron.evidence/v1",
            &payload_digest,
            "adapter/aiko-tool-membrane",
            tool_name,
        ]);
        let effects = if read_only {
            vec![]
        } else {
            vec![NeuronEffect {
                kind: "write".into(),
                target: format!("adapter:tool/{tool_name}"),
                schema: "aiko.tool-effect/v1".into(),
                payload_digest: payload_digest.clone(),
                bytes: raw_arguments.len() as u64,
                idempotency_key: idempotency_key.clone(),
            }]
        };
        let request = NeuronFireRequest {
            schema: NEURON_FIRE_SCHEMA.into(),
            neuron: NeuronIdentity {
                id: "adapter/aiko-tool-membrane".into(),
                version: "1".into(),
                digest: sha256_hex(&["aiko.neuron.tool-membrane/v1", NEURON_PACKAGE_DIGEST]),
            },
            stimulus: NeuronStimulus {
                id: format!("tool:{execution_id}:{call_id}"),
                schema: "aiko.tool-call/v1".into(),
                payload_digest: payload_digest.clone(),
                read_digests: vec![],
                messages: vec![],
                now_ms,
                deadline_ms: None,
                random_digest: None,
                adapter_versions: vec![format!(
                    "aiko/{NEURON_CORE_VERSION}/{NEURON_PACKAGE_DIGEST}"
                )],
            },
            caps: NeuronCaps {
                schema: NEURON_CAPS_SCHEMA.into(),
                fingerprint: sha256_hex(&[
                    "aiko.tool-caps/v1",
                    root_id,
                    execution_id,
                    tool_name,
                    if read_only { "read" } else { "write" },
                ]),
                grants: vec![],
                effects: if read_only {
                    vec![]
                } else {
                    vec!["write".into()]
                },
                max_effects: if read_only { 0 } else { 1 },
                max_bytes: if read_only {
                    0
                } else {
                    raw_arguments.len() as u64
                },
                max_cost_micros: 0,
            },
            decision: NeuronDecision {
                control: NeuronControl {
                    kind: "continue".into(),
                    value: "dispatch_capability_adapter".into(),
                },
                effects,
                evidence: vec![NeuronEvidence {
                    claim: "the leased Neuron requested this exact capability invocation".into(),
                    sources: vec![payload_digest],
                    method: "Aiko tool membrane admission".into(),
                    digest: evidence_digest,
                    producer: "adapter/aiko-tool-membrane".into(),
                    observed_at_ms: now_ms,
                    confidence_milli: 1000,
                }],
            },
        };
        let result = self.fire_neuron(&request)?;
        if result.status == NeuronFireStatus::Replayed {
            // An adapter effect may have happened before a crash. Never execute
            // it twice: an operator/reconciler must settle the existing outbox.
            return if read_only { Some(None) } else { None };
        }
        Some((!read_only).then_some(ToolEffectAdmission {
            firing_id: result.firing_id,
            effect_index: 0,
            idempotency_key,
        }))
    }

    pub(super) fn settle_tool_effect(
        &self,
        admission: &ToolEffectAdmission,
        success: bool,
        now_ms: u64,
    ) -> bool {
        let Some(settle) = self.neuron_effect_settle else {
            return false;
        };
        let evidence_digest = sha256_hex(&[
            "aiko.tool-effect.receipt/v1",
            &admission.firing_id,
            &admission.effect_index.to_string(),
            &admission.idempotency_key,
            if success { "committed" } else { "failed" },
        ]);
        let request = serde_json::json!({
            "schema": "neuron.effect-settle/v1",
            "firing_id": admission.firing_id,
            "effect_index": admission.effect_index,
            "idempotency_key": admission.idempotency_key,
            "outcome": if success { "committed" } else { "failed" },
            "evidence_digest": evidence_digest,
            "observed_at_ms": now_ms,
        });
        let Some(encoded) = serde_json::to_vec(&request)
            .ok()
            .and_then(|bytes| CString::new(bytes).ok())
        else {
            return false;
        };
        let Some(raw) = self.take_string(unsafe { settle(encoded.as_ptr()) }) else {
            return false;
        };
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .is_some_and(|result| {
                result.get("schema").and_then(serde_json::Value::as_str)
                    == Some("neuron.effect-settle-result/v1")
                    && result
                        .get("abi_version")
                        .and_then(serde_json::Value::as_u64)
                        == Some(u64::from(self.abi_version))
                    && matches!(
                        result.get("status").and_then(serde_json::Value::as_str),
                        Some("committed" | "replayed")
                    )
            })
    }

    pub(super) fn skill_state(&self, artifact: &SkillArtifact) -> Option<SkillStateResult> {
        let state = self.skill_state?;
        let request = serde_json::json!({
            "schema": SKILL_STATE_SCHEMA,
            "artifact": artifact,
        });
        let encoded = CString::new(serde_json::to_vec(&request).ok()?).ok()?;
        let raw = self.take_string(unsafe { state(encoded.as_ptr()) })?;
        let result: SkillStateResult = serde_json::from_str(&raw).ok()?;
        (result.schema == SKILL_STATE_RESULT_SCHEMA
            && result.skill_id == artifact.id
            && result.skill_version == artifact.version
            && result.skill_digest == artifact.digest
            && result.active_digest.as_deref().is_none_or(valid_sha256_hex))
        .then_some(result)
    }

    pub(super) fn claim_skill_nodes(
        &self,
        root_id: &str,
        root_occurrence: &str,
        owner: &str,
        now_ms: u64,
        lease_ms: u64,
        max_nodes: usize,
    ) -> Option<NeuronSkillWave> {
        let claim = self.skill_node_claim?;
        let request = serde_json::json!({
            "schema": NODE_CLAIM_SCHEMA,
            "root_id": root_id,
            "root_occurrence": root_occurrence,
            "owner": owner,
            "now_ms": now_ms,
            "lease_ms": lease_ms,
            "max_nodes": max_nodes,
        });
        let encoded = CString::new(serde_json::to_vec(&request).ok()?).ok()?;
        let raw = self.take_string(unsafe { claim(encoded.as_ptr()) })?;
        let result: NeuronSkillWave = serde_json::from_str(&raw).ok()?;
        (result.schema == NODE_CLAIM_RESULT_SCHEMA
            && result.abi_version == self.abi_version
            && result.root_id == root_id
            && valid_sha256_hex(&result.graph_digest)
            && result.nodes.iter().all(|node| {
                valid_sha256_hex(&node.execution_id)
                    && node.attempt > 0
                    && !node.evidence_requirements.is_empty()
                    && match node.worker.as_str() {
                        "aiko" => {
                            node.adapter.is_none()
                                && node.script.is_none()
                                && node.script_digest.is_none()
                        }
                        "host" => {
                            node.adapter
                                .as_deref()
                                .is_some_and(|value| !value.is_empty())
                                && node.script.is_none()
                                && node.script_digest.is_none()
                        }
                        "script" => {
                            node.adapter.as_deref() == Some("aiko.neuron-json-stdio/v1")
                                && node
                                    .script
                                    .as_deref()
                                    .is_some_and(|value| !value.is_empty())
                                && node.script_digest.as_deref().is_some_and(valid_sha256_hex)
                        }
                        _ => false,
                    }
            }))
        .then_some(result)
    }

    pub(super) fn settle_skill_node(
        &self,
        settlement: &NeuronSkillNodeSettlement,
        now_ms: u64,
    ) -> Option<NeuronSkillNodeSettlementResult> {
        let settle = self.skill_node_settle?;
        let request = serde_json::json!({
            "schema": NODE_SETTLE_SCHEMA,
            "root_id": settlement.root_id,
            "root_occurrence": settlement.root_occurrence,
            "owner": settlement.owner,
            "execution_id": settlement.execution_id,
            "attempt": settlement.attempt,
            "outcome": settlement.outcome,
            "evidence": settlement.evidence,
            "detail": settlement.detail,
            "decision": settlement.decision,
            "now_ms": now_ms,
        });
        let encoded = CString::new(serde_json::to_vec(&request).ok()?).ok()?;
        let raw = self.take_string(unsafe { settle(encoded.as_ptr()) })?;
        let result: NeuronSkillNodeSettlementResult = serde_json::from_str(&raw).ok()?;
        (result.schema == NODE_SETTLE_RESULT_SCHEMA
            && result.abi_version == self.abi_version
            && matches!(result.status.as_str(), "committed" | "replayed")
            && result.execution_id == settlement.execution_id
            && result.outcome == settlement.outcome
            && valid_sha256_hex(&result.evidence_digest)
            && valid_sha256_hex(&result.firing_id))
        .then_some(result)
    }

    /// ABI v7+ owns the typed terminal decision record. Older ABIs and an
    /// explicit operator opt-out retain the pre-Neuron compatibility path.
    pub(super) fn admit_turn_terminal(&self, contract_id: &str, goal: &str) -> bool {
        if !neuron_native_enabled() || self.neuron_fire.is_none() {
            return true;
        }
        let Some(request) = turn_terminal_adapter_firing(contract_id, goal) else {
            return false;
        };
        let Some(result) = self.fire_neuron(&request) else {
            tracing::warn!(
                contract_id,
                "Contract rejected Aiko's typed turn-terminal adapter; holding settlement"
            );
            return false;
        };
        tracing::debug!(
            contract_id,
            firing_id = %result.firing_id,
            status = ?result.status,
            "Contract admitted Aiko's typed turn-terminal adapter"
        );
        true
    }
}

pub(super) fn generated_skill_state(artifact: &SkillArtifact) -> Option<SkillStateResult> {
    super::native_contract()?.skill_state(artifact)
}

/// Hash an immutable Skill directory exactly as the generator does. Symlinks,
/// non-UTF-8 paths, oversized packages, and mutable special files fail closed.
pub(super) fn generated_skill_artifact(
    directory: &Path,
    id: &str,
    version: &str,
) -> Option<SkillArtifact> {
    fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Option<()> {
        let entries = std::fs::read_dir(directory).ok()?;
        for entry in entries {
            let path = entry.ok()?.path();
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if metadata.file_type().is_symlink() {
                return None;
            }
            if metadata.is_dir() {
                collect(root, &path, files)?;
            } else if metadata.is_file() {
                path.strip_prefix(root).ok()?.to_str()?;
                files.push(path);
                if files.len() > MAX_SKILL_ARTIFACT_FILES {
                    return None;
                }
            } else {
                return None;
            }
        }
        Some(())
    }

    let mut files = Vec::new();
    collect(directory, directory, &mut files)?;
    files.sort_by(|left, right| {
        left.strip_prefix(directory)
            .ok()
            .cmp(&right.strip_prefix(directory).ok())
    });
    let mut hasher = Sha256::new();
    let domain = "aiko.neuron-skill.bundle/v1";
    hasher.update((domain.len() as u64).to_le_bytes());
    hasher.update(domain.as_bytes());
    let mut bytes = 0usize;
    for path in files {
        let relative = path
            .strip_prefix(directory)
            .ok()?
            .to_str()?
            .replace('\\', "/");
        let content = std::fs::read(path).ok()?;
        bytes = bytes.checked_add(content.len())?;
        if bytes > MAX_SKILL_ARTIFACT_BYTES {
            return None;
        }
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(&content);
    }
    if bytes == 0 {
        return None;
    }
    Some(SkillArtifact {
        id: id.to_owned(),
        version: version.to_owned(),
        digest: format!("{:x}", hasher.finalize()),
        bytes,
    })
}

pub(super) fn generated_skill_is_active(artifact: &SkillArtifact) -> bool {
    generated_skill_state(artifact).is_some_and(|state| {
        state.state == SkillLifecycleState::Active
            && state.active_digest.as_deref() == Some(&artifact.digest)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn generated_wire_binding_matches_canonical_vectors() {
        assert_eq!(NEURON_CORE_VERSION, "typed-neuron/2");
        assert_eq!(NEURON_HASH_PROFILE, "deterministic-cbor-sha256/1");
        assert!(valid_sha256_hex(NEURON_SCHEMA_DIGEST));
        assert_eq!(
            NEURON_FIRING_VECTOR,
            "0f9b9bd0c968af050a021557f3ec62e2f6ed622d42b2f64cf169e560bcb62d9b"
        );
        assert_eq!(
            NEURON_DECISION_VECTOR,
            "1fda1ac7aef670317fee571651689f642e0ba32d46140d2d05af007d6fb9d596"
        );
    }

    #[test]
    fn neuron_abi_rollout_preserves_legacy_compatibility() {
        assert!(!supported_contract_abi(1));
        for version in MIN_CONTRACT_ABI..=CONTRACT_ABI_VERSION {
            assert!(supported_contract_abi(version));
            assert_eq!(negotiated_contract_abi(version), version);
        }
        // A newer Contract stays usable at this build's known subset instead
        // of degrading the whole substrate to "unavailable".
        assert!(supported_contract_abi(CONTRACT_ABI_VERSION + 1));
        assert_eq!(
            negotiated_contract_abi(CONTRACT_ABI_VERSION + 7),
            CONTRACT_ABI_VERSION
        );
        assert!(neuron_native_enabled_from(None));
        assert!(neuron_native_enabled_from(Some("on")));
        assert!(!neuron_native_enabled_from(Some("off")));
        assert!(!neuron_native_enabled_from(Some(" FALSE ")));
        assert!(!neuron_native_enabled_from(Some("legacy")));
    }

    #[test]
    fn turn_terminal_adapter_is_typed_grounded_bounded_and_private() {
        let raw_goal = "repair super-secret-user-visible-goal";
        let request =
            turn_terminal_adapter_firing("caf00d01", raw_goal).expect("valid adapter firing");
        assert_eq!(request.schema, NEURON_FIRE_SCHEMA);
        assert_eq!(request.neuron.id, "adapter/aiko-turn-terminal");
        assert!(valid_sha256_hex(&request.neuron.digest));
        assert!(valid_sha256_hex(&request.stimulus.payload_digest));
        assert_eq!(request.caps.effects, vec!["write"]);
        assert_eq!(request.caps.max_effects, 1);
        assert_eq!(request.caps.max_bytes, 0);
        assert_eq!(request.decision.effects.len(), 1);
        assert_eq!(request.decision.effects[0].target, "contract:caf00d01");
        assert_eq!(request.decision.effects[0].bytes, 0);
        assert_eq!(
            request.decision.evidence[0].sources,
            vec![request.stimulus.payload_digest.clone()]
        );
        let encoded = serde_json::to_string(&request).expect("serialize typed firing");
        assert!(!encoded.contains(raw_goal));

        let changed =
            turn_terminal_adapter_firing("caf00d01", "a different goal").expect("changed firing");
        assert_eq!(changed.stimulus.id, request.stimulus.id);
        assert_ne!(
            changed.stimulus.payload_digest,
            request.stimulus.payload_digest
        );
    }

    #[test]
    #[ignore = "run by graph-engineering-gate.sh against the built Contract dylib"]
    fn native_graph_abi13_loads_observable_abandonment() {
        let native = NativeContract::load().expect("load Contract ABI 13 library");
        assert_eq!(native.abi_version, CONTRACT_ABI_VERSION);
        assert!(native.expand_graph.is_some());
        assert!(native.abandon_graph.is_some());
    }

    /// Contract discovers its ledger from process CWD, so the pinned witness
    /// runs this ignored test alone under a serialized temporary CWD.
    #[test]
    #[ignore = "run via scripts/witness-neuron-native-slice.sh"]
    #[serial_test::serial]
    fn neuron_native_ffi_commits_replays_and_rejects_contradiction() {
        struct RestoreCwd(PathBuf);
        impl Drop for RestoreCwd {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }

        let native = NativeContract::load().expect("load Contract native library");
        assert_eq!(native.abi_version, CONTRACT_ABI_VERSION);
        assert!(native.neuron_fire.is_some());
        assert!(native.neuron_effect_settle.is_some());

        let project = tempfile::tempdir().expect("temporary Neuron project");
        std::fs::create_dir(project.path().join(".claude")).expect("temporary ledger directory");
        let restore = RestoreCwd(std::env::current_dir().expect("current directory"));
        std::env::set_current_dir(project.path()).expect("enter temporary project");

        let raw_goal = "private ffi witness goal";
        let request =
            turn_terminal_adapter_firing("caf00d01", raw_goal).expect("typed terminal firing");
        let first = native.fire_neuron(&request).expect("first firing admitted");
        assert_eq!(first.status, NeuronFireStatus::Committed);
        assert_eq!(first.effects_admitted, 1);
        let replay = native
            .fire_neuron(&request)
            .expect("identical firing replayed");
        assert_eq!(replay.status, NeuronFireStatus::Replayed);
        assert_eq!(replay.firing_id, first.firing_id);
        assert_eq!(replay.decision_digest, first.decision_digest);
        let admission = ToolEffectAdmission {
            firing_id: first.firing_id.clone(),
            effect_index: 0,
            idempotency_key: request.decision.effects[0].idempotency_key.clone(),
        };
        assert!(native.settle_tool_effect(&admission, true, 1));
        assert!(
            native.settle_tool_effect(&admission, true, 1),
            "identical adapter acknowledgement must replay"
        );

        let mut contradictory = request.clone();
        contradictory.decision.control.value = "contradictory_decision".into();
        assert!(native.fire_neuron(&contradictory).is_none());

        let ledger = std::fs::read_to_string(project.path().join(".claude/contracts.jsonl"))
            .expect("read temporary Contract ledger");
        assert_eq!(ledger.matches("\"event\":\"neuron_fired\"").count(), 1);
        assert_eq!(
            ledger
                .matches("\"event\":\"neuron_effect_settled\"")
                .count(),
            1
        );
        assert!(!ledger.contains(raw_goal));
        assert!(!ledger.contains("contradictory goal"));
        drop(restore);
    }
}
