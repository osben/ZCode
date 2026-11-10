//! Fork: protocol surface ported from the Node agent so the desktop UI behaves the same on
//! `zcode-rs` (specs/fork-rust-agent-parity.md). Each method family or command group lives in its
//! own module and is registered with one line in [`commands`] or [`methods`].

mod background_work;
pub(crate) mod commands;
mod file_summary;
pub(crate) mod methods;
mod queue;
pub(crate) use queue::settle_running_turn;
mod row_commands;
mod session_config;
mod session_delete;
mod session_tree;
mod skills;
mod subagents;
mod usage;
