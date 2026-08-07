//! Exposes the webhost origin to the public internet through a Cloudflare
//! quick tunnel, so the same frontend the desktop window renders is reachable
//! as a website. Opt-in only: a public URL is an outward-facing effect, so it
//! is never opened unless the user asked (AIKO_TUNNEL=1 or the start_tunnel
//! command from the UI).

use std::process::Stdio;

use tauri::{AppHandle, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::webhost::WebHostInfo;

#[derive(Default)]
pub struct TunnelState {
    child: Mutex<Option<tokio::process::Child>>,
    url: Mutex<Option<String>>,
}

/// cloudflared prints the assigned hostname inside a log box on stderr;
/// the URL is the only stable token in that output.
fn extract_tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let tail = &line[start..];
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(tail.len());
    let url = &tail[..end];
    url.contains(".trycloudflare.com").then(|| url.to_string())
}

pub async fn start<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let state: State<'_, TunnelState> = app.state();
    if let Some(url) = state.url.lock().await.clone() {
        return Ok(url);
    }
    let origin = app
        .state::<WebHostInfo>()
        .origin()
        .ok_or_else(|| "webhost is not running; nothing to expose".to_string())?;

    let mut child = tokio::process::Command::new("cloudflared")
        .args(["tunnel", "--no-autoupdate", "--url", &origin])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "cloudflared not found — install it (macOS: brew install cloudflared) and retry"
                    .to_string()
            } else {
                format!("could not start cloudflared: {error}")
            }
        })?;

    let (url_tx, url_rx) = tokio::sync::oneshot::channel::<String>();
    let url_tx = std::sync::Arc::new(std::sync::Mutex::new(Some(url_tx)));
    if let Some(stdout) = child.stdout.take() {
        scan_for_url(stdout, url_tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        scan_for_url(stderr, url_tx);
    }

    *state.child.lock().await = Some(child);

    match tokio::time::timeout(std::time::Duration::from_secs(30), url_rx).await {
        Ok(Ok(url)) => {
            *state.url.lock().await = Some(url.clone());
            println!("Aiko tunnel: frontend is publicly reachable at {url}");
            Ok(url)
        }
        _ => {
            stop_state(&state).await;
            Err("cloudflared started but no tunnel URL appeared within 30s".to_string())
        }
    }
}

fn scan_for_url<R>(
    reader: R,
    url_tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>>,
) where
    R: tokio::io::AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(url) = extract_tunnel_url(&line) {
                if let Some(sender) = url_tx.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = sender.send(url);
                }
            }
        }
    });
}

async fn stop_state(state: &TunnelState) {
    if let Some(mut child) = state.child.lock().await.take() {
        let _ = child.kill().await;
    }
    *state.url.lock().await = None;
}

pub fn stop_blocking<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<TunnelState>() {
        // Exit path: kill_on_drop covers the child if the runtime is gone.
        if let Ok(mut slot) = state.child.try_lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.start_kill();
            }
        }
    }
}

#[tauri::command]
pub async fn start_tunnel<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    start(&app).await
}

#[tauri::command]
pub async fn tunnel_status<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    Ok(app.state::<TunnelState>().url.lock().await.clone())
}

#[tauri::command]
pub async fn stop_tunnel<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    stop_state(&app.state::<TunnelState>()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extract_tunnel_url;

    #[test]
    fn finds_url_in_cloudflared_log_box() {
        let line = "2026-08-04T00:00:00Z INF |  https://lucky-otter-example.trycloudflare.com  |";
        assert_eq!(
            extract_tunnel_url(line).as_deref(),
            Some("https://lucky-otter-example.trycloudflare.com")
        );
        assert_eq!(extract_tunnel_url("INF Starting tunnel"), None);
        assert_eq!(
            extract_tunnel_url("visit https://developers.cloudflare.com for docs"),
            None
        );
    }
}
