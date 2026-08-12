//! Dependency-minimal orchestration for the strict GraphHarness host path.
//!
//! This module deliberately knows nothing about Contract's ABI, CellSidecar,
//! or the persisted graph implementation.  Production adapts those types at
//! the boundary; the state machine below is the one algorithm exercised by the
//! isolated witness and by the real host.

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaimIdentity {
    pub api_version: String,
    pub state: String,
    pub subject_digest: String,
    pub transitive_digest: String,
    pub adapter: String,
    pub bundle_ref: String,
    pub evaluation_policy: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Claim {
    pub contract_id: String,
    pub occurrence: String,
    pub state_root: PathBuf,
    pub expected_api_version: &'static str,
    pub expected_adapter: &'static str,
    pub expected_evaluation_policy: &'static str,
    pub materialize_admission: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WaveStatus {
    Wave,
    Waiting,
    Held,
    Failed,
    Complete,
}

#[derive(Clone, Debug)]
pub(crate) struct Node<N> {
    pub execution_id: String,
    pub attempt: u32,
    pub key: String,
    pub inputs: Value,
    pub payload: N,
}

#[derive(Clone, Debug)]
pub(crate) struct Wave<N> {
    pub status: WaveStatus,
    pub root_id: String,
    pub graph_digest: String,
    pub identity: Option<ClaimIdentity>,
    pub terminal_evidence: Option<Value>,
    pub nodes: Vec<Node<N>>,
}

#[derive(Debug)]
pub(crate) struct Prepared<P> {
    pub payload: P,
    pub subject_digest: String,
    pub transitive_digest: String,
    pub adapter: String,
    pub bundle_digest: String,
    pub witness_digest: String,
    pub judge_digest: String,
}

#[derive(Clone, Debug)]
pub(crate) struct NodeVerdict {
    pub outcome: &'static str,
    pub evidence: Value,
    pub detail: String,
}

#[derive(Debug)]
pub(crate) struct Settlement<D> {
    pub root_id: String,
    pub root_occurrence: String,
    pub owner: String,
    pub execution_id: String,
    pub attempt: u32,
    pub outcome: String,
    pub evidence: Value,
    pub detail: String,
    pub decision: D,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub completed: bool,
    pub retryable: bool,
    pub evidence: String,
}

#[allow(async_fn_in_trait)]
pub(crate) trait Orchestration {
    type NodePayload;
    type PreparedPayload;
    type Decision;

    async fn claim_wave(
        &mut self,
        contract_id: String,
        occurrence: String,
        owner: String,
    ) -> Option<Wave<Self::NodePayload>>;
    fn load_bundle(
        &mut self,
        state_root: &Path,
        bundle_ref: &str,
    ) -> Result<Prepared<Self::PreparedPayload>, String>;
    async fn execute_node(
        &mut self,
        prepared: &Self::PreparedPayload,
        identity: &ClaimIdentity,
        node: &Node<Self::NodePayload>,
    ) -> NodeVerdict;
    fn commit_neuron(
        &mut self,
        node: &Node<Self::NodePayload>,
        verdict: &NodeVerdict,
        now: u64,
    ) -> Option<Self::Decision>;
    async fn settle_node(&mut self, settlement: Settlement<Self::Decision>, now: u64) -> bool;
    async fn issue_terminal(&mut self, request: Value) -> Option<Value>;
    fn authenticate_terminal(
        &mut self,
        prepared: &Self::PreparedPayload,
        statement: &Value,
    ) -> Result<(), String>;
    fn materialize_terminal(
        &mut self,
        prepared: &Self::PreparedPayload,
        statement: &Value,
        state_root: &Path,
    ) -> Result<(), String>;
    fn now_ms(&mut self) -> u64;
    async fn wait_for_wave(&mut self);
}

fn terminal_verdict(terminal: Option<Value>) -> Verdict {
    let settlement = terminal.as_ref().and_then(|v| v.get("settlement"));
    let completed = settlement
        .and_then(|v| v.get("completed"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let retryable = settlement
        .and_then(|v| v.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(!completed);
    let evidence = settlement
        .and_then(|v| v.get("evidence"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .unwrap_or("Meta-Agent settlement lacked postcondition evidence")
        .to_owned();
    Verdict {
        completed,
        retryable,
        evidence,
    }
}

fn validate_wave<N>(
    claim: &Claim,
    expected_graph: Option<&str>,
    expected: &ClaimIdentity,
    wave: &Wave<N>,
) -> Result<(), String> {
    if wave.root_id != claim.contract_id || expected_graph.is_some_and(|v| wave.graph_digest != v) {
        return Err("graph_harness_claim_mismatch: Contract changed root or graph identity".into());
    }
    match wave.identity.as_ref() {
        None => {
            Err("graph_harness_claim_missing: immutable bundle identity was not projected".into())
        }
        Some(actual) if actual != expected => Err(
            "graph_harness_claim_mismatch: immutable bundle identity changed between waves".into(),
        ),
        Some(_) => Ok(()),
    }
}

pub(crate) async fn execute_graph_harness_claim_with<O: Orchestration>(
    host: &mut O,
    owner: String,
    claim: &Claim,
) -> Verdict {
    let mut expected_identity = None;
    let mut graph_digest: Option<String> = None;
    let mut prepared: Option<Prepared<O::PreparedPayload>> = None;
    let mut executed = BTreeSet::new();
    for _ in 0..64 {
        let Some(wave) = host
            .claim_wave(
                claim.contract_id.clone(),
                claim.occurrence.clone(),
                owner.clone(),
            )
            .await
        else {
            return Verdict {
                completed: false,
                retryable: true,
                evidence: "Contract could not lease the exact GraphHarness wave".into(),
            };
        };
        if expected_identity.is_none() {
            let Some(identity) = wave.identity.clone() else {
                return Verdict {
                    completed: false,
                    retryable: false,
                    evidence:
                        "graph_harness_claim_missing: strict root has no immutable bundle identity"
                            .into(),
                };
            };
            if identity.api_version != claim.expected_api_version
                || identity.adapter != claim.expected_adapter
                || identity.evaluation_policy != claim.expected_evaluation_policy
                || !matches!(identity.state.as_str(), "prepared" | "evaluated")
            {
                return Verdict {
                    completed: false,
                    retryable: false,
                    evidence: "graph_harness_claim_mismatch: unsupported immutable identity".into(),
                };
            }
            if let Err(e) = validate_wave(claim, None, &identity, &wave) {
                return Verdict {
                    completed: false,
                    retryable: false,
                    evidence: e,
                };
            }
            let loaded = match host.load_bundle(&claim.state_root, &identity.bundle_ref) {
                Ok(v) => v,
                Err(e) => {
                    return Verdict {
                        completed: false,
                        retryable: false,
                        evidence: format!("graph_harness_bundle_refused: {e}"),
                    };
                }
            };
            if loaded.subject_digest != identity.subject_digest
                || loaded.transitive_digest != identity.transitive_digest
                || loaded.adapter != identity.adapter
            {
                return Verdict { completed:false, retryable:false, evidence:"graph_harness_claim_mismatch: persisted bundle identity differs from Contract".into() };
            }
            graph_digest = Some(wave.graph_digest.clone());
            prepared = Some(loaded);
            expected_identity = Some(identity);
        }
        let identity = expected_identity
            .as_ref()
            .expect("identity initialized above");
        if let Err(e) = validate_wave(claim, graph_digest.as_deref(), identity, &wave) {
            return Verdict {
                completed: false,
                retryable: false,
                evidence: e,
            };
        }
        match wave.status {
            WaveStatus::Complete => {
                let mut terminal = terminal_verdict(wave.terminal_evidence);
                if !terminal.completed {
                    return terminal;
                }
                let prepared = prepared.as_ref().expect("bundle initialized above");
                let request = json!({
                    "schema":"contract.graph-harness-attestation.issue/v1",
                    "root_id":claim.contract_id,
                    "graph_digest":graph_digest.as_deref().unwrap_or_default(),
                    "subject_digest":identity.subject_digest,
                    "transitive_digest":identity.transitive_digest,
                    "expected_witness_digest":prepared.witness_digest,
                    "expected_judge_digest":prepared.judge_digest,
                    "admitted_by":{"ref":"aiko-rust-host","digest":{"algorithm":"sha256","value":prepared.bundle_digest}}
                });
                let Some(statement) = host.issue_terminal(request).await else {
                    terminal.completed = false;
                    terminal.retryable = false;
                    terminal.evidence = "Contract issuer refused terminal GraphHarness".into();
                    return terminal;
                };
                if let Err(e) = host.authenticate_terminal(&prepared.payload, &statement) {
                    terminal.completed = false;
                    terminal.retryable = false;
                    terminal.evidence = e;
                    return terminal;
                }
                if claim.materialize_admission {
                    if let Err(e) =
                        host.materialize_terminal(&prepared.payload, &statement, &claim.state_root)
                    {
                        terminal.completed = false;
                        terminal.retryable = false;
                        terminal.evidence = e;
                        return terminal;
                    }
                }
                return terminal;
            }
            WaveStatus::Held => {
                return Verdict {
                    completed: false,
                    retryable: true,
                    evidence: "Contract held a GraphHarness child pending authority".into(),
                };
            }
            WaveStatus::Failed => {
                return Verdict {
                    completed: false,
                    retryable: false,
                    evidence: "A GraphHarness child exhausted its bounded attempts".into(),
                };
            }
            WaveStatus::Waiting => host.wait_for_wave().await,
            WaveStatus::Wave => {
                if wave.nodes.is_empty() {
                    return Verdict {
                        completed: false,
                        retryable: true,
                        evidence: "Contract returned an empty GraphHarness wave".into(),
                    };
                }
                for node in wave.nodes {
                    if !executed.insert(node.execution_id.clone()) {
                        return Verdict { completed:false,retryable:false,evidence:"graph_harness_exactly_once_refused: leased child was already executed by this host".into() };
                    }
                    let verdict = host
                        .execute_node(
                            &prepared.as_ref().expect("bundle initialized above").payload,
                            identity,
                            &node,
                        )
                        .await;
                    let now = host.now_ms();
                    let Some(decision) = host.commit_neuron(&node, &verdict, now) else {
                        return Verdict {
                            completed: false,
                            retryable: false,
                            evidence: "Aiko could not encode exact GraphHarness Neuron decision"
                                .into(),
                        };
                    };
                    let settlement = Settlement {
                        root_id: claim.contract_id.clone(),
                        root_occurrence: claim.occurrence.clone(),
                        owner: owner.clone(),
                        execution_id: node.execution_id.clone(),
                        attempt: node.attempt,
                        outcome: verdict.outcome.into(),
                        evidence: verdict.evidence,
                        detail: verdict.detail,
                        decision,
                    };
                    if !host.settle_node(settlement, now).await {
                        return Verdict { completed:false,retryable:false,evidence:"Contract rejected exact GraphHarness evidence after execution; child will not be re-run".into() };
                    }
                }
            }
        }
    }
    Verdict {
        completed: false,
        retryable: true,
        evidence: "GraphHarness exceeded bounded wave budget".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    const SUBJECT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TRANSITIVE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const CELL: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const OUTPUT: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const WITNESS: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const JUDGE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    struct NoopWake;
    impl Wake for NoopWake {
        fn wake(self: Arc<Self>) {}
    }
    fn block_on<F: Future>(future: F) -> F::Output {
        let w = Waker::from(Arc::new(NoopWake));
        let mut cx = Context::from_waker(&w);
        let mut f = Box::pin(future);
        loop {
            if let Poll::Ready(v) = Pin::new(&mut f).poll(&mut cx) {
                return v;
            }
        }
    }
    fn claim(materialize: bool) -> Claim {
        Claim {
            contract_id: "root-1".into(),
            occurrence: "occ-1".into(),
            state_root: "/tmp".into(),
            expected_api_version: "graph-harness/v0",
            expected_adapter: "contract.graph-harness/v1",
            expected_evaluation_policy: "graph-harness-eval/v0",
            materialize_admission: materialize,
        }
    }
    fn identity() -> ClaimIdentity {
        ClaimIdentity {
            api_version: "graph-harness/v0".into(),
            state: "evaluated".into(),
            subject_digest: SUBJECT.into(),
            transitive_digest: TRANSITIVE.into(),
            adapter: "contract.graph-harness/v1".into(),
            bundle_ref: format!("cas:{SUBJECT}"),
            evaluation_policy: "graph-harness-eval/v0".into(),
        }
    }
    #[derive(Clone)]
    struct TestNode {
        cell: &'static str,
        witness: &'static str,
        judge: &'static str,
    }
    struct TestPrepared;
    fn node(execution: &str, key: &str, cell: &'static str, inputs: Value) -> Node<TestNode> {
        Node {
            execution_id: execution.into(),
            attempt: 1,
            key: key.into(),
            inputs,
            payload: TestNode {
                cell,
                witness: WITNESS,
                judge: JUDGE,
            },
        }
    }
    fn wave(
        status: WaveStatus,
        nodes: Vec<Node<TestNode>>,
        terminal: Option<Value>,
    ) -> Wave<TestNode> {
        Wave {
            status,
            root_id: "root-1".into(),
            graph_digest: SUBJECT.into(),
            identity: Some(identity()),
            terminal_evidence: terminal,
            nodes,
        }
    }
    struct FakeHost {
        calls: Vec<String>,
        waves: VecDeque<Wave<TestNode>>,
        load_error: Option<String>,
        settle_ok: bool,
        settlements: Vec<Value>,
        sidecar_initialized: bool,
    }
    impl FakeHost {
        fn happy() -> Self {
            Self {
                calls: vec![],
                waves: VecDeque::from([
                    wave(
                        WaveStatus::Wave,
                        vec![node(
                            "exec-producer",
                            "produce",
                            CELL,
                            json!({"seed":"pinned-input"}),
                        )],
                        None,
                    ),
                    wave(
                        WaveStatus::Wave,
                        vec![node(
                            "exec-north-star",
                            "__graph_harness_north_star",
                            WITNESS,
                            json!({"result":{"completed":true,"retryable":false,"evidence":"producer settled"}}),
                        )],
                        None,
                    ),
                    wave(
                        WaveStatus::Complete,
                        vec![],
                        Some(
                            json!({"settlement":{"completed":true,"retryable":false,"evidence":"north-star passed"}}),
                        ),
                    ),
                ]),
                load_error: None,
                settle_ok: true,
                settlements: vec![],
                sidecar_initialized: false,
            }
        }
    }
    impl Orchestration for FakeHost {
        type NodePayload = TestNode;
        type PreparedPayload = TestPrepared;
        type Decision = Value;
        async fn claim_wave(&mut self, _: String, _: String, _: String) -> Option<Wave<TestNode>> {
            self.calls.push("claim".into());
            self.waves.pop_front()
        }
        fn load_bundle(
            &mut self,
            _: &Path,
            bundle_ref: &str,
        ) -> Result<Prepared<TestPrepared>, String> {
            self.calls.push(format!("load:{bundle_ref}"));
            if let Some(e) = self.load_error.take() {
                return Err(e);
            }
            Ok(Prepared {
                payload: TestPrepared,
                subject_digest: SUBJECT.into(),
                transitive_digest: TRANSITIVE.into(),
                adapter: "contract.graph-harness/v1".into(),
                bundle_digest: SUBJECT.into(),
                witness_digest: WITNESS.into(),
                judge_digest: JUDGE.into(),
            })
        }
        async fn execute_node(
            &mut self,
            _: &TestPrepared,
            _: &ClaimIdentity,
            node: &Node<TestNode>,
        ) -> NodeVerdict {
            if !self.sidecar_initialized {
                self.calls.push("sidecar_init".into());
                self.sidecar_initialized = true
            }
            self.calls.push(format!(
                "execute:{}:{}:{}:{}:{}",
                node.execution_id,
                node.payload.cell,
                node.payload.witness,
                node.payload.judge,
                SUBJECT
            ));
            let (inputs, outputs, sources, produced_by) = if node.key == "produce" {
                (
                    json!({"seed":"pinned-input"}),
                    json!({"producer_output":OUTPUT}),
                    json!([
                        "material:pinned-input",
                        "contract:node-producer/exec-producer"
                    ]),
                    "cell/v0:produce",
                )
            } else {
                assert_eq!(
                    node.inputs["result"]["completed"], true,
                    "north-star consumes the actual terminal settlement product"
                );
                (
                    json!({"result":{"completed":true,"retryable":false,"evidence":"producer settled"}}),
                    json!({"accepted_product_digest":OUTPUT}),
                    json!([
                        format!("artifact:{OUTPUT}"),
                        "contract:node-north-star/exec-north-star"
                    ]),
                    "aiko.graph-harness-north-star/v1",
                )
            };
            NodeVerdict {
                outcome: "satisfied",
                evidence: json!({"cell_manifest":{"schema":"cell.execution-manifest/v0","cell_digest":node.payload.cell,"bundle":SUBJECT,"inputs":inputs,"outputs":outputs,"sources":sources,"produced_by":produced_by},"neuron_firing":{"execution_id":node.execution_id,"sources":sources,"produced_by":produced_by},"witness_verdict":{"digest":node.payload.witness,"evaluator":"pinned","verdict":"pass"},"judge_verdict":{"digest":node.payload.judge,"verdict":"pass"}}),
                detail: "genuine Cell/v0-shaped evidence".into(),
            }
        }
        fn commit_neuron(&mut self, _: &Node<TestNode>, v: &NodeVerdict, _: u64) -> Option<Value> {
            self.calls.push("neuron_commit".into());
            let f = v.evidence.get("neuron_firing")?;
            f.get("sources")?.as_array()?;
            f.get("produced_by")?.as_str()?;
            Some(json!({"committed":true}))
        }
        async fn settle_node(&mut self, s: Settlement<Value>, _: u64) -> bool {
            self.calls.push("contract_settle".into());
            self.settlements.push(json!({"root_id":s.root_id,"root_occurrence":s.root_occurrence,"owner":s.owner,"execution_id":s.execution_id,"attempt":s.attempt,"outcome":s.outcome,"evidence":s.evidence,"detail":s.detail,"decision":s.decision}));
            self.settle_ok
        }
        async fn issue_terminal(&mut self, r: Value) -> Option<Value> {
            self.calls
                .push(format!("issue:{}", r["subject_digest"].as_str().unwrap()));
            Some(json!({"signed":true}))
        }
        fn authenticate_terminal(&mut self, _: &TestPrepared, _: &Value) -> Result<(), String> {
            self.calls.push("authenticate".into());
            Ok(())
        }
        fn materialize_terminal(
            &mut self,
            _: &TestPrepared,
            _: &Value,
            _: &Path,
        ) -> Result<(), String> {
            self.calls.push("materialize".into());
            Ok(())
        }
        fn now_ms(&mut self) -> u64 {
            1
        }
        async fn wait_for_wave(&mut self) {}
    }

    #[test]
    fn exact_order_pins_evidence_and_terminal_authentication() {
        block_on(async {
            let mut host = FakeHost::happy();
            let result =
                execute_graph_harness_claim_with(&mut host, "owner".into(), &claim(true)).await;
            assert!(result.completed, "{}", result.evidence);
            assert_eq!(
                host.calls,
                vec![
                    "claim".to_owned(),
                    format!("load:cas:{SUBJECT}"),
                    "sidecar_init".to_owned(),
                    format!("execute:exec-producer:{CELL}:{WITNESS}:{JUDGE}:{SUBJECT}"),
                    "neuron_commit".to_owned(),
                    "contract_settle".to_owned(),
                    "claim".to_owned(),
                    format!("execute:exec-north-star:{WITNESS}:{WITNESS}:{JUDGE}:{SUBJECT}"),
                    "neuron_commit".to_owned(),
                    "contract_settle".to_owned(),
                    "claim".to_owned(),
                    format!("issue:{SUBJECT}"),
                    "authenticate".to_owned(),
                    "materialize".to_owned()
                ]
            );
            assert_eq!(
                host.calls.iter().filter(|c| *c == "sidecar_init").count(),
                1,
                "one strict CellSidecar serves both leased edges"
            );
            for execution in ["exec-producer", "exec-north-star"] {
                assert_eq!(
                    host.calls
                        .iter()
                        .filter(|c| c.starts_with(&format!("execute:{execution}:")))
                        .count(),
                    1,
                    "each leased Cell edge executes exactly once"
                )
            }
            assert_eq!(host.settlements.len(), 2);
            for settlement in &host.settlements {
                let evidence = &settlement["evidence"];
                assert!(
                    settlement.get("decision").is_some(),
                    "exact Neuron decision was not sent to Contract"
                );
                for required in [
                    "cell_manifest",
                    "neuron_firing",
                    "witness_verdict",
                    "judge_verdict",
                ] {
                    assert!(
                        evidence.get(required).is_some(),
                        "settlement omitted {required}"
                    )
                }
                assert_eq!(evidence["cell_manifest"]["bundle"], SUBJECT);
                assert_eq!(
                    evidence["neuron_firing"]["sources"],
                    evidence["cell_manifest"]["sources"]
                );
                assert_eq!(
                    evidence["neuron_firing"]["produced_by"],
                    evidence["cell_manifest"]["produced_by"]
                )
            }
            let producer = &host.settlements[0]["evidence"];
            assert_eq!(
                producer["cell_manifest"]["schema"],
                "cell.execution-manifest/v0"
            );
            assert_eq!(producer["cell_manifest"]["cell_digest"], CELL);
            assert_eq!(
                producer["cell_manifest"]["outputs"]["producer_output"],
                OUTPUT
            );
            assert_eq!(producer["neuron_firing"]["execution_id"], "exec-producer");
            assert!(
                producer["neuron_firing"]["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s == "material:pinned-input")
            );
        });
    }
    #[test]
    fn settlement_failure_stops_all_downstream_work() {
        block_on(async {
            let mut host = FakeHost::happy();
            host.settle_ok = false;
            let result =
                execute_graph_harness_claim_with(&mut host, "owner".into(), &claim(false)).await;
            assert!(!result.completed);
            assert_eq!(host.calls.last().unwrap(), "contract_settle");
            assert!(
                !host
                    .calls
                    .iter()
                    .any(|c| c.starts_with("issue:") || c == "authenticate")
            );
        });
    }
    #[test]
    fn persisted_bundle_drift_refuses_before_executor_or_neuron() {
        block_on(async {
            let mut host = FakeHost::happy();
            host.load_error = Some("material digest mismatch".into());
            let result =
                execute_graph_harness_claim_with(&mut host, "owner".into(), &claim(false)).await;
            assert!(!result.completed);
            assert!(result.evidence.contains("material digest mismatch"));
            assert_eq!(
                host.calls,
                vec!["claim".to_owned(), format!("load:cas:{SUBJECT}")]
            );
        });
    }
    #[test]
    fn strict_branch_contains_no_replan_or_legacy_adapter_call() {
        let source = include_str!("graph_harness_orchestration.rs");
        let branch = source
            .split("pub(crate) async fn execute_graph_harness_claim_with")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "plan_bounded(",
            "expand_claim_cell_with_routes(",
            "execute_claim_node(",
        ] {
            assert!(
                !branch.contains(forbidden),
                "strict GraphHarness branch called {forbidden}"
            )
        }
    }
}
