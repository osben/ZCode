//! 冷读取：会话行、活动分支上的消息、模型选择与模式；会话列表
//! （docs/specs/rust-cli/node-store.md §5，docs/specs/rust-m11-node-storage.md §6）。
use rusqlite::Connection;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId, MessageId, SessionId, TraceId, TurnId};
use rust_cli_kernel_api::incognito::IncognitoProfile;
use rust_cli_kernel_api::model::{ModelConnection, ModelSelection};
use rust_cli_kernel_api::permission::ExecutionState;
use rust_cli_kernel_api::store::{
    LoadedSession, SessionKind, SessionMeta, SessionSummary, TurnAnchor,
};
use rust_cli_kernel_api::store::{SessionFilter, StoreError};
use serde_json::Value;

use crate::branch::{Branch, active_messages, earlier_messages};
use crate::facts::{live_session, unsupported};
use crate::keys;
use crate::mode;
use crate::repo::messages;
use crate::repo::sessions::{self, SessionRow};
use crate::state;
use crate::{LOCAL_ENVIRONMENT, OrStorage};

/// 冷读取的会话；`checkpoints` 留空，由调用方按 [`crate::rewind::Active`] 补出（Node 写的要读产物目录，不在
/// 数据库线程里做，修复线 F12）。
pub fn load(
    conn: &Connection,
    session: &SessionId,
) -> Result<(LoadedSession, Vec<crate::rewind::Active>), StoreError> {
    // Fork: Node `SqliteSessionStore.getSession` hides a session with a purge row (specs/fork-rust-agent-parity.md
    // "Session runtime presence on the shared database").
    if crate::presence::is_purging(conn, session.as_str())? {
        return Err(StoreError::NotFound {
            session: session.clone(),
        });
    }
    let row = live_session(conn, session)?;
    let records = messages::messages(conn, session.as_str()).storage()?;
    let branch = Branch::from_revert(row.revert.as_ref());
    let active = active_messages(&records, &branch, true);
    // 压缩点之前的历史只供显示（工作线 F102，compact.md §5.1）；模型侧的历史仍是 `active`，单独转换，结果不变。
    let earlier = earlier_messages(&records, &branch, &active);
    let model = state::selection(conn, session.as_str())
        .storage()?
        .as_ref()
        .map(kernel_selection)
        .map(|selection| with_connection(conn, session, selection))
        .transpose()?;
    let execution = execution_state(conn, &row)?;
    // 库里的当前轮：会话 actor 打开会话时的起点（node-store.md §4，修复线 F6）。
    let turn = state::current_user(conn, session.as_str())
        .storage()?
        .map(|(prompt, turn)| TurnAnchor {
            prompt: MessageId::new(prompt),
            turn: turn.map(TurnId::new),
        });
    let loaded = LoadedSession {
        commands: commands(&records),
        message_models: message_models(&records),
        messages: crate::hydrate::hydrate(&active),
        earlier: crate::hydrate::hydrate(&earlier),
        model,
        mode: execution.map(|state| state.mode),
        plan: execution.is_some_and(|state| state.plan),
        meta: meta(&row),
        // Fork: Node `isAutoTitlePending` (specs/fork-rust-agent-parity.md, first-input title timing).
        goal_target: crate::goal_target::load(conn, session)?,
        goal_verifications: crate::goal_verify::load(conn, session)?,
        title_pending: matches!(
            row.title_source.as_deref().unwrap_or("first_input"),
            "default" | "first_input"
        ),
        title_source: row
            .title_source
            .as_deref()
            .map(rust_cli_kernel_api::title::Source::stored),
        permission_grant: permission_grant(conn, session)?,
        checkpoints: Vec::new(),
        turn: turn.clone(),
        // 续写时补 assistant 的判断（session-lifecycle.md §6.3.1）：当前轮的 `turn_usage` 是错误。
        last_turn_failed: match &turn {
            Some(anchor) => {
                crate::repo::usage::turn_failed(conn, session.as_str(), anchor.prompt.as_str())
                    .storage()?
            }
            None => false,
        },
        // Fork: set by `fork_execution_worktree::run_in_worktree` after the load.
        execution_worktree: false,
    };
    Ok((loaded, crate::rewind::active_checkpoints(conn, session)?))
}

/// Fork (B3): Node `restorePermissionGrantMarker`: the last stored grant receipt names the composer's adoption key; an
/// invalid one or another session's is ignored (logged, the cold read goes on).
fn permission_grant(conn: &Connection, session: &SessionId) -> Result<Option<String>, StoreError> {
    let stored = crate::repo::entries::list(
        conn,
        session.as_str(),
        Some(crate::records::PERMISSION_FULL_ACCESS_ENTRY),
    )
    .storage()?;
    let Some(last) = stored.last() else {
        return Ok(None);
    };
    let grant = crate::records::permission_grant_of(session.as_str(), &last.data);
    if grant.is_none() {
        tracing::warn!(
            event = "session.resume.permission_grant_invalid",
            session = %session,
            "ignoring an invalid permission grant receipt"
        );
    }
    Ok(grant)
}

/// Fork: the `anchor.sourceCommandId` of each user message (Node `buildProjectionAnchor` writes it for typed input), so
/// a cold projection can correlate its rows with the App's pending commands.
fn commands(records: &[messages::WithParts]) -> std::collections::BTreeMap<MessageId, CommandId> {
    records
        .iter()
        .filter(|record| record.info["role"] == "user")
        .filter_map(|record| {
            let command = record.info["anchor"]["sourceCommandId"].as_str()?;
            (!command.is_empty()).then(|| (MessageId::new(record.id()), CommandId::new(command)))
        })
        .collect()
}

/// Fork: Node's highspeed card providers (`packages/shared/src/highspeed.ts`): a single turn's execution model, not the
/// session's, so cold resume does not read it as a switch (Node `sessionModelSelectionOfHydratedMessage`).
const HIGHSPEED_PROVIDERS: [&str; 2] = [
    "account:zai-highspeed-card",
    "account:bigmodel-highspeed-card",
];

/// Fork: the stored model of each assistant message, read like Node `assistantModelSelectionOf` (not a timeline event,
/// both ids present, highspeed providers left out), for the cold model switch divider.
fn message_models(
    records: &[messages::WithParts],
) -> std::collections::BTreeMap<MessageId, ModelSelection> {
    records
        .iter()
        .filter(|record| record.info["role"] == "assistant")
        .filter(|record| record.info["semantics"]["kind"] != "timeline_event")
        .filter_map(|record| {
            let provider = record.info["providerId"]
                .as_str()
                .filter(|id| !id.is_empty())?;
            let model = record.info["modelId"]
                .as_str()
                .filter(|id| !id.is_empty())?;
            if HIGHSPEED_PROVIDERS.contains(&provider) {
                return None;
            }
            let selection = ModelSelection {
                reasoning: record.info["reasoningLevel"].as_str().map(str::to_owned),
                ..ModelSelection::new(provider.to_owned(), model.to_owned())
            };
            Some((MessageId::new(record.id()), selection))
        })
        .collect()
}

pub fn list(conn: &Connection, filter: &SessionFilter) -> Result<Vec<SessionSummary>, StoreError> {
    if filter.workspace.environment.as_str() != LOCAL_ENVIRONMENT {
        return Err(unsupported("sessions of a remote environment"));
    }
    // 本目录的顶层会话与 fork 出的会话，按活动时间倒序（session-lifecycle.md §6.2）。
    let limit = i64::try_from(filter.limit).unwrap_or(i64::MAX);
    let rows = sessions::list(conn, filter.workspace.root.as_str(), Some(limit)).storage()?;
    Ok(rows
        .into_iter()
        .map(|row| SessionSummary {
            id: SessionId::new(row.id),
            title: row.title,
            updated_at_ms: u64::try_from(row.time_updated).unwrap_or(0),
            created_at_ms: u64::try_from(row.time_created).unwrap_or(0),
            last_outcome: row.last_outcome,
            parent: row.parent_id.map(SessionId::new),
            title_source: row.title_source,
            incognito: row.incognito.is_some(),
        })
        .collect())
}

fn meta(row: &SessionRow) -> SessionMeta {
    let kind = match row.task_type.as_str() {
        "subagent_child" => SessionKind::Subagent,
        "fork" | "selection_side_chat" => SessionKind::Fork,
        _ => SessionKind::Interactive,
    };
    SessionMeta {
        id: SessionId::new(row.id.as_str()),
        kind,
        parent: row.parent_id.as_deref().map(SessionId::new),
        workspace: WorkspaceRef {
            // 远程会话的 workspace_id 是 Node 的远程 identity；本地为 NULL。
            environment: EnvironmentId::new(
                row.workspace_id.as_deref().unwrap_or(LOCAL_ENVIRONMENT),
            ),
            root: EnvPath::new(row.directory.as_str()),
        },
        title: row.title.clone(),
        // Node 会话都写 traceID；缺失时（极旧的会话）链路 ID 取会话 ID。
        trace: TraceId::new(row.trace_id.as_deref().unwrap_or(&row.id)),
        created_at_ms: u64::try_from(row.time_created).unwrap_or(0),
        // Fork: a present column never reads as a normal session (unparseable values read as lockdown).
        incognito: row.incognito.as_deref().map(IncognitoProfile::from_stored),
    }
}

/// Node `ModelSelection` → 内核的模型选择。
fn kernel_selection(selection: &Value) -> ModelSelection {
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    ModelSelection {
        reasoning: selection["options"]["reasoningLevel"]
            .as_str()
            .map(str::to_owned),
        ..ModelSelection::new(text(&selection["providerId"]), text(&selection["modelId"]))
    }
}

/// 团队项目（工作线 F49，node-store.md §5 第 5 条）：`rust-cli/model_connection` 的 `providerId` / `modelId` 与 Node 的
/// 选择相同才用（Node 或 App 之后换过模型时不套用）；三个 ID 都要是去空白后非空的字符串。
fn with_connection(
    conn: &Connection,
    session: &SessionId,
    mut selection: ModelSelection,
) -> Result<ModelSelection, StoreError> {
    let Some(data) =
        state::last_entry(conn, session.as_str(), &keys::named(keys::MODEL_CONNECTION))
            .storage()?
    else {
        return Ok(selection);
    };
    let matches = data["providerId"] == selection.provider.as_str()
        && data["modelId"] == selection.model.as_str();
    let connection = serde_json::from_value::<ModelConnection>(data["connection"].clone())
        .ok()
        .filter(|connection| {
            [
                &connection.product_id,
                &connection.organization_id,
                &connection.project_id,
            ]
            .iter()
            .all(|id| !rust_cli_base::js::string::trim(id).is_empty())
        });
    if matches {
        selection.connection = connection.map(Box::new);
    }
    Ok(selection)
}

/// Node 执行状态对应的权限模式与 plan 开关（修复线 F20）；`rust-cli/permission_mode` 记的模式与执行状态一致时用它
/// （区分 default 与 dontAsk），Node 续写改过模式后以 Node 为准。
fn execution_state(
    conn: &Connection,
    row: &SessionRow,
) -> Result<Option<ExecutionState>, StoreError> {
    let Some(execution) = state::execution(conn, row).storage()? else {
        return Ok(None);
    };
    let named = state::last_entry(conn, &row.id, &keys::named(keys::PERMISSION_MODE))
        .storage()?
        .and_then(|data| data["mode"].as_str().and_then(mode::from_entry_name));
    Ok(Some(mode::read(&execution, named)))
}

#[cfg(test)]
#[path = "load_turn_tests.rs"]
mod turn_tests;
