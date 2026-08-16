//! Mechanically enumerable public ingress routes.
//!
//! Every launch-capable public face calls a handler in `PUBLIC_INGRESS_ROUTES`.
//! The handler authenticates/canonicalizes and then invokes the same mandatory
//! Contract choke point.  This inventory contains no generic observer hooks.

use std::path::PathBuf;
use xai_grok_hooks::contract_projection::{
    Admission, DeclareTurnProjection, IngressChokePoint, IngressError, IngressRequest,
    IngressTransport, NativeAuthEvidence, VerifiedIngress,
};

#[derive(Debug, Clone)]
pub struct PublicIngressRequest {
    pub auth: NativeAuthEvidence,
    pub workspace: PathBuf,
    pub raw_request: Vec<u8>,
    pub nonce_namespace: String,
    pub idempotency_key: String,
    pub plan: String,
    /// Lineage comes from the authenticated session/schedule, never raw body.
    pub contract_root: Option<String>,
    pub contract_parent: Option<String>,
}

/// Convert the shell's already authenticated native session into ingress evidence.
/// Request metadata and environment variables are deliberately not consulted.
pub fn native_session_auth(
    auth: &crate::auth::GrokAuth,
    audience: &str,
    scopes: &[&str],
) -> Result<NativeAuthEvidence, IngressError> {
    let subject = auth
        .principal_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(auth.user_id.as_str());
    let tenant = auth
        .team_id
        .as_deref()
        .or(auth.organization_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("personal:{subject}"));
    NativeAuthEvidence::verified(
        subject,
        tenant,
        audience,
        scopes.iter().copied(),
        format!("native-session:{:?}", auth.auth_mode),
        auth.create_time.timestamp_millis().to_string(),
    )
}

/// Read the shell-owned authenticated session without exposing credentials to
/// an outer composition crate.
pub fn native_session_auth_from_manager(
    manager: &crate::auth::AuthManager,
    audience: &str,
    scopes: &[&str],
) -> Result<NativeAuthEvidence, IngressError> {
    let auth = manager.current().ok_or(IngressError::Unauthenticated)?;
    native_session_auth(&auth, audience, scopes)
}

pub trait MandatoryIngress: Send + Sync {
    fn admit_request(&self, request: IngressRequest) -> Result<Admission, IngressError>;
}

impl<P: DeclareTurnProjection> MandatoryIngress for IngressChokePoint<P> {
    fn admit_request(&self, request: IngressRequest) -> Result<Admission, IngressError> {
        self.admit(request)
    }
}

pub type PublicRouteHandler =
    fn(&dyn MandatoryIngress, PublicIngressRequest) -> Result<Admission, IngressError>;

#[derive(Clone, Copy)]
pub struct PublicIngressRoute {
    pub face: &'static str,
    pub transport: IngressTransport,
    pub handler: PublicRouteHandler,
}

fn through_shared(
    ingress: &dyn MandatoryIngress,
    transport: IngressTransport,
    request: PublicIngressRequest,
) -> Result<Admission, IngressError> {
    let verified = VerifiedIngress::from_transport_auth(
        transport,
        request.auth,
        &request.workspace,
        &request.raw_request,
        request.nonce_namespace,
        request.idempotency_key,
    )?;
    ingress.admit_request(IngressRequest {
        verified,
        plan: request.plan,
        contract_root: request.contract_root,
        contract_parent: request.contract_parent,
    })
}

macro_rules! adapter {
    ($name:ident, $transport:ident) => {
        pub fn $name(
            ingress: &dyn MandatoryIngress,
            request: PublicIngressRequest,
        ) -> Result<Admission, IngressError> {
            through_shared(ingress, IngressTransport::$transport, request)
        }
    };
}
adapter!(cli_ingress, Cli);
adapter!(headless_ingress, Headless);
adapter!(acp_ingress, Acp);
adapter!(mcp_ingress, Mcp);
adapter!(plugin_ingress, Plugin);
adapter!(gateway_ingress, Gateway);
adapter!(webhook_ingress, Webhook);
adapter!(cron_ingress, Cron);

pub const PUBLIC_INGRESS_ROUTES: [PublicIngressRoute; 8] = [
    PublicIngressRoute {
        face: "cli",
        transport: IngressTransport::Cli,
        handler: cli_ingress,
    },
    PublicIngressRoute {
        face: "headless",
        transport: IngressTransport::Headless,
        handler: headless_ingress,
    },
    PublicIngressRoute {
        face: "acp",
        transport: IngressTransport::Acp,
        handler: acp_ingress,
    },
    PublicIngressRoute {
        face: "mcp",
        transport: IngressTransport::Mcp,
        handler: mcp_ingress,
    },
    PublicIngressRoute {
        face: "plugin",
        transport: IngressTransport::Plugin,
        handler: plugin_ingress,
    },
    PublicIngressRoute {
        face: "gateway",
        transport: IngressTransport::Gateway,
        handler: gateway_ingress,
    },
    PublicIngressRoute {
        face: "webhook",
        transport: IngressTransport::Webhook,
        handler: webhook_ingress,
    },
    PublicIngressRoute {
        face: "cron",
        transport: IngressTransport::Cron,
        handler: cron_ingress,
    },
];

/// Production entry used immediately before a face launches an agent/workflow/tool/effect.
pub fn admit_public_ingress(
    face: &str,
    request: PublicIngressRequest,
) -> Result<Admission, IngressError> {
    let route = PUBLIC_INGRESS_ROUTES
        .iter()
        .find(|route| route.face == face)
        .ok_or(IngressError::MalformedRequest)?;
    (route.handler)(super::hook_ingress::shared_ingress(), request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use xai_grok_hooks::contract_projection::ProjectionReceipt;

    struct Projection {
        calls: AtomicUsize,
    }
    impl DeclareTurnProjection for Projection {
        fn declare_turn_context(
            &self,
            request: &IngressRequest,
        ) -> Result<ProjectionReceipt, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.verified.scopes(), &["turn.invoke"]);
            Ok(ProjectionReceipt {
                occurrence_id: "deadbeef".into(),
                root_id: "deadbeef".into(),
            })
        }
    }
    fn request(dir: &std::path::Path, face: &str) -> PublicIngressRequest {
        PublicIngressRequest {
            auth: NativeAuthEvidence::verified(
                format!("peer:{face}"),
                "tenant-a",
                "aiko",
                ["turn.invoke"],
                format!("native:{face}"),
                "gen-1",
            )
            .unwrap(),
            workspace: dir.into(),
            raw_request: format!("request:{face}").into_bytes(),
            nonce_namespace: format!("{face}:native"),
            idempotency_key: "delivery-1".into(),
            plan: format!("request:{face}"),
            contract_root: None,
            contract_parent: None,
        }
    }
    #[test]
    #[ignore = "acceptance gate builds and selects the real Contract dynamic library"]
    fn real_native_abi_is_reached_from_every_public_face() {
        let library = std::env::var_os("AIKO_CONTRACT_LIBRARY")
            .expect("gate must select the built Contract ABI");
        assert!(std::path::Path::new(&library).is_file());
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        // Filtered acceptance test runs alone; isolate Contract's durable HOME.
        unsafe { std::env::set_var("HOME", &home) };
        for route in PUBLIC_INGRESS_ROUTES {
            let original = request(dir.path(), route.face);
            let first = admit_public_ingress(route.face, original.clone());
            assert!(
                matches!(first, Ok(Admission::Declared(_))),
                "{} did not reach native ABI: {first:?}",
                route.face
            );
            let replay = admit_public_ingress(route.face, original.clone());
            assert!(
                matches!(replay, Ok(Admission::Adopted(_))),
                "{} did not adopt replay: {replay:?}",
                route.face
            );
            let mut collision = original;
            collision.raw_request.push(b'!');
            assert_eq!(
                admit_public_ingress(route.face, collision),
                Err(IngressError::Conflict)
            );
        }
    }

    #[test]
    fn every_public_face_executes_the_same_real_choke_point_before_launch() {
        assert_eq!(PUBLIC_INGRESS_ROUTES.len(), IngressTransport::ALL.len());
        let faces: Vec<_> = PUBLIC_INGRESS_ROUTES.iter().map(|r| r.face).collect();
        assert_eq!(
            faces,
            vec![
                "cli", "headless", "acp", "mcp", "plugin", "gateway", "webhook", "cron"
            ]
        );
        let dir = tempfile::tempdir().unwrap();
        let projection = Arc::new(Projection {
            calls: AtomicUsize::new(0),
        });
        let choke = IngressChokePoint::new(projection.clone(), Duration::from_secs(1));
        for route in PUBLIC_INGRESS_ROUTES {
            let admitted = (route.handler)(&choke, request(dir.path(), route.face));
            assert!(
                matches!(admitted, Ok(Admission::Declared(_))),
                "{} bypassed: {admitted:?}",
                route.face
            );
        }
        assert_eq!(projection.calls.load(Ordering::SeqCst), 8);
    }
}
