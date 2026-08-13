//! Embedded GraphHarness authoring and admission core.
//!
//! This module is deliberately independent of `contract_native` private types.
//! Integration converts the output of `skill_registry::plan_bounded` into
//! [`PlanPreview`] once, calls [`PreparedGraphAdapter::prepare`], and passes
//! [`GraphHarnessContractAdapter::expand_request`] verbatim to
//! `contract_expand_json`. It does not schedule, lease, execute, or settle.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const ROUTE_API_VERSION: &str = "aiko-workflow-route/v1";
pub const GRAPH_API_VERSION: &str = "graph-harness/v1";
pub const ATTESTATION_API_VERSION: &str = "graph-harness-attestation/v1";
pub const CONTRACT_ADAPTER_VERSION: &str = "aiko.graph-harness-contract/v1";
pub const CELL_ADAPTER_VERSION: &str = "aiko.graph-harness-cell-v0/v1";
pub const EDGE_MODEL_ADAPTER_VERSION: &str = "aiko.graph-harness-edge-model/v1";
pub const HOST_OBSERVE_ADAPTER: &str = "aiko.meta.observe/v1";
pub const HOST_RECALL_ADAPTER: &str = "aiko.meta.recall/v1";
pub const HOST_ROUTE_ADAPTER: &str = "aiko.meta.route/v1";
pub const HOST_CAPTURE_ADAPTER: &str = "aiko.meta.capture/v1";
pub const HOST_SETTLE_ADAPTER: &str = "aiko.meta.settle/v1";
pub const WORKSPACE_AUTHORITY: &str = "workspace://**";
pub const EXECUTOR_SCRATCH_AUTHORITY: &str = "executor-scratch://grok-home+temp";
pub const SANDBOXED_NEURON_PROCESS: &str = "aiko-sandboxed-neuron/v1";
pub const HOST_RUNTIME_PIN_VERSION: &str = "aiko-host-runtime-pin/v1";
pub const EVALUATION_POLICY_ID: &str = "isolated-local-workspace-sandboxed-neuron/v1";
pub const SUBJECTIVE_ACCEPTANCE_PROFILE: &str = "subjective-independent-edge-review/v1";
/// Canonical JSON declarative evaluators. These bytes are CAS material, not
/// labels: changing even whitespace changes the pinned implementation.
pub const NORTH_STAR_WITNESS_PROGRAM: &[u8] = br#"{"api_version":"aiko-terminal-settlement/v1","predicate":"aiko-terminal-settlement/v1","required_input_ports":["result"]}"#;
pub const NORTH_STAR_JUDGE_PROGRAM: &[u8] = br#"{"api_version":"aiko-independent-settlement-recheck/v1","predicate":"aiko-terminal-settlement/v1","required_input_ports":["result"]}"#;

pub fn deterministic_host_adapter(adapter: &str) -> bool {
    matches!(
        adapter,
        HOST_OBSERVE_ADAPTER
            | HOST_RECALL_ADAPTER
            | HOST_ROUTE_ADAPTER
            | HOST_CAPTURE_ADAPTER
            | HOST_SETTLE_ADAPTER
    )
}
const MAX_IJSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_VERIFY_KEY_BYTES: u64 = 65_536;
const OPENSSL: &str = "/usr/bin/openssl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    OpaqueWorkflow,
    UnsupportedWorker,
    MissingBinding,
    CapabilityGap,
    AuthorityUnenforceable,
    PreparedEffectRefused,
    InvalidTopology,
    InvalidCanonicalJson,
    DigestMismatch,
    MaterialMissing,
    BundleExists,
    BundleIo,
    AttestationIncomplete,
    AttestationIdentityMismatch,
    AttestationKeyMismatch,
    AttestationInvalid,
    VerifierUnavailable,
    ContractResponseMismatch,
    AdmissionRevoked,
    RegistryMismatch,
}

#[derive(Debug, thiserror::Error)]
#[error("{code:?}: {detail}")]
pub struct GraphHarnessRefusal {
    pub code: RefusalCode,
    pub detail: String,
}

impl GraphHarnessRefusal {
    fn new(code: RefusalCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

type Result<T> = std::result::Result<T, GraphHarnessRefusal>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteReason {
    ExplicitWorkflow,
    ReuseOrPublish,
    MoreThanOneLogicalNode,
    Dependency,
    JoinOrIndependentJudge,
    Generated,
    ScheduledOrDurable,
    Reactive,
    ExternalEffect,
    Recursive,
    WorkflowCompatibilityFlag,
    OpaqueOrHostComposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectReason {
    HelpSchemaVersion,
    ReadOnlyObservation,
    DeterministicLocalTransform,
    AtomicPublicVerb,
    SingleBoundedModelTurn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteRefusal {
    OpaqueWorkflow,
    UninspectableComposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "route", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowRoute {
    GraphHarnessRequired {
        reasons: BTreeSet<RouteReason>,
    },
    DirectAllowed {
        reason: DirectReason,
    },
    CompatibilityEscape {
        policy_id: String,
        audit_ref: String,
    },
    Refused {
        code: RouteRefusal,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowRequestFacts {
    #[serde(default)]
    pub explicit_workflow: bool,
    #[serde(default)]
    pub reuse_or_publish: bool,
    #[serde(default)]
    pub scheduled_or_durable: bool,
    #[serde(default)]
    pub reactive: bool,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub workflow_compatibility_flag: bool,
    #[serde(default)]
    pub opaque_composition: bool,
    #[serde(default)]
    pub requests_process: bool,
    #[serde(default)]
    pub requests_network: bool,
    #[serde(default)]
    pub requests_write: bool,
    #[serde(default)]
    pub help_schema_or_version: bool,
    #[serde(default)]
    pub atomic_public_verb: bool,
    #[serde(default)]
    pub deterministic_local_transform: bool,
    #[serde(default)]
    pub read_only_observation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanPreview {
    #[serde(default)]
    pub core_admitted: bool,
    #[serde(default)]
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanNode {
    pub key: String,
    pub plan: String,
    pub action: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub input_bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub requires_authorization: bool,
    #[serde(default)]
    pub effect_scope: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub reversible: bool,
    pub timeout_ms: u64,
    pub skill_id: String,
    pub skill_version: String,
    pub worker: String,
    #[serde(default)]
    pub adapter: Option<String>,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub script_digest: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub writes: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub research: Vec<String>,
    #[serde(default)]
    pub witness: Option<String>,
    #[serde(default)]
    pub generated: bool,
}

impl PlanNode {
    /// IsolatedLocal first profile: read-only, or one reversible workspace write.
    /// Network, secrets, and runtime-authorization nodes are not admissible.
    pub fn isolated_local_admissible(&self) -> bool {
        if self.requires_authorization || !self.capabilities.is_empty() {
            return false;
        }
        let read_only =
            self.read_only && self.effect_scope == "read_only" && self.writes.is_empty();
        let workspace_reversible = self.worker == "aiko"
            && !self.read_only
            && self.reversible
            && self.effect_scope == "local_reversible"
            && self.writes.len() == 1
            && self.writes[0] == WORKSPACE_AUTHORITY;
        read_only || workspace_reversible
    }
}

pub fn classify_workflow(
    facts: &WorkflowRequestFacts,
    preview: Option<&PlanPreview>,
) -> WorkflowRoute {
    if facts.opaque_composition
        && (facts.requests_process || facts.requests_network || facts.requests_write)
    {
        return WorkflowRoute::Refused {
            code: RouteRefusal::OpaqueWorkflow,
        };
    }
    let mut reasons = BTreeSet::new();
    if facts.opaque_composition || facts.requests_process {
        reasons.insert(RouteReason::OpaqueOrHostComposition);
    }
    let fact_reasons = [
        (facts.explicit_workflow, RouteReason::ExplicitWorkflow),
        (facts.reuse_or_publish, RouteReason::ReuseOrPublish),
        (facts.scheduled_or_durable, RouteReason::ScheduledOrDurable),
        (facts.reactive, RouteReason::Reactive),
        (facts.recursive, RouteReason::Recursive),
        (
            facts.workflow_compatibility_flag,
            RouteReason::WorkflowCompatibilityFlag,
        ),
    ];
    for (present, reason) in fact_reasons {
        if present {
            reasons.insert(reason);
        }
    }
    if facts.requests_network || facts.requests_write {
        reasons.insert(RouteReason::ExternalEffect);
    }
    if let Some(plan) = preview {
        if plan.children.len() > 1 {
            reasons.insert(RouteReason::MoreThanOneLogicalNode);
        }
        for node in &plan.children {
            // DirectAllowed is an implementation-shape claim, not a promise
            // inferred from read_only labels. Only one native Aiko model turn
            // with no composition surface is mechanically atomic.
            let mechanically_atomic = node.worker == "aiko"
                && node.adapter.is_none()
                && node.script.is_none()
                && node.script_digest.is_none()
                && node.capabilities.is_empty()
                && node.depends_on.is_empty()
                && node.input_bindings.is_empty()
                && !node.generated
                && !node.requires_authorization
                && node.read_only
                && node.effect_scope == "read_only"
                && node.writes.is_empty()
                && node.research.is_empty()
                && node.witness.is_none();
            if !mechanically_atomic {
                reasons.insert(RouteReason::OpaqueOrHostComposition);
            }
            if !node.depends_on.is_empty() {
                reasons.insert(RouteReason::Dependency);
            }
            if node.witness.is_some() || !node.research.is_empty() {
                reasons.insert(RouteReason::JoinOrIndependentJudge);
            }
            if node.generated {
                reasons.insert(RouteReason::Generated);
            }
            if node.requires_authorization || !node.read_only || node.effect_scope != "read_only" {
                reasons.insert(RouteReason::ExternalEffect);
            }
        }
    }
    if !reasons.is_empty() {
        return WorkflowRoute::GraphHarnessRequired { reasons };
    }
    if facts.help_schema_or_version {
        return WorkflowRoute::DirectAllowed {
            reason: DirectReason::HelpSchemaVersion,
        };
    }
    if facts.read_only_observation {
        return WorkflowRoute::DirectAllowed {
            reason: DirectReason::ReadOnlyObservation,
        };
    }
    if facts.deterministic_local_transform {
        return WorkflowRoute::DirectAllowed {
            reason: DirectReason::DeterministicLocalTransform,
        };
    }
    if facts.atomic_public_verb {
        return WorkflowRoute::DirectAllowed {
            reason: DirectReason::AtomicPublicVerb,
        };
    }
    if preview.is_some_and(|p| p.children.len() == 1) {
        return WorkflowRoute::DirectAllowed {
            reason: DirectReason::SingleBoundedModelTurn,
        };
    }
    WorkflowRoute::Refused {
        code: RouteRefusal::UninspectableComposition,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DigestValue {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphHarnessIdentity {
    pub api_version: String,
    pub subject_digest: String,
    pub transitive_digest: String,
    pub adapter_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationMode {
    IsolatedLocal,
    OperatorApprovedTrial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authority {
    #[serde(default)]
    pub filesystem: Vec<String>,
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub process: Vec<String>,
    #[serde(default)]
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationPolicy {
    pub mode: EvaluationMode,
    pub max_authority: Authority,
    pub allow_external_effects: bool,
    pub state_root: PathBuf,
    pub workspace_root: PathBuf,
    pub deadline_ms: u64,
    pub signer_policy_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialEntry {
    pub kind: String,
    pub digest: DigestValue,
    pub media_type: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct MaterialCas {
    entries: BTreeMap<String, (MaterialEntry, Vec<u8>)>,
}

impl MaterialCas {
    pub fn insert(
        &mut self,
        kind: impl Into<String>,
        media_type: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Result<String> {
        let digest = sha256_hex(&bytes);
        let entry = MaterialEntry {
            kind: kind.into(),
            digest: DigestValue {
                algorithm: "sha256".into(),
                value: digest.clone(),
            },
            media_type: media_type.into(),
            bytes: bytes.len() as u64,
        };
        if let Some((existing, _)) = self.entries.get(&digest) {
            if existing.kind != entry.kind || existing.media_type != entry.media_type {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::DigestMismatch,
                    format!("material {digest} is claimed with conflicting identities"),
                ));
            }
        } else {
            self.entries.insert(digest.clone(), (entry, bytes));
        }
        Ok(format!("cas:{digest}"))
    }
    pub fn entries(&self) -> impl Iterator<Item = (&str, &MaterialEntry)> {
        self.entries
            .iter()
            .map(|(digest, (entry, _))| (digest.as_str(), entry))
    }
    fn closure_json(&self) -> Vec<Value> {
        self.entries.values().map(|(entry, _)| json!({"kind": entry.kind, "ref": format!("cas:{}", entry.digest.value), "digest": entry.digest})).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialSource {
    pub kind: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeProfile {
    pub cell: String,
    pub witness: String,
    pub judge: String,
    pub verdict_schema: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostProfile {
    pub package_name: String,
    pub package_version: String,
    pub description: String,
    pub input_schema: String,
    pub output_schema: String,
    pub generator: String,
    pub north_star_witness: String,
    pub north_star_judge: String,
    pub verdict_schema: String,
    #[serde(default)]
    pub selected_skill_refs: Vec<String>,
    pub acceptance_profile: String,
    pub materials: BTreeMap<String, MaterialSource>,
    pub nodes: BTreeMap<String, NodeProfile>,
}

fn required_output_program(api_version: &str, ports: &[String]) -> Vec<u8> {
    let mut ports = ports.to_vec();
    ports.sort();
    ports.dedup();
    canonical_json(&json!({
        "api_version": api_version,
        "ports": ports,
        "predicate": "required-non-null",
    }))
    .unwrap_or_default()
}

pub fn embedded_host_profile(
    plan: &PlanPreview,
    selected_skill_refs: Vec<String>,
    runtime_digest: &str,
) -> HostProfile {
    let material = |kind: &str, bytes: Vec<u8>| MaterialSource {
        kind: kind.into(),
        media_type: match kind {
            "schema" => "application/schema+json",
            "edge-model-adapter" => "application/vnd.aiko.edge-model-node+json;version=1",
            "native-host-adapter" => "application/vnd.aiko.native-host-adapter+json;version=1",
            "cell" => "application/vnd.aiko.cell+json;version=0",
            "settlement-witness" | "settlement-judge" => {
                "application/vnd.aiko.declarative-evaluator+json;version=1"
            }
            _ => "application/octet-stream",
        }
        .into(),
        bytes,
    };
    let mut materials = BTreeMap::from([
        (
            "input-schema".into(),
            material("schema", br#"{"type":"object"}"#.to_vec()),
        ),
        (
            "output-schema".into(),
            material("schema", br#"{"type":"object"}"#.to_vec()),
        ),
        (
            "verdict-schema".into(),
            material("schema", br#"{"type":"object"}"#.to_vec()),
        ),
        (
            "generator".into(),
            material("generator", b"aiko-rust-plan-projection/v1".to_vec()),
        ),
        (
            "north-witness".into(),
            material("settlement-witness", NORTH_STAR_WITNESS_PROGRAM.to_vec()),
        ),
        (
            "north-judge".into(),
            material("settlement-judge", NORTH_STAR_JUDGE_PROGRAM.to_vec()),
        ),
    ]);
    let mut nodes = BTreeMap::new();
    for node in &plan.children {
        let cell = format!("node-{}-cell", node.key);
        let witness = format!("node-{}-witness", node.key);
        let judge = format!("node-{}-judge", node.key);
        // Each node retains its authenticated executor identity. Built-in host
        // adapters are pinned declarations, never relabeled as Cell or model.
        let (kind, api_version) = match (node.worker.as_str(), node.adapter.as_deref()) {
            ("host", Some(adapter)) if deterministic_host_adapter(adapter) => {
                ("native-host-adapter", adapter)
            }
            ("host", Some(CELL_ADAPTER_VERSION)) => ("cell", CELL_ADAPTER_VERSION),
            ("aiko", None) => ("edge-model-adapter", EDGE_MODEL_ADAPTER_VERSION),
            _ => ("unsupported-adapter", "unsupported"),
        };
        let implementation = serde_json::to_vec(&json!({
            "api_version": api_version,
            "node_id": node.key,
            "action": node.action,
            "plan": node.plan,
            "effect_scope": node.effect_scope,
            "writes": node.writes,
            "outputs": node.evidence,
            "runtime_pin": {
                "api_version": HOST_RUNTIME_PIN_VERSION,
                "executable_sha256": runtime_digest,
                "process_authority": SANDBOXED_NEURON_PROCESS,
                "sandbox": if node.effect_scope == "local_reversible" { "workspace" } else { "read-only" },
                "executor_scratch": EXECUTOR_SCRATCH_AUTHORITY,
                "network": "denied",
            },
        })).unwrap_or_default();
        materials.insert(cell.clone(), material(kind, implementation));
        materials.insert(
            witness.clone(),
            material(
                "witness",
                required_output_program("aiko-required-output-witness/v1", &node.evidence),
            ),
        );
        materials.insert(
            judge.clone(),
            material(
                "judge",
                required_output_program("aiko-independent-output-recheck/v1", &node.evidence),
            ),
        );
        nodes.insert(
            node.key.clone(),
            NodeProfile {
                cell,
                witness,
                judge,
                verdict_schema: "verdict-schema".into(),
            },
        );
    }
    HostProfile {
        package_name: "aiko-main-path".into(),
        package_version: "1.0.0".into(),
        description: "Aiko host-projected workflow".into(),
        input_schema: "input-schema".into(),
        output_schema: "output-schema".into(),
        generator: "generator".into(),
        north_star_witness: "north-witness".into(),
        north_star_judge: "north-judge".into(),
        verdict_schema: "verdict-schema".into(),
        selected_skill_refs,
        acceptance_profile: SUBJECTIVE_ACCEPTANCE_PROFILE.into(),
        materials,
        nodes,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedGraph {
    pub identity: GraphHarnessIdentity,
    pub bundle_digest: String,
    pub envelope: Value,
    #[serde(skip)]
    pub materials: MaterialCas,
    #[serde(skip)]
    bundle_dir: Option<PathBuf>,
}

pub struct PreparedGraphAdapter;
impl PreparedGraphAdapter {
    /// Deterministically adapts the already-selected bounded plan. The caller
    /// must not call the planner again after this boundary.
    pub fn prepare(
        goal: &str,
        plan: &PlanPreview,
        profile: &HostProfile,
        policy: &EvaluationPolicy,
    ) -> Result<PreparedGraph> {
        if !plan.core_admitted || plan.children.is_empty() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "plan is empty or its core is not admitted",
            ));
        }
        if profile.acceptance_profile.is_empty()
            || profile.acceptance_profile.len() > 128
            || !profile.acceptance_profile.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'-' | b'_' | b'/')
            })
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "acceptance profile must be an exact bounded machine identity",
            ));
        }
        if policy.mode != EvaluationMode::IsolatedLocal || policy.allow_external_effects {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::PreparedEffectRefused,
                "first profile permits isolated local evaluation without external effects only",
            ));
        }
        if policy.max_authority.filesystem.len() != 2
            || policy.max_authority.filesystem[0] != WORKSPACE_AUTHORITY
            || policy.max_authority.filesystem[1] != EXECUTOR_SCRATCH_AUTHORITY
            || !policy.max_authority.network.is_empty()
            || policy.max_authority.process.len() != 1
            || policy.max_authority.process[0] != SANDBOXED_NEURON_PROCESS
            || !policy.max_authority.secrets.is_empty()
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AuthorityUnenforceable,
                "first embedded profile grants only workspace, executor scratch, and one sandboxed Neuron process; no network or secrets",
            ));
        }
        let workspace_root = fs::canonicalize(&policy.workspace_root).map_err(bundle_io)?;
        let workspace_meta = fs::symlink_metadata(&workspace_root).map_err(bundle_io)?;
        if !workspace_root.is_absolute()
            || workspace_meta.file_type().is_symlink()
            || !workspace_meta.is_dir()
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AuthorityUnenforceable,
                "deployment workspace root is not a canonical real directory",
            ));
        }
        let workspace_root_digest = sha256_hex(workspace_root.to_string_lossy().as_bytes());
        let mut cas = MaterialCas::default();
        let mut refs = BTreeMap::new();
        for (name, source) in &profile.materials {
            refs.insert(
                name.clone(),
                cas.insert(&source.kind, &source.media_type, source.bytes.clone())?,
            );
        }
        let require_ref = |name: &str| -> Result<String> {
            refs.get(name).cloned().ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::MaterialMissing,
                    format!("profile material {name:?} is missing"),
                )
            })
        };
        let input_schema = implementation(
            &require_ref(&profile.input_schema)?,
            &cas,
            "application/schema+json",
        )?;
        let output_schema = implementation(
            &require_ref(&profile.output_schema)?,
            &cas,
            "application/schema+json",
        )?;
        let verdict_schema = implementation(
            &require_ref(&profile.verdict_schema)?,
            &cas,
            "application/schema+json",
        )?;
        let generator = implementation(
            &require_ref(&profile.generator)?,
            &cas,
            "application/octet-stream",
        )?;
        let mut nodes = plan.children.clone();
        nodes.sort_by(|a, b| a.key.cmp(&b.key));
        let ids: BTreeSet<_> = nodes.iter().map(|n| n.key.as_str()).collect();
        if ids.len() != nodes.len() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "duplicate plan node key",
            ));
        }
        let mut package_nodes = Vec::new();
        let mut edges = Vec::new();
        for node in &nodes {
            if !node.capabilities.is_empty() {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::CapabilityGap,
                    format!("node {} has unresolved capabilities", node.key),
                ));
            }
            if !node.isolated_local_admissible() {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::PreparedEffectRefused,
                    if node.requires_authorization {
                        format!("node {} requests authority at runtime", node.key)
                    } else {
                        format!(
                            "node {} exceeds the declared workspace-only evaluation authority",
                            node.key
                        )
                    },
                ));
            }
            let read_only =
                node.read_only && node.effect_scope == "read_only" && node.writes.is_empty();
            let workspace_reversible = node.worker == "aiko"
                && !node.read_only
                && node.reversible
                && node.effect_scope == "local_reversible"
                && node.writes.len() == 1
                && node.writes[0] == WORKSPACE_AUTHORITY;
            let adapter = match (node.worker.as_str(), node.adapter.as_deref()) {
                ("host", Some(adapter))
                    if deterministic_host_adapter(adapter)
                        && read_only
                        && node.script.is_none()
                        && node.script_digest.is_none() =>
                {
                    adapter
                }
                ("host", Some(CELL_ADAPTER_VERSION))
                    if read_only && node.script.is_none() && node.script_digest.is_none() =>
                {
                    CELL_ADAPTER_VERSION
                }
                ("aiko", None) if node.script.is_none() && node.script_digest.is_none() => {
                    EDGE_MODEL_ADAPTER_VERSION
                }
                _ => {
                    return Err(GraphHarnessRefusal::new(
                        RefusalCode::UnsupportedWorker,
                        format!("node {} has an opaque or unsupported executor", node.key),
                    ));
                }
            };
            let effects = if workspace_reversible {
                vec![json!({
                    "kind":"filesystem", "scope":WORKSPACE_AUTHORITY,
                    "external_boundary":false, "readback":"not-applicable",
                    "on_invalidation":"manual"
                })]
            } else {
                Vec::new()
            };
            let runtime_resources = if adapter == EDGE_MODEL_ADAPTER_VERSION
                || deterministic_host_adapter(adapter)
            {
                vec![
                    json!({"kind":"process","scope":SANDBOXED_NEURON_PROCESS,"mode":"execute","exclusive":false}),
                    json!({"kind":"filesystem","scope":EXECUTOR_SCRATCH_AUTHORITY,"mode":"write","exclusive":false}),
                ]
            } else {
                Vec::new()
            };
            for dep in &node.depends_on {
                if !ids.contains(dep.as_str()) {
                    return Err(GraphHarnessRefusal::new(
                        RefusalCode::InvalidTopology,
                        format!("node {} has unknown dependency {dep}", node.key),
                    ));
                }
            }
            for dep in &node.depends_on {
                let bound = node
                    .input_bindings
                    .values()
                    .any(|source| source.split_once('.').is_some_and(|(key, _)| key == dep));
                if !bound {
                    return Err(GraphHarnessRefusal::new(
                        RefusalCode::MissingBinding,
                        format!(
                            "node {} dependency {dep} has no explicit input binding",
                            node.key
                        ),
                    ));
                }
            }
            for (port, source) in &node.input_bindings {
                let (from_node, from_port) = source.split_once('.').ok_or_else(|| {
                    GraphHarnessRefusal::new(
                        RefusalCode::MissingBinding,
                        format!("binding {}.{} is not dependency.port", node.key, port),
                    )
                })?;
                if !node.depends_on.iter().any(|d| d == from_node) {
                    return Err(GraphHarnessRefusal::new(
                        RefusalCode::MissingBinding,
                        format!("binding {}.{} names a non-dependency", node.key, port),
                    ));
                }
                edges.push(json!({"from":{"node":from_node,"port":from_port},"to":{"node":node.key,"port":port}}));
            }
            let np = profile.nodes.get(&node.key).ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::MaterialMissing,
                    format!("node profile {} is missing", node.key),
                )
            })?;
            let implementation_media_type = if adapter == CELL_ADAPTER_VERSION {
                "application/vnd.aiko.cell+json;version=0"
            } else if adapter == EDGE_MODEL_ADAPTER_VERSION {
                "application/vnd.aiko.edge-model-node+json;version=1"
            } else {
                "application/vnd.aiko.native-host-adapter+json;version=1"
            };
            let cell = implementation(&require_ref(&np.cell)?, &cas, implementation_media_type)?;
            let witness =
                implementation(&require_ref(&np.witness)?, &cas, "application/octet-stream")?;
            let judge = implementation(&require_ref(&np.judge)?, &cas, "application/octet-stream")?;
            let node_verdict = implementation(
                &require_ref(&np.verdict_schema)?,
                &cas,
                "application/schema+json",
            )?;
            if witness["digest"] == judge["digest"] {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::InvalidTopology,
                    format!("node {} judge is not independent", node.key),
                ));
            }
            let evidence = if node.evidence.is_empty() {
                vec!["result".to_owned()]
            } else {
                let mut x = node.evidence.clone();
                x.sort();
                x.dedup();
                x
            };
            let acceptance_evidence = evidence
                .iter()
                .map(|name| {
                    json!({
                        "name":name,"kind":"structured-output","ref":format!("{}.{}",node.key,name)
                    })
                })
                .collect::<Vec<_>>();
            let judge_consumes = evidence
                .iter()
                .map(|name| format!("{}.{}", node.key, name))
                .collect::<Vec<_>>();
            package_nodes.push(json!({
                "id": node.key, "description": node.plan, "depends_on": node.depends_on,
                "reads": node.input_bindings.keys().cloned().collect::<Vec<_>>(), "produces": evidence,
                "writes": node.writes, "resources": runtime_resources, "effects": effects, "implementation": cell,
                "implementation_adapter": adapter,
                "worker": node.worker, "action":node.action,
                "skill_id":node.skill_id, "skill_version":node.skill_version,
                "determinism": if adapter == EDGE_MODEL_ADAPTER_VERSION { "edge_only" } else { "required" }, "grounding":{"sources":[{"ref":generator["ref"],"digest":generator["digest"]}]},
                "acceptance":{"claim":format!("{} completes with grounded named evidence",node.key),
                    "witness":{"id":format!("node-{}-witness",&sha256_hex(node.key.as_bytes())[..16]),"implementation":witness,"argv":["--json-stdio"],"timeout_ms":node.timeout_ms,
                        "expected":{"exit_codes":[0]},"evidence":acceptance_evidence},
                    "judge":{"independent":true,"implementation":judge,"consumes":judge_consumes,"verdict_schema":node_verdict,"policy":"all"}}
            }));
        }
        ensure_acyclic(&nodes)?;
        let depended_on = nodes
            .iter()
            .flat_map(|node| node.depends_on.iter().cloned())
            .collect::<BTreeSet<_>>();
        let terminals = nodes
            .iter()
            .filter(|node| !depended_on.contains(&node.key))
            .collect::<Vec<_>>();
        if terminals.len() != 1 || terminals[0].evidence.len() != 1 {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "first host profile requires one terminal node with one declared product",
            ));
        }
        let terminal_product = &terminals[0].evidence[0];
        edges.push(json!({"from":{"node":terminals[0].key,"port":terminal_product},"to":{"node":"$output","port":"result"}}));
        let node_timeout_total = nodes
            .iter()
            .try_fold(0_u64, |total, node| total.checked_add(node.timeout_ms))
            .ok_or_else(|| {
                GraphHarnessRefusal::new(RefusalCode::InvalidTopology, "node timeout sum overflow")
            })?;
        let root_timeout_ms = policy
            .deadline_ms
            .checked_sub(node_timeout_total)
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::InvalidTopology,
                    "evaluation deadline cannot cover node and north-star witnesses",
                )
            })?;
        edges.sort_by_key(|e| canonical_json(e).unwrap_or_default());
        let root_witness = implementation(
            &require_ref(&profile.north_star_witness)?,
            &cas,
            "application/vnd.aiko.declarative-evaluator+json;version=1",
        )?;
        let root_judge = implementation(
            &require_ref(&profile.north_star_judge)?,
            &cas,
            "application/vnd.aiko.declarative-evaluator+json;version=1",
        )?;
        if root_witness["digest"] == root_judge["digest"] {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "north-star judge is not independent",
            ));
        }
        let source_digests = cas
            .closure_json()
            .into_iter()
            .map(|v| json!({"ref":v["ref"],"digest":v["digest"]}))
            .collect::<Vec<_>>();
        let package = json!({
            "metadata":{"name":profile.package_name,"version":profile.package_version,"description":profile.description,
                "labels":{"evaluation_policy":EVALUATION_POLICY_ID,"acceptance_profile":profile.acceptance_profile,
                    "workspace_authority":WORKSPACE_AUTHORITY,"executor_scratch_authority":EXECUTOR_SCRATCH_AUTHORITY,
                    "process_authority":SANDBOXED_NEURON_PROCESS,"workspace_root_digest":workspace_root_digest}},
            "membrane":{"inputs":{"request":{"schema":input_schema}},"outputs":{"result":{"schema":output_schema}},"authority":{"filesystem":[WORKSPACE_AUTHORITY,EXECUTOR_SCRATCH_AUTHORITY],"network":[],"process":[SANDBOXED_NEURON_PROCESS],"secrets":[]}},
            "north_star":{"claim":goal,"witness":{"id":"north-star-witness","implementation":root_witness,"argv":["--json-stdio"],"timeout_ms":root_timeout_ms,"expected":{"exit_codes":[0]},"evidence":[{"name":"result","kind":"structured-output","ref":"$output.result"}]},
                "judge":{"independent":true,"implementation":root_judge,"consumes":["$output.result"],"verdict_schema":verdict_schema,"policy":"all"}},
            "nodes":package_nodes,"edges":edges,
            "recursion":{"max_depth":nodes.len(),"max_children_per_node":nodes.len(),"max_total_nodes":nodes.len(),"max_wall_time_ms":policy.deadline_ms,"max_tool_calls":nodes.len() + 1,"on_exhaustion":"refuse"},
            "provenance":{"authored_by":"aiko-rust-host","source_digests":source_digests,"generator":generator}
        });
        let subject_digest = sha256_hex(&canonical_json(&package)?);
        let closure = cas.closure_json();
        let transitive_subject = json!({"subject_digest":{"algorithm":"sha256","value":subject_digest},"dependency_closure":closure});
        let transitive_digest = sha256_hex(&canonical_json(&transitive_subject)?);
        let envelope = json!({
            "api_version":GRAPH_API_VERSION,"kind":"GraphHarness","package":package,
            "admission":{"state":"prepared","subject":"/package","subject_digest":{"algorithm":"sha256","value":subject_digest},"canonicalization":"rfc8785-json","transitive_digest":{"algorithm":"sha256","value":transitive_digest},"dependency_closure":closure},
            "registry":{"media_type":"application/vnd.aiko.graph-harness+json;version=1","name":profile.package_name,"version":profile.package_version,"description":profile.description,"schema":GRAPH_API_VERSION,"tags":["host-generated"],"projections":{"selected_skill_refs":profile.selected_skill_refs}}
        });
        let bundle_digest = sha256_hex(&canonical_json(&envelope)?);
        Ok(PreparedGraph {
            identity: GraphHarnessIdentity {
                api_version: GRAPH_API_VERSION.into(),
                subject_digest,
                transitive_digest,
                adapter_version: CONTRACT_ADAPTER_VERSION.into(),
            },
            bundle_digest,
            envelope,
            materials: cas,
            bundle_dir: None,
        })
    }
}

fn ensure_acyclic(nodes: &[PlanNode]) -> Result<()> {
    let mut indegree: BTreeMap<&str, usize> = nodes
        .iter()
        .map(|n| (n.key.as_str(), n.depends_on.len()))
        .collect();
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for node in nodes {
        for dep in &node.depends_on {
            children.entry(dep).or_default().push(&node.key);
        }
    }
    let mut ready: BTreeSet<&str> = indegree
        .iter()
        .filter_map(|(k, v)| (*v == 0).then_some(*k))
        .collect();
    let mut seen = 0;
    while let Some(next) = ready.pop_first() {
        seen += 1;
        for child in children.get(next).into_iter().flatten() {
            let d = indegree.get_mut(child).expect("validated dependency");
            *d -= 1;
            if *d == 0 {
                ready.insert(child);
            }
        }
    }
    if seen != nodes.len() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::InvalidTopology,
            "plan contains a dependency cycle",
        ));
    }
    Ok(())
}

fn implementation(reference: &str, cas: &MaterialCas, media_type: &str) -> Result<Value> {
    let digest = reference.strip_prefix("cas:").ok_or_else(|| {
        GraphHarnessRefusal::new(
            RefusalCode::MaterialMissing,
            "implementation is not a CAS reference",
        )
    })?;
    if !cas.entries.contains_key(digest) {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::MaterialMissing,
            format!("CAS member {digest} is absent"),
        ));
    }
    Ok(
        json!({"ref":reference,"digest":{"algorithm":"sha256","value":digest},"media_type":media_type}),
    )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedBundleManifest {
    identity: GraphHarnessIdentity,
    bundle_digest: String,
    materials: BTreeMap<String, MaterialEntry>,
}

impl PreparedGraph {
    /// Resolve an immutable prepared bundle only through the deployment state
    /// root and the digest Contract persisted on the admitted graph.
    pub fn load_persisted(state_root: &Path, bundle_ref: &str) -> Result<Self> {
        let digest = bundle_ref
            .strip_prefix("cas:")
            .filter(|value| valid_sha256(value))
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::DigestMismatch,
                    "claim bundle_ref is not a sha256 CAS identity",
                )
            })?;
        let root = canonical_deployment_root(state_root)?;
        let prepared_parent = real_directory(&root, "prepared", false)?;
        let bundle_dir = prepared_parent.join(digest);
        let bundle_meta = fs::symlink_metadata(&bundle_dir).map_err(bundle_io)?;
        if bundle_meta.file_type().is_symlink() || !bundle_meta.is_dir() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::BundleIo,
                "prepared bundle is not a real directory",
            ));
        }
        let manifest_bytes =
            read_bounded_regular(&bundle_dir.join("bundle.json"), 2 * 1024 * 1024)?;
        let manifest: PersistedBundleManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|error| {
                GraphHarnessRefusal::new(
                    RefusalCode::BundleIo,
                    format!("invalid bundle manifest: {error}"),
                )
            })?;
        if manifest.bundle_digest != digest {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                "bundle manifest identity differs from Contract claim",
            ));
        }
        let envelope_bytes =
            read_bounded_regular(&bundle_dir.join("envelope.json"), 8 * 1024 * 1024)?;
        let envelope: Value = serde_json::from_slice(&envelope_bytes).map_err(|error| {
            GraphHarnessRefusal::new(
                RefusalCode::BundleIo,
                format!("invalid prepared envelope: {error}"),
            )
        })?;
        let mut materials = MaterialCas::default();
        for (material_digest, entry) in manifest.materials {
            if material_digest != entry.digest.value
                || entry.digest.algorithm != "sha256"
                || !valid_sha256(&material_digest)
            {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::DigestMismatch,
                    "bundle material manifest identity mismatch",
                ));
            }
            if entry.bytes > 16 * 1024 * 1024 {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::BundleIo,
                    "bundle material exceeds host limit",
                ));
            }
            let bytes = read_bounded_regular(
                &bundle_dir.join("materials").join(&material_digest),
                16 * 1024 * 1024,
            )?;
            if bytes.len() as u64 != entry.bytes || sha256_hex(&bytes) != material_digest {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::DigestMismatch,
                    format!("material {material_digest} drifted"),
                ));
            }
            materials.entries.insert(material_digest, (entry, bytes));
        }
        let prepared = Self {
            identity: manifest.identity,
            bundle_digest: digest.to_owned(),
            envelope,
            materials,
            bundle_dir: Some(bundle_dir),
        };
        EmbeddedCompiler::inspect(&prepared)?;
        Ok(prepared)
    }

    pub fn material_file(&self, digest: &str) -> Result<PathBuf> {
        if !valid_sha256(digest) || !self.materials.entries.contains_key(digest) {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::MaterialMissing,
                format!("material {digest} is outside the prepared closure"),
            ));
        }
        let path = self
            .bundle_dir
            .as_ref()
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::BundleIo,
                    "prepared graph was not loaded from durable state",
                )
            })?
            .join("materials")
            .join(digest);
        let bytes = read_bounded_regular(&path, 16 * 1024 * 1024)?;
        if sha256_hex(&bytes) != digest {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                format!("material {digest} drifted after load"),
            ));
        }
        Ok(path)
    }

    pub fn material_digests(&self) -> impl Iterator<Item = &str> {
        self.materials.entries.keys().map(String::as_str)
    }

    pub fn material_bytes(&self, digest: &str) -> Result<&[u8]> {
        self.materials
            .entries
            .get(digest)
            .map(|(_, bytes)| bytes.as_slice())
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::MaterialMissing,
                    "runtime pin declaration is outside the prepared closure",
                )
            })
    }
}

fn read_bounded_regular(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::BundleIo,
            format!(
                "bundle member is not a bounded regular file: {}",
                path.display()
            ),
        ));
    }
    fs::read(path).map_err(bundle_io)
}

pub struct EmbeddedCompiler;
impl EmbeddedCompiler {
    pub fn inspect(prepared: &PreparedGraph) -> Result<()> {
        if prepared.identity.api_version != GRAPH_API_VERSION
            || prepared.identity.adapter_version != CONTRACT_ADAPTER_VERSION
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                "unsupported graph identity version",
            ));
        }
        let package = prepared.envelope.get("package").ok_or_else(|| {
            GraphHarnessRefusal::new(RefusalCode::DigestMismatch, "package missing")
        })?;
        if sha256_hex(&canonical_json(package)?) != prepared.identity.subject_digest {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                "subject digest mismatch",
            ));
        }
        let closure = prepared
            .envelope
            .pointer("/admission/dependency_closure")
            .ok_or_else(|| {
                GraphHarnessRefusal::new(RefusalCode::DigestMismatch, "closure missing")
            })?;
        let trans = sha256_hex(&canonical_json(
            &json!({"subject_digest":{"algorithm":"sha256","value":prepared.identity.subject_digest},"dependency_closure":closure}),
        )?);
        if trans != prepared.identity.transitive_digest {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                "transitive digest mismatch",
            ));
        }
        if sha256_hex(&canonical_json(&prepared.envelope)?) != prepared.bundle_digest {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                "bundle digest mismatch",
            ));
        }
        for (digest, (entry, bytes)) in &prepared.materials.entries {
            if sha256_hex(bytes) != *digest || entry.digest.value != *digest {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::DigestMismatch,
                    format!("material {digest} mismatch"),
                ));
            }
        }
        Ok(())
    }

    pub fn persist_atomic(prepared: &PreparedGraph, destination: &Path) -> Result<()> {
        Self::inspect(prepared)?;
        if destination.exists() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::BundleExists,
                "bundle destination already exists",
            ));
        }
        let parent = destination.parent().ok_or_else(|| {
            GraphHarnessRefusal::new(RefusalCode::BundleIo, "bundle has no parent")
        })?;
        fs::create_dir_all(parent).map_err(bundle_io)?;
        let temp = parent.join(format!(
            ".graph-harness-{}-{}.tmp",
            std::process::id(),
            prepared.bundle_digest
        ));
        if temp.exists() {
            fs::remove_dir_all(&temp).map_err(bundle_io)?;
        }
        let result = (|| -> std::io::Result<()> {
            fs::create_dir(&temp)?;
            fs::create_dir(temp.join("materials"))?;
            write_sync(
                &temp.join("envelope.json"),
                &canonical_json(&prepared.envelope)
                    .map_err(|e| std::io::Error::other(e.to_string()))?,
            )?;
            for (digest, (_, bytes)) in &prepared.materials.entries {
                write_sync(&temp.join("materials").join(digest), bytes)?;
            }
            let manifest = json!({"identity":prepared.identity,"bundle_digest":prepared.bundle_digest,"materials":prepared.materials.entries().map(|(d,e)|(d,e)).collect::<BTreeMap<_,_>>()});
            write_sync(
                &temp.join("bundle.json"),
                &canonical_json(&manifest).map_err(|e| std::io::Error::other(e.to_string()))?,
            )?;
            File::open(&temp)?.sync_all()?;
            fs::rename(&temp, destination)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&temp);
            return Err(bundle_io(error));
        }
        Ok(())
    }
}

pub fn materialize_admitted(
    prepared: &PreparedGraph,
    statement: &Value,
    state_root: &Path,
) -> Result<()> {
    EmbeddedCompiler::inspect(prepared)?;
    let root = canonical_deployment_root(state_root)?;
    let admitted_parent = real_directory(&root, "admitted", true)?;
    let destination = admitted_parent.join(&prepared.identity.subject_digest);

    let mut envelope = prepared.envelope.clone();
    let admission = envelope
        .get_mut("admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "prepared admission block missing",
            )
        })?;
    admission.insert("state".into(), Value::String("admitted".into()));
    admission.insert("attestation".into(), statement.clone());
    let envelope_bytes = canonical_json(&envelope)?;

    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::BundleExists,
                    "admitted subject exists but is not a real directory",
                ));
            }
            let existing =
                read_bounded_regular(&destination.join("envelope.json"), 8 * 1024 * 1024)?;
            let existing_ref = read_bounded_regular(&destination.join("prepared-bundle-ref"), 80)?;
            if existing != envelope_bytes
                || existing_ref != format!("cas:{}\n", prepared.bundle_digest).as_bytes()
            {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::BundleExists,
                    "subject already has a different admitted envelope or prepared reference",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temp = admitted_parent.join(format!(
                ".{}.{}.tmp",
                std::process::id(),
                prepared.identity.subject_digest
            ));
            if fs::symlink_metadata(&temp).is_ok() {
                fs::remove_dir_all(&temp).map_err(bundle_io)?;
            }
            fs::create_dir(&temp).map_err(bundle_io)?;
            let result = (|| -> std::io::Result<()> {
                write_sync(&temp.join("envelope.json"), &envelope_bytes)?;
                write_sync(
                    &temp.join("prepared-bundle-ref"),
                    format!("cas:{}\n", prepared.bundle_digest).as_bytes(),
                )?;
                File::open(&temp)?.sync_all()?;
                fs::rename(&temp, &destination)?;
                File::open(&admitted_parent)?.sync_all()
            })();
            if let Err(error) = result {
                let _ = fs::remove_dir_all(&temp);
                return Err(bundle_io(error));
            }
        }
        Err(error) => return Err(bundle_io(error)),
    }

    let registry = real_directory(&root, "registry", true)?;
    let registry_path = registry.join(format!("{}.json", prepared.identity.subject_digest));
    let projection = registry_projection(prepared, &destination);
    let projection_bytes = canonical_json(&projection)?;
    match fs::symlink_metadata(&registry_path) {
        Ok(_) => {
            if read_bounded_regular(&registry_path, 2 * 1024 * 1024)? != projection_bytes {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::RegistryMismatch,
                    "existing registry projection differs from the admitted identity",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temp = registry.join(format!(
                ".{}.{}.tmp",
                std::process::id(),
                prepared.identity.subject_digest
            ));
            if fs::symlink_metadata(&temp).is_ok() {
                fs::remove_file(&temp).map_err(bundle_io)?;
            }
            write_sync(&temp, &projection_bytes).map_err(bundle_io)?;
            match fs::hard_link(&temp, &registry_path) {
                Ok(()) => {
                    fs::remove_file(&temp).map_err(bundle_io)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    fs::remove_file(&temp).map_err(bundle_io)?;
                    if read_bounded_regular(&registry_path, 2 * 1024 * 1024)? != projection_bytes {
                        return Err(GraphHarnessRefusal::new(
                            RefusalCode::RegistryMismatch,
                            "racing registry projection differs from the admitted identity",
                        ));
                    }
                }
                Err(error) => {
                    let _ = fs::remove_file(&temp);
                    return Err(bundle_io(error));
                }
            }
            File::open(&registry)
                .and_then(|file| file.sync_all())
                .map_err(bundle_io)?;
        }
        Err(error) => return Err(bundle_io(error)),
    }
    Ok(())
}

fn canonical_deployment_root(state_root: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(state_root).map_err(bundle_io)?;
    let metadata = fs::symlink_metadata(&root).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || !root.is_absolute() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::BundleIo,
            "deployment state root is not a real absolute directory",
        ));
    }
    Ok(root)
}

fn real_directory(root: &Path, name: &str, create: bool) -> Result<PathBuf> {
    let path = root.join(name);
    if create {
        match fs::create_dir(&path) {
            Ok(()) => File::open(root)
                .and_then(|file| file.sync_all())
                .map_err(bundle_io)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(bundle_io(error)),
        }
    }
    let metadata = fs::symlink_metadata(&path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::BundleIo,
            format!("deployment {name} is not a real directory"),
        ));
    }
    Ok(path)
}

fn registry_projection(prepared: &PreparedGraph, admitted_dir: &Path) -> Value {
    json!({
        "schema":"aiko.graph-harness-registry/v1",
        "subject_digest":prepared.identity.subject_digest,
        "transitive_digest":prepared.identity.transitive_digest,
        "bundle_digest":prepared.bundle_digest,
        "admitted":admitted_dir,
        "metadata":prepared.envelope.pointer("/package/metadata").cloned().unwrap_or(Value::Null),
    })
}

fn write_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}
fn bundle_io(error: std::io::Error) -> GraphHarnessRefusal {
    GraphHarnessRefusal::new(RefusalCode::BundleIo, error.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractGraphHarnessIdentity {
    pub api_version: String,
    pub state: String,
    pub subject_digest: String,
    pub transitive_digest: String,
    pub adapter: String,
    pub bundle_ref: String,
    pub evaluation_policy: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractChild {
    pub key: String,
    pub plan: String,
    pub action: String,
    pub depends_on: Vec<String>,
    pub input_bindings: BTreeMap<String, String>,
    pub requires_authorization: bool,
    pub authorization: String,
    pub effect_scope: String,
    pub read_only: bool,
    pub reversible: bool,
    pub timeout_ms: u64,
    pub skill_id: String,
    pub skill_version: String,
    pub worker: String,
    pub adapter: String,
    pub activation: String,
    pub admission: String,
    pub script: String,
    pub script_digest: String,
    pub cell_digest: String,
    pub witness_id: String,
    pub witness_digest: String,
    pub judge_digest: String,
    pub evidence: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractExpandRequest {
    pub root_id: String,
    pub plan: String,
    pub action: String,
    pub cwd: PathBuf,
    pub agent: String,
    pub children: Vec<ContractChild>,
    pub selected_skills: Vec<Value>,
    pub core_admitted: bool,
    pub depth: u32,
    pub max_depth: u32,
    pub max_children: usize,
    pub max_concurrency: u32,
    pub execution_model: String,
    pub graph_harness: ContractGraphHarnessIdentity,
}

pub struct GraphHarnessContractAdapter;
impl GraphHarnessContractAdapter {
    pub fn expand_request(
        prepared: &PreparedGraph,
        root_id: &str,
        goal: &str,
        cwd: &Path,
        depth: u32,
        max_depth: u32,
        max_concurrency: u32,
    ) -> Result<ContractExpandRequest> {
        EmbeddedCompiler::inspect(prepared)?;
        if prepared
            .envelope
            .pointer("/package/north_star/claim")
            .and_then(Value::as_str)
            != Some(goal)
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIdentityMismatch,
                "Contract occurrence goal differs from the pinned package claim",
            ));
        }
        let canonical_cwd = fs::canonicalize(cwd).map_err(bundle_io)?;
        let cwd_digest = sha256_hex(canonical_cwd.to_string_lossy().as_bytes());
        if prepared
            .envelope
            .pointer("/package/metadata/labels/workspace_root_digest")
            .and_then(Value::as_str)
            != Some(cwd_digest.as_str())
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AuthorityUnenforceable,
                "request cwd differs from the deployment-pinned workspace root",
            ));
        }
        let package_nodes = prepared
            .envelope
            .pointer("/package/nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                GraphHarnessRefusal::new(RefusalCode::InvalidTopology, "package nodes missing")
            })?;
        let package_name = prepared
            .envelope
            .pointer("/package/metadata/name")
            .and_then(Value::as_str)
            .unwrap_or("graph-harness");
        let package_version = prepared
            .envelope
            .pointer("/package/metadata/version")
            .and_then(Value::as_str)
            .unwrap_or("1.0.0");
        let mut children = Vec::new();
        for node in package_nodes {
            let key = str_field(node, "id")?.to_owned();
            let depends_on = string_array(node, "depends_on")?;
            let mut bindings = BTreeMap::new();
            for edge in prepared
                .envelope
                .pointer("/package/edges")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if edge.pointer("/to/node").and_then(Value::as_str) == Some(&key) {
                    bindings.insert(
                        str_pointer(edge, "/to/port")?.to_owned(),
                        format!(
                            "{}.{}",
                            str_pointer(edge, "/from/node")?,
                            str_pointer(edge, "/from/port")?
                        ),
                    );
                }
            }
            let produces = string_array(node, "produces")?;
            let cell = node.get("implementation").cloned().ok_or_else(|| {
                GraphHarnessRefusal::new(RefusalCode::InvalidTopology, "cell binding missing")
            })?;
            let witness = node
                .pointer("/acceptance/witness/implementation")
                .cloned()
                .ok_or_else(|| {
                    GraphHarnessRefusal::new(
                        RefusalCode::InvalidTopology,
                        "witness binding missing",
                    )
                })?;
            let judge = node
                .pointer("/acceptance/judge/implementation")
                .cloned()
                .ok_or_else(|| {
                    GraphHarnessRefusal::new(RefusalCode::InvalidTopology, "judge binding missing")
                })?;
            let mut evidence = produces;
            evidence.extend([
                "cell_manifest".into(),
                "neuron_firing".into(),
                "witness_verdict".into(),
                "judge_verdict".into(),
            ]);
            evidence.sort();
            evidence.dedup();
            let workspace_effect =
                node.get("effects")
                    .and_then(Value::as_array)
                    .is_some_and(|effects| {
                        effects.len() == 1
                            && effects[0].get("kind").and_then(Value::as_str) == Some("filesystem")
                            && effects[0].get("scope").and_then(Value::as_str)
                                == Some(WORKSPACE_AUTHORITY)
                            && effects[0].get("external_boundary").and_then(Value::as_bool)
                                == Some(false)
                            && effects[0].get("on_invalidation").and_then(Value::as_str)
                                == Some("manual")
                    });
            children.push(ContractChild {
                key: key.clone(),
                plan: str_field(node, "description")?.to_owned(),
                action: str_field(node, "action")?.to_owned(),
                depends_on,
                input_bindings: bindings,
                requires_authorization: false,
                authorization: "approved".into(),
                effect_scope: if workspace_effect {
                    "local_reversible"
                } else {
                    "read_only"
                }
                .into(),
                read_only: !workspace_effect,
                reversible: workspace_effect,
                timeout_ms: node
                    .pointer("/acceptance/witness/timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(30_000),
                skill_id: str_field(node, "skill_id")?.to_owned(),
                skill_version: str_field(node, "skill_version")?.to_owned(),
                worker: str_field(node, "worker")?.to_owned(),
                adapter: str_field(node, "implementation_adapter")?.to_owned(),
                activation: "runtime".into(),
                admission: "graph_harness_prepared".into(),
                script: String::new(),
                script_digest: String::new(),
                cell_digest: str_pointer(&cell, "/digest/value")?.to_owned(),
                witness_id: str_pointer(node, "/acceptance/witness/id")?.to_owned(),
                witness_digest: str_pointer(&witness, "/digest/value")?.to_owned(),
                judge_digest: str_pointer(&judge, "/digest/value")?.to_owned(),
                evidence,
            });
        }
        let terminal = terminal_nodes(package_nodes)?;
        if terminal.len() != 1 {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidTopology,
                "north star requires exactly one terminal",
            ));
        }
        let output_edge = prepared
            .envelope
            .pointer("/package/edges")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|edge| edge.pointer("/to/node").and_then(Value::as_str) == Some("$output"))
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::InvalidTopology,
                    "terminal output mapping missing",
                )
            })?;
        let terminal_product = str_pointer(output_edge, "/from/port")?;
        let north_star_bindings = BTreeMap::from([(
            "result".to_owned(),
            format!("{}.{}", terminal[0], terminal_product),
        )]);
        children.push(ContractChild {
            key: "__graph_harness_north_star".into(),
            plan: "Verify package north star using pinned witness and independent judge".into(),
            action: format!("skill:{package_name}@{package_version}:host"),
            depends_on: terminal,
            input_bindings: north_star_bindings,
            requires_authorization: false,
            authorization: "approved".into(),
            effect_scope: "read_only".into(),
            read_only: true,
            reversible: true,
            timeout_ms: prepared
                .envelope
                .pointer("/package/north_star/witness/timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(30_000),
            skill_id: package_name.into(),
            skill_version: package_version.into(),
            worker: "host".into(),
            adapter: CELL_ADAPTER_VERSION.into(),
            activation: "runtime".into(),
            admission: "graph_harness_prepared".into(),
            script: String::new(),
            script_digest: String::new(),
            cell_digest: str_pointer(
                &prepared.envelope,
                "/package/north_star/witness/implementation/digest/value",
            )?
            .to_owned(),
            witness_id: str_pointer(&prepared.envelope, "/package/north_star/witness/id")?
                .to_owned(),
            witness_digest: str_pointer(
                &prepared.envelope,
                "/package/north_star/witness/implementation/digest/value",
            )?
            .to_owned(),
            judge_digest: str_pointer(
                &prepared.envelope,
                "/package/north_star/judge/implementation/digest/value",
            )?
            .to_owned(),
            evidence: vec![
                "cell_manifest".into(),
                "neuron_firing".into(),
                "witness_verdict".into(),
                "judge_verdict".into(),
            ],
        });
        Ok(ContractExpandRequest {
            root_id: root_id.into(),
            plan: goal.into(),
            action: "neuron:cell".into(),
            cwd: cwd.into(),
            agent: format!(
                "graph-harness:{}@{}",
                prepared
                    .envelope
                    .pointer("/package/metadata/name")
                    .and_then(Value::as_str)
                    .unwrap_or("package"),
                prepared
                    .envelope
                    .pointer("/package/metadata/version")
                    .and_then(Value::as_str)
                    .unwrap_or("1.0.0")
            ),
            max_children: children.len(),
            children,
            selected_skills: vec![],
            core_admitted: true,
            depth,
            max_depth,
            max_concurrency,
            execution_model: "typed_neuron_graph_harness".into(),
            graph_harness: ContractGraphHarnessIdentity {
                api_version: GRAPH_API_VERSION.into(),
                state: "prepared".into(),
                subject_digest: prepared.identity.subject_digest.clone(),
                transitive_digest: prepared.identity.transitive_digest.clone(),
                adapter: CONTRACT_ADAPTER_VERSION.into(),
                bundle_ref: format!("cas:{}", prepared.bundle_digest),
                evaluation_policy: EVALUATION_POLICY_ID.into(),
            },
        })
    }
    pub fn validate_expand_response(prepared: &PreparedGraph, response: &Value) -> Result<()> {
        for (pointer, expected) in [
            (
                "/graph_harness/subject_digest",
                prepared.identity.subject_digest.as_str(),
            ),
            (
                "/graph_harness/transitive_digest",
                prepared.identity.transitive_digest.as_str(),
            ),
            ("/graph_harness/adapter", CONTRACT_ADAPTER_VERSION),
        ] {
            if response.pointer(pointer).and_then(Value::as_str) != Some(expected) {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::ContractResponseMismatch,
                    format!("Contract response mismatch at {pointer}"),
                ));
            }
        }
        Ok(())
    }
}
fn terminal_nodes(nodes: &[Value]) -> Result<Vec<String>> {
    let mut depended = BTreeSet::new();
    for n in nodes {
        depended.extend(string_array(n, "depends_on")?);
    }
    let mut out = nodes
        .iter()
        .filter_map(|n| n.get("id").and_then(Value::as_str))
        .filter(|id| !depended.contains(*id))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    out.sort();
    Ok(out)
}
fn str_field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k).and_then(Value::as_str).ok_or_else(|| {
        GraphHarnessRefusal::new(RefusalCode::InvalidTopology, format!("missing string {k}"))
    })
}
fn str_pointer<'a>(v: &'a Value, p: &str) -> Result<&'a str> {
    v.pointer(p).and_then(Value::as_str).ok_or_else(|| {
        GraphHarnessRefusal::new(RefusalCode::InvalidTopology, format!("missing string {p}"))
    })
}
fn string_array(v: &Value, k: &str) -> Result<Vec<String>> {
    v.get(k)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            GraphHarnessRefusal::new(RefusalCode::InvalidTopology, format!("missing array {k}"))
        })?
        .iter()
        .map(|x| {
            x.as_str().map(str::to_owned).ok_or_else(|| {
                GraphHarnessRefusal::new(RefusalCode::InvalidTopology, format!("non-string in {k}"))
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestationAuthentication {
    pub algorithm: String,
    pub key_id: String,
    pub value: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImplementationIdentity {
    #[serde(rename = "ref")]
    pub reference: String,
    pub digest: DigestValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestationVerdict {
    pub witness_id: String,
    pub judge: ImplementationIdentity,
    pub verdict_ref: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphHarnessAttestation {
    pub api_version: String,
    pub kind: String,
    pub owner: String,
    pub subject_digest: DigestValue,
    pub transitive_digest: DigestValue,
    pub verdicts: Vec<AttestationVerdict>,
    pub admitted_by: ImplementationIdentity,
    pub admitted_at: String,
    pub evidence_refs: Vec<String>,
    pub ledger_ref: String,
    pub authentication: AttestationAuthentication,
}

pub struct DeploymentVerifier {
    pem: Vec<u8>,
    key_id: String,
}
impl DeploymentVerifier {
    /// Loads the only trust root from deployment bootstrap. Attestations have
    /// no key path, verifier command, or alternate key selector.
    pub fn from_environment() -> Result<Self> {
        let raw = std::env::var_os("AIKO_CONTRACT_VERIFY_KEY").ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "AIKO_CONTRACT_VERIFY_KEY is not configured",
            )
        })?;
        Self::load(Path::new(&raw))
    }
    fn load(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "verification key path must be absolute",
            ));
        }
        let meta = fs::symlink_metadata(path).map_err(|e| {
            GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
        })?;
        if meta.file_type().is_symlink()
            || !meta.is_file()
            || meta.len() == 0
            || meta.len() > MAX_VERIFY_KEY_BYTES
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "verification key must be a bounded regular non-symlink file",
            ));
        }
        let mut pem = Vec::new();
        File::open(path)
            .and_then(|f| f.take(MAX_VERIFY_KEY_BYTES + 1).read_to_end(&mut pem))
            .map_err(|e| {
                GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
            })?;
        let text = std::str::from_utf8(&pem).map_err(|_| {
            GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "verification key is not UTF-8 PEM",
            )
        })?;
        if !text.starts_with("-----BEGIN PUBLIC KEY-----\n")
            || !text.trim_end().ends_with("-----END PUBLIC KEY-----")
            || text.contains("PRIVATE KEY")
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "verifier requires public-only SPKI PEM",
            ));
        }
        let temp = tempfile::tempdir().map_err(|e| {
            GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
        })?;
        let der = temp.path().join("key.der");
        let openssl_meta = fs::symlink_metadata(OPENSSL).map_err(|error| {
            GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, error.to_string())
        })?;
        if openssl_meta.file_type().is_symlink() || !openssl_meta.is_file() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "fixed OpenSSL verifier is not a regular non-symlink file",
            ));
        }
        let status = Command::new(OPENSSL)
            .args(["pkey", "-pubin", "-in"])
            .arg(path)
            .args(["-outform", "DER", "-out"])
            .arg(&der)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| {
                GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
            })?;
        if !status.success() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "OpenSSL refused deployment public key",
            ));
        }
        let der = fs::read(der).map_err(|e| {
            GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
        })?;
        const PREFIX: &[u8] = &[
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        if der.len() != 44 || !der.starts_with(PREFIX) {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::VerifierUnavailable,
                "deployment public key is not Ed25519 SPKI",
            ));
        }
        Ok(Self {
            pem,
            key_id: format!("sha256:{}", sha256_hex(&der)),
        })
    }
    pub fn authenticate(
        &self,
        prepared: &PreparedGraph,
        attestation: &GraphHarnessAttestation,
    ) -> Result<()> {
        if attestation.api_version != ATTESTATION_API_VERSION
            || attestation.kind != "GraphHarnessAdmissionAttestation"
            || attestation.owner != "contract"
            || attestation.authentication.algorithm != "ed25519"
            || attestation.evidence_refs.is_empty()
            || attestation.verdicts.is_empty()
            || attestation.ledger_ref.is_empty()
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "attestation shape or evidence is incomplete",
            ));
        }
        if attestation.subject_digest.value != prepared.identity.subject_digest
            || attestation.transitive_digest.value != prepared.identity.transitive_digest
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIdentityMismatch,
                "attestation does not bind the prepared identity",
            ));
        }
        if attestation.subject_digest.algorithm != "sha256"
            || attestation.transitive_digest.algorithm != "sha256"
            || attestation.admitted_by.digest.algorithm != "sha256"
            || !valid_sha256(&attestation.subject_digest.value)
            || !valid_sha256(&attestation.transitive_digest.value)
            || !valid_sha256(&attestation.admitted_by.digest.value)
        {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "attestation contains a malformed digest",
            ));
        }
        verify_attestation_verdicts(prepared, attestation)?;
        if attestation.authentication.key_id != self.key_id {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationKeyMismatch,
                "attestation key id is not the deployment key",
            ));
        }
        let signature = decode_hex(&attestation.authentication.value)?;
        if signature.len() != 64 {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationInvalid,
                "Ed25519 signature must be 64 bytes",
            ));
        }
        let mut statement = serde_json::to_value(attestation).map_err(|e| {
            GraphHarnessRefusal::new(RefusalCode::AttestationInvalid, e.to_string())
        })?;
        statement
            .pointer_mut("/authentication/value")
            .map(|v| *v = Value::String(String::new()))
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::AttestationIncomplete,
                    "authentication value missing",
                )
            })?;
        let bytes = canonical_json(&statement)?;
        let temp = tempfile::tempdir().map_err(|e| {
            GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
        })?;
        let key = temp.path().join("key.pem");
        let msg = temp.path().join("statement.json");
        let sig = temp.path().join("signature.bin");
        write_sync(&key, &self.pem).map_err(bundle_io)?;
        write_sync(&msg, &bytes).map_err(bundle_io)?;
        write_sync(&sig, &signature).map_err(bundle_io)?;
        let status = Command::new(OPENSSL)
            .args(["pkeyutl", "-verify", "-pubin", "-rawin", "-inkey"])
            .arg(key)
            .args(["-in"])
            .arg(msg)
            .args(["-sigfile"])
            .arg(sig)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| {
                GraphHarnessRefusal::new(RefusalCode::VerifierUnavailable, e.to_string())
            })?;
        if !status.success() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationInvalid,
                "Ed25519 verification failed",
            ));
        }
        Ok(())
    }
}

/// A graph whose immutable prepared closure and Contract-owned admission have
/// both been re-read and authenticated from the deployment state root.
///
/// No execution-source identifiers are synthesized here: the current admitted
/// materialization does not persist such fields. Callers must derive execution
/// evidence from a fresh Contract occurrence rather than treating a path as a
/// source identity.
#[derive(Debug)]
pub struct AdmittedGraph {
    pub prepared: PreparedGraph,
    pub envelope: Value,
    pub attestation: GraphHarnessAttestation,
}

/// Load an admitted GraphHarness by its exact prepared CAS reference.
///
/// Paths carried in the registry are projections only. This loader derives the
/// subject and every deployment path from the re-inspected prepared identity,
/// then compares the complete registry projection without following its path.
pub fn load_admitted(
    state_root: &Path,
    bundle_ref: &str,
    verifier: &DeploymentVerifier,
) -> Result<AdmittedGraph> {
    let root = canonical_deployment_root(state_root)?;
    let prepared = PreparedGraph::load_persisted(&root, bundle_ref)?;
    // Reinspect after load so this function, rather than its caller, owns the
    // immutable closure check.
    EmbeddedCompiler::inspect(&prepared)?;
    let subject = &prepared.identity.subject_digest;

    let revoked_parent = root.join("revoked");
    match fs::symlink_metadata(&revoked_parent) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(GraphHarnessRefusal::new(
                    RefusalCode::BundleIo,
                    "deployment revoked store is not a real directory",
                ));
            }
            match fs::symlink_metadata(revoked_parent.join(subject)) {
                Ok(_) => {
                    return Err(GraphHarnessRefusal::new(
                        RefusalCode::AdmissionRevoked,
                        "admitted GraphHarness has a deployment revocation tombstone",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(bundle_io(error)),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(bundle_io(error)),
    }

    let admitted_parent = real_directory(&root, "admitted", false)?;
    let admitted_dir = admitted_parent.join(subject);
    let metadata = fs::symlink_metadata(&admitted_dir).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::BundleIo,
            "admitted subject is not a real directory",
        ));
    }
    let claimed_ref = read_bounded_regular(&admitted_dir.join("prepared-bundle-ref"), 80)?;
    let expected_ref = format!("cas:{}\n", prepared.bundle_digest);
    if claimed_ref != expected_ref.as_bytes() || bundle_ref != expected_ref.trim_end() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::DigestMismatch,
            "admitted prepared-bundle-ref is not the exact requested CAS identity",
        ));
    }

    let envelope_bytes =
        read_bounded_regular(&admitted_dir.join("envelope.json"), 8 * 1024 * 1024)?;
    let envelope: Value = serde_json::from_slice(&envelope_bytes).map_err(|error| {
        GraphHarnessRefusal::new(
            RefusalCode::BundleIo,
            format!("invalid admitted envelope: {error}"),
        )
    })?;
    let statement = envelope
        .pointer("/admission/attestation")
        .cloned()
        .ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "admitted envelope has no attestation",
            )
        })?;
    let attestation: GraphHarnessAttestation =
        serde_json::from_value(statement.clone()).map_err(|error| {
            GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                format!("invalid admitted attestation: {error}"),
            )
        })?;

    // Admission may change exactly two fields: prepared -> admitted and the
    // addition of the exact attestation. Any package, closure, or registry
    // mutation is therefore rejected even when the signature itself is valid.
    let mut restored = envelope.clone();
    let admission = restored
        .get_mut("admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::DigestMismatch,
                "admitted envelope has no admission object",
            )
        })?;
    if admission.get("state").and_then(Value::as_str) != Some("admitted")
        || admission.remove("attestation") != Some(statement)
    {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::DigestMismatch,
            "admitted envelope does not contain the exact admission transition",
        ));
    }
    admission.insert("state".into(), Value::String("prepared".into()));
    if canonical_json(&restored)? != canonical_json(&prepared.envelope)? {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::DigestMismatch,
            "admitted envelope differs from prepared bytes outside admission state and attestation",
        ));
    }
    verifier.authenticate(&prepared, &attestation)?;

    let registry_parent = real_directory(&root, "registry", false)?;
    let registry_path = registry_parent.join(format!("{subject}.json"));
    let registry_bytes = read_bounded_regular(&registry_path, 2 * 1024 * 1024)?;
    let registry_value: Value = serde_json::from_slice(&registry_bytes).map_err(|error| {
        GraphHarnessRefusal::new(
            RefusalCode::RegistryMismatch,
            format!("invalid registry projection: {error}"),
        )
    })?;
    let expected_registry = registry_projection(&prepared, &admitted_dir);
    if canonical_json(&registry_value)? != canonical_json(&expected_registry)? {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::RegistryMismatch,
            "registry projection does not exactly match the derived admitted identity",
        ));
    }

    Ok(AdmittedGraph {
        prepared,
        envelope,
        attestation,
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn verify_attestation_verdicts(
    prepared: &PreparedGraph,
    attestation: &GraphHarnessAttestation,
) -> Result<()> {
    let mut expected = BTreeMap::<String, Value>::new();
    let north_id = prepared
        .envelope
        .pointer("/package/north_star/witness/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "north-star witness identity is missing",
            )
        })?;
    let north_judge = prepared
        .envelope
        .pointer("/package/north_star/judge/implementation")
        .ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "north-star judge identity is missing",
            )
        })?;
    expected.insert(north_id.into(), north_judge.clone());
    for node in prepared
        .envelope
        .pointer("/package/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let witness_id = node
            .pointer("/acceptance/witness/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::AttestationIncomplete,
                    "node witness identity is missing",
                )
            })?;
        let judge = node
            .pointer("/acceptance/judge/implementation")
            .ok_or_else(|| {
                GraphHarnessRefusal::new(
                    RefusalCode::AttestationIncomplete,
                    "node judge identity is missing",
                )
            })?;
        if expected.insert(witness_id.into(), judge.clone()).is_some() {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "witness identities are not globally unique",
            ));
        }
    }
    if expected.len() != attestation.verdicts.len() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::AttestationIncomplete,
            "verdicts do not cover every witness exactly once",
        ));
    }
    let evidence = attestation.evidence_refs.iter().collect::<BTreeSet<_>>();
    if evidence.len() != attestation.evidence_refs.len() {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::AttestationIncomplete,
            "evidence references are not unique",
        ));
    }
    let mut seen = BTreeSet::new();
    for verdict in &attestation.verdicts {
        if !seen.insert(&verdict.witness_id) || !evidence.contains(&verdict.verdict_ref) {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "duplicate witness or ungrounded verdict reference",
            ));
        }
        let expected_judge = expected.get(&verdict.witness_id).ok_or_else(|| {
            GraphHarnessRefusal::new(
                RefusalCode::AttestationIncomplete,
                "verdict names an unknown witness",
            )
        })?;
        let actual_judge = serde_json::to_value(&verdict.judge).map_err(|error| {
            GraphHarnessRefusal::new(RefusalCode::AttestationIncomplete, error.to_string())
        })?;
        if canonical_json(expected_judge)? != canonical_json(&actual_judge)? {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::AttestationIdentityMismatch,
                "verdict judge differs from the prepared package",
            ));
        }
    }
    Ok(())
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::AttestationInvalid,
            "signature is not lowercase hexadecimal",
        ));
    }
    (0..value.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| {
                GraphHarnessRefusal::new(RefusalCode::AttestationInvalid, "invalid signature hex")
            })
        })
        .collect()
}

pub fn canonical_json(value: &Value) -> Result<Vec<u8>> {
    fn emit(v: &Value, out: &mut String) -> Result<()> {
        match v {
            Value::Null => out.push_str("null"),
            Value::Bool(x) => out.push_str(if *x { "true" } else { "false" }),
            Value::Number(n) => emit_number(n, out)?,
            Value::String(s) => out.push_str(&serde_json::to_string(s).map_err(|e| {
                GraphHarnessRefusal::new(RefusalCode::InvalidCanonicalJson, e.to_string())
            })?),
            Value::Array(xs) => {
                out.push('[');
                for (i, x) in xs.iter().enumerate() {
                    if i > 0 {
                        out.push(',')
                    }
                    emit(x, out)?
                }
                out.push(']')
            }
            Value::Object(map) => {
                let mut keys = map.keys().collect::<Vec<_>>();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',')
                    }
                    out.push_str(&serde_json::to_string(k).map_err(|e| {
                        GraphHarnessRefusal::new(RefusalCode::InvalidCanonicalJson, e.to_string())
                    })?);
                    out.push(':');
                    emit(&map[*k], out)?
                }
                out.push('}')
            }
        }
        Ok(())
    }
    let mut out = String::new();
    emit(value, &mut out)?;
    Ok(out.into_bytes())
}
fn emit_number(n: &Number, out: &mut String) -> Result<()> {
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() > MAX_IJSON_INTEGER {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidCanonicalJson,
                "integer outside I-JSON exact range",
            ));
        }
        out.push_str(&i.to_string());
        return Ok(());
    }
    if let Some(u) = n.as_u64() {
        if u > MAX_IJSON_INTEGER {
            return Err(GraphHarnessRefusal::new(
                RefusalCode::InvalidCanonicalJson,
                "integer outside I-JSON exact range",
            ));
        }
        out.push_str(&u.to_string());
        return Ok(());
    }
    Err(GraphHarnessRefusal::new(
        RefusalCode::InvalidCanonicalJson,
        "floating point JSON is unsupported",
    ))
}
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn pinned_executable_digest(path: &Path) -> Result<String> {
    const MAX_EXECUTABLE_BYTES: u64 = 1024 * 1024 * 1024;
    let canonical = fs::canonicalize(path).map_err(bundle_io)?;
    let metadata = fs::symlink_metadata(&canonical).map_err(bundle_io)?;
    if !canonical.is_absolute()
        || metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_EXECUTABLE_BYTES
    {
        return Err(GraphHarnessRefusal::new(
            RefusalCode::AuthorityUnenforceable,
            "host executable is not a bounded canonical regular file",
        ));
    }
    let mut file = File::open(canonical).map_err(bundle_io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(bundle_io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str) -> Value {
        let path = std::env::var_os("AIKO_GRAPH_HARNESS_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../../tests/fixtures/graph-harness/main-path")
            })
            .join(name);
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }
    #[test]
    fn canonical_parity_vector() {
        let input = fixture("canonical-input.json");
        let expected = fixture("canonical-expected.json");
        assert_eq!(
            String::from_utf8(canonical_json(&input).unwrap()).unwrap(),
            expected["canonical"].as_str().unwrap()
        );
        assert_eq!(
            sha256_hex(&canonical_json(&input).unwrap()),
            expected["sha256"].as_str().unwrap()
        );
    }
    #[test]
    fn route_vectors() {
        for name in [
            "route-workflow.json",
            "route-direct.json",
            "route-refused.json",
        ] {
            let v = fixture(name);
            let facts = serde_json::from_value(v["facts"].clone()).unwrap();
            let plan = if v["preview"].is_null() {
                None
            } else {
                Some(serde_json::from_value(v["preview"].clone()).unwrap())
            };
            assert_eq!(
                serde_json::to_value(classify_workflow(&facts, plan.as_ref())).unwrap(),
                v["expected"]
            );
        }
    }
    #[test]
    fn hostile_bin_sh_cannot_launder_into_direct_allowed() {
        let node = PlanNode {
            key: "hostile".into(),
            plan: "opaque".into(),
            action: "script".into(),
            depends_on: vec![],
            input_bindings: BTreeMap::new(),
            requires_authorization: false,
            effect_scope: "read_only".into(),
            read_only: true,
            reversible: true,
            timeout_ms: 1000,
            skill_id: "hostile".into(),
            skill_version: "1".into(),
            worker: "script".into(),
            adapter: Some("aiko.neuron-json-stdio/v1".into()),
            script: Some("/bin/sh".into()),
            script_digest: Some("00".repeat(32)),
            evidence: vec!["result".into()],
            writes: vec![],
            capabilities: vec![],
            research: vec![],
            witness: None,
            generated: false,
        };
        let route = classify_workflow(
            &WorkflowRequestFacts::default(),
            Some(&PlanPreview {
                core_admitted: true,
                children: vec![node],
            }),
        );
        assert!(matches!(route, WorkflowRoute::GraphHarnessRequired { .. }));
    }

    #[test]
    fn floats_and_wide_integers_refuse() {
        assert_eq!(
            canonical_json(&json!(1.5)).unwrap_err().code,
            RefusalCode::InvalidCanonicalJson
        );
        assert_eq!(
            canonical_json(&json!(9007199254740992u64))
                .unwrap_err()
                .code,
            RefusalCode::InvalidCanonicalJson
        );
    }
    fn prepared_fixture() -> PreparedGraph {
        let source = |kind: &str, bytes: &str| MaterialSource {
            kind: kind.into(),
            media_type: "application/octet-stream".into(),
            bytes: bytes.as_bytes().to_vec(),
        };
        let materials = BTreeMap::from([
            ("input".into(), source("schema", "input-schema")),
            ("output".into(), source("schema", "output-schema")),
            ("verdict".into(), source("schema", "verdict-schema")),
            ("generator".into(), source("generator", "host-generator")),
            ("cell-source".into(), source("cell", "cell-source")),
            ("cell-join".into(), source("cell", "cell-join")),
            ("witness-source".into(), source("witness", "witness-source")),
            ("witness-join".into(), source("witness", "witness-join")),
            ("judge-source".into(), source("judge", "judge-source")),
            ("judge-join".into(), source("judge", "judge-join")),
            ("north-witness".into(), source("witness", "north-witness")),
            ("north-judge".into(), source("judge", "north-judge")),
        ]);
        let profile = HostProfile {
            package_name: "main-path".into(),
            package_version: "1.0.0".into(),
            description: "main path fixture".into(),
            input_schema: "input".into(),
            output_schema: "output".into(),
            generator: "generator".into(),
            north_star_witness: "north-witness".into(),
            north_star_judge: "north-judge".into(),
            verdict_schema: "verdict".into(),
            selected_skill_refs: vec![],
            acceptance_profile: "fixture-bounded-acceptance/v1".into(),
            materials,
            nodes: BTreeMap::from([
                (
                    "source".into(),
                    NodeProfile {
                        cell: "cell-source".into(),
                        witness: "witness-source".into(),
                        judge: "judge-source".into(),
                        verdict_schema: "verdict".into(),
                    },
                ),
                (
                    "join".into(),
                    NodeProfile {
                        cell: "cell-join".into(),
                        witness: "witness-join".into(),
                        judge: "judge-join".into(),
                        verdict_schema: "verdict".into(),
                    },
                ),
            ]),
        };
        let base = |key: &str| PlanNode {
            key: key.into(),
            plan: key.into(),
            action: "skill:main-path@1.0.0:host".into(),
            depends_on: vec![],
            input_bindings: BTreeMap::new(),
            requires_authorization: false,
            effect_scope: "read_only".into(),
            read_only: true,
            reversible: true,
            timeout_ms: 1000,
            skill_id: "main-path".into(),
            skill_version: "1.0.0".into(),
            worker: "host".into(),
            adapter: Some(CELL_ADAPTER_VERSION.into()),
            script: None,
            script_digest: None,
            evidence: vec!["result".into()],
            writes: vec![],
            capabilities: vec![],
            research: vec![],
            witness: None,
            generated: false,
        };
        let source_node = base("source");
        let mut join = base("join");
        join.depends_on = vec!["source".into()];
        join.input_bindings
            .insert("source".into(), "source.result".into());
        let plan = PlanPreview {
            core_admitted: true,
            children: vec![join, source_node],
        };
        let policy = EvaluationPolicy {
            mode: EvaluationMode::IsolatedLocal,
            max_authority: Authority {
                filesystem: vec![
                    WORKSPACE_AUTHORITY.into(),
                    EXECUTOR_SCRATCH_AUTHORITY.into(),
                ],
                network: vec![],
                process: vec![SANDBOXED_NEURON_PROCESS.into()],
                secrets: vec![],
            },
            allow_external_effects: false,
            state_root: PathBuf::from("state"),
            workspace_root: PathBuf::from("/tmp"),
            deadline_ms: 10_000,
            signer_policy_id: "contract-deployment-v1".into(),
        };
        PreparedGraphAdapter::prepare("prove the main path", &plan, &profile, &policy).unwrap()
    }

    #[test]
    fn ordinary_aiko_edge_model_plan_prepares_with_distinct_pinned_adapter() {
        // Use stable names instead of depending on map enumeration.
        let source = |kind: &str, bytes: &str| MaterialSource {
            kind: kind.into(),
            media_type: "application/octet-stream".into(),
            bytes: bytes.as_bytes().to_vec(),
        };
        let materials = BTreeMap::from([
            ("input".into(), source("schema", "input")),
            ("output".into(), source("schema", "output")),
            ("verdict".into(), source("schema", "verdict")),
            (
                "generator".into(),
                source("generator", "bounded-planner-v1"),
            ),
            (
                "edge".into(),
                source(
                    "edge-model-adapter",
                    r#"{"api_version":"aiko.graph-harness-edge-model/v1"}"#,
                ),
            ),
            ("witness".into(), source("witness", "builtin-witness-v1")),
            ("judge".into(), source("judge", "builtin-judge-v1")),
            (
                "north-witness".into(),
                source("witness", "builtin-north-witness-v1"),
            ),
            (
                "north-judge".into(),
                source("judge", "builtin-north-judge-v1"),
            ),
        ]);
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "answer".into(),
            NodeProfile {
                cell: "edge".into(),
                witness: "witness".into(),
                judge: "judge".into(),
                verdict_schema: "verdict".into(),
            },
        );
        let profile = HostProfile {
            package_name: "ordinary".into(),
            package_version: "1".into(),
            description: "ordinary bounded model workflow".into(),
            input_schema: "input".into(),
            output_schema: "output".into(),
            generator: "generator".into(),
            north_star_witness: "north-witness".into(),
            north_star_judge: "north-judge".into(),
            verdict_schema: "verdict".into(),
            selected_skill_refs: vec![],
            acceptance_profile: "fixture-bounded-acceptance/v1".into(),
            materials,
            nodes,
        };
        let plan = PlanPreview {
            core_admitted: true,
            children: vec![PlanNode {
                key: "answer".into(),
                plan: "produce a grounded answer".into(),
                action: "skill:aiko@1:aiko".into(),
                depends_on: vec![],
                input_bindings: BTreeMap::new(),
                requires_authorization: false,
                effect_scope: "read_only".into(),
                read_only: true,
                reversible: true,
                timeout_ms: 1_000,
                skill_id: "aiko".into(),
                skill_version: "1".into(),
                worker: "aiko".into(),
                adapter: None,
                script: None,
                script_digest: None,
                evidence: vec!["result".into()],
                writes: vec![],
                capabilities: vec![],
                research: vec![],
                witness: None,
                generated: false,
            }],
        };
        let policy = EvaluationPolicy {
            mode: EvaluationMode::IsolatedLocal,
            max_authority: Authority {
                filesystem: vec![
                    WORKSPACE_AUTHORITY.into(),
                    EXECUTOR_SCRATCH_AUTHORITY.into(),
                ],
                network: vec![],
                process: vec![SANDBOXED_NEURON_PROCESS.into()],
                secrets: vec![],
            },
            allow_external_effects: false,
            state_root: PathBuf::from("/tmp"),
            workspace_root: PathBuf::from("/tmp"),
            deadline_ms: 10_000,
            signer_policy_id: "contract-deployment-v1".into(),
        };
        let prepared =
            PreparedGraphAdapter::prepare("answer meaningfully", &plan, &profile, &policy).unwrap();
        let request = GraphHarnessContractAdapter::expand_request(
            &prepared,
            "root",
            "answer meaningfully",
            Path::new("/tmp"),
            0,
            4,
            1,
        )
        .unwrap();
        assert_eq!(request.children[0].worker, "aiko");
        assert_eq!(request.children[0].adapter, EDGE_MODEL_ADAPTER_VERSION);
        assert_eq!(
            prepared
                .envelope
                .pointer("/package/nodes/0/determinism")
                .and_then(Value::as_str),
            Some("edge_only")
        );
    }

    #[test]
    fn contract_children_emit_exact_attestation_bindings_at_top_level() {
        let prepared = prepared_fixture();
        let request = GraphHarnessContractAdapter::expand_request(
            &prepared,
            "deadbeef",
            "prove the main path",
            Path::new("/tmp"),
            0,
            4,
            2,
        )
        .unwrap();
        let encoded = serde_json::to_value(request).unwrap();
        for child in encoded["children"].as_array().unwrap() {
            for field in [
                "cell_digest",
                "witness_id",
                "witness_digest",
                "judge_digest",
                "activation",
                "admission",
                "script",
                "script_digest",
            ] {
                assert!(
                    child.get(field).is_some(),
                    "missing Contract ABI field {field}"
                );
            }
            assert!(child.get("extras").is_none());
            assert_ne!(child["witness_digest"], child["judge_digest"]);
        }
    }

    #[test]
    fn preparation_is_deterministic_and_contract_request_has_acceptance_edge() {
        let a = prepared_fixture();
        let b = prepared_fixture();
        assert_eq!(a.identity, b.identity);
        assert_eq!(a.bundle_digest, b.bundle_digest);
        let golden = fixture("prepared-identity.golden.json");
        assert_eq!(a.identity.api_version, golden["api_version"]);
        assert_eq!(a.identity.subject_digest, golden["subject_digest"]);
        assert_eq!(a.identity.transitive_digest, golden["transitive_digest"]);
        assert_eq!(a.identity.adapter_version, golden["adapter_version"]);
        assert_eq!(a.bundle_digest, golden["bundle_digest"]);
        EmbeddedCompiler::inspect(&a).unwrap();
        let request = GraphHarnessContractAdapter::expand_request(
            &a,
            "root-1",
            "prove the main path",
            Path::new("/tmp"),
            0,
            4,
            2,
        )
        .unwrap();
        assert_eq!(
            request.graph_harness.subject_digest,
            a.identity.subject_digest
        );
        assert_eq!(request.execution_model, "typed_neuron_graph_harness");
        assert_eq!(
            request.children.last().unwrap().key,
            "__graph_harness_north_star"
        );
        assert_eq!(request.children.last().unwrap().depends_on, vec!["join"]);
        assert_eq!(
            request
                .children
                .last()
                .unwrap()
                .input_bindings
                .get("result")
                .map(String::as_str),
            Some("join.result")
        );
        assert!(
            request
                .children
                .iter()
                .all(|child| child.adapter == CELL_ADAPTER_VERSION)
        );
    }

    #[test]
    fn bundle_persistence_is_atomic_and_never_overwrites() {
        let prepared = prepared_fixture();
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("bundle");
        EmbeddedCompiler::persist_atomic(&prepared, &destination).unwrap();
        assert!(destination.join("envelope.json").is_file());
        assert!(destination.join("bundle.json").is_file());
        assert_eq!(
            EmbeddedCompiler::persist_atomic(&prepared, &destination)
                .unwrap_err()
                .code,
            RefusalCode::BundleExists
        );
    }

    #[test]
    fn strict_route_input_rejects_unknown() {
        assert!(serde_json::from_value::<WorkflowRequestFacts>(json!({"surprise":true})).is_err());
    }
    #[test]
    fn persisted_claim_projection_loads_exact_bundle_and_refuses_drift() {
        let prepared = prepared_fixture();
        let state = tempfile::tempdir().unwrap();
        let destination = state.path().join("prepared").join(&prepared.bundle_digest);
        EmbeddedCompiler::persist_atomic(&prepared, &destination).unwrap();
        let loaded =
            PreparedGraph::load_persisted(state.path(), &format!("cas:{}", prepared.bundle_digest))
                .unwrap();
        assert_eq!(loaded.identity, prepared.identity);
        assert_eq!(loaded.envelope, prepared.envelope);

        let digest = loaded.material_digests().next().unwrap().to_owned();
        fs::write(
            destination.join("materials").join(&digest),
            b"registry mutation",
        )
        .unwrap();
        assert_eq!(
            PreparedGraph::load_persisted(
                state.path(),
                &format!("cas:{}", prepared.bundle_digest),
            )
            .unwrap_err()
            .code,
            RefusalCode::DigestMismatch
        );
    }

    #[test]
    fn persisted_claim_projection_cannot_escape_deployment_root() {
        let state = tempfile::tempdir().unwrap();
        let error = PreparedGraph::load_persisted(state.path(), "cas:not-a-digest").unwrap_err();
        assert_eq!(error.code, RefusalCode::DigestMismatch);
    }

    #[test]
    fn runtime_pin_detects_executable_byte_drift() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("aiko-runtime");
        fs::write(&executable, b"runtime-v1").unwrap();
        let pinned = pinned_executable_digest(&executable).unwrap();
        fs::write(&executable, b"runtime-v2").unwrap();
        let observed = pinned_executable_digest(&executable).unwrap();
        let declaration = json!({"runtime_pin":{"executable_sha256":pinned}});
        assert_ne!(
            declaration
                .pointer("/runtime_pin/executable_sha256")
                .and_then(Value::as_str),
            Some(observed.as_str()),
            "drifted runtime must mismatch its admitted declaration"
        );
    }

    #[test]
    fn real_embedded_core_manifest_prepares_persists_and_projects_ordinary_profile() {
        let manifest_path = std::env::var_os("AIKO_EMBEDDED_CORE_MANIFEST")
            .map(PathBuf::from)
            .expect("exact witness supplies the checked-in embedded manifest");
        let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        assert_eq!(manifest["activation"], "core");
        let skill_id = manifest["id"].as_str().unwrap();
        let version = manifest["version"].as_str().unwrap();
        let goal = "ordinary profile exact witness";
        let children = manifest["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| {
                let local_key = raw["key"].as_str().unwrap();
                let prefix = |key: &str| format!("{skill_id}--{key}");
                let bindings = raw["input_bindings"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(name, source)| {
                        let (dependency, output) =
                            source.as_str().unwrap().split_once('.').unwrap();
                        (name.clone(), format!("{}.{}", prefix(dependency), output))
                    })
                    .collect();
                PlanNode {
                    key: prefix(local_key),
                    plan: raw["plan"].as_str().unwrap().replace("{{goal}}", goal),
                    action: format!(
                        "skill:{skill_id}@{version}:{}",
                        raw["worker"].as_str().unwrap()
                    ),
                    depends_on: raw["depends_on"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| prefix(v.as_str().unwrap()))
                        .collect(),
                    input_bindings: bindings,
                    requires_authorization: raw["requires_authority"].as_bool().unwrap(),
                    effect_scope: raw["effect"].as_str().unwrap().into(),
                    read_only: raw["read_only"].as_bool().unwrap(),
                    reversible: raw["reversible"].as_bool().unwrap(),
                    timeout_ms: raw["timeout_ms"].as_u64().unwrap(),
                    skill_id: skill_id.into(),
                    skill_version: version.into(),
                    worker: raw["worker"].as_str().unwrap().into(),
                    adapter: raw
                        .get("adapter")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    script: None,
                    script_digest: None,
                    evidence: raw["evidence"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().to_owned())
                        .collect(),
                    writes: raw
                        .get("writes")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|v| v.as_str().unwrap().to_owned())
                        .collect(),
                    capabilities: vec![],
                    research: vec![],
                    witness: None,
                    generated: false,
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(children.len(), 8);
        let preview = PlanPreview {
            core_admitted: true,
            children,
        };
        let runtime_digest = "a".repeat(64);
        let profile = embedded_host_profile(
            &preview,
            vec![format!("skill:{skill_id}@{version}")],
            &runtime_digest,
        );
        let directory = tempfile::tempdir().unwrap();
        let policy = EvaluationPolicy {
            mode: EvaluationMode::IsolatedLocal,
            max_authority: Authority {
                filesystem: vec![
                    WORKSPACE_AUTHORITY.into(),
                    EXECUTOR_SCRATCH_AUTHORITY.into(),
                ],
                network: vec![],
                process: vec![SANDBOXED_NEURON_PROCESS.into()],
                secrets: vec![],
            },
            allow_external_effects: false,
            state_root: directory.path().into(),
            workspace_root: directory.path().into(),
            deadline_ms: 600_000,
            signer_policy_id: "contract-deployment-v1".into(),
        };
        let prepared = PreparedGraphAdapter::prepare(goal, &preview, &profile, &policy).unwrap();
        let package_nodes = prepared
            .envelope
            .pointer("/package/nodes")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(package_nodes.len(), 8);
        assert_eq!(
            prepared
                .envelope
                .pointer("/package/metadata/labels/acceptance_profile")
                .and_then(Value::as_str),
            Some(SUBJECTIVE_ACCEPTANCE_PROFILE)
        );
        let judge_node = package_nodes
            .iter()
            .find(|node| node["id"] == "aiko-meta-agent--judge")
            .unwrap();
        assert_eq!(
            judge_node["depends_on"],
            json!(["aiko-meta-agent--capture"])
        );
        let judge_sources = prepared
            .envelope
            .pointer("/package/edges")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter(|edge| {
                edge.pointer("/to/node").and_then(Value::as_str) == Some("aiko-meta-agent--judge")
            })
            .map(|edge| edge.pointer("/from/node").and_then(Value::as_str).unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(judge_sources, BTreeSet::from(["aiko-meta-agent--capture"]));
        let adapter = |key: &str| {
            package_nodes.iter().find(|n| n["id"] == key).unwrap()["implementation_adapter"]
                .as_str()
                .unwrap()
        };
        assert_eq!(adapter("aiko-meta-agent--observe"), HOST_OBSERVE_ADAPTER);
        assert_eq!(adapter("aiko-meta-agent--recall"), HOST_RECALL_ADAPTER);
        assert_eq!(adapter("aiko-meta-agent--route"), HOST_ROUTE_ADAPTER);
        assert_eq!(adapter("aiko-meta-agent--capture"), HOST_CAPTURE_ADAPTER);
        assert_eq!(adapter("aiko-meta-agent--settle"), HOST_SETTLE_ADAPTER);
        for key in ["act", "verify", "judge"] {
            assert_eq!(
                adapter(&format!("aiko-meta-agent--{key}")),
                EDGE_MODEL_ADAPTER_VERSION
            );
        }
        let act = package_nodes
            .iter()
            .find(|n| n["id"] == "aiko-meta-agent--act")
            .unwrap();
        assert_eq!(act["writes"], json!([WORKSPACE_AUTHORITY]));
        assert_eq!(act["determinism"], "edge_only");
        assert_eq!(
            act["effects"][0],
            json!({"kind":"filesystem","scope":WORKSPACE_AUTHORITY,
            "external_boundary":false,"readback":"not-applicable","on_invalidation":"manual"})
        );
        let settle_edge = prepared
            .envelope
            .pointer("/package/edges")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e.pointer("/to/node").and_then(Value::as_str) == Some("$output"))
            .unwrap();
        assert_eq!(
            settle_edge.pointer("/from/node").unwrap(),
            "aiko-meta-agent--settle"
        );
        assert_eq!(settle_edge.pointer("/from/port").unwrap(), "settlement");
        let implementation_digest = act
            .pointer("/implementation/digest/value")
            .unwrap()
            .as_str()
            .unwrap();
        let declaration: Value =
            serde_json::from_slice(prepared.material_bytes(implementation_digest).unwrap())
                .unwrap();
        assert_eq!(
            declaration
                .pointer("/runtime_pin/executable_sha256")
                .unwrap(),
            &json!(runtime_digest)
        );
        assert_eq!(
            declaration.pointer("/runtime_pin/sandbox").unwrap(),
            "workspace"
        );
        let destination = directory
            .path()
            .join("prepared")
            .join(&prepared.bundle_digest);
        EmbeddedCompiler::persist_atomic(&prepared, &destination).unwrap();
        let loaded = PreparedGraph::load_persisted(
            directory.path(),
            &format!("cas:{}", prepared.bundle_digest),
        )
        .unwrap();
        let request = GraphHarnessContractAdapter::expand_request(
            &loaded,
            "root",
            goal,
            directory.path(),
            0,
            4,
            1,
        )
        .unwrap();
        assert_eq!(request.children.len(), 9);
        assert!(request.children.iter().all(|node| {
            !node.witness_id.contains("--")
                && node
                    .witness_id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        }));
        let settle = request
            .children
            .iter()
            .find(|n| n.key == "aiko-meta-agent--settle")
            .unwrap();
        assert_eq!(settle.adapter, HOST_SETTLE_ADAPTER);
        let act = request
            .children
            .iter()
            .find(|n| n.key == "aiko-meta-agent--act")
            .unwrap();
        assert_eq!(act.effect_scope, "local_reversible");
        let north = request
            .children
            .iter()
            .find(|n| n.key == "__graph_harness_north_star")
            .unwrap();
        assert_eq!(
            north.input_bindings["result"],
            "aiko-meta-agent--settle.settlement"
        );
    }

    fn signed_admitted_fixture() -> (tempfile::TempDir, DeploymentVerifier, String) {
        let prepared = prepared_fixture();
        let state = tempfile::tempdir().unwrap();
        let prepared_dir = state.path().join("prepared").join(&prepared.bundle_digest);
        EmbeddedCompiler::persist_atomic(&prepared, &prepared_dir).unwrap();

        let private_key = state.path().join("deployment-private.pem");
        let public_key = state.path().join("deployment-public.pem");
        assert!(
            Command::new(OPENSSL)
                .args(["genpkey", "-algorithm", "ED25519", "-out"])
                .arg(&private_key)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new(OPENSSL)
                .args(["pkey", "-in"])
                .arg(&private_key)
                .args(["-pubout", "-out"])
                .arg(&public_key)
                .status()
                .unwrap()
                .success()
        );
        let verifier = DeploymentVerifier::load(&public_key).unwrap();

        let mut expected = Vec::<(String, ImplementationIdentity)>::new();
        expected.push((
            prepared
                .envelope
                .pointer("/package/north_star/witness/id")
                .unwrap()
                .as_str()
                .unwrap()
                .into(),
            serde_json::from_value(
                prepared
                    .envelope
                    .pointer("/package/north_star/judge/implementation")
                    .unwrap()
                    .clone(),
            )
            .unwrap(),
        ));
        for node in prepared
            .envelope
            .pointer("/package/nodes")
            .unwrap()
            .as_array()
            .unwrap()
        {
            expected.push((
                node.pointer("/acceptance/witness/id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .into(),
                serde_json::from_value(
                    node.pointer("/acceptance/judge/implementation")
                        .unwrap()
                        .clone(),
                )
                .unwrap(),
            ));
        }
        let evidence_refs = (0..expected.len())
            .map(|index| format!("ledger://verdict/{index}"))
            .collect::<Vec<_>>();
        let verdicts = expected
            .into_iter()
            .zip(evidence_refs.iter())
            .map(|((witness_id, judge), verdict_ref)| AttestationVerdict {
                witness_id,
                judge,
                verdict_ref: verdict_ref.clone(),
            })
            .collect();
        let mut attestation = GraphHarnessAttestation {
            api_version: ATTESTATION_API_VERSION.into(),
            kind: "GraphHarnessAdmissionAttestation".into(),
            owner: "contract".into(),
            subject_digest: DigestValue {
                algorithm: "sha256".into(),
                value: prepared.identity.subject_digest.clone(),
            },
            transitive_digest: DigestValue {
                algorithm: "sha256".into(),
                value: prepared.identity.transitive_digest.clone(),
            },
            verdicts,
            admitted_by: ImplementationIdentity {
                reference: format!("cas:{}", "a".repeat(64)),
                digest: DigestValue {
                    algorithm: "sha256".into(),
                    value: "a".repeat(64),
                },
                entrypoint: None,
                media_type: None,
            },
            admitted_at: "ledger://ordinal/42".into(),
            evidence_refs,
            ledger_ref: "ledger://graph-harness/42".into(),
            authentication: AttestationAuthentication {
                algorithm: "ed25519".into(),
                key_id: verifier.key_id.clone(),
                value: String::new(),
            },
        };
        let statement_path = state.path().join("statement.json");
        let signature_path = state.path().join("signature.bin");
        fs::write(
            &statement_path,
            canonical_json(&serde_json::to_value(&attestation).unwrap()).unwrap(),
        )
        .unwrap();
        assert!(
            Command::new(OPENSSL)
                .args(["pkeyutl", "-sign", "-rawin", "-inkey"])
                .arg(&private_key)
                .args(["-in"])
                .arg(&statement_path)
                .args(["-out"])
                .arg(&signature_path)
                .status()
                .unwrap()
                .success()
        );
        attestation.authentication.value = fs::read(signature_path)
            .unwrap()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        materialize_admitted(
            &prepared,
            &serde_json::to_value(attestation).unwrap(),
            state.path(),
        )
        .unwrap();
        let bundle_ref = format!("cas:{}", prepared.bundle_digest);
        (state, verifier, bundle_ref)
    }

    #[test]
    fn admitted_loader_authenticates_exact_materialization() {
        let (state, verifier, bundle_ref) = signed_admitted_fixture();
        let loaded = load_admitted(state.path(), &bundle_ref, &verifier).unwrap();
        assert_eq!(
            loaded.prepared.identity.subject_digest,
            loaded.attestation.subject_digest.value
        );
        assert_eq!(
            loaded
                .envelope
                .pointer("/admission/state")
                .and_then(Value::as_str),
            Some("admitted")
        );
    }

    #[test]
    fn admitted_loader_refuses_envelope_registry_and_revocation_drift() {
        let (state, verifier, bundle_ref) = signed_admitted_fixture();
        let prepared = PreparedGraph::load_persisted(state.path(), &bundle_ref).unwrap();
        let subject = &prepared.identity.subject_digest;
        let admitted_envelope = state
            .path()
            .join("admitted")
            .join(subject)
            .join("envelope.json");
        let mut envelope: Value =
            serde_json::from_slice(&fs::read(&admitted_envelope).unwrap()).unwrap();
        envelope["registry"]["name"] = Value::String("substituted".into());
        fs::write(&admitted_envelope, canonical_json(&envelope).unwrap()).unwrap();
        assert_eq!(
            load_admitted(state.path(), &bundle_ref, &verifier)
                .unwrap_err()
                .code,
            RefusalCode::DigestMismatch
        );

        let (state, verifier, bundle_ref) = signed_admitted_fixture();
        let prepared = PreparedGraph::load_persisted(state.path(), &bundle_ref).unwrap();
        let registry_path = state
            .path()
            .join("registry")
            .join(format!("{}.json", prepared.identity.subject_digest));
        let mut registry: Value =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        registry["admitted"] = Value::String("/attacker/chosen/path".into());
        fs::write(&registry_path, canonical_json(&registry).unwrap()).unwrap();
        assert_eq!(
            load_admitted(state.path(), &bundle_ref, &verifier)
                .unwrap_err()
                .code,
            RefusalCode::RegistryMismatch
        );

        let (state, verifier, bundle_ref) = signed_admitted_fixture();
        let prepared = PreparedGraph::load_persisted(state.path(), &bundle_ref).unwrap();
        fs::create_dir(state.path().join("revoked")).unwrap();
        fs::write(
            state
                .path()
                .join("revoked")
                .join(prepared.identity.subject_digest),
            b"revoked",
        )
        .unwrap();
        assert_eq!(
            load_admitted(state.path(), &bundle_ref, &verifier)
                .unwrap_err()
                .code,
            RefusalCode::AdmissionRevoked
        );
    }

    #[test]
    fn admitted_loader_refuses_signature_and_exact_ref_drift() {
        let (state, verifier, bundle_ref) = signed_admitted_fixture();
        let prepared = PreparedGraph::load_persisted(state.path(), &bundle_ref).unwrap();
        let admitted = state
            .path()
            .join("admitted")
            .join(&prepared.identity.subject_digest);
        let envelope_path = admitted.join("envelope.json");
        let mut envelope: Value =
            serde_json::from_slice(&fs::read(&envelope_path).unwrap()).unwrap();
        envelope["admission"]["attestation"]["admitted_at"] =
            Value::String("ledger://tampered".into());
        fs::write(&envelope_path, canonical_json(&envelope).unwrap()).unwrap();
        assert_eq!(
            load_admitted(state.path(), &bundle_ref, &verifier)
                .unwrap_err()
                .code,
            RefusalCode::AttestationInvalid
        );

        let (state, verifier, bundle_ref) = signed_admitted_fixture();
        let prepared = PreparedGraph::load_persisted(state.path(), &bundle_ref).unwrap();
        fs::write(
            state
                .path()
                .join("admitted")
                .join(prepared.identity.subject_digest)
                .join("prepared-bundle-ref"),
            format!("{} ", bundle_ref),
        )
        .unwrap();
        assert_eq!(
            load_admitted(state.path(), &bundle_ref, &verifier)
                .unwrap_err()
                .code,
            RefusalCode::DigestMismatch
        );
    }

    #[test]
    fn isolated_local_refuses_account_mutation_and_admits_read_only() {
        let mutation = PlanNode {
            key: "act-on-web-api--execute-request".into(),
            plan: "Execute".into(),
            action: "skill:act-on-web-api@1.0.0:aiko".into(),
            depends_on: vec![],
            input_bindings: BTreeMap::new(),
            requires_authorization: true,
            effect_scope: "account_mutation".into(),
            read_only: false,
            reversible: false,
            timeout_ms: 30_000,
            skill_id: "act-on-web-api".into(),
            skill_version: "1.0.0".into(),
            worker: "aiko".into(),
            adapter: None,
            script: None,
            script_digest: None,
            evidence: vec![],
            writes: vec![],
            capabilities: vec![],
            research: vec![],
            witness: None,
            generated: false,
        };
        assert!(!mutation.isolated_local_admissible());
        let observe = PlanNode {
            key: "aiko-meta-agent--observe".into(),
            plan: "Observe".into(),
            action: "skill:aiko-meta-agent@1.0.0:host".into(),
            depends_on: vec![],
            input_bindings: BTreeMap::new(),
            requires_authorization: false,
            effect_scope: "read_only".into(),
            read_only: true,
            reversible: false,
            timeout_ms: 30_000,
            skill_id: "aiko-meta-agent".into(),
            skill_version: "1.0.0".into(),
            worker: "host".into(),
            adapter: Some(HOST_OBSERVE_ADAPTER.into()),
            script: None,
            script_digest: None,
            evidence: vec![],
            writes: vec![],
            capabilities: vec![],
            research: vec![],
            witness: None,
            generated: false,
        };
        assert!(observe.isolated_local_admissible());
    }
}
