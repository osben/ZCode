// 复制自 apps/zcode-cli-rust/crates/domain/src/node_journal/records.rs（feat/rs 79b6691c55）。
//! Node 记录模板（Node `message-persistence.ts`、`turn-model-step.ts`、`turn-step-finish.ts`、
//! `execution-state.ts`、`events.ts`）。键按 Node 对象字面量的顺序插入，存储的 JSON 与 Node
//! 逐字节一致（docs/specs/rust-m11-node-storage.md §2.3）。纯函数，没有 IO。
//!
//! 与复制来源的差异：只保留文本回合用到的模板（工具 part、shell 快照等之后按需加入）。
use crate::keys::{self, EntryKey};
use rust_cli_kernel_api::model::ModelSelection;
use serde_json::{Map, Value, json};

pub const AGENT: &str = "zcode-agent";
pub const MODEL_SELECTION_ENTRY: &str = crate::codecs::MODEL_SELECTION_ENTRY;
/// part `metadata` 里本工程的成员名。
pub const RUST_CLI: &str = "rustCli";
pub const EXECUTION_STATE_ENTRY: &str = "runtime/execution_state";
/// Fork (B3): Node `PERMISSION_FULL_ACCESS_ENTRY`, a permission mode grant's receipt.
pub const PERMISSION_FULL_ACCESS_ENTRY: &str = "runtime/permission_full_access";

/// Node `titleFromInput`（唯一定义在 kernel-api，会话 actor 用同一个函数更新内存里的标题）。
pub fn title_from_input(input: &str) -> String {
    rust_cli_kernel_api::title::from_input(input)
}

/// Node `toTokenUsageInfo`，输入是 Node 归一化后的用量（`inputTokens` 等）。
pub fn tokens(usage: Option<&Value>) -> Value {
    let field = |key: &str| {
        usage.map_or(json!(0), |u| {
            u.get(key)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(0))
        })
    };
    let mut out = Map::new();
    if let Some(total) = usage
        .and_then(|u| u.get("totalTokens"))
        .filter(|v| !v.is_null())
    {
        out.insert("total".into(), total.clone());
    }
    out.insert("input".into(), field("inputTokens"));
    out.insert("output".into(), field("outputTokens"));
    out.insert("reasoning".into(), field("reasoningTokens"));
    out.insert(
        "cache".into(),
        json!({"read": field("cacheReadTokens"), "write": field("cacheWriteTokens")}),
    );
    Value::Object(out)
}

/// Node `buildProjectionAnchor`。
pub fn anchor(turn: Option<&str>, origin: Option<&str>, command: Option<&str>) -> Option<Value> {
    if turn.is_none() && origin.is_none() && command.is_none() {
        return None;
    }
    let mut out = Map::new();
    if let Some(turn) = turn.filter(|t| !t.is_empty()) {
        out.insert("turnId".into(), turn.into());
    }
    if let Some(origin) = origin {
        out.insert("origin".into(), origin.into());
    }
    if let Some(command) = command.filter(|c| !c.is_empty()) {
        out.insert("sourceCommandId".into(), command.into());
    }
    Some(Value::Object(out))
}

/// 一条 session entry（`SessionEntryInfo`）。
pub fn entry(id: String, session: &str, kind: &str, now: u64, data: Value, touch: bool) -> Value {
    let mut out = json!({"id": id, "sessionID": session, "type": kind});
    if !touch {
        out["touchSession"] = false.into();
    }
    out["time"] = json!({"created": now, "updated": now});
    out["data"] = data;
    out
}

/// Node `persistRuntimeModelSelection`。
pub fn model_selection_entry(session: &str, now: u64, selection: Value) -> Value {
    entry(
        format!("{session}:runtime-model-selection"),
        session,
        MODEL_SELECTION_ENTRY,
        now,
        selection,
        false,
    )
}

/// `rust-cli/model_connection` 这条 entry（`keys::MODEL_CONNECTION`）；选择不带团队项目时没有。选择的团队项目（工作线
/// F49，docs/specs/rust-cli/node-store.md §4）：Node 的 `modelSelectionSchema` 是 strict，团队项目不能放进
/// `runtime/model_selection`，另存这一条；冷读取时 `providerId` / `modelId` 对得上才用。
pub fn model_connection_entry(
    session: &str,
    now: u64,
    selection: &ModelSelection,
) -> Option<Value> {
    let connection = selection.connection.as_deref()?;
    let data = json!({
        "providerId": selection.provider,
        "modelId": selection.model,
        "connection": connection,
    });
    Some(entry(
        EntryKey::single(session, keys::MODEL_CONNECTION).encode(),
        session,
        &keys::named(keys::MODEL_CONNECTION),
        now,
        data,
        false,
    ))
}

/// Node `buildExecutionStateEntry`。
pub fn execution_state_entry(session: &str, now: u64, mode: &str, plan: bool) -> Value {
    entry(
        format!("{session}:runtime-execution-state"),
        session,
        EXECUTION_STATE_ENTRY,
        now,
        json!({"mode": mode, "planEnabled": plan}),
        false,
    )
}

/// One side of a permission mode grant: the Node mode name and plan switch.
#[derive(Debug, Clone, Copy)]
pub struct GrantState<'a> {
    pub mode: &'a str,
    pub plan: bool,
}

/// What a permission mode grant's receipt records ([`permission_full_access_entry`]).
#[derive(Debug, Clone)]
pub struct GrantReceipt<'a> {
    pub interaction: &'a str,
    /// The `session_mode_changed` event's id and trace (both non-empty) and sequence number.
    pub event: &'a str,
    pub trace: &'a str,
    pub sequence: u64,
    pub previous: GrantState<'a>,
    pub next: GrantState<'a>,
    pub queue_items: &'a [String],
}

/// Fork (B3): Node `grantPermissionMode`'s receipt (`permissionFullAccessReceiptSchema`, every level `.strict()`):
/// `{interactionId, event}`, the event a `session_mode_changed` with `source: "command"` and `permissionGrant`. No
/// `turnId` (optional in Node, absent rather than null); `timestamp` is epoch milliseconds (`z.coerce.date`).
pub fn permission_full_access_entry(session: &str, now: u64, receipt: &GrantReceipt<'_>) -> Value {
    let event = json!({
        "id": receipt.event,
        "sessionId": session,
        "traceId": receipt.trace,
        "type": "session_mode_changed",
        "timestamp": now,
        "sequenceNumber": receipt.sequence,
        "payload": {
            "mode": receipt.next.mode,
            "planEnabled": receipt.next.plan,
            "previousMode": receipt.previous.mode,
            "previousPlanEnabled": receipt.previous.plan,
            "source": "command",
            "permissionGrant": {
                "interactionId": receipt.interaction,
                "queueItemIds": receipt.queue_items,
            },
        },
    });
    entry(
        format!("{session}:permission-full-access:{}", receipt.interaction),
        session,
        PERMISSION_FULL_ACCESS_ENTRY,
        now,
        json!({"interactionId": receipt.interaction, "event": event}),
        false,
    )
}

/// Fork (B3): the interaction of a stored grant receipt when it is one of `session`'s and matches Node's
/// `permissionFullAccessReceiptSchema` (every level `.strict()`, enum modes, the grant naming the receipt's interaction).
/// An invalid receipt or another session's is ignored (Node `restorePermissionGrantMarker`).
pub fn permission_grant_of(session: &str, data: &Value) -> Option<String> {
    let receipt = strict(data, &["interactionId", "event"], &[])?;
    let interaction = non_empty(&receipt["interactionId"])?;
    let event = strict(
        &receipt["event"],
        &[
            "id",
            "sessionId",
            "traceId",
            "type",
            "timestamp",
            "sequenceNumber",
            "payload",
        ],
        &["turnId"],
    )?;
    non_empty(&event["id"])?;
    non_empty(&event["traceId"])?;
    let turn_ok = event.get("turnId").is_none_or(Value::is_string);
    // `z.coerce.date`: `new Date(value)` accepts numbers, strings, booleans and null; objects and arrays are invalid.
    let time_ok = matches!(
        event["timestamp"],
        Value::Number(_) | Value::String(_) | Value::Bool(_) | Value::Null
    );
    let payload = strict(
        &event["payload"],
        &[
            "mode",
            "planEnabled",
            "previousMode",
            "previousPlanEnabled",
            "source",
            "permissionGrant",
        ],
        &[],
    )?;
    let grant = strict(
        &payload["permissionGrant"],
        &["interactionId", "queueItemIds"],
        &[],
    )?;
    let queue_ok = grant["queueItemIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().all(|id| non_empty(id).is_some()));
    let valid = turn_ok
        && time_ok
        && queue_ok
        && event["sessionId"] == session
        && event["type"] == "session_mode_changed"
        && event["sequenceNumber"].as_u64().is_some()
        && matches!(payload["mode"].as_str(), Some("guarded" | "yolo"))
        && matches!(
            payload["previousMode"].as_str(),
            Some("build" | "edit" | "yolo" | "guarded" | "auto" | "plan")
        )
        && payload["planEnabled"].is_boolean()
        && payload["previousPlanEnabled"].is_boolean()
        && payload["source"] == "command"
        && grant["interactionId"].as_str() == Some(interaction);
    valid.then(|| interaction.to_owned())
}

/// The object `value` when it has every `required` key and no key outside `required` and `optional` (zod `.strict()`).
fn strict<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    let object = value.as_object()?;
    let known = |key: &str| required.contains(&key) || optional.contains(&key);
    (required.iter().all(|key| object.contains_key(*key)) && object.keys().all(|key| known(key)))
        .then_some(object)
}

fn non_empty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

const USER_SEMANTICS: [(&str, &str); 5] = [
    ("origin", "real_user"),
    ("kind", "user_prompt"),
    ("uiVisibility", "visible"),
    ("providerVisibility", "visible"),
    ("transcriptVisibility", "visible"),
];

const ASSISTANT_SEMANTICS: [(&str, &str); 5] = [
    ("origin", "agent_runtime"),
    ("kind", "assistant_response"),
    ("uiVisibility", "visible"),
    ("providerVisibility", "visible"),
    ("transcriptVisibility", "visible"),
];

/// 只给模型看的 assistant（续写占位，node-store.md §4.2.1，工作线 F77）：Node 的写法，App 的投影不显示，Node 续写时
/// 照常进模型上下文。
pub const MODEL_ONLY_ASSISTANT_SEMANTICS: [(&str, &str); 5] = [
    ("origin", "agent_runtime"),
    ("kind", "assistant_response"),
    ("uiVisibility", "hidden"),
    ("providerVisibility", "visible"),
    ("transcriptVisibility", "hidden"),
];

fn semantics(fields: [(&str, &str); 5]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
    )
}

/// `persistUserPrompt` 记录的 user 输入事实。
pub struct UserPrompt<'a> {
    pub id: &'a str,
    pub session: &'a str,
    pub created: u64,
    pub selection: Option<Value>,
    pub turn: &'a str,
    pub command: Option<&'a str>,
    /// Fork: the App input's stored intent ([`crate::input_intent::message_metadata`]).
    pub metadata: Option<Value>,
}

/// Node `persistUserPrompt` 的消息。`agent` 是 `zcode-agent`；没有工具目录时 `tools` 为 `{}`。
pub fn user_message(p: &UserPrompt) -> Value {
    let mut out = json!({"id": p.id, "sessionID": p.session, "role": "user",
        "time": {"created": p.created}, "agent": AGENT});
    if let Some(selection) = &p.selection {
        out["modelSelection"] = selection.clone();
    }
    out["semantics"] = semantics(USER_SEMANTICS);
    if let Some(anchor) = anchor(Some(p.turn), Some("realUser"), p.command) {
        out["anchor"] = anchor;
    }
    out["tools"] = json!({});
    if let Some(metadata) = &p.metadata {
        out["metadata"] = metadata.clone();
    }
    out
}

/// 带起止时间的 text part（user 输入的 text part 起止都是消息创建时间）。
pub fn text_part(
    id: String,
    (session, message): (&str, &str),
    text: &str,
    (start, end): (u64, u64),
) -> Value {
    json!({"id": id, "sessionID": session, "messageID": message, "type": "text", "text": text,
        "time": {"start": start, "end": end}})
}

/// user 输入的 text part（Node `persistUserPrompt`）：`text` 是界面原文；与模型文本不同时，模型文本在
/// `metadata.modelInput`（Node `USER_MODEL_INPUT_METADATA_KEY`）。
pub fn user_text_part(
    id: String,
    (session, message): (&str, &str),
    (text, model): (&str, Option<&str>),
    (start, end): (u64, u64),
) -> Value {
    let mut out =
        json!({"id": id, "sessionID": session, "messageID": message, "type": "text", "text": text});
    if let Some(model) = model {
        out["metadata"] = json!({"modelInput": model});
    }
    out["time"] = json!({"start": start, "end": end});
    out
}

/// reasoning part；`metadata` 是推理块的 providerOptions。
pub fn reasoning_part(
    id: String,
    (session, message): (&str, &str),
    text: &str,
    metadata: Option<Value>,
    (start, end): (u64, u64),
) -> Value {
    let mut out = json!({"id": id, "sessionID": session, "messageID": message,
        "type": "reasoning", "text": text});
    if let Some(metadata) = metadata {
        out["metadata"] = metadata;
    }
    out["time"] = json!({"start": start, "end": end});
    out
}

pub fn step_start_part(id: String, (session, message): (&str, &str)) -> Value {
    json!({"id": id, "sessionID": session, "messageID": message, "type": "step-start"})
}

pub fn step_finish_part(
    id: String,
    (session, message): (&str, &str),
    reason: &str,
    tokens: Value,
) -> Value {
    json!({"id": id, "sessionID": session, "messageID": message, "type": "step-finish",
        "reason": reason, "cost": 0, "tokens": tokens})
}

/// `persistAssistantMessage` 记录的 assistant 事实。
pub struct Assistant<'a> {
    pub id: &'a str,
    pub session: &'a str,
    pub parent: &'a str,
    pub created: u64,
    pub completed: u64,
    pub provider: &'a str,
    pub model: &'a str,
    pub mode: &'a str,
    pub plan: bool,
    pub directory: &'a str,
    pub tokens: Value,
    pub finish: &'a str,
    pub turn: Option<&'a str>,
    /// 只给模型看（续写占位，§4.2.1）：`semantics` 用 [`MODEL_ONLY_ASSISTANT_SEMANTICS`]。
    pub model_only: bool,
}

/// Node `persistAssistantMessage` 的已完成消息（`cwd` 与 `root` 都是会话目录）。
pub fn assistant_message(a: &Assistant) -> Value {
    let time = json!({ "created": a.created, "completed": a.completed });
    let mut out = json!({"id": a.id, "sessionID": a.session, "role": "assistant", "time": time});
    out["parentID"] = a.parent.into();
    for (key, value) in [("modelId", a.model), ("providerId", a.provider)] {
        if !value.is_empty() {
            out[key] = value.into();
        }
    }
    out["mode"] = a.mode.into();
    out["planEnabled"] = a.plan.into();
    out["agent"] = AGENT.into();
    out["path"] = json!({"cwd": a.directory, "root": a.directory});
    out["cost"] = 0.into();
    out["tokens"] = a.tokens.clone();
    out["finish"] = a.finish.into();
    out["semantics"] = semantics(if a.model_only {
        MODEL_ONLY_ASSISTANT_SEMANTICS
    } else {
        ASSISTANT_SEMANTICS
    });
    if let Some(anchor) = anchor(a.turn, None, None) {
        out["anchor"] = anchor;
    }
    out
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
