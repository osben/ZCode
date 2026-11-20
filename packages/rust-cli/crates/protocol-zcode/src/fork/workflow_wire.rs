//! Fork: the NDJSON wire of the sandbox child (specs/fork-rust-workflow-engine.md, 4.1). The shapes live in
//! `rust_cli_kernel_api::workflow_child` since W7-5, so the run service in `runtime` can read them without this crate.
//! This module re-exports them for the transport and its tests.

pub use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildMessage, ChildRequest, Completion, CreateActor, WireError, response_line,
};
