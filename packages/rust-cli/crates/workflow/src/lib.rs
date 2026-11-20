//! The dynamic workflow engine core in Rust (W5a and W5b of specs/fork-rust-workflow-engine.md, sections 9.3 and 9.5).
//!
//! Deterministic state machine: identity, input hashing, run lifecycle, the ask scheduler, world nodes, replay,
//! settlement, and the amend-resume import cache. It reads no clock and draws no random numbers; its only I/O is
//! the journal port and the driver port. Nothing here is wired into a session yet (the gate stays off until W9).

pub mod actor_feed;
pub mod actor_mailbox;
pub mod actor_sessions;
pub mod actor_turns;
pub mod artifact_publish;
pub mod artifact_spec;
pub mod canon;
pub mod driver_owner;
pub mod driver_rules;
pub mod engine;
pub mod engine_artifacts;
pub mod engine_holes;
pub mod engine_report;
pub mod engine_world;
pub mod error;
pub mod escalation;
pub mod event;
pub mod identity;
pub mod import_build;
pub mod imported_cache;
pub mod journal;
pub mod journal_dwf;
pub mod model;
pub mod model_failure;
pub mod parked_answers;
#[cfg(test)]
#[path = "parked_answers_tests.rs"]
mod parked_answers_tests;
pub mod persona;
pub mod quota_resume;
pub mod replay;
pub mod residency;
pub mod resume;
pub mod run_concurrency;
pub mod run_progress;
pub mod run_store;
#[cfg(test)]
#[path = "run_store_tests.rs"]
mod run_store_tests;
pub mod scheduler;
pub mod scheduler_submit;
pub mod stall_clock;
#[cfg(test)]
mod test_clock;
pub mod world_git;
pub mod world_host;
pub mod world_read;

#[cfg(test)]
mod actor_feed_tests;
#[cfg(test)]
mod actor_mailbox_tests;
#[cfg(test)]
mod actor_sessions_tests;
#[cfg(test)]
mod actor_turns_close_tests;
#[cfg(test)]
mod actor_turns_tests;
#[cfg(test)]
mod artifact_review_tests;
#[cfg(test)]
mod driver_close_tests;
#[cfg(test)]
mod driver_feed_tests;
#[cfg(test)]
mod driver_golden_tests;
#[cfg(test)]
mod driver_model_failure_tests;
#[cfg(test)]
mod driver_node_parity_tests;
#[cfg(test)]
mod driver_owner_tests;
#[cfg(test)]
mod driver_stall_quota_tests;
#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod escalation_tests;
#[cfg(test)]
mod holes_golden_tests;
#[cfg(test)]
mod import_golden_tests;
#[cfg(test)]
mod lifecycle_golden_tests;
#[cfg(test)]
mod quota_busy_tests;
#[cfg(test)]
mod quota_resume_tests;
#[cfg(test)]
mod residency_tests;
#[cfg(test)]
mod run_concurrency_tests;
#[cfg(test)]
mod scheduler_golden_tests;
#[cfg(test)]
mod stall_clock_tests;
#[cfg(test)]
mod world_read_review_tests;
#[cfg(test)]
mod world_wiring_review_tests;
#[cfg(test)]
mod world_wiring_tests;
