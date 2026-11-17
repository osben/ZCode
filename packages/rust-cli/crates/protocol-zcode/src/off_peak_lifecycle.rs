//! Fork: the off-peak run's lifecycle (Node `core/src/runtime/off-peak/lifecycle.ts`; specs/fork-rust-automations.md,
//! slice 3). A pure state machine: it owns the run's state, the ticket's renewal and the completion rule. It does not
//! schedule model calls or tools. The model binding (waiting for a ticket, retrying on the expired code) is a separate
//! owner that calls into this machine; the events it returns are what `v4/offPeak/lifecycle` reports.

use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    RunningIdle,
    WaitingBackground,
    WaitingTicket,
    Completed,
    Cancelled,
}

impl State {
    /// The protocol name (`offPeakLifecycleStateSchema`).
    pub fn wire(self) -> &'static str {
        match self {
            Self::RunningIdle => "running_idle",
            Self::WaitingBackground => "waiting_background",
            Self::WaitingTicket => "waiting_ticket",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed,
    Stopped,
}

impl Outcome {
    /// The protocol name (`offPeakOutcomeSchema`).
    pub fn wire(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

/// The facts the runtime reports about its work (Node `OffPeakWorkSnapshot`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorkSnapshot {
    pub main_running: bool,
    pub background_running: bool,
    pub pending_notifications: bool,
    pub pending_inputs: bool,
}

/// A lifecycle effect (Node `OffPeakLifecycleEvent` without the identity, which the sink adds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    StateChanged(State),
    TicketNeeded {
        renewal_id: u64,
        expired_ticket_id: String,
    },
    TicketReleased {
        ticket_id: String,
    },
    Completed {
        outcome: Outcome,
    },
}

#[derive(Debug)]
pub struct OffPeakLifecycle {
    phase: State,
    ticket_id: Option<String>,
    ticket_available: bool,
    renewal_sequence: u64,
    pending_renewal: Option<u64>,
    applied_renewal: Option<(u64, String)>,
    idle_model_rounds: u32,
    outcome: Outcome,
    released_tickets: HashSet<String>,
    events: Vec<Event>,
}

impl OffPeakLifecycle {
    pub fn new(ticket_id: impl Into<String>) -> Self {
        Self {
            phase: State::RunningIdle,
            ticket_id: Some(ticket_id.into()),
            ticket_available: true,
            renewal_sequence: 0,
            pending_renewal: None,
            applied_renewal: None,
            idle_model_rounds: 0,
            outcome: Outcome::Succeeded,
            released_tickets: HashSet::new(),
            events: Vec::new(),
        }
    }

    pub fn state(&self) -> State {
        self.phase
    }

    pub fn terminal(&self) -> bool {
        matches!(self.phase, State::Completed | State::Cancelled)
    }

    pub fn ticket_id(&self) -> Option<&str> {
        self.ticket_id.as_deref()
    }

    /// Whether a model round may use the ticket now (Node `waitForTicket` without waiting).
    pub fn ticket_ready(&self) -> bool {
        self.ticket_available && self.pending_renewal.is_none() && self.ticket_id.is_some()
    }

    /// Node `retainIdleModelRound`: a model round of the run keeps it open. False once it is terminal or user-owned.
    pub fn retain_idle_model_round(&mut self) -> bool {
        if self.terminal() {
            return false;
        }
        self.idle_model_rounds += 1;
        true
    }

    /// The counterpart of [`Self::retain_idle_model_round`]: releases the round and any ticket nobody needs.
    pub fn release_idle_model_round(&mut self, work: WorkSnapshot) {
        self.idle_model_rounds = self.idle_model_rounds.saturating_sub(1);
        self.release_unused_ticket();
        self.work_changed(work);
    }

    /// Node `mainEnded`: the main turn finished with `outcome`; the run completes once no work is left.
    pub fn main_ended(&mut self, outcome: Outcome) {
        if self.terminal() {
            return;
        }
        self.outcome = outcome;
    }

    /// Node `workChanged`: recomputes the state from the runtime's facts, completing the run when nothing is left.
    pub fn work_changed(&mut self, work: WorkSnapshot) {
        if self.terminal() {
            return;
        }
        if !work.main_running
            && !work.background_running
            && !work.pending_notifications
            && !work.pending_inputs
            && self.pending_renewal.is_none()
            && self.idle_model_rounds == 0
        {
            self.change_state(State::Completed);
            self.release_unused_ticket();
            self.events.push(Event::Completed {
                outcome: self.outcome,
            });
            return;
        }
        let next = if self.pending_renewal.is_some() {
            State::WaitingTicket
        } else if work.main_running {
            State::RunningIdle
        } else {
            State::WaitingBackground
        };
        self.change_state(next);
    }

    /// Node `ticketExpired`: the ticket was refused as expired. Returns the renewal id the Host must answer with, once.
    pub fn ticket_expired(&mut self, ticket_id: &str) -> Option<u64> {
        if self.terminal() || self.ticket_id.as_deref() != Some(ticket_id) {
            return None;
        }
        if let Some(renewal) = self.pending_renewal {
            return Some(renewal);
        }
        self.renewal_sequence += 1;
        let renewal = self.renewal_sequence;
        self.pending_renewal = Some(renewal);
        self.ticket_available = false;
        self.change_state(State::WaitingTicket);
        self.events.push(Event::TicketNeeded {
            renewal_id: renewal,
            expired_ticket_id: ticket_id.to_owned(),
        });
        Some(renewal)
    }

    /// Node `replaceTicket`: installs the Host's renewal. A repeat of the applied answer is accepted with no effect. `work`
    /// is the runtime's current facts (Node `readWork`): the run is judged by them, not by an assumed running turn, so a
    /// renewal answered after the turn ended completes the run.
    pub fn replace_ticket(&mut self, renewal_id: u64, ticket_id: &str, work: WorkSnapshot) -> bool {
        if let Some((applied, id)) = &self.applied_renewal
            && *applied == renewal_id
            && id == ticket_id
        {
            return true;
        }
        if self.terminal()
            || self.pending_renewal != Some(renewal_id)
            || self.ticket_id.as_deref() == Some(ticket_id)
        {
            return false;
        }
        self.applied_renewal = Some((renewal_id, ticket_id.to_owned()));
        let previous = self.ticket_id.replace(ticket_id.to_owned());
        self.ticket_available = true;
        self.pending_renewal = None;
        if let Some(old) = previous {
            self.release_ticket(old);
        }
        self.work_changed(work);
        true
    }

    /// Node `cancel`: stops the run for good. Repeated calls have no effect.
    pub fn cancel(&mut self) {
        if self.terminal() {
            return;
        }
        self.pending_renewal = None;
        // A cancelled run holds no model round: a round still waiting for its ticket ends with the run.
        self.idle_model_rounds = 0;
        self.change_state(State::Cancelled);
        self.release_unused_ticket();
        self.events.push(Event::Completed {
            outcome: Outcome::Stopped,
        });
    }

    /// The effects since the last call, in order.
    pub fn drain_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    fn change_state(&mut self, state: State) {
        if state == self.phase {
            return;
        }
        self.phase = state;
        self.events.push(Event::StateChanged(state));
    }

    fn release_unused_ticket(&mut self) {
        if !self.terminal() || self.idle_model_rounds > 0 {
            return;
        }
        if let Some(ticket) = self.ticket_id.take() {
            self.release_ticket(ticket);
        }
    }

    fn release_ticket(&mut self, ticket_id: String) {
        if self.released_tickets.insert(ticket_id.clone()) {
            self.events.push(Event::TicketReleased { ticket_id });
        }
    }
}

#[cfg(test)]
#[path = "off_peak_lifecycle_tests.rs"]
mod tests;
