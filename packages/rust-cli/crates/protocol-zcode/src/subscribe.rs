//! 订阅（docs/specs/rust-cli/app-protocol.md §6）：`v4/conversation/subscribe` / `unsubscribe` / `resync`、
//! `v4/connection/flow` 与 `v4/sessionsIndex/reconcile`。P1 只有 desktop-continuous：回复只有 ACK（mode 一律 snapshot），
//! 首帧在回复之后发；resync 一律回快照。

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::panels::WorkspaceSession;
use rust_cli_kernel_api::store::SessionFilter;
use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::index::{CONFIG_PREFIX, INDEX_PREFIX, Summary};
use crate::live::{CONVERSATION_PREFIX, Live};
use crate::projection::state::Phase;
use crate::server::{Server, kernel_error};
use crate::wire::Purpose;
use rust_cli_protocol_core::sessions::Bridged;

/// 会话列表的快照最多从存储里取这么多个会话。
const STORED_SESSIONS_LIMIT: usize = 200;

/// 存储里一个工作区的会话 → 会话列表的行。
pub(crate) async fn stored_rows(server: &Server, workspace: &str) -> Vec<Value> {
    let filter = SessionFilter {
        workspace: server.workspace(workspace),
        limit: STORED_SESSIONS_LIMIT,
    };
    match server.kernel.workspace_sessions(filter).await {
        Ok(sessions) => {
            let queries = server.kernel.queries();
            let mut rows = Vec::with_capacity(sessions.len());
            for session in sessions {
                // Fork: the kernel lists open sessions the store has no row for; a prewarm draft is one of them and
                // stays out of the seed like Node's gateway `isDraftSession` (fork-agent-runtime-selection.md).
                if session.activity.is_some()
                    && queries
                        .is_rowless_draft(&session.summary.id)
                        .await
                        .unwrap_or(false)
                {
                    continue;
                }
                rows.push(cold_row(workspace, &session));
            }
            rows
        }
        Err(error) => {
            tracing::warn!(event = "protocol.index.read_failed", error = %error, "listing the workspace sessions failed");
            Vec::new()
        }
    }
}

/// A stored session with no live projection → its sessions-index row.
fn cold_row(workspace: &str, session: &WorkspaceSession) -> Value {
    let summary = &session.summary;
    // Fork: like Node's cold summary, report the stored creation time and the persisted
    // outcome; a session with no finished turn carries no `lastOutcome`.
    let outcome = summary.last_outcome.as_deref();
    let phase = match outcome {
        Some("error") => Phase::Error,
        Some("interrupted") => Phase::CompletedInterrupted,
        _ => Phase::CompletedSuccess,
    };
    let created_at = match summary.created_at_ms {
        0 => summary.updated_at_ms,
        created => created,
    };
    let mut row = Summary {
        session: summary.id.as_str(),
        workspace,
        title: &summary.title,
        phase,
        created_at,
        activity_at: summary.updated_at_ms,
        last_reply: session.last_reply.as_deref(),
        permissions: 0,
    }
    .to_value();
    if let Some(fields) = row.as_object_mut() {
        if outcome.is_none() {
            fields.remove("lastOutcome");
        }
        // Fork: a stored fork keeps its ancestry like Node's cold summary, so the Host admits it into its parent's
        // project instead of as an ordinary session.
        if let Some(parent) = &summary.parent {
            fields.insert("parentSessionId".to_owned(), json!(parent.as_str()));
        }
    }
    row
}

fn ack(subscription: &str, epoch: &str) -> Value {
    json!({"ack": {"subscriptionId": subscription, "mode": "snapshot", "logEpoch": epoch}})
}

pub async fn subscribe(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default().to_owned();
    let connection = params["connectionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        let live = server
            .live(&SessionId::new(session))
            .await
            .map_err(|error| kernel_error(&error))?;
        let subscription = server.context.fresh("sub");
        let epoch = live.sink.subscribe(&subscription, &connection);
        return Ok(Reply::then(
            ack(&subscription, &epoch),
            start_on_pump(live, subscription, Purpose::Initial),
        ));
    }
    let index = topic.strip_prefix(INDEX_PREFIX);
    if index.is_none() && !topic.starts_with(CONFIG_PREFIX) {
        return Err(RpcError::invalid_params(format!("unknown topic {topic}")));
    }
    let stored = match index {
        Some(workspace) => stored_rows(server, workspace).await,
        None => Vec::new(),
    };
    let subscription = server
        .context
        .fresh(if index.is_some() { "six" } else { "wcs" });
    let epoch = server.topics.subscribe(&topic, &subscription, &connection);
    let topics = server.topics.clone();
    let id = subscription.clone();
    Ok(Reply::then(
        ack(&subscription, &epoch),
        Box::new(move || {
            topics.start(topic, id, stored, Purpose::Initial);
            Box::pin(async {})
        }),
    ))
}

pub async fn unsubscribe(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default();
    let subscription = params["subscriptionId"].as_str().unwrap_or_default();
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        if let Some(live) = server.bridge.get(&SessionId::new(session)) {
            live.sink.unsubscribe(subscription);
        }
    } else {
        server.topics.unsubscribe(topic, subscription);
    }
    Ok(Reply::new(json!({})))
}

/// 重新同步：P1 一律回快照（续传在 P2）。
pub async fn resync(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default().to_owned();
    let subscription = params["subscriptionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let gone = || RpcError::invalid_params(format!("unknown subscription {subscription}"));
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        let live = server
            .bridge
            .get(&SessionId::new(session))
            .ok_or_else(gone)?;
        let epoch = live.sink.restart(&subscription).ok_or_else(gone)?;
        return Ok(Reply::then(
            ack(&subscription, &epoch),
            start_on_pump(live, subscription, Purpose::Recovery),
        ));
    }
    let epoch = server
        .topics
        .restart(&topic, &subscription)
        .ok_or_else(gone)?;
    let stored = match topic.strip_prefix(INDEX_PREFIX) {
        Some(workspace) => stored_rows(server, workspace).await,
        None => Vec::new(),
    };
    let topics = server.topics.clone();
    let id = subscription.clone();
    Ok(Reply::then(
        ack(&subscription, &epoch),
        Box::new(move || {
            topics.start(topic, id, stored, Purpose::Recovery);
            Box::pin(async {})
        }),
    ))
}

/// 下游背压：P1 只在 closed 时去掉这条连接的订阅（暂停与恢复在 P2）。
pub async fn flow(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    if params["state"] == "closed" {
        let connection = params["connectionId"].as_str().unwrap_or_default();
        server.topics.drop_connection(connection);
        rust_cli_base::sync::LockUnpoisoned::lock_unpoisoned(&server.uploads)
            .clear_connection(connection);
        for live in server.bridge.sessions() {
            live.sink.drop_connection(connection);
        }
    }
    Ok(Reply::new(json!({})))
}

/// 会话列表对账：按 sessionIds 回存在与否、标题与时间。
///
/// Fork: like Node `reconcileSessions`, the stored row decides `exists` / `deleted` (soft-deleted
/// rows stay `exists: true, deleted: true`, so the App's task index records the delete), and a
/// row from another workspace answers `exists: false`. A live session keeps its projection's
/// title and activity. Stores without the row read keep the older live/snapshot answer.
pub async fn reconcile(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let workspace = params["workspaceId"].as_str().unwrap_or_default();
    let mut ids: Vec<&str> = Vec::new();
    for id in params["sessionIds"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        // Node dedupes with `new Set(sessionIds)`.
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let queries = server.kernel.queries();
    let mut sessions = Vec::new();
    for id in ids {
        let session = SessionId::new(id);
        let live = server.bridge.get(&session).map(|live| live.sink.summary());
        let entry = match queries.reconcile_row(&session).await {
            Ok(row) => stored_entry(id, workspace, row.as_ref(), live.as_ref()),
            Err(_) => {
                let row = match live {
                    Some(row) => Some(row),
                    None => match server.kernel.session_snapshot(&session).await {
                        Ok(view) => Some(
                            Summary {
                                session: id,
                                workspace,
                                title: &view.meta.title,
                                phase: Phase::CompletedSuccess,
                                created_at: view.meta.created_at_ms,
                                activity_at: view.meta.created_at_ms,
                                last_reply: None,
                                permissions: 0,
                            }
                            .to_value(),
                        ),
                        Err(_) => None,
                    },
                };
                match row {
                    Some(row) => summary_entry(id, false, &row),
                    None => missing(id),
                }
            }
        };
        sessions.push(entry);
    }
    Ok(Reply::new(json!({"sessions": sessions})))
}

fn missing(id: &str) -> Value {
    json!({"sessionId": id, "exists": false, "deleted": false})
}

fn summary_entry(id: &str, deleted: bool, row: &Value) -> Value {
    let mut entry = json!({
        "sessionId": id,
        "exists": true,
        "deleted": deleted,
        "title": row["title"],
        "titleSource": row["titleSource"],
        "createdAt": row["createdAt"],
        "updatedAt": row["lastActivityAt"],
    });
    if let Some(outcome) = row.get("lastOutcome").filter(|outcome| !outcome.is_null()) {
        entry["lastOutcome"] = outcome.clone();
    }
    entry
}

/// Node `normalizeStoredTitleSource`.
fn title_source(source: Option<&str>) -> &'static str {
    match source {
        Some("custom") => "custom",
        Some("default") => "default",
        _ => "generated",
    }
}

/// Node `reconcileSessions` for one stored row (`StoreQueries::reconcile_row`). The workspace
/// check is Node's local branch (`directory === workspaceId`, no foreign `workspaceID`); zcode-rs
/// serves local workspaces only, so the remote-identity branch is not ported.
pub(crate) fn stored_entry(
    id: &str,
    workspace: &str,
    row: Option<&Value>,
    live: Option<&Value>,
) -> Value {
    let Some(row) = row else {
        return missing(id);
    };
    let same_workspace = row["directory"].as_str() == Some(workspace)
        && row["workspaceId"]
            .as_str()
            .is_none_or(|stored| stored == workspace);
    if !same_workspace {
        return missing(id);
    }
    let deleted = !row["timeDeleted"].is_null();
    let title_updated_at = if row["timeTitleUpdated"].is_null() {
        &row["timeCreated"]
    } else {
        &row["timeTitleUpdated"]
    };
    if let Some(live) = live {
        let mut entry = summary_entry(id, deleted, live);
        entry["titleUpdatedAt"] = title_updated_at.clone();
        return entry;
    }
    let mut entry = json!({
        "sessionId": id,
        "exists": true,
        "deleted": deleted,
        "title": row["title"],
        "titleSource": title_source(row["titleSource"].as_str()),
        "titleUpdatedAt": title_updated_at,
        "createdAt": row["timeCreated"],
        "updatedAt": row["timeUpdated"],
    });
    if let Some(outcome) = row["lastOutcome"].as_str() {
        entry["lastOutcome"] = json!(outcome);
    }
    entry
}

/// 新建的会话马上进会话列表（在会话的泵任务里发）。
pub fn announce(live: &Arc<Bridged<Live>>) {
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.publish_summary().await }));
}

/// 回复之后在会话的泵任务里发首帧（排在已经收到的事件之后）。
fn start_on_pump(
    live: Arc<Bridged<Live>>,
    subscription: String,
    purpose: Purpose,
) -> rust_cli_protocol_core::connection::After {
    Box::new(move || {
        let sink = live.sink.clone();
        live.run(Box::pin(
            async move { sink.start(&subscription, purpose).await },
        ));
        Box::pin(async {})
    })
}

#[cfg(test)]
#[path = "subscribe_reconcile_tests.rs"]
mod reconcile_tests;
