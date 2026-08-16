//! Mandatory Contract ingress primitives.
//!
//! This module is deliberately not part of the generic hook dispatcher.  A
//! transport authenticates first, then hands the opaque [`VerifiedIngress`]
//! to the single projection choke point.  Hook payloads are stimuli only; no
//! field in `HookEventEnvelope` can manufacture this value.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IngressTransport {
    Cli,
    Headless,
    Acp,
    Mcp,
    Plugin,
    Gateway,
    Webhook,
    Cron,
}

impl IngressTransport {
    pub const ALL: [Self; 8] = [
        Self::Cli,
        Self::Headless,
        Self::Acp,
        Self::Mcp,
        Self::Plugin,
        Self::Gateway,
        Self::Webhook,
        Self::Cron,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Headless => "headless",
            Self::Acp => "acp",
            Self::Mcp => "mcp",
            Self::Plugin => "plugin",
            Self::Gateway => "gateway",
            Self::Webhook => "webhook",
            Self::Cron => "cron",
        }
    }
}

/// Claims obtained from a transport's native authentication boundary.
///
/// This is intentionally distinct from the request body.  Adapters must build
/// it from their authenticated peer/session/signature/schedule, never by
/// deserializing authority fields from a hook payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAuthEvidence {
    subject: String,
    tenant: String,
    audience: String,
    scopes: Vec<String>,
    verification_evidence: String,
    credential_generation: String,
}

impl NativeAuthEvidence {
    pub fn verified(
        subject: impl Into<String>,
        tenant: impl Into<String>,
        audience: impl Into<String>,
        scopes: impl IntoIterator<Item = impl Into<String>>,
        verification_evidence: impl Into<String>,
        credential_generation: impl Into<String>,
    ) -> Result<Self, IngressError> {
        let mut scopes: Vec<String> = scopes.into_iter().map(Into::into).collect();
        scopes.sort();
        scopes.dedup();
        let evidence = Self {
            subject: subject.into(),
            tenant: tenant.into(),
            audience: audience.into(),
            scopes,
            verification_evidence: verification_evidence.into(),
            credential_generation: credential_generation.into(),
        };
        if evidence.subject.trim().is_empty()
            || evidence.tenant.trim().is_empty()
            || evidence.audience.trim().is_empty()
            || evidence.scopes.is_empty()
            || evidence.scopes.iter().any(|scope| scope.trim().is_empty())
            || evidence.verification_evidence.trim().is_empty()
            || evidence.credential_generation.trim().is_empty()
        {
            return Err(IngressError::Unauthenticated);
        }
        Ok(evidence)
    }
}

/// Authority-bearing ingress value.  Fields are private so an untrusted event
/// envelope cannot be reinterpreted as authority by downstream code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIngress {
    transport: IngressTransport,
    subject: String,
    tenant: String,
    audience: String,
    scopes: Vec<String>,
    canonical_request_digest: String,
    nonce_namespace: String,
    idempotency_key: String,
    verification_evidence: String,
    credential_generation: String,
    canonical_workspace: PathBuf,
}

impl VerifiedIngress {
    pub fn from_transport_auth(
        transport: IngressTransport,
        auth: NativeAuthEvidence,
        workspace: &Path,
        raw_request: &[u8],
        nonce_namespace: impl Into<String>,
        idempotency_key: impl Into<String>,
    ) -> Result<Self, IngressError> {
        let canonical_workspace =
            std::fs::canonicalize(workspace).map_err(|_| IngressError::WorkspaceNotCanonical)?;
        if !canonical_workspace.is_dir() {
            return Err(IngressError::WorkspaceNotCanonical);
        }
        let nonce_namespace = nonce_namespace.into();
        let idempotency_key = idempotency_key.into();
        if raw_request.is_empty()
            || nonce_namespace.trim().is_empty()
            || idempotency_key.trim().is_empty()
        {
            return Err(IngressError::MalformedRequest);
        }
        Ok(Self {
            transport,
            subject: auth.subject,
            tenant: auth.tenant,
            audience: auth.audience,
            scopes: auth.scopes,
            canonical_request_digest: format!("sha256:{}", sha256_hex(raw_request)),
            nonce_namespace,
            idempotency_key,
            verification_evidence: auth.verification_evidence,
            credential_generation: auth.credential_generation,
            canonical_workspace,
        })
    }

    pub fn transport(&self) -> IngressTransport {
        self.transport
    }
    pub fn subject(&self) -> &str {
        &self.subject
    }
    pub fn tenant(&self) -> &str {
        &self.tenant
    }
    pub fn audience(&self) -> &str {
        &self.audience
    }
    pub fn scopes(&self) -> &[String] {
        &self.scopes
    }
    pub fn request_digest(&self) -> &str {
        &self.canonical_request_digest
    }
    pub fn workspace(&self) -> &Path {
        &self.canonical_workspace
    }
}

#[derive(Debug, Clone)]
pub struct IngressRequest {
    pub verified: VerifiedIngress,
    /// Stimulus projected as the Contract plan. Never parsed for authority.
    pub plan: String,
    /// Established Contract lineage from the adapter/session, not the payload.
    pub contract_root: Option<String>,
    pub contract_parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionReceipt {
    pub occurrence_id: String,
    pub root_id: String,
}

pub trait DeclareTurnProjection: Send + Sync + 'static {
    fn declare_turn_context(&self, request: &IngressRequest) -> Result<ProjectionReceipt, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    Declared(ProjectionReceipt),
    Adopted(ProjectionReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngressError {
    Unauthenticated,
    WorkspaceNotCanonical,
    MalformedRequest,
    Conflict,
    AbiUnavailable,
    ProjectionFailed,
    ProjectionTimeout,
    ProjectionCrashed,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct OccurrenceKey {
    namespace: String,
    key: String,
    root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthorityAndPayload {
    transport: IngressTransport,
    subject: String,
    tenant: String,
    audience: String,
    scopes: Vec<String>,
    credential_generation: String,
    request_digest: String,
    workspace: PathBuf,
}

#[derive(Debug, Clone)]
struct RecordedAdmission {
    binding: AuthorityAndPayload,
    receipt: ProjectionReceipt,
}

/// The shared synchronous fail-closed declaration choke point.
///
/// The mutex intentionally covers projection.  That makes concurrent copies of
/// one delivery serialize behind the first declaration: byte-identical copies
/// adopt its receipt; authority/body/scope collisions refuse without a second
/// ABI call.  No caller receives an admission on timeout, panic, malformed ABI
/// output, or absence.
pub struct IngressChokePoint<P: DeclareTurnProjection> {
    projector: Arc<P>,
    timeout: Duration,
    admitted: Mutex<std::collections::BTreeMap<OccurrenceKey, RecordedAdmission>>,
}

impl<P: DeclareTurnProjection> IngressChokePoint<P> {
    pub fn new(projector: Arc<P>, timeout: Duration) -> Self {
        Self {
            projector,
            timeout,
            admitted: Mutex::new(Default::default()),
        }
    }

    pub fn admit(&self, request: IngressRequest) -> Result<Admission, IngressError> {
        let key = OccurrenceKey {
            namespace: request.verified.nonce_namespace.clone(),
            key: request.verified.idempotency_key.clone(),
            root: request.contract_root.clone(),
        };
        let binding = AuthorityAndPayload {
            transport: request.verified.transport,
            subject: request.verified.subject.clone(),
            tenant: request.verified.tenant.clone(),
            audience: request.verified.audience.clone(),
            scopes: request.verified.scopes.clone(),
            credential_generation: request.verified.credential_generation.clone(),
            request_digest: request.verified.canonical_request_digest.clone(),
            workspace: request.verified.canonical_workspace.clone(),
        };
        let mut admitted = self
            .admitted
            .lock()
            .map_err(|_| IngressError::ProjectionCrashed)?;
        if let Some(existing) = admitted.get(&key) {
            return if existing.binding == binding {
                Ok(Admission::Adopted(existing.receipt.clone()))
            } else {
                Err(IngressError::Conflict)
            };
        }

        let projector = Arc::clone(&self.projector);
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                projector.declare_turn_context(&request)
            }));
            let _ = tx.send(result);
        });
        let projected = match rx.recv_timeout(self.timeout) {
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(IngressError::ProjectionTimeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(IngressError::ProjectionCrashed);
            }
            Ok(Err(_)) => return Err(IngressError::ProjectionCrashed),
            Ok(Ok(Err(error))) if error == "abi_unavailable" => {
                return Err(IngressError::AbiUnavailable);
            }
            Ok(Ok(Err(_))) => return Err(IngressError::ProjectionFailed),
            Ok(Ok(Ok(receipt))) => receipt,
        };
        if projected.occurrence_id.is_empty() || projected.root_id.is_empty() {
            return Err(IngressError::ProjectionFailed);
        }
        admitted.insert(
            key,
            RecordedAdmission {
                binding,
                receipt: projected.clone(),
            },
        );
        Ok(Admission::Declared(projected))
    }
}

// Small dependency-free SHA-256 so the hooks crate does not grow a crypto
// dependency merely to identify raw request bytes.
fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64) * 8;
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, b) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, v) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(v);
        }
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        calls: AtomicUsize,
        delay: Duration,
        fail: Option<&'static str>,
    }
    impl DeclareTurnProjection for Fake {
        fn declare_turn_context(&self, _: &IngressRequest) -> Result<ProjectionReceipt, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                std::thread::sleep(self.delay);
            }
            if let Some(e) = self.fail {
                return Err(e.into());
            }
            Ok(ProjectionReceipt {
                occurrence_id: "deadbeef".into(),
                root_id: "deadbeef".into(),
            })
        }
    }
    fn req(dir: &Path, body: &[u8], subject: &str, scopes: &[&str]) -> IngressRequest {
        let auth = NativeAuthEvidence::verified(
            subject,
            "tenant-a",
            "aiko",
            scopes.iter().copied(),
            "peer:test",
            "gen-1",
        )
        .unwrap();
        let verified = VerifiedIngress::from_transport_auth(
            IngressTransport::Cli,
            auth,
            dir,
            body,
            "cli:test",
            "delivery-1",
        )
        .unwrap();
        IngressRequest {
            verified,
            plan: String::from_utf8_lossy(body).into(),
            contract_root: None,
            contract_parent: None,
        }
    }
    #[test]
    fn digest_is_raw_sha256_and_workspace_is_canonical() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let d = tempfile::tempdir().unwrap();
        let r = req(d.path(), b"abc", "alice", &["turn.invoke"]);
        assert_eq!(
            r.verified.request_digest(),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(r.verified.workspace().is_absolute());
    }
    #[test]
    fn identical_adopts_but_changed_body_subject_or_scope_conflicts() {
        let d = tempfile::tempdir().unwrap();
        let p = Arc::new(Fake {
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: None,
        });
        let c = IngressChokePoint::new(p.clone(), Duration::from_secs(1));
        assert!(matches!(
            c.admit(req(d.path(), b"go", "alice", &["turn.invoke"])),
            Ok(Admission::Declared(_))
        ));
        assert!(matches!(
            c.admit(req(d.path(), b"go", "alice", &["turn.invoke"])),
            Ok(Admission::Adopted(_))
        ));
        for changed in [
            req(d.path(), b"changed", "alice", &["turn.invoke"]),
            req(d.path(), b"go", "mallory", &["turn.invoke"]),
            req(d.path(), b"go", "alice", &["admin"]),
        ] {
            assert_eq!(c.admit(changed), Err(IngressError::Conflict));
        }
        assert_eq!(p.calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn missing_crashed_and_slow_projection_never_admit() {
        let d = tempfile::tempdir().unwrap();
        for fail in ["abi_unavailable", "bad_abi"] {
            let c = IngressChokePoint::new(
                Arc::new(Fake {
                    calls: AtomicUsize::new(0),
                    delay: Duration::ZERO,
                    fail: Some(fail),
                }),
                Duration::from_secs(1),
            );
            assert!(
                c.admit(req(d.path(), b"go", "a", &["turn.invoke"]))
                    .is_err()
            );
        }
        let c = IngressChokePoint::new(
            Arc::new(Fake {
                calls: AtomicUsize::new(0),
                delay: Duration::from_millis(50),
                fail: None,
            }),
            Duration::from_millis(1),
        );
        assert_eq!(
            c.admit(req(d.path(), b"go", "a", &["turn.invoke"])),
            Err(IngressError::ProjectionTimeout)
        );
    }
}
