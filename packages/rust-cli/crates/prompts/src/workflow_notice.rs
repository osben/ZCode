//! The model-visible notices of a dynamic workflow run (Node `runtime-task/workflow-notification-copy.ts`, 9.38, W7-7c):
//! a run's stall, a raised escalation, and the reminder of an idle main agent that a run still waits on. Each is a
//! complete text (the banner first), posted as it is; none is wrapped again.
//!
//! The lengths are counted in UTF-16 code units, as Node counts them.

/// Node `SYSTEM_NOTIFICATION_BANNER`: the model reads the notice as the system's report, not the user's words.
const BANNER: [&str; 4] = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
];

/// Node `TASK_NOTIFICATION_MAX_CHARS`.
pub const TASK_NOTIFICATION_MAX_UNITS: usize = 120_000;
/// Node's cap on a question or context text in the blocked reminder (`WORKFLOW_BLOCKED_TEXT_MAX_CHARS`).
const BLOCKED_TEXT_MAX_UNITS: usize = 2_000;
/// The reminder lists at most this many questions and holes; the rest are counted and read from GetWorkflowRun.
const BLOCKED_MAX_LISTED: usize = 8;

/// A run stalled: no model request of the run has succeeded for `since_ms`.
pub struct Stall<'a> {
    pub run_label: &'a str,
    pub run_id: &'a str,
    pub since_ms: u64,
    pub reason: Option<&'a str>,
    pub cap: Option<u64>,
}

/// The stall notice (Node `formatWorkflowStallNotification`).
pub fn stall(input: &Stall<'_>) -> String {
    let minutes = ((input.since_ms + 30_000) / 60_000).max(1);
    let mut lines = banner();
    lines.push("<workflow-stall>".into());
    lines.push(format!("  <run-id>{}</run-id>", escape_xml(input.run_id)));
    lines.push(format!("  <run>{}</run>", escape_xml(input.run_label)));
    lines.push(format!("  <since-ms>{}</since-ms>", input.since_ms));
    if let Some(reason) = input.reason {
        lines.push(format!(
            "  <dominant-reason>{}</dominant-reason>",
            escape_xml(reason)
        ));
    }
    if let Some(cap) = input.cap {
        lines.push(format!("  <cap>{cap}</cap>"));
    }
    let reason_clause = match input.reason {
        None => "the provider keeps failing requests".to_owned(),
        Some(reason) => format!("the provider keeps answering {reason}"),
    };
    let cap_clause = input
        .cap
        .map(|cap| format!(" (current fan-out {cap})"))
        .unwrap_or_default();
    lines.push("</workflow-stall>".into());
    lines.push(String::new());
    lines.push(format!(
        "Workflow run {} ({}) has not completed a model request in {minutes} minutes; {reason_clause} and the run is retrying with backoff{cap_clause}.",
        input.run_label, input.run_id
    ));
    lines.push("It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own.".into());
    truncate_task_notification(&lines.join("\n"))
}

/// A subagent escalated a blocking question and is parked on it.
pub struct Escalation<'a> {
    pub run_label: &'a str,
    pub run_id: &'a str,
    pub qid: &'a str,
    /// The actor's readable name, or its structured reference `site@ordinal` when it is anonymous.
    pub actor: &'a str,
    pub question: &'a str,
    pub context: Option<&'a str>,
}

/// The escalation notice (Node `formatWorkflowEscalationNotification`).
pub fn escalation(input: &Escalation<'_>) -> String {
    let mut lines = banner();
    lines.push("<workflow-escalation>".into());
    lines.push(format!("  <run-id>{}</run-id>", escape_xml(input.run_id)));
    lines.push(format!("  <run>{}</run>", escape_xml(input.run_label)));
    lines.push(format!(
        "  <question-id>{}</question-id>",
        escape_xml(input.qid)
    ));
    lines.push(format!(
        "  <subagent>{}</subagent>",
        escape_xml(input.actor)
    ));
    lines.push(format!(
        "  <question>{}</question>",
        escape_xml(input.question)
    ));
    if let Some(context) = input.context.filter(|context| !context.is_empty()) {
        lines.push(format!("  <context>{}</context>", escape_xml(context)));
    }
    lines.push("</workflow-escalation>".into());
    lines.push(String::new());
    lines.push(format!(
        "Subagent {} in workflow run {} ({}) escalated a blocking question and is parked on that call waiting for your answer.",
        input.actor, input.run_label, input.run_id
    ));
    lines.push(format!(
        "Next step: call ResolveWorkflowQuestion with question_id=\"{}\" and your answer.",
        input.qid
    ));
    lines.push("The run is still running: only the subagent that asked is parked — every other subagent and the script's control flow keep going. So do not drop what you are doing, but do not leave it unanswered either: nothing times out on its behalf.".into());
    lines.push("If this notification is ever lost, GetWorkflowRun lists the questions this run still owes an answer to.".into());
    truncate_task_notification(&lines.join("\n"))
}

/// A question a run is parked on, with how long it has waited.
pub struct BlockedQuestion {
    pub qid: String,
    pub subagent: String,
    pub question: String,
    pub context: Option<String>,
    pub waited_ms: u64,
}

/// A hole a run is waiting at, with how long it has waited.
pub struct BlockedHole {
    pub site_id: String,
    pub name: String,
    pub type_name: String,
    pub line: Option<u64>,
    pub waited_ms: u64,
}

/// One reminder of an idle main agent: everything the run still owes, at the moment of the send.
pub struct Blocked<'a> {
    pub run_label: &'a str,
    pub run_id: &'a str,
    /// Which reminder this is (1 first) and the most a run gets.
    pub ordinal: usize,
    pub total: usize,
    pub questions: &'a [BlockedQuestion],
    pub holes: &'a [BlockedHole],
    pub draft_path: Option<&'a str>,
}

/// The blocked reminder (Node `formatWorkflowBlockedNotification`).
pub fn blocked(input: &Blocked<'_>) -> String {
    let mut lines = banner();
    lines.push("<workflow-blocked>".into());
    lines.push(format!("  <run-id>{}</run-id>", escape_xml(input.run_id)));
    lines.push(format!("  <run>{}</run>", escape_xml(input.run_label)));
    lines.push(format!(
        "  <reminder>{} of {}</reminder>",
        input.ordinal, input.total
    ));
    let shown_questions = &input.questions[..input.questions.len().min(BLOCKED_MAX_LISTED)];
    if !input.questions.is_empty() {
        lines.push(format!(
            "  <open-questions count=\"{}\" shown=\"{}\">",
            input.questions.len(),
            shown_questions.len()
        ));
        for question in shown_questions {
            lines.push(format!(
                "    <question id=\"{}\" subagent=\"{}\" waited-ms=\"{}\">",
                escape_xml(&question.qid),
                escape_xml(&question.subagent),
                question.waited_ms
            ));
            lines.push(format!(
                "      <text>{}</text>",
                escape_xml(&bound_blocked_text(&question.question))
            ));
            if let Some(context) = question
                .context
                .as_deref()
                .filter(|context| !context.is_empty())
            {
                lines.push(format!(
                    "      <context>{}</context>",
                    escape_xml(&bound_blocked_text(context))
                ));
            }
            lines.push("    </question>".into());
        }
        lines.push("  </open-questions>".into());
    }
    let shown_holes = &input.holes[..input.holes.len().min(BLOCKED_MAX_LISTED)];
    if !input.holes.is_empty() {
        lines.push(format!(
            "  <open-holes count=\"{}\" shown=\"{}\">",
            input.holes.len(),
            shown_holes.len()
        ));
        for hole in shown_holes {
            let line = hole
                .line
                .map(|line| format!(" line=\"{line}\""))
                .unwrap_or_default();
            lines.push(format!(
                "    <hole id=\"{}\" name=\"{}\" type=\"{}\"{line} waited-ms=\"{}\"/>",
                escape_xml(&hole.site_id),
                escape_xml(&hole.name),
                escape_xml(&hole.type_name),
                hole.waited_ms
            ));
        }
        lines.push("  </open-holes>".into());
    }
    if let Some(draft) = input.draft_path {
        lines.push(format!("  <draft>{}</draft>", escape_xml(draft)));
    }
    lines.push("</workflow-blocked>".into());
    lines.push(String::new());

    let total = input.questions.len() + input.holes.len();
    let oldest = input
        .questions
        .iter()
        .map(|question| question.waited_ms)
        .chain(input.holes.iter().map(|hole| hole.waited_ms))
        .max()
        .unwrap_or(0);
    let minutes = ((oldest + 30_000) / 60_000).max(1);
    let mut what = Vec::new();
    if !input.questions.is_empty() {
        what.push(count_noun(input.questions.len(), "question"));
    }
    if !input.holes.is_empty() {
        what.push(count_noun(input.holes.len(), "hole"));
    }
    let what = what.join(" and ");
    lines.push(if total == 1 {
        format!(
            "Workflow run {} ({}) is still waiting on you: {what} is open, for {minutes} minutes, and you have not acted on it since your last turn ended.",
            input.run_label, input.run_id
        )
    } else {
        format!(
            "Workflow run {} ({}) is still waiting on you: {what} are open, the oldest for {minutes} minutes, and you have not acted on them since your last turn ended.",
            input.run_label, input.run_id
        )
    });
    if !input.questions.is_empty() {
        lines.push("Next step for each question: call ResolveWorkflowQuestion with its id as question_id and your answer.".into());
    }
    if !input.holes.is_empty() {
        let context = match input.draft_path {
            None => format!(
                "read the run's script with GetWorkflowRun (run_id=\"{}\")",
                input.run_id
            ),
            Some(draft) => format!("read the draft at {draft}"),
        };
        lines.push(format!(
            "Next step for each hole: {context} for the context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"{}\" and its id as hole_id and the body as `script`.",
            input.run_id
        ));
    }
    if input.questions.len() > shown_questions.len() || input.holes.len() > shown_holes.len() {
        lines.push(format!(
            "GetWorkflowRun lists the ones not shown here (run_id=\"{}\").",
            input.run_id
        ));
    }
    lines.push("If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop.".into());
    lines.push(if input.ordinal < input.total {
        "One more reminder follows if nothing changes.".into()
    } else {
        "This is the last reminder: nothing further is sent until the user writes or this run's open decisions change.".into()
    });
    lines.push(
        "Either way the parked branches keep waiting; nothing times out on their behalf.".into(),
    );
    truncate_task_notification(&lines.join("\n"))
}

fn banner() -> Vec<String> {
    BANNER.iter().map(|line| (*line).to_owned()).collect()
}

fn count_noun(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// Node `boundBlockedText`: a text over the blocked reminder's limit is cut and ends in an ellipsis.
fn bound_blocked_text(value: &str) -> String {
    if utf16_len(value) <= BLOCKED_TEXT_MAX_UNITS {
        return value.to_owned();
    }
    let mut head = utf16_prefix(value, BLOCKED_TEXT_MAX_UNITS - 1);
    head.push('…');
    head
}

/// Node `truncateTaskNotification`: a text over the limit is cut and marked.
pub fn truncate_task_notification(value: &str) -> String {
    if utf16_len(value) <= TASK_NOTIFICATION_MAX_UNITS {
        return value.to_owned();
    }
    format!(
        "{}\n[truncated]",
        utf16_prefix(value, TASK_NOTIFICATION_MAX_UNITS)
    )
}

/// Node `escapeXml`: the five characters that would open a tag or an attribute.
pub fn escape_xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// The longest prefix of at most `max` UTF-16 code units, never splitting a character.
fn utf16_prefix(value: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for character in value.chars() {
        let width = character.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(character);
    }
    out
}

#[cfg(test)]
#[path = "workflow_notice_tests.rs"]
mod tests;
