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

/// `originMeta` of the first `<task-notification>` in a notification message; `None` for a
/// notification the UI does not title (a Monitor, a workflow).
pub fn origin_meta(text: &str) -> Option<Value> {
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
    let metas: Vec<&Value> = metas.iter().map(Option::as_ref).collect::<Option<_>>()?;
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
