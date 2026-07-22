use libloading::Library;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{CStr, CString, c_char};
use std::path::Path;

type UnaryFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type VerifyFn = unsafe extern "C" fn(
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
) -> *mut c_char;
type AdmitFn = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> *mut c_char;
type RankFn = unsafe extern "C" fn(*const c_char, u32) -> *mut c_char;
type BinaryFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type FreeFn = unsafe extern "C" fn(*mut c_char);
type AbiVersionFn = unsafe extern "C" fn() -> u32;

#[derive(Debug, thiserror::Error)]
pub enum CollectiveError {
    #[error("Contract library could not be loaded: {0}")]
    Load(#[from] libloading::Error),
    #[error("Contract collective ABI is unavailable or incompatible")]
    IncompatibleAbi,
    #[error("collective input contains an embedded NUL byte")]
    EmbeddedNul,
    #[error("Contract returned no result")]
    NullResult,
    #[error("Contract returned invalid UTF-8")]
    InvalidUtf8,
    #[error("Contract returned invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("Contract rejected the object: {0:?}")]
    Rejected(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CanonicalObject {
    pub verdict: String,
    pub object_id: String,
    pub schema_version: u32,
    pub canonical: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PublicationVerdict {
    pub verdict: String,
    pub classification: String,
    #[serde(default)]
    pub reason_codes: Vec<String>,
    pub object_id: String,
    pub schema_version: u32,
    pub sanitized_descriptor: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerificationVerdict {
    pub verdict: String,
    #[serde(default)]
    pub reason_codes: Vec<String>,
    pub object_id: String,
    pub schema_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdmissionVerdict {
    pub verdict: String,
    #[serde(default)]
    pub reason_codes: Vec<String>,
    pub object_id: String,
    pub kind: String,
    #[serde(default)]
    pub ledger_effects: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Rejection {
    verdict: String,
    #[serde(default)]
    reason_codes: Vec<String>,
}

/// Dynamically loaded deterministic Contract boundary. The library is retained
/// for the lifetime of every copied function pointer.
pub struct CollectiveContract {
    _library: Library,
    canonicalize: UnaryFn,
    publication_verdict: UnaryFn,
    signing_payload: UnaryFn,
    verify: VerifyFn,
    admit: AdmitFn,
    rank: RankFn,
    checkpoint: UnaryFn,
    inclusion_proof: Option<BinaryFn>,
    verify_inclusion_proof: Option<UnaryFn>,
    merge: UnaryFn,
    apply_revocations: BinaryFn,
    free: FreeFn,
}

impl CollectiveContract {
    /// Load an explicit packaged Contract library. Product-level path discovery
    /// belongs in the Aiko runtime supervisor, not in this portable crate.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, CollectiveError> {
        // SAFETY: symbols are copied only after their library is opened, and
        // `_library` keeps the image loaded for the bridge's entire lifetime.
        let library = unsafe { Library::new(path.as_ref())? };
        let abi_version = unsafe {
            library
                .get::<AbiVersionFn>(b"contract_abi_version\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?()
        };
        if abi_version < 3 {
            return Err(CollectiveError::IncompatibleAbi);
        }
        unsafe {
            let canonicalize = *library
                .get::<UnaryFn>(b"contract_collective_canonicalize\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let publication_verdict = *library
                .get::<UnaryFn>(b"contract_collective_publication_verdict\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let signing_payload = *library
                .get::<UnaryFn>(b"contract_collective_signing_payload\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let verify = *library
                .get::<VerifyFn>(b"contract_collective_verify\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let admit = *library
                .get::<AdmitFn>(b"contract_collective_admit\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let rank = *library
                .get::<RankFn>(b"contract_collective_rank\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let checkpoint = *library
                .get::<UnaryFn>(b"contract_collective_checkpoint\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            // Added after collective ABI v3. It is optional so a newer Aiko
            // can still open an older v3 Contract library for operations that
            // do not request proof material.
            let inclusion_proof = library
                .get::<BinaryFn>(b"contract_collective_inclusion_proof\0")
                .ok()
                .map(|symbol| *symbol);
            let verify_inclusion_proof = library
                .get::<UnaryFn>(b"contract_collective_verify_inclusion_proof\0")
                .ok()
                .map(|symbol| *symbol);
            let merge = *library
                .get::<UnaryFn>(b"contract_collective_merge\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let apply_revocations = *library
                .get::<BinaryFn>(b"contract_collective_apply_revocations\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            let free = *library
                .get::<FreeFn>(b"contract_free\0")
                .map_err(|_| CollectiveError::IncompatibleAbi)?;
            Ok(Self {
                _library: library,
                canonicalize,
                publication_verdict,
                signing_payload,
                verify,
                admit,
                rank,
                checkpoint,
                inclusion_proof,
                verify_inclusion_proof,
                merge,
                apply_revocations,
                free,
            })
        }
    }

    fn cstring(value: &[u8]) -> Result<CString, CollectiveError> {
        CString::new(value).map_err(|_| CollectiveError::EmbeddedNul)
    }

    fn take_json<T: for<'de> Deserialize<'de>>(
        &self,
        pointer: *mut c_char,
    ) -> Result<T, CollectiveError> {
        if pointer.is_null() {
            return Err(CollectiveError::NullResult);
        }
        struct Returned<'a> {
            pointer: *mut c_char,
            free: &'a FreeFn,
        }
        impl Drop for Returned<'_> {
            fn drop(&mut self) {
                unsafe { (self.free)(self.pointer) };
            }
        }
        let returned = Returned {
            pointer,
            free: &self.free,
        };
        let bytes = unsafe { CStr::from_ptr(returned.pointer) }.to_bytes();
        let text = std::str::from_utf8(bytes).map_err(|_| CollectiveError::InvalidUtf8)?;
        let value: Value = serde_json::from_str(text)?;
        if value.get("verdict").and_then(Value::as_str) == Some("reject") {
            let rejection: Rejection = serde_json::from_value(value)?;
            debug_assert_eq!(rejection.verdict, "reject");
            return Err(CollectiveError::Rejected(rejection.reason_codes));
        }
        Ok(serde_json::from_value(value)?)
    }

    fn unary<T: for<'de> Deserialize<'de>>(
        &self,
        function: UnaryFn,
        input: &[u8],
    ) -> Result<T, CollectiveError> {
        let input = Self::cstring(input)?;
        self.take_json(unsafe { function(input.as_ptr()) })
    }

    pub fn canonicalize(&self, candidate: &[u8]) -> Result<CanonicalObject, CollectiveError> {
        self.unary(self.canonicalize, candidate)
    }

    pub fn publication_verdict(
        &self,
        candidate: &[u8],
    ) -> Result<PublicationVerdict, CollectiveError> {
        self.unary(self.publication_verdict, candidate)
    }

    pub fn signing_payload(&self, candidate: &[u8]) -> Result<Value, CollectiveError> {
        self.unary(self.signing_payload, candidate)
    }

    pub fn verify(
        &self,
        candidate: &[u8],
        claimed_object_id: &str,
        signature_hex: &str,
        publisher_key_hex: &str,
        now_iso: &str,
    ) -> Result<VerificationVerdict, CollectiveError> {
        let candidate = Self::cstring(candidate)?;
        let claimed_object_id = Self::cstring(claimed_object_id.as_bytes())?;
        let signature_hex = Self::cstring(signature_hex.as_bytes())?;
        let publisher_key_hex = Self::cstring(publisher_key_hex.as_bytes())?;
        let now_iso = Self::cstring(now_iso.as_bytes())?;
        self.take_json(unsafe {
            (self.verify)(
                candidate.as_ptr(),
                claimed_object_id.as_ptr(),
                signature_hex.as_ptr(),
                publisher_key_hex.as_ptr(),
                now_iso.as_ptr(),
            )
        })
    }

    /// Ask Contract to admit a complete signed envelope. This is the only
    /// bridge method a remote receive path may use before moving bytes out of
    /// quarantine; it includes publication-policy and ledger-projection rules.
    pub fn admit(
        &self,
        envelope: &[u8],
        source_peer: &str,
        received_at: &str,
    ) -> Result<AdmissionVerdict, CollectiveError> {
        let envelope = Self::cstring(envelope)?;
        let source_peer = Self::cstring(source_peer.as_bytes())?;
        let received_at = Self::cstring(received_at.as_bytes())?;
        self.take_json(unsafe {
            (self.admit)(
                envelope.as_ptr(),
                source_peer.as_ptr(),
                received_at.as_ptr(),
            )
        })
    }

    pub fn rank(&self, candidates: &Value, limit: u32) -> Result<Value, CollectiveError> {
        let candidates = Self::cstring(&serde_json::to_vec(candidates)?)?;
        self.take_json(unsafe { (self.rank)(candidates.as_ptr(), limit) })
    }

    pub fn checkpoint(&self, object_ids: &[String]) -> Result<Value, CollectiveError> {
        self.unary(self.checkpoint, &serde_json::to_vec(object_ids)?)
    }

    pub fn inclusion_proof(
        &self,
        object_ids: &[String],
        target_object_id: &str,
    ) -> Result<Value, CollectiveError> {
        let function = self
            .inclusion_proof
            .ok_or(CollectiveError::IncompatibleAbi)?;
        let object_ids = Self::cstring(&serde_json::to_vec(object_ids)?)?;
        let target = Self::cstring(target_object_id.as_bytes())?;
        self.take_json(unsafe { function(object_ids.as_ptr(), target.as_ptr()) })
    }

    pub fn verify_inclusion_proof(&self, proof: &Value) -> Result<bool, CollectiveError> {
        let function = self
            .verify_inclusion_proof
            .ok_or(CollectiveError::IncompatibleAbi)?;
        let result: Value = self.unary(function, &serde_json::to_vec(proof)?)?;
        Ok(result.get("verdict").and_then(Value::as_str) == Some("verified"))
    }

    pub fn merge(&self, admitted_metadata: &Value) -> Result<Value, CollectiveError> {
        self.unary(self.merge, &serde_json::to_vec(admitted_metadata)?)
    }

    pub fn apply_revocations(
        &self,
        revocation_envelopes: &Value,
        now_iso: &str,
    ) -> Result<Value, CollectiveError> {
        let revocations = Self::cstring(&serde_json::to_vec(revocation_envelopes)?)?;
        let now = Self::cstring(now_iso.as_bytes())?;
        self.take_json(unsafe { (self.apply_revocations)(revocations.as_ptr(), now.as_ptr()) })
    }
}
