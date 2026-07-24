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
}
