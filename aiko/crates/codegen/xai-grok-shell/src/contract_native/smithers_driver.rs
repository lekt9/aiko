//! Operational Smithers bridge. Contract remains the only readiness and
//! settlement authority; this module only verifies an immutable lease
//! descriptor and invokes the production GraphHarness Cell sidecar.

use super::graph_harness_cell::{
    CellAdapterError, CellExecutionRequest, CellNodeEvidence, CellSidecar,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmithersExecutionPins {
    pub root_id: String,
    pub occurrence_id: String,
    pub execution_id: String,
    pub attempt: u32,
    pub fence: u64,
    pub graph_digest: String,
    pub node_digest: String,
    pub input_digest: String,
    pub source_digest: String,
    pub cell_package_digest: String,
    pub cell_manifest_digest: String,
    pub limb_digest: String,
    pub attachment_generation: String,
    pub credential_generation: String,
    pub credential_scope_digest: String,
    pub firing_id: String,
    pub effect_id: String,
    pub verified_subject: String,
    pub verified_scope_digest: String,
    pub verified_request_digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmithersCellInvocation {
    pub descriptor_digest: String,
    pub pins: SmithersExecutionPins,
    pub cell_request: CellExecutionRequest,
}

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl SmithersCellInvocation {
    pub fn validate(&self) -> Result<(), CellAdapterError> {
        let p = &self.pins;
        if p.attempt == 0 || p.fence == 0 || !digest(&self.descriptor_digest) {
            return Err(CellAdapterError::Profile(
                "Smithers descriptor has no fenced identity".into(),
            ));
        }
        let digests = [
            &p.graph_digest,
            &p.node_digest,
            &p.input_digest,
            &p.source_digest,
            &p.cell_package_digest,
            &p.cell_manifest_digest,
            &p.limb_digest,
            &p.credential_scope_digest,
            &p.verified_scope_digest,
            &p.verified_request_digest,
        ];
        if digests.iter().any(|value| !digest(value)) {
            return Err(CellAdapterError::Profile(
                "Smithers descriptor contains an unpinned identity".into(),
            ));
        }
        if [
            &p.root_id,
            &p.occurrence_id,
            &p.execution_id,
            &p.attachment_generation,
            &p.credential_generation,
            &p.firing_id,
            &p.effect_id,
            &p.verified_subject,
        ]
        .iter()
        .any(|value| value.is_empty())
        {
            return Err(CellAdapterError::Profile(
                "Smithers descriptor contains an empty identity".into(),
            ));
        }
        if !p
            .graph_digest
            .eq_ignore_ascii_case(&self.cell_request.graph_transitive_digest)
            || p.cell_package_digest.to_ascii_lowercase()
                != self.cell_request.cell.digest.value.to_ascii_lowercase()
            || !p
                .cell_manifest_digest
                .eq_ignore_ascii_case(&self.cell_request.cell_digest)
        {
            return Err(CellAdapterError::Profile(
                "Smithers descriptor and GraphHarness Cell request are not cross-pinned".into(),
            ));
        }
        Ok(())
    }
}

/// Invoke the actual pinned GraphHarness Cell. The caller must ask Contract to
/// revalidate `descriptor_digest` and every pin immediately before its one
/// fenced settlement; this function deliberately has no settlement authority.
pub async fn invoke_smithers_graph_harness_cell(
    sidecar: &CellSidecar,
    invocation: SmithersCellInvocation,
) -> Result<CellNodeEvidence, CellAdapterError> {
    invocation.validate()?;
    sidecar.execute(invocation.cell_request).await
}
