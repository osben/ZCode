//! Fork: the off-peak runs of the agent and `v4/conversation/offPeakControl` (Node `off-peak/runtime.ts`
//! `controlOffPeakRuntime`; specs/fork-rust-automations.md, slice 3).
//!
//! A session holds at most one active run, keyed by its `executionId`. The lifecycle machine owns the run's state;
//! this module routes the Host's `cancel` and `replace_ticket` to it and shapes each effect as a
//! `v4/offPeak/lifecycle` notification with the run's identity (`sessionId`, `executionId`, `offPeakTaskId`). Nothing
//! here starts a run or calls a model: the model binding owns the run's start and its ticket requests.

use std::collections::HashMap;
use std::sync::Mutex;

use rust_cli_protocol_core::rpc::RpcError;

use serde_json::{Value, json};

use crate::off_peak_lifecycle::{Event, OffPeakLifecycle, WorkSnapshot};

/// Node `OFF_PEAK_EXECUTION_TOOL_DENYLIST` aside, a session with an active run refuses a second one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartError {
    AlreadyActive,
}

/// One run of a session.
struct Run {
    session: String,
    execution_id: String,
    off_peak_task_id: String,
    lifecycle: OffPeakLifecycle,
    /// The Host's request auth for a renewed ticket, kept for the model binding (not used here).
    request_auth: Option<Value>,
}

/// The answer to one control request: whether the Host's request matched a run, and the notifications it caused.
#[derive(Debug, PartialEq)]
pub struct Control {
    pub accepted: bool,
    pub notifications: Vec<Value>,
}

/// The runs of this agent, keyed by session id. A finished run stays until a new one replaces it, so a repeated cancel
/// is still answered (Node keeps a terminal controller for idempotent replies).
#[derive(Default)]
pub struct OffPeakRuns {
    runs: Mutex<HashMap<String, Run>>,
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
                lifecycle: OffPeakLifecycle::new(ticket_id),
                request_auth: None,
            },
        );
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
        match params["action"].as_str() {
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
                    run.request_auth = Some(params["requestAuth"].clone());
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
        }
    }

    /// The lifecycle's ticket request for `session`: the run's ticket expired. Returns the notifications it caused.
    /// The model binding calls this when a request is refused as expired (Node `ticketExpired`).
    pub fn ticket_expired(&self, session: &str, ticket_id: &str) -> Vec<Value> {
        let mut runs = self.lock();
        let Some(run) = runs.get_mut(session) else {
            return Vec::new();
        };
        run.lifecycle.ticket_expired(ticket_id);
        notifications(run)
    }

    /// The runtime's work facts for `session`'s run. Returns the notifications the change caused (Node
    /// `workChanged`).
    pub fn work_changed(&self, session: &str, work: WorkSnapshot) -> Vec<Value> {
        let mut runs = self.lock();
        let Some(run) = runs.get_mut(session) else {
            return Vec::new();
        };
        run.lifecycle.work_changed(work);
        notifications(run)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn notifications(run: &mut Run) -> Vec<Value> {
    let events = run.lifecycle.drain_events();
    events
        .into_iter()
        .map(|event| wire(run, event))
        .collect()
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
        Event::UserTakeover => json!({"type": "user_takeover"}),
        Event::TicketNeeded {
            renewal_id,
            expired_ticket_id,
        } => json!({"type": "ticket_needed", "renewalId": renewal_id, "expiredTicketId": expired_ticket_id}),
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
