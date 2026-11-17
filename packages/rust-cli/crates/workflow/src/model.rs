//! Run-level vocabulary shared by the engine and the journal (Node `types.ts`: `RunStatus`,
//! `RunStopReason`, `Caps`, `RunRecord`, `RunSettlementRecord`, `StoredEvent`).
//!
//! Numbers that are JavaScript numbers in Node stay `f64` here (caps, spent tokens): the journal and
//! the event payloads print them with `Number::toString`, so `2.7` and `1e21` come out as Node writes them.
use serde_json::{Map, Value};

/// Node `RunStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RunStatus {
    Pending,
    #[default]
    Running,
    Completed,
    Errored,
    Stopped,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Errored => "errored",
            Self::Stopped => "stopped",
        }
    }
}

/// Node `RunStopReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    User,
    Model,
    Provider,
    Interrupted,
    Superseded,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Model => "model",
            Self::Provider => "provider",
            Self::Interrupted => "interrupted",
            Self::Superseded => "superseded",
        }
    }
}

impl StopReason {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "user" => Self::User,
            "model" => Self::Model,
            "provider" => Self::Provider,
            "interrupted" => Self::Interrupted,
            "superseded" => Self::Superseded,
            _ => return None,
        })
    }
}

/// Node `Caps`: the run's concurrency ceiling, a JavaScript number.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Caps {
    pub max_concurrency: f64,
}

impl Caps {
    /// Node `{ maxConcurrency }` as the event and row payloads write it.
    pub fn to_json(self) -> Value {
        let mut map = Map::new();
        map.insert("maxConcurrency".into(), js_number(self.max_concurrency));
        Value::Object(map)
    }
}

/// A JavaScript number as a JSON value. Non-finite numbers become `null`, as `JSON.stringify` does.
pub fn js_number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// Node `RunSettlementRecord`: the terminal data written with a status. Absent fields are `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settlement {
    pub stop_reason: Option<StopReason>,
    pub superseded_by: Option<String>,
    pub failure: Option<Value>,
    pub result: Option<Value>,
}

/// Node `RunRecord`, as the journal stores it. Optional fields follow Node's absent-key rule.
#[derive(Debug, Clone, PartialEq)]
pub struct RunRow {
    pub run_id: String,
    pub parent_session_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub tool_call_id: Option<String>,
    pub script_text: Option<String>,
    pub script_hash: Option<String>,
    pub args: Option<Value>,
    pub resumed_from: Option<String>,
    pub caps: Caps,
    pub spent_tokens: f64,
    pub status: RunStatus,
    pub stop_reason: Option<StopReason>,
    pub superseded_by: Option<String>,
    pub failure: Option<Value>,
    pub result: Option<Value>,
}

impl RunRow {
    /// Node `getRun` as `JSON.stringify` shows it (absent fields are omitted).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("runId".into(), Value::String(self.run_id.clone()));
        map.insert("caps".into(), self.caps.to_json());
        map.insert("spentTokens".into(), js_number(self.spent_tokens));
        map.insert("status".into(), Value::String(self.status.as_str().into()));
        insert_text(&mut map, "scriptText", &self.script_text);
        if let Some(args) = &self.args {
            map.insert("args".into(), args.clone());
        }
        insert_text(&mut map, "name", &self.name);
        insert_text(&mut map, "scriptHash", &self.script_hash);
        insert_text(&mut map, "parentSessionId", &self.parent_session_id);
        insert_text(&mut map, "cwd", &self.cwd);
        insert_text(&mut map, "toolCallId", &self.tool_call_id);
        insert_text(&mut map, "resumedFrom", &self.resumed_from);
        if let Some(reason) = self.stop_reason {
            map.insert("stopReason".into(), Value::String(reason.as_str().into()));
        }
        insert_text(&mut map, "supersededBy", &self.superseded_by);
        if let Some(failure) = &self.failure {
            map.insert("failure".into(), failure.clone());
        }
        if let Some(result) = &self.result {
            map.insert("result".into(), result.clone());
        }
        Value::Object(map)
    }
}

fn insert_text(map: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(text) = value {
        map.insert(key.into(), Value::String(text.clone()));
    }
}

/// Node `StoredEvent`: the sequence and the event's exact JSON text as written (key order included).
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub sequence: u64,
    pub payload_json: String,
}
