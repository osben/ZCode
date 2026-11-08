//! Fork: the background result turn header (Node `mapTurnHeaderOrigin("background_task")` and
//! `BackgroundResultOriginMeta`; specs/fork-rust-agent-parity.md). A turn that a background task
//! notification opened has no typed user row; its header reads `origin: "backgroundResult"` with
//! `originMeta {backgroundSource, workId, title}`, so the UI shows the structured title instead of a
//! plain model-only turn. The meta is read from the notification envelope, which is the same live and
//! cold.

use serde_json::{Value, json};

use super::{Projection, turn_key};

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
    let end = ["\" completed", "\" failed", "\" was "]
        .iter()
        .filter_map(|ending| rest.find(ending))
        .min()?;
    Some(&rest[..end])
}

/// Every `(task id, status)` of the `<task-notification>` blocks in a notification message.
pub(super) fn notified_statuses(text: &str) -> Vec<(String, String)> {
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
pub(super) fn origin_meta(text: &str) -> Option<Value> {
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
    Some(json!({"backgroundSource": source, "workId": work, "title": title}))
}

impl Projection {
    /// A notification opened the current turn: its header becomes the background result header. A
    /// notification merged into a turn the user opened leaves the header alone.
    pub(super) fn background_result(&mut self, text: &str, out: &mut Vec<Value>) {
        let Some(turn) = &self.turn else {
            return;
        };
        if turn.command.is_some() || turn.keys.iter().any(|key| key.starts_with("user:")) {
            return;
        }
        let Some(meta) = origin_meta(text) else {
            return;
        };
        let key = turn_key(&turn.id);
        self.upsert(
            &key,
            |row| {
                if row["origin"] == "userInput" {
                    row.insert("origin".into(), json!("backgroundResult"));
                    row.insert("originMeta".into(), meta);
                }
            },
            out,
        );
    }
}
