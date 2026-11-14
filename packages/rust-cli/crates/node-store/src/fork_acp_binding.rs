//! Fork: a session's ACP binding and config (Node `fork-acp-session-binding.ts`, specs/acp-agent-runtime.md "S5" and
//! "S6"). The binding lives in `fork_acp_session_binding` (Node migrations 9003 and 9004); the choices made before the
//! first turn live in `fork_acp_session_choice` (9005).
//!
//! The tables belong to the Node agent's fork migrations: zcode-rs adds no migration. A database Node never migrated
//! has neither table; it then holds no binding and no choices (reads answer empty), and a write is `Unsupported`.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use rust_cli_kernel_api::store::{AcpSessionBinding, AcpSessionConfig, StoreError};
use serde_json::{Map, Value};

use crate::OrStorage;

/// Node's error for a choice written for a binding of another agent (`writeChoice`).
const BOUND_TO_OTHER_AGENT: &str = "the ACP session is bound to another agent";

/// Whether the binding table has all the columns of migrations 9003 and 9004.
fn binding_table(conn: &Connection) -> Result<bool, StoreError> {
    conn.query_row(
        "select count(*) = 8 from pragma_table_info('fork_acp_session_binding')
         where name in ('session_id', 'agent_id', 'acp_session_id', 'cwd', 'launch_key', 'updated_at',
                        'config_options', 'config_choices')",
        [],
        |row| row.get(0),
    )
    .storage()
}

/// Whether the pending choice table of migration 9005 exists.
fn choice_table(conn: &Connection) -> Result<bool, StoreError> {
    conn.query_row(
        "select count(*) = 4 from pragma_table_info('fork_acp_session_choice')
         where name in ('session_id', 'agent_id', 'config_choices', 'updated_at')",
        [],
        |row| row.get(0),
    )
    .storage()
}

/// Writes need both tables: the binding write moves pending choices, so a database with one table only is refused.
fn require_tables(conn: &Connection) -> Result<(), StoreError> {
    if binding_table(conn)? && choice_table(conn)? {
        return Ok(());
    }
    Err(StoreError::Unsupported {
        what: "ACP session binding (the database has no fork_acp tables)".to_owned(),
    })
}

/// Node's `Date.now()` for the `updated_at` columns.
fn stamp(now_ms: u64) -> i64 {
    i64::try_from(now_ms).unwrap_or(i64::MAX)
}

pub(crate) fn binding(
    conn: &Connection,
    session: &str,
) -> Result<Option<AcpSessionBinding>, StoreError> {
    if !binding_table(conn)? {
        return Ok(None);
    }
    conn.query_row(
        "select agent_id, acp_session_id, cwd, launch_key from fork_acp_session_binding where session_id = ?1",
        [session],
        |row| {
            Ok(AcpSessionBinding {
                agent_id: row.get::<_, String>(0)?,
                acp_session_id: row.get::<_, String>(1)?,
                cwd: row.get::<_, String>(2)?,
                launch_key: row.get::<_, String>(3)?,
            })
        },
    )
    .optional()
    .storage()
}

/// Node `readConfig`: the binding's config; without a binding, the pending choices stand for the configuration.
pub(crate) fn config(conn: &Connection, session: &str) -> Result<AcpSessionConfig, StoreError> {
    if binding_table(conn)? {
        let row = conn
            .query_row(
                "select agent_id, config_options, config_choices from fork_acp_session_binding where session_id = ?1",
                [session],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .storage()?;
        if let Some((agent_id, offered, choices)) = row {
            return Ok(AcpSessionConfig {
                agent_id: Some(agent_id),
                offered: offered.as_deref().and_then(parse_offered),
                choices: parse_choices(choices.as_deref()),
            });
        }
    }
    Ok(match pending(conn, session)? {
        Some((agent_id, choices)) => AcpSessionConfig {
            agent_id: Some(agent_id),
            offered: None,
            choices: parse_choices(Some(&choices)),
        },
        None => AcpSessionConfig::default(),
    })
}

/// Node `write`: upserts the binding columns; pending choices of the same agent move into `config_choices` (binding
/// values first, pending values override), pending choices of another agent are dropped. One write lock.
pub(crate) fn set_binding(
    conn: &mut Connection,
    session: &str,
    binding: &AcpSessionBinding,
    now_ms: u64,
) -> Result<(), StoreError> {
    require_tables(conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .storage()?;
    tx.execute(
        "insert into fork_acp_session_binding
           (session_id, agent_id, acp_session_id, cwd, launch_key, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(session_id) do update set
           agent_id = excluded.agent_id,
           acp_session_id = excluded.acp_session_id,
           cwd = excluded.cwd,
           launch_key = excluded.launch_key,
           updated_at = excluded.updated_at",
        params![
            session,
            binding.agent_id,
            binding.acp_session_id,
            binding.cwd,
            binding.launch_key,
            stamp(now_ms)
        ],
    )
    .storage()?;
    if let Some((pending_agent, pending_choices)) = pending(&tx, session)? {
        if pending_agent == binding.agent_id {
            let mut choices = stored_choices(&tx, session)?;
            choices.extend(parse_choices(Some(&pending_choices)));
            tx.execute(
                "update fork_acp_session_binding set config_choices = ?2 where session_id = ?1",
                params![session, to_json(&choices)?],
            )
            .storage()?;
        }
        tx.execute(
            "delete from fork_acp_session_choice where session_id = ?1",
            [session],
        )
        .storage()?;
    }
    tx.commit().storage()
}

/// Node `clear`: deletes the binding row (with its offered options and choices) and any pending choices. A table
/// that does not exist holds nothing to delete.
pub(crate) fn clear(conn: &Connection, session: &str) -> Result<(), StoreError> {
    if binding_table(conn)? {
        conn.execute(
            "delete from fork_acp_session_binding where session_id = ?1",
            [session],
        )
        .storage()?;
    }
    if choice_table(conn)? {
        conn.execute(
            "delete from fork_acp_session_choice where session_id = ?1",
            [session],
        )
        .storage()?;
    }
    Ok(())
}

/// Node `writeOffered`: replaces the offered options of an existing binding; no row, no change.
pub(crate) fn set_offered(
    conn: &Connection,
    session: &str,
    offered: &Value,
    now_ms: u64,
) -> Result<(), StoreError> {
    require_tables(conn)?;
    conn.execute(
        "update fork_acp_session_binding set config_options = ?2, updated_at = ?3 where session_id = ?1",
        params![session, offered.to_string(), stamp(now_ms)],
    )
    .storage()?;
    Ok(())
}

/// Node `writeChoice`: a binding of `agent_id` keeps the value in its choices; without a binding it is a pending
/// choice (replacing the pending row's choices when the pending row is of another agent).
pub(crate) fn set_choice(
    conn: &mut Connection,
    session: &str,
    agent_id: &str,
    config_id: &str,
    value: &str,
    now_ms: u64,
) -> Result<(), StoreError> {
    require_tables(conn)?;
    let now = stamp(now_ms);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .storage()?;
    if let Some(bound) = bound_agent(&tx, session)? {
        if bound != agent_id {
            return Err(StoreError::Storage {
                message: BOUND_TO_OTHER_AGENT.to_owned(),
            });
        }
        let mut choices = stored_choices(&tx, session)?;
        choices.insert(config_id.to_owned(), value.to_owned());
        tx.execute(
            "update fork_acp_session_binding set config_choices = ?2, updated_at = ?3 where session_id = ?1",
            params![session, to_json(&choices)?, now],
        )
        .storage()?;
    } else {
        let mut choices = match pending(&tx, session)? {
            Some((pending_agent, text)) if pending_agent == agent_id => parse_choices(Some(&text)),
            _ => BTreeMap::new(),
        };
        choices.insert(config_id.to_owned(), value.to_owned());
        tx.execute(
            "insert into fork_acp_session_choice (session_id, agent_id, config_choices, updated_at)
             values (?1, ?2, ?3, ?4)
             on conflict(session_id) do update set
               agent_id = excluded.agent_id,
               config_choices = excluded.config_choices,
               updated_at = excluded.updated_at",
            params![session, agent_id, to_json(&choices)?, now],
        )
        .storage()?;
    }
    tx.commit().storage()
}

/// The pending choice row of a session as (agent id, stored choices text).
fn pending(conn: &Connection, session: &str) -> Result<Option<(String, String)>, StoreError> {
    if !choice_table(conn)? {
        return Ok(None);
    }
    conn.query_row(
        "select agent_id, config_choices from fork_acp_session_choice where session_id = ?1",
        [session],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .storage()
}

fn bound_agent(conn: &Connection, session: &str) -> Result<Option<String>, StoreError> {
    conn.query_row(
        "select agent_id from fork_acp_session_binding where session_id = ?1",
        [session],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .storage()
}

/// The binding's stored `config_choices`; empty without a binding or a value.
fn stored_choices(
    conn: &Connection,
    session: &str,
) -> Result<BTreeMap<String, String>, StoreError> {
    let text = conn
        .query_row(
            "select config_choices from fork_acp_session_binding where session_id = ?1",
            [session],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .storage()?;
    Ok(parse_choices(text.flatten().as_deref()))
}

fn to_json(choices: &BTreeMap<String, String>) -> Result<String, StoreError> {
    serde_json::to_string(choices).storage()
}

/// A malformed stored value is treated as absent: the next turn writes a fresh snapshot (Node `parseOffered`).
fn parse_offered(text: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    is_offered(&parsed).then_some(parsed)
}

/// Node `parseChoices`: a JSON object; entries whose value is not a string are skipped.
fn parse_choices(text: Option<&str>) -> BTreeMap<String, String> {
    let Some(Value::Object(entries)) =
        text.and_then(|text| serde_json::from_str::<Value>(text).ok())
    else {
        return BTreeMap::new();
    };
    entries
        .into_iter()
        .filter_map(|(config_id, value)| match value {
            Value::String(value) => Some((config_id, value)),
            _ => None,
        })
        .collect()
}

/// Node `isConfigOption` over every element: the shape of `ExternalAgentConfigOption[]`.
fn is_offered(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|options| options.iter().all(is_config_option))
}

fn is_config_option(value: &Value) -> bool {
    let Some(option) = value.as_object() else {
        return false;
    };
    has_string(option, "id")
        && has_string(option, "name")
        && has_nullable_string(option, "description")
        && has_nullable_string(option, "category")
        && has_string(option, "currentValue")
        && option
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|entries| entries.iter().all(is_config_entry))
}

fn is_config_entry(value: &Value) -> bool {
    let Some(entry) = value.as_object() else {
        return false;
    };
    has_string(entry, "value")
        && has_string(entry, "name")
        && has_nullable_string(entry, "description")
        && has_nullable_string(entry, "group")
}

fn has_string(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).is_some_and(Value::is_string)
}

fn has_nullable_string(object: &Map<String, Value>, key: &str) -> bool {
    object
        .get(key)
        .is_some_and(|value| value.is_null() || value.is_string())
}

#[cfg(test)]
#[path = "fork_acp_binding_tests.rs"]
mod tests;
