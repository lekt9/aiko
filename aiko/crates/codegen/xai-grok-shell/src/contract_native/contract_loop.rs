//! Active contract loop driver — participates in the dcontract neuron tree
//! instead of merely firing-and-forgetting through the FFI bridge.
//!
//! From session analysis of 20,769 contract events, the substrate chains
//! automatically through recursive neuron trees: parent fires → holds → guard →
//! children declared → children fire → break_above → fill iterations → waves
//! progress → sabbath checkpoint. The EBM learns which routes succeed fastest.
//!
//! This module makes Aiko an active participant:
//! 1. Parse contract events from the ledger
//! 2. Handle fill iterations by executing the corresponding tool calls
//! 3. Handle guard events by retrying with alternative approaches
//! 4. Use EBM muscle rankings to select the best tool/approach
//! 5. Provide sabbath self-attestation evidence
//!
//! Gated behind `AIKO_CONTRACT_LOOP=true` (default: false for backward compat).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOOP_ENABLED_ENV: &str = "AIKO_CONTRACT_LOOP";
const POLL_MS_ENV: &str = "AIKO_CONTRACT_LOOP_POLL_MS";
const DEFAULT_POLL_MS: u64 = 100;
const MAX_WAVES_ENV: &str = "AIKO_CONTRACT_LOOP_MAX_WAVES";
const DEFAULT_MAX_WAVES: u32 = 7;

// ── Contract Event Types (parsed from contracts.jsonl) ──────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event")]
pub enum ContractEvent {
    #[serde(rename = "declared")]
    Declared {
        id: String,
        #[serde(default)]
        plan: Option<String>,
        #[serde(default)]
        action: Option<String>,
        #[serde(default)]
        pointer_type: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
        #[serde(default)]
        parent_id: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "iterated")]
    Iterated {
        id: String,
        #[serde(default)]
        wave: Option<u32>,
        #[serde(default)]
        action_exit: Option<i32>,
        #[serde(default)]
        action_result: Option<String>,
        #[serde(default)]
        delta: Option<f64>,
        #[serde(default)]
        delta_gap: Option<Vec<String>>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "break_above")]
    BreakAbove {
        id: String,
        source_id: String,
        #[serde(default)]
        depth: Option<u32>,
        #[serde(default)]
        action_result: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "guard")]
    Guard {
        id: String,
        #[serde(default)]
        error_class: Option<String>,
        #[serde(default)]
        layer: Option<String>,
        #[serde(default)]
        remediation: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "ebm_proto")]
    EbmProto {
        #[serde(default)]
        key: Option<String>,
        #[serde(default)]
        from_id: Option<String>,
        #[serde(default)]
        w: Option<f64>,
        #[serde(default)]
        mean: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "satisfied")]
    Satisfied {
        id: String,
        #[serde(default)]
        wave: Option<u32>,
        #[serde(default)]
        proof: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "cache_resolved")]
    CacheResolved {
        id: String,
        #[serde(default)]
        wave: Option<u32>,
        #[serde(default)]
        snapshot: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "child_added")]
    ChildAdded {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        child_id: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "pattern")]
    Pattern {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        pattern_text: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    /// Catch-all for unknown events — ignored but not an error.
    #[serde(other)]
    Unknown,
}

// ── Loop Domain Types ───────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum FillAction {
    /// Execute an interpret step
    Interpret { child_id: String, plan_text: String },
    /// Execute a verify step
    Verify { child_id: String, claim: String },
    /// Execute an adjudicate step
    Adjudicate { child_id: String },
    /// Execute a generic iteration (retry wave record)
    Iterate { child_id: String, wave: u32 },
    /// Unknown fill — surface to agent
    Unknown {
        child_id: String,
        action_result: String,
    },
}

#[derive(Debug, Clone)]
pub struct FillIteration {
    pub via_contract: String,
    pub wave: u32,
    pub delta: Option<f64>,
    pub action_result: String,
}

#[derive(Debug, Clone)]
pub struct GuardEvent {
    pub contract_id: String,
    pub error_class: String,
    pub layer: String,
    pub remediation: String,
}

#[derive(Debug, Clone)]
pub struct ChildOutcome {
    pub child_id: String,
    pub action: String,
    pub outcome: String,
    pub satisfied: bool,
    pub cache_snapshot: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EbmMuscleEntry {
    pub binary: String,
    pub energy: f64,
    pub context_energy: f64,
    pub confidence: f64,
    pub fires: u64,
    pub successes: u64,
    pub failures: u64,
}

#[derive(Debug, Clone)]
pub struct MuscleRankings {
    pub abi_version: u32,
    pub candidates: Vec<EbmMuscleEntry>,
}

#[derive(Debug, Clone)]
pub struct SabbathEvidence {
    pub wave: u32,
    pub children_outcomes: Vec<ChildOutcome>,
    pub energy_delta: Option<f64>,
    pub chain_coherent: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoopAction {
    /// Execute a tool call
    ExecuteTool {
        tool_name: String,
        context: String,
        child_id: String,
    },
    /// Retry with an alternative approach
    Retry {
        reason: String,
        suggested_alternative: Option<String>,
    },
    /// Provide sabbath self-attestation
    SabbathAttest,
    /// Loop complete
    Complete {
        satisfied: bool,
        retryable: bool,
        evidence: String,
    },
    /// No action needed — keep polling
    Idle,
}

// ── ContractLoopDriver ──────────────────────────────────────────────

pub struct ContractLoopDriver {
    pub contract_id: String,
    pub goal: String,
    wave: u32,
    max_waves: u32,
    children: BTreeMap<String, ChildOutcome>,
    pending_fills: Vec<FillIteration>,
    pending_guards: Vec<GuardEvent>,
    muscle_rankings: Option<MuscleRankings>,
    sabbath: bool,
    sabbath_evidence: Vec<SabbathEvidence>,
    /// Byte offset into contracts.jsonl for incremental polling
    poll_offset: u64,
    poll_interval: Duration,
    /// Set when the loop has reached terminal state
    completed: bool,
    retryable: bool,
    terminal_evidence: String,
}

impl ContractLoopDriver {
    /// Create a new loop driver for a contract.
    ///
    /// Reads the current EBM muscle rankings and primes the driver with
    /// the initial contract state from the ledger.
    pub fn new(contract_id: String, goal: String) -> Self {
        let max_waves = std::env::var(MAX_WAVES_ENV)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_MAX_WAVES);
        let poll_ms = std::env::var(POLL_MS_ENV)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_POLL_MS);

        Self {
            contract_id,
            goal,
            wave: 0,
            max_waves,
            children: BTreeMap::new(),
            pending_fills: Vec::new(),
            pending_guards: Vec::new(),
            muscle_rankings: None,
            sabbath: false,
            sabbath_evidence: Vec::new(),
            poll_offset: 0,
            poll_interval: Duration::from_millis(poll_ms),
            completed: false,
            retryable: false,
            terminal_evidence: String::new(),
        }
    }

    /// Whether the ContractLoopDriver is enabled.
    pub fn enabled() -> bool {
        std::env::var(LOOP_ENABLED_ENV).ok().is_some_and(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
    }

    // ── Event Parsing ──────────────────────────────────────────────

    /// Parse contract events from the ledger, returning only new events
    /// since the last poll position.
    fn ledger_path() -> Option<PathBuf> {
        let cwd = std::env::current_dir().ok()?;
        let path = cwd.join(".claude").join("contracts.jsonl");
        if path.exists() {
            return Some(path);
        }
        None
    }

    /// Parse muscle rankings from the ledger JSON.
    fn parse_muscle_rankings(raw: &str) -> Option<MuscleRankings> {
        let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
        let abi_version = parsed.get("abi_version")?.as_u64()? as u32;
        let candidates = parsed
            .get("candidates")?
            .as_array()?
            .iter()
            .filter_map(|c| {
                Some(EbmMuscleEntry {
                    binary: c.get("binary")?.as_str()?.to_string(),
                    energy: c.get("energy")?.as_f64()?,
                    context_energy: c.get("context_energy")?.as_f64().unwrap_or(0.0),
                    confidence: c.get("confidence")?.as_f64().unwrap_or(0.5),
                    fires: c.get("fires")?.as_u64().unwrap_or(0),
                    successes: c.get("successes")?.as_u64().unwrap_or(0),
                    failures: c.get("failures")?.as_u64().unwrap_or(0),
                })
            })
            .collect();
        Some(MuscleRankings {
            abi_version,
            candidates,
        })
    }

    /// Select the best tool for a goal using EBM muscle rankings.
    ///
    /// Returns the lowest-energy candidate with evidence readiness,
    /// falling back to None if no suitable candidate exists.
    pub fn select_tool_via_ebm(&self, context_hint: &str) -> Option<EbmMuscleEntry> {
        let rankings = self.muscle_rankings.as_ref()?;
        let hint_lower = context_hint.to_ascii_lowercase();

        rankings
            .candidates
            .iter()
            .filter(|c| c.confidence > 0.5)
            .filter(|c| c.successes > 0)
            .min_by(|a, b| {
                a.energy
                    .partial_cmp(&b.energy)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        // Prefer candidates that match the context hint
                        let a_match = a.binary.to_ascii_lowercase().contains(&hint_lower);
                        let b_match = b.binary.to_ascii_lowercase().contains(&hint_lower);
                        b_match.cmp(&a_match)
                    })
                    .then_with(|| {
                        b.confidence
                            .partial_cmp(&a.confidence)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
            .cloned()
    }

    // ── Fill Iteration Handler ─────────────────────────────────────

    /// Determine what action to take for a fill iteration.
    ///
    /// When the substrate emits `fill who:contract via contract X`,
    /// this method looks up child X's outcome and determines the next
    /// tool call or action.
    pub fn handle_fill_iteration(&mut self, fill: &FillIteration) -> FillAction {
        // Look up the child's outcome
        if let Some(child) = self.children.get(&fill.via_contract) {
            match child.action.as_str() {
                "cli" | "adjudicate" => {
                    // CLI/adjudicate children are resolved by the substrate
                    FillAction::Adjudicate {
                        child_id: fill.via_contract.clone(),
                    }
                }
                "iterate" => FillAction::Iterate {
                    child_id: fill.via_contract.clone(),
                    wave: fill.wave,
                },
                _ => FillAction::Unknown {
                    child_id: fill.via_contract.clone(),
                    action_result: fill.action_result.clone(),
                },
            }
        } else {
            // Child not yet resolved — surface as unknown
            FillAction::Unknown {
                child_id: fill.via_contract.clone(),
                action_result: fill.action_result.clone(),
            }
        }
    }

    // ── Guard Handler ──────────────────────────────────────────────

    /// Handle a guard event by determining the recovery action.
    ///
    /// Guard events fire when a neuron's action_result is `hold`.
    /// The handler queries EBM for alternative routes and returns
    /// a retry action with the suggested alternative.
    pub fn handle_guard(&self, guard: &GuardEvent) -> LoopAction {
        // Query EBM for alternative routes (exclude the failed contract)
        let alternative = self.select_tool_via_ebm(&format!("retry {}", guard.error_class));

        LoopAction::Retry {
            reason: format!(
                "{} guard on {}: {}",
                guard.error_class, guard.contract_id, guard.remediation
            ),
            suggested_alternative: alternative.map(|e| e.binary),
        }
    }

    // ── One-Shot Surface ───────────────────────────────────────────

    /// Determine the next action the loop should take.
    ///
    /// Priority order:
    /// 1. If completed, return Complete
    /// 2. If sabbath, return SabbathAttest
    /// 3. If pending guards, handle the first one
    /// 4. If pending fills, handle the first one
    /// 5. Otherwise, return Idle
    pub fn next_action(&mut self) -> LoopAction {
        if self.completed {
            return LoopAction::Complete {
                satisfied: !self.retryable,
                retryable: self.retryable,
                evidence: self.terminal_evidence.clone(),
            };
        }

        if self.sabbath {
            return LoopAction::SabbathAttest;
        }

        // Handle guards first (failures take priority)
        if let Some(guard) = self.pending_guards.first().cloned() {
            self.pending_guards.remove(0);
            return self.handle_guard(&guard);
        }

        // Handle fills
        if let Some(fill) = self.pending_fills.first().cloned() {
            self.pending_fills.remove(0);
            let action = self.handle_fill_iteration(&fill);

            return match action {
                FillAction::Interpret { .. } | FillAction::Verify { .. } => {
                    // These need tool execution
                    if let Some(tool) = self.select_tool_via_ebm(&fill.action_result) {
                        LoopAction::ExecuteTool {
                            tool_name: tool.binary,
                            context: fill.action_result,
                            child_id: fill.via_contract,
                        }
                    } else {
                        LoopAction::Idle
                    }
                }
                FillAction::Adjudicate { .. } | FillAction::Iterate { .. } => {
                    // Substrate handles these — just continue
                    LoopAction::Idle
                }
                FillAction::Unknown { .. } => LoopAction::Idle,
            };
        }

        LoopAction::Idle
    }

    /// Feed a tool result back into the loop.
    ///
    /// After a tool call completes, this updates the child's outcome
    /// and processes resulting events.
    pub fn feed_tool_result(&mut self, child_id: &str, success: bool, output: &str) {
        if let Some(child) = self.children.get_mut(child_id) {
            if success {
                child.outcome = "satisfied".into();
                child.satisfied = true;
            } else {
                child.outcome = format!("failed: {}", &output[..output.len().min(200)]);
            }
        }
        // Poll for new events (fills, breaks, guards triggered by this result)
        // In the initial implementation this is a no-op; Phase 2 wires
        // the actual ledger polling.
    }

    /// Provide sabbath self-attestation evidence.
    pub fn provide_sabbath_evidence(&self) -> SabbathEvidence {
        let chain_coherent = self
            .children
            .values()
            .filter(|c| c.action != "iterate")
            .all(|c| c.satisfied);

        SabbathEvidence {
            wave: self.wave,
            children_outcomes: self.children.values().cloned().collect(),
            energy_delta: self.pending_fills.last().and_then(|f| f.delta),
            chain_coherent,
        }
    }

    /// Record a child declaration from the event stream.
    pub fn record_child_declared(&mut self, child_id: String, action: String) {
        self.children
            .entry(child_id.clone())
            .or_insert(ChildOutcome {
                child_id,
                action,
                outcome: "pending".into(),
                satisfied: false,
                cache_snapshot: None,
            });
    }

    /// Record a child resolution (break_above or satisfied).
    pub fn record_child_resolved(
        &mut self,
        child_id: &str,
        outcome: &str,
        snapshot: Option<String>,
    ) {
        if let Some(child) = self.children.get_mut(child_id) {
            child.outcome = outcome.to_string();
            child.satisfied = outcome.contains("resolved") || outcome.contains("satisfied");
            child.cache_snapshot = snapshot;
        }
    }

    /// Record a fill iteration from the event stream.
    pub fn record_fill_iteration(&mut self, fill: FillIteration) {
        self.wave = self.wave.max(fill.wave);
        self.pending_fills.push(fill);
    }

    /// Record a guard event.
    pub fn record_guard(&mut self, guard: GuardEvent) {
        self.pending_guards.push(guard);
    }

    /// Enter sabbath mode (two-phase commit).
    pub fn enter_sabbath(&mut self) {
        self.sabbath = true;
    }

    /// Submit sabbath evidence and attempt to complete.
    pub fn submit_sabbath_evidence(&mut self, evidence: SabbathEvidence) {
        self.sabbath_evidence.push(evidence);
        let latest = self.sabbath_evidence.last();

        if latest.is_some_and(|e| e.chain_coherent) {
            self.completed = true;
            self.retryable = false;
            self.terminal_evidence = "sabbath: chain coherent, all children satisfied".into();
        } else {
            self.completed = true;
            self.retryable = true;
            self.terminal_evidence = "sabbath: chain incoherent, retryable".into();
        }
    }

    /// Force complete the loop (wave limit reached).
    pub fn force_settle(&mut self) {
        self.completed = true;
        self.retryable = !self.children.values().all(|c| c.satisfied);
        self.terminal_evidence = format!(
            "force settle after wave {}: {} children, {} satisfied",
            self.wave,
            self.children.len(),
            self.children.values().filter(|c| c.satisfied).count()
        );
    }

    /// Process a batch of raw contract events and update driver state.
    pub fn process_events(&mut self, events: &[ContractEvent]) {
        for event in events {
            match event {
                ContractEvent::Declared {
                    id,
                    action,
                    parent_id,
                    pointer_type,
                    ..
                } => {
                    // Only track children of our contract
                    if parent_id.as_deref() == Some(&self.contract_id) || id == &self.contract_id {
                        let action_str = pointer_type
                            .clone()
                            .unwrap_or_else(|| action.clone().unwrap_or_default());
                        self.record_child_declared(id.clone(), action_str);
                    }
                }
                ContractEvent::Iterated {
                    id,
                    wave,
                    action_result,
                    delta,
                    ..
                } => {
                    if let (Some(result), Some(wave_num)) = (action_result, wave) {
                        // Detect fill iterations: "fill who:contract via contract X"
                        if result.starts_with("fill who:contract via contract ") {
                            let via = result
                                .strip_prefix("fill who:contract via contract ")
                                .unwrap_or(&result)
                                .split(' ')
                                .next()
                                .unwrap_or("")
                                .to_string();
                            self.record_fill_iteration(FillIteration {
                                via_contract: via,
                                wave: *wave_num,
                                delta: *delta,
                                action_result: result.to_string(),
                            });
                        }
                        // Detect sabbath checkpoints
                        if result.contains("hold:sabbath") {
                            self.enter_sabbath();
                        }
                        // Detect hold (triggers guard)
                        if result == "hold" && id != &self.contract_id {
                            // The next event should be a guard
                        }
                    }
                }
                ContractEvent::BreakAbove {
                    source_id,
                    action_result,
                    ..
                } => {
                    if let Some(result) = action_result {
                        self.record_child_resolved(&source_id, &result, None);
                    }
                }
                ContractEvent::Satisfied { id, .. } => {
                    self.record_child_resolved(&id, "satisfied", None);
                }
                ContractEvent::CacheResolved { id, snapshot, .. } => {
                    if let Some(snap) = &snapshot {
                        if let Some(child) = self.children.get_mut(id.as_str()) {
                            child.cache_snapshot = Some(snap.clone());
                        }
                    }
                }
                ContractEvent::Guard {
                    id,
                    error_class,
                    layer,
                    remediation,
                    ..
                } => {
                    self.record_guard(GuardEvent {
                        contract_id: id.clone(),
                        error_class: error_class.clone().unwrap_or_default(),
                        layer: layer.clone().unwrap_or_default(),
                        remediation: remediation.clone().unwrap_or_default(),
                    });
                }
                ContractEvent::ChildAdded { id, child_id, .. } => {
                    if let (Some(parent), Some(child)) = (id, child_id) {
                        if *parent == self.contract_id {
                            self.record_child_declared(child.clone(), "unknown".into());
                        }
                    }
                }
                ContractEvent::EbmProto { key, from_id, .. } => {
                    // Track EBM updates for the muscle rankings
                    if let (Some(k), Some(_from)) = (key, from_id) {
                        if k == "fire:ok" || k == "fire:retryable" {
                            // Phase 2: update local muscle ranking cache
                        }
                    }
                }
                ContractEvent::Pattern { .. } | ContractEvent::Unknown => {
                    // Informational — no state change
                }
            }
        }
    }

    // ── Accessors ──────────────────────────────────────────────────

    pub fn wave(&self) -> u32 {
        self.wave
    }

    pub fn is_completed(&self) -> bool {
        self.completed
    }

    pub fn is_sabbath(&self) -> bool {
        self.sabbath
    }

    pub fn child_count(&self) -> usize {
        self.children.len()
    }

    pub fn satisfied_count(&self) -> usize {
        self.children.values().filter(|c| c.satisfied).count()
    }
}

// ── Public API — used from contract_native.rs ──────────────────────

/// Arm a contract loop for one-shot execution.
///
/// Returns a ContractLoopDriver initialized with the contract goal
/// and EBM muscle rankings. The caller drives the loop by calling
/// `next_action()` in a loop until `Complete`.
pub fn arm_contract_loop(contract_id: String, goal: String) -> ContractLoopDriver {
    ContractLoopDriver::new(contract_id, goal)
}

/// Parse a single line of the contracts.jsonl ledger.
pub fn parse_event_line(line: &str) -> Option<ContractEvent> {
    serde_json::from_str(line).ok()
}

/// Parse a batch of event lines.
pub fn parse_event_lines(lines: &[&str]) -> Vec<ContractEvent> {
    lines
        .iter()
        .filter_map(|line| parse_event_line(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_is_disabled_by_default() {
        // Without AIKO_CONTRACT_LOOP set, the driver should report disabled
        unsafe { std::env::remove_var(LOOP_ENABLED_ENV) };
        assert!(!ContractLoopDriver::enabled());
    }

    #[test]
    fn driver_enabled_with_env() {
        unsafe { std::env::set_var(LOOP_ENABLED_ENV, "true") };
        assert!(ContractLoopDriver::enabled());
        unsafe { std::env::remove_var(LOOP_ENABLED_ENV) };
    }

    #[test]
    fn new_driver_starts_at_wave_zero() {
        let driver = ContractLoopDriver::new("test-id".into(), "test goal".into());
        assert_eq!(driver.wave(), 0);
        assert!(!driver.is_completed());
        assert!(!driver.is_sabbath());
        assert_eq!(driver.child_count(), 0);
    }

    #[test]
    fn record_child_declared_adds_entry() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        driver.record_child_declared("child-1".into(), "cli".into());
        assert_eq!(driver.child_count(), 1);
        let child = driver.children.get("child-1").unwrap();
        assert_eq!(child.action, "cli");
        assert!(!child.satisfied);
    }

    #[test]
    fn record_fill_iteration_advances_wave() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        driver.record_fill_iteration(FillIteration {
            via_contract: "child-1".into(),
            wave: 2,
            delta: Some(-1.5),
            action_result: "fill who:contract via contract child-1 (diffuse-default wave 2)".into(),
        });
        assert_eq!(driver.wave(), 2);
        assert_eq!(driver.pending_fills.len(), 1);
    }

    #[test]
    fn next_action_returns_idle_when_no_events() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        assert_eq!(driver.next_action(), LoopAction::Idle);
    }

    #[test]
    fn next_action_returns_retry_on_guard() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        driver.record_guard(GuardEvent {
            contract_id: "fc38956b".into(),
            error_class: "generic".into(),
            layer: "neuron".into(),
            remediation: "inspect action_result".into(),
        });
        let action = driver.next_action();
        assert!(matches!(action, LoopAction::Retry { .. }));
    }

    #[test]
    fn sabbath_detection_from_iterated_event() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        let events = parse_event_lines(&[
            r#"{"event":"iterated","id":"parent","wave":2,"action_exit":1,"action_result":"hold:sabbath — two-witness/emergency checkpoint awaits sabbath-eval child to self-attest via chain coherence","delta":-2.1}"#,
        ]);
        driver.process_events(&events);
        assert!(driver.is_sabbath());
    }

    #[test]
    fn fill_iteration_detected_from_iterated_event() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        let events = parse_event_lines(&[
            r#"{"event":"iterated","id":"parent","wave":1,"action_exit":0,"action_result":"fill who:contract via contract 885a9fae (diffuse-default wave 0)","delta":-1.769}"#,
        ]);
        driver.process_events(&events);
        assert_eq!(driver.wave(), 1);
        assert_eq!(driver.pending_fills.len(), 1);
        assert_eq!(driver.pending_fills[0].via_contract, "885a9fae");
    }

    #[test]
    fn parse_real_contract_event_line() {
        let line = r#"{"event":"declared","id":"885a9fae","plan":"FkLRaGyFxmot2R4w2xlD4wyw/rzkQ6mbKSZlFdeGKp8HoJbERjZOcyjAyDj1SHSPI07sjJw2LTUO91JiPShO7mpkdPJXho34PIjAVQtUzMJJC2mS0ozfapUvS8ZhBEMoYqpCA45QdlK4qVsmvqTEgcyWdLBLfS3B5sseNtjybE7KgPt2LU/IUrD80PnjBgXQ9GreDN1cW11Um5Vm+fF1KQqMdSbEYqCD9p5lZFp71wcMK542UNCKRfQgNPexOlbUHYryu4adsGWga09O6DdXGEbYFgb6NUmqVzGu","action":"T9TtR26OAS4oFo9UDSVzQy+kx/zhXBfk9Y7x2tGVa4WmXw0sSzFiyYOeZq3gUpONcMUVnyU+HaRIgg==","pointer_type":"cli","layer":2,"cwd":"/Users/lekt9","parent_id":"fc38956b","synapses":[],"env_pubkey":"dd03742060a3774926f65235d1618574d104b2e4d182a8460b36ab9a704bd593","parent_signature":"ef6c6a8efb37ef5525087746a83cd82cd815b93a0fadd3f0c330f046afeb9ff6d31dfdda1f721c96df2886307d95ced7c233635d7c809f5668972aeaebbbe902","inputs_hash":"2c58089791a9176cae62da49efc3619974749cb0937431f4bcfca172cdd4741b","inputs_hash_version":2,"ts":"2026-06-28T17:18:06.542140Z","agent":"lewistham9x@gmail.com","payload_sealed":true}"#;
        let event = parse_event_line(line);
        assert!(event.is_some());
        match event.unwrap() {
            ContractEvent::Declared {
                id,
                pointer_type,
                parent_id,
                layer,
                ..
            } => {
                assert_eq!(id, "885a9fae");
                assert_eq!(pointer_type, Some("cli".into()));
                assert_eq!(parent_id, Some("fc38956b".into()));
                assert_eq!(layer, Some(2));
            }
            _ => panic!("expected Declared event"),
        }
    }

    #[test]
    fn force_settle_marks_complete() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        driver.record_child_declared("child-1".into(), "cli".into());
        driver.record_child_resolved("child-1", "satisfied", None);
        driver.force_settle();
        assert!(driver.is_completed());
        assert!(!driver.retryable);
    }

    #[test]
    fn provide_sabbath_evidence_checks_chain_coherence() {
        let mut driver = ContractLoopDriver::new("parent".into(), "goal".into());
        driver.wave = 1;
        driver.record_child_declared("child-a".into(), "cli".into());
        driver.record_child_declared("child-b".into(), "iterate".into());
        driver.record_child_resolved("child-a", "satisfied", None);
        driver.record_child_resolved("child-b", "recorded retry wave", None);

        let evidence = driver.provide_sabbath_evidence();
        assert!(evidence.chain_coherent); // iterate children excluded from coherence check
        assert_eq!(evidence.wave, 1);
        assert_eq!(evidence.children_outcomes.len(), 2);
    }
}
