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

/// Node `InstanceRef` / `ActorRef`: `siteId` × per-site ordinal (the ordinal starts at 1).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Ref {
    pub site_id: String,
    pub ordinal: u64,
}

impl Ref {
    pub fn new(site_id: impl Into<String>, ordinal: u64) -> Self {
        Self {
            site_id: site_id.into(),
            ordinal,
        }
    }

    /// Node `refToString`: `site@ordinal`, the key of the instance and actor tables.
    pub fn key(&self) -> String {
        Self::key_of(&self.site_id, self.ordinal)
    }

    /// The key of `site@ordinal` without building a `Ref` (for rows that already own their site).
    pub fn key_of(site_id: &str, ordinal: u64) -> String {
        format!("{site_id}@{ordinal}")
    }

    /// `{siteId, ordinal}` as Node writes the ref in events.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("siteId".into(), Value::String(self.site_id.clone()));
        map.insert("ordinal".into(), Value::from(self.ordinal));
        Value::Object(map)
    }
}

/// Node `Violation` (schema/types.ts): where a value failed, what was expected, and what arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: String,
    pub expected: String,
    pub got: String,
}

impl Violation {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("path".into(), Value::String(self.path.clone()));
        map.insert("expected".into(), Value::String(self.expected.clone()));
        map.insert("got".into(), Value::String(self.got.clone()));
        Value::Object(map)
    }

    pub fn from_json(json: &Value) -> Option<Self> {
        Some(Self {
            path: json.get("path")?.as_str()?.to_owned(),
            expected: json.get("expected")?.as_str()?.to_owned(),
            got: json.get("got")?.as_str()?.to_owned(),
        })
    }
}

/// Node `NodeKind`. Only `ask` rows are written by the scheduler so far; the others are read by the
/// replay filters and arrive with their own rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Ask,
    WorldRead,
    WorldRun,
    Report,
    Artifact,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::WorldRead => "world-read",
            Self::WorldRun => "world-run",
            Self::Report => "report",
            Self::Artifact => "artifact",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "ask" => Self::Ask,
            "world-read" => Self::WorldRead,
            "world-run" => Self::WorldRun,
            "report" => Self::Report,
            "artifact" => Self::Artifact,
            _ => return None,
        })
    }
}

/// Node `NodeRecordStatus`: an ask is `running` from admission until it settles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeStatus {
    Running,
    Completed,
    Failed,
}

impl NodeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

/// Node `dwf_node` record, unique on (run, site, ordinal). Asks also carry the actor coordinates,
/// `actorSeq` and `inputHash`. `stats` is the JSON object the driver reported; the engine drops
/// `worldToolCalls` from it when the transcript predates the dispatch.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeRow {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: u64,
    pub kind: NodeKind,
    pub actor_site_id: Option<String>,
    pub actor_ordinal: Option<u64>,
    pub actor_seq: Option<u64>,
    pub input_hash: String,
    pub status: NodeStatus,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub stats: Option<Value>,
    /// Node `input` (`WorldReadInput`, bounded): written at admission of a world node, carried through the
    /// settlement upsert. Absent on asks.
    pub input: Option<Value>,
    /// Node `messageBoundary`: ask rows only, written by the driver after the exchange (see
    /// `Engine::set_message_boundary`). A count, invariant under prefix copies.
    pub message_boundary: Option<u64>,
}

impl NodeRow {
    /// Node's stored record as `JSON.stringify` writes it (absent fields omitted). Compared canonically.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("runId".into(), Value::String(self.run_id.clone()));
        map.insert("siteId".into(), Value::String(self.site_id.clone()));
        map.insert("ordinal".into(), Value::from(self.ordinal));
        map.insert("kind".into(), Value::String(self.kind.as_str().into()));
        insert_text(&mut map, "actorSiteId", &self.actor_site_id);
        if let Some(ordinal) = self.actor_ordinal {
            map.insert("actorOrdinal".into(), Value::from(ordinal));
        }
        if let Some(seq) = self.actor_seq {
            map.insert("actorSeq".into(), Value::from(seq));
        }
        map.insert("inputHash".into(), Value::String(self.input_hash.clone()));
        map.insert("status".into(), Value::String(self.status.as_str().into()));
        if let Some(result) = &self.result {
            map.insert("result".into(), result.clone());
        }
        if let Some(error) = &self.error {
            map.insert("error".into(), error.clone());
        }
        if let Some(stats) = &self.stats {
            map.insert("stats".into(), stats.clone());
        }
        if let Some(input) = &self.input {
            map.insert("input".into(), input.clone());
        }
        if let Some(boundary) = self.message_boundary {
            map.insert("messageBoundary".into(), Value::from(boundary));
        }
        Value::Object(map)
    }
}

/// Node `ActorRecord`, unique on (run, site, ordinal). `persona` is the normalized persona JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct ActorRow {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: u64,
    pub name: Option<String>,
    pub persona: Option<Value>,
    pub session_id: Option<String>,
    pub resolved_model: Option<String>,
}

impl ActorRow {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("runId".into(), Value::String(self.run_id.clone()));
        map.insert("siteId".into(), Value::String(self.site_id.clone()));
        map.insert("ordinal".into(), Value::from(self.ordinal));
        insert_text(&mut map, "name", &self.name);
        if let Some(persona) = &self.persona {
            map.insert("persona".into(), persona.clone());
        }
        insert_text(&mut map, "sessionId", &self.session_id);
        insert_text(&mut map, "resolvedModel", &self.resolved_model);
        Value::Object(map)
    }
}
