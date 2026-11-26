//! Fork: protocol surface ported from the Node agent so the desktop UI behaves the same on
//! `zcode-rs` (specs/fork-rust-agent-parity.md). Each method family or command group lives in its
//! own module and is registered with one line in [`commands`] or [`methods`].

pub(crate) mod activity_summary;
mod background_task;
mod background_work;
pub(crate) mod browser_turn_screenshot;
mod child_processes;
pub(crate) mod commands;
pub(crate) mod external_agent_config;
mod file_summary;
pub(crate) mod slash_builtins;
/// Fork (W9a, 9.53): the v4 run controls `startSavedWorkflow` and `amendWorkflowRunSettings`.
pub(crate) mod workflow_run_commands;
// Fork: specs/fork-rust-node-helper.md F3, "Helper → Rust requests".
pub(crate) mod helper_answers;
mod helper_elicitation;
mod helper_sampling;
mod helper_session_admit;
pub(crate) mod hook_review;
pub(crate) mod legacy_session;
mod lsp;
// Fork: specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 1: the lease registry.
mod mcp_ui_lease;
// Fork (F7 PR 1): the Rust owner of the panels of Rust-run servers (routing, calls, resource reads).
pub(crate) mod mcp_ui_rust;
// Fork (F7 PR 2): the sampling ledger of the panels of Rust-run servers (Node `samplingCalls.ts`).
pub(crate) mod mcp_ui_sampling;
// Fork (F7 PR 3): the app-provided tools of the panels of Rust-run servers, and the router that composes them with the
// Node helper's set (Node `appTools.ts`, `appToolsProtocol.ts`).
pub(crate) mod mcp_ui_app_tools;
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
pub(crate) mod workflow_runs;
mod workspace_model;
pub(crate) use workspace_model::Operations as WorkspaceOperations;
pub(crate) mod workspace_trust;
// Fork: specs/fork-rust-workflow-engine.md, 4.1 (as built in W4): the compile helper, the entry file, the sandbox child
// and its NDJSON host. Exported from the crate root, where the composition root installs the child launcher.
pub mod workflow_child;
pub mod workflow_compile;
pub mod workflow_entry;
pub mod workflow_host;
pub mod workflow_lines;
pub mod workflow_progress;
pub mod workflow_reminder;
pub mod workflow_reminder_host;
pub mod workflow_runner;
// Fork: the snippet runner is built by the composition root with the gate (W7-7); nothing constructs it yet.
#[allow(dead_code)]
pub mod workflow_snippet;
// Fork (W7-11, 9.44): on-demand activation of the workflow tools (Node dynamic-workflow-activation.ts).
pub mod workflow_activation;
pub mod workflow_activity;
#[cfg(test)]
mod workflow_cold_open_tests;
pub mod workflow_wire;
pub use workspace_trust::{
    Admission, ReviewBundle, ReviewItem, ReviewLookup, ReviewSource, StoredTrust, ToggleError,
    WorkspaceAdmin, WorkspaceTarget,
};
