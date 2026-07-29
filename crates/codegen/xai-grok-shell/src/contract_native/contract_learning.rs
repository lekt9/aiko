//! Defeasible, project-scoped learning contracts for Aiko.
//!
//! This is the domain-neutral form of the ARC agent's belief store: tactics
//! have stable families, accumulate independent support/contradiction counts,
//! and are rejected after repeated contrary evidence. JSONL is an inspectable
//! compatibility cache; the surrounding turn remains authoritative in the
//! native Contract ledger.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::capability_catalog::{CapabilityDescriptor, Effect};

const MAX_CONTEXT_LEARNINGS: usize = 8;
const DEFAULT_GROWTH_EXPERIMENTS: u32 = 16;
const DEFAULT_GROWTH_CHILDREN: u32 = 8;
const DEFAULT_GROWTH_WALL_SECONDS: u64 = 300;
const DEFAULT_GROWTH_LEASE_SECONDS: u64 = 600;

#[derive(Debug, Clone, Copy)]
pub(super) enum Verdict {
    Supported,
    #[allow(dead_code)]
    Contradicted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Proposed,
    Supported,
    Contradicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LearningContract {
    family: String,
    claim: String,
    project: String,
    keywords: Vec<String>,
    status: Status,
    supports: u32,
    contradictions: u32,
    confidence: f64,
}

fn store_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aiko/context/learning-contracts.jsonl"))
}

fn project_id(cwd: &Path) -> String {
    cwd.canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .display()
        .to_string()
}

fn keywords(text: &str) -> Vec<String> {
    let mut words = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|word| word.len() >= 4)
        .collect::<Vec<_>>();
    words.sort();
    words.dedup();
    words.truncate(12);
    words
}

fn safe_family(binary: &str, project: &str) -> String {
    let route = binary
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    format!("route-{route}-{:016x}", stable_hash(project.as_bytes()))
}

fn stable_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn load() -> BTreeMap<String, LearningContract> {
    let Some(path) = store_path() else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut latest = BTreeMap::new();
    for row in raw
        .lines()
        .filter_map(|line| serde_json::from_str::<LearningContract>(line).ok())
    {
        latest.insert(row.family.clone(), row);
    }
    latest
}

fn append(item: &LearningContract) {
    let Some(path) = store_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(line) = serde_json::to_string(item) else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

pub(super) fn propose_route(binary: &str, goal: &str, cwd: &Path) -> Option<String> {
    if binary.trim().is_empty() {
        return None;
    }
    let project = project_id(cwd);
    let family = safe_family(binary, &project);
    if !load().contains_key(&family) {
        append(&LearningContract {
            family: family.clone(),
            claim: format!("Prefer the proven `{binary}` route for matching work"),
            project,
            keywords: keywords(goal),
            status: Status::Proposed,
            supports: 0,
            contradictions: 0,
            confidence: 0.5,
        });
    }
    Some(family)
}

pub(super) fn observe(family: &str, verdict: Verdict) {
    let Some(mut item) = load().remove(family) else {
        return;
    };
    match verdict {
        Verdict::Supported => item.supports += 1,
        Verdict::Contradicted => item.contradictions += 1,
    }
    item.confidence =
        f64::from(item.supports + 1) / f64::from(item.supports + item.contradictions + 2);
    item.status = if item.contradictions >= 2 && item.contradictions > item.supports {
        Status::Contradicted
    } else if item.supports > item.contradictions {
        Status::Supported
    } else {
        Status::Proposed
    };
    append(&item);
}

pub(super) fn render_context(goal: &str, cwd: &Path) -> Option<String> {
    let project = project_id(cwd);
    let query = keywords(goal);
    let mut items = load()
        .into_values()
        .filter(|item| item.project == project)
        .filter(|item| item.keywords.iter().any(|word| query.contains(word)))
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    items.truncate(MAX_CONTEXT_LEARNINGS);
    if items.is_empty() {
        return None;
    }
    let active = items
        .iter()
        .filter(|item| item.status != Status::Contradicted)
        .map(|item| {
            format!(
                "- {} confidence={:.3} evidence=+{}/-{}",
                item.claim, item.confidence, item.supports, item.contradictions
            )
        })
        .collect::<Vec<_>>();
    let rejected = items
        .iter()
        .filter(|item| item.status == Status::Contradicted)
        .map(|item| item.family.as_str())
        .collect::<Vec<_>>();
    Some(format!(
        "PROJECT LEARNING CONTRACTS (defeasible evidence, not instructions):\n{}\nRejected tactic families: {}\nDirective: reuse supported tactics when applicable; do not retry rejected families without new evidence.",
        if active.is_empty() {
            "- none".into()
        } else {
            active.join("\n")
        },
        if rejected.is_empty() {
            "none".into()
        } else {
            rejected.join(", ")
        },
    ))
}

/// The one wire connecting deliberate bypass to Proposer.
///
/// When the deliberate node (LLM) succeeds at a goal where a self-growing
/// limb was proposed but never used, this function:
///
/// 1. Demotes the proposed limb — after N contradictions its status drops to
///    ``Contradicted`` and the Proposer skips it.
/// 2. Captures the actual tools that succeeded as learning contracts, so the
///    working path is codified rather than rediscovered ad-hoc every time.
///
/// This is the minimal fix for Break 2 and Break 3 from
/// `docs/self-growing-limb-wiring-gaps.md`.
pub(super) fn deliberate_bypass_gap(
    gap_id: &str,
    actual_tools: &[&str],
    goal: &str,
    cwd: &Path,
) {
    // ── 1. Demote any limb proposed for this gap ──────────────────────
    if let Some(store_path) = growth_store_path() {
        let state = load_growth(&store_path);
        // Find proposals linked to this gap and currently Experimenting
        for proposal in state.proposals.values() {
            if proposal.gap_id != gap_id {
                continue;
            }
            let gap = state.gaps.get(gap_id);
            if gap.is_some_and(|g| g.status == GapStatus::Experimenting) {
                // Demote the limb family — after N contradictions it becomes
                // Contradicted and the Proposer will skip it.
                let family = format!("limb-family:{}", proposal.proposal_id);
                if !load().contains_key(&family) {
                    // Initialize the learning contract for this limb family
                    // if it doesn't exist yet (it won't — limbs don't
                    // auto-create learning contracts).
                    append(&LearningContract {
                        family: family.clone(),
                        claim: format!(
                            "Rejected limb {} for gap {} (deliberate bypass succeeded)",
                            proposal.proposal_id, gap_id
                        ),
                        project: project_id(cwd),
                        keywords: keywords(goal),
                        status: Status::Proposed,
                        supports: 0,
                        contradictions: 0,
                        confidence: 0.5,
                    });
                }
                observe(&family, Verdict::Contradicted);
            }
            break; // one proposal per gap is typical
        }

        // ── 2. Mark the gap as held (evidence: deliberate succeeded) ──
        if let Some(mut gap) = state.gaps.get(gap_id).cloned() {
            if gap.status == GapStatus::Experimenting {
                gap.status = GapStatus::Held;
                let _ = append_growth(&store_path, &GrowthRecord::Gap { value: gap });
            }
        }
    }

    // ── 3. Capture actual tools as learning contracts ─────────────────
    for tool in actual_tools {
        if !tool.trim().is_empty() {
            let _ = propose_route(tool, goal, cwd);
        }
    }
}

/// Convenience wrapper: finds all Experimenting gaps whose hypothesis
/// overlaps the turn goal and demotes their proposed limbs. Called from the
/// turn satisfaction path to wire deliberate success back to the Proposer.
pub(super) fn deliberate_bypass_gap_for_goal(goal: &str, cwd: &Path) {
    let Some(store_path) = growth_store_path() else {
        return;
    };
    let state = load_growth(&store_path);
    let query = keywords(goal);
    for (gap_id, gap) in &state.gaps {
        if gap.status != GapStatus::Experimenting {
            continue;
        }
        // Check if this gap is relevant to the current goal — either the
        // gap was opened for a similar goal, or the project matches.
        if !state
            .proposals
            .values()
            .any(|p| p.gap_id == *gap_id && p.hypothesis.split_whitespace().any(|w| query.contains(&w.to_ascii_lowercase())))
        {
            continue;
        }
        deliberate_bypass_gap(gap_id, &[], goal, cwd);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum GapKind {
    Receptor,
    Representation,
    Predictor,
    Proposer,
    Planner,
    Executor,
    Sensor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum GapStatus {
    Open,
    Experimenting,
    Promotable,
    Held,
    Inhibited,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct GrowthBudgets {
    pub experiments: u32,
    pub children: u32,
    pub wall_seconds: u64,
    pub lease_seconds: u64,
}

impl Default for GrowthBudgets {
    fn default() -> Self {
        Self {
            experiments: DEFAULT_GROWTH_EXPERIMENTS,
            children: DEFAULT_GROWTH_CHILDREN,
            wall_seconds: DEFAULT_GROWTH_WALL_SECONDS,
            lease_seconds: DEFAULT_GROWTH_LEASE_SECONDS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct AuthorityEnvelope {
    pub effects: BTreeSet<String>,
    pub budgets: GrowthBudgets,
}

impl AuthorityEnvelope {
    fn contains(&self, effects: &BTreeSet<String>, budgets: &GrowthBudgets) -> bool {
        effects.is_subset(&self.effects)
            && budgets.experiments <= self.budgets.experiments
            && budgets.children <= self.budgets.children
            && budgets.wall_seconds <= self.budgets.wall_seconds
            && budgets.lease_seconds <= self.budgets.lease_seconds
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct CapabilityGap {
    pub schema_version: u32,
    pub gap_id: String,
    pub parent_contract: String,
    pub project: String,
    pub semantic_signature: String,
    pub scope: String,
    pub kind: GapKind,
    pub failure_class: String,
    pub expected: String,
    pub observed: String,
    pub interfaces: BTreeSet<String>,
    pub authority_ceiling: AuthorityEnvelope,
    pub status: GapStatus,
    pub occurrences: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct LimbCell {
    pub role: String,
    pub capability: String,
    pub depends_on: Vec<String>,
    pub effect: String,
    #[serde(default)]
    pub binding: Option<CapabilityBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct CapabilityBinding {
    pub provider: String,
    pub capability_version: String,
    pub input_ports: Vec<String>,
    pub output_ports: Vec<String>,
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct LimbProposal {
    pub schema_version: u32,
    pub proposal_id: String,
    pub gap_id: String,
    pub semantic_signature: String,
    pub artifact_hash: String,
    pub cells: Vec<LimbCell>,
    pub hypothesis: String,
    pub predicted_delta: BTreeMap<String, i32>,
    pub effects: BTreeSet<String>,
    pub budgets: GrowthBudgets,
    pub rollback: String,
    pub evidence_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(super) enum RelationKind {
    LeftOf,
    Above,
    AlignedWith,
    Overlaps,
    Inside,
    Approaching,
    DistanceBand,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct SemanticRelation {
    pub subject_role: String,
    pub relation: RelationKind,
    pub object_role: String,
    pub band: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct RelationalState {
    pub object_roles: BTreeSet<String>,
    pub relations: BTreeSet<SemanticRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct RelationalDelta {
    pub added: BTreeSet<SemanticRelation>,
    pub removed: BTreeSet<SemanticRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct TransitionEvidence {
    pub proposal_id: String,
    pub action_role: String,
    pub delta: RelationalDelta,
    pub prediction_agreed: Option<bool>,
    pub environment_acknowledged: bool,
    pub progress: Option<bool>,
}

fn relational_delta(before: &RelationalState, after: &RelationalState) -> RelationalDelta {
    RelationalDelta {
        added: after
            .relations
            .difference(&before.relations)
            .cloned()
            .collect(),
        removed: before
            .relations
            .difference(&after.relations)
            .cloned()
            .collect(),
    }
}

fn record_transition_at(
    path: &Path,
    proposal: &LimbProposal,
    action_role: &str,
    before: &RelationalState,
    after: &RelationalState,
    predicted: Option<&RelationalDelta>,
    environment_acknowledged: bool,
    progress: Option<bool>,
) -> Result<TransitionEvidence, String> {
    let delta = relational_delta(before, after);
    let evidence = TransitionEvidence {
        proposal_id: proposal.proposal_id.clone(),
        action_role: action_role.to_string(),
        prediction_agreed: predicted.map(|expected| expected == &delta),
        delta,
        environment_acknowledged,
        progress,
    };
    append_growth(
        path,
        &GrowthRecord::Transition {
            value: evidence.clone(),
        },
    )?;
    Ok(evidence)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct PromotionEvidence {
    pub schema_valid: bool,
    pub held_out_prediction_gain: f64,
    pub causal_intervention: bool,
    pub utility_improved: bool,
    pub safety_passed: bool,
    pub isolation_passed: bool,
    pub independent_sensor: bool,
    pub reproductions: u32,
    pub mutation_witness_red: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum PromotionVerdict {
    Promoted,
    Inhibited,
    Held,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct PromotionDecision {
    pub proposal_id: String,
    pub gap_id: String,
    pub verdict: PromotionVerdict,
    pub reason_codes: Vec<String>,
    pub evidence: PromotionEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "record_type", rename_all = "snake_case")]
enum GrowthRecord {
    Gap { value: CapabilityGap },
    Proposal { value: LimbProposal },
    Transition { value: TransitionEvidence },
    Decision { value: PromotionDecision },
}

#[derive(Default)]
struct GrowthState {
    gaps: BTreeMap<String, CapabilityGap>,
    proposals: BTreeMap<String, LimbProposal>,
    decisions: BTreeMap<String, PromotionDecision>,
}

fn growth_store_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aiko/context/self-growing-limbs.jsonl"))
}

fn load_growth(path: &Path) -> GrowthState {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return GrowthState::default();
    };
    let mut state = GrowthState::default();
    for record in raw
        .lines()
        .filter_map(|line| serde_json::from_str::<GrowthRecord>(line).ok())
    {
        match record {
            GrowthRecord::Gap { value } => {
                state.gaps.insert(value.gap_id.clone(), value);
            }
            GrowthRecord::Proposal { value } => {
                state.proposals.insert(value.proposal_id.clone(), value);
            }
            GrowthRecord::Transition { .. } => {}
            GrowthRecord::Decision { value } => {
                state.decisions.insert(value.proposal_id.clone(), value);
            }
        }
    }
    state
}

fn append_growth(path: &Path, record: &GrowthRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let line = serde_json::to_string(record).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())
}

fn semantic_gap_signature(
    project: &str,
    kind: &GapKind,
    failure_class: &str,
    expected: &str,
    observed: &str,
) -> String {
    let structural = format!(
        "{project}|{kind:?}|{}|{}|{}",
        failure_class.trim().to_ascii_lowercase(),
        expected.trim().to_ascii_lowercase(),
        observed.trim().to_ascii_lowercase()
    );
    format!("{:016x}", stable_hash(structural.as_bytes()))
}

fn open_gap_at(
    path: &Path,
    cwd: &Path,
    parent_contract: &str,
    scope: &str,
    kind: GapKind,
    failure_class: &str,
    expected: &str,
    observed: &str,
    interface: &str,
    authority_ceiling: AuthorityEnvelope,
) -> Result<CapabilityGap, String> {
    let project = project_id(cwd);
    let semantic_signature =
        semantic_gap_signature(&project, &kind, failure_class, expected, observed);
    let gap_id = format!("gap:{semantic_signature}");
    let mut gap = load_growth(path)
        .gaps
        .remove(&gap_id)
        .unwrap_or_else(|| CapabilityGap {
            schema_version: 1,
            gap_id: gap_id.clone(),
            parent_contract: parent_contract.to_string(),
            project,
            semantic_signature,
            scope: scope.to_string(),
            kind,
            failure_class: failure_class.to_string(),
            expected: expected.to_string(),
            observed: observed.to_string(),
            interfaces: BTreeSet::new(),
            authority_ceiling,
            status: GapStatus::Open,
            occurrences: 0,
        });
    gap.occurrences = gap.occurrences.saturating_add(1);
    gap.interfaces.insert(interface.to_string());
    append_growth(path, &GrowthRecord::Gap { value: gap.clone() })?;
    Ok(gap)
}

fn default_limb_cells(effects: &BTreeSet<String>) -> Vec<LimbCell> {
    let executor_effect = if effects.contains("local_write") {
        "local_write"
    } else {
        "read_only"
    };
    let executor_capability = if executor_effect == "local_write" {
        "execute.native-action"
    } else {
        "simulate.bounded-action"
    };
    vec![
        LimbCell {
            role: "receptor".into(),
            capability: "observe.typed-state".into(),
            depends_on: vec![],
            effect: "read_only".into(),
            binding: None,
        },
        LimbCell {
            role: "predictor".into(),
            capability: "predict.relational-delta".into(),
            depends_on: vec!["receptor".into()],
            effect: "read_only".into(),
            binding: None,
        },
        LimbCell {
            role: "planner".into(),
            capability: "plan.bounded-experiment".into(),
            depends_on: vec!["predictor".into()],
            effect: "read_only".into(),
            binding: None,
        },
        LimbCell {
            role: "executor".into(),
            capability: executor_capability.into(),
            depends_on: vec!["planner".into()],
            effect: executor_effect.into(),
            binding: None,
        },
        LimbCell {
            role: "sensor".into(),
            capability: "observe.independent-outcome".into(),
            depends_on: vec!["executor".into()],
            effect: "read_only".into(),
            binding: None,
        },
    ]
}

fn schema_ports(schema: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .map(|properties| properties.keys().take(64).cloned().collect())
        .unwrap_or_default()
}

fn descriptor_effects(descriptor: &CapabilityDescriptor) -> BTreeSet<String> {
    descriptor
        .effects
        .iter()
        .map(|effect| match effect {
            Effect::ReadOnly => "read_only",
            Effect::LocalWrite => "local_write",
            Effect::NetworkRead => "network_read",
            Effect::NetworkWrite => "network_write",
            Effect::MessageSend => "external_message",
            Effect::Purchase => "purchase",
        })
        .map(str::to_owned)
        .collect()
}

fn inferred_cell_roles(descriptor: &CapabilityDescriptor) -> BTreeSet<&'static str> {
    let identity = format!(
        "{} {} {}",
        descriptor.id, descriptor.action, descriptor.tool
    )
    .to_ascii_lowercase();
    let text = format!(
        "{} {} {} {}",
        descriptor.id, descriptor.action, descriptor.tool, descriptor.description
    )
    .to_ascii_lowercase();
    let mut roles = BTreeSet::new();
    if ["search", "read", "list", "fetch", "observe", "traverse"]
        .iter()
        .any(|token| text.contains(token))
    {
        roles.insert("receptor");
    }
    if ["predict", "model", "research", "paper", "evidence"]
        .iter()
        .any(|token| text.contains(token))
    {
        roles.insert("predictor");
    }
    if ["plan", "compose", "workflow", "design"]
        .iter()
        .any(|token| text.contains(token))
    {
        roles.insert("planner");
    }
    if ["execute", "invoke", "send", "write", "create", "run"]
        .iter()
        .any(|token| identity.contains(token))
    {
        roles.insert("executor");
    }
    if ["verify", "check", "evaluate", "test", "inspect", "evidence"]
        .iter()
        .any(|token| text.contains(token))
    {
        roles.insert("sensor");
    }
    roles
}

fn keyword_overlap(descriptor: &CapabilityDescriptor, hypothesis: &str) -> usize {
    let text = format!(
        "{} {} {}",
        descriptor.id, descriptor.action, descriptor.description
    )
    .to_ascii_lowercase();
    keywords(hypothesis)
        .iter()
        .filter(|keyword| text.contains(keyword.as_str()))
        .count()
}

/// Replace abstract limb cells with registered, available implementations
/// where typed effects fit inside the inherited envelope. Stable ordering and
/// keyword score make the composition deterministic; unavailable remote
/// artifacts can inform research but can never become executable cells.
fn compose_registered_cells(
    defaults: Vec<LimbCell>,
    descriptors: &[CapabilityDescriptor],
    hypothesis: &str,
    authority: &AuthorityEnvelope,
) -> Vec<LimbCell> {
    let mut composed = Vec::with_capacity(defaults.len());
    for mut cell in defaults {
        let predecessor_outputs = composed
            .last()
            .and_then(|predecessor: &LimbCell| predecessor.binding.as_ref())
            .map(|binding| binding.output_ports.as_slice())
            .unwrap_or(&[]);
        let selected = descriptors
            .iter()
            .filter(|descriptor| descriptor.available)
            .filter(|descriptor| descriptor_effects(descriptor).len() == 1)
            .filter(|descriptor| {
                authority
                    .effects
                    .is_superset(&descriptor_effects(descriptor))
            })
            .filter(|descriptor| inferred_cell_roles(descriptor).contains(cell.role.as_str()))
            .filter(|descriptor| {
                let inputs = schema_ports(&descriptor.input_schema);
                predecessor_outputs.is_empty()
                    || inputs.is_empty()
                    || inputs
                        .iter()
                        .any(|input| predecessor_outputs.contains(input))
            })
            .max_by(|left, right| {
                keyword_overlap(left, hypothesis)
                    .cmp(&keyword_overlap(right, hypothesis))
                    .then_with(|| right.id.cmp(&left.id))
            });
        if let Some(descriptor) = selected {
            cell.capability = descriptor.id.clone();
            let effects = descriptor_effects(descriptor);
            cell.effect = effects.iter().next().cloned().unwrap_or(cell.effect);
            cell.binding = Some(CapabilityBinding {
                provider: descriptor.provider.clone(),
                capability_version: descriptor.capability_version.clone(),
                input_ports: schema_ports(&descriptor.input_schema),
                output_ports: schema_ports(&descriptor.output_schema),
                requires: descriptor.requires.clone(),
            });
        }
        composed.push(cell);
    }
    composed
}

fn propose_limb_at(
    path: &Path,
    gap: &CapabilityGap,
    requested_effects: BTreeSet<String>,
    budgets: GrowthBudgets,
    hypothesis: &str,
) -> Result<LimbProposal, String> {
    propose_limb_with_catalog_at(path, gap, requested_effects, budgets, hypothesis, &[])
}

fn propose_limb_with_catalog_at(
    path: &Path,
    gap: &CapabilityGap,
    requested_effects: BTreeSet<String>,
    budgets: GrowthBudgets,
    hypothesis: &str,
    descriptors: &[CapabilityDescriptor],
) -> Result<LimbProposal, String> {
    if !gap.authority_ceiling.contains(&requested_effects, &budgets) {
        return Err("temporary limb exceeds parent authority or budget".into());
    }
    let cells = compose_registered_cells(
        default_limb_cells(&requested_effects),
        descriptors,
        hypothesis,
        &gap.authority_ceiling,
    );
    if !cells.iter().any(|cell| cell.role == "sensor") {
        return Err("temporary limb requires an independent sensor".into());
    }
    if cells
        .iter()
        .any(|cell| !requested_effects.contains(&cell.effect))
    {
        return Err("temporary limb cell exceeds its declared effects".into());
    }
    let material = format!(
        "{}|{}|{:?}|{:?}",
        gap.gap_id, hypothesis, requested_effects, budgets
    );
    let digest = format!("{:016x}", stable_hash(material.as_bytes()));
    let proposal = LimbProposal {
        schema_version: 1,
        proposal_id: format!("limb:{digest}"),
        gap_id: gap.gap_id.clone(),
        semantic_signature: gap.semantic_signature.clone(),
        artifact_hash: format!("fnv1a64:{digest}"),
        cells,
        hypothesis: hypothesis.to_string(),
        predicted_delta: BTreeMap::new(),
        effects: requested_effects,
        budgets,
        rollback: format!("contract:rollback-{digest}"),
        evidence_state: "unverified".into(),
    };
    append_growth(
        path,
        &GrowthRecord::Proposal {
            value: proposal.clone(),
        },
    )?;
    let mut experimenting = gap.clone();
    experimenting.status = GapStatus::Experimenting;
    append_growth(
        path,
        &GrowthRecord::Gap {
            value: experimenting,
        },
    )?;
    Ok(proposal)
}

fn evaluate_limb_at(
    path: &Path,
    proposal: &LimbProposal,
    evidence: PromotionEvidence,
) -> Result<PromotionDecision, String> {
    let mut reasons = Vec::new();
    if !evidence.schema_valid {
        reasons.push("schema".into());
    }
    if evidence.held_out_prediction_gain <= 0.0 {
        reasons.push("held_out_prediction".into());
    }
    if !evidence.causal_intervention {
        reasons.push("causal".into());
    }
    if !evidence.utility_improved {
        reasons.push("utility".into());
    }
    if !evidence.safety_passed {
        reasons.push("safety".into());
    }
    if !evidence.isolation_passed {
        reasons.push("isolation".into());
    }
    if !evidence.independent_sensor {
        reasons.push("independent_sensor".into());
    }
    if evidence.reproductions < 2 {
        reasons.push("reproduction".into());
    }
    if !evidence.mutation_witness_red {
        reasons.push("mutation".into());
    }
    let verdict = if reasons.is_empty() {
        PromotionVerdict::Promoted
    } else if evidence.safety_passed && evidence.independent_sensor {
        PromotionVerdict::Inhibited
    } else {
        PromotionVerdict::Held
    };
    let decision = PromotionDecision {
        proposal_id: proposal.proposal_id.clone(),
        gap_id: proposal.gap_id.clone(),
        verdict,
        reason_codes: reasons,
        evidence,
    };
    append_growth(
        path,
        &GrowthRecord::Decision {
            value: decision.clone(),
        },
    )?;
    if let Some(mut gap) = load_growth(path).gaps.remove(&proposal.gap_id) {
        gap.status = match decision.verdict {
            PromotionVerdict::Promoted => GapStatus::Closed,
            PromotionVerdict::Inhibited => GapStatus::Inhibited,
            PromotionVerdict::Held => GapStatus::Held,
        };
        append_growth(path, &GrowthRecord::Gap { value: gap })?;
    }
    Ok(decision)
}

fn recall_promoted_at(
    path: &Path,
    semantic_signature: &str,
    _interface: &str,
) -> Option<LimbProposal> {
    let state = load_growth(path);
    state
        .proposals
        .values()
        .filter(|proposal| proposal.semantic_signature == semantic_signature)
        .find(|proposal| {
            state
                .decisions
                .get(&proposal.proposal_id)
                .is_some_and(|decision| decision.verdict == PromotionVerdict::Promoted)
        })
        .cloned()
}

fn no_candidate_failure_class(goal: &str) -> String {
    let goal_family = format!("{:016x}", stable_hash(keywords(goal).join("|").as_bytes()));
    format!("no_candidate:{goal_family}")
}

pub(super) fn open_no_candidate_gap(
    goal: &str,
    cwd: &Path,
    descriptors: &[CapabilityDescriptor],
) -> Option<CapabilityGap> {
    let path = growth_store_path()?;
    let goal_lc = goal.to_ascii_lowercase();
    let network_discovery = ["github", "repository", "library", "arxiv", "paper"]
        .iter()
        .any(|token| goal_lc.contains(token));
    let mut effects = BTreeSet::from(["read_only".into()]);
    if network_discovery {
        effects.insert("network_read".into());
    }
    let authority = AuthorityEnvelope {
        effects: effects.clone(),
        budgets: GrowthBudgets::default(),
    };
    let gap = open_gap_at(
        &path,
        cwd,
        "turn:current",
        "archetype",
        GapKind::Proposer,
        &no_candidate_failure_class(goal),
        "a valid capability plan",
        "no available candidate",
        "turn",
        authority,
    )
    .ok()?;
    let already_proposed = load_growth(&path)
        .proposals
        .values()
        .any(|proposal| proposal.gap_id == gap.gap_id);
    if !already_proposed {
        let _ = propose_limb_with_catalog_at(
            &path,
            &gap,
            effects,
            GrowthBudgets::default(),
            &format!(
                "Assemble existing receptors, predictors, planners, executors, and sensors for: {}",
                goal.chars().take(160).collect::<String>()
            ),
            descriptors,
        );
    }
    Some(gap)
}

fn maintain_runtime_gap_at(path: &Path, gap: &CapabilityGap) {
    if gap.occurrences >= gap.authority_ceiling.budgets.experiments {
        let mut held = gap.clone();
        held.status = GapStatus::Held;
        let _ = append_growth(path, &GrowthRecord::Gap { value: held });
        return;
    }
    let already_proposed = load_growth(path)
        .proposals
        .values()
        .any(|proposal| proposal.gap_id == gap.gap_id);
    if !already_proposed {
        let _ = propose_limb_at(
            path,
            gap,
            BTreeSet::from(["read_only".into()]),
            gap.authority_ceiling.budgets.clone(),
            "Observe and explain the failed capability without repeating its effect",
        );
    }
}

pub(super) fn open_runtime_gap(
    cwd: &Path,
    kind: GapKind,
    failure_class: &str,
    expected: &str,
    observed: &str,
    interface: &str,
) -> Option<CapabilityGap> {
    let path = growth_store_path()?;
    let authority = AuthorityEnvelope {
        effects: BTreeSet::from(["read_only".into()]),
        budgets: GrowthBudgets {
            experiments: 4,
            children: 5,
            wall_seconds: 60,
            lease_seconds: 120,
        },
    };
    let gap = open_gap_at(
        &path,
        cwd,
        "turn:current",
        "episode",
        kind,
        failure_class,
        expected,
        observed,
        interface,
        authority,
    )
    .ok()?;
    maintain_runtime_gap_at(&path, &gap);
    Some(gap)
}

fn render_growth_context_at(path: &Path, cwd: &Path) -> Option<String> {
    // Per-turn sweep: expire stale leases before rendering so the agent never
    // sees an immortal active gap that has exhausted its experiment budget
    // (SG invariant #5: no immortal experiments). This is the production
    // caller of expire_stale_leases — without it the function was dead code
    // reached only by its unit test. Best-effort: a transient store error
    // during the sweep must not suppress the growth context.
    let _ = expire_stale_leases(path, "");
    let project = project_id(cwd);
    let state = load_growth(path);
    let mut gaps = state
        .gaps
        .values()
        .filter(|gap| gap.project == project)
        .collect::<Vec<_>>();
    gaps.sort_by_key(|gap| std::cmp::Reverse(gap.occurrences));
    gaps.truncate(4);
    if gaps.is_empty() {
        return None;
    }
    let rows = gaps
        .into_iter()
        .map(|gap| {
            let proposal = state
                .proposals
                .values()
                .filter(|proposal| proposal.gap_id == gap.gap_id)
                .max_by(|left, right| left.proposal_id.cmp(&right.proposal_id));
            let proposal_context = proposal.map_or_else(
                || " proposal=none".to_string(),
                |proposal| {
                    let cells = proposal
                        .cells
                        .iter()
                        .map(|cell| {
                            let binding = cell.binding.as_ref().map_or_else(
                                || "substrate".to_string(),
                                |binding| {
                                    format!(
                                        "{}@{} in={:?} out={:?} requires={:?}",
                                        binding.provider,
                                        binding.capability_version,
                                        binding.input_ports,
                                        binding.output_ports,
                                        binding.requires,
                                    )
                                },
                            );
                            format!(
                                "{}:{} effect={} binding={}",
                                cell.role, cell.capability, cell.effect, binding
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" -> ");
                    format!(
                        " proposal={} evidence={:?} effects={} budget=experiments:{}/children:{}/wall:{}s/lease:{}s rollback={} cells=[{}] hypothesis={:?}",
                        proposal.proposal_id,
                        proposal.evidence_state,
                        proposal.effects.iter().cloned().collect::<Vec<_>>().join("|"),
                        proposal.budgets.experiments,
                        proposal.budgets.children,
                        proposal.budgets.wall_seconds,
                        proposal.budgets.lease_seconds,
                        proposal.rollback,
                        cells,
                        proposal.hypothesis,
                    )
                },
            );
            format!(
                "- {} kind={:?} status={:?} occurrences={} scope={} authority=inherited{}",
                gap.gap_id,
                gap.kind,
                gap.status,
                gap.occurrences,
                gap.scope,
                proposal_context,
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "SELF-GROWING CONTRACT GAPS (bounded development hypotheses, never new authority):\n{rows}\nDirective: reuse existing cells first; any temporary limb requires an independent sensor, rollback, finite lease, and held-out promotion evidence."
    ))
}

pub(super) fn render_growth_context(cwd: &Path) -> Option<String> {
    render_growth_context_at(&growth_store_path()?, cwd)
}

// ── SG0: Schema validation with privacy guards ────────────────────────

/// Reject any field that could leak raw coordinates, machine paths, or
/// credentials into the durable growth store.
fn validate_privacy<T: Serialize>(value: &T, label: &str) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let lower = raw.to_ascii_lowercase();
    // Never store exact pixel/grid coordinates.
    if lower.contains("\"x\":") || lower.contains("\"y\":") {
        return Err(format!("{label}: coordinate leakage detected"));
    }
    // Never store filesystem paths.
    if lower.contains("/users/") || lower.contains("\\\\users\\\\") {
        return Err(format!("{label}: machine path leakage detected"));
    }
    // Never store credential-shaped fields.
    for token in &["token", "secret", "password", "api_key", "credential"] {
        if lower.contains(token) {
            return Err(format!(
                "{label}: credential-shaped field '{token}' detected"
            ));
        }
    }
    Ok(())
}

/// Validate a capability gap against the schema invariants declared in
/// plan.md SG0: non-empty identity, valid semantic signature format,
/// bounded scope, non-empty failure class, and parent authority subset.
pub(super) fn validate_gap(gap: &CapabilityGap) -> Result<(), String> {
    if gap.gap_id.is_empty() || !gap.gap_id.starts_with("gap:") {
        return Err("gap_id must be non-empty and start with 'gap:'".into());
    }
    if gap.semantic_signature.len() != 16 {
        return Err("semantic_signature must be a 16-char hex digest".into());
    }
    if gap.parent_contract.is_empty() {
        return Err("parent_contract must be non-empty".into());
    }
    if gap.failure_class.is_empty() {
        return Err("failure_class must be non-empty".into());
    }
    if gap.expected.is_empty() && gap.observed.is_empty() {
        return Err("at least one of expected or observed must be non-empty".into());
    }
    // Scope must be a recognised value.
    if !matches!(gap.scope.as_str(), "episode" | "archetype" | "global") {
        return Err(format!(
            "scope '{}' is not a recognised scope kind",
            gap.scope
        ));
    }
    // Budget caps: never unbounded.
    if gap.authority_ceiling.budgets.experiments == 0
        || gap.authority_ceiling.budgets.experiments > 1024
    {
        return Err("experiments budget must be 1..1024".into());
    }
    if gap.authority_ceiling.budgets.children > 64 {
        return Err("children budget must be ≤64".into());
    }
    if gap.authority_ceiling.budgets.wall_seconds > 3600 {
        return Err("wall_seconds budget must be ≤3600".into());
    }
    if gap.authority_ceiling.budgets.lease_seconds > 7200 {
        return Err("lease_seconds budget must be ≤7200".into());
    }
    validate_privacy(gap, "gap")?;
    Ok(())
}

/// Validate a limb proposal: cells form a valid DAG, independent sensor
/// is present, effects stay within the parent envelope, and no raw
/// coordinates or secrets leak into the durable proposal.
pub(super) fn validate_proposal(
    proposal: &LimbProposal,
    parent: &CapabilityGap,
) -> Result<(), String> {
    if proposal.proposal_id.is_empty() || !proposal.proposal_id.starts_with("limb:") {
        return Err("proposal_id must be non-empty and start with 'limb:'".into());
    }
    if proposal.gap_id != parent.gap_id {
        return Err("proposal must reference its originating gap".into());
    }
    // Every cell must have a non-empty role and capability.
    for (i, cell) in proposal.cells.iter().enumerate() {
        if cell.role.is_empty() {
            return Err(format!("cell {i}: role must be non-empty"));
        }
        if cell.capability.is_empty() {
            return Err(format!("cell {i}: capability must be non-empty"));
        }
    }
    // Independent sensor must be present.
    if !proposal.cells.iter().any(|c| c.role == "sensor") {
        return Err("proposal must include an independent sensor cell".into());
    }
    // Effects must be within parent authority.
    if !parent
        .authority_ceiling
        .effects
        .is_superset(&proposal.effects)
    {
        return Err("proposal effects must be a subset of parent authority".into());
    }
    // Budgets must be within parent.
    if !parent
        .authority_ceiling
        .contains(&proposal.effects, &proposal.budgets)
    {
        return Err("proposal budgets exceed parent authority".into());
    }
    // Rollback must be declared.
    if proposal.rollback.is_empty() {
        return Err("proposal must declare a rollback contract".into());
    }
    validate_privacy(proposal, "proposal")?;
    Ok(())
}

// ── SG1: Complete gap classification ──────────────────────────────────

/// Failure classes recognised by the gap detector. These map to the
/// bounded triggers in plan.md SG1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FailureClass {
    NoCandidate,
    RepeatedLoop,
    UnexplainedTransition,
    PredictionError,
    MissingSensor,
    ProviderFailure,
    PermissionDenied,
    Timeout,
}

impl FailureClass {
    fn as_str(&self) -> &'static str {
        match self {
            FailureClass::NoCandidate => "no_candidate",
            FailureClass::RepeatedLoop => "repeated_loop",
            FailureClass::UnexplainedTransition => "unexplained_transition",
            FailureClass::PredictionError => "prediction_error",
            FailureClass::MissingSensor => "missing_sensor",
            FailureClass::ProviderFailure => "provider_failure",
            FailureClass::PermissionDenied => "permission_denied",
            FailureClass::Timeout => "timeout",
        }
    }

    fn gap_kind(&self) -> GapKind {
        match self {
            FailureClass::NoCandidate => GapKind::Proposer,
            FailureClass::RepeatedLoop => GapKind::Planner,
            FailureClass::UnexplainedTransition => GapKind::Predictor,
            FailureClass::PredictionError => GapKind::Predictor,
            FailureClass::MissingSensor => GapKind::Sensor,
            FailureClass::ProviderFailure => GapKind::Executor,
            FailureClass::PermissionDenied => GapKind::Executor,
            FailureClass::Timeout => GapKind::Executor,
        }
    }

    /// Ordinary recoverable failures should NOT create unbounded gaps.
    /// Only structural/novel failures open new development tracks.
    fn is_structural(&self) -> bool {
        matches!(
            self,
            FailureClass::NoCandidate
                | FailureClass::RepeatedLoop
                | FailureClass::UnexplainedTransition
                | FailureClass::PredictionError
                | FailureClass::MissingSensor
        )
    }
}

/// Open a gap only when the failure is structural, not an ordinary
/// recoverable error. Returns `None` for transient failures like
/// timeouts or permission denials that should not spawn limbs.
pub(super) fn classify_and_open_gap(
    cwd: &Path,
    class: FailureClass,
    expected: &str,
    observed: &str,
    interface: &str,
) -> Option<CapabilityGap> {
    if !class.is_structural() {
        return None;
    }
    open_runtime_gap(
        cwd,
        class.gap_kind(),
        class.as_str(),
        expected,
        observed,
        interface,
    )
}

// ── SG3: Limb lifecycle (kill, renew, expire) ────────────────────────

/// Lease state for a running limb.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct LimbLease {
    pub proposal_id: String,
    pub owner: String,
    pub generation: u32,
    pub issued_at: String,
    pub expires_at: String,
    pub renewal_policy: String,
    pub child_count: u32,
    pub max_children: u32,
    pub active: bool,
}

/// Kill a running limb: mark its lease inactive, update the gap to
/// Open (returning it to the development pool), and record the
/// termination in the growth store.
pub(super) fn kill_limb(path: &Path, proposal_id: &str) -> Result<(), String> {
    let state = load_growth(path);
    let proposal = state
        .proposals
        .get(proposal_id)
        .ok_or_else(|| format!("proposal {proposal_id} not found"))?;
    let gap = state
        .gaps
        .get(&proposal.gap_id)
        .ok_or_else(|| format!("gap {} not found", proposal.gap_id))?;
    // Return the gap to Open so it can be re-proposed.
    let mut reopened = gap.clone();
    reopened.status = GapStatus::Open;
    append_growth(path, &GrowthRecord::Gap { value: reopened })?;
    // Record the termination as a decision.
    let decision = PromotionDecision {
        proposal_id: proposal_id.to_string(),
        gap_id: proposal.gap_id.clone(),
        verdict: PromotionVerdict::Held,
        reason_codes: vec!["killed".into()],
        evidence: PromotionEvidence {
            schema_valid: true,
            held_out_prediction_gain: 0.0,
            causal_intervention: false,
            utility_improved: false,
            safety_passed: true,
            isolation_passed: true,
            independent_sensor: true,
            reproductions: 0,
            mutation_witness_red: false,
        },
    };
    append_growth(path, &GrowthRecord::Decision { value: decision })?;
    Ok(())
}

/// Expire all limbs whose lease window has closed. Returns the count of
/// expired limbs.
pub(super) fn expire_stale_leases(path: &Path, _now: &str) -> Result<usize, String> {
    let state = load_growth(path);
    let mut expired = 0usize;
    for gap in state.gaps.values() {
        // Hold any *active* gap whose observed occurrences have exhausted the
        // experiment budget — not just Experimenting ones. An Open gap that has
        // been reinforced past its budget without ever being experimented is
        // equally exhausted and must not live forever (SG invariant #5: no
        // immortal experiments). Promotable and terminal statuses are left
        // alone so a winner is not clobbered and settled gaps are not re-held.
        // Consistent with maintain_runtime_gap_at's exhaustion rule.
        if matches!(gap.status, GapStatus::Open | GapStatus::Experimenting)
            && gap.occurrences >= gap.authority_ceiling.budgets.experiments
        {
            let mut held = gap.clone();
            held.status = GapStatus::Held;
            append_growth(path, &GrowthRecord::Gap { value: held })?;
            expired += 1;
        }
    }
    Ok(expired)
}

// ── SG4: Energy-based experiment candidate ranking ───────────────────

/// A ranked experiment candidate with energy terms.
#[derive(Debug, Clone)]
pub(super) struct ExperimentCandidate {
    pub proposal_id: String,
    pub predicted_progress_energy: f64,
    pub information_gain: f64,
    pub loop_penalty: f64,
    pub failure_penalty: f64,
    pub action_cost: f64,
    pub composite_energy: f64,
    pub tier: CandidateTier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum CandidateTier {
    /// Proven successful in matching context.
    Verified = 0,
    /// New or unverified — eligible for bounded experiment.
    Unverified = 1,
    /// Previously failed in this context.
    Failed = 2,
    /// Unsafe or illegal — HOLD only.
    Unsafe = 3,
}

/// Rank limb proposals by composite energy: progress potential +
/// information gain - penalties - cost. Returns candidates sorted
/// lowest-energy-first (better).
pub(super) fn rank_experiment_candidates(path: &Path, cwd: &Path) -> Vec<ExperimentCandidate> {
    let state = load_growth(path);
    let project = project_id(cwd);
    let mut candidates = Vec::new();
    for proposal in state.proposals.values().filter(|p| {
        state
            .gaps
            .get(&p.gap_id)
            .is_some_and(|g| g.project == project)
    }) {
        let gap = state.gaps.get(&proposal.gap_id).unwrap();
        // Tier classification.
        let tier = if let Some(decision) = state.decisions.get(&proposal.proposal_id) {
            match decision.verdict {
                PromotionVerdict::Promoted => CandidateTier::Verified,
                PromotionVerdict::Inhibited => CandidateTier::Failed,
                PromotionVerdict::Held => CandidateTier::Unsafe,
            }
        } else if gap.status == GapStatus::Held {
            CandidateTier::Unsafe
        } else {
            CandidateTier::Unverified
        };
        // Energy terms.
        let predicted_progress_energy = if proposal.predicted_delta.is_empty() {
            0.0
        } else {
            proposal.predicted_delta.len() as f64 * 0.1
        };
        let information_gain = if proposal.evidence_state == "unverified" {
            0.3
        } else {
            0.0
        };
        let loop_penalty = if gap.failure_class.contains("repeated_loop") {
            0.5
        } else {
            0.0
        };
        let failure_penalty = if matches!(tier, CandidateTier::Failed) {
            1.0
        } else {
            0.0
        };
        let action_cost = proposal.cells.len() as f64 * 0.05;
        let composite_energy = predicted_progress_energy + information_gain
            - loop_penalty
            - failure_penalty
            - action_cost;
        candidates.push(ExperimentCandidate {
            proposal_id: proposal.proposal_id.clone(),
            predicted_progress_energy,
            information_gain,
            loop_penalty,
            failure_penalty,
            action_cost,
            composite_energy,
            tier,
        });
    }
    // Sort by tier first, then by composite energy (lower is better).
    candidates.sort_by(|a, b| {
        a.tier.cmp(&b.tier).then_with(|| {
            a.composite_energy
                .partial_cmp(&b.composite_energy)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    candidates
}

#[cfg(test)]
mod contract_learning_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn growth_test_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "aiko-self-growing-{name}-{}-{nonce}.jsonl",
            std::process::id()
        ))
    }

    fn test_authority() -> AuthorityEnvelope {
        AuthorityEnvelope {
            effects: BTreeSet::from(["read_only".into(), "local_write".into()]),
            budgets: GrowthBudgets::default(),
        }
    }

    fn promotion_evidence() -> PromotionEvidence {
        PromotionEvidence {
            schema_valid: true,
            held_out_prediction_gain: 0.2,
            causal_intervention: true,
            utility_improved: true,
            safety_passed: true,
            isolation_passed: true,
            independent_sensor: true,
            reproductions: 2,
            mutation_witness_red: true,
        }
    }

    #[test]
    fn repeated_contradictions_reject_a_family() {
        let mut item = LearningContract {
            family: "f".into(),
            claim: "c".into(),
            project: "p".into(),
            keywords: vec![],
            status: Status::Proposed,
            supports: 0,
            contradictions: 2,
            confidence: 0.25,
        };
        item.status = if item.contradictions >= 2 && item.contradictions > item.supports {
            Status::Contradicted
        } else {
            Status::Proposed
        };
        assert_eq!(item.status, Status::Contradicted);
    }

    #[test]
    fn family_is_stable_and_project_scoped() {
        assert_eq!(
            safe_family("application.act", "/a"),
            safe_family("application.act", "/a")
        );
        assert_ne!(
            safe_family("application.act", "/a"),
            safe_family("application.act", "/b")
        );
    }

    #[test]
    fn confidence_uses_smoothed_evidence_counts() {
        let supports = 3_u32;
        let contradictions = 1_u32;
        let confidence = f64::from(supports + 1) / f64::from(supports + contradictions + 2);
        assert!((confidence - 2.0 / 3.0).abs() < f64::EPSILON);
    }

    #[test]
    fn gap_identity_is_semantic_and_deduplicates_across_interfaces() {
        let path = growth_test_path("dedupe");
        let cwd = Path::new("/tmp/project");
        let first = open_gap_at(
            &path,
            cwd,
            "contract:parent",
            "archetype",
            GapKind::Predictor,
            "unexplained_transition",
            "typed relational delta",
            "unknown delta",
            "arc",
            test_authority(),
        )
        .expect("first gap");
        let second = open_gap_at(
            &path,
            cwd,
            "contract:parent",
            "archetype",
            GapKind::Predictor,
            "unexplained_transition",
            "typed relational delta",
            "unknown delta",
            "ios",
            test_authority(),
        )
        .expect("second gap");
        assert_eq!(first.gap_id, second.gap_id);
        assert_eq!(second.occurrences, 2);
        assert_eq!(
            second.interfaces,
            BTreeSet::from(["arc".into(), "ios".into()])
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn no_candidate_identity_tracks_the_need_not_the_interface() {
        assert_eq!(
            no_candidate_failure_class("find a GitHub sensor library"),
            no_candidate_failure_class("library sensor GitHub find a")
        );
        assert_ne!(
            no_candidate_failure_class("find a GitHub sensor library"),
            no_candidate_failure_class("render an offline SwiftUI chart")
        );
    }

    #[test]
    fn runtime_failure_lease_holds_and_does_not_duplicate_the_proposal() {
        let path = growth_test_path("runtime-lease");
        let budgets = GrowthBudgets {
            experiments: 4,
            children: 5,
            wall_seconds: 60,
            lease_seconds: 120,
        };
        for _ in 0..4 {
            let gap = open_gap_at(
                &path,
                Path::new("/tmp/runtime-lease"),
                "turn:test",
                "episode",
                GapKind::Sensor,
                "provider_failure",
                "typed outcome",
                "routing error",
                "web_search",
                AuthorityEnvelope {
                    effects: BTreeSet::from(["read_only".into()]),
                    budgets: budgets.clone(),
                },
            )
            .expect("gap");
            maintain_runtime_gap_at(&path, &gap);
        }
        let state = load_growth(&path);
        let gap = state.gaps.values().next().expect("persisted gap");
        assert_eq!(gap.occurrences, 4);
        assert_eq!(gap.status, GapStatus::Held);
        assert_eq!(state.proposals.len(), 1);
        let raw = std::fs::read_to_string(&path).expect("ledger");
        assert_eq!(raw.matches("\"record_type\":\"proposal\"").count(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn temporary_limb_cannot_expand_parent_authority_or_budget() {
        let path = growth_test_path("authority");
        let gap = open_gap_at(
            &path,
            Path::new("/tmp/project"),
            "contract:parent",
            "episode",
            GapKind::Executor,
            "no_candidate",
            "bounded local action",
            "none",
            "cli",
            test_authority(),
        )
        .expect("gap");
        let escalation = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["network".into()]),
            GrowthBudgets::default(),
            "spawn an ungoverned network limb",
        );
        assert!(escalation.is_err());
        let oversized = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into()]),
            GrowthBudgets {
                experiments: DEFAULT_GROWTH_EXPERIMENTS + 1,
                ..GrowthBudgets::default()
            },
            "run forever",
        );
        assert!(oversized.is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn promotion_rejects_overfit_or_same_failure_domain_evidence() {
        let path = growth_test_path("overfit");
        let gap = open_gap_at(
            &path,
            Path::new("/tmp/project"),
            "contract:parent",
            "archetype",
            GapKind::Planner,
            "repeated_loop",
            "progress",
            "loop",
            "arc",
            test_authority(),
        )
        .expect("gap");
        let proposal = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into()]),
            GrowthBudgets::default(),
            "memorize the training episode",
        )
        .expect("proposal");
        let mut overfit = promotion_evidence();
        overfit.held_out_prediction_gain = -0.1;
        overfit.reproductions = 1;
        overfit.mutation_witness_red = false;
        let decision = evaluate_limb_at(&path, &proposal, overfit).expect("decision");
        assert_eq!(decision.verdict, PromotionVerdict::Inhibited);
        assert!(
            decision
                .reason_codes
                .contains(&"held_out_prediction".into())
        );
        assert!(decision.reason_codes.contains(&"reproduction".into()));
        assert!(decision.reason_codes.contains(&"mutation".into()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn self_growing_limb_end_to_end_witness() {
        let path = growth_test_path("end-to-end");
        let cwd = Path::new("/tmp/project");
        let gap = open_gap_at(
            &path,
            cwd,
            "contract:parent",
            "archetype",
            GapKind::Representation,
            "unexplained_transition",
            "coordinate-free relational state",
            "raw frame delta only",
            "arc",
            test_authority(),
        )
        .expect("gap");
        let proposal = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into(), "local_write".into()]),
            GrowthBudgets::default(),
            "track selected objects and predict relational action deltas",
        )
        .expect("bounded proposal");
        assert_eq!(
            proposal
                .cells
                .iter()
                .map(|cell| cell.role.as_str())
                .collect::<Vec<_>>(),
            vec!["receptor", "predictor", "planner", "executor", "sensor"]
        );
        assert!(!proposal.rollback.is_empty());
        let far = SemanticRelation {
            subject_role: "selected-medium-family-2".into(),
            relation: RelationKind::DistanceBand,
            object_role: "target-small-family-1".into(),
            band: Some("far".into()),
        };
        let near = SemanticRelation {
            band: Some("near".into()),
            ..far.clone()
        };
        let before = RelationalState {
            object_roles: BTreeSet::from([
                "selected-medium-family-2".into(),
                "target-small-family-1".into(),
            ]),
            relations: BTreeSet::from([far.clone()]),
        };
        let after = RelationalState {
            object_roles: before.object_roles.clone(),
            relations: BTreeSet::from([near.clone()]),
        };
        let predicted = RelationalDelta {
            added: BTreeSet::from([near]),
            removed: BTreeSet::from([far]),
        };
        let transition = record_transition_at(
            &path,
            &proposal,
            "move-toward-target",
            &before,
            &after,
            Some(&predicted),
            true,
            None,
        )
        .expect("dense relational evidence");
        assert_eq!(transition.prediction_agreed, Some(true));
        assert_eq!(transition.progress, None);
        let decision = evaluate_limb_at(&path, &proposal, promotion_evidence()).expect("promotion");
        assert_eq!(decision.verdict, PromotionVerdict::Promoted);

        // Every lookup reopens the append store, which is the restart witness.
        let recalled = recall_promoted_at(&path, &gap.semantic_signature, "telegram")
            .expect("promoted limb transfers to a second interface");
        assert_eq!(recalled.proposal_id, proposal.proposal_id);
        assert_eq!(recalled.artifact_hash, proposal.artifact_hash);

        let persisted = std::fs::read_to_string(&path).expect("durable lineage");
        assert!(persisted.contains("\"record_type\":\"gap\""));
        assert!(persisted.contains("\"record_type\":\"proposal\""));
        assert!(persisted.contains("\"record_type\":\"transition\""));
        assert!(persisted.contains("\"record_type\":\"decision\""));
        assert!(!persisted.contains("\"x\":"));
        assert!(!persisted.contains("\"y\":"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn growth_context_routes_the_compiled_limb_into_the_agent_prompt() {
        let path = growth_test_path("growth-context");
        let cwd = Path::new("/tmp/growth-context-project");
        let authority = AuthorityEnvelope {
            effects: BTreeSet::from(["read_only".into()]),
            budgets: GrowthBudgets::default(),
        };
        let gap = open_gap_at(
            &path,
            cwd,
            "turn:test",
            "episode",
            GapKind::Proposer,
            "no_candidate",
            "typed observation",
            "no provider",
            "cli",
            authority,
        )
        .expect("gap");
        let proposal = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into()]),
            GrowthBudgets::default(),
            "observe an unknown surface safely",
        )
        .expect("proposal");

        let context = render_growth_context_at(&path, cwd).expect("growth context");
        assert!(context.contains(&proposal.proposal_id));
        assert!(context.contains("receptor:observe.typed-state"));
        assert!(context.contains("executor:simulate.bounded-action"));
        assert!(context.contains(&proposal.rollback));
        assert!(context.contains("effects=read_only"));
        assert!(context.contains("hypothesis=\"observe an unknown surface safely\""));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn composition_reuses_registered_cells_and_never_activates_quarantine() {
        let path = growth_test_path("registered-composition");
        let cwd = Path::new("/tmp/registered-composition");
        let authority = AuthorityEnvelope {
            effects: BTreeSet::from(["read_only".into(), "network_read".into()]),
            budgets: GrowthBudgets::default(),
        };
        let gap = open_gap_at(
            &path,
            cwd,
            "turn:test",
            "archetype",
            GapKind::Receptor,
            "missing_library",
            "existing implementation evidence",
            "no local provider",
            "cli",
            authority,
        )
        .expect("gap");
        let descriptor = |id: &str, description: &str, available: bool| {
            serde_json::from_value::<CapabilityDescriptor>(serde_json::json!({
                "schema_version": 1,
                "id": id,
                "capability_version": "v1",
                "provider": "registry:github",
                "tool": "web_search",
                "action": "search_repositories",
                "description": description,
                "input_schema": {"type":"object"},
                "output_schema": {"type":"object"},
                "requires": [],
                "permission": "network",
                "effects": ["network_read"],
                "available": available
            }))
            .expect("descriptor")
        };
        let registered = descriptor(
            "registry.github.search",
            "Search GitHub repositories for reusable sensor libraries",
            true,
        );
        let quarantined = descriptor(
            "artifact:github.unverified.inspect",
            "Search GitHub repositories for reusable sensor libraries",
            false,
        );
        let proposal = propose_limb_with_catalog_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into(), "network_read".into()]),
            GrowthBudgets::default(),
            "find a GitHub sensor library before generating glue",
            &[quarantined, registered],
        )
        .expect("composed proposal");
        assert!(
            proposal
                .cells
                .iter()
                .any(|cell| cell.capability == "registry.github.search")
        );
        let github_cell = proposal
            .cells
            .iter()
            .find(|cell| cell.capability == "registry.github.search")
            .expect("registered GitHub cell");
        assert_eq!(
            github_cell
                .binding
                .as_ref()
                .expect("typed binding")
                .provider,
            "registry:github"
        );
        assert!(
            proposal
                .cells
                .iter()
                .all(|cell| cell.capability != "artifact:github.unverified.inspect")
        );
        assert!(proposal.effects.is_subset(&gap.authority_ceiling.effects));
        let read_only_cells = compose_registered_cells(
            default_limb_cells(&BTreeSet::from(["read_only".into()])),
            &[descriptor(
                "registry.github.search",
                "Search GitHub repositories for reusable sensor libraries",
                true,
            )],
            "find a GitHub sensor library",
            &AuthorityEnvelope {
                effects: BTreeSet::from(["read_only".into()]),
                budgets: GrowthBudgets::default(),
            },
        );
        assert!(
            read_only_cells
                .iter()
                .all(|cell| cell.capability != "registry.github.search"),
            "network discovery must not expand a read-only parent envelope"
        );
        let _ = std::fs::remove_file(path);
    }

    // ── SG0: Schema validation tests ────────────────────────────────

    #[test]
    fn validate_gap_rejects_invalid_id_format() {
        let mut gap = CapabilityGap {
            schema_version: 1,
            gap_id: "bad-format".into(),
            parent_contract: "turn:test".into(),
            project: "p".into(),
            semantic_signature: "0123456789abcdef".into(),
            scope: "episode".into(),
            kind: GapKind::Predictor,
            failure_class: "test".into(),
            expected: "expected".into(),
            observed: "observed".into(),
            interfaces: BTreeSet::new(),
            authority_ceiling: test_authority(),
            status: GapStatus::Open,
            occurrences: 0,
        };
        assert!(validate_gap(&gap).is_err());
        gap.gap_id = "gap:valid".into();
        assert!(validate_gap(&gap).is_ok());
    }

    #[test]
    fn validate_gap_rejects_coordinate_leakage() {
        let mut map = serde_json::Map::new();
        map.insert("x".into(), serde_json::Value::Number(42.into()));
        map.insert("y".into(), serde_json::Value::Number(7.into()));
        assert!(validate_privacy(&map, "test").is_err());
    }

    #[test]
    fn validate_gap_rejects_credential_leakage() {
        let map = serde_json::json!({"api_key": "sk-1234"});
        assert!(validate_privacy(&map, "test").is_err());
    }

    #[test]
    fn validate_gap_enforces_budget_caps() {
        let mut gap = CapabilityGap {
            schema_version: 1,
            gap_id: "gap:test".into(),
            parent_contract: "turn:test".into(),
            project: "p".into(),
            semantic_signature: "0123456789abcdef".into(),
            scope: "episode".into(),
            kind: GapKind::Predictor,
            failure_class: "test".into(),
            expected: "e".into(),
            observed: "o".into(),
            interfaces: BTreeSet::new(),
            authority_ceiling: AuthorityEnvelope {
                effects: BTreeSet::from(["read_only".into()]),
                budgets: GrowthBudgets {
                    experiments: 2000, // >1024
                    ..GrowthBudgets::default()
                },
            },
            status: GapStatus::Open,
            occurrences: 0,
        };
        assert!(validate_gap(&gap).is_err());
        gap.authority_ceiling.budgets.experiments = 8;
        assert!(validate_gap(&gap).is_ok());
    }

    // ── SG1: Gap classification tests ───────────────────────────────

    #[test]
    fn structural_failures_open_gaps_transient_do_not() {
        let path = growth_test_path("classification");
        let cwd = Path::new("/tmp/classification");
        // Structural: should open a gap.
        let gap =
            classify_and_open_gap(cwd, FailureClass::NoCandidate, "typed plan", "none", "cli");
        assert!(gap.is_some());
        // Transient: should NOT open a gap.
        let no_gap = classify_and_open_gap(
            cwd,
            FailureClass::Timeout,
            "response",
            "deadline exceeded",
            "http",
        );
        assert!(no_gap.is_none());
        // Structural: prediction error.
        let pg = classify_and_open_gap(
            cwd,
            FailureClass::PredictionError,
            "correct delta",
            "wrong delta",
            "arc",
        );
        assert!(pg.is_some());
        let _ = std::fs::remove_file(path);
    }

    // ── SG3: Limb lifecycle tests ───────────────────────────────────

    #[test]
    fn kill_limb_reopens_gap_and_records_decision() {
        let path = growth_test_path("kill-limb");
        let cwd = Path::new("/tmp/kill-limb");
        let gap = open_gap_at(
            &path,
            cwd,
            "turn:test",
            "episode",
            GapKind::Executor,
            "provider_failure",
            "action",
            "error",
            "cli",
            test_authority(),
        )
        .expect("gap");
        let proposal = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into()]),
            GrowthBudgets::default(),
            "test limb",
        )
        .expect("proposal");
        kill_limb(&path, &proposal.proposal_id).expect("killed");
        let state = load_growth(&path);
        let reopened = state.gaps.get(&gap.gap_id).expect("gap exists");
        assert_eq!(reopened.status, GapStatus::Open);
        let decision = state
            .decisions
            .get(&proposal.proposal_id)
            .expect("kill recorded");
        assert_eq!(decision.verdict, PromotionVerdict::Held);
        assert!(decision.reason_codes.contains(&"killed".into()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn expire_stale_leases_holds_exhausted_gaps() {
        let path = growth_test_path("expire-lease");
        let cwd = Path::new("/tmp/expire-lease");
        let budgets = GrowthBudgets {
            experiments: 2,
            ..GrowthBudgets::default()
        };
        let gap = open_gap_at(
            &path,
            cwd,
            "turn:test",
            "episode",
            GapKind::Executor,
            "provider_failure",
            "action",
            "error",
            "cli",
            AuthorityEnvelope {
                effects: BTreeSet::from(["read_only".into()]),
                budgets,
            },
        )
        .expect("gap");
        // Manually bump occurrences past the budget.
        for _ in 0..3 {
            let mut g = load_growth(&path).gaps.remove(&gap.gap_id).unwrap();
            g.occurrences = g.occurrences.saturating_add(1);
            let _ = append_growth(&path, &GrowthRecord::Gap { value: g });
        }
        let expired = expire_stale_leases(&path, "2026-07-24T00:00:00Z").expect("expired");
        assert!(expired > 0);
        let state = load_growth(&path);
        let held = state.gaps.get(&gap.gap_id).expect("gap exists");
        assert_eq!(held.status, GapStatus::Held);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn render_growth_context_sweep_holds_exhausted_active_gap() {
        // Integration witness that the per-turn render sweep actually fires
        // expire_stale_leases in production: an *active* gap (Open) reinforced
        // past its experiment budget through a path that does NOT auto-hold
        // (open_gap_at, unlike open_runtime_gap) must be Held before the agent
        // ever sees the growth context. Without the sweep wiring this gap would
        // live forever — SG invariant #5 (no immortal experiments).
        let path = growth_test_path("sweep-hold");
        let cwd = Path::new("/tmp/sweep-hold");
        let budgets = GrowthBudgets {
            experiments: 2,
            ..GrowthBudgets::default()
        };
        let gap = open_gap_at(
            &path,
            cwd,
            "turn:test",
            "episode",
            GapKind::Executor,
            "provider_failure",
            "action",
            "error",
            "cli",
            AuthorityEnvelope {
                effects: BTreeSet::from(["read_only".into()]),
                budgets,
            },
        )
        .expect("gap");
        // open_gap_at does not auto-hold. Reinforce past the experiment budget
        // without going through open_runtime_gap's maintain_runtime_gap_at.
        for _ in 0..2 {
            let mut g = load_growth(&path).gaps.remove(&gap.gap_id).unwrap();
            g.occurrences = g.occurrences.saturating_add(1);
            let _ = append_growth(&path, &GrowthRecord::Gap { value: g });
        }
        let pre = load_growth(&path)
            .gaps
            .get(&gap.gap_id)
            .expect("gap exists")
            .clone();
        assert_eq!(
            pre.status,
            GapStatus::Open,
            "gap must still be Open before sweep"
        );
        assert_eq!(
            pre.occurrences, 3,
            "occurrences must exceed the budget of 2"
        );
        // The render sweep must hold the exhausted active gap.
        let _ = render_growth_context_at(&path, cwd);
        let post = load_growth(&path)
            .gaps
            .get(&gap.gap_id)
            .expect("gap exists")
            .clone();
        assert_eq!(
            post.status,
            GapStatus::Held,
            "render sweep must hold exhausted gap"
        );
        let _ = std::fs::remove_file(path);
    }

    // ── SG4: Energy ranking tests ───────────────────────────────────

    #[test]
    fn energy_ranking_sorts_by_tier_then_composite_energy() {
        let path = growth_test_path("energy-rank");
        let cwd = Path::new("/tmp/energy-rank");
        // Create a gap and two proposals.
        let gap = open_gap_at(
            &path,
            cwd,
            "turn:test",
            "archetype",
            GapKind::Planner,
            "repeated_loop",
            "progress",
            "loop",
            "arc",
            test_authority(),
        )
        .expect("gap");
        let p1 = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into()]),
            GrowthBudgets::default(),
            "explore broadly",
        )
        .expect("p1");
        let p2 = propose_limb_at(
            &path,
            &gap,
            BTreeSet::from(["read_only".into()]),
            GrowthBudgets::default(),
            "target specific action",
        )
        .expect("p2");
        // Promote p1 → Verified tier.
        evaluate_limb_at(&path, &p1, promotion_evidence()).expect("promote p1");
        let candidates = rank_experiment_candidates(&path, cwd);
        assert!(candidates.len() >= 2);
        // Verified should sort before Unverified.
        let verified_idx = candidates
            .iter()
            .position(|c| c.tier == CandidateTier::Verified);
        let unverified_idx = candidates
            .iter()
            .position(|c| c.tier == CandidateTier::Unverified);
        assert!(
            verified_idx < unverified_idx,
            "verified candidates must rank before unverified"
        );
        let _ = std::fs::remove_file(path);
    }
}
