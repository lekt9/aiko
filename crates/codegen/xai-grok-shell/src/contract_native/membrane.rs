//! Provider-neutral Contract membrane shared by interface adapters.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceFamily {
    Cli,
    Tui,
    Mcp,
    Messaging,
    Ios,
    Subprocess,
    Api,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IngressMode {
    Poll,
    LocalListener,
    EphemeralTunnel,
    DurableTunnel,
    ProviderWebhook,
    HostedWorker,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliverySemantics {
    AtMostOnce,
    AtLeastOnce,
    EffectivelyOnce,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Durability {
    Ephemeral,
    Session,
    Leased,
    Restartable,
    HostedDurable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Created,
    Updated,
    Deleted,
    Moved,
    Reordered,
    Unchanged,
    Unknown,
}

impl InterfaceFamily {
    pub fn from_binding(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("tui") => Self::Tui,
            Some("mcp") => Self::Mcp,
            Some("messaging") => Self::Messaging,
            Some("ios") => Self::Ios,
            Some("subprocess") => Self::Subprocess,
            Some("api") => Self::Api,
            _ => Self::Cli,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    ReadOnly,
    LocalWrite,
    ExternalMessage,
    Purchase,
    Delete,
    Publish,
    CredentialAccess,
    PermissionChange,
    ProcessSpawn,
}

impl EffectClass {
    pub fn consequential(self) -> bool {
        self != Self::ReadOnly
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Receptor {
    pub family: InterfaceFamily,
    pub capability: String,
    pub occurrence_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LifecyclePolicy {
    pub lease_ms: u64,
    pub health_sensor: String,
    pub cancellation_capability: String,
    pub restart_owner: String,
    pub max_restarts: u32,
    pub max_children: u32,
}

impl LifecyclePolicy {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.lease_ms == 0 {
            return Err("lease must be finite");
        }
        if self.health_sensor.trim().is_empty()
            || self.cancellation_capability.trim().is_empty()
            || self.restart_owner.trim().is_empty()
        {
            return Err("health, cancellation, and restart ownership are required");
        }
        if self.max_restarts == 0 || self.max_children == 0 {
            return Err("restart and child bounds must be positive");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionEnvelope {
    pub receptor: Receptor,
    pub effect: EffectClass,
    pub contract_id: Option<String>,
    pub authorization: Authorization,
    pub executed: bool,
    pub environment_acknowledged: bool,
    pub progress: Option<bool>,
    pub lifecycle: Option<LifecyclePolicy>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Authorization {
    ContractAuthorized,
    ReadOnlyDegraded,
    Hold,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdentityKind {
    Actor,
    Conversation,
    Resource,
    Occurrence,
    Runtime,
    ProviderHandle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityScope {
    pub kind: IdentityKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    ProviderReceipt,
    IndependentSensor,
    UserConfirmation,
    PredictionAgreement,
    StateTransition,
    ProgressSignal,
    CompletionSignal,
    Contradiction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    LiveProvider,
    DurableLedger,
    LocalCache,
    ModelPrediction,
    UserAssertion,
    Derived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Live,
    Fresh,
    Stale,
    Expired,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyClass {
    RawSecret,
    Sensitive,
    Redacted,
    Public,
}

impl PrivacyClass {
    fn may_cross_contract_boundary(self) -> bool {
        matches!(self, Self::Redacted | Self::Public)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Starting,
    Healthy,
    Degraded,
    Unreachable,
    Expired,
    Retired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Observed,
    Authorized,
    Prepared,
    Executed,
    Acknowledged,
    Consumed,
    Progressed,
    Completed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HoldReason {
    MissingAuthority,
    UnsupportedCapability,
    IncompatibleVersion,
    MissingEvidence,
    UnsafeFallback,
    BudgetExhausted,
    LeaseUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvidenceReference {
    pub occurrence_id: String,
    pub kind: EvidenceKind,
    pub provenance: Provenance,
    pub freshness: Freshness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityBinding {
    pub capability: String,
    pub implementation: String,
    pub schema_version: u32,
    pub health: HealthState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EventEnvelope {
    pub receptor_id: String,
    pub source_instance: String,
    pub event_id: String,
    pub event_kind: String,
    pub observed_at_unix_ms: u64,
    pub provider_version: Option<String>,
    pub content_fingerprint: String,
    pub summary: String,
    pub reply_context: serde_json::Map<String, serde_json::Value>,
    pub privacy: PrivacyClass,
    pub provenance: Provenance,
}

impl EventEnvelope {
    pub fn validate(&self, max_summary_bytes: usize) -> Result<(), &'static str> {
        if self.receptor_id.trim().is_empty()
            || self.source_instance.trim().is_empty()
            || self.event_id.trim().is_empty()
            || self.event_kind.trim().is_empty()
            || self.observed_at_unix_ms == 0
            || self.content_fingerprint.trim().is_empty()
        {
            return Err("event identity, observation time, and fingerprint are required");
        }
        if !self.privacy.may_cross_contract_boundary() {
            return Err("private event payload cannot cross the Contract boundary");
        }
        if self.summary.len() > max_summary_bytes {
            return Err("event summary exceeds its bounded projection");
        }
        Ok(())
    }

    pub fn idempotency_key(&self, schema_generation: u32) -> Result<String, &'static str> {
        self.validate(4_096)?;
        if schema_generation == 0 {
            return Err("schema generation must be positive");
        }
        let material = serde_json::to_vec(&(
            &self.receptor_id,
            &self.source_instance,
            &self.event_id,
            schema_generation,
        ))
        .map_err(|_| "event identity cannot be serialized")?;
        Ok(blake3::hash(&material).to_hex().to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeCursor {
    pub receptor_id: String,
    pub resource_key: String,
    pub generation: u64,
    pub provider_token: Option<String>,
    pub content_fingerprint: String,
    pub last_observed_at_unix_ms: u64,
    pub last_changed_at_unix_ms: u64,
    pub lease_owner: String,
    pub lease_generation: u64,
    pub lease_until_unix_ms: u64,
}

impl ChangeCursor {
    pub fn compare(&self, event: &EventEnvelope) -> ChangeKind {
        if self.receptor_id != event.receptor_id || self.resource_key != event.source_instance {
            return ChangeKind::Unknown;
        }
        if self.content_fingerprint == event.content_fingerprint
            && self.provider_token == event.provider_version
        {
            ChangeKind::Unchanged
        } else {
            ChangeKind::Updated
        }
    }

    pub fn advance(
        &self,
        event: &EventEnvelope,
        owner: &str,
        lease_generation: u64,
    ) -> Result<Self, &'static str> {
        event.validate(4_096)?;
        if owner != self.lease_owner || lease_generation != self.lease_generation {
            return Err("stale cursor lease cannot advance");
        }
        let changed = self.compare(event) != ChangeKind::Unchanged;
        Ok(Self {
            receptor_id: self.receptor_id.clone(),
            resource_key: self.resource_key.clone(),
            generation: self.generation.saturating_add(1),
            provider_token: event.provider_version.clone(),
            content_fingerprint: event.content_fingerprint.clone(),
            last_observed_at_unix_ms: event.observed_at_unix_ms,
            last_changed_at_unix_ms: if changed {
                event.observed_at_unix_ms
            } else {
                self.last_changed_at_unix_ms
            },
            lease_owner: self.lease_owner.clone(),
            lease_generation: self.lease_generation,
            lease_until_unix_ms: self.lease_until_unix_ms,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransportBinding {
    pub receptor_id: String,
    pub mode: IngressMode,
    pub adapter_capability: String,
    /// Opaque secret-store handle. Never an endpoint URL or credential.
    pub endpoint_ref: String,
    pub durability: Durability,
    pub delivery: DeliverySemantics,
    pub lease_owner: String,
    pub lease_generation: u64,
    pub lease_until_unix_ms: u64,
    pub health_sensor: String,
    pub health: HealthState,
    pub cancellation_capability: String,
    pub restart_policy: String,
    pub supersedes: Option<String>,
}

impl TransportBinding {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.receptor_id.trim().is_empty()
            || self.adapter_capability.trim().is_empty()
            || self.endpoint_ref.trim().is_empty()
            || self.lease_owner.trim().is_empty()
            || self.lease_generation == 0
            || self.lease_until_unix_ms == 0
            || self.health_sensor.trim().is_empty()
            || self.cancellation_capability.trim().is_empty()
        {
            return Err("transport identity, lease, health, and cancellation are required");
        }
        if self.endpoint_ref.contains("://") {
            return Err("transport endpoint must be an opaque secret reference");
        }
        match (self.mode, self.durability) {
            (IngressMode::EphemeralTunnel, Durability::Restartable | Durability::HostedDurable)
            | (IngressMode::LocalListener, Durability::HostedDurable) => {
                Err("transport mode cannot claim stronger durability")
            }
            _ => Ok(()),
        }
    }

    pub fn may_receive(&self, owner: &str, generation: u64, now_unix_ms: u64) -> bool {
        self.validate().is_ok()
            && owner == self.lease_owner
            && generation == self.lease_generation
            && now_unix_ms < self.lease_until_unix_ms
            && matches!(self.health, HealthState::Healthy | HealthState::Degraded)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextBudget {
    pub max_bytes: u32,
    pub deadline_unix_ms: u64,
    pub max_effects: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionRole {
    User,
    Assistant,
}

/// Privacy-bounded conversation state that may cross any Contract receptor.
///
/// Provider-native message identifiers and payloads remain in the adapter. The
/// membrane carries only a stable occurrence reference and a redacted textual
/// projection so the same continuation ABI works for CLI, messaging, iOS, MCP,
/// subprocess, and future transports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionOccurrence {
    pub occurrence_id: String,
    pub role: InteractionRole,
    pub content: String,
    pub provenance: Provenance,
    pub freshness: Freshness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContinuationRequest {
    pub triggering_occurrence: Option<String>,
    pub parent_lineage: Vec<String>,
    pub normalized_input: String,
    pub identity_scope: IdentityScope,
    pub effect: EffectClass,
    pub authority: Authorization,
    pub open_obligations: Vec<String>,
    pub relevant_evidence: Vec<EvidenceReference>,
    pub contradictions: Vec<EvidenceReference>,
    pub capability_bindings: Vec<CapabilityBinding>,
    pub recent_interactions: Vec<InteractionOccurrence>,
    pub privacy: PrivacyClass,
    pub budget: ContextBudget,
    pub family: InterfaceFamily,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContinuationReadiness {
    Ready,
    DegradedReadOnly,
    Hold(HoldReason),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContractContinuation {
    pub schema_version: u32,
    pub triggering_occurrence: Option<String>,
    pub parent_lineage: Vec<String>,
    pub normalized_input: String,
    pub identity_scope: IdentityScope,
    pub effect: EffectClass,
    pub authority: Authorization,
    pub open_obligations: Vec<String>,
    pub relevant_evidence: Vec<EvidenceReference>,
    pub contradictions: Vec<EvidenceReference>,
    pub capability_bindings: Vec<CapabilityBinding>,
    pub recent_interactions: Vec<InteractionOccurrence>,
    pub privacy: PrivacyClass,
    pub budget: ContextBudget,
    pub family: InterfaceFamily,
    pub readiness: ContinuationReadiness,
    pub continuation_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationError {
    MissingInput,
    MissingIdentity,
    InvalidBudget,
    PrivatePayload,
    InvalidOccurrence,
    InvalidAuthority,
    InvalidEvidence,
    InvalidCapabilityBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedEffect {
    pub capability: String,
    pub effect: EffectClass,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContractResult {
    pub continuation_token: String,
    pub output: serde_json::Value,
    pub proposed_effects: Vec<ProposedEffect>,
    pub observations: Vec<EvidenceReference>,
    pub unresolved_obligations: Vec<String>,
    pub claimed_outcome: Outcome,
    pub evidence_references: Vec<EvidenceReference>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultValidationError {
    ContinuationMismatch,
    WorkerHeld,
    TooManyEffects,
    AuthorityExpansion,
    UnsupportedCapability,
    InvalidEvidence,
}

impl ContractContinuation {
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn resolve(request: ContinuationRequest) -> Result<Self, ContinuationError> {
        Self::validate_request(&request)?;
        let readiness = match (
            request.triggering_occurrence.is_some(),
            request.effect.consequential(),
            request.authority,
        ) {
            (true, _, Authorization::ContractAuthorized) => ContinuationReadiness::Ready,
            (false, false, Authorization::ReadOnlyDegraded) => {
                ContinuationReadiness::DegradedReadOnly
            }
            (false, true, Authorization::Hold) => {
                ContinuationReadiness::Hold(HoldReason::MissingAuthority)
            }
            _ => return Err(ContinuationError::InvalidAuthority),
        };
        let token_material = serde_json::to_vec(&(
            Self::SCHEMA_VERSION,
            &request.triggering_occurrence,
            &request.parent_lineage,
            &request.normalized_input,
            &request.identity_scope,
            request.effect,
            request.authority,
            &request.open_obligations,
            &request.relevant_evidence,
            &request.contradictions,
            &request.capability_bindings,
            &request.recent_interactions,
            request.privacy,
            request.budget,
            request.family,
            &readiness,
        ))
        .map_err(|_| ContinuationError::MissingInput)?;
        let continuation_token = blake3::hash(&token_material).to_hex().to_string();
        Ok(Self {
            schema_version: Self::SCHEMA_VERSION,
            triggering_occurrence: request.triggering_occurrence,
            parent_lineage: request.parent_lineage,
            normalized_input: request.normalized_input,
            identity_scope: request.identity_scope,
            effect: request.effect,
            authority: request.authority,
            open_obligations: request.open_obligations,
            relevant_evidence: request.relevant_evidence,
            contradictions: request.contradictions,
            capability_bindings: request.capability_bindings,
            recent_interactions: request.recent_interactions,
            privacy: request.privacy,
            budget: request.budget,
            family: request.family,
            readiness,
            continuation_token,
        })
    }

    fn validate_request(request: &ContinuationRequest) -> Result<(), ContinuationError> {
        if request.normalized_input.trim().is_empty() {
            return Err(ContinuationError::MissingInput);
        }
        if request.identity_scope.value.trim().is_empty() {
            return Err(ContinuationError::MissingIdentity);
        }
        if request.budget.max_bytes == 0
            || request.budget.max_effects == 0
            || request.budget.deadline_unix_ms == 0
        {
            return Err(ContinuationError::InvalidBudget);
        }
        if !request.privacy.may_cross_contract_boundary() {
            return Err(ContinuationError::PrivatePayload);
        }
        if request
            .triggering_occurrence
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
            || request.parent_lineage.iter().any(|id| id.trim().is_empty())
        {
            return Err(ContinuationError::InvalidOccurrence);
        }
        if request
            .relevant_evidence
            .iter()
            .chain(request.contradictions.iter())
            .any(|evidence| evidence.occurrence_id.trim().is_empty())
        {
            return Err(ContinuationError::InvalidEvidence);
        }
        if request.capability_bindings.iter().any(|binding| {
            binding.capability.trim().is_empty()
                || binding.implementation.trim().is_empty()
                || binding.schema_version == 0
        }) {
            return Err(ContinuationError::InvalidCapabilityBinding);
        }
        if request.recent_interactions.iter().any(|interaction| {
            interaction.occurrence_id.trim().is_empty()
                || interaction.content.trim().is_empty()
                || interaction.content.len() > request.budget.max_bytes as usize
        }) {
            return Err(ContinuationError::InvalidEvidence);
        }
        Ok(())
    }

    pub fn may_invoke_worker(&self) -> bool {
        !matches!(self.readiness, ContinuationReadiness::Hold(_))
    }

    pub fn validate_result(
        &self,
        result: &ContractResult,
    ) -> Result<(), ResultValidationError> {
        if result.continuation_token != self.continuation_token {
            return Err(ResultValidationError::ContinuationMismatch);
        }
        if !self.may_invoke_worker() {
            return Err(ResultValidationError::WorkerHeld);
        }
        if result.proposed_effects.len() > self.budget.max_effects as usize {
            return Err(ResultValidationError::TooManyEffects);
        }
        for proposed in &result.proposed_effects {
            if proposed.effect != self.effect {
                return Err(ResultValidationError::AuthorityExpansion);
            }
            if !self.capability_bindings.is_empty()
                && !self
                    .capability_bindings
                    .iter()
                    .any(|binding| binding.capability == proposed.capability)
            {
                return Err(ResultValidationError::UnsupportedCapability);
            }
        }
        if result
            .observations
            .iter()
            .chain(result.evidence_references.iter())
            .any(|evidence| evidence.occurrence_id.trim().is_empty())
        {
            return Err(ResultValidationError::InvalidEvidence);
        }
        Ok(())
    }
}

impl ExecutionEnvelope {
    pub fn new(
        receptor: Receptor,
        effect: EffectClass,
        contract_id: Option<String>,
        lifecycle: Option<LifecyclePolicy>,
    ) -> Result<Self, &'static str> {
        if receptor.capability.trim().is_empty() || receptor.occurrence_id.trim().is_empty() {
            return Err("typed receptor identity is required");
        }
        if effect == EffectClass::ProcessSpawn {
            lifecycle
                .as_ref()
                .ok_or("process spawn requires lifecycle policy")?
                .validate()?;
        }
        let authorization = if contract_id.is_some() {
            Authorization::ContractAuthorized
        } else if effect.consequential() {
            Authorization::Hold
        } else {
            Authorization::ReadOnlyDegraded
        };
        Ok(Self {
            receptor,
            effect,
            contract_id,
            authorization,
            executed: false,
            environment_acknowledged: false,
            progress: None,
            lifecycle,
        })
    }

    pub fn may_execute(&self) -> bool {
        self.authorization != Authorization::Hold
    }

    pub fn mark_executed(&mut self) -> Result<(), &'static str> {
        if !self.may_execute() {
            return Err("held effects cannot execute");
        }
        self.executed = true;
        Ok(())
    }

    pub fn acknowledge(&mut self) -> Result<(), &'static str> {
        if !self.executed {
            return Err("environment cannot acknowledge an unexecuted action");
        }
        self.environment_acknowledged = true;
        Ok(())
    }

    pub fn settle_progress(&mut self, progressed: bool) -> Result<(), &'static str> {
        if !self.environment_acknowledged {
            return Err("progress requires independent environment acknowledgement");
        }
        self.progress = Some(progressed);
        Ok(())
    }
}

// ── RM0: persistence model — declared vs live ────────────────────────
//
// A durable ledger declaration is the *intent* that a receptor exist. It is
// NOT a live watcher. A live watcher requires a current leased runtime owner
// (a reconciler) whose lease has not expired and whose health is
// Healthy/Degraded. Killing the reconciler drops the receptor to not-live
// while the declaration persists; restarting the reconciler rebinds the same
// receptor from its declaration without duplicating an effect. This is the
// RM0 gate: "a ledger row alone can never be reported as a live watcher."

/// The durable ledger row declaring a receptor's intent. Persists across
/// process death. Does NOT make the receptor live.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReceptorDeclaration {
    pub receptor_id: String,
    pub family: InterfaceFamily,
    pub ingress_modes: Vec<IngressMode>,
    pub delivery: DeliverySemantics,
    pub durability: Durability,
    pub lifecycle: LifecyclePolicy,
    pub effects: Vec<EffectClass>,
}

impl ReceptorDeclaration {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.receptor_id.trim().is_empty() {
            return Err("receptor_id is required");
        }
        if self.ingress_modes.is_empty() {
            return Err("at least one ingress mode is required");
        }
        // Ephemeral durability cannot claim restartable durability — a
        // transport that cannot be reconstructed must not promise it.
        if matches!(self.durability, Durability::Restartable | Durability::HostedDurable)
            && self.lifecycle.restart_owner.trim().is_empty()
        {
            return Err("restartable durability requires a reconciler (restart_owner)");
        }
        self.lifecycle.validate()?;
        Ok(())
    }
}

/// A live runtime lease held by a reconciler for one declared receptor.
/// Absent from the registry => the receptor is not live, regardless of any
/// durable declaration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveLease {
    pub owner: String,
    pub generation: u64,
    pub lease_until_unix_ms: u64,
    pub health: HealthState,
}

/// Tracks declared receptors (durable intent) separately from live leases
/// (current reconciler ownership). This is the desired-state vs
/// observed-runtime-state split RM0 requires.
#[derive(Debug, Clone, Default)]
pub struct ReceptorRegistry {
    declarations: std::collections::BTreeMap<String, ReceptorDeclaration>,
    live: std::collections::BTreeMap<String, LiveLease>,
    /// Durable high-water-mark of the lease generation ever issued per
    /// receptor. Survives `revoke` (reconciler death) so that a restart
    /// issues a strictly higher generation than the killed lease — a stale
    /// worker holding the old generation cannot then pass `may_receive` and
    /// commit effects after restart.
    last_issued_generation: std::collections::BTreeMap<String, u64>,
}

impl ReceptorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Declare a receptor's intent. Validates and persists the declaration.
    /// The receptor is NOT live after this — a ledger row alone is never a
    /// live watcher.
    pub fn declare(&mut self, decl: ReceptorDeclaration) -> Result<(), &'static str> {
        decl.validate()?;
        self.declarations.insert(decl.receptor_id.clone(), decl);
        // Declaring never inserts into `live`.
        Ok(())
    }

    /// True iff a reconciler holds a current, non-expired, healthy/degraded
    /// lease for this receptor. A declaration alone returns false.
    pub fn is_live(&self, id: &str, now_unix_ms: u64) -> bool {
        match self.live.get(id) {
            Some(lease) => {
                lease.lease_until_unix_ms > now_unix_ms
                    && matches!(lease.health, HealthState::Healthy | HealthState::Degraded)
            }
            None => false,
        }
    }

    /// A reconciler takes ownership of a declared receptor. Requires a prior
    /// declaration — runtime cannot be reconstructed from nothing. Returns the
    /// new lease generation.
    pub fn acquire_lease(
        &mut self,
        id: &str,
        owner: &str,
        now_unix_ms: u64,
        ttl_ms: u64,
    ) -> Result<u64, &'static str> {
        if owner.trim().is_empty() {
            return Err("lease owner is required");
        }
        if !self.declarations.contains_key(id) {
            return Err("cannot acquire lease: no declaration to reconstruct from");
        }
        // Monotonic generation: the new generation must exceed both the
        // currently-live generation (if any) and the durable high-water-mark
        // (so a restart after revoke invalidates stale workers from the
        // killed generation).
        let live_gen = self.live.get(id).map(|l| l.generation).unwrap_or(0);
        let high_water = self.last_issued_generation.get(id).copied().unwrap_or(0);
        let generation = live_gen.max(high_water) + 1;
        self.last_issued_generation
            .insert(id.to_string(), generation);
        self.live.insert(
            id.to_string(),
            LiveLease {
                owner: owner.to_string(),
                generation,
                lease_until_unix_ms: now_unix_ms.saturating_add(ttl_ms),
                health: HealthState::Healthy,
            },
        );
        Ok(generation)
    }

    /// Kill the reconciler for a receptor: drop its live lease. The
    /// declaration persists, so the receptor can be restarted.
    pub fn revoke(&mut self, id: &str) {
        self.live.remove(id);
    }

    /// True iff `owner`/`generation` identify the current live lease and it
    /// is current. A stale worker holding a pre-restart generation is
    /// rejected — it may append observations but cannot commit effects.
    pub fn may_commit(
        &self,
        id: &str,
        owner: &str,
        generation: u64,
        now_unix_ms: u64,
    ) -> bool {
        match self.live.get(id) {
            Some(lease) => {
                lease.owner == owner
                    && lease.generation == generation
                    && lease.lease_until_unix_ms > now_unix_ms
                    && matches!(lease.health, HealthState::Healthy | HealthState::Degraded)
            }
            None => false,
        }
    }

    /// Restart a receptor from its declaration: rebind the same receptor_id
    /// to a fresh lease. Idempotent rebind — does not create a second
    /// receptor. Returns the new generation.
    pub fn restart(
        &mut self,
        id: &str,
        owner: &str,
        now_unix_ms: u64,
        ttl_ms: u64,
    ) -> Result<u64, &'static str> {
        self.acquire_lease(id, owner, now_unix_ms, ttl_ms)
    }

    /// Idempotent reconciler pass for one receptor: if a current lease is
    /// already held by `owner`, this is a no-op (returns false — no
    /// duplicate effect); otherwise it acquires one from the declaration
    /// (returns true). Re-running reconcile on a settled receptor changes
    /// nothing.
    pub fn reconcile(
        &mut self,
        id: &str,
        owner: &str,
        now_unix_ms: u64,
        ttl_ms: u64,
    ) -> Result<bool, &'static str> {
        if let Some(lease) = self.live.get(id) {
            if lease.owner == owner && lease.lease_until_unix_ms > now_unix_ms {
                return Ok(false); // already live for this owner — no-op
            }
        }
        self.acquire_lease(id, owner, now_unix_ms, ttl_ms)?;
        Ok(true)
    }

    pub fn live_count(&self) -> usize {
        self.live.len()
    }

    pub fn declaration_count(&self) -> usize {
        self.declarations.len()
    }

    /// True if the durable declaration exists (independent of liveness).
    pub fn is_declared(&self, id: &str) -> bool {
        self.declarations.contains_key(id)
    }
}

// ── RM2: durable occurrence store + compare-and-set cursor store ──────
//
// At-least-once input + idempotent processing. The occurrence store dedups
// by the event's idempotency key (receptor/source/event_id/schema_gen); a
// replayed event is a no-op. A reused event_id with a *changed* fingerprint
// is a contradiction — retained for adapter evaluation, never silently
// processed. The cursor store advances only via compare-and-set, only after
// a durable append, and never moves backwards for out-of-order delivery.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    /// First time this event identity was seen — process it.
    New,
    /// Same identity AND same fingerprint — idempotent replay, no effect.
    Duplicate,
    /// Same identity, DIFFERENT fingerprint — reused ID with changed content.
    /// Held for adapter evaluation; the cursor is NOT advanced.
    Contradiction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContradictionRecord {
    pub receptor_id: String,
    pub source_instance: String,
    pub event_id: String,
    pub prior_fingerprint: String,
    pub new_fingerprint: String,
    pub observed_at_unix_ms: u64,
}

/// Append-only, deduplicating occurrence store. The single convergence point
/// for concurrent poller + webhook delivery of the same event.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OccurrenceStore {
    schema_generation: u32,
    /// idempotency_key -> stored content_fingerprint (the first-seen truth).
    seen: std::collections::BTreeMap<String, String>,
    contradictions: Vec<ContradictionRecord>,
    appended: u64,
}

impl OccurrenceStore {
    pub fn new(schema_generation: u32) -> Self {
        Self {
            schema_generation,
            ..Default::default()
        }
    }

    /// Append an event. Dedup is by idempotency key; a reused ID with a
    /// changed fingerprint is a contradiction (retained, not processed).
    /// Returns whether the event is new, a duplicate, or a contradiction.
    pub fn append(&mut self, event: &EventEnvelope) -> Result<AppendOutcome, &'static str> {
        let key = event.idempotency_key(self.schema_generation)?;
        match self.seen.get(&key) {
            None => {
                self.seen
                    .insert(key, event.content_fingerprint.clone());
                self.appended += 1;
                Ok(AppendOutcome::New)
            }
            Some(prior) => {
                if *prior == event.content_fingerprint {
                    Ok(AppendOutcome::Duplicate)
                } else {
                    // Reused event_id with changed content — retain as a
                    // contradiction. Do NOT overwrite the stored truth and
                    // do NOT advance any cursor.
                    self.contradictions.push(ContradictionRecord {
                        receptor_id: event.receptor_id.clone(),
                        source_instance: event.source_instance.clone(),
                        event_id: event.event_id.clone(),
                        prior_fingerprint: prior.clone(),
                        new_fingerprint: event.content_fingerprint.clone(),
                        observed_at_unix_ms: event.observed_at_unix_ms,
                    });
                    Ok(AppendOutcome::Contradiction)
                }
            }
        }
    }

    pub fn distinct_count(&self) -> u64 {
        self.appended
    }

    pub fn contradictions(&self) -> &[ContradictionRecord] {
        &self.contradictions
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvanceOutcome {
    /// The cursor moved forward (content changed).
    Advanced,
    /// Same content — no move.
    Unchanged,
    /// An older/out-of-order observation. The occurrence was appended (no
    /// event loss) but the cursor was NOT moved backward.
    StaleObservation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CursorError {
    /// No cursor installed for this receptor/resource — resync required.
    MissingCursor,
    /// The lease is expired or held by another owner/generation.
    StaleLease,
}

/// Compare-and-set cursor store. Cursors advance only after a durable
/// occurrence append and never move backwards.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CursorStore {
    cursors: std::collections::BTreeMap<(String, String), ChangeCursor>,
}

impl CursorStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, receptor_id: &str, resource_key: &str) -> Option<&ChangeCursor> {
        self.cursors
            .get(&(receptor_id.to_string(), resource_key.to_string()))
    }

    /// Install the initial cursor for a receptor/resource.
    pub fn install(&mut self, cursor: ChangeCursor) {
        self.cursors
            .insert((cursor.receptor_id.clone(), cursor.resource_key.clone()), cursor);
    }

    /// Advance the cursor for `event`'s (receptor, source) under the given
    /// lease. Compare-and-set: the cursor only moves if its generation has
    /// not changed since the read. Out-of-order (older observed_at) events
    /// are observed but do not move the cursor backward.
    pub fn advance(
        &mut self,
        event: &EventEnvelope,
        owner: &str,
        lease_generation: u64,
        now_unix_ms: u64,
    ) -> Result<AdvanceOutcome, CursorError> {
        let key = (event.receptor_id.clone(), event.source_instance.clone());
        let current = self.cursors.get(&key).ok_or(CursorError::MissingCursor)?;
        // Lease must be current and held by `owner`.
        if current.lease_owner != owner
            || current.lease_generation != lease_generation
            || current.lease_until_unix_ms <= now_unix_ms
        {
            return Err(CursorError::StaleLease);
        }
        // Out-of-order: an older observation never moves the cursor back.
        if event.observed_at_unix_ms < current.last_observed_at_unix_ms {
            return Ok(AdvanceOutcome::StaleObservation);
        }
        match current.compare(event) {
            ChangeKind::Unchanged => Ok(AdvanceOutcome::Unchanged),
            _ => {
                let advanced = current
                    .advance(event, owner, lease_generation)
                    .map_err(|_| CursorError::StaleLease)?;
                // Compare-and-set: only commit if the stored cursor is still
                // the one we read (no concurrent advance won).
                match self.cursors.get(&key) {
                    Some(still) if still.generation == current.generation => {
                        self.cursors.insert(key, advanced);
                        Ok(AdvanceOutcome::Advanced)
                    }
                    _ => Err(CursorError::StaleLease),
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.cursors.len()
    }
}

// ── RM3: generic transport registry ──────────────────────────────────
//
// Every ingress mode (poller, local listener, ephemeral/durable tunnel,
// hosted worker, provider-native webhook) is a capability bound through
// the same shape. The registry is provider-neutral: it never branches on a
// provider name (Cloudflare, ngrok, etc.) — adapters are descriptors, and
// replacing one tunnel provider with another needs only a new descriptor
// and executor. Every live binding requires a finite lease, an owner, a
// health sensor, a cancellation capability, a restart policy, and bounded
// children. Endpoints/credentials stay as opaque secret references
// (enforced by TransportBinding::validate).

/// A transport binding plus its runtime child-count bound and current count.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegisteredTransport {
    pub binding: TransportBinding,
    pub max_children: u32,
    pub child_count: u32,
}

impl RegisteredTransport {
    /// A stable identity for this binding: receptor + adapter capability +
    /// generation. Used as the supersession pointer.
    pub fn binding_id(&self) -> String {
        format!(
            "{}@{}#{}",
            self.binding.receptor_id, self.binding.adapter_capability, self.binding.lease_generation
        )
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.binding.validate()?;
        if self.max_children == 0 {
            return Err("transport child bound must be positive");
        }
        if self.child_count > self.max_children {
            return Err("transport child count exceeds its bound");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TransportRegistry {
    /// (receptor_id, adapter_capability) -> the live binding for that pair.
    bindings: std::collections::BTreeMap<(String, String), RegisteredTransport>,
    /// Supersession history: binding_id -> the binding_id it replaced.
    superseded_by: std::collections::BTreeMap<String, String>,
}

impl TransportRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a transport binding as a capability. Validates the full
    /// shape (lease/owner/health/cancellation/restart/secret-ref endpoint/
    /// mode-durability honesty/child bound). If a live binding already
    /// exists for this (receptor, adapter), the new one supersedes it — the
    /// old binding's id is recorded as superseded. Provider-neutral: no
    /// branch on adapter name.
    pub fn register(
        &mut self,
        binding: TransportBinding,
        max_children: u32,
        child_count: u32,
    ) -> Result<RegisteredTransport, &'static str> {
        let registered = RegisteredTransport {
            binding,
            max_children,
            child_count,
        };
        registered.validate()?;
        let key = (
            registered.binding.receptor_id.clone(),
            registered.binding.adapter_capability.clone(),
        );
        if let Some(prior) = self.bindings.insert(key, registered.clone()) {
            // Record supersession: the prior binding is replaced by this one.
            self.superseded_by
                .insert(prior.binding_id(), registered.binding_id());
        }
        Ok(registered)
    }

    /// Replace one adapter with another for the same receptor (e.g. swap a
    /// tunnel provider). The old adapter's binding is retired; the new one
    /// is registered. Requires only the new descriptor — no provider branch.
    pub fn replace_adapter(
        &mut self,
        receptor_id: &str,
        new_binding: TransportBinding,
        max_children: u32,
    ) -> Result<RegisteredTransport, &'static str> {
        if new_binding.receptor_id != receptor_id {
            return Err("replacement binding must target the same receptor");
        }
        // Retire any existing binding for this receptor under the OLD adapter
        // (whatever it was) before registering the new one.
        let old_adapter = new_binding.adapter_capability.clone();
        let to_retire: Vec<_> = self
            .bindings
            .keys()
            .filter(|(r, _)| r == receptor_id)
            .cloned()
            .collect();
        for (r, a) in to_retire {
            if let Some(prior) = self.bindings.remove(&(r, a)) {
                self.superseded_by
                    .insert(prior.binding_id(), new_binding.adapter_capability.clone());
            }
        }
        let _ = old_adapter; // adapter name is opaque to the registry
        self.register(new_binding, max_children, 0)
    }

    /// The effective (live, current) bindings for a receptor.
    pub fn effective(&self, receptor_id: &str) -> Vec<&RegisteredTransport> {
        self.bindings
            .iter()
            .filter(|((r, _), _)| r == receptor_id)
            .map(|(_, rt)| rt)
            .collect()
    }

    pub fn get(
        &self,
        receptor_id: &str,
        adapter_capability: &str,
    ) -> Option<&RegisteredTransport> {
        self.bindings
            .get(&(receptor_id.to_string(), adapter_capability.to_string()))
    }

    /// Retire a binding: remove it from the live set. Its supersession
    /// history is retained.
    pub fn retire(&mut self, receptor_id: &str, adapter_capability: &str) {
        self.bindings
            .remove(&(receptor_id.to_string(), adapter_capability.to_string()));
    }

    /// True iff a live binding for this (receptor, adapter) may receive at
    /// `now_unix_ms` under `owner`/`generation`.
    pub fn may_receive(
        &self,
        receptor_id: &str,
        adapter_capability: &str,
        owner: &str,
        generation: u64,
        now_unix_ms: u64,
    ) -> bool {
        match self.get(receptor_id, adapter_capability) {
            Some(rt) => rt.binding.may_receive(owner, generation, now_unix_ms),
            None => false,
        }
    }

    pub fn binding_count(&self) -> usize {
        self.bindings.len()
    }

    pub fn supersession_count(&self) -> usize {
        self.superseded_by.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receptor(family: InterfaceFamily) -> Receptor {
        Receptor {
            family,
            capability: "example.action".into(),
            occurrence_id: "occurrence-1".into(),
        }
    }

    #[test]
    fn every_interface_family_uses_the_same_state_machine() {
        for family in [
            InterfaceFamily::Cli,
            InterfaceFamily::Tui,
            InterfaceFamily::Mcp,
            InterfaceFamily::Messaging,
            InterfaceFamily::Ios,
            InterfaceFamily::Subprocess,
            InterfaceFamily::Api,
        ] {
            let read = ExecutionEnvelope::new(receptor(family), EffectClass::ReadOnly, None, None)
                .unwrap();
            assert!(read.may_execute());
            let write =
                ExecutionEnvelope::new(receptor(family), EffectClass::LocalWrite, None, None)
                    .unwrap();
            assert!(!write.may_execute());
        }
    }

    #[test]
    fn execution_acknowledgement_and_progress_are_distinct() {
        let mut envelope = ExecutionEnvelope::new(
            receptor(InterfaceFamily::Messaging),
            EffectClass::ExternalMessage,
            Some("contract-1".into()),
            None,
        )
        .unwrap();
        assert!(envelope.acknowledge().is_err());
        envelope.mark_executed().unwrap();
        assert_eq!(envelope.progress, None);
        envelope.acknowledge().unwrap();
        assert_eq!(envelope.progress, None);
        envelope.settle_progress(false).unwrap();
        assert_eq!(envelope.progress, Some(false));
    }

    #[test]
    fn process_spawn_requires_bounded_owned_lifecycle() {
        assert!(
            ExecutionEnvelope::new(
                receptor(InterfaceFamily::Subprocess),
                EffectClass::ProcessSpawn,
                Some("contract-1".into()),
                None,
            )
            .is_err()
        );
        let lifecycle = LifecyclePolicy {
            lease_ms: 30_000,
            health_sensor: "pid-and-heartbeat".into(),
            cancellation_capability: "process.cancel".into(),
            restart_owner: "contract:root".into(),
            max_restarts: 3,
            max_children: 4,
        };
        let envelope = ExecutionEnvelope::new(
            receptor(InterfaceFamily::Subprocess),
            EffectClass::ProcessSpawn,
            Some("contract-1".into()),
            Some(lifecycle),
        )
        .unwrap();
        assert!(envelope.may_execute());
    }

    fn continuation_request(
        family: InterfaceFamily,
        effect: EffectClass,
        contract_id: Option<&str>,
    ) -> ContinuationRequest {
        ContinuationRequest {
            triggering_occurrence: contract_id.map(str::to_owned),
            parent_lineage: vec!["parent-1".into()],
            normalized_input: "continue the scoped work".into(),
            identity_scope: IdentityScope {
                kind: IdentityKind::Conversation,
                value: "conversation-1".into(),
            },
            effect,
            authority: if contract_id.is_some() {
                Authorization::ContractAuthorized
            } else if effect.consequential() {
                Authorization::Hold
            } else {
                Authorization::ReadOnlyDegraded
            },
            open_obligations: vec!["reply to the triggering occurrence".into()],
            relevant_evidence: vec![EvidenceReference {
                occurrence_id: "evidence-1".into(),
                kind: EvidenceKind::IndependentSensor,
                provenance: Provenance::DurableLedger,
                freshness: Freshness::Fresh,
            }],
            contradictions: vec![],
            capability_bindings: vec![CapabilityBinding {
                capability: "conversation.respond".into(),
                implementation: "fixture.worker".into(),
                schema_version: 1,
                health: HealthState::Healthy,
            }],
            recent_interactions: vec![InteractionOccurrence {
                occurrence_id: "message-1".into(),
                role: InteractionRole::User,
                content: "prior bounded message".into(),
                provenance: Provenance::DurableLedger,
                freshness: Freshness::Fresh,
            }],
            privacy: PrivacyClass::Redacted,
            budget: ContextBudget {
                max_bytes: 8_192,
                deadline_unix_ms: 4_000_000_000_000,
                max_effects: 2,
            },
            family,
        }
    }

    #[test]
    fn continuation_is_deterministic_and_bound_to_occurrence_and_identity() {
        let request = continuation_request(
            InterfaceFamily::Messaging,
            EffectClass::ExternalMessage,
            Some("deadbeef"),
        );
        let first = ContractContinuation::resolve(request.clone()).unwrap();
        let second = ContractContinuation::resolve(request).unwrap();
        assert_eq!(first.continuation_token, second.continuation_token);
        assert_eq!(first.readiness, ContinuationReadiness::Ready);

        let mut other = continuation_request(
            InterfaceFamily::Messaging,
            EffectClass::ExternalMessage,
            Some("deadbeef"),
        );
        other.identity_scope.value = "conversation-2".into();
        let other = ContractContinuation::resolve(other).unwrap();
        assert_ne!(first.continuation_token, other.continuation_token);
    }

    #[test]
    fn unavailable_contract_degrades_reads_but_holds_consequential_workers() {
        let read = ContractContinuation::resolve(continuation_request(
            InterfaceFamily::Api,
            EffectClass::ReadOnly,
            None,
        ))
        .unwrap();
        assert_eq!(
            read.readiness,
            ContinuationReadiness::DegradedReadOnly
        );
        assert!(read.may_invoke_worker());

        let write = ContractContinuation::resolve(continuation_request(
            InterfaceFamily::Messaging,
            EffectClass::ExternalMessage,
            None,
        ))
        .unwrap();
        assert_eq!(
            write.readiness,
            ContinuationReadiness::Hold(HoldReason::MissingAuthority)
        );
        assert!(!write.may_invoke_worker());
    }

    #[test]
    fn result_must_match_continuation_and_cannot_expand_authority() {
        let continuation = ContractContinuation::resolve(continuation_request(
            InterfaceFamily::Messaging,
            EffectClass::ExternalMessage,
            Some("deadbeef"),
        ))
        .unwrap();
        let accepted = ContractResult {
            continuation_token: continuation.continuation_token.clone(),
            output: serde_json::json!({"reply": "bounded"}),
            proposed_effects: vec![ProposedEffect {
                capability: "conversation.respond".into(),
                effect: EffectClass::ExternalMessage,
            }],
            observations: vec![],
            unresolved_obligations: vec![],
            claimed_outcome: Outcome::Prepared,
            evidence_references: vec![],
            errors: vec![],
        };
        assert!(continuation.validate_result(&accepted).is_ok());

        let mut forged = accepted.clone();
        forged.continuation_token = "forged".into();
        assert_eq!(
            continuation.validate_result(&forged),
            Err(ResultValidationError::ContinuationMismatch)
        );

        let mut widened = accepted;
        widened.proposed_effects[0].effect = EffectClass::Purchase;
        assert_eq!(
            continuation.validate_result(&widened),
            Err(ResultValidationError::AuthorityExpansion)
        );
    }

    fn event(fingerprint: &str) -> EventEnvelope {
        EventEnvelope {
            receptor_id: "message-inbound".into(),
            source_instance: "conversation-1".into(),
            event_id: "provider-event-7".into(),
            event_kind: "message.received".into(),
            observed_at_unix_ms: 10_000,
            provider_version: Some("v7".into()),
            content_fingerprint: fingerprint.into(),
            summary: "bounded message summary".into(),
            reply_context: serde_json::Map::new(),
            privacy: PrivacyClass::Redacted,
            provenance: Provenance::LiveProvider,
        }
    }

    #[test]
    fn event_idempotency_is_provider_neutral_and_privacy_gated() {
        let first = event("digest-a");
        let mut duplicate = first.clone();
        duplicate.summary = "a different projection of the same event".into();
        assert_eq!(
            first.idempotency_key(2).unwrap(),
            duplicate.idempotency_key(2).unwrap()
        );
        duplicate.event_id = "provider-event-8".into();
        assert_ne!(
            first.idempotency_key(2).unwrap(),
            duplicate.idempotency_key(2).unwrap()
        );
        let mut secret = first;
        secret.privacy = PrivacyClass::RawSecret;
        assert!(secret.idempotency_key(2).is_err());
    }

    #[test]
    fn cursor_advancement_requires_current_lease_and_separates_change() {
        let cursor = ChangeCursor {
            receptor_id: "message-inbound".into(),
            resource_key: "conversation-1".into(),
            generation: 4,
            provider_token: Some("v7".into()),
            content_fingerprint: "digest-a".into(),
            last_observed_at_unix_ms: 9_000,
            last_changed_at_unix_ms: 8_000,
            lease_owner: "runtime-1".into(),
            lease_generation: 3,
            lease_until_unix_ms: 20_000,
        };
        assert_eq!(cursor.compare(&event("digest-a")), ChangeKind::Unchanged);
        assert!(
            cursor
                .advance(&event("digest-b"), "stale-runtime", 3)
                .is_err()
        );
        let advanced = cursor
            .advance(&event("digest-b"), "runtime-1", 3)
            .unwrap();
        assert_eq!(advanced.generation, 5);
        assert_eq!(advanced.last_changed_at_unix_ms, 10_000);
    }

    #[test]
    fn transport_cannot_lie_about_durability_or_expose_endpoint() {
        let mut binding = TransportBinding {
            receptor_id: "message-inbound".into(),
            mode: IngressMode::EphemeralTunnel,
            adapter_capability: "transport.tunnel.ephemeral".into(),
            endpoint_ref: "secret-ref:transport-endpoint-1".into(),
            durability: Durability::Leased,
            delivery: DeliverySemantics::AtLeastOnce,
            lease_owner: "runtime-1".into(),
            lease_generation: 2,
            lease_until_unix_ms: 20_000,
            health_sensor: "transport-health-v1".into(),
            health: HealthState::Healthy,
            cancellation_capability: "transport.retire".into(),
            restart_policy: "on-failure".into(),
            supersedes: None,
        };
        assert!(binding.validate().is_ok());
        assert!(binding.may_receive("runtime-1", 2, 10_000));
        assert!(!binding.may_receive("runtime-1", 1, 10_000));
        binding.durability = Durability::HostedDurable;
        assert!(binding.validate().is_err());
        binding.durability = Durability::Leased;
        binding.endpoint_ref = "https://public.example/webhook".into();
        assert!(binding.validate().is_err());
    }

    // ── RM0: persistence model — declared vs live ───────────────────

    fn test_declaration(id: &str, durability: Durability) -> ReceptorDeclaration {
        ReceptorDeclaration {
            receptor_id: id.into(),
            family: InterfaceFamily::Messaging,
            ingress_modes: vec![IngressMode::Poll, IngressMode::EphemeralTunnel],
            delivery: DeliverySemantics::AtLeastOnce,
            durability,
            lifecycle: LifecyclePolicy {
                lease_ms: 60_000,
                health_sensor: "transport-health-v1".into(),
                cancellation_capability: "transport.retire".into(),
                restart_owner: "reconciler-1".into(),
                max_restarts: 3,
                max_children: 4,
            },
            effects: vec![EffectClass::ReadOnly],
        }
    }

    #[test]
    fn rm0_ledger_row_alone_is_never_a_live_watcher() {
        // The RM0 gate: a durable declaration, with no reconciler holding a
        // current lease, must NOT be reportable as live.
        let mut reg = ReceptorRegistry::new();
        reg.declare(test_declaration("msg-in", Durability::Leased))
            .expect("declare");
        assert!(reg.is_declared("msg-in"));
        assert!(!reg.is_live("msg-in", 1_000), "a ledger row alone is not live");
        assert_eq!(reg.live_count(), 0);
        assert_eq!(reg.declaration_count(), 1);
    }

    #[test]
    fn rm0_acquire_lease_makes_live_and_revoke_drops_to_not_live() {
        let mut reg = ReceptorRegistry::new();
        reg.declare(test_declaration("msg-in", Durability::Leased))
            .expect("declare");
        let lease_gen = reg
            .acquire_lease("msg-in", "reconciler-1", 1_000, 60_000)
            .expect("acquire");
        assert_eq!(lease_gen, 1);
        assert!(reg.is_live("msg-in", 1_000));
        assert_eq!(reg.live_count(), 1);
        // Kill the reconciler.
        reg.revoke("msg-in");
        assert!(!reg.is_live("msg-in", 1_000), "killed reconciler -> not live");
        assert!(reg.is_declared("msg-in"), "declaration persists across kill");
        assert_eq!(reg.live_count(), 0);
    }

    #[test]
    fn rm0_restart_recovers_from_declaration_without_duplicating_effect() {
        // Kill + restart recovers the SAME receptor from its declaration; no
        // second receptor is created, and re-reconciling an already-live
        // receptor is a no-op (no duplicate effect).
        let mut reg = ReceptorRegistry::new();
        reg.declare(test_declaration("msg-in", Durability::Restartable))
            .expect("declare");
        let _ = reg
            .acquire_lease("msg-in", "reconciler-1", 1_000, 60_000)
            .expect("acquire");
        assert_eq!(reg.live_count(), 1);

        // Kill the reconciler.
        reg.revoke("msg-in");
        assert!(!reg.is_live("msg-in", 1_000));

        // Restart from the declaration — same receptor_id, still one live.
        let lease_gen = reg
            .restart("msg-in", "reconciler-1", 2_000, 60_000)
            .expect("restart");
        assert!(lease_gen > 1, "restart advances the generation");
        assert!(reg.is_live("msg-in", 2_000));
        assert_eq!(reg.live_count(), 1, "restart must not create a duplicate receptor");

        // Re-running reconcile on the already-live receptor is a no-op.
        let rebound = reg
            .reconcile("msg-in", "reconciler-1", 2_000, 60_000)
            .expect("reconcile");
        assert!(!rebound, "idempotent reconcile is a no-op on a live receptor");
        assert_eq!(reg.live_count(), 1, "re-reconcile must not duplicate an effect");
    }

    #[test]
    fn rm0_cannot_acquire_lease_for_undeclared_receptor() {
        // Runtime cannot be reconstructed from nothing — a reconciler cannot
        // take ownership of a receptor with no durable declaration.
        let mut reg = ReceptorRegistry::new();
        let err = reg
            .acquire_lease("never-declared", "reconciler-1", 1_000, 60_000)
            .unwrap_err();
        assert!(err.contains("no declaration"), "{err}");
        assert_eq!(reg.live_count(), 0);
    }

    #[test]
    fn rm0_expired_lease_is_not_live() {
        let mut reg = ReceptorRegistry::new();
        reg.declare(test_declaration("msg-in", Durability::Leased))
            .expect("declare");
        let _ = reg
            .acquire_lease("msg-in", "reconciler-1", 1_000, 60_000)
            .expect("acquire");
        assert!(reg.is_live("msg-in", 1_000));
        // After the lease expires, the receptor is not live even though the
        // reconciler was never explicitly killed.
        assert!(!reg.is_live("msg-in", 70_000), "expired lease -> not live");
    }

    #[test]
    fn rm0_restartable_durability_requires_a_reconciler() {
        // Reject `durable: true` when no reconciler can reconstruct the
        // runtime: a Restartable declaration with no restart_owner is invalid.
        let mut decl = test_declaration("msg-in", Durability::Restartable);
        decl.lifecycle.restart_owner = String::new();
        let err = decl.validate().unwrap_err();
        assert!(err.contains("reconciler") || err.contains("restart_owner"), "{err}");
    }

    #[test]
    fn rm0_stale_worker_cannot_commit_after_restart() {
        // The reason generations are monotonic across revoke/restart: a
        // worker holding the killed generation must not be able to commit
        // effects after the reconciler restarts under a new generation.
        let mut reg = ReceptorRegistry::new();
        reg.declare(test_declaration("msg-in", Durability::Restartable))
            .expect("declare");
        let killed_gen = reg
            .acquire_lease("msg-in", "reconciler-1", 1_000, 60_000)
            .expect("acquire");
        assert_eq!(killed_gen, 1);
        assert!(reg.may_commit("msg-in", "reconciler-1", killed_gen, 1_000));

        // Kill and restart under a strictly higher generation.
        reg.revoke("msg-in");
        let live_gen = reg
            .restart("msg-in", "reconciler-1", 2_000, 60_000)
            .expect("restart");
        assert!(live_gen > killed_gen);

        // The stale worker (killed_gen) cannot commit; the current one can.
        assert!(
            !reg.may_commit("msg-in", "reconciler-1", killed_gen, 2_000),
            "stale generation must not commit after restart"
        );
        assert!(reg.may_commit("msg-in", "reconciler-1", live_gen, 2_000));
    }

    // ── RM2: occurrence dedup + compare-and-set cursor ───────────────

    fn evt(receptor: &str, source: &str, id: &str, fp: &str, at: u64) -> EventEnvelope {
        EventEnvelope {
            receptor_id: receptor.into(),
            source_instance: source.into(),
            event_id: id.into(),
            event_kind: "message".into(),
            observed_at_unix_ms: at,
            provider_version: Some(format!("v{at}")),
            content_fingerprint: fp.into(),
            summary: "redacted".into(),
            reply_context: serde_json::Map::new(),
            privacy: PrivacyClass::Redacted,
            provenance: Provenance::LiveProvider,
        }
    }

    fn cursor_for(receptor: &str, source: &str, owner: &str, lease_gen: u64, until: u64) -> ChangeCursor {
        ChangeCursor {
            receptor_id: receptor.into(),
            resource_key: source.into(),
            generation: 1,
            provider_token: Some("v1".into()),
            content_fingerprint: "fp-1".into(),
            last_observed_at_unix_ms: 1_000,
            last_changed_at_unix_ms: 1_000,
            lease_owner: owner.into(),
            lease_generation: lease_gen,
            lease_until_unix_ms: until,
        }
    }

    /// Build a cursor that represents "we last observed this event" — its
    /// fingerprint, token, and observed_at match the event, so compare()
    /// against the same event returns Unchanged.
    fn cursor_from(e: &EventEnvelope, owner: &str, lease_gen: u64, until: u64) -> ChangeCursor {
        ChangeCursor {
            receptor_id: e.receptor_id.clone(),
            resource_key: e.source_instance.clone(),
            generation: 1,
            provider_token: e.provider_version.clone(),
            content_fingerprint: e.content_fingerprint.clone(),
            last_observed_at_unix_ms: e.observed_at_unix_ms,
            last_changed_at_unix_ms: e.observed_at_unix_ms,
            lease_owner: owner.into(),
            lease_generation: lease_gen,
            lease_until_unix_ms: until,
        }
    }

    #[test]
    fn rm2_replay_is_idempotent_no_duplicate_effect() {
        // Replay: the same event delivered twice produces one occurrence and
        // no duplicate effect.
        let mut store = OccurrenceStore::new(1);
        let e = evt("msg-in", "tg-1", "evt-1", "fp-a", 1_000);
        assert_eq!(store.append(&e).unwrap(), AppendOutcome::New);
        assert_eq!(store.append(&e).unwrap(), AppendOutcome::Duplicate);
        assert_eq!(store.distinct_count(), 1, "replay must not add an occurrence");
        assert!(store.contradictions().is_empty());
    }

    #[test]
    fn rm2_race_poller_and_webhook_converge_on_one_occurrence() {
        // Concurrent poller + webhook delivery of the same event converges.
        let mut store = OccurrenceStore::new(1);
        let e = evt("msg-in", "tg-1", "evt-1", "fp-a", 1_000);
        // Simultaneous delivery from two transports.
        let a = store.append(&e).unwrap();
        let b = store.append(&e).unwrap();
        assert_eq!(a, AppendOutcome::New);
        assert_eq!(b, AppendOutcome::Duplicate);
        assert_eq!(store.distinct_count(), 1);
    }

    #[test]
    fn rm2_reused_event_id_with_changed_content_is_a_contradiction() {
        // A reused event_id with a changed fingerprint is retained as a
        // contradiction and NOT processed as new.
        let mut store = OccurrenceStore::new(1);
        let first = evt("msg-in", "tg-1", "evt-1", "fp-a", 1_000);
        let changed = evt("msg-in", "tg-1", "evt-1", "fp-B", 2_000);
        assert_eq!(store.append(&first).unwrap(), AppendOutcome::New);
        assert_eq!(store.append(&changed).unwrap(), AppendOutcome::Contradiction);
        assert_eq!(store.distinct_count(), 1, "contradiction must not add an occurrence");
        assert_eq!(store.contradictions().len(), 1);
        assert_eq!(store.contradictions()[0].prior_fingerprint, "fp-a");
        assert_eq!(store.contradictions()[0].new_fingerprint, "fp-B");
    }

    #[test]
    fn rm2_cursor_advances_only_on_changed_content() {
        let mut cursors = CursorStore::new();
        let mut store = OccurrenceStore::new(1);

        // Unchanged content — cursor does not move. Install a cursor that
        // matches the event we last observed (same fingerprint/token).
        let same = evt("msg-in", "tg-1", "evt-1", "fp-1", 2_000);
        cursors.install(cursor_from(&same, "r-1", 7, 60_000));
        assert_eq!(store.append(&same).unwrap(), AppendOutcome::New);
        assert_eq!(
            cursors.advance(&same, "r-1", 7, 2_000).unwrap(),
            AdvanceOutcome::Unchanged
        );
        assert_eq!(cursors.get("msg-in", "tg-1").unwrap().generation, 1);

        // Changed content — cursor advances, generation bumps.
        let changed = evt("msg-in", "tg-1", "evt-2", "fp-2", 3_000);
        assert_eq!(store.append(&changed).unwrap(), AppendOutcome::New);
        assert_eq!(
            cursors.advance(&changed, "r-1", 7, 3_000).unwrap(),
            AdvanceOutcome::Advanced
        );
        assert_eq!(cursors.get("msg-in", "tg-1").unwrap().generation, 2);
    }

    #[test]
    fn rm2_out_of_order_event_does_not_move_cursor_backward() {
        // An older observation is appended (no event loss) but the cursor
        // is not moved backward.
        let mut cursors = CursorStore::new();
        let mut store = OccurrenceStore::new(1);
        cursors.install(cursor_for("msg-in", "tg-1", "r-1", 7, 60_000));

        // A newer event advances the cursor first.
        let newer = evt("msg-in", "tg-1", "evt-2", "fp-2", 5_000);
        assert_eq!(store.append(&newer).unwrap(), AppendOutcome::New);
        assert_eq!(
            cursors.advance(&newer, "r-1", 7, 5_000).unwrap(),
            AdvanceOutcome::Advanced
        );
        assert_eq!(cursors.get("msg-in", "tg-1").unwrap().last_observed_at_unix_ms, 5_000);

        // An older, different event arrives out of order — observed, no
        // backward move.
        let older = evt("msg-in", "tg-1", "evt-1", "fp-old", 2_000);
        assert_eq!(store.append(&older).unwrap(), AppendOutcome::New);
        assert_eq!(
            cursors.advance(&older, "r-1", 7, 6_000).unwrap(),
            AdvanceOutcome::StaleObservation
        );
        assert_eq!(
            cursors.get("msg-in", "tg-1").unwrap().last_observed_at_unix_ms,
            5_000,
            "cursor must not move backward"
        );
    }

    #[test]
    fn rm2_stale_lease_cannot_advance_cursor() {
        // An expired lease or wrong owner/generation cannot advance the cursor.
        let mut cursors = CursorStore::new();
        cursors.install(cursor_for("msg-in", "tg-1", "r-1", 7, 60_000));
        let changed = evt("msg-in", "tg-1", "evt-2", "fp-2", 3_000);
        // Wrong owner.
        assert_eq!(
            cursors.advance(&changed, "r-other", 7, 3_000),
            Err(CursorError::StaleLease)
        );
        // Wrong generation.
        assert_eq!(
            cursors.advance(&changed, "r-1", 6, 3_000),
            Err(CursorError::StaleLease)
        );
        // Expired lease.
        assert_eq!(
            cursors.advance(&changed, "r-1", 7, 70_000),
            Err(CursorError::StaleLease)
        );
    }

    #[test]
    fn rm2_advance_requires_a_cursor_resync_if_missing() {
        // No cursor installed — a bounded resync is required, not an
        // unbounded replay.
        let mut cursors = CursorStore::new();
        let e = evt("msg-in", "tg-1", "evt-1", "fp-1", 1_000);
        assert_eq!(
            cursors.advance(&e, "r-1", 7, 1_000),
            Err(CursorError::MissingCursor)
        );
    }

    #[test]
    fn rm2_restart_replay_still_dedups_after_serialization() {
        // The occurrence store is reconstructable: after a "restart" (round-
        // trip through serialization), a replayed event is still a duplicate.
        let mut store = OccurrenceStore::new(1);
        let e = evt("msg-in", "tg-1", "evt-1", "fp-a", 1_000);
        assert_eq!(store.append(&e).unwrap(), AppendOutcome::New);
        let serialized = serde_json::to_string(&store).unwrap();
        let mut restored: OccurrenceStore = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            restored.append(&e).unwrap(),
            AppendOutcome::Duplicate,
            "replay after restart must still dedup"
        );
        assert_eq!(restored.distinct_count(), 1);
    }

    // ── RM3: generic transport registry (provider-neutral) ───────────

    fn transport(
        receptor: &str,
        adapter: &str,
        mode: IngressMode,
        durability: Durability,
        owner: &str,
        generation: u64,
        until: u64,
    ) -> TransportBinding {
        TransportBinding {
            receptor_id: receptor.into(),
            mode,
            adapter_capability: adapter.into(),
            endpoint_ref: "secret-ref:endpoint-1".into(),
            durability,
            delivery: DeliverySemantics::AtLeastOnce,
            lease_owner: owner.into(),
            lease_generation: generation,
            lease_until_unix_ms: until,
            health_sensor: "transport-health-v1".into(),
            health: HealthState::Healthy,
            cancellation_capability: "transport.retire".into(),
            restart_policy: "on-failure".into(),
            supersedes: None,
        }
    }

    #[test]
    fn rm3_register_requires_full_lifecycle_shape() {
        // Every live binding requires lease/owner/health/cancellation/restart
        // and a positive child bound. Missing any is rejected.
        let mut reg = TransportRegistry::new();
        let good = transport("msg-in", "poller-1", IngressMode::Poll, Durability::Leased, "r-1", 1, 60_000);
        assert!(reg.register(good, 4, 0).is_ok());

        // Zero child bound rejected.
        let bad = transport("msg-in", "poller-2", IngressMode::Poll, Durability::Leased, "r-1", 1, 60_000);
        assert!(reg.register(bad, 0, 0).is_err());

        // Invalid binding (endpoint URL, not a secret ref) rejected.
        let mut leaked = transport("msg-in", "poller-3", IngressMode::Poll, Durability::Leased, "r-1", 1, 60_000);
        leaked.endpoint_ref = "https://public.example/hook".into();
        assert!(reg.register(leaked, 4, 0).is_err());

        // Mode-durability dishonesty rejected (ephemeral cannot be restartable).
        let mut lying = transport("msg-in", "tunnel-1", IngressMode::EphemeralTunnel, Durability::Restartable, "r-1", 1, 60_000);
        assert!(reg.register(lying.clone(), 4, 0).is_err());
        lying.durability = Durability::Leased;
        assert!(reg.register(lying, 4, 0).is_ok());
    }

    #[test]
    fn rm3_replacing_a_tunnel_provider_needs_only_a_new_descriptor() {
        // The RM3 gate: replacing one tunnel provider with another requires
        // only a new adapter descriptor and executor — no provider branch in
        // the registry. Two unrelated adapter names bind the same receptor
        // through the identical shape.
        let mut reg = TransportRegistry::new();
        let alpha = transport("msg-in", "tunnel-alpha", IngressMode::EphemeralTunnel, Durability::Leased, "r-1", 1, 60_000);
        let beta = transport("msg-in", "tunnel-beta", IngressMode::EphemeralTunnel, Durability::Leased, "r-1", 1, 60_000);
        assert!(reg.register(alpha, 4, 0).is_ok());
        assert!(reg.register(beta, 4, 0).is_ok());
        // Both adapters are live for the same receptor — provider-neutral.
        assert_eq!(reg.effective("msg-in").len(), 2);
        assert!(reg.get("msg-in", "tunnel-alpha").is_some());
        assert!(reg.get("msg-in", "tunnel-beta").is_some());
        // Replacing alpha with a fresh generation supersedes the old one.
        let alpha2 = transport("msg-in", "tunnel-alpha", IngressMode::EphemeralTunnel, Durability::Leased, "r-1", 2, 60_000);
        let replaced = reg.register(alpha2, 4, 0).unwrap();
        assert_eq!(replaced.binding.lease_generation, 2);
        assert_eq!(reg.supersession_count(), 1, "the prior alpha is superseded");
        // Still two distinct adapters live.
        assert_eq!(reg.effective("msg-in").len(), 2);
    }

    #[test]
    fn rm3_retire_drops_liveness_but_keeps_supersession_history() {
        let mut reg = TransportRegistry::new();
        let b = transport("msg-in", "poller-1", IngressMode::Poll, Durability::Leased, "r-1", 1, 60_000);
        let _ = reg.register(b, 4, 0).unwrap();
        assert!(reg.may_receive("msg-in", "poller-1", "r-1", 1, 1_000));
        reg.retire("msg-in", "poller-1");
        assert!(!reg.may_receive("msg-in", "poller-1", "r-1", 1, 1_000));
        assert_eq!(reg.binding_count(), 0);
    }

    #[test]
    fn rm3_replace_adapter_swaps_provider_without_branching() {
        // swap_adapter: retire whatever adapter was live for a receptor and
        // register a new one, by descriptor alone.
        let mut reg = TransportRegistry::new();
        let poller = transport("msg-in", "poller-1", IngressMode::Poll, Durability::Leased, "r-1", 1, 60_000);
        let _ = reg.register(poller, 4, 0).unwrap();
        assert_eq!(reg.effective("msg-in").len(), 1);

        // Promote to an ephemeral tunnel under a different adapter name.
        let tunnel = transport("msg-in", "tunnel-alpha", IngressMode::EphemeralTunnel, Durability::Leased, "r-1", 1, 60_000);
        let _ = reg.replace_adapter("msg-in", tunnel, 4).unwrap();
        assert_eq!(reg.effective("msg-in").len(), 1, "old adapter retired, new one live");
        assert!(reg.get("msg-in", "poller-1").is_none());
        assert!(reg.get("msg-in", "tunnel-alpha").is_some());
    }

    #[test]
    fn rm3_child_count_bound_is_enforced() {
        let mut reg = TransportRegistry::new();
        let b = transport("msg-in", "poller-1", IngressMode::Poll, Durability::Leased, "r-1", 1, 60_000);
        // child_count exceeding max_children is rejected at registration.
        assert!(reg.register(b.clone(), 2, 3).is_err());
        // Within bound is accepted.
        assert!(reg.register(b, 2, 2).is_ok());
    }
}
