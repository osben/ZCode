//! Fork: the run record of each hook of one dispatch, as Node's `HookRun*` lifecycle events carry them
//! (`core/src/hooks/runner.ts`; specs/fork-rust-agent-parity.md HK-UP-01).

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
