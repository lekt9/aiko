//! The web face of the aiko CLI and native daemon. Two surfaces, one rule:
//!
//! - `/cli/*`   — a fixed catalog of CLI verbs run as jobs. Fixed argv only:
//!   the web never composes arbitrary command lines. Long flows (device-code
//!   login) stream their output through a polled job, so "login works" from a
//!   page that cannot own a TTY.
//! - `/native/*` — reverse proxy to the daemon in `~/.aiko/native/api.json`,
//!   bearer token injected server-side so the browser never holds it.
//!
//! Both require a loopback Host and, when a browser sends Origin, its exact
//! matching HTTP origin. The tunnel forwards its public hostname in Host, so
//! the public website gets the UI and Manus API but never the raw daemon or CLI
//! — unless the operator explicitly sets AIKO_EXPOSE_NATIVE=1.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::native_api;
use crate::webhost::HostState;

const OUTPUT_CAP: usize = 128 * 1024;
const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
const CLI_CANCELLATION_SUPPORTED: bool = cfg!(unix);
const CANCELLATION_NOT_IMPLEMENTED: &str =
    "job cancellation is not implemented on this platform; the process tree is still running";

pub struct Verb {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub argv: &'static [&'static str],
    pub long_running: bool,
}

/// Every entry is a complete, fixed invocation verified to run without a TTY.
/// Growing this table is the supported way to expose more of the CLI.
pub const VERBS: &[Verb] = &[
    Verb {
        id: "login",
        title: "Sign in",
        description: "Device-code sign-in: a verification URL and code appear below; approve it in any browser.",
        argv: &["login", "--device-auth"],
        long_running: true,
    },
    Verb {
        id: "logout",
        title: "Sign out",
        description: "Sign out and clear cached credentials.",
        argv: &["logout"],
        long_running: false,
    },
    Verb {
        id: "version",
        title: "Version",
        description: "Print the runtime version.",
        argv: &["version"],
        long_running: false,
    },
    Verb {
        id: "models",
        title: "Models",
        description: "List available models for the signed-in account.",
        argv: &["models"],
        long_running: false,
    },
    Verb {
        id: "inspect",
        title: "Inspect",
        description: "Show the configuration aiko discovers for this machine.",
        argv: &["inspect"],
        long_running: false,
    },
    Verb {
        id: "mcp-list",
        title: "MCP servers",
        description: "List configured MCP servers.",
        argv: &["mcp", "list"],
        long_running: false,
    },
    Verb {
        id: "tasks-list",
        title: "Durable tasks",
        description: "Inspect Contract-native durable tasks.",
        argv: &["tasks", "list"],
        long_running: false,
    },
];

#[derive(Clone, Serialize)]
pub struct JobSnapshot {
    id: u64,
    verb: String,
    output: String,
    done: bool,
    exit_code: Option<i32>,
    cancelled: bool,
    timed_out: bool,
}

struct Job {
    verb: String,
    output: String,
    done: bool,
    exit_code: Option<i32>,
    cancel_requested: bool,
    cancelled: bool,
    timed_out: bool,
}

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    map: std::sync::Mutex<HashMap<u64, Arc<std::sync::Mutex<Job>>>>,
}

/// The loopback gate. Host distinguishes the local app from a tunnel, while
/// the browser's Origin prevents a hostile website from driving privileged
/// loopback endpoints. Non-browser clients may omit Origin; when present it
/// must name this exact HTTP origin. AIKO_EXPOSE_NATIVE is the explicit bypass
/// for operators who deliberately publish the surface.
pub fn is_local_request(headers: &HeaderMap) -> bool {
    if std::env::var("AIKO_EXPOSE_NATIVE").is_ok_and(|v| v == "1" || v == "true") {
        return true;
    }
    let Some(host) = headers.get("host").and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let host_name = host.rsplit_once(':').map_or(host, |(name, port)| {
        // "::1" has colons but no bracketed port form when raw. An empty port
        // is malformed rather than a loopback authority.
        if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    if !matches!(host_name, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
        return false;
    }

    let mut origins = headers.get_all("origin").iter();
    let Some(origin) = origins.next() else {
        return true;
    };
    if origins.next().is_some() {
        return false;
    }
    origin
        .to_str()
        .is_ok_and(|origin| origin == format!("http://{host}"))
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        "this surface is loopback-only; open the app locally (or set AIKO_EXPOSE_NATIVE=1 on the host to override)",
    )
        .into_response()
}

/// A tracked, self-contained face for the CLI. It lives with the desktop host
/// rather than inside the frontend gitlink, so a fresh clone can rebuild the
/// integration from the parent repository alone.
pub async fn console_page(headers: HeaderMap) -> Response {
    if !is_local_request(&headers) {
        return forbidden();
    }
    (
        [
            ("content-type", "text/html; charset=utf-8"),
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
            ("referrer-policy", "no-referrer"),
            (
                "content-security-policy",
                "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            ),
        ],
        include_str!("../../public/console.html"),
    )
        .into_response()
}

pub async fn cli_verbs(headers: HeaderMap) -> Response {
    if !is_local_request(&headers) {
        return forbidden();
    }
    #[derive(Serialize)]
    struct Entry {
        id: &'static str,
        title: &'static str,
        description: &'static str,
        long_running: bool,
    }
    let catalog: Vec<Entry> = VERBS
        .iter()
        .map(|verb| Entry {
            id: verb.id,
            title: verb.title,
            description: verb.description,
            long_running: verb.long_running,
        })
        .collect();
    axum::Json(catalog).into_response()
}

#[derive(serde::Deserialize)]
pub struct RunRequest {
    verb: String,
}

pub async fn cli_run(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<RunRequest>,
) -> Response {
    if !is_local_request(&headers) {
        return forbidden();
    }
    let Some(verb) = VERBS.iter().find(|verb| verb.id == request.verb) else {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "unknown verb '{}': the catalog at /cli/verbs is the whole surface",
                request.verb
            ),
        )
            .into_response();
    };

    let jobs = &state.jobs;
    let id = jobs.next.fetch_add(1, Ordering::Relaxed) + 1;
    let job = Arc::new(std::sync::Mutex::new(Job {
        verb: verb.id.to_string(),
        output: String::new(),
        done: false,
        exit_code: None,
        cancel_requested: false,
        cancelled: false,
        timed_out: false,
    }));
    if let Ok(mut map) = jobs.map.lock() {
        map.insert(id, job.clone());
    }

    let mut command = tokio::process::Command::new(&state.aiko_bin);
    command
        .args(verb.argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    configure_process_tree(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish(
                &job,
                Some(-1),
                Some(format!("could not start {}: {error}", state.aiko_bin)),
                false,
                false,
            );
            return snapshot_response(id, &job);
        }
    };

    let stdout_task = child
        .stdout
        .take()
        .map(|stdout| append_lines(stdout, job.clone()));
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| append_lines(stderr, job.clone()));
    let job_for_wait = job.clone();
    tokio::spawn(monitor_child(
        child,
        job_for_wait,
        stdout_task,
        stderr_task,
        JOB_TIMEOUT,
    ));

    snapshot_response(id, &job)
}

pub async fn cli_job(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Path(id): Path<u64>,
) -> Response {
    if !is_local_request(&headers) {
        return forbidden();
    }
    let job = state
        .jobs
        .map
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned());
    match job {
        Some(job) => snapshot_response(id, &job),
        None => (StatusCode::NOT_FOUND, "no such job").into_response(),
    }
}

pub async fn cli_job_cancel(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Path(id): Path<u64>,
) -> Response {
    if !is_local_request(&headers) {
        return forbidden();
    }
    // Until Windows jobs are assigned to a kill-on-close Job Object, accepting
    // this request could kill only the immediate child and falsely settle a
    // still-running process tree. Refuse before even looking up (and therefore
    // before mutating) the job.
    if !CLI_CANCELLATION_SUPPORTED {
        return (StatusCode::NOT_IMPLEMENTED, CANCELLATION_NOT_IMPLEMENTED).into_response();
    }
    let job = state
        .jobs
        .map
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned());
    match job {
        Some(job) => {
            if let Ok(mut value) = job.lock() {
                if !value.done {
                    value.cancel_requested = true;
                }
            }
            snapshot_response(id, &job)
        }
        None => (StatusCode::NOT_FOUND, "no such job").into_response(),
    }
}

#[cfg(unix)]
fn configure_process_tree(command: &mut tokio::process::Command) {
    // Give each job its own process group before spawn. Cancellation must reach
    // descendants which inherited our pipes; killing only the shell leaves the
    // readers open and makes a cancellation snapshot impossible to settle.
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_tree(_command: &mut tokio::process::Command) {}

#[cfg(unix)]
async fn terminate_process_tree(
    child: &mut tokio::process::Child,
    process_group: Option<u32>,
) -> std::io::Result<()> {
    if let Some(pid) = process_group {
        // process_group(0) makes the child's PID its PGID. Keep that ID even
        // after the immediate child exits: pipe-inheriting descendants can
        // outlive it and are still members of the group we must terminate.
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
    }
    match child.try_wait()? {
        Some(_) => Ok(()),
        None => child.wait().await.map(|_| ()),
    }
}

#[cfg(not(unix))]
async fn terminate_process_tree(
    child: &mut tokio::process::Child,
    _process_group: Option<u32>,
) -> std::io::Result<()> {
    // Keep non-Unix targets compiling and preserve their existing immediate-
    // child behavior. Windows process-tree cancellation requires a Job Object.
    child.kill().await?;
    child.wait().await.map(|_| ())
}

async fn monitor_child(
    mut child: tokio::process::Child,
    job: Arc<std::sync::Mutex<Job>>,
    stdout_task: Option<tokio::task::JoinHandle<()>>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    timeout: std::time::Duration,
) {
    let started = tokio::time::Instant::now();
    let process_group = child.id();
    let mut exited = None;
    let (code, note, cancelled, timed_out) = loop {
        let cancel_requested = job.lock().is_ok_and(|job| job.cancel_requested);
        if cancel_requested {
            let (note, cancelled) = match terminate_process_tree(&mut child, process_group).await {
                Ok(()) => ("cancelled by user".to_string(), true),
                Err(error) => (format!("cancellation failed: {error}"), false),
            };
            break (Some(-1), Some(note), cancelled, false);
        }
        if started.elapsed() >= timeout {
            let termination = terminate_process_tree(&mut child, process_group)
                .await
                .err();
            let note = termination.map_or_else(
                || format!("timed out after {}s", timeout.as_secs()),
                |error| {
                    format!(
                        "timed out after {}s; termination failed: {error}",
                        timeout.as_secs()
                    )
                },
            );
            break (Some(-1), Some(note), false, true);
        }
        if exited.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exited = Some((status.code(), None)),
                Ok(None) => {}
                Err(error) => exited = Some((Some(-1), Some(error.to_string()))),
            }
        }
        let stdout_done = stdout_task
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished);
        let stderr_done = stderr_task
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished);
        if stdout_done && stderr_done {
            if let Some((code, note)) = exited.take() {
                break (code, note, false, false);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    // A process may exit before the independent pipe readers have drained.
    // Publishing done earlier makes the UI stop polling and silently loses
    // the final lines — exactly the output a failing command needs most.
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    finish(&job, code, note, cancelled, timed_out);
}

fn append_lines<R>(reader: R, job: Arc<std::sync::Mutex<Job>>) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut job) = job.lock() {
                if job.output.len() < OUTPUT_CAP {
                    job.output.push_str(&line);
                    job.output.push('\n');
                }
            }
        }
    })
}

fn finish(
    job: &Arc<std::sync::Mutex<Job>>,
    code: Option<i32>,
    note: Option<String>,
    cancelled: bool,
    timed_out: bool,
) {
    if let Ok(mut job) = job.lock() {
        if let Some(note) = note {
            job.output.push_str(&note);
            job.output.push('\n');
        }
        job.done = true;
        job.exit_code = code;
        job.cancelled = cancelled;
        job.timed_out = timed_out;
    }
}

fn snapshot_response(id: u64, job: &Arc<std::sync::Mutex<Job>>) -> Response {
    match job.lock() {
        Ok(job) => axum::Json(JobSnapshot {
            id,
            verb: job.verb.clone(),
            output: job.output.clone(),
            done: job.done,
            exit_code: job.exit_code,
            cancelled: job.cancelled,
            timed_out: job.timed_out,
        })
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Serialize, PartialEq, Debug)]
pub struct AuthAccount {
    provider: String,
    email: Option<String>,
    auth_mode: Option<String>,
    expires_at: Option<String>,
}

#[derive(Serialize)]
pub struct AuthStatus {
    signed_in: bool,
    accounts: Vec<AuthAccount>,
}

/// The Aiko identity provider. Login IS this issuer (`aiko login` device flow
/// targets it); other auth.json entries are third-party residue and must not
/// be what "signed in" means.
pub const AIKO_AUTH_ISSUER: &str = "aiko.theclarityproject.net";

/// Reduce an auth.json document to identity only. The file maps
/// "issuer::client" → an entry holding tokens; NOTHING token-shaped may leave
/// this function — the browser gets who you are, never what proves it.
pub fn auth_accounts(raw: &str) -> Vec<AuthAccount> {
    let Ok(document) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(entries) = document.as_object() else {
        return Vec::new();
    };
    let mut accounts: Vec<AuthAccount> = entries
        .iter()
        .filter_map(|(key, entry)| {
            let entry = entry.as_object()?;
            let provider = key.split("::").next().unwrap_or(key);
            let provider = provider
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
            let text = |field: &str| {
                entry
                    .get(field)
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            };
            Some(AuthAccount {
                provider,
                email: text("email"),
                auth_mode: text("auth_mode"),
                expires_at: text("expires_at"),
            })
        })
        .collect();
    // The Aiko account leads deterministically — the UI's "the account" is
    // accounts[0], and that must never depend on JSON key order.
    accounts.sort_by_key(|account| account.provider != AIKO_AUTH_ISSUER);
    accounts
}

pub fn is_aiko_signed_in(accounts: &[AuthAccount]) -> bool {
    accounts
        .iter()
        .any(|account| account.provider == AIKO_AUTH_ISSUER)
}

fn auth_file() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    [".aiko/auth.json", ".grok/auth.json"]
        .iter()
        .map(|rel| home.join(rel))
        .find(|path| path.is_file())
}

pub async fn cli_auth(headers: HeaderMap) -> Response {
    if !is_local_request(&headers) {
        return forbidden();
    }
    let accounts = auth_file()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| auth_accounts(&raw))
        .unwrap_or_default();
    axum::Json(AuthStatus {
        signed_in: is_aiko_signed_in(&accounts),
        accounts,
    })
    .into_response()
}

/// `/native/{*rest}` — the daemon's whole versioned surface, discovered live.
/// The manifest and OpenAPI document the operations; this proxy adds nothing
/// and removes nothing beyond the loopback gate and the token.
pub async fn native_proxy(
    State(state): State<Arc<HostState>>,
    request: axum::extract::Request,
) -> Response {
    if !is_local_request(request.headers()) {
        return forbidden();
    }
    let discovery = match native_api::read_discovery() {
        Ok(discovery) => discovery,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("aiko runtime not discovered: {error}"),
            )
                .into_response();
        }
    };

    // Owned copies: the strings must outlive `request.into_parts()` below.
    let path = request
        .uri()
        .path()
        .trim_start_matches("/native/")
        .to_string();
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    if !path.starts_with("v1/") || path.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            "native paths are /native/v1/... only",
        )
            .into_response();
    }
    let base = discovery.base_url.trim_end_matches('/');
    let token = discovery.authorization.token.clone();

    let wants_websocket = request
        .headers()
        .get("upgrade")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if wants_websocket {
        // The daemon accepts the token as a query parameter for WebSocket
        // clients (browsers cannot set Authorization on a socket).
        let separator = if query.is_empty() { "?" } else { "&" };
        let target = format!(
            "{}/{path}{query}{separator}token={token}",
            base.replacen("http", "ws", 1)
        );
        let (mut parts, _body) = request.into_parts();
        use axum::extract::FromRequestParts;
        return match axum::extract::WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => ws.on_upgrade(move |socket| crate::webhost::bridge_ws(socket, target)),
            Err(rejection) => rejection.into_response(),
        };
    }

    let method = request.method().clone();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "DELETE") {
        return (StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response();
    }
    let (parts, body) = request.into_parts();
    let target = format!("{base}/{path}{query}");
    let mut outbound = state.client.request(method, &target).bearer_auth(token);
    if let Some(content_type) = parts.headers.get("content-type") {
        outbound = outbound.header("content-type", content_type);
    }
    outbound = outbound.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    crate::webhost::relay(outbound, &target).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_host(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", host.parse().unwrap());
        headers
    }

    #[test]
    fn loopback_gate_admits_local_and_refuses_tunnel_hosts() {
        assert!(is_local_request(&headers_with_host("127.0.0.1:17870")));
        assert!(is_local_request(&headers_with_host("localhost:17870")));
        assert!(is_local_request(&headers_with_host("localhost")));

        let mut same_origin = headers_with_host("127.0.0.1:17870");
        same_origin.insert("origin", "http://127.0.0.1:17870".parse().unwrap());
        assert!(is_local_request(&same_origin));
        for origin in [
            "https://127.0.0.1:17870",
            "http://127.0.0.1:9999",
            "https://hostile.example",
            "null",
        ] {
            let mut hostile = headers_with_host("127.0.0.1:17870");
            hostile.insert("origin", origin.parse().unwrap());
            assert!(!is_local_request(&hostile), "admitted Origin {origin}");
        }
        assert!(!is_local_request(&headers_with_host("localhost:")));
        assert!(!is_local_request(&headers_with_host(
            "lucky-otter.trycloudflare.com"
        )));
        assert!(!is_local_request(&headers_with_host("192.168.1.20:17870")));
        assert!(!is_local_request(&HeaderMap::new()));
    }

    #[test]
    fn auth_accounts_extracts_identity_and_never_secrets() {
        let raw = r#"{
            "https://auth.example.com::client-1": {
                "key": "sk-SECRET-KEY",
                "refresh_token": "rt-SECRET-TOKEN",
                "auth_mode": "oauth",
                "email": "person@example.com",
                "expires_at": "2026-09-02T00:00:00Z"
            }
        }"#;
        let accounts = auth_accounts(raw);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].provider, "auth.example.com");
        assert_eq!(accounts[0].email.as_deref(), Some("person@example.com"));
        assert_eq!(accounts[0].auth_mode.as_deref(), Some("oauth"));

        // The seal: serialize exactly what the endpoint would send and prove
        // no token material survives the reduction.
        let wire = serde_json::to_string(&accounts).unwrap();
        assert!(!wire.contains("SECRET"), "secret leaked to wire: {wire}");
        assert!(!wire.contains("key"), "token field leaked: {wire}");
        assert!(!wire.contains("refresh"), "token field leaked: {wire}");

        // Garbage in → empty out, never a panic.
        assert!(auth_accounts("not json").is_empty());
        assert!(auth_accounts("[1,2,3]").is_empty());
    }

    #[test]
    fn signed_in_means_the_aiko_issuer_and_it_leads() {
        // x.ai listed FIRST in the document: order must not decide identity.
        let raw = r#"{
            "https://auth.x.ai::client-x": {
                "email": "person@example.com", "auth_mode": "oidc"
            },
            "https://aiko.theclarityproject.net::aiko-cli": {
                "email": "person@example.com", "auth_mode": "oidc"
            }
        }"#;
        let accounts = auth_accounts(raw);
        assert_eq!(accounts[0].provider, AIKO_AUTH_ISSUER);
        assert!(is_aiko_signed_in(&accounts));

        // A third-party entry alone is NOT an Aiko sign-in.
        let foreign_only = r#"{
            "https://auth.x.ai::client-x": {
                "email": "person@example.com", "auth_mode": "oidc"
            }
        }"#;
        let accounts = auth_accounts(foreign_only);
        assert_eq!(accounts.len(), 1);
        assert!(!is_aiko_signed_in(&accounts));
    }

    #[test]
    fn cancellation_availability_matches_the_compiled_process_tree_implementation() {
        assert_eq!(CLI_CANCELLATION_SUPPORTED, cfg!(unix));
        if !cfg!(unix) {
            assert!(CANCELLATION_NOT_IMPLEMENTED.contains("not implemented"));
            assert!(CANCELLATION_NOT_IMPLEMENTED.contains("process tree"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_pipe_inheriting_process_group_before_settlement() {
        let job = Arc::new(std::sync::Mutex::new(Job {
            verb: "test".to_string(),
            output: String::new(),
            done: false,
            exit_code: None,
            cancel_requested: false,
            cancelled: false,
            timed_out: false,
        }));
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "sleep 600 & echo $!"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        configure_process_tree(&mut command);
        let mut child = command.spawn().expect("spawn shell process group");
        let stdout_task = child
            .stdout
            .take()
            .map(|out| append_lines(out, job.clone()));
        let stderr_task = child
            .stderr
            .take()
            .map(|out| append_lines(out, job.clone()));
        let monitor = tokio::spawn(monitor_child(
            child,
            job.clone(),
            stdout_task,
            stderr_task,
            std::time::Duration::from_secs(5),
        ));

        let descendant_pid = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(pid) = job
                    .lock()
                    .ok()
                    .and_then(|value| value.output.lines().next()?.parse::<i32>().ok())
                {
                    break pid;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant advertised its PID");
        job.lock().unwrap().cancel_requested = true;
        tokio::time::timeout(std::time::Duration::from_secs(2), monitor)
            .await
            .expect("pipe readers closed after group termination")
            .expect("monitor task completed");

        let snapshot = job.lock().unwrap();
        assert!(snapshot.done);
        assert!(snapshot.cancelled);
        assert!(!snapshot.timed_out);
        drop(snapshot);
        let gone = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if unsafe { libc::kill(descendant_pid, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            gone.is_ok(),
            "pipe-inheriting descendant {descendant_pid} survived cancellation"
        );
    }

    #[test]
    fn catalog_includes_login_and_only_fixed_argv() {
        let login = VERBS
            .iter()
            .find(|verb| verb.id == "login")
            .expect("login verb");
        assert!(login.argv.contains(&"--device-auth"));
        // No entry may smuggle a shell: argv is words, never a command line.
        for verb in VERBS {
            for word in verb.argv {
                assert!(!word.contains(' '), "argv word with space in {}", verb.id);
            }
        }
    }
}
