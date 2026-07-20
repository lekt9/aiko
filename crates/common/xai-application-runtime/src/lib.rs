//! Aiko-native browser and Electron application primitives.
//!
//! This crate intentionally owns its CDP transport and action surface. It does
//! not invoke, link, or depend on Agent Browser's CLI, daemon, MCP server, or
//! Rust package. The command shape remains compatible with Aiko's application
//! tools so the higher Contract routing layer stays stable.

mod cdp;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cdp::{Client, Event};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, broadcast};

const SUPPORTED_ACTIONS: &[&str] = &[
    "launch",
    "snapshot",
    "url",
    "title",
    "gettext",
    "getattribute",
    "tab_list",
    "console",
    "errors",
    "session_info",
    "inspect",
    "react_tree",
    "requests",
    "request_detail",
    "responsebody",
    "navigate",
    "click",
    "dblclick",
    "fill",
    "type",
    "press",
    "hover",
    "scroll",
    "select",
    "check",
    "uncheck",
    "back",
    "forward",
    "reload",
    "tab_new",
    "tab_switch",
    "tab_close",
    "close",
    "evaluate",
];

const INTERACTIVE_ROLES: &[&str] = &[
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    title: String,
    url: String,
    web_socket_debugger_url: Option<String>,
}

struct Session {
    client: Arc<Client>,
    events: broadcast::Receiver<Event>,
    http: reqwest::Client,
    base_url: String,
    target: Target,
    refs: HashMap<String, i64>,
    requests: HashMap<String, Value>,
    console: Vec<Value>,
    errors: Vec<Value>,
    child: Option<Child>,
    profile: Option<PathBuf>,
}

impl Session {
    async fn command(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.drain_events();
        let result = self.client.command(method, params).await;
        self.drain_events();
        result
    }

    fn drain_events(&mut self) {
        loop {
            let event = match self.events.try_recv() {
                Ok(event) => event,
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            match event.method.as_str() {
                "Network.requestWillBeSent" => {
                    if let Some(id) = event.params.get("requestId").and_then(Value::as_str) {
                        let request = event.params.get("request").cloned().unwrap_or(Value::Null);
                        self.requests.insert(
                            id.to_owned(),
                            json!({
                                "requestId": id,
                                "request": request,
                                "type": event.params.get("type").cloned().unwrap_or(Value::Null),
                                "timestamp": event.params.get("timestamp").cloned().unwrap_or(Value::Null),
                            }),
                        );
                    }
                }
                "Network.responseReceived" => {
                    if let Some(id) = event.params.get("requestId").and_then(Value::as_str) {
                        let entry = self
                            .requests
                            .entry(id.to_owned())
                            .or_insert_with(|| json!({"requestId": id}));
                        if let Some(object) = entry.as_object_mut() {
                            object.insert(
                                "response".into(),
                                event.params.get("response").cloned().unwrap_or(Value::Null),
                            );
                        }
                    }
                }
                "Runtime.consoleAPICalled" => {
                    self.console.push(event.params);
                    trim_events(&mut self.console);
                }
                "Runtime.exceptionThrown" | "Log.entryAdded" => {
                    self.errors.push(event.params);
                    trim_events(&mut self.errors);
                }
                _ => {}
            }
        }
    }

    async fn shutdown(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill().await;
        }
        if let Some(profile) = self.profile.take() {
            let _ = std::fs::remove_dir_all(profile);
        }
    }
}

fn trim_events(events: &mut Vec<Value>) {
    if events.len() > 500 {
        events.drain(..events.len() - 500);
    }
}

#[derive(Default)]
struct RuntimeState {
    session: Option<Session>,
}

/// One process-local browser or Electron session.
pub struct EmbeddedRuntime {
    state: Mutex<RuntimeState>,
}

impl Default for EmbeddedRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl EmbeddedRuntime {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RuntimeState::default()),
        }
    }

    /// Execute one Aiko application command against the native CDP runtime.
    pub async fn execute(&self, command: Value) -> Value {
        let id = command
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let action = command
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !SUPPORTED_ACTIONS.contains(&action) {
            return failure(
                &id,
                format!("Unsupported Aiko application action: {action}"),
            );
        }

        let mut state = self.state.lock().await;
        let result = self.dispatch(action, &command, &mut state).await;
        match result {
            Ok(data) => success(&id, data),
            Err(error) => failure(&id, error),
        }
    }

    pub async fn close(&self) -> Value {
        self.execute(json!({"action": "close"})).await
    }

    async fn dispatch(
        &self,
        action: &str,
        command: &Value,
        state: &mut RuntimeState,
    ) -> Result<Value, String> {
        match action {
            "launch" => {
                if let Some(mut old) = state.session.take() {
                    old.shutdown().await;
                }
                state.session = Some(connect(command).await?);
                let session = state.session.as_ref().expect("session installed");
                Ok(json!({
                    "attached": true,
                    "targetId": session.target.id,
                    "title": session.target.title,
                    "url": session.target.url,
                    "endpoint": session.base_url,
                }))
            }
            "session_info" => Ok(match state.session.as_ref() {
                Some(session) => json!({
                    "connected": true,
                    "targetId": session.target.id,
                    "title": session.target.title,
                    "url": session.target.url,
                    "endpoint": session.base_url,
                    "engine": "aiko-cdp",
                }),
                None => json!({"connected": false, "engine": "aiko-cdp"}),
            }),
            "close" => {
                if let Some(mut session) = state.session.take() {
                    session.shutdown().await;
                }
                Ok(json!({"closed": true}))
            }
            _ => {
                if state.session.is_none() {
                    state.session = Some(connect(&json!({"headed": false})).await?);
                }
                dispatch_session(
                    action,
                    command,
                    state.session.as_mut().expect("session available"),
                )
                .await
            }
        }
    }
}

async fn connect(command: &Value) -> Result<Session, String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("HTTP client initialization failed: {error}"))?;
    let mut child = None;
    let mut profile = None;

    let explicit_url = command
        .get("cdpUrl")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let port = command.get("cdpPort").and_then(Value::as_u64);
    let (base_url, direct_websocket) = if let Some(url) = explicit_url {
        endpoint_from_url(&url)?
    } else if let Some(port) = port {
        (format!("http://127.0.0.1:{port}"), None)
    } else {
        let launched = launch_chrome(command.get("headed").and_then(Value::as_bool) == Some(true))?;
        child = Some(launched.0);
        profile = Some(launched.1);
        (launched.2, None)
    };

    let target = if let Some(websocket) = direct_websocket {
        Target {
            id: websocket
                .rsplit('/')
                .next()
                .unwrap_or("external")
                .to_owned(),
            kind: "page".into(),
            title: "External CDP target".into(),
            url: String::new(),
            web_socket_debugger_url: Some(websocket),
        }
    } else {
        wait_for_target(
            &http,
            &base_url,
            command.get("targetId").and_then(Value::as_str),
        )
        .await?
    };
    build_session(http, base_url, target, child, profile).await
}

fn endpoint_from_url(url: &str) -> Result<(String, Option<String>), String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("Invalid CDP URL: {error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "CDP URL has no host".to_owned())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "CDP URL has no port".to_owned())?;
    let base = format!("http://{host}:{port}");
    if matches!(parsed.scheme(), "ws" | "wss") && parsed.path().contains("/devtools/page/") {
        Ok((base, Some(url.to_owned())))
    } else {
        Ok((base, None))
    }
}

fn launch_chrome(headed: bool) -> Result<(Child, PathBuf, String), String> {
    let executable = chrome_executable().ok_or_else(|| {
        "Chrome was not found. Supply cdpPort/cdpUrl for an existing Electron or browser target."
            .to_owned()
    })?;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Unable to reserve CDP port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Unable to inspect CDP port: {error}"))?
        .port();
    drop(listener);
    let profile = std::env::temp_dir().join(format!("aiko-cdp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&profile)
        .map_err(|error| format!("Unable to create browser profile: {error}"))?;

    let mut process = Command::new(executable);
    process
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if !headed {
        process.arg("--headless=new");
    }
    let child = process
        .spawn()
        .map_err(|error| format!("Chrome launch failed: {error}"))?;
    Ok((child, profile, format!("http://127.0.0.1:{port}")))
}

fn chrome_executable() -> Option<PathBuf> {
    let configured = std::env::var_os("AIKO_CHROME_EXECUTABLE").map(PathBuf::from);
    configured.filter(|path| path.is_file()).or_else(|| {
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ]
        .into_iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .map(Path::to_path_buf)
    })
}

async fn list_targets(http: &reqwest::Client, base: &str) -> Result<Vec<Target>, String> {
    http.get(format!("{base}/json/list"))
        .send()
        .await
        .map_err(|error| format!("CDP discovery failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("CDP discovery rejected: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Invalid CDP target list: {error}"))
}

fn meaningful_target(target: &Target) -> bool {
    target.kind == "page"
        && target.web_socket_debugger_url.is_some()
        && ((!target.title.is_empty() && target.title != "about:blank")
            || !matches!(target.url.as_str(), "" | "about:blank"))
}

fn choose_target(targets: Vec<Target>, requested_id: Option<&str>) -> Option<Target> {
    if let Some(requested_id) = requested_id {
        return targets.into_iter().find(|target| {
            target.kind == "page"
                && target.web_socket_debugger_url.is_some()
                && target.id == requested_id
        });
    }
    targets
        .iter()
        .find(|target| meaningful_target(target))
        .cloned()
        .or_else(|| {
            targets
                .into_iter()
                .find(|target| target.kind == "page" && target.web_socket_debugger_url.is_some())
        })
}

async fn wait_for_target(
    http: &reqwest::Client,
    base: &str,
    requested_id: Option<&str>,
) -> Result<Target, String> {
    let started = Instant::now();
    loop {
        if let Ok(targets) = list_targets(http, base).await
            && let Some(target) = choose_target(targets, requested_id)
        {
            return Ok(target);
        }
        if started.elapsed() > Duration::from_secs(12) {
            return Err(format!("No page or Electron CDP target found at {base}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn build_session(
    http: reqwest::Client,
    base_url: String,
    target: Target,
    child: Option<Child>,
    profile: Option<PathBuf>,
) -> Result<Session, String> {
    let websocket = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| "CDP target did not expose a WebSocket URL".to_owned())?;
    let client = Arc::new(Client::connect(websocket).await?);
    let events = client.subscribe();
    for domain in [
        "Page.enable",
        "Runtime.enable",
        "DOM.enable",
        "Network.enable",
        "Log.enable",
    ] {
        let _ = client.command(domain, json!({})).await;
    }
    Ok(Session {
        client,
        events,
        http,
        base_url,
        target,
        refs: HashMap::new(),
        requests: HashMap::new(),
        console: Vec::new(),
        errors: Vec::new(),
        child,
        profile,
    })
}

async fn dispatch_session(
    action: &str,
    command: &Value,
    session: &mut Session,
) -> Result<Value, String> {
    match action {
        "navigate" => {
            let url = required_string(command, "url")?;
            let result = session.command("Page.navigate", json!({"url": url})).await?;
            Ok(json!({"url": url, "navigation": result}))
        }
        "url" => Ok(json!({"url": evaluate_value(session, "location.href").await?})),
        "title" => Ok(json!({"title": evaluate_value(session, "document.title").await?})),
        "evaluate" => {
            let script = required_string(command, "script")?;
            Ok(json!({"value": evaluate_value(session, script).await?}))
        }
        "snapshot" => snapshot(session, command).await,
        "gettext" => element_call(
            session,
            required_string(command, "selector")?,
            "function(){ return this.innerText || this.textContent || ''; }",
            json!([]),
        )
        .await
        .map(|text| json!({"text": text})),
        "getattribute" => {
            let attribute = required_string(command, "attribute")?;
            element_call(
                session,
                required_string(command, "selector")?,
                "function(name){ return this.getAttribute(name); }",
                json!([{"value": attribute}]),
            )
            .await
            .map(|value| json!({"attribute": attribute, "value": value}))
        }
        "click" => element_action(
            session,
            command,
            "function(){ this.click(); return true; }",
            json!([]),
        )
        .await,
        "dblclick" => element_action(
            session,
            command,
            "function(){ this.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window})); return true; }",
            json!([]),
        )
        .await,
        "hover" => element_action(
            session,
            command,
            "function(){ this.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,view:window})); return true; }",
            json!([]),
        )
        .await,
        "fill" => {
            let value = required_string(command, "value")?;
            element_action(
                session,
                command,
                "function(value){ this.focus(); this.value=value; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
                json!([{"value": value}]),
            )
            .await
        }
        "type" => {
            let value = required_string(command, "value")?;
            element_action(
                session,
                command,
                "function(value){ this.focus(); if(this.isContentEditable){this.textContent=(this.textContent||'')+value}else{this.value=(this.value||'')+value} this.dispatchEvent(new Event('input',{bubbles:true})); return true; }",
                json!([{"value": value}]),
            )
            .await
        }
        "select" => {
            let values = command.get("values").cloned().unwrap_or_else(|| json!([]));
            element_action(
                session,
                command,
                "function(values){ for(const option of this.options||[]){option.selected=values.includes(option.value)} this.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
                json!([{"value": values}]),
            )
            .await
        }
        "check" | "uncheck" => {
            let checked = action == "check";
            element_action(
                session,
                command,
                "function(checked){ this.checked=checked; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
                json!([{"value": checked}]),
            )
            .await
        }
        "press" => {
            let key = required_string(command, "key")?;
            session
                .command("Input.dispatchKeyEvent", json!({"type":"keyDown","key":key}))
                .await?;
            session
                .command("Input.dispatchKeyEvent", json!({"type":"keyUp","key":key}))
                .await?;
            Ok(json!({"pressed": key}))
        }
        "scroll" => {
            let amount = command.get("amount").and_then(Value::as_i64).unwrap_or(500);
            let direction = command
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("down");
            let (x, y) = match direction {
                "up" => (0, -amount),
                "left" => (-amount, 0),
                "right" => (amount, 0),
                _ => (0, amount),
            };
            let script = format!("window.scrollBy({x},{y}); true");
            let _ = evaluate_value(session, &script).await?;
            Ok(json!({"direction": direction, "amount": amount}))
        }
        "back" => {
            let _ = evaluate_value(session, "history.back(); true").await?;
            Ok(json!({"navigated": "back"}))
        }
        "forward" => {
            let _ = evaluate_value(session, "history.forward(); true").await?;
            Ok(json!({"navigated": "forward"}))
        }
        "reload" => {
            session.command("Page.reload", json!({})).await?;
            Ok(json!({"reloaded": true}))
        }
        "tab_list" => {
            session.drain_events();
            let targets = list_targets(&session.http, &session.base_url).await?;
            Ok(json!({"tabs": targets.into_iter().filter(|t| t.kind == "page").map(target_json).collect::<Vec<_>>()}))
        }
        "tab_new" => new_tab(session, command).await,
        "tab_switch" => switch_tab(session, command).await,
        "tab_close" => close_tab(session, command).await,
        "console" => {
            session.drain_events();
            Ok(json!({"messages": session.console}))
        }
        "errors" => {
            session.drain_events();
            Ok(json!({"errors": session.errors}))
        }
        "requests" => requests(session, command),
        "request_detail" => {
            session.drain_events();
            let id = required_string(command, "requestId")?;
            session
                .requests
                .get(id)
                .cloned()
                .ok_or_else(|| format!("Unknown request id: {id}"))
        }
        "responsebody" => {
            let id = required_string(command, "requestId")?;
            session
                .command("Network.getResponseBody", json!({"requestId": id}))
                .await
        }
        "inspect" => Ok(json!({
            "engine": "aiko-cdp",
            "endpoint": session.base_url,
            "target": target_json(session.target.clone()),
            "capabilities": SUPPORTED_ACTIONS,
        })),
        "react_tree" => react_tree(session).await,
        _ => Err(format!("Action is not implemented in the Aiko CDP slice: {action}")),
    }
}

fn target_json(target: Target) -> Value {
    json!({
        "targetId": target.id,
        "title": target.title,
        "url": target.url,
        "type": target.kind,
    })
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing required field: {key}"))
}

async fn evaluate_value(session: &mut Session, expression: &str) -> Result<Value, String> {
    let response = session
        .command(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "userGesture": true,
            }),
        )
        .await?;
    remote_value(&response)
}

fn remote_value(response: &Value) -> Result<Value, String> {
    if let Some(exception) = response.get("exceptionDetails") {
        return Err(exception
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("JavaScript evaluation failed")
            .to_owned());
    }
    let result = response.get("result").unwrap_or(response);
    Ok(result
        .get("value")
        .cloned()
        .or_else(|| result.get("description").cloned())
        .unwrap_or(Value::Null))
}

async fn object_id(session: &mut Session, selector: &str) -> Result<String, String> {
    let response = if let Some(backend_node_id) = session.refs.get(selector).copied() {
        session
            .command("DOM.resolveNode", json!({"backendNodeId": backend_node_id}))
            .await?
    } else {
        session
            .command(
                "Runtime.evaluate",
                json!({
                    "expression": format!("document.querySelector({})", json!(selector)),
                    "returnByValue": false,
                }),
            )
            .await?
    };
    response
        .pointer("/object/objectId")
        .or_else(|| response.pointer("/result/objectId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Element not found: {selector}"))
}

async fn element_call(
    session: &mut Session,
    selector: &str,
    function: &str,
    arguments: Value,
) -> Result<Value, String> {
    let object_id = object_id(session, selector).await?;
    let response = session
        .command(
            "Runtime.callFunctionOn",
            json!({
                "objectId": object_id,
                "functionDeclaration": function,
                "arguments": arguments,
                "awaitPromise": true,
                "returnByValue": true,
                "userGesture": true,
            }),
        )
        .await?;
    remote_value(&response)
}

async fn element_action(
    session: &mut Session,
    command: &Value,
    function: &str,
    arguments: Value,
) -> Result<Value, String> {
    let selector = required_string(command, "selector")?;
    let value = element_call(session, selector, function, arguments).await?;
    Ok(json!({"selector": selector, "performed": value}))
}

async fn snapshot(session: &mut Session, command: &Value) -> Result<Value, String> {
    let interactive = command
        .get("interactive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result = session
        .command("Accessibility.getFullAXTree", json!({}))
        .await?;
    let nodes = result
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Accessibility tree did not contain nodes".to_owned())?;
    session.refs.clear();
    let mut lines = Vec::new();
    let mut refs = Map::new();
    for node in nodes {
        if node.get("ignored").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let role = ax_string(node, "role").unwrap_or("generic");
        let name = ax_string(node, "name").unwrap_or_default();
        if interactive && !INTERACTIVE_ROLES.contains(&role) {
            continue;
        }
        if role == "generic" && name.is_empty() {
            continue;
        }
        if let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) {
            let reference = format!("e{}", session.refs.len() + 1);
            session.refs.insert(reference.clone(), backend);
            refs.insert(
                reference.clone(),
                json!({"backendDOMNodeId": backend, "role": role, "name": name}),
            );
            lines.push(format!("[ref={reference}] {role} {}", json!(name)));
        } else if !name.is_empty() {
            lines.push(format!("{role} {}", json!(name)));
        }
    }
    Ok(json!({
        "snapshot": lines.join("\n"),
        "refs": refs,
        "interactive": interactive,
        "nodeCount": lines.len(),
    }))
}

fn ax_string<'a>(node: &'a Value, key: &str) -> Option<&'a str> {
    node.get(key)?.get("value")?.as_str()
}

fn requests(session: &mut Session, command: &Value) -> Result<Value, String> {
    session.drain_events();
    let filter = command
        .get("filter")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut requests: Vec<Value> = session
        .requests
        .values()
        .filter(|entry| {
            filter.is_empty() || entry.to_string().to_ascii_lowercase().contains(&filter)
        })
        .cloned()
        .collect();
    requests.sort_by(|left, right| {
        left.get("timestamp")
            .and_then(Value::as_f64)
            .partial_cmp(&right.get("timestamp").and_then(Value::as_f64))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(json!({"requests": requests}))
}

async fn new_tab(session: &mut Session, command: &Value) -> Result<Value, String> {
    let url = command
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("about:blank");
    let endpoint = format!("{}/json/new?{}", session.base_url, urlencoding::encode(url));
    let target: Target = session
        .http
        .put(endpoint)
        .send()
        .await
        .map_err(|error| format!("New tab failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("New tab rejected: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Invalid new tab response: {error}"))?;
    replace_target(session, target).await?;
    Ok(json!({"opened": true, "target": target_json(session.target.clone())}))
}

async fn switch_tab(session: &mut Session, command: &Value) -> Result<Value, String> {
    let requested = required_string(command, "target")?;
    let targets: Vec<Target> = list_targets(&session.http, &session.base_url)
        .await?
        .into_iter()
        .filter(|target| target.kind == "page")
        .collect();
    let target = requested
        .parse::<usize>()
        .ok()
        .and_then(|index| targets.get(index).cloned())
        .or_else(|| {
            targets
                .iter()
                .find(|target| target.id == requested)
                .cloned()
        })
        .ok_or_else(|| format!("Unknown tab target: {requested}"))?;
    replace_target(session, target).await?;
    Ok(json!({"switched": true, "target": target_json(session.target.clone())}))
}

async fn close_tab(session: &mut Session, command: &Value) -> Result<Value, String> {
    let requested = command
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or(&session.target.id)
        .to_owned();
    session
        .http
        .get(format!("{}/json/close/{requested}", session.base_url))
        .send()
        .await
        .map_err(|error| format!("Close tab failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Close tab rejected: {error}"))?;
    let target = wait_for_target(&session.http, &session.base_url, None).await?;
    replace_target(session, target).await?;
    Ok(json!({"closed": requested, "target": target_json(session.target.clone())}))
}

async fn replace_target(session: &mut Session, target: Target) -> Result<(), String> {
    let websocket = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| "Selected target has no CDP WebSocket".to_owned())?;
    let client = Arc::new(Client::connect(websocket).await?);
    let events = client.subscribe();
    for domain in [
        "Page.enable",
        "Runtime.enable",
        "DOM.enable",
        "Network.enable",
        "Log.enable",
    ] {
        let _ = client.command(domain, json!({})).await;
    }
    session.client = client;
    session.events = events;
    session.target = target;
    session.refs.clear();
    Ok(())
}

async fn react_tree(session: &mut Session) -> Result<Value, String> {
    const SCRIPT: &str = r#"
(() => {
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return {available:false, roots:[]};
  const out = [];
  const seen = new Set();
  function nameOf(f) {
    const t = f && f.elementType;
    return typeof t === 'string' ? t : (t && (t.displayName || t.name)) || 'Anonymous';
  }
  function walk(f, depth) {
    if (!f || seen.has(f) || seen.size >= 500) return null;
    seen.add(f);
    const node = {name:nameOf(f), key:f.key ?? null, depth, children:[]};
    let child = f.child;
    while (child) {
      const value = walk(child, depth + 1);
      if (value) node.children.push(value);
      child = child.sibling;
    }
    return node;
  }
  for (const renderer of hook.renderers.keys()) {
    for (const root of hook.getFiberRoots(renderer)) {
      const value = walk(root.current, 0);
      if (value) out.push(value);
    }
  }
  return {available:true, roots:out, truncated:seen.size >= 500};
})()
"#;
    evaluate_value(session, SCRIPT).await
}

fn success(id: &str, data: Value) -> Value {
    json!({"success": true, "id": id, "data": data})
}

fn failure(id: &str, error: String) -> Value {
    json!({"success": false, "id": id, "error": error})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_target(id: &str, title: &str, url: &str) -> Target {
        Target {
            id: id.to_owned(),
            kind: "page".to_owned(),
            title: title.to_owned(),
            url: url.to_owned(),
            web_socket_debugger_url: Some(format!("ws://127.0.0.1/devtools/page/{id}")),
        }
    }

    #[test]
    fn automatic_attachment_prefers_meaningful_page_over_blank_page() {
        let selected = choose_target(
            vec![
                test_target("blank", "about:blank", "about:blank"),
                test_target("app", "Aiko", "https://example.test/app"),
            ],
            None,
        )
        .expect("target");
        assert_eq!(selected.id, "app");
    }

    #[test]
    fn explicit_attachment_honors_target_id() {
        let selected = choose_target(
            vec![
                test_target("first", "First", "https://example.test/first"),
                test_target("requested", "Requested", "https://example.test/requested"),
            ],
            Some("requested"),
        )
        .expect("target");
        assert_eq!(selected.id, "requested");
    }

    #[tokio::test]
    async fn session_info_does_not_spawn_or_require_agent_browser() {
        let runtime = EmbeddedRuntime::new();
        let result = runtime.execute(json!({"action": "session_info"})).await;
        assert_eq!(result["success"], true);
        assert_eq!(result["data"]["connected"], false);
        assert_eq!(result["data"]["engine"], "aiko-cdp");
    }

    #[tokio::test]
    async fn unsupported_commands_fail_closed() {
        let runtime = EmbeddedRuntime::new();
        let result = runtime.execute(json!({"action": "video_start"})).await;
        assert_eq!(result["success"], false);
        assert!(result["error"].as_str().unwrap().contains("Unsupported"));
    }

    #[test]
    fn primitive_surface_contains_every_aiko_application_action() {
        assert_eq!(SUPPORTED_ACTIONS.len(), 34);
        assert!(SUPPORTED_ACTIONS.contains(&"react_tree"));
        assert!(SUPPORTED_ACTIONS.contains(&"responsebody"));
        assert!(!SUPPORTED_ACTIONS.contains(&"daemon"));
        assert!(!SUPPORTED_ACTIONS.contains(&"plugin"));
    }

    #[tokio::test]
    async fn native_runtime_drives_snapshot_and_action_end_to_end() {
        if chrome_executable().is_none() {
            return;
        }
        let runtime = EmbeddedRuntime::new();
        let launched = runtime.execute(json!({"action": "launch"})).await;
        assert_eq!(launched["success"], true, "{launched}");

        let html = "<main><button id='aiko' onclick='this.dataset.clicked=\"yes\"'>Aiko native action</button></main>";
        let url = format!("data:text/html,{}", urlencoding::encode(html));
        let navigated = runtime
            .execute(json!({"action": "navigate", "url": url}))
            .await;
        assert_eq!(navigated["success"], true, "{navigated}");

        let snapshot = runtime
            .execute(json!({"action": "snapshot", "interactive": true}))
            .await;
        assert_eq!(snapshot["success"], true, "{snapshot}");
        assert!(
            snapshot["data"]["snapshot"]
                .as_str()
                .unwrap_or_default()
                .contains("Aiko native action"),
            "{snapshot}"
        );

        let clicked = runtime
            .execute(json!({"action": "click", "selector": "e1"}))
            .await;
        assert_eq!(clicked["success"], true, "{clicked}");
        let observed = runtime
            .execute(json!({
                "action": "evaluate",
                "script": "document.querySelector('#aiko').dataset.clicked"
            }))
            .await;
        assert_eq!(observed["data"]["value"], "yes", "{observed}");

        let endpoint = launched["data"]["endpoint"]
            .as_str()
            .expect("launch exposes its CDP endpoint");
        let attached = EmbeddedRuntime::new();
        let attach_result = attached
            .execute(json!({"action": "launch", "cdpUrl": endpoint}))
            .await;
        assert_eq!(attach_result["success"], true, "{attach_result}");
        let attached_snapshot = attached
            .execute(json!({"action": "snapshot", "interactive": true}))
            .await;
        assert_eq!(attached_snapshot["success"], true, "{attached_snapshot}");
        assert!(
            attached_snapshot["data"]["snapshot"]
                .as_str()
                .unwrap_or_default()
                .contains("Aiko native action"),
            "{attached_snapshot}"
        );
        let _ = attached.close().await;
        let _ = runtime.close().await;
    }
}
