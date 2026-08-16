use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Barrier, Mutex};

const NOW: i64 = 1_700_000_000;
const GENERATION: u64 = 41;
const HOST: &str = "api.example.test";

#[derive(Default)]
struct TestProvider {
    calls: AtomicUsize,
    barrier: Option<Arc<Barrier>>,
    release: Option<Arc<Barrier>>,
    error: Mutex<Option<CredentialHandleError>>,
}

impl NativeAccountCredentialProvider for TestProvider {
    fn resolve_account_session(&self) -> Result<NativeAccountSession, CredentialHandleError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(barrier) = &self.barrier {
            barrier.wait();
        }
        if let Some(release) = &self.release {
            release.wait();
        }
        if let Some(error) = self.error.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(NativeAccountSession {
            bearer: b"ACCOUNT-SESSION-SECRET".to_vec(),
            subject: "subject-1".into(),
            tenant: "tenant-1".into(),
            generation: GENERATION,
            expires_at_unix: NOW + 600,
            mfa_satisfied: true,
        })
    }
}

fn binding() -> CredentialHandleBinding {
    CredentialHandleBinding {
        subject: "subject-1".into(),
        tenant: "tenant-1".into(),
        contract_execution: "contract-run-9".into(),
        lease_fence: 17,
        audience: "account-api".into(),
        destination_host: HOST.into(),
        operation: "message.send".into(),
        resource: "conversation/72".into(),
        credential_generation: GENERATION,
        expires_at_unix: NOW + 300,
        mfa_required: true,
        replay_policy: ReplayPolicy::OneShot,
    }
}

fn broker(provider: TestProvider) -> CredentialHandleBroker<TestProvider> {
    CredentialHandleBroker::with_clock_and_id(
        provider,
        || NOW,
        || "account:handle:11111111-1111-4111-8111-111111111111".into(),
    )
}

fn use_for<'a>(handle: &'a str) -> CredentialUse<'a> {
    CredentialUse {
        handle,
        subject: "subject-1",
        tenant: "tenant-1",
        contract_execution: "contract-run-9",
        lease_fence: 17,
        operation: "message.send",
        resource: "conversation/72",
        credential_generation: GENERATION,
        destination: DestinationPlan {
            audience: "account-api",
            initial: "https://api.example.test/v1/start",
            redirects: &["https://api.example.test/v1/continue"],
            final_destination: "https://api.example.test/v1/messages",
        },
    }
}

#[test]
fn credential_handle_metadata_is_opaque_and_account_bound() {
    let broker = broker(TestProvider::default());
    let metadata = broker.issue(binding()).unwrap();
    let encoded = serde_json::to_string(&metadata).unwrap();
    assert!(encoded.contains("subject-1"));
    assert!(encoded.contains("tenant-1"));
    assert!(encoded.contains("contract-run-9"));
    assert!(encoded.contains("message.send"));
    assert!(encoded.contains("conversation/72"));
    assert!(!encoded.contains("ACCOUNT-SESSION-SECRET"));
    assert!(!encoded.contains("api_key"));
    assert_eq!(
        metadata.handle,
        "account:handle:11111111-1111-4111-8111-111111111111"
    );
}

#[test]
fn credential_handle_resolves_only_after_destination_and_redirect_revalidation() {
    let provider = TestProvider::default();
    let broker = broker(provider);
    let metadata = broker.issue(binding()).unwrap();

    let request = reqwest::Client::new().post("https://api.example.test/v1/messages");
    let built = broker
        .execute(&use_for(&metadata.handle), |authorization| {
            authorization.apply(request).unwrap().build().unwrap()
        })
        .unwrap();
    assert_eq!(
        built.headers()[reqwest::header::AUTHORIZATION],
        "Bearer ACCOUNT-SESSION-SECRET"
    );
    assert_eq!(broker.metadata(&metadata.handle).unwrap().use_count, 1);
    assert_eq!(
        broker.execute(&use_for(&metadata.handle), |_| ()),
        Err(CredentialHandleError::Replay)
    );
}

#[test]
fn credential_handle_cross_scope_generation_and_lease_replay_are_refused() {
    let cases: &[(&str, Box<dyn Fn(&mut CredentialHandleBinding)>)] = &[
        ("subject", Box::new(|b| b.subject = "other-subject".into())),
        ("tenant", Box::new(|b| b.tenant = "other-tenant".into())),
        (
            "execution",
            Box::new(|b| b.contract_execution = "other-run".into()),
        ),
        ("lease", Box::new(|b| b.lease_fence += 1)),
        (
            "operation",
            Box::new(|b| b.operation = "account.delete".into()),
        ),
        (
            "resource",
            Box::new(|b| b.resource = "conversation/other".into()),
        ),
        ("generation", Box::new(|b| b.credential_generation += 1)),
    ];
    for (label, alter) in cases {
        let broker = CredentialHandleBroker::with_clock_and_id(TestProvider::default(), || NOW, {
            let label = label.to_string();
            move || format!("account:handle:{label}")
        });
        let metadata = broker.issue(binding()).unwrap();
        let mut requested = binding();
        alter(&mut requested);
        let use_ = CredentialUse {
            handle: &metadata.handle,
            subject: &requested.subject,
            tenant: &requested.tenant,
            contract_execution: &requested.contract_execution,
            lease_fence: requested.lease_fence,
            operation: &requested.operation,
            resource: &requested.resource,
            credential_generation: requested.credential_generation,
            destination: DestinationPlan {
                audience: "account-api",
                initial: "https://api.example.test/a",
                redirects: &[],
                final_destination: "https://api.example.test/b",
            },
        };
        assert!(
            matches!(
                broker.execute(&use_, |_| ()),
                Err(CredentialHandleError::BindingMismatch(_))
            ),
            "{label}"
        );
    }
}

#[test]
fn credential_handle_cross_host_redirect_refuses_before_provider_resolution() {
    let provider = TestProvider::default();
    let broker = broker(provider);
    let metadata = broker.issue(binding()).unwrap();
    let use_ = CredentialUse {
        destination: DestinationPlan {
            audience: "account-api",
            initial: "https://api.example.test/start",
            redirects: &["https://attacker.example/steal"],
            final_destination: "https://api.example.test/final",
        },
        ..use_for(&metadata.handle)
    };
    assert!(matches!(
        broker.execute(&use_, |_| ()),
        Err(CredentialHandleError::Destination(_))
    ));
    assert_eq!(broker.provider.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn credential_handle_api_key_provider_has_no_ambient_fallback() {
    let provider = TestProvider {
        error: Mutex::new(Some(CredentialHandleError::ApiKeyForbidden)),
        ..Default::default()
    };
    let broker = broker(provider);
    let metadata = broker.issue(binding()).unwrap();
    let effect_crossed = AtomicBool::new(false);
    assert_eq!(
        broker.execute(&use_for(&metadata.handle), |_| effect_crossed
            .store(true, Ordering::SeqCst)),
        Err(CredentialHandleError::ApiKeyForbidden)
    );
    assert!(!effect_crossed.load(Ordering::SeqCst));
}

#[test]
fn credential_handle_expiry_and_revoke_fail_closed() {
    let expired = CredentialHandleBroker::with_clock_and_id(
        TestProvider::default(),
        || NOW + 301,
        || "account:handle:expired".into(),
    );
    assert_eq!(
        expired.issue(binding()),
        Err(CredentialHandleError::Expired)
    );

    let broker = broker(TestProvider::default());
    let metadata = broker.issue(binding()).unwrap();
    broker.revoke(&metadata.handle).unwrap();
    assert_eq!(
        broker.execute(&use_for(&metadata.handle), |_| ()),
        Err(CredentialHandleError::Revoked)
    );
}

#[test]
fn credential_handle_revoke_cannot_win_between_lease_and_effect() {
    let reached_provider = Arc::new(Barrier::new(2));
    let release_provider = Arc::new(Barrier::new(2));
    let provider = TestProvider {
        barrier: Some(reached_provider.clone()),
        release: Some(release_provider.clone()),
        ..Default::default()
    };
    let broker = Arc::new(CredentialHandleBroker::with_clock_and_id(
        provider,
        || NOW,
        || "account:handle:race".into(),
    ));
    let handle = broker.issue(binding()).unwrap().handle;
    let crossed = Arc::new(AtomicBool::new(false));

    let executor = {
        let broker = broker.clone();
        let handle = handle.clone();
        let crossed = crossed.clone();
        std::thread::spawn(move || {
            broker
                .execute(&use_for(&handle), |_| crossed.store(true, Ordering::SeqCst))
                .unwrap();
        })
    };
    reached_provider.wait();
    let revoke_done = Arc::new(AtomicBool::new(false));
    let revoker = {
        let broker = broker.clone();
        let handle = handle.clone();
        let revoke_done = revoke_done.clone();
        std::thread::spawn(move || {
            broker.revoke(&handle).unwrap();
            revoke_done.store(true, Ordering::SeqCst);
        })
    };
    std::thread::yield_now();
    assert!(!revoke_done.load(Ordering::SeqCst));
    assert!(!crossed.load(Ordering::SeqCst));
    release_provider.wait();
    executor.join().unwrap();
    revoker.join().unwrap();
    assert!(crossed.load(Ordering::SeqCst));
    assert!(revoke_done.load(Ordering::SeqCst));
    assert_eq!(
        broker.execute(&use_for(&handle), |_| ()),
        Err(CredentialHandleError::Revoked)
    );
}

#[cfg(unix)]
#[test]
fn credential_handle_sigkill_leaves_no_secret_or_metadata_residue() {
    use std::os::unix::process::ExitStatusExt;
    let sandbox = tempfile::tempdir().unwrap();
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg("kill -9 $$")
        .env_clear()
        .current_dir(sandbox.path())
        .status()
        .unwrap();
    assert_eq!(status.signal(), Some(9));
    assert_eq!(std::fs::read_dir(sandbox.path()).unwrap().count(), 0);
    // Broker construction/issuance uses memory and the provider only; no HOME/tmp/file backend.
    let broker = broker(TestProvider::default());
    let metadata = broker.issue(binding()).unwrap();
    assert!(!sandbox.path().join(&metadata.handle).exists());
}
