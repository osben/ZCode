//! Fork: the history of an imported session (`session/create` with `importedHistory`, source `claudeCode`;
//! specs/fork-rust-imported-history.md). Node `persistImportedSessionHistory` (`server-operations.ts`) writes the
//! session row's title and times and one message with one text part per imported message; the rows here are the
//! same, byte for byte in `data`, so the Node app and CLI read them back (and the reverse: a Node-written import
//! loads here through the ordinary text hydration).
use rusqlite::{Connection, params};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{ImportedHistory, StoreError};
use serde_json::{Value, json};

use crate::OrStorage;
use crate::repo::{messages, sessions};
use crate::state;

/// Node `slugifyImportedSession`.
pub(crate) fn slug(session: &str) -> String {
    let mut out = String::with_capacity(session.len());
    let mut dash = false;
    for c in session.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(120).collect();
    if trimmed.is_empty() {
        "imported-session".to_owned()
    } else {
        trimmed
    }
}

fn ms(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Node `isImportedHistoryMessage`.
fn is_imported(message: &messages::WithParts, source: &str) -> bool {
    let id = message.info["id"].as_str().unwrap_or_default();
    let numbered = id
        .strip_prefix("msg_import_")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit()));
    numbered
        || id.starts_with("msg_claude-import-")
        || message.info["metadata"]["migrationSource"] == source
        || message
            .parts
            .iter()
            .any(|part| part["metadata"]["migrationSource"] == source)
}

/// Node `removePreviousImportedSessionHistory`: clears the session's earlier import messages (their parts go with
/// them) and keeps the rest. A legacy create refuses an existing id, so a fresh session has none; it still runs, as in
/// Node, so rows an older build wrote under the fixed ids never survive a new import.
fn remove_previous(conn: &Connection, session: &str, source: &str) -> Result<usize, StoreError> {
    let mut removed = 0;
    for message in messages::messages(conn, session).storage()? {
        if !is_imported(&message, source) {
            continue;
        }
        let id = message.info["id"].as_str().unwrap_or_default();
        conn.execute(
            "delete from message where id = ? and session_id = ?",
            params![id, session],
        )
        .storage()?;
        removed += 1;
    }
    Ok(removed)
}

/// Writes the import into the session's row. `now` is the save time (`Date.now()` of Node's `saveMessage` / `savePart`).
pub(crate) fn write(
    conn: &Connection,
    session: &SessionId,
    history: &ImportedHistory,
    now: i64,
) -> Result<(), StoreError> {
    let id = session.as_str();
    let row = sessions::get(conn, id)
        .storage()?
        .ok_or_else(|| StoreError::NotFound {
            session: session.clone(),
        })?;
    let mode = state::execution(conn, &row)
        .storage()?
        .unwrap_or_default()
        .mode;
    // Node's `currentModel` comes from the model string (`provider/model`), which carries no options.
    let selection = state::selection(conn, id).storage()?.and_then(|selection| {
        let provider = selection["providerId"].as_str()?.to_owned();
        let model = selection["modelId"].as_str()?.to_owned();
        Some((provider, model))
    });
    let first = history.messages.first().and_then(|m| m.timestamp);
    let last = history.messages.last().and_then(|m| m.timestamp);
    let created = history.created_at.or(first).map_or(now, ms);
    let updated = history.updated_at.or(last).map_or(created, ms);
    let updated = created.max(updated);
    let title = history
        .title
        .as_deref()
        .map(rust_cli_base::js::string::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("Imported session");
    // `time_created` is not in the upsert's conflict update, as in Node: a row Node creates here is new, so the
    // creation time is the import's.
    conn.prepare_cached(
        "update session set title = ?, title_source = 'custom', title_message_id = null, slug = ?, \
         time_created = ?, time_updated = ?, time_title_updated = ? where id = ?",
    )
    .storage()?
    .execute(params![title, slug(id), created, updated, updated, id])
    .storage()?;

    remove_previous(conn, id, "claudeCode")?;
    let mut parent: Option<String> = None;
    let mut last_stamp = created - 1;
    for (index, message) in history.messages.iter().enumerate() {
        let raw = message
            .timestamp
            .map_or(created + i64::try_from(index).unwrap_or(0), ms);
        // Array order is the truth: timestamps only ever increase (the store reads by `time_created`).
        let stamp = if raw > last_stamp {
            raw
        } else {
            last_stamp + 1
        };
        last_stamp = stamp;
        let message_id = format!("msg_{id}_import_{index}");
        let info = if message.assistant {
            let mut info = json!({
                "id": message_id,
                "sessionID": id,
                "role": "assistant",
                "time": {"created": stamp, "completed": stamp},
                "parentID": parent.clone().unwrap_or_else(|| format!("msg_{id}_import_parent_{index}")),
            });
            if let Some((provider, model)) = &selection {
                info["modelId"] = json!(model);
                info["providerId"] = json!(provider);
            }
            info["mode"] = json!(mode);
            info["agent"] = json!("zcode-agent");
            info["path"] = json!({"cwd": row.directory, "root": row.directory});
            info["cost"] = json!(0);
            info["tokens"] =
                json!({"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}});
            info["finish"] = json!("stop");
            info
        } else {
            parent = Some(message_id.clone());
            let mut info = json!({
                "id": message_id,
                "sessionID": id,
                "role": "user",
                "time": {"created": stamp},
                "agent": "zcode-agent",
            });
            if let Some((provider, model)) = &selection {
                info["modelSelection"] = json!({"providerId": provider, "modelId": model});
            }
            info["metadata"] = json!({"migrationSource": "claudeCode"});
            info
        };
        messages::save_message(conn, &info, now).storage()?;
        let part: Value = json!({
            "id": format!("part_{id}_import_{index}_text"),
            "sessionID": id,
            "messageID": message_id,
            "type": "text",
            "text": message.content,
            "time": {"start": stamp, "end": stamp},
            "metadata": {"migrationSource": "claudeCode"},
        });
        messages::save_part(conn, &part, now).storage()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "import_history_tests.rs"]
mod tests;
