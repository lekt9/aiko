//! Host-side desktop notifications.
//!
//! **macOS delivery (Sequoia reality)**:
//! - Real `.app` package → `UNUserNotificationCenter` (registers as Aiko, can banner).
//! - Bare `tauri dev` binary → **do not** use NSUserNotification / notify-rust:
//!   they often return Ok while delivering nothing. Use `osascript` instead
//!   (lands under Script Editor; banner depends on that app's Notification prefs).
//! - Touching UN from a bare binary aborts the process with an uncatchable ObjC
//!   exception (`bundleProxyForCurrentProcess is nil`).
//!
//! **Other platforms**: `tauri-plugin-notification`.
//!
//! Returns the delivery **path** string on success so Settings can be honest.

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Product bundle id (must match `tauri.conf.json` `identifier`).
const APP_BUNDLE_ID: &str = "ai.aiko.desktop";

/// Show a system notification.
///
/// On success returns a short path id:
/// - `unusernotification` — modern API, real `.app`
/// - `nsusernotification` — legacy API (packaged app fallback)
/// - `osascript` — dev bare-binary path (Script Editor)
/// - `plugin` — tauri-plugin-notification
#[tauri::command]
pub fn desktop_notify_show<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("notification title is empty".into());
    }
    let body = body
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
    let session_id = session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    #[cfg(target_os = "macos")]
    {
        match show_macos(&title, &body) {
            Ok(path) => {
                tracing::info!(
                    target: "desktop_notify",
                    title = %title,
                    %path,
                    "native notification delivered"
                );
                return Ok(path.to_string());
            }
            Err(e) => {
                tracing::warn!(
                    target: "desktop_notify",
                    error = %e,
                    title = %title,
                    "macos native path failed"
                );
                return Err(e);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        show_via_plugin(&app, &title, &body, session_id.as_deref())?;
        tracing::info!(
            target: "desktop_notify",
            title = %title,
            "plugin notification accepted"
        );
        Ok("plugin".into())
    }
}

/// Whether the host can attempt native notifications.
#[tauri::command]
pub fn desktop_notify_available() -> bool {
    true
}

/// Startup hook: request UN auth only inside a real `.app`.
pub fn request_permission_on_startup() {
    #[cfg(target_os = "macos")]
    {
        if is_real_app_bundle() {
            match request_macos_auth() {
                Ok(granted) => {
                    tracing::info!(
                        target: "desktop_notify",
                        granted,
                        "macos notification authorization"
                    );
                }
                Err(e) => {
                    tracing::debug!(
                        target: "desktop_notify",
                        error = %e,
                        "macos notification auth failed"
                    );
                }
            }
            // Pin legacy NS path for packaged-app fallback only.
            if let Err(e) = pin_ns_application() {
                tracing::debug!(
                    target: "desktop_notify",
                    error = %e,
                    "set_application(ai.aiko.desktop) failed"
                );
            }
        } else {
            tracing::debug!(
                target: "desktop_notify",
                "dev bare binary: notifications use osascript (Script Editor); UN/NS skipped"
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn show_via_plugin<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    let mut builder = app.notification().builder().title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    if let Some(sid) = session_id {
        builder = builder.extra("sessionId", sid);
    }
    builder.show().map_err(|e| e.to_string())
}

/// True only when the running process lives inside `Something.app/Contents/MacOS/`.
#[cfg(target_os = "macos")]
fn is_real_app_bundle() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        let path = exe.to_string_lossy();
        if path.contains(".app/Contents/MacOS/") {
            return true;
        }
        for ancestor in exe.ancestors() {
            if ancestor
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"))
            {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn show_macos(title: &str, body: &str) -> Result<&'static str, String> {
    if is_real_app_bundle() {
        // Packaged app: modern UN first (real Grok identity + System Settings entry).
        match show_via_usernotifications(title, body) {
            Ok(()) => return Ok("unusernotification"),
            Err(e) => {
                tracing::debug!(
                    target: "desktop_notify",
                    error = %e,
                    "UNUserNotificationCenter path failed"
                );
            }
        }
        // Packaged fallback: NS with our product id.
        match show_via_nsusernotification(title, body) {
            Ok(()) => return Ok("nsusernotification"),
            Err(e) => {
                tracing::debug!(
                    target: "desktop_notify",
                    error = %e,
                    "NSUserNotification path failed"
                );
            }
        }
        return show_via_osascript(title, body).map(|_| "osascript");
    }

    // Bare `tauri dev` binary on Sequoia:
    // - UN → process crash (never call)
    // - NS / notify-rust → often Ok with zero visible delivery
    // - osascript → lands in Notification Center under Script Editor (verified)
    show_via_osascript(title, body).map(|_| "osascript")
}

#[cfg(target_os = "macos")]
fn request_macos_auth() -> Result<bool, String> {
    if !is_real_app_bundle() {
        return Err("not a real .app bundle".into());
    }
    mac_usernotifications::check_bundle().map_err(|e| e.to_string())?;
    mac_usernotifications::blocking::request_auth().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn show_via_usernotifications(title: &str, body: &str) -> Result<(), String> {
    if !is_real_app_bundle() {
        return Err("not a real .app bundle".into());
    }
    mac_usernotifications::check_bundle().map_err(|e| e.to_string())?;
    let granted = mac_usernotifications::blocking::request_auth().map_err(|e| e.to_string())?;
    if !granted {
        return Err("user denied notification authorization".into());
    }
    let mut n = mac_usernotifications::Notification::new().title(title);
    if !body.is_empty() {
        n = n.message(body);
    }
    n.send_blocking().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn pin_ns_application() -> Result<(), String> {
    use mac_notification_sys::error::{ApplicationError, Error as MacError};
    match mac_notification_sys::set_application(APP_BUNDLE_ID) {
        Ok(()) => Ok(()),
        Err(MacError::Application(ApplicationError::AlreadySet(_))) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn show_via_nsusernotification(title: &str, body: &str) -> Result<(), String> {
    pin_ns_application()?;
    mac_notification_sys::send_notification(title, None, body, None).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_via_osascript(title: &str, body: &str) -> Result<(), String> {
    use std::process::Command;

    // Collapse control/newlines and cap length so AppleScript stays valid
    // (availability; title/body are app-controlled i18n strings).
    let sanitize = |s: &str| -> String {
        let flat: String = s
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
        let truncated: String = flat.chars().take(200).collect();
        truncated.replace('\\', "\\\\").replace('"', "\\\"")
    };
    // sound name makes the alert more noticeable when banners are subtle.
    let script = format!(
        "display notification \"{}\" with title \"{}\" sound name \"default\"",
        sanitize(body),
        sanitize(title)
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;
    if out.status.success() {
        tracing::info!(
            target: "desktop_notify",
            title = %title,
            "osascript notification accepted (Notification Center → 脚本编辑器 / Script Editor)"
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(format!("osascript failed: {stderr}"))
    }
}
