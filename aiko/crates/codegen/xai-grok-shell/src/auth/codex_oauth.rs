//! Codex (ChatGPT) OAuth 2.0 PKCE login flow.
//!
//! Ported from codegraff's `oauth.zig::codexLogin`. Reuses the official Codex
//! CLI's public OAuth app — same `client_id`, same `auth.openai.com` endpoints,
//! same `~/.codex/auth.json` on-disk format. A user who ran `codex login` once
//! can use Aiko against the same credential without a separate login.
//!
//! Flow: PKCE verifier/challenge (S256) + random state →
//! bind 127.0.0.1:1455 → open browser to authorize URL →
//! accept one callback connection → exchange code for tokens →
//! write `~/.codex/auth.json` (Codex CLI-compatible schema).

use std::path::PathBuf;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// ── Constants (exact mirror of codegraff/src/oauth.zig) ────────────────────

const OAUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE: &str = "openid profile email offline_access";

/// How long before an access token's expiry to proactively refresh it (300s).
/// Mirrors codegraff's `oauth_refresh_margin_s`.
const REFRESH_MARGIN_S: i64 = 300;

/// Low-traffic mutex — serializes concurrent refreshes so parallel sub-agents
/// don't race the single-use refresh_token.
static REFRESH_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ── On-disk types (Codex CLI auth.json compatible) ────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CodexTokens {
    id_token: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CodexAuthJson {
    auth_mode: String,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: CodexTokens,
    #[serde(default)]
    last_refresh: Option<String>,
}

/// The caller-visible credential, ready to be used as a Bearer.
#[derive(Debug, Clone)]
pub struct CodexAuth {
    pub access_token: String,
    pub account_id: Option<String>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

// ── Load ───────────────────────────────────────────────────────────────────

fn auth_json_path(home: &std::path::Path) -> PathBuf {
    home.join(".codex").join("auth.json")
}

/// Read `~/.codex/auth.json` and return credentials.
/// Returns `None` if the file doesn't exist, is unparseable, or has no token.
pub fn load_codex_auth(home: &std::path::Path) -> Option<CodexAuth> {
    let path = auth_json_path(home);
    let data = std::fs::read_to_string(&path).ok()?;
    let v: CodexAuthJson = serde_json::from_str(&data).ok()?;
    let access = v.tokens.access_token;
    if access.is_empty() {
        return None;
    }
    let account = v.tokens.account_id.clone();
    let expires_at = parse_expiry_from_id_token(v.tokens.id_token.as_deref());
    Some(CodexAuth {
        access_token: access,
        account_id: account,
        expires_at,
    })
}

/// Parse the `exp` claim from the id_token JWT payload to derive the access
/// token's approximate expiry (id_tokens are typically issued with the same
/// lifetime as the access token, ~1h).
fn parse_expiry_from_id_token(id_token: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    let token = id_token?;
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let exp = v.get("exp")?.as_i64()?;
    chrono::DateTime::from_timestamp(exp, 0)
}

/// Like `load_codex_auth` but also refreshes the token on disk when within
/// `REFRESH_MARGIN_S` of expiry (proactive refresh).
pub fn load_codex_auth_fresh(home: &std::path::Path) -> Option<CodexAuth> {
    let mut auth = load_codex_auth(home)?;

    // Proactive refresh near expiry
    let should_refresh = auth.expires_at.is_some_and(|exp| {
        let now = chrono::Utc::now();
        let remaining = exp - now;
        remaining.num_seconds() < REFRESH_MARGIN_S
    });

    if should_refresh {
        tracing::info!(
            remaining_s = auth
                .expires_at
                .map(|e| (e - chrono::Utc::now()).num_seconds())
                .unwrap_or(-1),
            "codex token near expiry, refreshing proactively"
        );
        let _guard = REFRESH_MUTEX.lock().ok()?;

        // Re-read: another concurrent refresher may have already replaced the token.
        let recheck = load_codex_auth(home)?;
        if recheck.expires_at != auth.expires_at {
            return Some(recheck);
        }

        // Reload the file for the refresh_token
        let path = auth_json_path(home);
        let data = std::fs::read_to_string(&path).ok()?;
        let v: CodexAuthJson = serde_json::from_str(&data).ok()?;
        let rt = v.tokens.refresh_token.as_deref()?;

        match do_refresh_off_runtime(home, rt) {
            Ok(new_auth) => Some(new_auth),
            Err(e) => {
                tracing::warn!(error = %e, "codex token refresh failed, returning cached token");
                Some(auth)
            }
        }
    } else {
        Some(auth)
    }
}

/// Force-refresh the token (called after a 401 on a Codex request).
pub fn refresh_codex_auth(home: &std::path::Path) -> Option<CodexAuth> {
    let _guard = REFRESH_MUTEX.lock().ok()?;
    let path = auth_json_path(home);
    let data = std::fs::read_to_string(&path).ok()?;
    let v: CodexAuthJson = serde_json::from_str(&data).ok()?;
    let rt = v.tokens.refresh_token.as_deref()?;

    match do_refresh_off_runtime(home, rt) {
        Ok(new) => Some(new),
        Err(e) => {
            tracing::warn!(error = %e, "codex force-refresh failed");
            None
        }
    }
}

// ── Refresh (synchronous — called inside the mutex lock) ───────────────────

fn do_refresh(home: &std::path::Path, refresh_token: &str) -> anyhow::Result<CodexAuth> {
    let body = format!(
        "grant_type=refresh_token&client_id={}&refresh_token={}&scope={}",
        CODEX_CLIENT_ID, refresh_token, urlencoding::encode(OAUTH_SCOPE)
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let resp = client
        .post(OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()?;

    let status = resp.status();
    let body_text = resp.text()?;

    if !status.is_success() {
        anyhow::bail!("codex token refresh HTTP {}: {}", status.as_u16(), body_text);
    }

    let resp: serde_json::Value = serde_json::from_str(&body_text)?;
    let access = resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("no access_token in refresh response"))?
        .to_string();

    let id_token = resp.get("id_token").and_then(|v| v.as_str()).map(String::from);
    let new_refresh = resp
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| Some(refresh_token.to_string()));
    let account = id_token
        .as_deref()
        .and_then(extract_account_from_id_token);

    write_auth_json(home, &id_token, &access, new_refresh.as_deref(), account.as_deref())?;

    let expires_at = parse_expiry_from_id_token(id_token.as_deref());
    Ok(CodexAuth {
        access_token: access,
        account_id: account,
        expires_at,
    })
}

/// Run the blocking OAuth client outside any ambient Tokio runtime.
///
/// Credential resolution is intentionally synchronous, but it also runs on
/// the pager's current-thread Tokio worker. `reqwest::blocking` creates and
/// drops its own runtime, which panics when dropped from inside another async
/// runtime. A short-lived OS thread keeps that nested runtime outside Tokio
/// while preserving the synchronous credential API.
fn do_refresh_off_runtime(
    home: &std::path::Path,
    refresh_token: &str,
) -> anyhow::Result<CodexAuth> {
    let home = home.to_path_buf();
    let refresh_token = refresh_token.to_string();
    run_blocking_off_runtime(move || do_refresh(&home, &refresh_token))
}

fn run_blocking_off_runtime<T, F>(operation: F) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    if tokio::runtime::Handle::try_current().is_err() {
        return operation();
    }
    std::thread::spawn(operation)
        .join()
        .map_err(|_| anyhow::anyhow!("codex token refresh worker panicked"))?
}

// ── Login flow ─────────────────────────────────────────────────────────────

/// Run the Codex (ChatGPT) PKCE OAuth login flow.
///
/// Returns the credential on success. This is an async function because it
/// binds a TCP socket and opens a browser. Call from within a tokio runtime.
pub async fn codex_login(home: &std::path::Path) -> anyhow::Result<CodexAuth> {
    // 1. Generate PKCE verifier and challenge
    let verifier = generate_code_verifier();
    let challenge = compute_s256_challenge(&verifier);

    // 2. Generate random state for CSRF protection
    let state = random_base64url(16);

    // 3. Build the authorize URL
    let scope_enc = urlencoding::encode(OAUTH_SCOPE);
    let redirect_enc = urlencoding::encode(CODEX_REDIRECT_URI);
    let challenge_enc = urlencoding::encode(&challenge);
    let state_enc = urlencoding::encode(&state);

    let authorize_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&\
         code_challenge={}&code_challenge_method=S256&state={}&\
         id_token_add_organizations=true&codex_cli_simplified_flow=true",
        OAUTH_AUTHORIZE_URL, CODEX_CLIENT_ID, redirect_enc,
        scope_enc, challenge_enc, state_enc,
    );

    // 4. Bind the callback port BEFORE opening the browser (mirrors codegraff)
    let listener = TcpListener::bind("127.0.0.1:1455")
        .await
        .map_err(|e| anyhow::anyhow!("failed to bind localhost:1455: {e}"))?;

    eprintln!();
    eprintln!("Open this URL to authorize Aiko with Codex (ChatGPT):");
    eprintln!();
    eprintln!("  {authorize_url}");
    eprintln!();
    eprintln!("If your browser doesn't open automatically, copy the URL above.");
    eprintln!();

    // Open browser (off-thread since webbrowser::open is blocking)
    let url_clone = authorize_url.clone();
    tokio::task::spawn_blocking(move || {
        let _ = webbrowser::open(&url_clone);
    });

    // 5. Accept one callback connection
    let auth_code = tokio::time::timeout(
        std::time::Duration::from_secs(600), // 10-minute timeout
        accept_callback(listener, &state),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Login timed out after 10 minutes"))??;

    // 6. Exchange code for tokens
    let code_enc = urlencoding::encode(&auth_code);
    let body = format!(
        "grant_type=authorization_code&client_id={}&code={}&\
         redirect_uri={}&code_verifier={}",
        CODEX_CLIENT_ID, code_enc, urlencoding::encode(CODEX_REDIRECT_URI),
        urlencoding::encode(&verifier),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let resp = client
        .post(OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;

    let status = resp.status();
    let body_text = resp.text().await?;

    if !status.is_success() {
        anyhow::bail!("token exchange HTTP {}: {}", status.as_u16(), body_text);
    }

    let v: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| anyhow::anyhow!("bad token response: {e}"))?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let desc = v
            .get("error_description")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        anyhow::bail!("OAuth error: {err} {desc}");
    }

    let access = v
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("no access_token in response"))?
        .to_string();

    let id_token = v.get("id_token").and_then(|v| v.as_str()).map(String::from);
    let refresh = v.get("refresh_token").and_then(|v| v.as_str()).map(String::from);
    let account = id_token
        .as_deref()
        .and_then(extract_account_from_id_token);

    // 7. Write ~/.codex/auth.json (Codex CLI-compatible format)
    write_auth_json(home, &id_token, &access, refresh.as_deref(), account.as_deref())?;

    eprintln!(
        "✓ logged into Codex (account {}) — wrote ~/.codex/auth.json",
        account.as_deref().unwrap_or("unknown").chars().take(8).collect::<String>()
    );

    let expires_at = parse_expiry_from_id_token(id_token.as_deref());
    Ok(CodexAuth {
        access_token: access,
        account_id: account,
        expires_at,
    })
}

// ── Callback: accept one HTTP connection, serve confirmation page, extract code ──

async fn accept_callback(listener: TcpListener, expected_state: &str) -> anyhow::Result<String> {
    let (stream, _) = listener.accept().await?;
    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);

    // Read the request line
    let mut req_line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        buf_reader.read_line(&mut req_line),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timed out reading callback request"))?
    .map_err(|e| anyhow::anyhow!("failed to read callback request: {e}"))?;

    // Drain remaining headers so we don't block the response
    let mut header = String::new();
    loop {
        header.clear();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            buf_reader.read_line(&mut header),
        )
        .await
        .map_err(|_| anyhow::anyhow!("timed out reading headers"))?
        .map_err(|e| anyhow::anyhow!("failed to read headers: {e}"))?;
        if header.trim().is_empty() {
            break;
        }
    }

    // Serve a confirmation page (dark-mode, branded)
    let page = CODE_LOGIN_PAGE_HTML;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Connection: close\r\nContent-Length: {}\r\n\r\n{}",
        page.len(),
        page,
    );
    let _ = writer.write_all(response.as_bytes()).await;
    let _ = writer.flush().await;

    // Parse code and state from the request line
    let code = query_param(&req_line, "code")
        .ok_or_else(|| anyhow::anyhow!("no authorization code in callback"))?;

    let got_state = query_param(&req_line, "state").unwrap_or_default();
    if got_state != expected_state {
        anyhow::bail!("state mismatch — possible CSRF, aborting");
    }

    Ok(code.to_string())
}

/// Extract a query-parameter value from an HTTP request line.
fn query_param<'a>(req_line: &'a str, key: &str) -> Option<&'a str> {
    // GET /path?k1=v1&k2=v2 HTTP/1.1
    let query_start = req_line.find('?')?;
    let query_end = req_line[query_start..].find(' ')?;
    let query = &req_line[query_start + 1..query_start + query_end];

    let prefix = format!("{}=", key);
    for chunk in query.split('&') {
        if let Some(stripped) = chunk.strip_prefix(&prefix) {
            return Some(stripped);
        }
    }
    None
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn generate_code_verifier() -> String {
    let bytes: [u8; 48] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

fn compute_s256_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

fn random_base64url(len_bytes: usize) -> String {
    let mut bytes = vec![0u8; len_bytes];
    let mut rng = rand::rng();
    rng.fill(&mut bytes[..]);
    URL_SAFE_NO_PAD.encode(&bytes)
}

/// Extract `chatgpt_account_id` from the id_token JWT payload.
/// Mirrors codegraff's `oauth_helpers.zig::accountFromIdToken`.
fn extract_account_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(String::from)
}

/// Write the Codex CLI-compatible auth.json.
fn write_auth_json(
    home: &std::path::Path,
    id_token: &Option<String>,
    access_token: &str,
    refresh_token: Option<&str>,
    account_id: Option<&str>,
) -> anyhow::Result<()> {
    let codex_dir = home.join(".codex");
    std::fs::create_dir_all(&codex_dir)?;

    let auth = CodexAuthJson {
        auth_mode: "chatgpt".to_string(),
        openai_api_key: None,
        tokens: CodexTokens {
            id_token: id_token.clone(),
            access_token: access_token.to_string(),
            refresh_token: refresh_token.map(String::from),
            account_id: account_id.map(String::from),
        },
        last_refresh: Some(chrono::Utc::now().to_rfc3339()),
    };

    let json = serde_json::to_string_pretty(&auth)?;
    let path = auth_json_path(home);

    // Write atomically: temp file → rename
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;

    // Set 0600 permissions (best-effort, mirrors codegraff/storage.rs pattern)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&tmp_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&tmp_path, perms);
        }
    }

    std::fs::rename(&tmp_path, &path)?;

    Ok(())
}

// ── Login confirmation page (branded, dark-mode-aware) ─────────────────────

const CODE_LOGIN_PAGE_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aiko — Codex Login Complete</title>
<style>
  :root { color-scheme: dark; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    display:flex; align-items:center; justify-content:center;
    min-height:100vh; background:#0d0d0d; color:#e4e4e4;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    text-align:center; padding:2.5rem 2rem; max-width:380px;
  }
  .check { font-size:3rem; margin-bottom:0.75rem; }
  h1 { font-size:1.25rem; font-weight:600; margin-bottom:0.5rem; }
  p { font-size:0.9rem; color:#999; line-height:1.5; }
</style>
</head>
<body>
<div class="card">
  <div class="check">✓</div>
  <h1>You're all set</h1>
  <p>You can close this tab and return to Aiko.<br>
  Your Codex credentials have been saved.</p>
</div>
</body>
</html>
"#;

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pkce_verifier_challenge_roundtrip() {
        let verifier = generate_code_verifier();
        // Verifier is 48 bytes → 64 base64url chars (no padding)
        assert_eq!(verifier.len(), 64);
        assert!(!verifier.contains('='));
        assert!(!verifier.contains('+'));
        assert!(!verifier.contains('/'));

        let challenge = compute_s256_challenge(&verifier);
        // Challenge is SHA-256 → 32 bytes → 43 base64url chars (no padding)
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains('='));

        // Deterministic: same verifier → same challenge
        let challenge2 = compute_s256_challenge(&verifier);
        assert_eq!(challenge, challenge2);

        // Different verifier → different challenge
        let verifier2 = generate_code_verifier();
        let challenge3 = compute_s256_challenge(&verifier2);
        assert_ne!(challenge, challenge3);
    }

    #[test]
    fn test_query_param_extraction() {
        let req = "GET /auth/callback?code=abc123&state=def456 HTTP/1.1";
        assert_eq!(query_param(req, "code"), Some("abc123"));
        assert_eq!(query_param(req, "state"), Some("def456"));
        assert_eq!(query_param(req, "missing"), None);

        // No query string
        assert_eq!(query_param("GET / HTTP/1.1", "code"), None);
    }

    #[test]
    fn test_extract_account_from_id_token() {
        // Build a minimal JWT payload
        let payload = serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acc_test_123"
            }
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap());
        let id_token = format!("header.{}.sig", payload_b64);

        assert_eq!(
            extract_account_from_id_token(&id_token),
            Some("acc_test_123".to_string())
        );
    }

    #[test]
    fn test_extract_account_missing() {
        // id_token with no chatgpt_account_id
        let payload = serde_json::json!({"sub": "user-1"});
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap());
        let id_token = format!("header.{}.sig", payload_b64);

        assert_eq!(extract_account_from_id_token(&id_token), None);

        // Not a JWT
        assert_eq!(extract_account_from_id_token("not-a-jwt"), None);
    }

    #[test]
    fn test_auth_json_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();

        // Write
        write_auth_json(
            home,
            &Some("id-token-value".to_string()),
            "access-token-value",
            Some("refresh-token-value"),
            Some("acc-123"),
        )
        .unwrap();

        // Read
        let auth = load_codex_auth(home).unwrap();
        assert_eq!(auth.access_token, "access-token-value");
        assert_eq!(auth.account_id.as_deref(), Some("acc-123"));

        // Write without account_id (user logged in with personal account)
        write_auth_json(
            home,
            &Some("id2".to_string()),
            "access2",
            None,
            None,
        )
        .unwrap();

        let auth2 = load_codex_auth(home).unwrap();
        assert_eq!(auth2.access_token, "access2");
        assert!(auth2.account_id.is_none());
    }

    #[test]
    fn test_load_codex_auth_no_file() {
        let dir = tempfile::tempdir().unwrap();
        // No .codex/auth.json exists
        assert!(load_codex_auth(dir.path()).is_none());
    }

    #[test]
    fn test_load_codex_auth_empty_token() {
        let dir = tempfile::tempdir().unwrap();
        let auth = CodexAuthJson {
            auth_mode: "chatgpt".to_string(),
            openai_api_key: None,
            tokens: CodexTokens {
                id_token: None,
                access_token: String::new(), // empty
                refresh_token: None,
                account_id: None,
            },
            last_refresh: None,
        };
        let json = serde_json::to_string(&auth).unwrap();
        std::fs::create_dir_all(dir.path().join(".codex")).unwrap();
        std::fs::write(auth_json_path(dir.path()), json).unwrap();

        assert!(load_codex_auth(dir.path()).is_none());
    }

    #[test]
    fn test_parse_expiry_from_id_token() {
        // JWT with exp: 1 hour from now
        let now = chrono::Utc::now().timestamp();
        let future = now + 3600;
        let payload = serde_json::json!({"exp": future, "sub": "u"});
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap());
        let token = format!("h.{}.sig", payload_b64);

        let exp = parse_expiry_from_id_token(Some(&token)).unwrap();
        let now = chrono::Utc::now();
        assert!(exp > now, "expiry should be in the future");
        assert!(exp < now + chrono::Duration::seconds(3700), "expiry should be ~1h from now");
    }

    #[test]
    fn test_random_base64url_len() {
        let s = random_base64url(16);
        // 16 bytes → 22 base64url chars (no padding)
        assert_eq!(s.len(), 22);
        assert!(!s.contains('='));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_oauth_work_runs_outside_current_thread_runtime() {
        let runtime_thread = std::thread::current().id();
        let worker_thread = run_blocking_off_runtime(|| Ok(std::thread::current().id())).unwrap();
        assert_ne!(worker_thread, runtime_thread);
    }
}
