use xai_grok_hooks::data_membrane::{HookDataPolicy, minimize_envelope, redact_text};
use xai_grok_hooks::event::{HookEventEnvelope, HookEventName, HookPayload};
use xai_grok_hooks::runner::{command_membrane, http_membrane};

fn envelope() -> HookEventEnvelope {
    HookEventEnvelope {
        hook_event_name: HookEventName::PostToolUse,
        session_id: "session-1".into(),
        cwd: "/tenant/a/private".into(),
        workspace_root: "/tenant/a".into(),
        timestamp: "journal-display-only".into(),
        transcript_path: Some("/tenant/a/transcript-secret.jsonl".into()),
        client_identifier: Some("client".into()),
        prompt_id: Some("prompt-id".into()),
        payload: HookPayload::PostToolUse {
            tool_name: "Read".into(),
            tool_use_id: "tool-1".into(),
            tool_input: serde_json::json!({"path":"../tenant-b/private", "api_token":"canary-token"}),
            tool_result: serde_json::json!({"content":"sibling canary"}),
            tool_input_truncated: false,
            tool_result_truncated: false,
            duration_ms: Some(3),
            is_backgrounded: false,
            subagent_type: None,
        },
    }
}

#[test]
fn data_membrane_default_denies_raw_payload_paths_and_transcript() {
    let value = minimize_envelope(&envelope(), &HookDataPolicy::default());
    let object = value.as_object().unwrap();
    for denied in [
        "cwd",
        "workspaceRoot",
        "transcriptPath",
        "toolInput",
        "toolResult",
    ] {
        assert!(
            !object.contains_key(denied),
            "default membrane leaked {denied}: {value}"
        );
    }
    assert_eq!(object["toolName"], "Read");
    assert_eq!(object["toolUseId"], "tool-1");
}

#[test]
fn data_membrane_capabilities_are_per_field_and_credentials_stay_redacted() {
    let policy = HookDataPolicy::parse(Some("payload:tool_input,path:transcript"));
    let value = minimize_envelope(&envelope(), &policy);
    assert!(value.get("transcriptPath").is_some());
    assert!(
        value.get("toolResult").is_none(),
        "input capability widened to result"
    );
    assert_eq!(value["toolInput"]["api_token"], "[redacted]");
    let credentials = HookDataPolicy::parse(Some("payload:tool_input,payload:credentials"));
    assert_eq!(
        minimize_envelope(&envelope(), &credentials)["toolInput"]["api_token"],
        "canary-token"
    );
}

#[test]
fn data_membrane_does_not_forward_ambient_or_undeclared_env() {
    let policy = HookDataPolicy::parse(Some("env:SAFE"));
    assert!(policy.allows_env("SAFE"));
    assert!(!policy.allows_env("AWS_SECRET_ACCESS_KEY"));
    assert!(!policy.allows_env("HOME"));
}

#[test]
fn data_membrane_redacts_result_and_log_credentials() {
    let policy = HookDataPolicy::default();
    let text = redact_text(
        "request failed Authorization: Bearer canary password=hunter2 ghp_123",
        &policy,
    );
    assert!(
        !text.contains("canary") && !text.contains("hunter2") && !text.contains("ghp_123"),
        "{text}"
    );
}

#[test]
fn data_membrane_confines_commands_and_symlinks() {
    let workspace = tempfile::tempdir().unwrap();
    let sibling = tempfile::tempdir().unwrap();
    let inside = workspace.path().join("hook");
    std::fs::write(&inside, "hook").unwrap();
    let outside = sibling.path().join("steal");
    std::fs::write(&outside, "steal").unwrap();
    let policy = HookDataPolicy::default();
    assert!(command_membrane::confined_command(&inside, workspace.path(), &policy).is_ok());
    assert!(command_membrane::confined_command(&outside, workspace.path(), &policy).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, workspace.path().join("looks-safe")).unwrap();
        assert!(
            command_membrane::confined_command(
                &workspace.path().join("looks-safe"),
                workspace.path(),
                &policy
            )
            .is_err()
        );
    }
    assert!(!command_membrane::shell_allowed(&policy));
}

#[test]
fn data_membrane_http_is_https_host_scoped_and_secret_free() {
    let none = HookDataPolicy::default();
    assert!(http_membrane::constrained_url("https://example.com/hook", &none).is_err());
    let host = HookDataPolicy::parse(Some("http:example.com"));
    assert!(http_membrane::constrained_url("https://example.com/hook", &host).is_ok());
    for denied in [
        "http://example.com/hook",
        "https://other.example/hook",
        "https://user:secret@example.com/hook",
        "https://example.com/hook?token=canary",
        "https://127.0.0.1/hook",
    ] {
        assert!(
            http_membrane::constrained_url(denied, &host).is_err(),
            "allowed {denied}"
        );
    }
}

#[test]
fn data_membrane_observer_policy_grants_nothing_by_default() {
    // Observer transport policy is an inert projection, not Contract authority.
    let policy = HookDataPolicy::default();
    assert!(!policy.allows("contract:verify"));
    assert!(!policy.allows("payload:tool_input"));
}

#[cfg(unix)]
#[tokio::test]
async fn data_membrane_production_runner_minimizes_stdin_and_clears_ambient_env() {
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;
    use xai_grok_hooks::config::HookSpec;
    use xai_grok_hooks::runner::{HookRunnerResult, RunContext, run_hook};

    let workspace = tempfile::tempdir().unwrap();
    let captured = workspace.path().join("captured.json");
    let env_capture = workspace.path().join("captured.env");
    let executable = workspace.path().join("observer");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\ncat > '{}'\nprintf '%s|%s' \"${{SAFE-unset}}\" \"${{HOME-unset}}\" > '{}'\nprintf '{{\"decision\":\"allow\"}}'\n",
            captured.display(), env_capture.display()
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&executable, permissions).unwrap();

    let mut extra_env = HashMap::new();
    extra_env.insert("SAFE".into(), "declared".into());
    extra_env.insert("UNSAFE".into(), "canary".into());
    extra_env.insert(
        xai_grok_hooks::data_membrane::CAPABILITY_ENV.into(),
        "env:SAFE".into(),
    );
    let spec = HookSpec {
        name: "membrane-production".into(),
        event: HookEventName::PostToolUse,
        handler_type: "command".into(),
        configured_matcher: None,
        matcher: None,
        enabled: true,
        command: Some(executable.clone()),
        command_raw: Some(executable.display().to_string()),
        url: None,
        url_raw: None,
        timeout_ms: 5000,
        source_dir: workspace.path().to_path_buf(),
        extra_env,
    };
    let workspace_string = workspace.path().display().to_string();
    let ctx = RunContext {
        session_id: "session-1",
        workspace_root: &workspace_string,
    };
    let (result, _, _) = run_hook(&spec, &envelope(), &ctx, true).await;
    assert!(
        matches!(result, HookRunnerResult::Decision(_)),
        "{result:?}"
    );

    let actual: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(captured).unwrap()).unwrap();
    assert!(
        actual.get("toolInput").is_none(),
        "production leaked: {actual}"
    );
    assert!(
        actual.get("toolResult").is_none(),
        "production leaked: {actual}"
    );
    assert!(
        actual.get("workspaceRoot").is_none(),
        "production leaked: {actual}"
    );
    assert_eq!(
        std::fs::read_to_string(env_capture).unwrap(),
        "declared|unset"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn data_membrane_production_runner_denies_implicit_shell() {
    use std::collections::HashMap;
    use xai_grok_hooks::config::HookSpec;
    use xai_grok_hooks::runner::{HookRunnerResult, RunContext, run_hook};

    let workspace = tempfile::tempdir().unwrap();
    let spec = HookSpec {
        name: "implicit-shell".into(),
        event: HookEventName::PostToolUse,
        handler_type: "command".into(),
        configured_matcher: None,
        matcher: None,
        enabled: true,
        command: Some("printf shell".into()),
        command_raw: Some("printf shell".into()),
        url: None,
        url_raw: None,
        timeout_ms: 5000,
        source_dir: workspace.path().to_path_buf(),
        extra_env: HashMap::new(),
    };
    let workspace_string = workspace.path().display().to_string();
    let ctx = RunContext {
        session_id: "s",
        workspace_root: &workspace_string,
    };
    let (result, _, _) = run_hook(&spec, &envelope(), &ctx, false).await;
    assert!(matches!(result, HookRunnerResult::Failed(ref e) if e.contains("command:shell")));
}

#[tokio::test]
async fn data_membrane_production_http_runner_requires_explicit_host() {
    use std::collections::HashMap;
    use xai_grok_hooks::config::HookSpec;
    use xai_grok_hooks::runner::{HookRunnerResult, RunContext, run_hook};

    let spec = HookSpec {
        name: "http-default-deny".into(),
        event: HookEventName::PostToolUse,
        handler_type: "http".into(),
        configured_matcher: None,
        matcher: None,
        enabled: true,
        command: None,
        command_raw: None,
        url: Some("https://example.com/hook?token=canary".into()),
        url_raw: Some("https://example.com/hook?token=canary".into()),
        timeout_ms: 50,
        source_dir: std::env::temp_dir(),
        extra_env: HashMap::new(),
    };
    let ctx = RunContext {
        session_id: "s",
        workspace_root: "/tmp",
    };
    let (result, _, _) = run_hook(&spec, &envelope(), &ctx, false).await;
    assert!(matches!(
        result,
        HookRunnerResult::Failed(ref e) if e.contains("explicit host capability")
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn data_membrane_production_runner_redacts_hook_reason() {
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;
    use xai_grok_hooks::config::HookSpec;
    use xai_grok_hooks::runner::{HookRunnerResult, RunContext, run_hook};

    let workspace = tempfile::tempdir().unwrap();
    let executable = workspace.path().join("deny-observer");
    std::fs::write(
        &executable,
        "#!/bin/sh\ncat >/dev/null\nprintf '{\"decision\":\"deny\",\"reason\":\"password=hunter2\"}'\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&executable, permissions).unwrap();
    let spec = HookSpec {
        name: "redacting-observer".into(),
        event: HookEventName::PostToolUse,
        handler_type: "command".into(),
        configured_matcher: None,
        matcher: None,
        enabled: true,
        command: Some(executable.clone()),
        command_raw: Some(executable.display().to_string()),
        url: None,
        url_raw: None,
        timeout_ms: 5000,
        source_dir: workspace.path().to_path_buf(),
        extra_env: HashMap::new(),
    };
    let workspace_string = workspace.path().display().to_string();
    let ctx = RunContext {
        session_id: "s",
        workspace_root: &workspace_string,
    };
    let (result, _, _) = run_hook(&spec, &envelope(), &ctx, true).await;
    match result {
        HookRunnerResult::Decision(xai_grok_hooks::result::HookDecision::Deny {
            reason, ..
        }) => {
            assert!(!reason.contains("hunter2"), "reason leaked: {reason}");
        }
        other => panic!("expected redacted deny, got {other:?}"),
    }
}
