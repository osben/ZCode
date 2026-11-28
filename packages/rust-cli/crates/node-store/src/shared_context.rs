//! Fork: the stored shared context of an imported session (`session/create` with `importedHistory.source =
//! "sharedContext"`; specs/fork-rust-imported-history.md, Shared context). Node's `commitSharedContextImportBundle`
//! writes the session row's title and times, one hidden `model-only` message with one text part, and the
//! `v4/shared_context_import` entry; `transitionSharedContextImport` moves the entry's status. The rows here are the
//! same, byte for byte in `data`, so the Node app and CLI read them back (and the reverse).
use rusqlite::Connection;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{SharedContextImport, SharedContextTransition, StoreError};
use serde_json::{Value, json};

use crate::OrStorage;
use crate::repo::entries::{self, Entry};
use crate::repo::{messages, sessions};
use crate::state;

/// The `session_entry.type` of the share's provenance.
pub(crate) const ENTRY_TYPE: &str = "v4/shared_context_import";

fn ms(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// The entry of a context (Node matches `data.contextId`).
fn entry_of(conn: &Connection, session: &str, context: &str) -> Result<Option<Entry>, StoreError> {
    Ok(entries::list(conn, session, Some(ENTRY_TYPE))
        .storage()?
        .into_iter()
        .find(|entry| entry.data["contextId"] == context))
}

/// Node `commitSharedContextImportBundle` on the session's row (a draft's row is made by the caller in the same
/// transaction). `now` is the save time (`Date.now()` of the bundle's writes).
pub(crate) fn write(
    conn: &Connection,
    session: &SessionId,
    import: &SharedContextImport,
    now: i64,
) -> Result<(), StoreError> {
    let id = session.as_str();
    sessions::get(conn, id)
        .storage()?
        .ok_or_else(|| StoreError::NotFound {
            session: session.clone(),
        })?;
    let text = |key: &str| import.provenance.get(key).and_then(Value::as_str);
    let share = text("shareId").unwrap_or_default();
    let entry_id = format!("v4_shared_context_import:{id}:{share}");
    // Node returns the stored session when the bundle's session exists and has the entry: nothing is written twice.
    if entries::list(conn, id, Some(ENTRY_TYPE))
        .storage()?
        .iter()
        .any(|entry| entry.id == entry_id)
    {
        return Ok(());
    }
    let created = import.created_at.map_or(now, ms);
    let context =
        text("contextId").map_or_else(|| format!("legacy-shared-context-{id}"), str::to_owned);
    let status = text("status").unwrap_or("pending").to_owned();
    // `time_created` is not in the upsert's conflict update, as in Node: a row Node creates here is new, so the
    // creation time is the import's.
    conn.prepare_cached(
        "update session set title = ?, title_source = 'custom', title_message_id = null, slug = ?, \
         time_created = ?, time_updated = ?, time_title_updated = ? where id = ?",
    )
    .storage()?
    .execute(rusqlite::params![
        import.title,
        crate::import_history::slug(id),
        created,
        created,
        created,
        id
    ])
    .storage()?;
    // Node's `currentModel` comes from the model string (`provider/model`), which carries no options.
    let selection = state::selection(conn, id).storage()?.and_then(|selection| {
        Some(json!({
            "providerId": selection["providerId"].as_str()?,
            "modelId": selection["modelId"].as_str()?,
        }))
    });
    let message_id = format!("msg_{id}_shared_context");
    let mut info = json!({
        "id": message_id,
        "sessionID": id,
        "role": "user",
        "time": {"created": created},
        "agent": "zcode-agent",
    });
    if let Some(selection) = selection {
        info["modelSelection"] = selection;
    }
    info["synthetic"] = json!(true);
    info["source"] = json!("shared_context");
    info["visibility"] = json!("model-only");
    info["semantics"] = json!({
        "origin": "import",
        "kind": "shared_context",
        "source": "conversation_share",
        "uiVisibility": "hidden",
        "providerVisibility": "visible",
        "transcriptVisibility": "visible",
    });
    info["metadata"] = json!({
        "shareId": share,
        "contextId": context,
        "sharedContextStatus": status,
    });
    messages::save_message(conn, &info, now).storage()?;
    let part = json!({
        "id": format!("part_{id}_shared_context_text"),
        "sessionID": id,
        "messageID": message_id,
        "type": "text",
        "text": import.markdown,
        "time": {"start": created, "end": created},
        "metadata": {"sharedContext": true},
    });
    messages::save_part(conn, &part, now).storage()?;
    // `{...provenance, contextId, status}`: a key the provenance has keeps its place, a missing one goes last.
    let mut data = import.provenance.clone();
    data.insert("contextId".to_owned(), json!(context));
    data.insert("status".to_owned(), json!(status));
    entries::save(
        conn,
        &Entry {
            id: entry_id,
            session_id: id.to_owned(),
            kind: ENTRY_TYPE.to_owned(),
            time_created: created,
            time_updated: created,
            data: Value::Object(data),
            touch_session: true,
        },
    )
    .storage()
}

/// Sets the context message's `metadata.sharedContextStatus` (Node re-saves the message with the merged metadata).
fn set_message_status(
    conn: &Connection,
    session: &str,
    context: &str,
    status: &str,
    now: i64,
) -> Result<(), StoreError> {
    let found = messages::messages(conn, session)
        .storage()?
        .into_iter()
        .find(|message| message.info["metadata"]["contextId"] == context);
    let Some(message) = found else {
        return Ok(());
    };
    let mut info = message.info;
    info["metadata"]["sharedContextStatus"] = json!(status);
    messages::save_message(conn, &info, now).storage()
}

/// The hidden message of a context and its text (Node's turn joins the text parts with a newline and trims).
pub(crate) fn text(
    conn: &Connection,
    session: &str,
    context: &str,
) -> Result<Option<rust_cli_kernel_api::store::SharedContextText>, StoreError> {
    let found = messages::messages(conn, session)
        .storage()?
        .into_iter()
        .find(|message| {
            message.info["role"] == "user"
                && message.info["source"] == "shared_context"
                && message.info["metadata"]["contextId"] == context
        });
    Ok(found.map(|message| {
        let text: Vec<&str> = message
            .parts
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect();
        rust_cli_kernel_api::store::SharedContextText {
            message: rust_cli_kernel_api::ids::MessageId::new(message.id()),
            text: rust_cli_base::js::string::trim(&text.join("\n")).to_owned(),
        }
    }))
}

/// Node `transitionSharedContextImport`.
pub(crate) fn transition(
    conn: &Connection,
    session: &SessionId,
    transition: &SharedContextTransition,
    now: i64,
) -> Result<bool, StoreError> {
    let id = session.as_str();
    let Some(mut entry) = entry_of(conn, id, &transition.context_id)? else {
        return Ok(false);
    };
    let current = entry.data["status"].as_str().unwrap_or_default();
    if !transition.expected.iter().any(|status| status == current) {
        return Ok(false);
    }
    let Some(data) = entry.data.as_object_mut() else {
        return Ok(false);
    };
    data.insert("status".to_owned(), json!(transition.status));
    if let Some(source) = &transition.source_id {
        data.insert("sourceId".to_owned(), json!(source));
    }
    entry.time_updated = now;
    entries::save(conn, &entry).storage()?;
    set_message_status(conn, id, &transition.context_id, &transition.status, now)?;
    Ok(true)
}

/// Node `promoteSessionInput`, the shared context part: the user message that carries `sharedContextRefs` in its
/// `metadata.inputIntent` attaches the context in the same transaction. A missing entry or one that is neither
/// `pending` nor `reserved` is an error, which rolls the message back (Node throws).
pub(crate) fn attach(
    conn: &Connection,
    session: &str,
    message: &str,
    refs: &Value,
    now: i64,
) -> Result<(), StoreError> {
    let Some(refs) = refs.as_array() else {
        return Ok(());
    };
    for reference in refs {
        if reference["kind"] != "shared_context_import" {
            continue;
        }
        let Some(context) = reference["context_id"].as_str() else {
            continue;
        };
        let Some(mut entry) = entry_of(conn, session, context)? else {
            return Err(crate::storage("shared context import is missing"));
        };
        if !matches!(entry.data["status"].as_str(), Some("pending" | "reserved")) {
            return Err(crate::storage(
                "shared context import is no longer attachable",
            ));
        }
        let Some(data) = entry.data.as_object_mut() else {
            return Err(crate::storage(
                "shared context import is no longer attachable",
            ));
        };
        data.insert("status".to_owned(), json!("attached"));
        data.insert("attachedMessageId".to_owned(), json!(message));
        entry.time_updated = now;
        entries::save(conn, &entry).storage()?;
        set_message_status(conn, session, context, "attached", now)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "shared_context_tests.rs"]
mod tests;
