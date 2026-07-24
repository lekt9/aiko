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
}
