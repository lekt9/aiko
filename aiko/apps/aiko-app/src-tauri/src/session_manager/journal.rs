//! Rewind timeline and journal checkpoints.

use std::sync::Arc;

use tauri::AppHandle;

use crate::acp_client::AcpClient;
use crate::error::AgentErrorCode;
use crate::session_fsm::SessionState;
use crate::store::{self};

use super::*;

impl SessionManager {
    pub async fn rewind_drop_last_user_turn(
        self: &Arc<Self>,
        app: AppHandle,
        session_id: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let (backend, app_sid, acp, agent_sid, user_prompt_count) = {
            let guard = self.inner.lock();
            let s = guard.as_ref().ok_or("no active session")?;
            if let Some(target) = session_id.as_deref() {
                if s.app_session_id != target {
                    return Err(format!(
                        "{}: chat {target} is not focused — reconnect and retry",
                        AgentErrorCode::ConnectFailed.as_str()
                    ));
                }
            }
            if s.fsm.state() == SessionState::Streaming
                || s.fsm.state() == SessionState::AwaitingPermission
            {
                return Err("cannot edit while a turn is running".into());
            }
            let msgs = store::load_messages(&s.app_session_id);
            let user_prompt_count = msgs.iter().filter(|m| m.role == "user").count() as u32;
            if user_prompt_count == 0 {
                return Err("no user message to rewind".into());
            }
            (
                s.backend.clone(),
                s.app_session_id.clone(),
                s.acp.clone(),
                s.meta.agent_session_id.clone(),
                user_prompt_count,
            )
        };

        // Agent: discard last user turn. TUI semantics keep the selected turn and drop after;
        // so for "drop last user" we target the previous turn when count > 1.
        // When count == 1, execute target 0 with best-effort; host journal is the source of truth for UI.
        if backend != "mock_acp" && !AcpClient::use_mock() {
            if let Some(client) = acp {
                let target = user_prompt_count.saturating_sub(1);
                // Prefer rewinding to previous turn (keep 0..n-2, drop n-1..).
                // When only one user turn: try target 0 then clear local journal fully.
                let exec_index = if user_prompt_count <= 1 {
                    0u32
                } else {
                    // Keep through previous user turn → drop last.
                    user_prompt_count - 2
                };
                match client
                    .rewind_execute_for(
                        agent_sid.as_deref().ok_or("chat has no agent session id")?,
                        exec_index,
                        false,
                    )
                    .await
                {
                    Ok(_) => {
                        tracing::info!(
                            target: "session",
                            "rewind_drop_last_user_turn: agent rewound target={exec_index} (user_turns={user_prompt_count})"
                        );
                    }
                    Err(e) => {
                        // Fallback: try targeting the last turn itself (some builds discard at/after index).
                        tracing::warn!(
                            target: "session",
                            error = %e,
                            "rewind_execute({exec_index}) failed; trying last-turn index {target}"
                        );
                        if let Err(e2) = client
                            .rewind_execute_for(
                                agent_sid.as_deref().ok_or("chat has no agent session id")?,
                                target,
                                false,
                            )
                            .await
                        {
                            tracing::warn!(
                                target: "session",
                                error = %e2,
                                "agent rewind failed; local journal still truncated"
                            );
                        }
                    }
                }
            }
        }

        // Local journal: keep messages strictly before the last user message.
        let msgs = store::load_messages(&app_sid);
        let mut cut = msgs.len();
        for (i, m) in msgs.iter().enumerate().rev() {
            if m.role == "user" {
                cut = i;
                break;
            }
        }
        let kept: Vec<_> = msgs.into_iter().take(cut).collect();
        store::save_messages(&app_sid, &kept)?;

        {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                s.meta.updated_at = chrono::Utc::now();
                let _ = store::update_session_meta(&s.meta);
            }
        }
        let snap = self.snapshot();
        Self::emit_state(&app, &snap);
        Ok(snap)
    }

    /// List rewind points for an app session journal (one per user prompt).
    /// Prefer the local journal so the UI timeline always matches what the user sees.
    pub fn list_rewind_points(
        &self,
        session_id: Option<String>,
    ) -> Result<Vec<RewindPointDto>, String> {
        let app_sid = match session_id {
            Some(id) if !id.trim().is_empty() => id,
            _ => {
                let guard = self.inner.lock();
                let s = guard.as_ref().ok_or("no active session")?;
                s.app_session_id.clone()
            }
        };
        // Ensure session exists in the index (or at least has a journal dir).
        let known = store::load_sessions_index().iter().any(|s| s.id == app_sid);
        if !known && store::load_messages(&app_sid).is_empty() {
            return Err(format!("session not found: {app_sid}"));
        }
        Ok(Self::rewind_points_from_journal(&app_sid))
    }

    pub(super) fn rewind_points_from_journal(app_sid: &str) -> Vec<RewindPointDto> {
        let msgs = store::load_messages(app_sid);
        let mut out = Vec::new();
        let mut idx = 0u32;
        for m in msgs {
            if m.role != "user" {
                continue;
            }
            let raw = m.content.split_whitespace().collect::<Vec<_>>().join(" ");
            let preview = if raw.chars().count() > 80 {
                let truncated: String = raw.chars().take(79).collect();
                format!("{truncated}…")
            } else if raw.is_empty() {
                "…".into()
            } else {
                raw
            };
            out.push(RewindPointDto {
                prompt_index: idx,
                message_id: Some(m.id),
                preview,
            });
            idx = idx.saturating_add(1);
        }
        out
    }

    /// Rewind a session to a user-prompt index (keep that turn, drop after).
    /// Always truncates the local journal. Agent `x.ai/rewind/execute` is best-effort
    /// when this session is the live ACP session.
    pub async fn rewind_to_prompt_index(
        self: &Arc<Self>,
        app: AppHandle,
        target_prompt_index: u32,
        restore_files: bool,
        session_id: Option<String>,
    ) -> Result<RewindExecuteResult, String> {
        let app_sid = match session_id {
            Some(id) if !id.trim().is_empty() => id,
            _ => {
                let guard = self.inner.lock();
                let s = guard.as_ref().ok_or("no active session")?;
                s.app_session_id.clone()
            }
        };

        // Block if *this* session is mid-turn on the live host.
        let (live_match, backend, acp, agent_sid, busy) = {
            let guard = self.inner.lock();
            match guard.as_ref() {
                Some(s) if s.app_session_id == app_sid => {
                    let busy = s.fsm.state() == SessionState::Streaming
                        || s.fsm.state() == SessionState::AwaitingPermission;
                    (
                        true,
                        s.backend.clone(),
                        s.acp.clone(),
                        s.meta.agent_session_id.clone(),
                        busy,
                    )
                }
                _ => (false, String::new(), None, None, false),
            }
        };
        if busy {
            return Err("cannot rewind while a turn is running".into());
        }

        let msgs = store::load_messages(&app_sid);
        let user_count = msgs.iter().filter(|m| m.role == "user").count() as u32;
        if user_count == 0 {
            return Err("no user messages to rewind".into());
        }
        if target_prompt_index >= user_count {
            return Err(format!(
                "user prompt index out of range: {target_prompt_index} (have {user_count})"
            ));
        }

        let mut agent_ok = true;
        let mut agent_error: Option<String> = None;

        // Agent path only when this is the live session with a real ACP client.
        if live_match && backend != "mock_acp" && !AcpClient::use_mock() {
            if let Some(client) = acp {
                let sid = agent_sid.ok_or("chat has no agent session id")?;
                match client
                    .rewind_execute_for(&sid, target_prompt_index, restore_files)
                    .await
                {
                    Ok(_) => {
                        tracing::info!(
                            target: "session",
                            "rewind_to_prompt_index: agent rewound target={target_prompt_index}"
                        );
                    }
                    Err(e) => {
                        agent_ok = false;
                        agent_error = Some(e.clone());
                        tracing::warn!(
                            target: "session",
                            error = %e,
                            "agent rewind failed; applying local journal truncate only"
                        );
                    }
                }
            } else {
                agent_ok = false;
                agent_error = Some("agent not connected".into());
            }
        } else if !live_match {
            agent_ok = false;
            agent_error = Some("session not live; local journal only".into());
        }

        let kept = store::truncate_through_user_prompt(&msgs, target_prompt_index)?;
        let kept_count = kept.len();
        store::save_messages(&app_sid, &kept)?;

        // Touch meta updated_at for index sort.
        if let Some(mut meta) = store::load_sessions_index()
            .into_iter()
            .find(|s| s.id == app_sid)
        {
            meta.updated_at = chrono::Utc::now();
            let _ = store::update_session_meta(&meta);
            if live_match {
                let mut guard = self.inner.lock();
                if let Some(s) = guard.as_mut() {
                    if s.app_session_id == app_sid {
                        s.meta.updated_at = meta.updated_at;
                    }
                }
            }
        }

        let snap = self.snapshot();
        Self::emit_state(&app, &snap);
        Ok(RewindExecuteResult {
            snapshot: snap,
            agent_ok,
            agent_error,
            local_ok: true,
            kept_count,
        })
    }
}
