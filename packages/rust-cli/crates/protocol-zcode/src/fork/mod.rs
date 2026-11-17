//! Fork: protocol surface ported from the Node agent so the desktop UI behaves the same on
//! `zcode-rs` (specs/fork-rust-agent-parity.md). Each method family or command group lives in its
//! own module and is registered with one line in [`commands`] or [`methods`].

mod background_task;
mod background_work;
pub(crate) mod browser_turn_screenshot;
mod child_processes;
pub(crate) mod commands;
pub(crate) mod external_agent_config;
mod file_summary;
// Fork: specs/fork-rust-node-helper.md F3, "Helper → Rust requests".
mod helper_answers;
mod helper_sampling;
mod helper_session_admit;
pub(crate) mod hook_review;
pub(crate) mod legacy_session;
mod lsp;
pub(crate) mod methods;
pub mod node_helper;
mod queue;
mod release_under_directory;
pub(crate) use queue::settle_running_turn;
pub(crate) mod in_flight;
mod row_commands;
mod session_config;
pub(crate) mod session_data;
mod session_data_files;
mod session_data_size;
mod session_delete;
pub(crate) mod session_deletion;
#[cfg(test)]
#[path = "session_store_integration_tests.rs"]
mod session_store_integration_tests;
pub(crate) mod session_tree;
mod skills;
mod subagents;
mod usage;
mod workspace_model;
pub(crate) use workspace_model::Operations as WorkspaceOperations;
pub(crate) mod workspace_trust;
pub use workspace_trust::{
    Admission, ReviewBundle, ReviewItem, ReviewLookup, ReviewSource, StoredTrust, ToggleError,
    WorkspaceAdmin, WorkspaceTarget,
};
