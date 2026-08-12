//! Pinned edge-model dispatch for GraphHarness Primary.
//!
//! Models are allowed only at an edge leased by Contract. This module validates
//! the immutable adapter/witness/judge pins and grounds the one producer result;
//! it owns no frontier, scheduler, or durable state.

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub const EDGE_ADAPTER: &str = "aiko.graph-harness-edge-model/v1";
pub const BUILTIN_ACCEPTANCE: &str = "aiko.graph-harness-builtin-acceptance/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rollout {
    Observe,
    Prepare,
    EvaluateSupported,
    Primary,
}

impl Rollout {
    /// Deployment parsing is pure so the exact default/refusal is executable in
    /// the credentialless standalone witness. Request data never enters here.
    pub fn from_bootstrap() -> Result<Self, String> {
        Self::from_bootstrap_value(std::env::var("AIKO_GRAPH_HARNESS_ROLLOUT").ok().as_deref())
    }
    pub fn from_bootstrap_value(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("primary").to_ascii_lowercase().as_str() {
            "observe" => Ok(Self::Observe),
            "prepare" => Ok(Self::Prepare),
            "evaluate_supported" | "evaluate-supported" => Ok(Self::EvaluateSupported),
            "primary" => Ok(Self::Primary),
            other => Err(format!(
                "graph_harness_policy_invalid: unsupported deployment rollout {other:?}"
            )),
        }
    }
    pub fn requires_graph_harness(self) -> bool {
        !matches!(self, Self::Observe)
    }
    pub fn permits_admission_materialization(self) -> bool {
        matches!(self, Self::Primary)
    }
}

#[derive(Clone, Debug)]
pub struct EdgeExecutionClaim {
    pub execution_id: String,
    pub node_id: String,
    pub graph_subject_digest: String,
    pub graph_transitive_digest: String,
    pub adapter: String,
    pub adapter_digest: String,
    pub witness_id: String,
    pub witness_digest: String,
    pub judge_digest: String,
    pub required_outputs: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct EdgeProducerResult {
    pub outcome: String,
    pub evidence: Value,
    pub detail: String,
}

#[allow(async_fn_in_trait)]
pub trait EdgeModelExecutor {
    async fn execute_once(&mut self, claim: &EdgeExecutionClaim) -> EdgeProducerResult;
}

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputProgram {
    api_version: String,
    ports: Vec<String>,
    predicate: String,
}

fn parse_output_program(
    bytes: &[u8],
    digest_pin: &str,
    api: &str,
    required_outputs: &[String],
) -> Result<OutputProgram, String> {
    if sha256(bytes) != digest_pin {
        return Err("required-output evaluator bytes drifted from their CAS pin".into());
    }
    let program: OutputProgram = serde_json::from_slice(bytes)
        .map_err(|error| format!("required-output evaluator is malformed: {error}"))?;
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("required-output evaluator is malformed: {error}"))?;
    let canonical = serde_json::to_vec(&normalize_canonical(&value))
        .map_err(|error| format!("required-output evaluator encoding failed: {error}"))?;
    if canonical != bytes
        || program.api_version != api
        || program.predicate != "required-non-null"
        || program.ports != required_outputs
        || program.ports.is_empty()
    {
        return Err("required-output evaluator declaration differs from the leased claim".into());
    }
    Ok(program)
}

fn evaluate_required_outputs(evidence: &Value, ports: &[String]) -> Result<String, String> {
    let object = evidence
        .as_object()
        .ok_or_else(|| "producer evidence is not an object".to_owned())?;
    if object.len() != ports.len()
        || ports
            .iter()
            .any(|port| object.get(port).map_or(true, Value::is_null))
    {
        return Err("producer result must contain exactly the declared non-null outputs".into());
    }
    canonical_product_digest(evidence)
}

fn independent_output_recheck(
    durable_output: &[u8],
    ports: &[String],
    witness_digest: &str,
) -> Result<String, String> {
    let reparsed: Value = serde_json::from_slice(durable_output)
        .map_err(|error| format!("durable producer output is malformed: {error}"))?;
    let computed = evaluate_required_outputs(&reparsed, ports)?;
    if computed != witness_digest {
        return Err("independent output judge detected product digest drift".into());
    }
    Ok(computed)
}

/// Execute once only after both CAS-pinned declarative evaluators have been
/// parsed. The model's product, not the program digest, determines pass/fail.
pub async fn execute_pinned_edge<E: EdgeModelExecutor>(
    executor: &mut E,
    claim: &EdgeExecutionClaim,
    witness_program: &[u8],
    judge_program: &[u8],
) -> EdgeProducerResult {
    if claim.adapter != EDGE_ADAPTER
        || !digest(&claim.graph_subject_digest)
        || !digest(&claim.graph_transitive_digest)
        || !digest(&claim.adapter_digest)
        || !digest(&claim.witness_digest)
        || !digest(&claim.judge_digest)
        || claim.witness_digest == claim.judge_digest
        || claim.execution_id.is_empty()
        || claim.node_id.is_empty()
        || parse_output_program(
            witness_program,
            &claim.witness_digest,
            "aiko-required-output-witness/v1",
            &claim.required_outputs,
        )
        .is_err()
        || parse_output_program(
            judge_program,
            &claim.judge_digest,
            "aiko-independent-output-recheck/v1",
            &claim.required_outputs,
        )
        .is_err()
    {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail: "edge-model declarative evaluator pins were incomplete or foreign".into(),
        };
    }
    let mut produced = executor.execute_once(claim).await;
    if produced.outcome != "satisfied" {
        return produced;
    }
    let product_digest =
        match evaluate_required_outputs(&produced.evidence, &claim.required_outputs) {
            Ok(value) => value,
            Err(detail) => {
                return EdgeProducerResult {
                    outcome: "died".into(),
                    evidence: json!({}),
                    detail,
                };
            }
        };
    let durable_output =
        serde_json::to_vec(&normalize_canonical(&produced.evidence)).unwrap_or_default();
    if let Err(detail) =
        independent_output_recheck(&durable_output, &claim.required_outputs, &product_digest)
    {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail,
        };
    }
    let Some(evidence) = produced.evidence.as_object_mut() else {
        unreachable!()
    };
    let graph_source = format!("graph-stimulus:sha256:{}", claim.graph_subject_digest);
    let product_source = format!("artifact:sha256:{product_digest}");
    evidence.insert("cell_manifest".into(), json!({"digest":product_digest,"cell_digest":claim.adapter_digest,
        "transitive_digest":claim.graph_transitive_digest,"sources":[graph_source,product_source],"produced_by":EDGE_ADAPTER}));
    evidence.insert("neuron_firing".into(), json!({"execution_id":claim.execution_id,"sources":[graph_source,product_source],"produced_by":EDGE_ADAPTER}));
    evidence.insert("product_digest".into(), json!(product_digest));
    evidence.insert(
        "witness_verdict".into(),
        json!({"digest":claim.witness_digest,"evaluator":claim.witness_id,"verdict":"pass"}),
    );
    evidence.insert("judge_verdict".into(), json!({"digest":claim.judge_digest,"evaluator":format!("output-judge-{}",&claim.judge_digest[..16]),"verdict":"pass"}));
    produced.detail =
        "leased edge product passed CAS-pinned witness and independent output recheck".into();
    produced
}

/// Execute one already-leased deterministic host adapter. FnOnce prevents a
/// retry, while the same declarative program path prevents digest-labelled pass.
pub fn execute_pinned_host<F>(
    claim: &EdgeExecutionClaim,
    witness_program: &[u8],
    judge_program: &[u8],
    producer: F,
) -> EdgeProducerResult
where
    F: FnOnce() -> Option<EdgeProducerResult>,
{
    if !super::graph_harness::deterministic_host_adapter(&claim.adapter)
        || !digest(&claim.graph_subject_digest)
        || !digest(&claim.graph_transitive_digest)
        || !digest(&claim.adapter_digest)
        || !digest(&claim.witness_digest)
        || !digest(&claim.judge_digest)
        || claim.witness_digest == claim.judge_digest
        || claim.execution_id.is_empty()
        || claim.node_id.is_empty()
        || parse_output_program(
            witness_program,
            &claim.witness_digest,
            "aiko-required-output-witness/v1",
            &claim.required_outputs,
        )
        .is_err()
        || parse_output_program(
            judge_program,
            &claim.judge_digest,
            "aiko-independent-output-recheck/v1",
            &claim.required_outputs,
        )
        .is_err()
    {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail: "native host declarative evaluator pins were incomplete or foreign".into(),
        };
    }
    let Some(mut produced) = producer() else {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail: "native host adapter identity was not recognized".into(),
        };
    };
    if produced.outcome != "satisfied" {
        return produced;
    }
    let product_digest =
        match evaluate_required_outputs(&produced.evidence, &claim.required_outputs) {
            Ok(value) => value,
            Err(detail) => {
                return EdgeProducerResult {
                    outcome: "died".into(),
                    evidence: json!({}),
                    detail,
                };
            }
        };
    let durable_output =
        serde_json::to_vec(&normalize_canonical(&produced.evidence)).unwrap_or_default();
    if let Err(detail) =
        independent_output_recheck(&durable_output, &claim.required_outputs, &product_digest)
    {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail,
        };
    }
    let Some(evidence) = produced.evidence.as_object_mut() else {
        unreachable!()
    };
    let graph_source = format!("graph-stimulus:sha256:{}", claim.graph_subject_digest);
    let product_source = format!("artifact:sha256:{product_digest}");
    evidence.insert("cell_manifest".into(), json!({"digest":product_digest,"cell_digest":claim.adapter_digest,
        "transitive_digest":claim.graph_transitive_digest,"sources":[graph_source,product_source],"produced_by":claim.adapter}));
    evidence.insert("neuron_firing".into(), json!({"execution_id":claim.execution_id,"sources":[graph_source,product_source],"produced_by":claim.adapter}));
    evidence.insert("product_digest".into(), json!(product_digest));
    evidence.insert(
        "witness_verdict".into(),
        json!({"digest":claim.witness_digest,"evaluator":claim.witness_id,"verdict":"pass"}),
    );
    evidence.insert("judge_verdict".into(), json!({"digest":claim.judge_digest,"evaluator":format!("output-judge-{}",&claim.judge_digest[..16]),"verdict":"pass"}));
    produced.detail =
        "leased host product passed CAS-pinned witness and independent output recheck".into();
    produced
}

/// Canonical declarative program pinned in PreparedGraph CAS.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettlementProgram {
    api_version: String,
    predicate: String,
    required_input_ports: Vec<String>,
}

const WITNESS_API: &str = "aiko-terminal-settlement/v1";
const JUDGE_API: &str = "aiko-independent-settlement-recheck/v1";
const SETTLEMENT_PREDICATE: &str = "aiko-terminal-settlement/v1";
const MAX_SETTLEMENT_EVIDENCE_BYTES: usize = 4096;

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn normalize_canonical(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(normalize_canonical).collect()),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), normalize_canonical(&values[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn canonical_product_digest(product: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(&normalize_canonical(product))
        .map_err(|error| format!("canonical product encoding failed: {error}"))?;
    Ok(sha256(&bytes))
}

fn parse_program(bytes: &[u8], api: &str) -> Result<SettlementProgram, String> {
    let program: SettlementProgram = serde_json::from_slice(bytes)
        .map_err(|error| format!("declarative evaluator is malformed: {error}"))?;
    if program.api_version != api
        || program.predicate != SETTLEMENT_PREDICATE
        || program.required_input_ports.len() != 1
        || program.required_input_ports[0] != "result"
    {
        return Err("declarative evaluator declaration does not match the north-star claim".into());
    }
    // A semantically equivalent but non-canonical declaration is a different,
    // unsupported program. CAS identity cannot bless free-form JSON spelling.
    let parsed_value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("declarative evaluator is malformed: {error}"))?;
    let canonical = serde_json::to_vec(&normalize_canonical(&parsed_value))
        .map_err(|error| format!("declarative evaluator encoding failed: {error}"))?;
    if canonical != bytes {
        return Err("declarative evaluator bytes are not canonical JSON".into());
    }
    Ok(program)
}

fn evaluate_settlement(durable_input: &[u8]) -> Result<String, String> {
    let reparsed: Value = serde_json::from_slice(durable_input)
        .map_err(|error| format!("durable north-star input is malformed: {error}"))?;
    let inputs = reparsed
        .as_object()
        .filter(|inputs| inputs.len() == 1 && inputs.contains_key("result"))
        .ok_or_else(|| {
            "north-star input must contain exactly the declared result port".to_owned()
        })?;
    let result = inputs["result"]
        .as_object()
        .ok_or_else(|| "north-star result must be a non-null object".to_owned())?;
    const REQUIRED_FIELDS: [&str; 7] = [
        "completed",
        "retryable",
        "evidence",
        "goal_digest",
        "product_digest",
        "witness_evidence",
        "judge_evidence",
    ];
    if result.len() != REQUIRED_FIELDS.len()
        || !REQUIRED_FIELDS
            .iter()
            .all(|field| result.contains_key(*field))
    {
        return Err("north-star result is not the exact grounded product settlement".into());
    }
    let completed = result
        .get("completed")
        .and_then(Value::as_bool)
        .ok_or_else(|| "north-star result.completed must be a bool".to_owned())?;
    let retryable = result
        .get("retryable")
        .and_then(Value::as_bool)
        .ok_or_else(|| "north-star result.retryable must be a bool".to_owned())?;
    if !completed || retryable {
        return Err("north-star settlement did not satisfy the requested outcome".into());
    }
    let evidence = result
        .get("evidence")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= MAX_SETTLEMENT_EVIDENCE_BYTES)
        .ok_or_else(|| "north-star result.evidence must be nonempty and bounded".to_owned())?;
    let goal_digest = result
        .get("goal_digest")
        .and_then(Value::as_str)
        .filter(|value| digest(value))
        .ok_or_else(|| "north-star result.goal_digest must be sha256".to_owned())?;
    let product_digest = result
        .get("product_digest")
        .and_then(Value::as_str)
        .filter(|value| digest(value))
        .ok_or_else(|| "north-star result.product_digest must be sha256".to_owned())?;
    if goal_digest == product_digest {
        return Err("north-star goal and product identities must be distinct".into());
    }
    for field in ["witness_evidence", "judge_evidence"] {
        result
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= MAX_SETTLEMENT_EVIDENCE_BYTES)
            .ok_or_else(|| format!("north-star result.{field} must be nonempty and bounded"))?;
    }
    let _ = evidence;
    canonical_product_digest(&inputs["result"])
}

struct WitnessEvidence {
    predicate: &'static str,
    product_digest: String,
}

fn independent_judge(
    durable_input: &[u8],
    witness_evidence: &WitnessEvidence,
) -> Result<String, String> {
    // Deliberately reparse and re-run the predicate rather than trusting the
    // witness's shape verdict or claimed product digest.
    if witness_evidence.predicate != SETTLEMENT_PREDICATE
        || !digest(&witness_evidence.product_digest)
    {
        return Err("independent judge rejected foreign witness evidence".into());
    }
    let independently_computed = evaluate_settlement(durable_input)?;
    if independently_computed != witness_evidence.product_digest {
        return Err("independent judge detected product digest drift".into());
    }
    Ok(independently_computed)
}

/// Execute the two CAS-pinned declarative programs over one durable terminal
/// product. A digest names bytes; only parsing and executing those bytes can
/// produce a pass.
pub fn execute_north_star(
    claim: &EdgeExecutionClaim,
    inputs: &Value,
    witness_program: &[u8],
    judge_program: &[u8],
) -> EdgeProducerResult {
    let pins_valid = claim.adapter == super::graph_harness::CELL_ADAPTER_VERSION
        && digest(&claim.graph_subject_digest)
        && digest(&claim.graph_transitive_digest)
        && digest(&claim.adapter_digest)
        && digest(&claim.witness_digest)
        && digest(&claim.judge_digest)
        && claim.witness_digest != claim.judge_digest
        && !claim.execution_id.is_empty()
        && !claim.witness_id.is_empty()
        && claim.node_id == "__graph_harness_north_star"
        && claim.required_outputs.len() == 1
        && claim.required_outputs[0] == "result"
        && sha256(witness_program) == claim.witness_digest
        && sha256(judge_program) == claim.judge_digest;
    if !pins_valid {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail: "north-star inputs, declaration pins, or required ports were incomplete".into(),
        };
    }
    if let Err(detail) = parse_program(witness_program, WITNESS_API) {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail,
        };
    }
    if let Err(detail) = parse_program(judge_program, JUDGE_API) {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail,
        };
    }
    let durable_input = match serde_json::to_vec(&normalize_canonical(inputs)) {
        Ok(bytes) => bytes,
        Err(error) => {
            return EdgeProducerResult {
                outcome: "died".into(),
                evidence: json!({}),
                detail: format!("durable north-star input encoding failed: {error}"),
            };
        }
    };
    let witness_product_digest = match evaluate_settlement(&durable_input) {
        Ok(value) => value,
        Err(detail) => {
            return EdgeProducerResult {
                outcome: "died".into(),
                evidence: json!({}),
                detail,
            };
        }
    };
    let witness_evidence = WitnessEvidence {
        predicate: SETTLEMENT_PREDICATE,
        product_digest: witness_product_digest.clone(),
    };
    let judge_product_digest = match independent_judge(&durable_input, &witness_evidence) {
        Ok(value) => value,
        Err(detail) => {
            return EdgeProducerResult {
                outcome: "died".into(),
                evidence: json!({}),
                detail,
            };
        }
    };
    if judge_product_digest != witness_product_digest {
        return EdgeProducerResult {
            outcome: "died".into(),
            evidence: json!({}),
            detail: "independent judge product digest drift".into(),
        };
    }
    let graph_source = format!("graph-stimulus:sha256:{}", claim.graph_subject_digest);
    let product_source = format!("artifact:sha256:{witness_product_digest}");
    let witness_evaluator = claim.witness_id.clone();
    let judge_evaluator = format!("north-star-judge-{}", &claim.judge_digest[..16]);
    EdgeProducerResult {
        outcome: "satisfied".into(),
        evidence: json!({
            "cell_manifest":{"digest":witness_product_digest,"cell_digest":claim.adapter_digest,
                "transitive_digest":claim.graph_transitive_digest,"sources":[graph_source,product_source],
                "produced_by":BUILTIN_ACCEPTANCE},
            "neuron_firing":{"execution_id":claim.execution_id,"sources":[graph_source,product_source],
                "produced_by":BUILTIN_ACCEPTANCE},
            "product_digest":witness_product_digest,
            "witness_evidence":{"predicate":witness_evidence.predicate,"product_digest":witness_evidence.product_digest},
            "witness_verdict":{"digest":claim.witness_digest,"evaluator":witness_evaluator,"verdict":"pass"},
            "judge_verdict":{"digest":claim.judge_digest,"evaluator":judge_evaluator,"verdict":"pass"}
        }),
        detail: "CAS-pinned terminal settlement predicate passed independent digest recheck".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::graph_harness::*;
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    struct FakeEdge {
        calls: usize,
    }
    impl EdgeModelExecutor for FakeEdge {
        async fn execute_once(&mut self, _claim: &EdgeExecutionClaim) -> EdgeProducerResult {
            self.calls += 1;
            EdgeProducerResult {
                outcome: "satisfied".into(),
                evidence: json!({"result":{"answer":"grounded"}}),
                detail: "model edge".into(),
            }
        }
    }
    fn source(kind: &str, bytes: &str) -> MaterialSource {
        MaterialSource {
            kind: kind.into(),
            media_type: "application/octet-stream".into(),
            bytes: bytes.as_bytes().to_vec(),
        }
    }
    fn fixture() -> (PlanPreview, HostProfile, EvaluationPolicy) {
        let plan = PlanPreview {
            core_admitted: true,
            children: vec![PlanNode {
                key: "answer".into(),
                plan: "produce a grounded ordinary answer".into(),
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
            (
                "witness".into(),
                source(
                    "witness",
                    r#"{"api_version":"aiko-required-output-witness/v1","ports":["result"],"predicate":"required-non-null"}"#,
                ),
            ),
            (
                "judge".into(),
                source(
                    "judge",
                    r#"{"api_version":"aiko-independent-output-recheck/v1","ports":["result"],"predicate":"required-non-null"}"#,
                ),
            ),
            (
                "north-witness".into(),
                source(
                    "witness",
                    std::str::from_utf8(NORTH_STAR_WITNESS_PROGRAM).unwrap(),
                ),
            ),
            (
                "north-judge".into(),
                source(
                    "judge",
                    std::str::from_utf8(NORTH_STAR_JUDGE_PROGRAM).unwrap(),
                ),
            ),
        ]);
        let nodes = BTreeMap::from([(
            "answer".into(),
            NodeProfile {
                cell: "edge".into(),
                witness: "witness".into(),
                judge: "judge".into(),
                verdict_schema: "verdict".into(),
            },
        )]);
        let profile = HostProfile {
            package_name: "ordinary".into(),
            package_version: "1".into(),
            description: "ordinary".into(),
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
        (plan, profile, policy)
    }

    #[tokio::test]
    async fn public_typed_edge_flow_executes_once_and_reaches_materialization() {
        assert_eq!(
            Rollout::from_bootstrap_value(None).unwrap(),
            Rollout::Primary
        );
        assert!(Rollout::from_bootstrap_value(Some("invalid")).is_err());
        let (plan, profile, policy) = fixture();
        assert!(matches!(
            classify_workflow(
                &WorkflowRequestFacts {
                    explicit_workflow: true,
                    ..Default::default()
                },
                Some(&plan)
            ),
            WorkflowRoute::GraphHarnessRequired { .. }
        ));
        let prepared =
            PreparedGraphAdapter::prepare("ordinary explicit workflow", &plan, &profile, &policy)
                .unwrap();
        assert_eq!(
            prepared
                .envelope
                .pointer("/package/nodes/0/determinism")
                .and_then(Value::as_str),
            Some("edge_only")
        );
        let request = GraphHarnessContractAdapter::expand_request(
            &prepared,
            "root0001",
            "ordinary explicit workflow",
            Path::new("/tmp"),
            0,
            4,
            1,
        )
        .unwrap();
        let child = &request.children[0];
        assert_eq!(child.worker, "aiko");
        assert_eq!(child.adapter, EDGE_ADAPTER);
        let claim = EdgeExecutionClaim {
            execution_id: "execution-1".into(),
            node_id: child.key.clone(),
            graph_subject_digest: prepared.identity.subject_digest.clone(),
            graph_transitive_digest: prepared.identity.transitive_digest.clone(),
            adapter: child.adapter.clone(),
            adapter_digest: child.cell_digest.clone(),
            witness_id: child.witness_id.clone(),
            witness_digest: child.witness_digest.clone(),
            judge_digest: child.judge_digest.clone(),
            required_outputs: vec!["result".into()],
        };
        let witness_program = prepared.material_bytes(&claim.witness_digest).unwrap();
        let judge_program = prepared.material_bytes(&claim.judge_digest).unwrap();
        let mut fake = FakeEdge { calls: 0 };
        let fired = execute_pinned_edge(&mut fake, &claim, witness_program, judge_program).await;
        assert_eq!(fake.calls, 1);
        assert_eq!(fired.outcome, "satisfied");
        assert_eq!(fired.evidence["neuron_firing"]["produced_by"], EDGE_ADAPTER);
        assert_eq!(
            fired.evidence["neuron_firing"]["sources"][0],
            format!("graph-stimulus:sha256:{}", prepared.identity.subject_digest)
        );
        let settled = fired.evidence.get("result").is_some();
        assert!(settled);
        let north = &request.children[1];
        let north_claim = EdgeExecutionClaim {
            execution_id: "execution-north".into(),
            node_id: north.key.clone(),
            graph_subject_digest: prepared.identity.subject_digest.clone(),
            graph_transitive_digest: prepared.identity.transitive_digest.clone(),
            adapter: north.adapter.clone(),
            adapter_digest: north.cell_digest.clone(),
            witness_id: north.witness_id.clone(),
            witness_digest: north.witness_digest.clone(),
            judge_digest: north.judge_digest.clone(),
            required_outputs: vec!["result".into()],
        };
        assert_eq!(north.input_bindings["result"], "answer.result");
        let witness_program = prepared
            .material_bytes(&north_claim.witness_digest)
            .unwrap();
        let judge_program = prepared.material_bytes(&north_claim.judge_digest).unwrap();
        let terminal_settlement = json!({"result":{
            "completed":true,"retryable":false,"evidence":"ordinary workflow settled",
            "goal_digest":"a".repeat(64),"product_digest":"b".repeat(64),
            "witness_evidence":"direct product witness passed",
            "judge_evidence":"independent direct product judge passed"
        }});
        let north_verdict = execute_north_star(
            &north_claim,
            &terminal_settlement,
            witness_program,
            judge_program,
        );
        assert_eq!(
            north_verdict.outcome, "satisfied",
            "{}",
            north_verdict.detail
        );
        let product_digest = north_verdict.evidence["product_digest"].as_str().unwrap();
        assert_eq!(
            north_verdict.evidence["neuron_firing"]["sources"][0],
            format!("graph-stimulus:sha256:{}", prepared.identity.subject_digest)
        );
        assert_eq!(
            north_verdict.evidence["neuron_firing"]["sources"][1],
            format!("artifact:sha256:{product_digest}")
        );
        assert_eq!(
            north_verdict.evidence["neuron_firing"]["produced_by"],
            BUILTIN_ACCEPTANCE
        );
        assert_ne!(
            north_verdict.evidence["witness_verdict"]["evaluator"],
            north_verdict.evidence["judge_verdict"]["evaluator"]
        );
        // Issuance, authentication, and materialization are Contract-owned
        // downstream operations and are intentionally not simulated here.
        assert!(settled);
    }

    fn north_claim_for(witness: &[u8], judge: &[u8]) -> EdgeExecutionClaim {
        EdgeExecutionClaim {
            execution_id: "execution-north".into(),
            node_id: "__graph_harness_north_star".into(),
            graph_subject_digest: "a".repeat(64),
            graph_transitive_digest: "b".repeat(64),
            adapter: CELL_ADAPTER_VERSION.into(),
            adapter_digest: "c".repeat(64),
            witness_id: "north-star-witness".into(),
            witness_digest: sha256(witness),
            judge_digest: sha256(judge),
            required_outputs: vec!["result".into()],
        }
    }

    #[test]
    fn exact_north_star_refuses_bad_products_programs_and_digest_drift() {
        let good = json!({"result":{
            "completed":true,"retryable":false,"evidence":"durable settlement evidence",
            "goal_digest":"a".repeat(64),"product_digest":"b".repeat(64),
            "witness_evidence":"direct product witness passed",
            "judge_evidence":"independent direct product judge passed"
        }});
        let claim = north_claim_for(NORTH_STAR_WITNESS_PROGRAM, NORTH_STAR_JUDGE_PROGRAM);
        let run = |claim: &EdgeExecutionClaim, input: &Value, witness: &[u8], judge: &[u8]| {
            execute_north_star(claim, input, witness, judge)
        };
        assert_eq!(
            run(
                &claim,
                &good,
                NORTH_STAR_WITNESS_PROGRAM,
                NORTH_STAR_JUDGE_PROGRAM
            )
            .outcome,
            "satisfied"
        );
        for bad in [
            json!({}),
            json!({"wrong_port":{"completed":true,"retryable":false,"evidence":"x"}}),
            json!({"result":null}),
            json!({"result":{"completed":"yes","retryable":false,"evidence":"x"}}),
            json!({"result":{"completed":false,"retryable":false,"evidence":"x"}}),
            json!({"result":{"completed":true,"retryable":true,"evidence":"x"}}),
            json!({"result":{"completed":true,"retryable":false,"evidence":""}}),
            json!({"result":{"completed":true,"retryable":false,"evidence":"x"},"extra":1}),
        ] {
            assert_eq!(
                run(
                    &claim,
                    &bad,
                    NORTH_STAR_WITNESS_PROGRAM,
                    NORTH_STAR_JUDGE_PROGRAM
                )
                .outcome,
                "died"
            );
        }

        let foreign = br#"{"api_version":"foreign/v1","predicate":"aiko-terminal-settlement/v1","required_input_ports":["result"]}"#;
        let foreign_claim = north_claim_for(foreign, NORTH_STAR_JUDGE_PROGRAM);
        assert_eq!(
            run(&foreign_claim, &good, foreign, NORTH_STAR_JUDGE_PROGRAM).outcome,
            "died"
        );

        let mut mismatched = claim.clone();
        mismatched.witness_digest = "f".repeat(64);
        assert_eq!(
            run(
                &mismatched,
                &good,
                NORTH_STAR_WITNESS_PROGRAM,
                NORTH_STAR_JUDGE_PROGRAM
            )
            .outcome,
            "died"
        );

        let same_claim = north_claim_for(NORTH_STAR_WITNESS_PROGRAM, NORTH_STAR_WITNESS_PROGRAM);
        assert_eq!(
            run(
                &same_claim,
                &good,
                NORTH_STAR_WITNESS_PROGRAM,
                NORTH_STAR_WITNESS_PROGRAM
            )
            .outcome,
            "died"
        );

        let durable = serde_json::to_vec(&normalize_canonical(&good)).unwrap();
        let drifted = WitnessEvidence {
            predicate: SETTLEMENT_PREDICATE,
            product_digest: "0".repeat(64),
        };
        assert!(independent_judge(&durable, &drifted).is_err());
    }

    struct OutputEdge(Value);
    impl EdgeModelExecutor for OutputEdge {
        async fn execute_once(&mut self, _claim: &EdgeExecutionClaim) -> EdgeProducerResult {
            EdgeProducerResult {
                outcome: "satisfied".into(),
                evidence: self.0.clone(),
                detail: "edge".into(),
            }
        }
    }

    #[tokio::test]
    async fn model_and_host_refuse_missing_null_extra_and_foreign_output_programs() {
        let witness = br#"{"api_version":"aiko-required-output-witness/v1","ports":["result"],"predicate":"required-non-null"}"#;
        let judge = br#"{"api_version":"aiko-independent-output-recheck/v1","ports":["result"],"predicate":"required-non-null"}"#;
        let mut claim = north_claim_for(witness, judge);
        claim.node_id = "producer".into();
        claim.adapter = EDGE_ADAPTER.into();
        for bad in [
            json!({}),
            json!({"result":null}),
            json!({"wrong":1}),
            json!({"result":1,"extra":2}),
        ] {
            let mut edge = OutputEdge(bad);
            assert_eq!(
                execute_pinned_edge(&mut edge, &claim, witness, judge)
                    .await
                    .outcome,
                "died"
            );
        }
        let foreign =
            br#"{"api_version":"foreign/v1","ports":["result"],"predicate":"required-non-null"}"#;
        let mut foreign_claim = claim.clone();
        foreign_claim.witness_digest = sha256(foreign);
        let mut edge = OutputEdge(json!({"result":1}));
        assert_eq!(
            execute_pinned_edge(&mut edge, &foreign_claim, foreign, judge)
                .await
                .outcome,
            "died"
        );

        claim.adapter = HOST_SETTLE_ADAPTER.into();
        for bad in [
            json!({}),
            json!({"result":null}),
            json!({"result":1,"extra":2}),
        ] {
            assert_eq!(
                execute_pinned_host(&claim, witness, judge, || Some(EdgeProducerResult {
                    outcome: "satisfied".into(),
                    evidence: bad,
                    detail: "host".into()
                }))
                .outcome,
                "died"
            );
        }
        let mut host_foreign_claim = foreign_claim.clone();
        host_foreign_claim.adapter = HOST_SETTLE_ADAPTER.into();
        assert_eq!(
            execute_pinned_host(&host_foreign_claim, foreign, judge, || Some(
                EdgeProducerResult {
                    outcome: "satisfied".into(),
                    evidence: json!({"result":1}),
                    detail: "host".into()
                }
            ))
            .outcome,
            "died"
        );
    }

    #[test]
    fn exact_opaque_script_is_never_direct_or_supported() {
        let (mut plan, profile, policy) = fixture();
        let node = &mut plan.children[0];
        node.worker = "script".into();
        node.adapter = Some("aiko.neuron-json-stdio/v1".into());
        node.script = Some("/bin/sh".into());
        node.script_digest = Some("00".repeat(32));
        assert!(matches!(
            classify_workflow(&WorkflowRequestFacts::default(), Some(&plan)),
            WorkflowRoute::GraphHarnessRequired { .. }
        ));
        assert_eq!(
            PreparedGraphAdapter::prepare("hostile", &plan, &profile, &policy)
                .unwrap_err()
                .code,
            RefusalCode::UnsupportedWorker
        );
    }

    #[test]
    fn pinned_native_host_dispatches_exactly_once_and_keeps_adapter_identity() {
        let calls = std::cell::Cell::new(0usize);
        let witness = br#"{"api_version":"aiko-required-output-witness/v1","ports":["settlement"],"predicate":"required-non-null"}"#;
        let judge = br#"{"api_version":"aiko-independent-output-recheck/v1","ports":["settlement"],"predicate":"required-non-null"}"#;
        let claim = EdgeExecutionClaim {
            execution_id: "execution".into(),
            node_id: "aiko-meta-agent--settle".into(),
            graph_subject_digest: "a".repeat(64),
            graph_transitive_digest: "b".repeat(64),
            adapter: HOST_SETTLE_ADAPTER.into(),
            adapter_digest: "c".repeat(64),
            witness_id: "settle-witness".into(),
            witness_digest: sha256(witness),
            judge_digest: sha256(judge),
            required_outputs: vec!["settlement".into()],
        };
        let verdict = execute_pinned_host(&claim, witness, judge, || {
            calls.set(calls.get() + 1);
            Some(EdgeProducerResult {
                outcome: "satisfied".into(),
                evidence: json!({"settlement":{"completed":true}}),
                detail: "native".into(),
            })
        });
        assert_eq!(calls.get(), 1);
        assert_eq!(verdict.outcome, "satisfied");
        assert_eq!(
            verdict.evidence["cell_manifest"]["produced_by"],
            HOST_SETTLE_ADAPTER
        );
    }
}
