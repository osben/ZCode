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
