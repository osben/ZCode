//! Fork: the subagent runs a parent `Live` reads for its telemetry facts (specs/fork-rust-agent-parity.md, "Child
//! runs"). Node's child runtimes push their events into the parent's sink; the Rust parent reads each child run from
//! the agents crate's run feed. This decides which children to watch from the kernel subagent table, reads every run
//! once (a replay and a live stream of the same run never both count), and turns each run into the child's facts.
//!
//! The owner is the parent `Live` (one per open session), which keeps the watch tasks; this keeps the per-child state
//! for the lifetime of that `Live`, so a resumed or woken run continues the same child's numbering.

use std::collections::HashMap;

use rust_cli_kernel_api::agents::ChildLive;
use rust_cli_kernel_api::ids::TurnId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::session_api::KernelEvent;
use serde_json::Value;

use crate::telemetry::{Observed, Provider, Role, Telemetry, uuid_v7};

/// Which watches to open after a table read. A watch is never closed from the table: when its entry settles, the
/// run may already sit in the watch's feed unread (the mirror publishes `Finished` before the table settles), so a
/// watch only ends after its run's `Finished` or when its feed ends.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Plan {
    /// Children to watch, with whether the entry looked alive (running or parked). A watch opened for an entry that
    /// was not alive only reads a finished run the feed kept, and ends when there is none.
    pub open: Vec<(String, bool)>,
}

#[derive(Debug)]
struct Watch {
    id: u64,
    /// The run the feed replays was already read: its items are skipped until its `Finished`.
    skipping: bool,
}

#[derive(Debug)]
struct Reading {
    run: u64,
    turn: TurnId,
    scope: String,
    provider: Provider,
    seq: u64,
    /// The run continues on a new watch (the previous one fell behind): of its replay, only the committed messages
    /// past the ones already read are new.
    skip_replay: bool,
    /// The run's committed messages read so far. The replay lists every committed message of the run in order.
    committed: usize,
    /// The committed messages of the current replay passed so far, while `skip_replay`.
    replayed: usize,
}

struct Child {
    telemetry: Telemetry,
    /// The highest run number whose `Started` was read.
    last_run: u64,
    reading: Option<Reading>,
    watch: Option<Watch>,
}

impl Child {
    fn new(session: &str) -> Self {
        Self {
            telemetry: Telemetry::new(session, Role::Child),
            last_run: 0,
            reading: None,
            watch: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct ChildRuns {
    children: HashMap<String, Child>,
    /// Each agent's table state at the last read: status and parked.
    table: HashMap<String, (SubagentStatus, bool)>,
    /// The first table read is done: entries settled before this `Live` opened are only recorded.
    primed: bool,
    watches: u64,
}

/// What one feed item did.
#[derive(Debug, Default)]
pub(crate) struct Read {
    pub facts: Vec<Value>,
    /// The watch closed with a run still being read (the feed fell behind): open a new one.
    pub reopen: bool,
}

impl ChildRuns {
    /// Opens a watch on `child` unless one is open; returns its ID.
    pub fn open(&mut self, child: &str) -> Option<u64> {
        let record = self
            .children
            .entry(child.to_owned())
            .or_insert_with(|| Child::new(child));
        if record.watch.is_some() {
            return None;
        }
        self.watches += 1;
        record.watch = Some(Watch {
            id: self.watches,
            skipping: false,
        });
        Some(self.watches)
    }

    /// The watch `id` on `child` could not start (no feed).
    pub fn closed(&mut self, child: &str, id: u64) {
        if let Some(record) = self.children.get_mut(child)
            && record.watch.as_ref().is_some_and(|watch| watch.id == id)
        {
            record.watch = None;
        }
    }

    /// The watch on `child` is open.
    #[cfg(test)]
    pub fn watching(&self, child: &str) -> bool {
        self.children
            .get(child)
            .is_some_and(|record| record.watch.is_some())
    }

    /// One item of watch `id`'s feed; `None` when the feed ended. `replayed` marks the feed's replay part. `resolve`
    /// names a run's model for its request facts.
    pub fn item(
        &mut self,
        child: &str,
        id: u64,
        replayed: bool,
        item: Option<ChildLive>,
        now: u64,
        resolve: &dyn Fn(&ModelSelection) -> Provider,
    ) -> Read {
        let mut read = Read::default();
        let Some(record) = self.children.get_mut(child) else {
            return read;
        };
        let Some(watch) = record.watch.as_mut().filter(|watch| watch.id == id) else {
            // A closed watch's items: the current watch reads that run.
            return read;
        };
        let event = match item {
            None => {
                record.watch = None;
                read.reopen = record.reading.is_some();
                return read;
            }
            Some(ChildLive::Started { run, selection }) => {
                if run <= record.last_run {
                    match &mut record.reading {
                        Some(reading) if reading.run == run => {
                            reading.skip_replay = replayed;
                            reading.replayed = 0;
                        }
                        _ => watch.skipping = true,
                    }
                    return read;
                }
                record.last_run = run;
                watch.skipping = false;
                let turn = TurnId::new(format!("turn_{}", uuid_v7(now)));
                record.reading = Some(Reading {
                    run,
                    scope: format!("{}-", turn.as_str()),
                    turn: turn.clone(),
                    provider: resolve(&selection),
                    seq: 0,
                    skip_replay: false,
                    committed: 0,
                    replayed: 0,
                });
                KernelEvent::TurnStarted {
                    turn,
                    command: None,
                }
            }
            Some(item) => {
                let skipping = watch.skipping;
                if matches!(item, ChildLive::Finished(_)) {
                    // The watch ends after its run's `Finished`.
                    record.watch = None;
                }
                let Some(reading) = record.reading.as_mut() else {
                    return read;
                };
                if skipping {
                    return read;
                }
                if replayed && reading.skip_replay {
                    // A watch that fell behind: the items it lost are gone from the stream, but the replay still
                    // lists the run's committed messages; the ones past those already read are new. The in-progress
                    // events of the replay (merged deltas, tools) cannot be told apart from the ones read: skipped. A
                    // replayed `Finished` (the run ended before the new watch subscribed) is never one already read:
                    // after a run's `Finished` the same run is skipped whole.
                    match item {
                        ChildLive::Committed(_) => {
                            reading.replayed += 1;
                            if reading.replayed <= reading.committed {
                                return read;
                            }
                        }
                        ChildLive::Finished(_) => {}
                        ChildLive::Event(_) | ChildLive::Started { .. } => return read,
                    }
                }
                if matches!(item, ChildLive::Committed(_)) {
                    reading.committed += 1;
                }
                let turn = reading.turn.clone();
                match item {
                    ChildLive::Event(event) => event.into_kernel_event(turn),
                    ChildLive::Committed(message) => KernelEvent::MessageDone { message },
                    ChildLive::Finished(outcome) => KernelEvent::TurnFinished {
                        turn,
                        outcome,
                        usage: None,
                    },
                    ChildLive::Started { .. } => return read,
                }
            }
        };
        let finished = matches!(event, KernelEvent::TurnFinished { .. });
        let Some(reading) = record.reading.as_mut() else {
            return read;
        };
        reading.seq += 1;
        read.facts = record.telemetry.observe(
            &event,
            &Observed {
                scope: &reading.scope,
                seq: reading.seq,
                now,
                provider: &reading.provider,
                automation: None,
            },
        );
        if finished {
            record.reading = None;
        }
        read
    }

    /// The table read when the parent `Live` opens: settled entries are only recorded, alive ones are watched. Once
    /// per `Live`; a no-op when a change already made the first read.
    pub fn prime(&mut self, entries: &[SubagentEntry]) -> Plan {
        let mut plan = Plan::default();
        if std::mem::replace(&mut self.primed, true) {
            return plan;
        }
        for entry in entries {
            let alive = entry.status == SubagentStatus::Running || entry.parked;
            self.table.insert(
                entry.agent.as_str().to_owned(),
                (entry.status, entry.parked),
            );
            if alive {
                plan.open.push((entry.child.as_str().to_owned(), true));
            }
        }
        plan
    }

    /// A read of the kernel subagent table: the watches to open. Under `node_desktop` subagents launch no subagents
    /// (specs/fork-rust-agent-parity.md, "Subagents launch no subagents"), so no entry has an owner to report.
    pub fn table(&mut self, entries: &[SubagentEntry]) -> Plan {
        let mut plan = Plan::default();
        let primed = std::mem::replace(&mut self.primed, true);
        for entry in entries {
            let child = entry.child.as_str();
            let alive = entry.status == SubagentStatus::Running || entry.parked;
            let state = (entry.status, entry.parked);
            let changed = self.table.insert(entry.agent.as_str().to_owned(), state) != Some(state);
            let record = self
                .children
                .entry(child.to_owned())
                .or_insert_with(|| Child::new(child));
            if record.watch.is_none() && (alive || (changed && primed)) {
                plan.open.push((child.to_owned(), alive));
            }
        }
        plan
    }
}

#[cfg(test)]
#[path = "child_runs_tests.rs"]
mod tests;
