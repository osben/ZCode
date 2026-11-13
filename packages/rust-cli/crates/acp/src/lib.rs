//! External ACP agents (opencode, Cursor, …) as the model of a session (specs/fork-rust-agent-parity.md "ACP
//! external agents"; Node `packages/acp-agent-runtime` and the worker's `acp-agent/`).
//!
//! This crate owns the agent process and the ACP protocol: launch rules, the JSON-RPC connection, the session
//! handshake and resume, prompts, cancellation, permission asks and configuration options. The turn mapping onto
//! the session (rows, todos, title) lives in the runtime crate.

pub mod config;
pub mod error;
pub mod launch;
mod rpc;
pub mod runtime;
pub mod updates;

pub use config::{ConfigOption, ConfigValue};
pub use error::{AcpError, AcpErrorCode};
pub use launch::{AcpLaunch, launch_key};
pub use runtime::{
    AcpRuntime, AcpRuntimeOptions, AcpState, AcpTimeouts, PromptResponse, SessionStart,
};
pub use updates::{PermissionAnswer, PermissionAsk, PlanEntry, RuntimeEvent, ToolCallInfo};
