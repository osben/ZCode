//! Fork: the run progress port's live half (specs/fork-rust-workflow-engine.md, 9.34, W7-5e; the model-visible effects of
//! the progress path, 9.38, W7-7c). Node's sink appends each run's progress to the parent session's in-memory event store
//! and the Host hears it. Here the progress is not written anywhere: the durable record is the run's journal. The port
//! hands the projection's deltas to the parent session's open stream, if one is open, and it posts the run notices the
//! parent's model reads (an escalation, a stall, a hole). Rust's cold read does not yet replay the journal into progress events
//! (9.34, 298).

use std::sync::{Arc, Weak};

use rust_cli_base::js::string::{utf16_len, utf16_prefix};
use rust_cli_kernel_api::agents::AgentSignals;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_notice_meta::{self, HolePayload};
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_prompts::workflow_notice::{Escalation, Hole, Stall};
use serde_json::Value;

use super::workflow_reminder::BlockedReminderClock;
use super::workflow_reminder_host::WorkflowReminders;

/// Where a run's live deltas go: the parent session's open stream.
pub trait ProgressDelivery: Send + Sync {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>);
}

/// Where a run's model-visible notices go: the parent session's model inbox (Node `enqueueBackgroundTaskNotification`).
/// The text is complete; it is not wrapped again.
pub trait WorkflowNotices: Send + Sync {
    /// `workflow` is the notice's origin fragment (9.51, W8d), `None` for a notice that carries none.
    fn post(&self, parent_session_id: &str, text: String, workflow: Option<Value>);
}

/// The production notices: the parent session's signal channel, which the session actor reads at its tool boundary or
/// when it is idle (the same channel as a subagent's message, and not counted as background work).
pub struct SignalNotices {
    signals: Arc<dyn AgentSignals>,
}

impl SignalNotices {
    pub fn new(signals: Arc<dyn AgentSignals>) -> Self {
        Self { signals }
    }
}

impl WorkflowNotices for SignalNotices {
    fn post(&self, parent_session_id: &str, text: String, workflow: Option<Value>) {
        self.signals
            .workflow_notice(&SessionId::new(parent_session_id), text, workflow);
    }
}

/// The run progress port. Its effects are the live delivery of the deltas and the parent's model notices; nothing is
/// persisted, and the payload is not written anywhere (it is the journal's row, which the run service keeps).
pub struct WorkflowProgressHost {
    delivery: Arc<dyn ProgressDelivery>,
    notices: Option<Arc<dyn WorkflowNotices>>,
    reminder: Option<Arc<BlockedReminderClock>>,
    reminders: Option<Arc<WorkflowReminders>>,
}

impl WorkflowProgressHost {
    pub fn new(delivery: Arc<dyn ProgressDelivery>) -> Self {
        Self {
            delivery,
            notices: None,
            reminder: None,
            reminders: None,
        }
    }

    /// The app's per-session reminder clocks (9.44). An open-set change is routed to the clock of the run's parent session.
    #[must_use]
    pub fn with_reminders(mut self, reminders: Arc<WorkflowReminders>) -> Self {
        self.reminders = Some(reminders);
        self
    }

    /// The parent's model inbox for the run notices. Without it no notice is posted.
    #[must_use]
    pub fn with_notices(mut self, notices: Arc<dyn WorkflowNotices>) -> Self {
        self.notices = Some(notices);
        self
    }

    /// The blocked-run reminder clock, told when a run's open set changes (Node `noteWorkflowReminderRunEvent`).
    #[must_use]
    pub fn with_reminder(mut self, reminder: Arc<BlockedReminderClock>) -> Self {
        self.reminder = Some(reminder);
        self
    }
}

impl WorkflowRunProgressPort for WorkflowProgressHost {
    /// Delivers the deltas to the parent's open stream, then gives the model its notices (Node's order: the reminder
    /// clock, the escalation, the stall, the hole; see 9.38 and 9.49).
    fn record(
        &self,
        parent_session_id: &str,
        progress: &Value,
        deltas: &[Value],
    ) -> Result<(), String> {
        if !deltas.is_empty() {
            self.delivery.deliver(parent_session_id, deltas.to_vec());
        }
        let event_type = str_field(progress, "eventType");
        let run_id = str_field(progress, "runId");
        if let (Some(reminder), Some(run_id), Some(event_type)) =
            (&self.reminder, run_id, event_type)
            && OPEN_SET_EVENT_TYPES.contains(&event_type)
        {
            reminder.open_set_changed(run_id);
        }
        if let (Some(reminders), Some(run_id), Some(event_type)) =
            (&self.reminders, run_id, event_type)
            && OPEN_SET_EVENT_TYPES.contains(&event_type)
        {
            reminders.open_set_changed(parent_session_id, run_id);
        }
        if let (Some(notices), Some(run_id)) = (&self.notices, run_id) {
            let payload = progress.get("payload").unwrap_or(&Value::Null);
            let posted = match event_type {
                Some(ESCALATION_RAISED) => escalation_text(run_id, payload),
                Some(RUN_STALLED) => stall_text(run_id, payload),
                Some(HOLE_REACHED) => hole_text(
                    run_id,
                    parent_session_id,
                    payload,
                    self.reminders.as_deref(),
                ),
                _ => None,
            };
            if let Some((text, workflow)) = posted {
                notices.post(parent_session_id, text, Some(workflow));
            }
        }
        Ok(())
    }
}

/// The run events that change a run's open set (Node `OPEN_SET_EVENT_TYPES`).
const OPEN_SET_EVENT_TYPES: [&str; 4] = [
    "escalation-raised",
    "escalation-resolved",
    "hole-reached",
    "hole-filled",
];
const ESCALATION_RAISED: &str = "escalation-raised";
const RUN_STALLED: &str = "run-stalled";
const HOLE_REACHED: &str = "hole-reached";

/// Node `WORKFLOW_HOLE_PROMPT_MAX_CHARS` (`dynamic-workflow-run-hole-notification.ts`): the prompt is cut at 4000 UTF-16
/// units, the last one an ellipsis.
const HOLE_PROMPT_MAX_UNITS: usize = 4_000;

/// `hole-reached` → the parked hole's notice (9.49, W8b; Node `notifyHoleReached`). The payload carries the site and the
/// name; the type and the line come from the run the parent reads (the projection's hole), so the main agent sees the
/// type it must return. Without that read the type is `unknown`, as Node's fallback. A malformed payload is skipped.
fn hole_text(
    run_id: &str,
    parent_session_id: &str,
    payload: &Value,
    reminders: Option<&WorkflowReminders>,
) -> Option<(String, Value)> {
    let instance = payload.get("instance");
    let site_id = instance.and_then(|instance| str_field(instance, "siteId"));
    let ordinal = instance.and_then(|instance| instance.get("ordinal").and_then(Value::as_u64));
    let (Some(site_id), Some(ordinal), Some(name)) = (site_id, ordinal, str_field(payload, "name"))
    else {
        tracing::warn!(
            event = "dynamic_workflow.hole.notification_skipped",
            run_id,
            "Dynamic workflow hole notification skipped: malformed payload"
        );
        return None;
    };
    let hole =
        reminders.and_then(|reminders| reminders.open_hole(parent_session_id, run_id, site_id));
    // Node `notifyHoleReached`: the payload wins for each field when it carries one, else the projection's hole, else the fallback.
    let type_name = str_field(payload, "type")
        .or_else(|| {
            hole.as_ref()
                .map(|hole| hole.type_name.as_str())
                .filter(|type_name| !type_name.is_empty())
        })
        .unwrap_or("unknown");
    let line = payload
        .get("line")
        .and_then(Value::as_u64)
        .or_else(|| hole.as_ref().and_then(|hole| hole.line));
    let prompt = str_field(payload, "prompt").map(bound_hole_prompt);
    // The draft path is not in the projection yet (divergence 488), and the payload does not name the phases (9.49).
    let text = rust_cli_prompts::workflow_notice::hole(&Hole {
        run_label: run_id,
        run_id,
        hole_id: site_id,
        name,
        type_name,
        prompt: prompt.as_deref(),
        draft_path: None,
        line,
        before: None,
        after: None,
    });
    // The payload carries the ordinal the text does not (9.51, W8d).
    let workflow = workflow_notice_meta::hole(&HolePayload {
        site_id,
        ordinal,
        name,
        type_name,
        prompt: prompt.as_deref(),
        draft_path: None,
        line,
        before: None,
        after: None,
    });
    Some((text, workflow))
}

/// Node `boundPrompt`: a prompt over the limit keeps its first 3999 UTF-16 units and ends in `…`. The cut never splits a
/// character (a lone surrogate cannot be held by a Rust string; divergence 365). Same rule as the engine's copy, on the
/// shared UTF-16 helpers.
fn bound_hole_prompt(prompt: &str) -> String {
    if utf16_len(prompt) <= HOLE_PROMPT_MAX_UNITS {
        return prompt.to_owned();
    }
    format!("{}…", utf16_prefix(prompt, HOLE_PROMPT_MAX_UNITS - 1))
}

/// `escalation-raised` → the parked question's notice. A payload without a question id or text is skipped, and never
/// panics: the notice is an observation, and the run's truth is in the journal.
fn escalation_text(run_id: &str, payload: &Value) -> Option<(String, Value)> {
    let (Some(qid), Some(question)) = (str_field(payload, "qid"), str_field(payload, "question"))
    else {
        tracing::warn!(
            event = "dynamic_workflow.escalation.notification_skipped",
            run_id,
            "Dynamic workflow escalation notification skipped: malformed payload"
        );
        return None;
    };
    let actor = str_field(payload, "actorName")
        .map(str::to_owned)
        .unwrap_or_else(|| actor_ref_label(payload.get("actor")));
    let context = str_field(payload, "context");
    let text = rust_cli_prompts::workflow_notice::escalation(&Escalation {
        // The run's display name is the registry's description (Node); the progress path has no registry, so the id stands.
        run_label: run_id,
        run_id,
        qid,
        actor: &actor,
        question,
        context,
    });
    // `askedAt` is epoch milliseconds, read as a number only when it is one (Node `typeof askedAt === "number"`).
    let asked_at = payload.get("askedAt").and_then(Value::as_f64);
    let workflow = workflow_notice_meta::escalation(qid, &actor, question, context, asked_at);
    Some((text, workflow))
}

/// `run-stalled` → the run's stall notice. A `sinceMs` that is not a finite, non-negative number is skipped.
fn stall_text(run_id: &str, payload: &Value) -> Option<(String, Value)> {
    let Some(since) = payload
        .get("sinceMs")
        .and_then(Value::as_f64)
        .filter(|since| since.is_finite() && *since >= 0.0)
    else {
        tracing::warn!(
            event = "dynamic_workflow.stall.notification_skipped",
            run_id,
            "Dynamic workflow stall notification skipped: malformed payload"
        );
        return None;
    };
    let cap = payload
        .get("cap")
        .and_then(Value::as_f64)
        .filter(|cap| cap.is_finite() && *cap >= 0.0)
        .map(|cap| cap.floor() as u64);
    let reason = str_field(payload, "reason");
    let text = rust_cli_prompts::workflow_notice::stall(&Stall {
        run_label: run_id,
        run_id,
        since_ms: since.floor() as u64,
        reason,
        cap,
    });
    let workflow = workflow_notice_meta::stall(since, reason, cap.map(|cap| cap as f64));
    Some((text, workflow))
}

/// Node `actorRefLabel`: a named actor's name, else `siteId@ordinal`, else a fixed fallback.
fn actor_ref_label(actor: Option<&Value>) -> String {
    match actor {
        Some(Value::String(name)) => name.clone(),
        Some(Value::Object(actor)) => {
            let site = actor.get("siteId").and_then(Value::as_str);
            let ordinal = actor.get("ordinal").and_then(Value::as_u64);
            match (site, ordinal) {
                (Some(site), Some(ordinal)) => format!("{site}@{ordinal}"),
                _ => "unknown actor".to_owned(),
            }
        }
        _ => "unknown actor".to_owned(),
    }
}

/// A non-empty string field (Node `stringField`).
fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// The production delivery: the parent session's open stream gets the deltas in its pump, as the helper's plugin UI
/// deltas do. A session with no open stream has nobody to show them to, so they are dropped. The context is held weakly:
/// the run service reaches this delivery through the context, so a strong reference here would be a cycle.
pub struct BridgeDelivery {
    context: Weak<crate::context::Context>,
}

impl BridgeDelivery {
    pub fn new(context: Weak<crate::context::Context>) -> Self {
        Self { context }
    }
}

impl ProgressDelivery for BridgeDelivery {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>) {
        let Some(context) = self.context.upgrade() else {
            return;
        };
        let Some(bridge) = context.live_bridge() else {
            return;
        };
        let Some(live) = bridge.get(&rust_cli_kernel_api::ids::SessionId::new(parent_session_id))
        else {
            return;
        };
        let sink = live.sink.clone();
        live.run(Box::pin(async move {
            sink.workflow_runs_changed(deltas).await;
        }));
    }
}

#[cfg(test)]
#[path = "workflow_progress_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workflow_progress_notice_tests.rs"]
mod notice_tests;
