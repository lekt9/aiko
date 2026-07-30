//! Contracts view — shows active/completed/failed contract tasks from the
//! Contract ledger (`libcontract.dylib`).
//!
//! Data is fetched via `xai_grok_shell::contract_native::list_scheduled_contracts()`
//! which returns a JSON array of `{id, status, prompt}`. The view renders these
//! as a scrollable, selectable list with status icons and an optional inspect
//! detail popup.
//!
//! ## Module layout
//!
//! - [`state`] — `ContractsState`, `ContractEntry`.
//! - [`layout`] — pure rect computation.
//! - [`render`] — `render_contracts()` drawing routine.

pub mod layout;
pub mod render;
pub mod state;

pub use render::render_contracts;
pub use state::{ContractEntry, ContractsState};
