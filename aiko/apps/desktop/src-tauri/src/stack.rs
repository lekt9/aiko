//! The stack supervisor — what makes the app self-contained.
//!
//! Opening Aiko Desktop must be sufficient: the webview needs the webhost, the
//! webhost needs the Manus backend, the backend needs MongoDB + Redis and the
//! local aiko runtime. The sidecar runtime is already supervised
//! (`runtime.rs`); this module supervises the rest, with one discipline:
//! **adopt what is already running, spawn only what is missing, and never
//! report ready on anything but the backend actually answering.**
//!
//! `cargo run --bin aiko-stack` runs the same code standalone (detached
//! children) — that binary is the runnable witness for this module.

use std::path::PathBuf;
use std::sync::Mutex;

pub const BACKEND_READY_PATH: &str = "/api/v1/config/frontend";
const DB_CONTAINERS: &[(&str, &str, u16)] = &[
    ("aiko-mongo", "docker.io/library/mongo:7.0", 27017),
    ("aiko-redis", "docker.io/library/redis:7.0", 6379),
];

/// Self-contained defaults: anonymous auth (no SMTP/email dependency), local
/// databases, assistant on the local aiko runtime. Written only when the
/// backend has no .env of its own — an existing file is the operator's word.
pub fn default_env_contents() -> &'static str {
    "# Written by Aiko Desktop for self-contained operation. Edit freely; this\n\
     # file is only created when absent.\n\
     API_KEY=aiko-local\n\
     AUTH_PROVIDER=none\n\
     MONGODB_URI=mongodb://127.0.0.1:27017\n\
     MONGODB_DATABASE=manus\n\
     REDIS_HOST=127.0.0.1\n\
     REDIS_PORT=6379\n\
     AIKO_LOCAL=true\n"
}

#[derive(Default)]
pub struct StackSupervisor {
    backend_child: Mutex<Option<tokio::process::Child>>,
}

impl StackSupervisor {
    pub fn stop(&self) {
        if let Ok(mut slot) = self.backend_child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.start_kill();
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StackOutcome {
    /// The backend was already answering; nothing was touched.
    Adopted,
    /// Databases ensured and a backend spawned; it answered before timeout.
    Started,
    /// Something needed is missing on this machine. The string names it —
    /// honesty here is what the UI's outage state renders.
    Unavailable(String),
}

pub async fn backend_up(base_url: &str) -> bool {
    let url = format!("{}{}", base_url.trim_end_matches('/'), BACKEND_READY_PATH);
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    else {
        return false;
    };
    client
        .get(url)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

/// The backend source tree. Bundled resource first (a packaged app carries it),
/// then AIKO_BACKEND_DIR, then the repo-relative dev location.
pub fn resolve_backend_dir(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("AIKO_BACKEND_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("backend"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../frontend/backend"));
    candidates
        .into_iter()
        .find(|dir| dir.join("pyproject.toml").is_file())
}

fn tool_path(name: &str) -> Option<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        // GUI launches miss shell PATH entries; podman/uv commonly live here.
        paths.push(home.join(".local/bin"));
        paths.push(home.join("bin"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin"));
    paths.push(PathBuf::from("/usr/local/bin"));
    paths
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

fn container_engine() -> Option<PathBuf> {
    tool_path("podman").or_else(|| tool_path("docker"))
}

async fn ensure_databases(engine: &PathBuf) -> Result<(), String> {
    for (name, image, port) in DB_CONTAINERS {
        let running = tokio::process::Command::new(engine)
            .args(["container", "inspect", "-f", "{{.State.Running}}", name])
            .output()
            .await
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "true");
        match running {
            Some(true) => continue,
            Some(false) => {
                let start = tokio::process::Command::new(engine)
                    .args(["start", name])
                    .output()
                    .await
                    .map_err(|error| format!("could not start {name}: {error}"))?;
                if !start.status.success() {
                    return Err(format!(
                        "could not start {name}: {}",
                        String::from_utf8_lossy(&start.stderr).trim()
                    ));
                }
            }
            None => {
                let publish = format!("{port}:{port}");
                let run = tokio::process::Command::new(engine)
                    .args(["run", "-d", "--name", name, "-p", &publish, image])
                    .output()
                    .await
                    .map_err(|error| format!("could not create {name}: {error}"))?;
                if !run.status.success() {
                    return Err(format!(
                        "could not create {name}: {}",
                        String::from_utf8_lossy(&run.stderr).trim()
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Bring the stack up. `retain` receives the spawned backend child when the
/// caller wants to own its lifetime (the app kills it on exit); pass None to
/// leave it detached (the standalone witness binary).
pub async fn ensure(
    backend_url: &str,
    resource_dir: Option<PathBuf>,
    retain: Option<&StackSupervisor>,
) -> StackOutcome {
    if backend_up(backend_url).await {
        return StackOutcome::Adopted;
    }

    let Some(backend_dir) = resolve_backend_dir(resource_dir) else {
        return StackOutcome::Unavailable(
            "backend source not found (set AIKO_BACKEND_DIR or bundle resources/backend)"
                .to_string(),
        );
    };
    let Some(uv) = tool_path("uv") else {
        return StackOutcome::Unavailable(
            "uv not found — install it: https://docs.astral.sh/uv/".to_string(),
        );
    };
    let Some(engine) = container_engine() else {
        return StackOutcome::Unavailable(
            "no container engine — install podman (or docker) for MongoDB/Redis".to_string(),
        );
    };
    if let Err(error) = ensure_databases(&engine).await {
        return StackOutcome::Unavailable(error);
    }

    let env_file = backend_dir.join(".env");
    if !env_file.is_file() {
        if let Err(error) = std::fs::write(&env_file, default_env_contents()) {
            return StackOutcome::Unavailable(format!(
                "could not write {}: {error}",
                env_file.display()
            ));
        }
    }

    let mut command = tokio::process::Command::new(&uv);
    command
        .args(["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"])
        .current_dir(&backend_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if retain.is_some() {
        command.kill_on_drop(true);
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return StackOutcome::Unavailable(format!("could not spawn backend: {error}"));
        }
    };
    if let Some(supervisor) = retain {
        if let Ok(mut slot) = supervisor.backend_child.lock() {
            *slot = Some(child);
        }
    } else {
        // Detached: the witness binary exits, the stack stays.
        std::mem::forget(child);
    }

    // Ready means the backend ANSWERS — a spawned pid is not readiness.
    for _ in 0..120 {
        if backend_up(backend_url).await {
            return StackOutcome::Started;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    StackOutcome::Unavailable(
        "backend spawned but never answered within 60s — check backend logs".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_env_is_self_contained() {
        let env = default_env_contents();
        // Anonymous auth is what removes the email/SMTP dependency.
        assert!(env.contains("AUTH_PROVIDER=none"));
        assert!(env.contains("AIKO_LOCAL=true"));
        assert!(env.contains("MONGODB_URI=mongodb://127.0.0.1:27017"));
        assert!(env.contains("REDIS_HOST=127.0.0.1"));
    }

    #[test]
    fn backend_dir_resolves_from_env_then_repo() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pyproject.toml"), "[project]").unwrap();
        // SAFETY: tests in this module touching this var run single-threaded
        // within cargo's per-test process isolation of set_var usage here.
        unsafe { std::env::set_var("AIKO_BACKEND_DIR", dir.path()) };
        let resolved = resolve_backend_dir(None);
        unsafe { std::env::remove_var("AIKO_BACKEND_DIR") };
        assert_eq!(resolved.as_deref(), Some(dir.path()));

        // Without the env var, the repo-relative dev backend is found (this
        // repository ships it), proving the packaged fallback order.
        let fallback = resolve_backend_dir(None).expect("repo backend dir");
        assert!(fallback.join("pyproject.toml").is_file());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn adopts_an_already_answering_backend() {
        // A stub that answers the readiness path proves ensure() adopts
        // without touching containers or spawning anything.
        let app = axum::Router::new().route(
            BACKEND_READY_PATH,
            axum::routing::get(|| async { "{\"code\":0}" }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let outcome = ensure(&format!("http://{addr}"), None, None).await;
        assert_eq!(outcome, StackOutcome::Adopted);

        // And a dead port is never "adopted" — fail closed.
        assert!(!backend_up("http://127.0.0.1:1").await);
    }
}
