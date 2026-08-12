//! Pinned `cell/v0` sidecar adapter for the GraphHarness primary profile.
//!
//! This module deliberately does not schedule graph nodes.  It executes one
//! already-leased node and returns evidence for the Neuron/Contract bridge.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tempfile::Builder;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const CONFIG_LIMIT: usize = 256 * 1024;
const MATERIAL_LIMIT: usize = 16 * 1024 * 1024;
const MATERIAL_COUNT_LIMIT: usize = 256;
const INPUT_LIMIT: usize = 2 * 1024 * 1024;
const MANIFEST_LIMIT: usize = 2 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const PROCESS_STDOUT_LIMIT: usize = 256 * 1024;
const PROCESS_STDERR_LIMIT: usize = 64 * 1024;
const MAX_TIMEOUT_MS: u64 = 3_600_000;

#[derive(Debug, thiserror::Error)]
pub enum CellAdapterError {
    #[error("cell_executor_unavailable: {0}")]
    Unavailable(String),
    #[error("cell_profile_refused: {0}")]
    Profile(String),
    #[error("cell_execution_failed: {0}")]
    Execution(String),
    #[error("cell_evidence_invalid: {0}")]
    Evidence(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, CellAdapterError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Sha256Pin {
    pub algorithm: String,
    pub value: String,
}

impl Sha256Pin {
    fn validate(&self) -> Result<()> {
        if self.algorithm != "sha256"
            || self.value.len() != 64
            || !self.value.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(CellAdapterError::Unavailable(
                "a pin must be a sha256 digest".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PinnedFile {
    pub path: PathBuf,
    pub digest: Sha256Pin,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidecarConfig {
    pub api_version: String,
    pub runner: PinnedFile,
    pub materials: Vec<PinnedFile>,
    pub transitive_digest: Sha256Pin,
    pub state_root: PathBuf,
    pub timeout_ms: u64,
    pub output_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct CellSidecar {
    config_file: PinnedFile,
    config: SidecarConfig,
    material_pins: BTreeMap<PathBuf, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedProgram {
    pub executable: PinnedFile,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CellExecutionRequest {
    pub graph_subject_digest: String,
    pub graph_transitive_digest: String,
    pub node_id: String,
    pub cell: PinnedFile,
    pub cell_digest: String,
    pub materials: Vec<PinnedFile>,
    pub transitive_cell_digest: String,
    pub inputs: BTreeMap<String, Value>,
    pub expected_outputs: BTreeSet<String>,
    pub timeout_ms: u64,
    pub witness: PinnedProgram,
    pub witness_digest: String,
    pub judge: PinnedProgram,
    pub judge_digest: String,
    #[serde(default)]
    pub source_refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcceptanceVerdict {
    pub schema: String,
    pub accepted: bool,
    pub evidence_digest: String,
    #[serde(default)]
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CellNodeEvidence {
    pub schema: String,
    pub graph_subject_digest: String,
    pub graph_transitive_digest: String,
    pub node_id: String,
    pub cell_digest: String,
    pub transitive_cell_digest: String,
    pub manifest_digest: String,
    pub input_digests: BTreeMap<String, String>,
    pub output_digests: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, Value>,
    pub source_refs: Vec<String>,
    pub produced_by: String,
    pub witness_program_digest: String,
    pub witness_verdict_digest: String,
    pub witness: AcceptanceVerdict,
    pub judge_program_digest: String,
    pub judge_verdict_digest: String,
    pub judge: AcceptanceVerdict,
    pub isolated_root: PathBuf,
}

#[derive(Clone, Debug)]
pub struct AcceptanceExecutionRequest {
    pub graph_subject_digest: String,
    pub graph_transitive_digest: String,
    pub node_id: String,
    pub materials: Vec<PinnedFile>,
    pub inputs: BTreeMap<String, Value>,
    pub timeout_ms: u64,
    pub witness: PinnedProgram,
    pub witness_digest: String,
    pub judge: PinnedProgram,
    pub judge_digest: String,
    pub source_refs: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct AcceptanceEdgeEvidence {
    pub input_digest: String,
    pub witness_verdict_digest: String,
    pub witness: AcceptanceVerdict,
    pub judge_verdict_digest: String,
    pub judge: AcceptanceVerdict,
    pub isolated_root: PathBuf,
}

impl CellSidecar {
    /// Load deployment bootstrap. The request cannot select this path or digest.
    pub fn load(config_file: PinnedFile) -> Result<Self> {
        let bytes = read_pinned(&config_file, CONFIG_LIMIT)?;
        let config: SidecarConfig = serde_json::from_slice(&bytes)?;
        if config.api_version != "aiko.graph-harness-cell-sidecar/v1" {
            return Err(CellAdapterError::Unavailable(
                "unsupported sidecar configuration version".into(),
            ));
        }
        if config.materials.is_empty() || config.materials.len() > MATERIAL_COUNT_LIMIT {
            return Err(CellAdapterError::Unavailable(
                "material closure is empty or exceeds its bound".into(),
            ));
        }
        require_absolute_directory(&config.state_root)?;
        if !(1..=MAX_TIMEOUT_MS).contains(&config.timeout_ms)
            || !(1..=OUTPUT_LIMIT).contains(&config.output_bytes)
        {
            return Err(CellAdapterError::Unavailable(
                "sidecar bounds are invalid".into(),
            ));
        }
        read_pinned(&config.runner, MATERIAL_LIMIT)?;
        let mut pins = BTreeMap::new();
        for material in &config.materials {
            read_pinned(material, MATERIAL_LIMIT)?;
            if pins
                .insert(
                    material.path.clone(),
                    material.digest.value.to_ascii_lowercase(),
                )
                .is_some()
            {
                return Err(CellAdapterError::Unavailable(
                    "duplicate path in Cell closure".into(),
                ));
            }
        }
        let observed = closure_digest(&config.runner, &config.materials)?;
        config.transitive_digest.validate()?;
        if observed != config.transitive_digest.value.to_ascii_lowercase() {
            return Err(CellAdapterError::Unavailable(
                "Cell sidecar transitive closure drifted".into(),
            ));
        }
        Ok(Self {
            config_file,
            config,
            material_pins: pins,
        })
    }

    pub fn deployment_identity(&self) -> (&PinnedFile, &Sha256Pin) {
        (&self.config_file, &self.config.transitive_digest)
    }

    pub fn from_environment() -> Result<Self> {
        let path = std::env::var_os("AIKO_GRAPH_HARNESS_CELL_SIDECAR_CONFIG")
            .map(PathBuf::from)
            .ok_or_else(|| {
                CellAdapterError::Unavailable("deployment sidecar config is not configured".into())
            })?;
        let digest =
            std::env::var("AIKO_GRAPH_HARNESS_CELL_SIDECAR_CONFIG_SHA256").map_err(|_| {
                CellAdapterError::Unavailable(
                    "deployment sidecar config digest is not configured".into(),
                )
            })?;
        Self::load(PinnedFile {
            path,
            digest: Sha256Pin {
                algorithm: "sha256".into(),
                value: digest,
            },
        })
    }

    /// Run only the package acceptance edge. There is deliberately no Cell
    /// producer in this path: all inputs are already durable terminal products.
    pub async fn execute_acceptance_edge(
        &self,
        request: AcceptanceExecutionRequest,
    ) -> Result<AcceptanceEdgeEvidence> {
        if !xai_grok_sandbox::is_active() || xai_grok_sandbox::profile_name() != Some("strict") {
            return Err(CellAdapterError::Profile(
                "Primary profile requires an active kernel-enforced strict host sandbox".into(),
            ));
        }
        for digest in [
            &request.graph_subject_digest,
            &request.graph_transitive_digest,
            &request.witness_digest,
            &request.judge_digest,
        ] {
            require_digest(digest)?;
        }
        safe_id(&request.node_id)?;
        if request.materials.is_empty() || request.materials.len() > MATERIAL_COUNT_LIMIT {
            return Err(CellAdapterError::Profile(
                "acceptance material closure is invalid".into(),
            ));
        }
        let mut pins = BTreeMap::new();
        for material in &request.materials {
            read_pinned(material, MATERIAL_LIMIT)?;
            pins.insert(
                material.path.clone(),
                material.digest.value.to_ascii_lowercase(),
            );
        }
        let request_sidecar = Self {
            config_file: self.config_file.clone(),
            config: self.config.clone(),
            material_pins: pins,
        };
        request_sidecar.require_program(&request.witness, &request.witness_digest)?;
        request_sidecar.require_program(&request.judge, &request.judge_digest)?;
        if request.witness.executable.path == request.judge.executable.path
            || request.witness_digest == request.judge_digest
        {
            return Err(CellAdapterError::Profile(
                "north-star witness and judge must have separate identities".into(),
            ));
        }
        self.reverify_all()?;
        let timeout_ms = request
            .timeout_ms
            .min(self.config.timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);
        let temp = Builder::new()
            .prefix(".graph-harness-acceptance.")
            .tempdir_in(&self.config.state_root)?;
        let staging = temp.keep();
        let acceptance_input = canonical_json(&serde_json::json!({
            "schema":"aiko.graph-harness-north-star.acceptance-input/v1",
            "node_id":request.node_id,
            "graph_subject_digest":request.graph_subject_digest,
            "graph_transitive_digest":request.graph_transitive_digest,
            "inputs":request.inputs,
            "source_refs":request.source_refs,
        }))?;
        let input_digest = sha256(&acceptance_input);
        let result = async {
            let witness =
                run_acceptor(&request.witness, &staging, timeout_ms, &acceptance_input).await?;
            let witness_bytes = canonical_json(&serde_json::to_value(&witness)?)?;
            let witness_verdict_digest = sha256(&witness_bytes);
            if !witness.accepted || witness.evidence_digest != input_digest {
                return Err(CellAdapterError::Evidence(
                    "pinned north-star witness rejected or cited different inputs".into(),
                ));
            }
            let judge_input = canonical_json(&serde_json::json!({
                "schema":"aiko.graph-harness-north-star.judge-input/v1",
                "acceptance":serde_json::from_slice::<Value>(&acceptance_input)?,
                "witness":witness,
                "witness_verdict_digest":witness_verdict_digest,
            }))?;
            let judge = run_acceptor(&request.judge, &staging, timeout_ms, &judge_input).await?;
            let judge_verdict_digest = sha256(&canonical_json(&serde_json::to_value(&judge)?)?);
            if !judge.accepted || judge.evidence_digest != witness_verdict_digest {
                return Err(CellAdapterError::Evidence(
                    "independent north-star judge rejected or cited different witness evidence"
                        .into(),
                ));
            }
            Ok(AcceptanceEdgeEvidence {
                input_digest,
                witness_verdict_digest,
                witness,
                judge_verdict_digest,
                judge,
                isolated_root: PathBuf::new(),
            })
        }
        .await;
        let mut evidence = match result {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        let final_root = self.config.state_root.join(format!(
            "acceptance-{}-{}",
            safe_id(&request.node_id)?,
            &evidence.judge_verdict_digest[..16]
        ));
        if final_root.exists() {
            return Err(CellAdapterError::Execution(
                "acceptance evidence root already exists".into(),
            ));
        }
        fs::rename(&staging, &final_root)?;
        sync_directory(&self.config.state_root)?;
        evidence.isolated_root = final_root;
        Ok(evidence)
    }

    /// Verify the complete declaration closure and the deliberately narrow
    /// Primary profile. This is identity/profile checking, never scheduling.
    pub fn verify_primary_closure(&self, root: &PinnedFile) -> Result<()> {
        self.require_material(root)?;
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        self.verify_cell(root.path.as_path(), &mut visiting, &mut visited)?;
        if visited.len() != self.cell_material_count()? {
            return Err(CellAdapterError::Profile(
                "configured Cell declarations contain unreachable material".into(),
            ));
        }
        Ok(())
    }

    fn cell_material_count(&self) -> Result<usize> {
        let mut count = 0;
        for path in self.material_pins.keys() {
            if is_cell_declaration(path)? {
                count += 1;
            }
        }
        Ok(count)
    }

    fn verify_cell(
        &self,
        path: &Path,
        visiting: &mut BTreeSet<PathBuf>,
        visited: &mut BTreeSet<PathBuf>,
    ) -> Result<()> {
        let path = path.to_path_buf();
        if visited.contains(&path) {
            return Ok(());
        }
        if !visiting.insert(path.clone()) {
            return Err(CellAdapterError::Profile("recursive Cell closure".into()));
        }
        let pin = self.pin_for(&path)?;
        let bytes = read_pinned(&pin, MATERIAL_LIMIT)?;
        let cell: Value = serde_json::from_slice(&bytes).map_err(|_| {
            CellAdapterError::Profile("Primary profile requires canonical JSON Cell files".into())
        })?;
        if cell.get("apiVersion").and_then(Value::as_str) != Some("cell/v0")
            || cell.get("kind").and_then(Value::as_str) != Some("Cell")
        {
            return Err(CellAdapterError::Profile("foreign Cell declaration".into()));
        }
        let spec = object_field(&cell, "spec")?;
        let has_run = spec.contains_key("run");
        let has_children = spec.contains_key("organelles");
        if has_run == has_children {
            return Err(CellAdapterError::Profile(
                "Cell must contain exactly one of run or organelles".into(),
            ));
        }
        verify_caps(spec.get("membrane"))?;
        if let Some(run) = spec.get("run") {
            let run = run
                .as_object()
                .ok_or_else(|| CellAdapterError::Profile("Cell run must be an object".into()))?;
            if run.get("kind").and_then(Value::as_str) != Some("exec") {
                return Err(CellAdapterError::Profile(
                    "Primary profile refuses Python and HTTP leaves".into(),
                ));
            }
            if run.contains_key("shell") {
                return Err(CellAdapterError::Profile("shell leaves are opaque".into()));
            }
            let command = run
                .get("command")
                .and_then(Value::as_array)
                .ok_or_else(|| CellAdapterError::Profile("exec command must be argv".into()))?;
            let executable = command
                .first()
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .ok_or_else(|| CellAdapterError::Profile("exec command is empty".into()))?;
            if !executable.is_absolute() || !self.material_pins.contains_key(&executable) {
                return Err(CellAdapterError::Profile(
                    "exec executable is not an absolute pinned closure member".into(),
                ));
            }
            read_pinned(&self.pin_for(&executable)?, MATERIAL_LIMIT)?;
            if run
                .get("env")
                .and_then(Value::as_object)
                .is_some_and(|e| !e.is_empty())
            {
                return Err(CellAdapterError::Profile(
                    "Primary profile refuses leaf-selected environment".into(),
                ));
            }
        } else {
            let children = spec
                .get("organelles")
                .and_then(Value::as_array)
                .ok_or_else(|| CellAdapterError::Profile("organelles must be an array".into()))?;
            for child in children {
                let child = child.as_object().ok_or_else(|| {
                    CellAdapterError::Profile("organelle must be an object".into())
                })?;
                if child.contains_key("cellInline") {
                    return Err(CellAdapterError::Profile(
                        "Primary profile requires independently pinned child files".into(),
                    ));
                }
                let reference = child
                    .get("cell")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CellAdapterError::Profile("organelle lacks cell".into()))?;
                let resolved = resolve_reference(&path, reference)?;
                self.require_material(&self.pin_for(&resolved)?)?;
                self.verify_cell(&resolved, visiting, visited)?;
            }
        }
        visiting.remove(&path);
        visited.insert(path);
        Ok(())
    }

    fn for_request(&self, request: &CellExecutionRequest) -> Result<Self> {
        if request.materials.is_empty() || request.materials.len() > MATERIAL_COUNT_LIMIT {
            return Err(CellAdapterError::Profile(
                "request material closure is empty or exceeds its bound".into(),
            ));
        }
        let mut pins = BTreeMap::new();
        for material in &request.materials {
            read_pinned(material, MATERIAL_LIMIT)?;
            if pins
                .insert(
                    material.path.clone(),
                    material.digest.value.to_ascii_lowercase(),
                )
                .is_some()
            {
                return Err(CellAdapterError::Profile(
                    "duplicate request closure path".into(),
                ));
            }
        }
        require_digest(&request.transitive_cell_digest)?;
        if package_closure_digest(&request.materials)?
            != request.transitive_cell_digest.to_ascii_lowercase()
        {
            return Err(CellAdapterError::Profile(
                "request Cell transitive closure drifted".into(),
            ));
        }
        Ok(Self {
            config_file: self.config_file.clone(),
            config: self.config.clone(),
            material_pins: pins,
        })
    }

    /// Execute one Contract-leased node. An inactive or non-strict host
    /// sandbox is a refusal: Cell's exec caps are declarations, not confinement.
    pub async fn execute(&self, request: CellExecutionRequest) -> Result<CellNodeEvidence> {
        let request_sidecar = self.for_request(&request)?;
        request_sidecar.verify_request(&request)?;
        if !xai_grok_sandbox::is_active() || xai_grok_sandbox::profile_name() != Some("strict") {
            return Err(CellAdapterError::Profile(
                "Primary profile requires an active kernel-enforced strict host sandbox".into(),
            ));
        }
        self.reverify_all()?;
        request_sidecar.reverify_request_materials(&request)?;
        let timeout_ms = request
            .timeout_ms
            .min(self.config.timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);
        let temp = Builder::new()
            .prefix(".graph-harness-cell.")
            .tempdir_in(&self.config.state_root)?;
        let staging = temp.keep();
        let result = request_sidecar
            .execute_in(&request, &staging, timeout_ms)
            .await;
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
            return result;
        }
        let mut evidence = result?;
        let staging_name = staging
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| CellAdapterError::Execution("isolated root name is not UTF-8".into()))?;
        let final_root = self.config.state_root.join(format!(
            "node-{}-{}-{}",
            safe_id(&request.node_id)?,
            &evidence.manifest_digest[..16],
            staging_name.trim_start_matches('.')
        ));
        fs::rename(&staging, &final_root).map_err(|error| {
            CellAdapterError::Execution(format!(
                "isolated root could not commit atomically: {error}"
            ))
        })?;
        sync_directory(&self.config.state_root)?;
        evidence.isolated_root = final_root;
        Ok(evidence)
    }

    async fn execute_in(
        &self,
        request: &CellExecutionRequest,
        root: &Path,
        timeout_ms: u64,
    ) -> Result<CellNodeEvidence> {
        let input_path = root.join("request-inputs.json");
        write_new_sync(&input_path, &serde_json::to_vec(&request.inputs)?)?;
        let out = root.join("result");
        fs::create_dir(&out)?;
        let args = vec![
            "run".to_string(),
            request.cell.path.display().to_string(),
            "--inputs".to_string(),
            input_path.display().to_string(),
            "--out".to_string(),
            out.display().to_string(),
        ];
        run_bounded_program(&self.config.runner.path, &args, root, timeout_ms, &[]).await?;
        self.reverify_all()?;
        self.reverify_request_materials(request)?;
        let manifest_path = out.join("manifest.json");
        let manifest_bytes = read_regular(&manifest_path, MANIFEST_LIMIT)?;
        let manifest: Value = serde_json::from_slice(&manifest_bytes)?;
        validate_manifest(&manifest, request, &request.transitive_cell_digest)?;
        let manifest_digest = sha256(&manifest_bytes);
        let (outputs, output_digests) =
            read_outputs(&out, &request.expected_outputs, self.config.output_bytes)?;
        let input_digests = request
            .inputs
            .iter()
            .map(|(name, value)| Ok((name.clone(), sha256(&canonical_json(value)?))))
            .collect::<Result<BTreeMap<_, _>>>()?;
        validate_manifest_port_digests(&manifest, &input_digests, &output_digests)?;
        let acceptance_input = serde_json::to_vec(&serde_json::json!({
            "schema": "aiko.graph-harness-cell.acceptance-input/v1",
            "node_id": request.node_id,
            "manifest_digest": manifest_digest,
            "outputs": outputs,
            "output_digests": output_digests,
            "source_refs": request.source_refs,
        }))?;
        let witness = run_acceptor(&request.witness, root, timeout_ms, &acceptance_input).await?;
        let witness_bytes = canonical_json(&serde_json::to_value(&witness)?)?;
        let witness_verdict_digest = sha256(&witness_bytes);
        if !witness.accepted || witness.evidence_digest != manifest_digest {
            return Err(CellAdapterError::Evidence(
                "pinned witness rejected or cited a different manifest".into(),
            ));
        }
        // The judge is a distinct pinned process and receives the witness
        // verdict as evidence; it never shares producer or witness execution.
        let judge_input = serde_json::to_vec(&serde_json::json!({
            "schema": "aiko.graph-harness-cell.judge-input/v1",
            "acceptance": serde_json::from_slice::<Value>(&acceptance_input)?,
            "witness": witness,
            "witness_verdict_digest": witness_verdict_digest,
        }))?;
        let judge = run_acceptor(&request.judge, root, timeout_ms, &judge_input).await?;
        let judge_verdict_digest = sha256(&canonical_json(&serde_json::to_value(&judge)?)?);
        if !judge.accepted || judge.evidence_digest != witness_verdict_digest {
            return Err(CellAdapterError::Evidence(
                "independent judge rejected or did not cite the witness verdict".into(),
            ));
        }
        Ok(CellNodeEvidence {
            schema: "aiko.graph-harness-cell.evidence/v1".into(),
            graph_subject_digest: request.graph_subject_digest.clone(),
            graph_transitive_digest: request.graph_transitive_digest.clone(),
            node_id: request.node_id.clone(),
            cell_digest: request.cell_digest.clone(),
            transitive_cell_digest: request.transitive_cell_digest.clone(),
            manifest_digest,
            input_digests,
            output_digests,
            outputs,
            source_refs: request.source_refs.clone(),
            produced_by: "aiko.graph-harness-cell-v0/v1".into(),
            witness_program_digest: request.witness_digest.clone(),
            witness_verdict_digest,
            witness,
            judge_program_digest: request.judge_digest.clone(),
            judge_verdict_digest,
            judge,
            isolated_root: PathBuf::new(),
        })
    }

    fn verify_request(&self, request: &CellExecutionRequest) -> Result<()> {
        for digest in [
            &request.graph_subject_digest,
            &request.graph_transitive_digest,
            &request.cell_digest,
            &request.transitive_cell_digest,
            &request.witness_digest,
            &request.judge_digest,
        ] {
            require_digest(digest)?;
        }
        safe_id(&request.node_id)?;
        if serde_json::to_vec(&request.inputs)?.len() > INPUT_LIMIT {
            return Err(CellAdapterError::Profile("Cell inputs exceed bound".into()));
        }
        if request.expected_outputs.is_empty() || request.expected_outputs.len() > 64 {
            return Err(CellAdapterError::Profile(
                "invalid output port count".into(),
            ));
        }
        for port in &request.expected_outputs {
            safe_id(port)?;
        }
        self.verify_primary_closure(&request.cell)?;
        self.require_program(&request.witness, &request.witness_digest)?;
        self.require_program(&request.judge, &request.judge_digest)?;
        if request.witness.executable.path == request.judge.executable.path
            || request.witness_digest == request.judge_digest
            || request.cell.path == request.witness.executable.path
            || request.cell.path == request.judge.executable.path
        {
            return Err(CellAdapterError::Profile(
                "producer, witness, and judge must have separate identities".into(),
            ));
        }
        Ok(())
    }

    fn require_program(&self, program: &PinnedProgram, expected: &str) -> Result<()> {
        self.require_material(&program.executable)?;
        if program.executable.digest.value.to_ascii_lowercase() != expected {
            return Err(CellAdapterError::Profile(
                "program identity mismatch".into(),
            ));
        }
        if program.args.len() > 32 || program.args.iter().any(|arg| arg.len() > 4096) {
            return Err(CellAdapterError::Profile(
                "program argv exceeds bound".into(),
            ));
        }
        Ok(())
    }

    fn require_material(&self, file: &PinnedFile) -> Result<()> {
        let Some(expected) = self.material_pins.get(&file.path) else {
            return Err(CellAdapterError::Profile(
                "path is outside the pinned transitive closure".into(),
            ));
        };
        if expected != &file.digest.value.to_ascii_lowercase() {
            return Err(CellAdapterError::Profile("material pin mismatch".into()));
        }
        read_pinned(file, MATERIAL_LIMIT)?;
        Ok(())
    }

    fn pin_for(&self, path: &Path) -> Result<PinnedFile> {
        let digest = self.material_pins.get(path).ok_or_else(|| {
            CellAdapterError::Profile("referenced material is absent from closure".into())
        })?;
        Ok(PinnedFile {
            path: path.to_path_buf(),
            digest: Sha256Pin {
                algorithm: "sha256".into(),
                value: digest.clone(),
            },
        })
    }

    fn reverify_request_materials(&self, request: &CellExecutionRequest) -> Result<()> {
        for material in &request.materials {
            read_pinned(material, MATERIAL_LIMIT)?;
        }
        if package_closure_digest(&request.materials)?
            != request.transitive_cell_digest.to_ascii_lowercase()
        {
            return Err(CellAdapterError::Profile(
                "request closure changed at execution boundary".into(),
            ));
        }
        Ok(())
    }

    fn reverify_all(&self) -> Result<()> {
        read_pinned(&self.config_file, CONFIG_LIMIT)?;
        read_pinned(&self.config.runner, MATERIAL_LIMIT)?;
        for material in &self.config.materials {
            read_pinned(material, MATERIAL_LIMIT)?;
        }
        Ok(())
    }
}

fn verify_caps(membrane: Option<&Value>) -> Result<()> {
    let caps = membrane
        .and_then(Value::as_object)
        .and_then(|m| m.get("caps"))
        .and_then(Value::as_object);
    if caps
        .and_then(|c| c.get("allow_net"))
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
        || caps
            .and_then(|c| c.get("allow_spawn"))
            .and_then(Value::as_bool)
            == Some(true)
    {
        return Err(CellAdapterError::Profile(
            "Primary profile refuses network and spawn authority".into(),
        ));
    }
    Ok(())
}

fn object_field<'a>(value: &'a Value, name: &str) -> Result<&'a Map<String, Value>> {
    value
        .get(name)
        .and_then(Value::as_object)
        .ok_or_else(|| CellAdapterError::Profile(format!("Cell lacks object field {name}")))
}

fn resolve_reference(parent: &Path, reference: &str) -> Result<PathBuf> {
    let reference = Path::new(reference);
    if reference.is_absolute() {
        return Ok(reference.to_path_buf());
    }
    if reference
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(CellAdapterError::Profile(
            "Cell reference traverses upward".into(),
        ));
    }
    let mut resolved = parent
        .parent()
        .ok_or_else(|| CellAdapterError::Profile("Cell path has no parent".into()))?
        .to_path_buf();
    for component in reference.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            _ => return Err(CellAdapterError::Profile("invalid Cell reference".into())),
        }
    }
    Ok(resolved)
}

fn read_pinned(file: &PinnedFile, limit: usize) -> Result<Vec<u8>> {
    file.digest.validate()?;
    require_absolute_regular(&file.path)?;
    let bytes = read_regular(&file.path, limit)?;
    if sha256(&bytes) != file.digest.value.to_ascii_lowercase() {
        return Err(CellAdapterError::Unavailable(format!(
            "pinned file drifted: {}",
            file.path.display()
        )));
    }
    Ok(bytes)
}

fn require_absolute_regular(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(CellAdapterError::Unavailable(
            "deployment paths must be absolute".into(),
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(CellAdapterError::Unavailable(
            "deployment path must be a regular non-symlink file".into(),
        ));
    }
    Ok(())
}

fn require_absolute_directory(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(CellAdapterError::Unavailable(
            "state root must be absolute".into(),
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CellAdapterError::Unavailable(
            "state root must be an existing non-symlink directory".into(),
        ));
    }
    Ok(())
}

fn read_regular(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(CellAdapterError::Evidence(format!(
            "file is not a bounded regular file: {}",
            path.display()
        )));
    }
    Ok(fs::read(path)?)
}

fn closure_digest(runner: &PinnedFile, materials: &[PinnedFile]) -> Result<String> {
    let mut entries = Vec::with_capacity(materials.len() + 1);
    entries.push((&runner.path, runner.digest.value.to_ascii_lowercase()));
    for material in materials {
        entries.push((&material.path, material.digest.value.to_ascii_lowercase()));
    }
    entries.sort_by(|a, b| a.0.as_os_str().cmp(b.0.as_os_str()));
    let mut hash = Sha256::new();
    hash.update(b"aiko.cell-sidecar-closure/v1\0");
    for (path, digest) in entries {
        hash.update(path.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(digest.as_bytes());
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn package_closure_digest(
    materials: &[PinnedFile],
) -> std::result::Result<String, CellAdapterError> {
    let mut entries = materials
        .iter()
        .map(|m| (&m.path, m.digest.value.to_ascii_lowercase()))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.as_os_str().cmp(b.0.as_os_str()));
    let mut hash = Sha256::new();
    hash.update(b"aiko.graph-harness-cell-closure/v1\0");
    for (path, digest) in entries {
        hash.update(path.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(digest.as_bytes());
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn is_cell_declaration(path: &Path) -> Result<bool> {
    let bytes = read_regular(path, MATERIAL_LIMIT)?;
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(false);
    };
    Ok(
        value.get("apiVersion").and_then(Value::as_str) == Some("cell/v0")
            && value.get("kind").and_then(Value::as_str) == Some("Cell"),
    )
}

fn require_digest(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CellAdapterError::Profile("invalid sha256 identity".into()));
    }
    Ok(())
}

fn safe_id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(CellAdapterError::Profile("unsafe identifier".into()));
    }
    Ok(value)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical_json(value: &Value) -> Result<Vec<u8>> {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), sort(v)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    Ok(serde_json::to_vec(&sort(value))?)
}

fn write_new_sync(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

async fn read_bounded<R: AsyncRead + Unpin>(reader: R, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process output exceeded cap",
        ));
    }
    Ok(bytes)
}

async fn run_bounded_program(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    timeout_ms: u64,
    stdin_bytes: &[u8],
) -> Result<Vec<u8>> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("HOME", cwd)
        .env("TMPDIR", cwd)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "linux")]
    {
        unsafe {
            command.pre_exec(|| xai_grok_sandbox::child_net::install_child_network_filter());
        }
    }
    let mut child = command
        .spawn()
        .map_err(|e| CellAdapterError::Execution(format!("could not start pinned program: {e}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CellAdapterError::Execution("missing stdin".into()))?;
    stdin.write_all(stdin_bytes).await?;
    drop(stdin);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CellAdapterError::Execution("missing stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CellAdapterError::Execution("missing stderr".into()))?;
    let execution = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        tokio::try_join!(
            child.wait(),
            read_bounded(stdout, PROCESS_STDOUT_LIMIT),
            read_bounded(stderr, PROCESS_STDERR_LIMIT)
        )
    })
    .await;
    match execution {
        Ok(Ok((status, stdout, stderr))) if status.success() => Ok(stdout),
        Ok(Ok((status, _, stderr))) => Err(CellAdapterError::Execution(format!(
            "pinned program exited {}: {}",
            status.code().unwrap_or(-1),
            String::from_utf8_lossy(&stderr)
        ))),
        Ok(Err(error)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(CellAdapterError::Execution(error.to_string()))
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(CellAdapterError::Execution(
                "pinned program timed out".into(),
            ))
        }
    }
}

async fn run_acceptor(
    program: &PinnedProgram,
    cwd: &Path,
    timeout_ms: u64,
    input: &[u8],
) -> Result<AcceptanceVerdict> {
    let bytes = run_bounded_program(
        &program.executable.path,
        &program.args,
        cwd,
        timeout_ms,
        input,
    )
    .await?;
    let verdict: AcceptanceVerdict = serde_json::from_slice(&bytes)?;
    if verdict.schema != "aiko.graph-harness-cell.acceptance-verdict/v1" {
        return Err(CellAdapterError::Evidence(
            "foreign acceptance verdict".into(),
        ));
    }
    require_digest(&verdict.evidence_digest)
        .map_err(|_| CellAdapterError::Evidence("verdict lacks evidence digest".into()))?;
    Ok(verdict)
}

fn validate_manifest(
    manifest: &Value,
    request: &CellExecutionRequest,
    transitive: &str,
) -> Result<()> {
    let object = manifest
        .as_object()
        .ok_or_else(|| CellAdapterError::Evidence("manifest must be an object".into()))?;
    if object.get("cell").and_then(Value::as_str) != Some(request.cell_digest.as_str()) {
        return Err(CellAdapterError::Evidence(
            "manifest Cell identity mismatch".into(),
        ));
    }
    if object.get("digest").and_then(Value::as_str).is_none()
        || object.get("inputs").and_then(Value::as_object).is_none()
        || object.get("outputs").and_then(Value::as_object).is_none()
        || object.get("evidence").and_then(Value::as_array).is_none()
        || object.get("produced_by").and_then(Value::as_str).is_none()
    {
        return Err(CellAdapterError::Evidence("manifest is incomplete".into()));
    }
    if let Some(observed) = object.get("transitive_digest").and_then(Value::as_str)
        && observed != transitive
    {
        return Err(CellAdapterError::Evidence(
            "manifest closure identity mismatch".into(),
        ));
    }
    Ok(())
}

fn validate_manifest_port_digests(
    manifest: &Value,
    inputs: &BTreeMap<String, String>,
    outputs: &BTreeMap<String, String>,
) -> Result<()> {
    fn digest_map(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
        value?
            .as_object()?
            .iter()
            .map(|(name, digest)| {
                digest
                    .as_str()
                    .map(|digest| (name.clone(), digest.to_ascii_lowercase()))
            })
            .collect()
    }
    if digest_map(manifest.get("inputs")).as_ref() != Some(inputs)
        || digest_map(manifest.get("outputs")).as_ref() != Some(outputs)
    {
        return Err(CellAdapterError::Evidence(
            "manifest port digests do not match validated JSON products".into(),
        ));
    }
    Ok(())
}

fn read_outputs(
    out: &Path,
    expected: &BTreeSet<String>,
    limit: usize,
) -> Result<(BTreeMap<String, Value>, BTreeMap<String, String>)> {
    let outputs_dir = out;
    let metadata = fs::symlink_metadata(outputs_dir)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CellAdapterError::Evidence(
            "Cell result is not a real directory".into(),
        ));
    }
    let mut outputs = BTreeMap::new();
    let mut digests = BTreeMap::new();
    let mut total = 0usize;
    for port in expected {
        let bytes = read_regular(&outputs_dir.join(format!("{port}.json")), limit)?;
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| CellAdapterError::Evidence("output size overflow".into()))?;
        if total > limit {
            return Err(CellAdapterError::Evidence("Cell outputs exceed cap".into()));
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        digests.insert(port.clone(), sha256(&canonical_json(&value)?));
        outputs.insert(port.clone(), value);
    }
    let actual = fs::read_dir(outputs_dir)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_file())
                .map(|_| entry.file_name())
        })
        .collect::<BTreeSet<_>>();
    let mut wanted = expected
        .iter()
        .map(|p| format!("{p}.json").into())
        .collect::<BTreeSet<_>>();
    wanted.insert("manifest.json".into());
    if actual != wanted {
        return Err(CellAdapterError::Evidence(
            "undeclared or missing Cell output".into(),
        ));
    }
    Ok((outputs, digests))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn pin(path: &Path) -> PinnedFile {
        PinnedFile {
            path: path.to_path_buf(),
            digest: Sha256Pin {
                algorithm: "sha256".into(),
                value: sha256(&fs::read(path).unwrap()),
            },
        }
    }

    #[cfg(unix)]
    #[test]
    fn pinned_file_refuses_relative_and_symlink_paths() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::write(&real, b"x").unwrap();
        let relative = PinnedFile {
            path: PathBuf::from("real"),
            digest: pin(&real).digest.clone(),
        };
        assert!(matches!(
            read_pinned(&relative, 10),
            Err(CellAdapterError::Unavailable(_))
        ));
        let link = dir.path().join("link");
        symlink(&real, &link).unwrap();
        assert!(matches!(
            read_pinned(&pin(&real).clone_with_path(link), 10),
            Err(CellAdapterError::Unavailable(_))
        ));
    }

    trait ClonePath {
        fn clone_with_path(&self, path: PathBuf) -> Self;
    }
    impl ClonePath for PinnedFile {
        fn clone_with_path(&self, path: PathBuf) -> Self {
            Self {
                path,
                digest: self.digest.clone(),
            }
        }
    }

    #[test]
    fn primary_profile_refuses_python_http_and_unpinned_exec() {
        for run in [
            serde_json::json!({"kind":"python","code":"pass"}),
            serde_json::json!({"kind":"http","http":{}}),
            serde_json::json!({"kind":"exec","command":["/not/pinned"]}),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("root.cell.json");
            fs::write(
                &root,
                serde_json::to_vec(&serde_json::json!({
                    "apiVersion":"cell/v0","kind":"Cell","spec":{"membrane":{"caps":{}},"run":run}
                }))
                .unwrap(),
            )
            .unwrap();
            let runner = dir.path().join("runner");
            fs::write(&runner, b"runner").unwrap();
            let cfg_path = dir.path().join("config.json");
            let runner_pin = pin(&runner);
            let root_pin = pin(&root);
            let td = closure_digest(&runner_pin, std::slice::from_ref(&root_pin)).unwrap();
            let cfg = SidecarConfig {
                api_version: "aiko.graph-harness-cell-sidecar/v1".into(),
                runner: runner_pin,
                materials: vec![root_pin.clone()],
                transitive_digest: Sha256Pin {
                    algorithm: "sha256".into(),
                    value: td,
                },
                state_root: dir.path().to_path_buf(),
                timeout_ms: 10,
                output_bytes: 10,
            };
            fs::write(&cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();
            let sidecar = CellSidecar::load(pin(&cfg_path)).unwrap();
            assert!(matches!(
                sidecar.verify_primary_closure(&root_pin),
                Err(CellAdapterError::Profile(_))
            ));
        }
    }

    #[test]
    fn closure_digest_detects_transitive_drift() {
        let dir = tempfile::tempdir().unwrap();
        let runner = dir.path().join("runner");
        let material = dir.path().join("material");
        fs::write(&runner, b"r").unwrap();
        fs::write(&material, b"one").unwrap();
        let old = closure_digest(&pin(&runner), &[pin(&material)]).unwrap();
        fs::write(&material, b"two").unwrap();
        let new = closure_digest(&pin(&runner), &[pin(&material)]).unwrap();
        assert_ne!(old, new);
    }

    #[test]
    fn manifest_port_digests_must_match_validated_products() {
        let inputs = BTreeMap::from([("in".into(), "a".repeat(64))]);
        let outputs = BTreeMap::from([("out".into(), "b".repeat(64))]);
        let valid = serde_json::json!({"inputs": inputs, "outputs": outputs});
        assert!(validate_manifest_port_digests(&valid, &inputs, &outputs).is_ok());
        let laundered = serde_json::json!({"inputs": inputs, "outputs": {"out": "c".repeat(64)}});
        assert!(matches!(
            validate_manifest_port_digests(&laundered, &inputs, &outputs),
            Err(CellAdapterError::Evidence(_))
        ));
    }

    #[test]
    fn output_reader_refuses_undeclared_products() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("answer.json"), b"{\"ok\":true}").unwrap();
        fs::write(dir.path().join("manifest.json"), b"{}").unwrap();
        fs::write(dir.path().join("extra.json"), b"null").unwrap();
        let expected = BTreeSet::from(["answer".into()]);
        assert!(matches!(
            read_outputs(dir.path(), &expected, 1024),
            Err(CellAdapterError::Evidence(_))
        ));
    }

    #[test]
    fn canonical_json_sorts_nested_objects() {
        let value = serde_json::json!({"z":{"b":1,"a":2},"a":0});
        assert_eq!(
            String::from_utf8(canonical_json(&value).unwrap()).unwrap(),
            r#"{"a":0,"z":{"a":2,"b":1}}"#
        );
    }
}
