//! Fork: the off-peak runs of the agent and `v4/conversation/offPeakControl` (Node `off-peak/runtime.ts`
//! `controlOffPeakRuntime`; specs/fork-rust-automations.md, slice 3).
//!
//! A session holds at most one active run, keyed by its `executionId`. The lifecycle machine owns the run's state;
//! this module routes the Host's `cancel` and `replace_ticket` to it and shapes each effect as a
//! `v4/offPeak/lifecycle` notification with the run's identity (`sessionId`, `executionId`, `offPeakTaskId`). The
//! run's ticket source ([`crate::off_peak_ticket::RunTickets`]) reads the same state to wait for and renew its ticket.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use rust_cli_base::secret::RedactedString;
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::off_peak_ticket::Ticket;
use rust_cli_kernel_api::provider::SuppliedAuth;
use rust_cli_protocol_core::rpc::RpcError;

use serde_json::{Value, json};
use tokio::sync::Notify;

use rust_cli_kernel_api::session_api::TurnOutcome;

use crate::off_peak_lifecycle::{Event, OffPeakLifecycle, Outcome, State, WorkSnapshot};

/// Node `OFF_PEAK_EXECUTION_TOOL_DENYLIST` aside, a session with an active run refuses a second one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartError {
    AlreadyActive,
}

/// Node's ticket-expired business codes (`isOffPeakTicketExpiredCode`): 3102 missed slot, 3106 run timeout.
pub(crate) fn is_expired_code(code: &str) -> bool {
    matches!(code, "3102" | "3106")
}

/// An admitted off-peak input, before its turn opens the run (`modelExecution.offPeak` and the task it creates).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRun {
    pub session: String,
    pub execution_id: String,
    pub off_peak_task_id: String,
    pub ticket_id: String,
    pub provider_id: String,
    pub provider_error_code: String,
}

/// One run of a session.
struct Run {
    session: String,
    execution_id: String,
    off_peak_task_id: String,
    /// The provider the run is bound to and the code that marks its expired ticket (Node `initial.providerErrorCode`).
    provider_id: String,
    provider_error_code: String,
    lifecycle: OffPeakLifecycle,
    /// The credentials the Host sent with the ticket it installed by `replace_ticket` (None for the start ticket).
    request_auth: Option<SuppliedAuth>,
    /// The turn the run's input started (Node's `ownsTurn`): the turn whose end releases the run's idle round.
    turn: Option<String>,
}

/// The answer to one control request: whether the Host's request matched a run, and the notifications it caused.
#[derive(Debug, PartialEq)]
pub struct Control {
    pub accepted: bool,
    pub notifications: Vec<Value>,
}

/// The state a run's ticket source acts on.
pub(crate) enum Poll {
    /// A usable ticket, with the credentials the Host sent for it (None: the ordinary source supplies them).
    Ready(Ticket),
    /// Not usable yet: a renewal is pending or the ticket is not installed.
    Pending,
    /// The run ended; the Node error code its attempts fail with.
    Ended(&'static str),
}

/// What an expired ticket does to its run (Node `ticketExpired`).
pub(crate) enum Expiry {
    /// The attempt's ticket was already replaced: retry at once on the current one.
    Immediate,
    /// The renewal was asked for; the notifications it caused, to send to the Host.
    Renewing(Vec<Value>),
    /// The run ended; the Node error code.
    Ended(&'static str),
}

/// The runs of this agent, keyed by session id. A finished run stays until a new one replaces it, so a repeated cancel
/// is still answered (Node keeps a terminal controller for idempotent replies).
#[derive(Default)]
pub struct OffPeakRuns {
    runs: Mutex<HashMap<String, Run>>,
    /// Woken on every change of a run, for the attempts waiting for a ticket (Node `waiters`).
    pub(crate) changed: Notify,
    /// Admitted off-peak inputs whose turn has not started, by command id. A run is opened when its turn starts (Node
    /// `prepareOffPeakTurn`), so a refused or dropped input never leaves a run behind.
    pending: Mutex<HashMap<String, PendingRun>>,
    /// The workspace policy (`workspace/updateOffPeakToolPolicy`): the default of a session without its own flag.
    policy: AtomicBool,
    /// `offPeakToolEnabled` of the sessions created or resumed with one (Node records it on the session at create).
    session_flags: Mutex<HashMap<String, bool>>,
}

impl OffPeakRuns {
    /// Starts a run for `session`. A session with an active run refuses another (Node
    /// `off_peak_execution_already_active`); a finished run is replaced.
    pub fn start(
        &self,
        session: &str,
        execution_id: &str,
        off_peak_task_id: &str,
        ticket_id: &str,
        provider_id: &str,
        provider_error_code: &str,
    ) -> Result<(), StartError> {
        let mut runs = self.lock();
        if let Some(run) = runs.get(session)
            && !run.lifecycle.terminal()
            && run.execution_id != execution_id
        {
            return Err(StartError::AlreadyActive);
        }
        runs.insert(
            session.to_owned(),
            Run {
                session: session.to_owned(),
                execution_id: execution_id.to_owned(),
                off_peak_task_id: off_peak_task_id.to_owned(),
                provider_id: provider_id.to_owned(),
                provider_error_code: provider_error_code.to_owned(),
                lifecycle: OffPeakLifecycle::new(ticket_id),
                request_auth: None,
                turn: None,
            },
        );
        // The admitted input keeps the run open until its turn ends (Node: pending inputs count as work).
        if let Some(run) = runs.get_mut(session) {
            run.lifecycle.retain_idle_model_round();
        }
        self.changed.notify_waiters();
        Ok(())
    }

    /// Node `controlOffPeakRuntime`: answers a control request for `session`. A request that matches no run answers
    /// `accepted: false`.
    pub fn control(&self, session: &str, params: &Value) -> Control {
        let mut runs = self.lock();
        let Some(run) = runs.get_mut(session) else {
            return Control {
                accepted: false,
                notifications: Vec::new(),
            };
        };
        if params["sessionId"].as_str() != Some(session)
            || params["executionId"].as_str() != Some(run.execution_id.as_str())
        {
            return Control {
                accepted: false,
                notifications: Vec::new(),
            };
        }
        let control = match params["action"].as_str() {
            Some("cancel") => {
                run.lifecycle.cancel();
                Control {
                    accepted: true,
                    notifications: notifications(run),
                }
            }
            Some("replace_ticket") => {
                let renewal = params["renewalId"].as_u64();
                let ticket = params["ticketId"].as_str();
                let accepted = match (renewal, ticket) {
                    (Some(renewal), Some(ticket)) => run.lifecycle.replace_ticket(renewal, ticket),
                    _ => false,
                };
                if accepted {
                    run.request_auth = params["requestAuth"]
                        .is_object()
                        .then(|| supplied_auth(&params["requestAuth"]));
                }
                Control {
                    accepted,
                    notifications: notifications(run),
                }
            }
            _ => Control {
                accepted: false,
                notifications: Vec::new(),
            },
        };
        self.changed.notify_waiters();
        control
    }

    /// Admits an off-peak input: its run opens when its turn starts. A session with an open run refuses it (Node
    /// `off_peak_execution_already_active`).
    pub fn admit(&self, session: &str, command: &str, run: PendingRun) -> Result<(), StartError> {
        if self
            .lock()
            .get(session)
            .is_some_and(|open| !open.lifecycle.terminal())
        {
            return Err(StartError::AlreadyActive);
        }
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(command.to_owned(), run);
        Ok(())
    }

    /// The provider an admitted off-peak input's run binds to, after its model was edited while queued.
    pub fn set_pending_provider(&self, command: &str, provider: &str) {
        if let Some(pending) = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(command)
        {
            pending.provider_id = provider.to_owned();
        }
    }

    /// A turn started with `command`. When the input was admitted as an off-peak run, the run opens now and this turn is
    /// its turn (Node `prepareOffPeakTurn`). Turns of one session run one at a time, so a run from an earlier turn has
    /// ended before this one starts; were it not so, the start is refused and the turn stays ordinary.
    pub fn turn_started(&self, session: &str, turn: &str, command: Option<&str>) {
        let Some(command) = command else {
            return;
        };
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(command);
        let Some(pending) = pending.filter(|pending| pending.session == session) else {
            return;
        };
        if self
            .start(
                session,
                &pending.execution_id,
                &pending.off_peak_task_id,
                &pending.ticket_id,
                &pending.provider_id,
                &pending.provider_error_code,
            )
            .is_err()
        {
            return;
        }
        if let Some(run) = self.lock().get_mut(session) {
            run.turn = Some(turn.to_owned());
        }
        self.changed.notify_waiters();
    }

    /// A turn finished. When it is the run's turn, the run's main side ends with the turn's outcome and the idle round
    /// is released (Node `mainEnded` and the binding's `release`); the run completes once no work is left.
    pub fn turn_finished(&self, session: &str, turn: &str, outcome: &TurnOutcome) -> Vec<Value> {
        let mut runs = self.lock();
        let Some(run) = runs.get_mut(session) else {
            return Vec::new();
        };
        if run.turn.as_deref() != Some(turn) {
            return Vec::new();
        }
        run.turn = None;
        run.lifecycle.main_ended(lifecycle_outcome(outcome));
        // Background tasks and queued notifications of the run are not observed yet (divergence: specs slice 3).
        run.lifecycle
            .release_idle_model_round(WorkSnapshot::default());
        self.changed.notify_waiters();
        notifications(run)
    }

    /// Whether `execution` of `session` is the run and may still use its ticket; otherwise why not.
    pub(crate) fn poll_ticket(&self, session: &str, execution: &str) -> Poll {
        let runs = self.lock();
        let Some(run) = runs
            .get(session)
            .filter(|run| run.execution_id == execution)
        else {
            return Poll::Ended("off_peak_completed");
        };
        let lifecycle = &run.lifecycle;
        if lifecycle.terminal() {
            return Poll::Ended(ended_code(lifecycle.state()));
        }
        match lifecycle.ticket_id() {
            Some(id) if lifecycle.ticket_ready() => Poll::Ready(Ticket {
                id: id.to_owned(),
                auth: run.request_auth.clone(),
            }),
            _ => Poll::Pending,
        }
    }

    /// Node `ticketExpired` for the attempt on `ticket`.
    pub(crate) fn expire_ticket(&self, session: &str, execution: &str, ticket: &str) -> Expiry {
        let mut runs = self.lock();
        let Some(run) = runs
            .get_mut(session)
            .filter(|run| run.execution_id == execution)
        else {
            return Expiry::Ended("off_peak_completed");
        };
        if run.lifecycle.terminal() {
            return Expiry::Ended(ended_code(run.lifecycle.state()));
        }
        if run.lifecycle.ticket_id() != Some(ticket) {
            return Expiry::Immediate;
        }
        run.lifecycle.ticket_expired(ticket);
        let notes = notifications(run);
        self.changed.notify_waiters();
        Expiry::Renewing(notes)
    }

    /// Node `retryExpired`: whether `error`, a refusal from `provider`, is the expired-ticket refusal of the run.
    pub(crate) fn refused_as_expired(
        &self,
        session: &str,
        execution: &str,
        provider: &str,
        error: &ModelError,
    ) -> bool {
        let runs = self.lock();
        let Some(run) = runs
            .get(session)
            .filter(|run| run.execution_id == execution)
        else {
            return false;
        };
        let Some(failure) = error.provider() else {
            return false;
        };
        run.provider_id == provider
            && (failure.code == run.provider_error_code || is_expired_code(&failure.code))
    }

    /// The session of the open (not ended) run `execution`, whichever session asks for it.
    pub(crate) fn open_session(&self, execution: &str) -> Option<String> {
        self.lock()
            .values()
            .find(|run| run.execution_id == execution && !run.lifecycle.terminal())
            .map(|run| run.session.clone())
    }

    /// Whether the off-peak tools are offered to `session`: its own flag when it was created or resumed with one, the
    /// workspace policy otherwise.
    pub fn tools_enabled(&self, session: &str) -> bool {
        self.session_flags
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session)
            .copied()
            .unwrap_or_else(|| self.policy.load(Ordering::SeqCst))
    }

    pub fn set_session_enabled(&self, session: &str, enabled: bool) {
        self.session_flags
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session.to_owned(), enabled);
    }

    pub fn set_policy(&self, enabled: bool) {
        self.policy.store(enabled, Ordering::SeqCst);
    }

    /// Records the `offPeakToolEnabled` a session's create or resume carried, if any.
    pub fn note_session_flag(&self, session: &str, params: &Value) {
        if let Some(enabled) = params["offPeakToolEnabled"].as_bool() {
            self.set_session_enabled(session, enabled);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The lifecycle outcome of a turn (Node `OffPeakOutcome`): an interrupted turn is stopped, a failed one failed.
fn lifecycle_outcome(outcome: &TurnOutcome) -> Outcome {
    match outcome {
        TurnOutcome::Interrupted => Outcome::Stopped,
        TurnOutcome::Failed { .. } => Outcome::Failed,
        _ => Outcome::Succeeded,
    }
}

/// The Node error code of a run that ended in `state`: a cancel, or a completion.
fn ended_code(state: State) -> &'static str {
    match state {
        State::Cancelled => "off_peak_cancelled",
        _ => "off_peak_completed",
    }
}

/// The credentials of a `replace_ticket` (Node `ModelRequestAuth`): the headers and the key.
fn supplied_auth(auth: &Value) -> SuppliedAuth {
    SuppliedAuth {
        api_key: auth["apiKey"].as_str().map(RedactedString::new),
        headers: auth["headers"]
            .as_object()
            .map(|headers| {
                headers
                    .iter()
                    .filter_map(|(name, value)| {
                        Some((name.clone(), RedactedString::new(value.as_str()?)))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn notifications(run: &mut Run) -> Vec<Value> {
    let events = run.lifecycle.drain_events();
    events.into_iter().map(|event| wire(run, event)).collect()
}

fn wire(run: &Run, event: Event) -> Value {
    let identity = json!({
        "sessionId": run.session,
        "executionId": run.execution_id,
        "offPeakTaskId": run.off_peak_task_id,
    });
    let mut out = identity.as_object().cloned().unwrap_or_default();
    let body = match event {
        Event::StateChanged(state) => json!({"type": "state_changed", "state": state.wire()}),
        Event::TicketNeeded {
            renewal_id,
            expired_ticket_id,
        } => {
            json!({"type": "ticket_needed", "renewalId": renewal_id, "expiredTicketId": expired_ticket_id})
        }
        Event::TicketReleased { ticket_id } => {
            json!({"type": "ticket_released", "ticketId": ticket_id})
        }
        Event::Completed { outcome } => json!({"type": "completed", "outcome": outcome.wire()}),
    };
    if let Some(fields) = body.as_object() {
        out.extend(fields.clone());
    }
    Value::Object(out)
}

/// The notification a run's lifecycle effect is sent as (Node `v4/offPeak/lifecycle`).
pub(crate) const LIFECYCLE: &str = "v4/offPeak/lifecycle";

/// `v4/conversation/offPeakControl` (Host to agent): the params were checked by the inbound schema. The answer says
/// whether a run matched, and each effect of the request is sent as a `v4/offPeak/lifecycle` notification.
pub(crate) async fn control_request(
    context: &crate::context::Context,
    params: &Value,
) -> Result<Value, RpcError> {
    let session = params["sessionId"].as_str().unwrap_or_default();
    let control = context.off_peak.control(session, params);
    for notification in &control.notifications {
        context.peer.notify(LIFECYCLE, notification).await;
    }
    Ok(json!({"accepted": control.accepted}))
}

#[cfg(test)]
#[path = "off_peak_control_tests.rs"]
mod tests;
