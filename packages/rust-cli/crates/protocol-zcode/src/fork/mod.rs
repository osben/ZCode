//! Fork: protocol surface ported from the Node agent so the desktop UI behaves the same on
//! `zcode-rs` (specs/fork-rust-agent-parity.md). Each method family or command group lives in its
//! own module and is registered with one line in [`commands`] or [`methods`].

pub(crate) mod commands;
mod file_summary;
pub(crate) mod methods;
mod queue;
mod row_commands;
mod session_config;
mod session_delete;
mod skills;
