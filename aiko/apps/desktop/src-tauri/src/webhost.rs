//! Serves the web frontend (apps/frontend/frontend) from the desktop app
//! itself, mirroring the frontend container's nginx contract one-to-one:
//! `/` is the SPA with index.html fallback, `/api/` is reverse-proxied —
//! including WebSocket upgrades — to the backend. The desktop window and any
//! tunnel both point at this origin, so the app and the website are the same
//! bytes talking to the same backend.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::extract::{FromRequestParts, State, WebSocketUpgrade};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager, Runtime};

pub const DEFAULT_ADDR: &str = "127.0.0.1:17870";
pub const DEFAULT_BACKEND: &str = "http://127.0.0.1:8000";

/// The bound address, published once the listener is up so the tunnel and the
/// window can target the origin that actually exists rather than the one we
/// hoped for.
#[derive(Default)]
pub struct WebHostInfo {
    addr: OnceLock<SocketAddr>,
}

impl WebHostInfo {
    pub fn addr(&self) -> Option<SocketAddr> {
        self.addr.get().copied()
    }

    pub fn origin(&self) -> Option<String> {
        self.addr().map(|addr| format!("http://{addr}"))
    }
}

pub(crate) struct HostState {
    dist: Option<PathBuf>,
    backend: String,
    pub(crate) client: reqwest::Client,
    pub(crate) aiko_bin: String,
    pub(crate) jobs: crate::console::Jobs,
}

/// The bundled sidecar sits beside the app binary; a dev shell has `aiko` on
/// PATH. Either way the operator can pin it with AIKO_BIN.
fn resolve_aiko_bin() -> String {
    if let Ok(bin) = std::env::var("AIKO_BIN") {
        return bin;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(if cfg!(windows) { "aiko.exe" } else { "aiko" });
            if sidecar.is_file() {
                return sidecar.to_string_lossy().into_owned();
            }
        }
    }
    "aiko".to_string()
}

fn frontend_dist<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("AIKO_FRONTEND_DIST") {
        let path = PathBuf::from(path);
        if path.join("index.html").is_file() {
            return Some(path);
        }
        eprintln!(
            "Aiko webhost: AIKO_FRONTEND_DIST has no index.html: {}",
            path.display()
        );
    }
    let resource_dir = app.path().resource_dir().ok()?;
    ["frontend", "resources/frontend"]
        .iter()
        .map(|dir| resource_dir.join(dir))
        .find(|path| path.join("index.html").is_file())
}

pub async fn launch<R: Runtime>(app: AppHandle<R>) {
    let addr: SocketAddr = std::env::var("AIKO_WEB_ADDR")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or_else(|| DEFAULT_ADDR.parse().expect("default web addr parses"));
    let backend = std::env::var("AIKO_BACKEND_URL").unwrap_or_else(|_| DEFAULT_BACKEND.to_string());
    let dist = frontend_dist(&app);
    if dist.is_none() {
        eprintln!(
            "Aiko webhost: no frontend dist found (set AIKO_FRONTEND_DIST or bundle resources); serving API proxy only"
        );
    }

    let bound = match serve(dist, addr, backend, resolve_aiko_bin()).await {
        Ok(bound) => bound,
        Err(error) => {
            // Another instance may already be hosting this origin; the window
            // can still navigate there, but we must not claim we bound it.
            eprintln!("Aiko webhost could not bind {addr}: {error}");
            return;
        }
    };
    let _ = app.state::<WebHostInfo>().addr.set(bound);

    // Under `tauri dev` the window is on the Vite dev server (hot reload,
    // /api proxy); yanking it to the static dist would be a downgrade. In any
    // built app — debug or release — the bundled tauri:// page cannot reach
    // /api, so the served origin is the UI.
    if !tauri::is_dev() {
        if let Ok(url) = format!("http://{bound}").parse() {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.navigate(url) {
                    eprintln!("Aiko webhost: window navigation failed: {error}");
                }
            }
        }
    }
}

/// Bind and serve. Returns the actually-bound address (port 0 resolves here),
/// so gates can run against an ephemeral port.
pub async fn serve(
    dist: Option<PathBuf>,
    addr: SocketAddr,
    backend: String,
    aiko_bin: String,
) -> std::io::Result<SocketAddr> {
    let state = Arc::new(HostState {
        dist,
        backend: backend.trim_end_matches('/').to_string(),
        client: reqwest::Client::new(),
        aiko_bin,
        jobs: crate::console::Jobs::default(),
    });
    let router = Router::new()
        .route("/api/{*rest}", any(proxy))
        .route("/api", any(proxy))
        .route("/native/{*rest}", any(crate::console::native_proxy))
        .route("/console", axum::routing::get(crate::console::console_page))
        .route("/cli/verbs", axum::routing::get(crate::console::cli_verbs))
        .route("/cli/auth", axum::routing::get(crate::console::cli_auth))
        .route("/open", axum::routing::post(open_external))
        .route("/cli/run", axum::routing::post(crate::console::cli_run))
        .route(
            "/cli/jobs/{id}",
            axum::routing::get(crate::console::cli_job),
        )
        .route(
            "/cli/jobs/{id}/cancel",
            axum::routing::post(crate::console::cli_job_cancel),
        )
        .fallback(static_file)
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("Aiko webhost stopped: {error}");
        }
    });
    Ok(bound)
}

#[axum::debug_handler]
async fn proxy(State(state): State<Arc<HostState>>, request: axum::extract::Request) -> Response {
    let uri = request.uri().clone();
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(uri.path());

    let wants_websocket = request
        .headers()
        .get("upgrade")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if wants_websocket {
        let target = format!(
            "{}{}",
            state.backend.replacen("http", "ws", 1),
            path_and_query
        );
        let (mut parts, _body) = request.into_parts();
        return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => ws.on_upgrade(move |socket| bridge_ws(socket, target)),
            Err(rejection) => rejection.into_response(),
        };
    }

    let (parts, body) = request.into_parts();
    let target = format!("{}{}", state.backend, path_and_query);
    let mut request = state.client.request(parts.method, &target);
    for (name, value) in &parts.headers {
        // Hop-by-hop headers describe THIS connection; forwarding them breaks
        // the upstream one. Host must be the backend's own.
        let skip = matches!(
            name.as_str(),
            "host"
                | "connection"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "te"
                | "trailers"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
        );
        if !skip {
            request = request.header(name, value);
        }
    }
    request = request.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    relay(request, &target).await
}

/// Send an already-built upstream request and stream the answer back,
/// stripping hop-by-hop headers. 502 on failure — never a fabricated success.
pub(crate) async fn relay(request: reqwest::RequestBuilder, target: &str) -> Response {
    match request.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let mut response = Response::builder().status(status);
            for (name, value) in upstream.headers() {
                let skip = matches!(
                    name.as_str(),
                    "connection" | "keep-alive" | "transfer-encoding" | "upgrade"
                );
                if !skip {
                    response = response.header(name, value);
                }
            }
            response
                .body(Body::from_stream(upstream.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            format!("backend unreachable at {target}: {error}"),
        )
            .into_response(),
    }
}

pub(crate) async fn bridge_ws(mut client: axum::extract::ws::WebSocket, target: String) {
    use axum::extract::ws::Message as A;
    use tokio_tungstenite::tungstenite::Message as T;

    let upstream = match tokio_tungstenite::connect_async(&target).await {
        Ok((stream, _)) => stream,
        Err(error) => {
            eprintln!("Aiko webhost: websocket backend unreachable at {target}: {error}");
            let _ = client.close().await;
            return;
        }
    };
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut down_tx, mut down_rx) = client.split();

    let to_backend = async {
        while let Some(Ok(message)) = down_rx.next().await {
            let forwarded = match message {
                A::Text(text) => T::Text(text.as_str().into()),
                A::Binary(bytes) => T::Binary(bytes),
                A::Ping(bytes) => T::Ping(bytes),
                A::Pong(bytes) => T::Pong(bytes),
                A::Close(_) => break,
            };
            if up_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = up_tx.send(T::Close(None)).await;
    };
    let to_client = async {
        while let Some(Ok(message)) = up_rx.next().await {
            let forwarded = match message {
                T::Text(text) => A::Text(text.as_str().into()),
                T::Binary(bytes) => A::Binary(bytes),
                T::Ping(bytes) => A::Ping(bytes),
                T::Pong(bytes) => A::Pong(bytes),
                T::Close(_) => break,
                T::Frame(_) => continue,
            };
            if down_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = down_tx.close().await;
    };
    tokio::join!(to_backend, to_client);
}

/// A webview has no browser to hand a link to: `target="_blank"` opens nothing
/// and a plain external href would navigate the app itself away from its UI.
/// The page therefore posts the URL back here and the HOST opens it. Same
/// origin, so it needs no Tauri IPC and works identically in a real browser.
const LINK_SHIM: &str = r#"<script>
(function () {
  function externalUrl(target) {
    var anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor) return null;
    var href = anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return null;
    try {
      if (new URL(href).origin === window.location.origin) return null;
    } catch (e) { return null; }
    return href;
  }
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var url = externalUrl(event.target);
    if (!url) return;
    event.preventDefault();
    fetch('/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    }).catch(function () { window.open(url, '_blank'); });
  }, true);
  window.aikoOpenExternal = function (url) {
    return fetch('/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });
  };
  if (/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(window.location.hostname)) {
    var consoleLink = document.createElement('a');
    consoleLink.href = '/console';
    consoleLink.textContent = 'Aiko CLI';
    consoleLink.setAttribute('aria-label', 'Open Aiko local CLI console');
    consoleLink.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 14px;border-radius:999px;background:#111813;color:#b8f36b;border:1px solid #344136;font:600 12px ui-monospace,monospace;text-decoration:none;box-shadow:0 8px 30px #0008';
    document.body.appendChild(consoleLink);
  }
})();
</script>"#;

#[derive(serde::Deserialize)]
struct OpenRequest {
    url: String,
}

/// Opening a URL runs a program on the host, so this is loopback-only like the
/// CLI surface, and the scheme allow-list is closed: http/https only. A
/// `file:`, `javascript:` or shell-shaped URL is refused, never "tried".
async fn open_external(
    headers: axum::http::HeaderMap,
    axum::Json(request): axum::Json<OpenRequest>,
) -> Response {
    if !crate::console::is_local_request(&headers) {
        return (StatusCode::FORBIDDEN, "opening links is loopback-only").into_response();
    }
    if !is_openable(&request.url) {
        return (
            StatusCode::BAD_REQUEST,
            "only http and https URLs can be opened",
        )
            .into_response();
    }
    // `that_detached` reports Ok for merely SPAWNING the opener, so a failed
    // hand-off would still answer 204 — a success we never verified. `that`
    // waits for the opener's exit status; it blocks, hence spawn_blocking.
    let url = request.url.clone();
    match tokio::task::spawn_blocking(move || open::that(&url)).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_GATEWAY,
            format!("the browser refused {}: {error}", request.url),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("opener task failed: {error}"),
        )
            .into_response(),
    }
}

fn is_openable(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
}

fn inject_link_shim(html: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(html) else {
        return html.to_vec();
    };
    // Before </body> when there is one, else appended — either way the shim
    // runs after the document exists, and a page without </body> still gets it.
    match text.rfind("</body>") {
        Some(index) => {
            let mut out = String::with_capacity(text.len() + LINK_SHIM.len());
            out.push_str(&text[..index]);
            out.push_str(LINK_SHIM);
            out.push_str(&text[index..]);
            out.into_bytes()
        }
        None => [text.as_bytes(), LINK_SHIM.as_bytes()].concat(),
    }
}

async fn static_file(State(state): State<Arc<HostState>>, uri: Uri) -> Response {
    let Some(dist) = state.dist.as_deref() else {
        return (
            StatusCode::NOT_FOUND,
            "frontend dist not bundled; API proxy only",
        )
            .into_response();
    };
    let requested = sanitize(dist, uri.path());
    // nginx contract: try_files $uri /index.html — unknown routes get the SPA.
    let path = match requested {
        Some(path) if path.is_file() => path,
        _ => dist.join("index.html"),
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_for(&path);
            let is_html = mime.starts_with("text/html");
            let cache = if is_html {
                "no-cache"
            } else {
                "public, max-age=3600"
            };
            let bytes = if is_html {
                inject_link_shim(&bytes)
            } else {
                bytes
            };
            ([("content-type", mime), ("cache-control", cache)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn sanitize(dist: &Path, path: &str) -> Option<PathBuf> {
    let mut out = dist.to_path_buf();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains('\\') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn host_with_dist() -> (SocketAddr, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("index.html"), "<html>aiko spa</html>").unwrap();
        std::fs::write(dir.path().join("app.js"), "console.log(1)").unwrap();
        let fake_cli = dir.path().join("fake-aiko");
        std::fs::write(
            &fake_cli,
            r#"#!/bin/sh
if [ "$1" = login ]; then echo 'Visit https://aiko.example/device'; echo 'User code: TEST-CODE'; sleep 30; else echo "$@"; fi
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let addr = serve(
            Some(dir.path().to_path_buf()),
            "127.0.0.1:0".parse().unwrap(),
            // A port that must not be listening: the proxy has to fail closed
            // with 502, never fabricate a body.
            "http://127.0.0.1:1".to_string(),
            fake_cli.to_string_lossy().into_owned(),
        )
        .await
        .expect("bind ephemeral port");
        (addr, dir)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_spa_with_index_fallback_and_fails_proxy_closed() {
        let (addr, _dir) = host_with_dist().await;
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();

        let index = client.get(&base).send().await.expect("GET /");
        assert_eq!(index.status(), 200);
        assert!(index.text().await.unwrap().contains("aiko spa"));

        // Unknown route → index.html, the nginx try_files contract.
        let deep = client
            .get(format!("{base}/sessions/abc123"))
            .send()
            .await
            .expect("GET deep route");
        assert_eq!(deep.status(), 200);
        assert!(deep.text().await.unwrap().contains("aiko spa"));

        let asset = client
            .get(format!("{base}/app.js"))
            .send()
            .await
            .expect("GET asset");
        assert_eq!(asset.status(), 200);
        assert_eq!(
            asset.headers()["content-type"].to_str().unwrap(),
            "text/javascript"
        );

        // Backend down → 502 from the proxy, not a fabricated success.
        let api = client
            .get(format!("{base}/api/v1/sessions"))
            .send()
            .await
            .expect("GET /api");
        assert_eq!(api.status(), 502);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cli_console_runs_catalog_verbs_and_refuses_tunnel_hosts() {
        let (addr, _dir) = host_with_dist().await;
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();

        // The CLI face is a real, discoverable page, not an undocumented API.
        let console = client
            .get(format!("{base}/console"))
            .send()
            .await
            .expect("GET /console");
        assert_eq!(console.status(), 200);
        assert_eq!(console.headers()["cache-control"], "no-store");
        assert!(
            console.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        let console_body = console.text().await.unwrap();
        assert!(console_body.contains("Aiko Console"));
        assert!(console_body.contains("/cli/verbs"));

        // Loopback Host (reqwest's default here) sees the catalog.
        let verbs: serde_json::Value = client
            .get(format!("{base}/cli/verbs"))
            .send()
            .await
            .expect("GET /cli/verbs")
            .json()
            .await
            .expect("catalog json");
        let ids: Vec<&str> = verbs
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"login"));
        assert!(ids.contains(&"version"));

        // A run through the fake binary: `echo version` proves the job model
        // (spawn, capture, complete) without a real aiko install.
        let started: serde_json::Value = client
            .post(format!("{base}/cli/run"))
            .json(&serde_json::json!({"verb": "version"}))
            .send()
            .await
            .expect("POST /cli/run")
            .json()
            .await
            .expect("job json");
        let job_id = started["id"].as_u64().expect("job id");
        let mut done = false;
        let mut output = String::new();
        for _ in 0..50 {
            let job: serde_json::Value = client
                .get(format!("{base}/cli/jobs/{job_id}"))
                .send()
                .await
                .expect("GET job")
                .json()
                .await
                .expect("job json");
            done = job["done"].as_bool().unwrap_or(false);
            output = job["output"].as_str().unwrap_or("").to_string();
            if done {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(done, "job never completed");
        assert!(output.contains("version"), "echoed argv missing: {output}");

        // Long-running fixed jobs have a real stop path; cancellation kills the
        // child and settles only after the process has exited.
        let login: serde_json::Value = client
            .post(format!("{base}/cli/run"))
            .json(&serde_json::json!({"verb": "login"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let login_id = login["id"].as_u64().unwrap();
        let cancel = client
            .post(format!("{base}/cli/jobs/{login_id}/cancel"))
            .send()
            .await
            .expect("POST cancel");
        assert_eq!(cancel.status(), 200);
        let mut cancelled = false;
        for _ in 0..50 {
            let job: serde_json::Value = client
                .get(format!("{base}/cli/jobs/{login_id}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if job["done"].as_bool().unwrap_or(false) {
                cancelled = job["cancelled"].as_bool().unwrap_or(false);
                assert!(
                    job["output"]
                        .as_str()
                        .unwrap_or("")
                        .contains("cancelled by user")
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(cancelled, "cancelled job never settled");

        // Unknown verbs are refused: the catalog is the whole surface.
        let unknown = client
            .post(format!("{base}/cli/run"))
            .json(&serde_json::json!({"verb": "rm-rf"}))
            .send()
            .await
            .expect("POST unknown verb");
        assert_eq!(unknown.status(), 400);

        // A request that arrived through the tunnel carries the public
        // hostname in Host and must be refused — the public website gets the
        // UI, never the CLI.
        let tunneled = client
            .get(format!("{base}/cli/verbs"))
            .header("host", "lucky-otter.trycloudflare.com")
            .send()
            .await
            .expect("tunneled GET");
        assert_eq!(tunneled.status(), 403);
        let tunneled_console = client
            .get(format!("{base}/console"))
            .header("host", "lucky-otter.trycloudflare.com")
            .send()
            .await
            .expect("tunneled console GET");
        assert_eq!(tunneled_console.status(), 403);
        let tunneled_native = client
            .get(format!("{base}/native/v1/health"))
            .header("host", "lucky-otter.trycloudflare.com")
            .send()
            .await
            .expect("tunneled native GET");
        assert_eq!(tunneled_native.status(), 403);

        // Being addressed to loopback is not enough: a hostile browser Origin
        // must not be able to drive either HTTP or WebSocket native requests.
        let hostile_http = client
            .get(format!("{base}/cli/verbs"))
            .header("origin", "https://hostile.example")
            .send()
            .await
            .expect("hostile-origin HTTP GET");
        assert_eq!(hostile_http.status(), 403);

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut websocket = format!("ws://{addr}/native/v1/events")
            .into_client_request()
            .expect("websocket request");
        websocket
            .headers_mut()
            .insert("origin", "https://hostile.example".parse().unwrap());
        match tokio_tungstenite::connect_async(websocket).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status().as_u16(), 403);
            }
            Ok(_) => panic!("hostile-origin WebSocket handshake was admitted"),
            Err(error) => panic!("unexpected WebSocket refusal: {error}"),
        }
    }

    #[test]
    fn link_shim_is_injected_and_only_web_urls_open() {
        let page = inject_link_shim(b"<html><body><p>hi</p></body></html>");
        let page = String::from_utf8(page).unwrap();
        assert!(page.contains("aikoOpenExternal"), "shim missing");
        assert!(
            page.contains("Open Aiko local CLI console"),
            "console entry point missing"
        );
        // It must land INSIDE body, before the close tag.
        let shim_at = page.find("aikoOpenExternal").unwrap();
        assert!(shim_at < page.find("</body>").unwrap());
        // A page with no </body> still gets the shim rather than silently none.
        let bare = String::from_utf8(inject_link_shim(b"<p>hi</p>")).unwrap();
        assert!(bare.contains("aikoOpenExternal"));

        assert!(is_openable("https://example.com/device?code=ABCD"));
        assert!(is_openable("http://127.0.0.1:8080/x"));
        // Opening runs a program on the host: everything else is refused.
        assert!(!is_openable("file:///etc/passwd"));
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("data:text/html,<script>x</script>"));
        assert!(!is_openable("not a url"));
        assert!(!is_openable("https://"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn open_endpoint_refuses_bad_schemes_and_tunnel_hosts() {
        let (addr, _dir) = host_with_dist().await;
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();

        // The served page carries the shim, so links are clickable at all.
        let page = client
            .get(&base)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(page.contains("aikoOpenExternal"));

        let refused = client
            .post(format!("{base}/open"))
            .json(&serde_json::json!({"url": "file:///etc/passwd"}))
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), 400);

        let tunneled = client
            .post(format!("{base}/open"))
            .header("host", "lucky-otter.trycloudflare.com")
            .json(&serde_json::json!({"url": "https://example.com"}))
            .send()
            .await
            .unwrap();
        assert_eq!(tunneled.status(), 403);
    }

    #[test]
    fn sanitize_refuses_traversal() {
        let dist = PathBuf::from("/srv/dist");
        assert!(sanitize(&dist, "/../etc/passwd").is_none());
        assert!(sanitize(&dist, "/a/../../etc").is_none());
        assert_eq!(
            sanitize(&dist, "/assets/app.js"),
            Some(PathBuf::from("/srv/dist/assets/app.js"))
        );
    }
}
