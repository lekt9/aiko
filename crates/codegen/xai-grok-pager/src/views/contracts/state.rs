//! Contracts view state — `ContractsState` and `ContractEntry`.
//!
//! Mirrors the shape of `list_scheduled_contracts()` JSON output:
//! `[{id, status, prompt}, ...]`.

use ratatui::layout::Rect;
use xai_grok_shell::collective_host::CollectiveStatus;

/// A single contract task entry from the ledger.
#[derive(Debug, Clone)]
pub struct ContractEntry {
    /// Contract row id (8 hex chars from `contract_declare_turn`).
    pub id: String,
    /// Status string from the ledger: "active", "satisfied", "failed", …
    pub status: String,
    /// The task prompt / goal text.
    pub prompt: String,
}

impl ContractEntry {
    /// Parse a `list_scheduled_contracts()` JSON value into a flat vec.
    pub fn from_scheduled_json(json: &serde_json::Value) -> Vec<Self> {
        let Some(items) = json.as_array() else {
            return Vec::new();
        };
        items
            .iter()
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?.to_string();
                let status = item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let prompt = item
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(ContractEntry { id, status, prompt })
            })
            .collect()
    }

    /// Whether the status is a terminal "done" state.
    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "satisfied" | "failed" | "cancelled")
    }

    /// Whether the task is actively running.
    pub fn is_active(&self) -> bool {
        matches!(self.status.as_str(), "active" | "pending")
    }
}

/// In-memory state for the contracts view.
#[derive(Debug, Clone)]
pub struct ContractsState {
    /// All contract entries (fetched once on open; refreshable).
    pub entries: Vec<ContractEntry>,
    /// Currently selected index into [`Self::entries`].
    pub selected: usize,
    /// Scroll offset (first visible row index).
    pub scroll: usize,
    /// Mouse-hovered entry index, if any.
    pub hovered_row: Option<usize>,
    /// Last frame's screen area (for mouse hit-testing).
    pub last_area: Rect,
    /// Row rects from the last render pass (index → Rect).
    pub row_rects: Vec<Rect>,
    /// Whether entries are currently being fetched.
    pub loading: bool,
    /// Error message to display if the fetch failed.
    pub error: Option<String>,
    /// Toast message (shown for a few seconds, then cleared).
    pub toast: Option<String>,
    /// Whether the inspect detail view is showing for the selected entry.
    pub inspect_detail: Option<String>,
    /// Local Collective status. This is product state only; Contract remains
    /// the authority for every object and publication verdict.
    pub collective: CollectiveStatus,
    /// Exact sanitized candidates awaiting an explicit local decision.
    pub collective_review_ids: Vec<String>,
}

impl ContractsState {
    /// Create an empty state (entries fetch in a background effect).
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            selected: 0,
            scroll: 0,
            hovered_row: None,
            last_area: Rect::default(),
            row_rects: Vec::new(),
            loading: true,
            error: None,
            toast: None,
            inspect_detail: None,
            collective: xai_grok_shell::collective_host::collective_status(),
            collective_review_ids: Vec::new(),
        }
    }

    pub fn refresh_collective(&mut self) {
        self.collective = xai_grok_shell::collective_host::collective_status();
        self.collective_review_ids = xai_grok_shell::collective_host::collective_review_queue()
            .map(|items| items.into_iter().map(|item| item.object_id).collect())
            .unwrap_or_default();
    }

    pub fn toggle_collective_participation(&mut self) {
        match xai_grok_shell::collective_host::set_collective_participation(
            !self.collective.participation_enabled,
        ) {
            Ok(status) => self.collective = status,
            Err(error) => self.set_toast(error),
        }
    }

    pub fn cycle_collective_publication_mode(&mut self) {
        match xai_grok_shell::collective_host::cycle_collective_publication_mode() {
            Ok(status) => self.collective = status,
            Err(error) => self.set_toast(error),
        }
    }

    pub fn toggle_collective_evidence_sharing(&mut self) {
        match xai_grok_shell::collective_host::set_collective_evidence_sharing(
            !self.collective.publish_aggregate_attestations,
        ) {
            Ok(status) => self.collective = status,
            Err(error) => self.set_toast(error),
        }
    }

    pub fn approve_oldest_collective_review(&mut self) {
        let Some(object_id) = self.collective_review_ids.first().cloned() else {
            self.set_toast("No Collective candidates await review".into());
            return;
        };
        match xai_grok_shell::collective_host::approve_collective_review(&object_id) {
            Ok(_) => {
                self.set_toast("Collective shape approved".into());
                self.refresh_collective();
            }
            Err(error) => self.set_toast(error),
        }
    }

    pub fn reject_oldest_collective_review(&mut self) {
        let Some(object_id) = self.collective_review_ids.first().cloned() else {
            self.set_toast("No Collective candidates await review".into());
            return;
        };
        match xai_grok_shell::collective_host::reject_collective_review(&object_id) {
            Ok(()) => {
                self.set_toast("Collective shape kept private".into());
                self.refresh_collective();
            }
            Err(error) => self.set_toast(error),
        }
    }

    /// Set entries from a JSON value, clearing loading/error.
    pub fn set_entries(&mut self, json: &serde_json::Value) {
        let tasks = json.get("tasks").unwrap_or(json);
        self.entries = ContractEntry::from_scheduled_json(tasks);
        self.refresh_collective();
        self.loading = false;
        self.error = None;
        // Clamp selection if entries shrank.
        if !self.entries.is_empty() && self.selected >= self.entries.len() {
            self.selected = self.entries.len().saturating_sub(1);
        }
        if self.entries.is_empty() {
            self.selected = 0;
        }
    }

    /// Mark as loading.
    pub fn set_loading(&mut self) {
        self.loading = true;
        self.error = None;
    }

    /// Mark as errored.
    pub fn set_error(&mut self, msg: String) {
        self.loading = false;
        self.error = Some(msg);
    }

    /// Show a temporary toast.
    pub fn set_toast(&mut self, msg: String) {
        self.toast = Some(msg);
    }

    /// Clear the toast.
    pub fn clear_toast(&mut self) {
        self.toast = None;
        self.inspect_detail = None;
    }

    /// Move selection down; returns true if changed.
    pub fn select_next(&mut self) -> bool {
        if self.entries.is_empty() {
            return false;
        }
        let prev = self.selected;
        self.selected = (self.selected + 1).min(self.entries.len() - 1);
        if self.selected != prev {
            // Auto-scroll: keep selected in the visible range.
            if self.selected >= self.scroll + self.visible_rows() {
                self.scroll = self
                    .selected
                    .saturating_sub(self.visible_rows().saturating_sub(1));
            }
        }
        self.selected != prev
    }

    /// Move selection up; returns true if changed.
    pub fn select_prev(&mut self) -> bool {
        if self.entries.is_empty() {
            return false;
        }
        let prev = self.selected;
        self.selected = self.selected.saturating_sub(1);
        if self.selected != prev {
            if self.selected < self.scroll {
                self.scroll = self.selected;
            }
        }
        self.selected != prev
    }

    /// Jump to first entry.
    pub fn select_first(&mut self) -> bool {
        if self.entries.is_empty() || self.selected == 0 {
            return false;
        }
        self.selected = 0;
        self.scroll = 0;
        true
    }

    /// Jump to last entry.
    pub fn select_last(&mut self) -> bool {
        if self.entries.is_empty() || self.selected == self.entries.len() - 1 {
            return false;
        }
        self.selected = self.entries.len() - 1;
        self.scroll = self
            .selected
            .saturating_sub(self.visible_rows().saturating_sub(1));
        true
    }

    /// How many rows fit in the list area (excluding header/footer).
    fn visible_rows(&self) -> usize {
        let h = self.last_area.height.saturating_sub(4); // header + footer
        h.max(1) as usize
    }
}
