//! The dynamic workflow engine core in Rust (W5a and W5b of specs/fork-rust-workflow-engine.md, sections 9.3 and 9.5).
//!
//! Deterministic state machine: identity, input hashing, run lifecycle, the ask scheduler, world nodes, replay,
//! settlement, and the amend-resume import cache. It reads no clock and draws no random numbers; its only I/O is
//! the journal port and the driver port. Nothing here is wired into a session yet (the gate stays off until W9).

pub mod canon;
pub mod engine;
pub mod engine_world;
pub mod error;
pub mod event;
pub mod identity;
pub mod import_build;
pub mod imported_cache;
pub mod journal;
pub mod journal_dwf;
pub mod model;
pub mod persona;
pub mod replay;
pub mod resume;
pub mod scheduler;
pub mod scheduler_submit;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod import_golden_tests;
#[cfg(test)]
mod lifecycle_golden_tests;
#[cfg(test)]
mod scheduler_golden_tests;
