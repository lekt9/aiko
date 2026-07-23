//! Stable, authenticated loopback API for native Aiko frontends.
//!
//! This is deliberately a facade over owned interfaces. Contract remains the
//! task/ledger authority and ACP remains the full-duplex agent-mail protocol.

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use xai_grok_pager::app::cli::{
    ActivityCommand, AgentMailCommand, CaptchaCommand, NativeArgs, NativeCommand, ReflexCommand,
    TelegramCommand,
};
use xai_grok_shell::agentmail_native;
use xai_grok_shell::captcha_native;
use xai_grok_shell::env::GrokBuildEnvironment;
use xai_grok_shell::leader::{
    ClientCapabilities, ClientMode, LeaderClient, LeaderTarget, resolve_leader_target,
};
use xai_grok_shell::telegram_native;

pub const DEFAULT_ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 19_420));
const SCHEMA: &str = "aiko.native.v1";
const MAX_WS_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const INTERFACE_MANIFEST: &str = include_str!("../../../../docs/aiko-native-interfaces.json");
const OPENAPI: &str = include_str!("../../../../docs/aiko-native-api.openapi.json");

#[derive(Clone)]
struct ApiState {
    token: Arc<str>,
    address: SocketAddr,
}

struct DiscoveryGuard {
    path: PathBuf,
    pid: u32,
}

impl Drop for DiscoveryGuard {
    fn drop(&mut self) {
        let owns_file = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("pid").and_then(Value::as_u64))
            == Some(self.pid as u64);
        if owns_file {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub async fn run_command(args: NativeArgs) -> Result<()> {
    match args.command {
        NativeCommand::Manifest => {
            let value: Value = serde_json::from_str(INTERFACE_MANIFEST)?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        NativeCommand::Discovery => {
            let raw = std::fs::read_to_string(discovery_path()).with_context(|| {
                "Aiko native API is not discoverable; start the background worker or run `aiko native serve`"
            })?;
            let value: Value = serde_json::from_str(&raw)
                .context("Aiko native API discovery document is invalid")?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        NativeCommand::Serve { addr } => {
            tokio::select! {
                result = serve(addr) => result,
                signal = tokio::signal::ctrl_c() => {
                    signal.context("failed to listen for shutdown signal")?;
                    Ok(())
                }
            }
        }
        NativeCommand::Reflex { command } => {
            let value = match command {
                ReflexCommand::Status => xai_grok_shell::contract_native::reflex_policy_status(),
                ReflexCommand::List { context } => {
                    xai_grok_shell::contract_native::inspect_muscle_rankings(context).await
                }
                ReflexCommand::Delete { capability } => json!({
                    "capability": capability.clone(),
                    "deleted": xai_grok_shell::contract_native::delete_muscle_reflex(capability).await,
                }),
                ReflexCommand::Enable => {
                    xai_grok_shell::contract_native::set_reflexes_enabled(true)
                        .map_err(anyhow::Error::msg)?
                }
                ReflexCommand::Disable => {
                    xai_grok_shell::contract_native::set_reflexes_enabled(false)
                        .map_err(anyhow::Error::msg)?
                }
                ReflexCommand::Allow { capability } => {
                    xai_grok_shell::contract_native::set_reflex_capability_enabled(capability, true)
                        .map_err(anyhow::Error::msg)?
                }
                ReflexCommand::Deny { capability } => {
                    xai_grok_shell::contract_native::set_reflex_capability_enabled(
                        capability, false,
                    )
                    .map_err(anyhow::Error::msg)?
                }
            };
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        NativeCommand::Activity { command } => {
            let value = match command {
                ActivityCommand::Status => xai_grok_shell::contract_native::reflex_policy_status(),
                ActivityCommand::Enable => {
                    xai_grok_shell::contract_native::set_activity_sensors_enabled(true)
                        .map_err(anyhow::Error::msg)?
                }
                ActivityCommand::Disable => {
                    xai_grok_shell::contract_native::set_activity_sensors_enabled(false)
                        .map_err(anyhow::Error::msg)?
                }
                ActivityCommand::List { limit } => {
                    xai_grok_shell::contract_native::inspect_activity_events(limit)
                }
                ActivityCommand::Clear => {
                    xai_grok_shell::contract_native::clear_activity_events()
                        .map_err(anyhow::Error::msg)?;
                    json!({ "cleared": true })
                }
                ActivityCommand::Exclude { application } => {
                    xai_grok_shell::contract_native::set_activity_application_excluded(
                        application,
                        true,
                    )
                    .map_err(anyhow::Error::msg)?
                }
                ActivityCommand::Include { application } => {
                    xai_grok_shell::contract_native::set_activity_application_excluded(
                        application,
                        false,
                    )
                    .map_err(anyhow::Error::msg)?
                }
            };
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        NativeCommand::AgentMail { command } => match command {
            AgentMailCommand::CreateInbox { name } => {
                let inbox = agentmail_native::create_inbox(Some(&name)).await?;
                agentmail_native::print_inbox(&inbox);
                Ok(())
            }
            AgentMailCommand::ListInboxes => {
                let response = agentmail_native::list_inboxes().await?;
                agentmail_native::print_inbox_list(&response);
                Ok(())
            }
            AgentMailCommand::ListThreads => {
                let response = agentmail_native::list_threads().await?;
                agentmail_native::print_thread_list(&response);
                Ok(())
            }
            AgentMailCommand::GetThread { id } => {
                let detail = agentmail_native::get_thread(&id).await?;
                agentmail_native::print_thread_detail(&detail);
                Ok(())
            }
            AgentMailCommand::WaitForCode { timeout, poll } => {
                match agentmail_native::wait_for_verification_code(timeout, poll).await? {
                    Some((detail, code)) => {
                        let result = json!({
                            "thread": detail,
                            "verification_code": code,
                        });
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    }
                    None => {
                        eprintln!("No verification code found within {timeout}s");
                    }
                }
                Ok(())
            }
        },
        NativeCommand::Captcha { command } => match command {
            CaptchaCommand::SolveHcaptcha {
                site_key,
                page_url,
                invisible,
            } => {
                let response = captcha_native::solve_captcha(
                    "HCaptchaTaskProxyless",
                    &site_key,
                    &page_url,
                    Some(invisible),
                    None,
                )
                .await?;
                captcha_native::print_solve_response(&response);
                Ok(())
            }
            CaptchaCommand::SolveRecaptcha {
                site_key,
                page_url,
                min_score,
            } => {
                let captcha_type = if min_score.is_some() {
                    "RecaptchaV3TaskProxyless"
                } else {
                    "RecaptchaV2TaskProxyless"
                };
                let response = captcha_native::solve_captcha(
                    captcha_type,
                    &site_key,
                    &page_url,
                    None,
                    min_score,
                )
                .await?;
                captcha_native::print_solve_response(&response);
                Ok(())
            }
            CaptchaCommand::GetResult { task_id } => {
                let response = captcha_native::get_captcha_result(task_id).await?;
                captcha_native::print_result_response(&response);
                Ok(())
            }
            CaptchaCommand::WaitForSolution {
                task_id,
                timeout,
                poll,
            } => {
                let response = captcha_native::wait_for_solution(task_id, timeout, poll).await?;
                captcha_native::print_result_response(&response);
                Ok(())
            }
        },
        NativeCommand::Telegram { command } => match command {
            TelegramCommand::Status { .. } => {
                let settings = telegram_native::read_settings().map_err(anyhow::Error::msg)?;
                telegram_native::print_settings(&settings);
                Ok(())
            }
            TelegramCommand::SetToken { token } => {
                let masked = telegram_native::save_bot_token(&token).map_err(anyhow::Error::msg)?;
                println!("Token saved: {masked}");
                Ok(())
            }
            TelegramCommand::ApprovePair { code } => {
                let result =
                    telegram_native::approve_pair_code(&code).map_err(anyhow::Error::msg)?;
                telegram_native::print_pair_result(&result);
                Ok(())
            }
            TelegramCommand::Log { tail } => {
                let lines = telegram_native::read_bridge_log(tail);
                telegram_native::print_log(&lines);
                Ok(())
            }
        },
    }
}

pub async fn serve(address: SocketAddr) -> Result<()> {
    if !address.ip().is_loopback() {
        anyhow::bail!("Aiko native API refuses non-loopback address {address}");
    }
    let token = load_or_create_token()?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind Aiko native API at {address}"))?;
    let address = listener.local_addr()?;
    let state = ApiState {
        token: Arc::from(token),
        address,
    };
    let _discovery = write_discovery(&state)?;
    let app = Router::new()
        .route("/v1/manifest", get(manifest))
        .route("/v1/openapi.json", get(openapi))
        .route("/v1/health", get(health))
        .route("/v1/contracts", get(contracts))
        .route("/v1/contracts/scheduled", get(scheduled_contracts))
        .route("/v1/contracts/{id}", get(contract_history))
        .route("/v1/contracts/{id}/retry", post(retry_contract))
        .route("/v1/contracts/{id}/cancel", post(cancel_contract))
        .route("/v1/reflexes", get(reflexes))
        .route("/v1/reflexes/{capability}", delete(delete_reflex))
        .route(
            "/v1/reflex-policy",
            get(reflex_policy).put(update_reflex_policy),
        )
        .route(
            "/v1/activity",
            get(activity_events).delete(clear_activity_events),
        )
        .route("/v1/collective", get(collective_status))
        .route("/v1/signals", post(emit_signal))
        .route("/v1/leaders", get(leaders))
        .route("/v1/agent-mail", get(agent_mail))
        .route(
            "/v1/agentmail/inboxes",
            get(agentmail_list_inboxes).post(agentmail_create_inbox),
        )
        .route("/v1/agentmail/threads", get(agentmail_list_threads))
        .route("/v1/agentmail/threads/{id}", get(agentmail_get_thread))
        .route("/v1/agentmail/wait-for-code", post(agentmail_wait_for_code))
        .route("/v1/captcha/solve", post(captcha_solve))
        .route("/v1/captcha/direct", post(captcha_direct_solve))
        .route("/v1/captcha/results/{task_id}", get(captcha_get_result))
        .route("/v1/captcha/wait", post(captcha_wait_for_solution))
        .route("/v1/telegram/settings", get(telegram_get_settings))
        .route("/v1/telegram/token", put(telegram_set_token))
        .route("/v1/telegram/pair", post(telegram_approve_pair))
        .route("/v1/telegram/log", get(telegram_get_log))
        .route("/v1/collective/status", get(collective_status))
        .route("/v1/collective/audit", get(collective_audit))
        .route("/v1/collective/objects", get(collective_objects))
        .route(
            "/v1/collective/equivocations",
            get(collective_equivocations),
        )
        .route("/v1/collective/query-local", post(collective_query_local))
        .route("/v1/collective/discover", post(collective_discover))
        .route("/v1/collective/review", get(collective_review_queue))
        .route(
            "/v1/collective/review/{object_id}/approve",
            post(collective_review_approve),
        )
        .route(
            "/v1/collective/review/{object_id}/reject",
            post(collective_review_reject),
        )
        .route(
            "/v1/collective/objects/{object_id}",
            delete(collective_erase_object),
        )
        .route(
            "/v1/collective/objects/{object_id}/revoke",
            post(collective_revoke_object),
        )
        .route(
            "/v1/collective/participation",
            put(collective_set_participation).post(collective_set_participation),
        )
        .route(
            "/v1/collective/publication-mode",
            put(collective_set_publication_mode).post(collective_set_publication_mode),
        )
        .route(
            "/v1/collective/evidence-sharing",
            put(collective_set_evidence_sharing).post(collective_set_evidence_sharing),
        )
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state);
    axum::serve(listener, app)
        .await
        .context("Aiko native API server failed")
}

async fn require_auth(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let header_token = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let query_token = request.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "token").then_some(value)
        })
    });
    if header_token
        .or(query_token)
        .is_none_or(|provided| !constant_time_eq(provided.as_bytes(), state.token.as_bytes()))
    {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Read the same-user discovery document and provide its bearer token.",
        );
    }
    next.run(request).await
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

async fn manifest(State(state): State<ApiState>) -> Response {
    match serde_json::from_str::<Value>(INTERFACE_MANIFEST) {
        Ok(mut value) => {
            value["baseUrl"] = json!(format!("http://{}", state.address));
            value["agentMailUrl"] = json!(format!("ws://{}/v1/agent-mail", state.address));
            Json(value).into_response()
        }
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_manifest",
            &error.to_string(),
        ),
    }
}

async fn openapi() -> Response {
    match serde_json::from_str::<Value>(OPENAPI) {
        Ok(value) => Json(value).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_openapi",
            &error.to_string(),
        ),
    }
}

async fn health(State(state): State<ApiState>) -> Json<Value> {
    Json(json!({
        "schema": SCHEMA,
        "status": "ok",
        "version": env!("VERSION_WITH_COMMIT"),
        "pid": std::process::id(),
        "address": state.address,
        "contractAbi": xai_grok_shell::contract_native::contract_abi_version(),
        "contractAvailable": xai_grok_shell::contract_native::contract_abi_version().is_some(),
    }))
}

async fn collective_status() -> Json<Value> {
    Json(json!({
        "schema": SCHEMA,
        "collective": xai_grok_shell::collective_host::collective_status(),
    }))
}

async fn collective_audit() -> Response {
    match xai_grok_shell::collective_host::collective_publication_audit() {
        Ok(items) => Json(json!({ "schema": SCHEMA, "items": items })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn collective_objects() -> Response {
    match xai_grok_shell::collective_host::collective_objects() {
        Ok(items) => Json(json!({ "schema": SCHEMA, "items": items })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn collective_equivocations() -> Response {
    match xai_grok_shell::collective_host::collective_equivocations() {
        Ok(items) => Json(json!({ "schema": SCHEMA, "items": items })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn collective_query_local(Json(body): Json<Value>) -> Response {
    let Some(task) = body.get("task").and_then(Value::as_str) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`task` is required.",
        );
    };
    let limit = body.get("limit").and_then(Value::as_u64).unwrap_or(20) as u32;
    match xai_grok_shell::collective_host::query_collective_local(task, limit) {
        Ok(ranked) => Json(json!({ "schema": SCHEMA, "ranked": ranked })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "collective_error", &error),
    }
}

async fn collective_discover(Json(body): Json<Value>) -> Response {
    let query = match serde_json::from_value::<xai_aiko_collective::PublicQuery>(
        body.get("query").cloned().unwrap_or(Value::Null),
    ) {
        Ok(query) => query,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`query` must contain bounded public capability_terms, operations, and effects.",
            );
        }
    };
    let limit = body.get("limit").and_then(Value::as_u64).unwrap_or(20);
    let Ok(limit) = u16::try_from(limit) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`limit` is invalid.",
        );
    };
    match xai_grok_shell::collective_host::discover_collective(query, limit) {
        Ok(ranked) => Json(json!({ "schema": SCHEMA, "ranked": ranked })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "collective_error", &error),
    }
}

async fn collective_review_queue() -> Response {
    match xai_grok_shell::collective_host::collective_review_queue() {
        Ok(items) => Json(json!({ "schema": SCHEMA, "items": items })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn collective_review_approve(Path(object_id): Path<String>) -> Response {
    match xai_grok_shell::collective_host::approve_collective_review(&object_id) {
        Ok(published_object_id) => Json(json!({
            "schema": SCHEMA,
            "publishedObjectId": published_object_id,
        }))
        .into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "collective_error", &error),
    }
}

async fn collective_review_reject(Path(object_id): Path<String>) -> Response {
    match xai_grok_shell::collective_host::reject_collective_review(&object_id) {
        Ok(()) => Json(json!({ "schema": SCHEMA, "rejected": true })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "collective_error", &error),
    }
}

async fn collective_erase_object(Path(object_id): Path<String>) -> Response {
    match xai_grok_shell::collective_host::erase_collective_object(&object_id) {
        Ok(status) => Json(json!({ "schema": SCHEMA, "collective": status })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "collective_error", &error),
    }
}

async fn collective_revoke_object(
    Path(object_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let reason = body
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("publisher_request");
    match xai_grok_shell::collective_host::revoke_collective_object(&object_id, reason) {
        Ok(revocation_object_id) => Json(json!({
            "schema": SCHEMA,
            "objectId": object_id,
            "revocationObjectId": revocation_object_id,
        }))
        .into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "collective_error", &error),
    }
}

async fn collective_set_participation(Json(body): Json<Value>) -> Response {
    let Some(enabled) = body.get("enabled").and_then(Value::as_bool) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`enabled` must be boolean.",
        );
    };
    match xai_grok_shell::collective_host::set_collective_participation(enabled) {
        Ok(status) => Json(json!({ "schema": SCHEMA, "collective": status })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn collective_set_publication_mode(Json(body): Json<Value>) -> Response {
    let mode = match body.get("mode").and_then(Value::as_str) {
        Some(mode @ ("disabled" | "safe_public_shapes" | "review_every_object")) => mode,
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`mode` must be disabled, safe_public_shapes, or review_every_object.",
            );
        }
    };
    match xai_grok_shell::collective_host::set_collective_publication_mode_name(mode) {
        Ok(status) => Json(json!({ "schema": SCHEMA, "collective": status })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn collective_set_evidence_sharing(Json(body): Json<Value>) -> Response {
    let Some(enabled) = body.get("enabled").and_then(Value::as_bool) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`enabled` must be boolean.",
        );
    };
    match xai_grok_shell::collective_host::set_collective_evidence_sharing(enabled) {
        Ok(status) => Json(json!({ "schema": SCHEMA, "collective": status })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "collective_error",
            &error,
        ),
    }
}

async fn contracts() -> Json<Value> {
    let contracts = xai_grok_shell::contract_native::list_contracts()
        .await
        .into_iter()
        .map(|(id, plan)| json!({ "id": id, "plan": plan }))
        .collect::<Vec<_>>();
    Json(json!({ "schema": SCHEMA, "items": contracts }))
}

async fn scheduled_contracts() -> Json<Value> {
    Json(json!({
        "schema": SCHEMA,
        "items": xai_grok_shell::contract_native::list_scheduled_contracts().await,
    }))
}

async fn reflexes(Query(query): Query<BTreeMap<String, String>>) -> Json<Value> {
    Json(json!({
        "schema": SCHEMA,
        "rankings": xai_grok_shell::contract_native::inspect_muscle_rankings(
            query.get("context").cloned().unwrap_or_default()
        ).await,
        "policy": xai_grok_shell::contract_native::reflex_policy_status(),
    }))
}

async fn delete_reflex(Path(capability): Path<String>) -> Response {
    if xai_grok_shell::contract_native::delete_muscle_reflex(capability.clone()).await {
        Json(json!({ "schema": SCHEMA, "capability": capability, "deleted": true })).into_response()
    } else {
        api_error(
            StatusCode::NOT_FOUND,
            "reflex_not_found",
            "The learned reflex could not be deleted.",
        )
    }
}

async fn reflex_policy() -> Json<Value> {
    Json(
        json!({ "schema": SCHEMA, "policy": xai_grok_shell::contract_native::reflex_policy_status() }),
    )
}

async fn update_reflex_policy(Json(body): Json<Value>) -> Response {
    let result = if let Some(enabled) = body.get("reflexes_enabled").and_then(Value::as_bool) {
        xai_grok_shell::contract_native::set_reflexes_enabled(enabled)
    } else if let Some(enabled) = body
        .get("activity_sensors_enabled")
        .and_then(Value::as_bool)
    {
        xai_grok_shell::contract_native::set_activity_sensors_enabled(enabled)
    } else if let (Some(capability), Some(enabled)) = (
        body.get("capability").and_then(Value::as_str),
        body.get("enabled").and_then(Value::as_bool),
    ) {
        xai_grok_shell::contract_native::set_reflex_capability_enabled(
            capability.to_owned(),
            enabled,
        )
    } else if let (Some(application), Some(excluded)) = (
        body.get("application").and_then(Value::as_str),
        body.get("excluded").and_then(Value::as_bool),
    ) {
        xai_grok_shell::contract_native::set_activity_application_excluded(
            application.to_owned(),
            excluded,
        )
    } else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_policy_update",
            "Provide one supported reflex policy update.",
        );
    };
    match result {
        Ok(policy) => Json(json!({ "schema": SCHEMA, "policy": policy })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "policy_write_failed",
            &error,
        ),
    }
}

async fn activity_events(Query(query): Query<BTreeMap<String, String>>) -> Json<Value> {
    let limit = query
        .get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(100);
    Json(json!({
        "schema": SCHEMA,
        "activity": xai_grok_shell::contract_native::inspect_activity_events(limit),
    }))
}

async fn clear_activity_events() -> Response {
    match xai_grok_shell::contract_native::clear_activity_events() {
        Ok(()) => Json(json!({ "schema": SCHEMA, "cleared": true })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "activity_clear_failed",
            &error,
        ),
    }
}

async fn contract_history(Path(id): Path<String>) -> Response {
    match xai_grok_shell::contract_native::inspect_contract(id.clone()).await {
        Some(history) => Json(json!({
            "schema": SCHEMA,
            "id": id,
            "contentType": "application/x-ndjson",
            "history": history,
        }))
        .into_response(),
        None => api_error(
            StatusCode::NOT_FOUND,
            "contract_not_found",
            "No Contract ledger rows matched that id.",
        ),
    }
}

async fn retry_contract(Path(id): Path<String>) -> Response {
    if xai_grok_shell::contract_native::retry_contract(id.clone()).await {
        Json(json!({ "schema": SCHEMA, "id": id, "released": true })).into_response()
    } else {
        api_error(
            StatusCode::CONFLICT,
            "not_retryable",
            "The contract has no retryable occurrence.",
        )
    }
}

async fn cancel_contract(Path(id): Path<String>) -> Response {
    if xai_grok_shell::contract_native::cancel_contract(id.clone()).await {
        Json(json!({ "schema": SCHEMA, "id": id, "cancelled": true })).into_response()
    } else {
        api_error(
            StatusCode::CONFLICT,
            "not_cancelled",
            "The contract could not be cancelled.",
        )
    }
}

async fn emit_signal(Json(body): Json<Value>) -> Response {
    let Some(name) = body.get("name").and_then(Value::as_str).map(str::trim) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_signal",
            "`name` is required.",
        );
    };
    if name.is_empty() || name.len() > 128 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_signal",
            "`name` must contain 1–128 bytes.",
        );
    }
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let detail = body
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if detail.len() > 2_000 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_signal",
            "`detail` must not exceed 2,000 bytes.",
        );
    }
    let detail = xai_grok_secrets::redact_secrets(detail);
    let detail = xai_grok_secrets::redact_user_paths(detail.as_ref()).into_owned();
    if xai_grok_shell::contract_native::emit_contract_signal(name.to_string(), cwd, detail).await {
        Json(json!({ "schema": SCHEMA, "accepted": true, "name": name })).into_response()
    } else {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "contract_unavailable",
            "Contract ABI v3 did not accept the signal.",
        )
    }
}

async fn leaders() -> Json<Value> {
    let items = xai_grok_shell::leader::discover_leaders()
        .await
        .into_iter()
        .map(|leader| {
            json!({
                "classification": format!("{:?}", leader.classification),
                "environment": leader.environment.map(|value| format!("{value:?}")),
                "pid": leader.live_info.as_ref().map(|info| info.pid).or(leader.pid_from_lock),
                "socketPath": leader.socket_path.map(|path| path.display().to_string()),
                "wsUrlSuffix": leader.ws_url_suffix,
                "error": leader.target_error.map(|value| value.to_string()),
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "schema": SCHEMA, "items": items }))
}

async fn agent_mail(
    State(_state): State<ApiState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let requested_protocol = headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|item| item.trim() == "aiko.acp.v1"));
    let upgrade = if requested_protocol {
        upgrade.protocols(["aiko.acp.v1"])
    } else {
        upgrade
    };
    upgrade.on_upgrade(bridge_agent_mail)
}

async fn bridge_agent_mail(socket: WebSocket) {
    let selection =
        match resolve_leader_target(LeaderTarget::Environment(GrokBuildEnvironment::Production))
            .await
        {
            Ok(selection) => selection,
            Err(error) => {
                send_ws_error(socket, "leader_unavailable", &error.message).await;
                return;
            }
        };
    let Some(socket_path) = selection.socket_path().map(FsPath::to_path_buf) else {
        send_ws_error(
            socket,
            "leader_unavailable",
            "The selected leader has no socket path.",
        )
        .await;
        return;
    };
    let capabilities = ClientCapabilities {
        client_version: Some(env!("VERSION_WITH_COMMIT").to_string()),
        ..ClientCapabilities::default()
    };
    let client = match LeaderClient::connect(
        socket_path,
        "aiko-native-frontend",
        ClientMode::Stdio,
        capabilities,
    )
    .await
    {
        Ok(client) => client,
        Err(error) => {
            send_ws_error(socket, "leader_connect_failed", &error.to_string()).await;
            return;
        }
    };
    let (to_leader, mut from_leader) = client.into_channels();
    let (mut to_frontend, mut from_frontend) = socket.split();
    loop {
        tokio::select! {
            inbound = from_frontend.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_WS_MESSAGE_BYTES => {
                        if serde_json::from_str::<Value>(&text).is_err() {
                            let _ = to_frontend.send(Message::Text(
                                json!({"jsonrpc":"2.0","error":{"code":-32600,"message":"invalid JSON-RPC payload"}}).to_string().into()
                            )).await;
                            continue;
                        }
                        if to_leader.send(text.to_string()).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if to_frontend.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
            outbound = from_leader.recv() => {
                let Some(payload) = outbound else { break };
                if to_frontend.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn send_ws_error(mut socket: WebSocket, code: &str, message: &str) {
    let message = xai_grok_secrets::redact_secrets(message);
    let _ = socket
        .send(Message::Text(
            json!({
                "schema": SCHEMA,
                "type": "error",
                "error": { "code": code, "message": message },
            })
            .to_string()
            .into(),
        ))
        .await;
    let _ = socket.close().await;
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    let message = xai_grok_secrets::redact_secrets(message);
    let message = xai_grok_secrets::redact_user_paths(message.as_ref());
    (
        status,
        Json(json!({
            "schema": SCHEMA,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

fn native_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aiko/native")
}

fn token_path() -> PathBuf {
    native_dir().join("token")
}

fn discovery_path() -> PathBuf {
    native_dir().join("api.json")
}

fn load_or_create_token() -> Result<String> {
    let path = token_path();
    std::fs::create_dir_all(native_dir())?;
    set_private_dir_permissions(&native_dir())?;
    if let Ok(token) = std::fs::read_to_string(&path) {
        let token = token.trim();
        if token.len() >= 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            set_private_permissions(&path)?;
            return Ok(token.to_string());
        }
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    write_private_atomic(&path, token.as_bytes())?;
    Ok(token)
}

fn write_discovery(state: &ApiState) -> Result<DiscoveryGuard> {
    let path = discovery_path();
    let pid = std::process::id();
    let value = json!({
        "schema": SCHEMA,
        "apiVersion": 1,
        "pid": pid,
        "baseUrl": format!("http://{}", state.address),
        "agentMailUrl": format!("ws://{}/v1/agent-mail", state.address),
        "authorization": {
            "type": "bearer",
            "token": state.token,
            "websocketQueryParameter": "token",
            "websocketSubprotocol": "aiko.acp.v1",
        },
        "manifest": "/v1/manifest",
        "openapi": "/v1/openapi.json",
    });
    write_private_atomic(&path, serde_json::to_string_pretty(&value)?.as_bytes())?;
    Ok(DiscoveryGuard { path, pid })
}

fn write_private_atomic(path: &FsPath, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("private Aiko path has no parent directory")?;
    std::fs::create_dir_all(parent)?;
    set_private_dir_permissions(parent)?;
    let temporary = parent.join(format!(".native-write-{}", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&temporary, bytes)?;
    }
    std::fs::rename(&temporary, path)?;
    set_private_permissions(path)?;
    Ok(())
}

fn set_private_permissions(path: &FsPath) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn set_private_dir_permissions(path: &FsPath) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

// ── agentmail routes ─────────────────────────────────────────────────────────

async fn agentmail_create_inbox(Json(body): Json<Value>) -> Response {
    if body.get("confirmPurchase").and_then(Value::as_bool) != Some(true) {
        return api_error(
            StatusCode::PAYMENT_REQUIRED,
            "purchase_confirmation_required",
            "Creating an AgentMail inbox costs $2.00. Resubmit with `confirmPurchase: true`.",
        );
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Aiko Build")
        .trim();
    if name.is_empty() || name.len() > 120 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`name` must contain 1–120 bytes.",
        );
    }
    match agentmail_native::create_inbox(Some(name)).await {
        Ok(inbox) => Json(json!({ "schema": SCHEMA, "inbox": inbox })).into_response(),
        Err(error) => api_error(
            StatusCode::PAYMENT_REQUIRED,
            "agentmail_error",
            &error.to_string(),
        ),
    }
}

async fn agentmail_list_inboxes() -> Response {
    match agentmail_native::list_inboxes().await {
        Ok(response) => Json(json!({ "schema": SCHEMA, "inboxes": response.items, "next_cursor": response.next_cursor })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "agentmail_error",
            &error.to_string(),
        ),
    }
}

async fn agentmail_list_threads() -> Response {
    match agentmail_native::list_threads().await {
        Ok(response) => Json(json!({ "schema": SCHEMA, "threads": response.items, "next_cursor": response.next_cursor })).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "agentmail_error",
            &error.to_string(),
        ),
    }
}

async fn agentmail_get_thread(Path(id): Path<String>) -> Response {
    if !valid_external_id(&id) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`id` must be a 1–200 character provider identifier.",
        );
    }
    match agentmail_native::get_thread(&id).await {
        Ok(detail) => Json(json!({ "schema": SCHEMA, "thread": detail })).into_response(),
        Err(error) => api_error(StatusCode::NOT_FOUND, "agentmail_error", &error.to_string()),
    }
}

async fn agentmail_wait_for_code(Json(body): Json<Value>) -> Response {
    let timeout = body.get("timeout").and_then(Value::as_u64).unwrap_or(120);
    let poll = body.get("poll").and_then(Value::as_u64).unwrap_or(5);
    if timeout == 0 || timeout > 600 || poll == 0 || poll > 60 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`timeout` must be 1–600 seconds and `poll` must be 1–60 seconds.",
        );
    }
    match agentmail_native::wait_for_verification_code(timeout, poll).await {
        Ok(Some((detail, code))) => Json(json!({
            "schema": SCHEMA,
            "thread": detail,
            "verification_code": code,
        }))
        .into_response(),
        Ok(None) => Json(json!({
            "schema": SCHEMA,
            "verification_code": null,
            "message": "No verification code found within timeout",
        }))
        .into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "agentmail_error",
            &error.to_string(),
        ),
    }
}

// ── captcha routes ───────────────────────────────────────────────────────────

async fn captcha_solve(Json(body): Json<Value>) -> Response {
    if body.get("confirmPurchase").and_then(Value::as_bool) != Some(true) {
        return api_error(
            StatusCode::PAYMENT_REQUIRED,
            "purchase_confirmation_required",
            "Submitting a CAPTCHA solve costs approximately $0.01. Resubmit with `confirmPurchase: true`.",
        );
    }
    let captcha_type = match body.get("type").and_then(Value::as_str) {
        Some("hcaptcha") | None => "HCaptchaTaskProxyless",
        Some("recaptcha_v2") => "RecaptchaV2TaskProxyless",
        Some("recaptcha_v3") => "RecaptchaV3TaskProxyless",
        Some(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`type` must be `hcaptcha`, `recaptcha_v2`, or `recaptcha_v3`.",
            );
        }
    };
    let site_key = match body.get("site_key").and_then(Value::as_str) {
        Some(k) => k.to_string(),
        None => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`site_key` is required.",
            );
        }
    };
    let page_url = match body.get("page_url").and_then(Value::as_str) {
        Some(u) => u.to_string(),
        None => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`page_url` is required.",
            );
        }
    };
    let invisible = body.get("invisible").and_then(Value::as_bool);
    let min_score = body.get("min_score").and_then(Value::as_f64);
    if site_key.is_empty()
        || site_key.len() > 1_000
        || page_url.len() > 4_096
        || !(page_url.starts_with("https://") || page_url.starts_with("http://"))
        || min_score.is_some_and(|score| !(0.0..=1.0).contains(&score))
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "CAPTCHA parameters are invalid or exceed their limits.",
        );
    }

    match captcha_native::solve_captcha(captcha_type, &site_key, &page_url, invisible, min_score)
        .await
    {
        Ok(response) => {
            if let Some(task_id) = response.taskId {
                Json(json!({
                    "schema": SCHEMA,
                    "task_id": task_id,
                    "status": "processing",
                }))
                .into_response()
            } else {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "captcha_error",
                    "No task ID returned.",
                )
            }
        }
        Err(error) => api_error(
            StatusCode::PAYMENT_REQUIRED,
            "captcha_error",
            &error.to_string(),
        ),
    }
}

async fn captcha_get_result(Path(task_id): Path<u64>) -> Response {
    match captcha_native::get_captcha_result(task_id).await {
        Ok(response) => {
            let token = captcha_native::extract_token(&response);
            Json(json!({
                "schema": SCHEMA,
                "task_id": task_id,
                "status": response.status,
                "token": token,
                "solution": response.solution,
            }))
            .into_response()
        }
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "captcha_error",
            &error.to_string(),
        ),
    }
}

async fn captcha_wait_for_solution(Json(body): Json<Value>) -> Response {
    let task_id = match body.get("task_id").and_then(Value::as_u64) {
        Some(id) => id,
        None => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`task_id` is required.",
            );
        }
    };
    let timeout = body.get("timeout").and_then(Value::as_u64).unwrap_or(120);
    let poll = body.get("poll").and_then(Value::as_u64).unwrap_or(5);
    if timeout == 0 || timeout > 600 || poll == 0 || poll > 60 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`timeout` must be 1–600 seconds and `poll` must be 1–60 seconds.",
        );
    }

    match captcha_native::wait_for_solution(task_id, timeout, poll).await {
        Ok(response) => {
            let token = captcha_native::extract_token(&response);
            Json(json!({
                "schema": SCHEMA,
                "task_id": task_id,
                "status": "ready",
                "token": token,
                "solution": response.solution,
            }))
            .into_response()
        }
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "captcha_error",
            &error.to_string(),
        ),
    }
}

async fn captcha_direct_solve(Json(body): Json<Value>) -> Response {
    let api_key = captcha_native::resolve_2captcha_key(body.get("api_key").and_then(Value::as_str));
    let Some(api_key) = api_key else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "missing_api_key",
            "No 2Captcha API key provided. Set `api_key` in the request body, the TWOCAPTCHA_API_KEY environment variable, or save it via the /v1/captcha/key endpoint.",
        );
    };

    let captcha_type = match body.get("type").and_then(Value::as_str) {
        Some("hcaptcha") | None => "HCaptchaTaskProxyless",
        Some("recaptcha_v2") => "RecaptchaV2TaskProxyless",
        Some("recaptcha_v3") => "RecaptchaV3TaskProxyless",
        Some("turnstile") => "TurnstileTaskProxyless",
        Some(other) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_type",
                &format!(
                    "Unknown captcha type: {other}. Supported: hcaptcha, recaptcha_v2, recaptcha_v3, turnstile."
                ),
            );
        }
    };

    let site_key = match body.get("site_key").and_then(Value::as_str) {
        Some(k) => k.to_string(),
        None => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "missing_site_key",
                "`site_key` is required.",
            );
        }
    };

    let page_url = match body.get("page_url").and_then(Value::as_str) {
        Some(u) => u.to_string(),
        None => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "missing_page_url",
                "`page_url` is required.",
            );
        }
    };

    let invisible = body.get("invisible").and_then(Value::as_bool);
    let min_score = body.get("min_score").and_then(Value::as_f64);

    if site_key.is_empty()
        || site_key.len() > 1_000
        || page_url.len() > 4_096
        || !(page_url.starts_with("https://") || page_url.starts_with("http://"))
        || min_score.is_some_and(|score| !(0.0..=1.0).contains(&score))
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_params",
            "CAPTCHA parameters are invalid or exceed their limits.",
        );
    }

    match captcha_native::solve_captcha_direct(
        &api_key,
        captcha_type,
        &site_key,
        &page_url,
        invisible,
        min_score,
    )
    .await
    {
        Ok(response) => {
            if let Some(task_id) = response.taskId {
                Json(json!({ "schema": SCHEMA, "task_id": task_id, "status": "processing" }))
                    .into_response()
            } else {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "captcha_error",
                    "No task ID returned.",
                )
            }
        }
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "captcha_error",
            &error.to_string(),
        ),
    }
}

fn valid_external_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

// ── telegram routes ──────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
struct TelegramLogQuery {
    tail: Option<usize>,
}

async fn telegram_get_settings() -> Response {
    match telegram_native::read_settings() {
        Ok(settings) => Json(json!({ "schema": SCHEMA, "settings": settings })).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "telegram_error", &error),
    }
}

async fn telegram_set_token(Json(body): Json<Value>) -> Response {
    let token = match body.get("token").and_then(Value::as_str) {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`token` is required and must not be empty.",
            );
        }
    };
    if token.len() > 200 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`token` must not exceed 200 bytes.",
        );
    }
    match telegram_native::save_bot_token(&token) {
        Ok(masked) => Json(json!({ "schema": SCHEMA, "token": masked })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "telegram_error", &error),
    }
}

async fn telegram_approve_pair(Json(body): Json<Value>) -> Response {
    let code = match body.get("code").and_then(Value::as_str) {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "`code` is required and must not be empty.",
            );
        }
    };
    if code.len() > 6 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "`code` must be 4–6 hex characters.",
        );
    }
    match telegram_native::approve_pair_code(&code) {
        Ok(result) => Json(json!({ "schema": SCHEMA, "result": result })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "telegram_error", &error),
    }
}

async fn telegram_get_log(Query(params): Query<TelegramLogQuery>) -> Response {
    let tail = params.tail.unwrap_or(20).clamp(1, 200);
    let lines = telegram_native::read_bridge_log(tail);
    Json(json!({ "schema": SCHEMA, "lines": lines })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_interface_documents_are_valid_and_versioned() {
        let manifest: Value = serde_json::from_str(INTERFACE_MANIFEST).unwrap();
        let openapi: Value = serde_json::from_str(OPENAPI).unwrap();
        assert_eq!(manifest["schema"], SCHEMA);
        assert_eq!(manifest["apiVersion"], 1);
        assert_eq!(openapi["openapi"], "3.1.0");
        assert!(openapi["paths"]["/v1/agent-mail"].is_object());
        assert!(openapi["paths"]["/v1/agentmail/inboxes"].is_object());
    }

    #[test]
    fn bearer_comparison_rejects_prefixes_and_suffixes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abc", b"abd"));
    }

    #[test]
    fn external_identifiers_do_not_escape_provider_paths() {
        assert!(valid_external_id("thread_123-abc"));
        assert!(!valid_external_id(""));
        assert!(!valid_external_id("../thread"));
        assert!(!valid_external_id("thread/attachment"));
    }
}
