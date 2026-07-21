//! Dispatch handlers for the Contracts view.
//!
//! These handlers manage view open/close and data refresh via the contract FFI.

use crate::app::actions::Effect;
use crate::app::app_view::{ActiveView, AppView};

/// Open the Contracts view. Toggles: if already open, closes it.
pub(super) fn dispatch_open_contracts(app: &mut AppView) -> Vec<Effect> {
    // Toggle: if already in the contracts view, close it.
    if matches!(app.active_view, ActiveView::Contracts) {
        return dispatch_exit_contracts(app);
    }

    // Initialize state if this is the first open.
    if app.contracts.is_none() {
        app.contracts = Some(crate::views::contracts::ContractsState::new());
    }
    if let Some(state) = app.contracts.as_mut() {
        state.set_loading();
    }

    app.active_view = ActiveView::Contracts;

    // Fire an async effect to fetch contract data.
    vec![Effect::AsyncContractRefresh]
}

/// Close the Contracts view and return to the previous view (Welcome or AgentDashboard).
pub(super) fn dispatch_exit_contracts(app: &mut AppView) -> Vec<Effect> {
    // Return to Welcome if no agents, else AgentDashboard.
    app.active_view = if app.agents.is_empty() {
        ActiveView::Welcome
    } else {
        ActiveView::AgentDashboard
    };
    // Clear toast/inspect when leaving.
    if let Some(state) = app.contracts.as_mut() {
        state.clear_toast();
    }
    vec![]
}

/// Refresh the contracts list (re-fetch from FFI).
pub(super) fn dispatch_refresh_contracts(app: &mut AppView) -> Vec<Effect> {
    if let Some(state) = app.contracts.as_mut() {
        state.set_loading();
    }
    vec![Effect::AsyncContractRefresh]
}

/// Handle the async contract data load result.
pub(super) fn handle_contracts_loaded(app: &mut AppView, json: &serde_json::Value) -> Vec<Effect> {
    if let Some(state) = app.contracts.as_mut() {
        state.set_entries(json);
    }
    vec![]
}
