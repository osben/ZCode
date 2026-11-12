//! Fork: a background task notification's `originMeta` (Node `BackgroundResultOriginMeta`,
//! specs/fork-rust-agent-parity.md). One derivation for the two readers that must agree: the
//! protocol projection titles the background result turn, and the Node store writes the same meta on
//! the notification message so Node's cold read titles it too.

use serde_json::{Value, json};

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// `origin_meta` of one notification block, with the run a no-progress reminder was built for. Node writes
/// `subagentStall.executionId` after `lastProgressAt` (subagent-stall-reminder.ts), only when the reminder has one.
/// `execution` is given only for a message that is exactly this one block (a batch keeps base fields, as Node).
pub fn origin_meta_with_execution(text: &str, execution: Option<&str>) -> Option<Value> {
    let mut meta = origin_meta(text)?;
    if let (Some(execution), Some(stall)) = (execution, meta.get_mut("subagentStall")) {
        stall["executionId"] = json!(execution);
    }
    Some(meta)
}

/// The quoted description in a notification summary: `Agent "<title>" completed`, `Background
/// command "<title>" failed with exit code 1`. The closing quote is the one before the ending words,
/// so a quote inside the title or the error text does not cut it short.
fn quoted_title<'a>(summary: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = summary.strip_prefix(prefix)?;
    let end = ["\" finished", "\" completed", "\" failed", "\" was "]
        .iter()
        .filter_map(|ending| rest.find(ending))
        .min()?;
    Some(&rest[..end])
}

/// Every `(task id, status)` of the `<task-notification>` blocks in a notification message.
pub fn notified_statuses(text: &str) -> Vec<(String, String)> {
    text.split("<task-notification>")
        .skip(1)
        .filter_map(|block| {
            let task = between(block, "<task-id>", "</task-id>")?.trim();
            let status = between(block, "<status>", "</status>")?.trim();
            (!task.is_empty() && !status.is_empty()).then(|| (task.to_owned(), status.to_owned()))
        })
        .collect()
}

/// Fork: every `(task id, output file)` of the `<task-notification>` blocks in a notification message.
pub fn notified_outputs(text: &str) -> Vec<(String, String)> {
    text.split("<task-notification>")
        .skip(1)
        .filter_map(|block| {
            let task = between(block, "<task-id>", "</task-id>")?.trim();
            let output = between(block, "<output-file>", "</output-file>")?.trim();
            (!task.is_empty() && !output.is_empty()).then(|| (task.to_owned(), output.to_owned()))
        })
        .collect()
}

/// `originMeta` of the first `<task-notification>` in a notification message; `None` for a
/// notification the UI does not title (a Monitor, a workflow). A no-progress reminder
/// (`<background-agent-stall>`) has its own meta (Node `subagent-stall-reminder.ts`).
pub fn origin_meta(text: &str) -> Option<Value> {
    if let Some(stall) = stall_origin_meta(text) {
        return Some(stall);
    }
    let work = between(text, "<task-id>", "</task-id>")?.trim();
    let summary = between(text, "<summary>", "</summary>")?.trim();
    let (source, title) = if let Some(title) = quoted_title(summary, "Agent \"") {
        ("subagent", title)
    } else {
        ("bash", quoted_title(summary, "Background command \"")?)
    };
    let title = title.trim();
    if work.is_empty() || title.is_empty() {
        return None;
    }
    let mut meta = json!({"backgroundSource": source, "workId": work, "title": title});
    if source == "subagent"
        && let Some(result) = subagent_result(text, summary)
    {
        meta["subagentResult"] = result;
    }
    Some(meta)
}

/// Node `subagent-stall-reminder.ts`'s `originMeta`, read back from the reminder block. The title and the stall
/// fields come from the block's own tags, which the formatter wrote from the same numbers. Node's `executionId`
/// is not in the text, so it is not here (Rust has no execution id).
fn stall_origin_meta(text: &str) -> Option<Value> {
    let block = between(
        text,
        "<background-agent-stall>",
        "</background-agent-stall>",
    )?;
    let work = tag(block, "task-id")?;
    let description = tag(block, "description")?;
    let no_progress: u64 = tag(block, "no-progress-for-ms")?.parse().ok()?;
    let last_progress = parse_iso_ms(&tag(block, "last-progress-at")?)?;
    // Node: `Math.max(1, Math.round(noProgressForMs / 60_000))`, half up.
    let minutes = (no_progress + 30_000).div_euclid(60_000).max(1);
    Some(json!({
        "backgroundSource": "subagent",
        "title": format!("{description} — no progress for {minutes} min"),
        "workId": work,
        "subagentStall": {"noProgressForMs": no_progress, "lastProgressAt": last_progress},
    }))
}

/// The inverse of JS `toISOString` (`YYYY-MM-DDTHH:MM:SS.mmmZ`, base `iso_timestamp`).
fn parse_iso_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let separators_ok = bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z';
    if !separators_ok {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse::<i64>().ok())
            .flatten()
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second, millis) = (
        digits(11..13)?,
        digits(14..16)?,
        digits(17..19)?,
        digits(20..23)?,
    );
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = rust_cli_base::civil::days_from_civil(year, month as u32, day as u32);
    let total = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis;
    u64::try_from(total).ok()
}

/// Node `SUBAGENT_RESULT_ERROR_MAX_CHARS`: the structured error is bounded, the summary is not.
const RESULT_ERROR_MAX_CHARS: usize = 2_000;

/// Node `localAgentSubagentResult`: the subagent's terminal state, with the failure reason that
/// follows `failed: ` in the summary.
fn subagent_result(text: &str, summary: &str) -> Option<Value> {
    let status = between(text, "<status>", "</status>")?.trim();
    match status {
        "failed" => {
            let reason = summary
                .split_once("\" failed: ")
                .map(|(_, reason)| reason.trim())
                .filter(|reason| !reason.is_empty())
                .unwrap_or("Unknown error");
            let error = if reason.chars().count() <= RESULT_ERROR_MAX_CHARS {
                reason.to_owned()
            } else {
                let mut bounded: String = reason.chars().take(RESULT_ERROR_MAX_CHARS - 1).collect();
                bounded.push('…');
                bounded
            };
            Some(json!({"status": "failed", "error": error}))
        }
        "completed" | "killed" => Some(json!({"status": status})),
        _ => None,
    }
}

/// One `<task-notification>` block that names its tool call (Node `ZCodeParsedBackgroundTaskNotification`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifiedTool {
    pub tool_use: String,
    pub status: Option<String>,
    pub error: Option<String>,
    pub result: Option<String>,
    pub summary: Option<String>,
}

/// Node `readTaskNotificationTag`: the trimmed, XML-decoded tag text; `None` when empty.
fn tag(block: &str, name: &str) -> Option<String> {
    let value = between(block, &format!("<{name}>"), &format!("</{name}>"))?.trim();
    (!value.is_empty()).then(|| decode(value))
}

/// Node `decodeTaskNotificationXmlText`.
fn decode(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Node `parseZCodeBackgroundTaskNotifications`: every block of a notification message that names a
/// `<tool-use-id>`, with tags read inside that block only. The single-notification `subagentResult`
/// (`origin_meta`) gives the status and error only when the message holds exactly one block; a
/// merged message reads each block's own `<status>` / `<error>`. `text` must be a task-notification
/// message.
pub fn notified_tools(text: &str) -> Vec<NotifiedTool> {
    const OPEN: &str = "<task-notification>";
    // Node also requires the text to start with the envelope; the kernel wraps each one in a
    // `<system-reminder>` with a preamble, and callers pass only task-notification messages.
    let blocks: Vec<&str> = text
        .split(OPEN)
        .skip(1)
        .map(|block| block.split("</task-notification>").next().unwrap_or(block))
        .collect();
    let single = match blocks.as_slice() {
        [block] => origin_meta(block).and_then(|meta| meta.get("subagentResult").cloned()),
        _ => None,
    };
    blocks
        .iter()
        .filter_map(|block| {
            let tool_use = tag(block, "tool-use-id")?;
            let (status, error) = match &single {
                Some(result) => (
                    result["status"].as_str().map(str::to_owned),
                    // The reason is read from the envelope summary; Node keeps it unescaped in `originMeta`.
                    result["error"].as_str().map(decode),
                ),
                None => (tag(block, "status"), tag(block, "error")),
            };
            Some(NotifiedTool {
                tool_use,
                status,
                error,
                result: tag(block, "result"),
                summary: tag(block, "summary"),
            })
        })
        .collect()
}

/// Node `MAX_BACKGROUND_RESULT_TITLES`: a batch header names this many tasks, then `+N`.
const MAX_TITLES: usize = 3;

/// Node `resolveBackgroundTaskNotificationOriginMeta`: one notification keeps its meta; a batch keeps
/// the first task's source and work id and joins the titles with ` · `, and is untitled when any of
/// its notifications is.
pub fn batch_meta(metas: &[Option<Value>]) -> Option<Value> {
    if let [single] = metas {
        return single.clone();
    }
    // Node `orderTaskNotificationsForParsing`: terminal notifications first, a stall reminder (`subagentStall`) last.
    let mut ordered = metas.to_vec();
    ordered.sort_by_key(|meta| {
        meta.as_ref()
            .is_some_and(|meta| meta.get("subagentStall").is_some())
    });
    let metas: Vec<&Value> = ordered
        .iter()
        .map(|meta| meta.as_ref())
        .collect::<Option<_>>()?;
    let first = metas.first()?;
    let mut titles: Vec<String> = metas
        .iter()
        .take(MAX_TITLES)
        .filter_map(|meta| meta["title"].as_str().map(str::to_owned))
        .collect();
    if metas.len() > MAX_TITLES {
        titles.push(format!("+{}", metas.len() - MAX_TITLES));
    }
    // Like Node, a batch keeps only the base fields: one turn cannot carry each task's result.
    Some(json!({
        "backgroundSource": first["backgroundSource"],
        "workId": first["workId"],
        "title": titles.join(" · "),
    }))
}

#[cfg(test)]
#[path = "background_origin_tests.rs"]
mod tests;
