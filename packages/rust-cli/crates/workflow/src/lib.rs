//! The dynamic workflow engine core in Rust (W5a of specs/fork-rust-workflow-engine.md, section 9.2).
//!
//! Deterministic state machine: identity, input hashing, run lifecycle, settlement and usage. It
//! reads no clock and draws no random numbers; its only I/O is the journal port. Nothing here is
//! wired into a session yet (the gate stays off until W9).

pub mod canon;
pub mod engine;
pub mod error;
pub mod event;
pub mod journal;
pub mod journal_dwf;
pub mod model;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod lifecycle_golden_tests;
