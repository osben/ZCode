//! Fork: the workflow child's contract (specs/fork-rust-workflow-engine.md, 4.1 and 9.18 decision 1).
//!
//! The NDJSON wire is the sandbox child's message shape. `ChildHandler` is the engine side of Boundary A: the transport
//! in `protocol-zcode` (`workflow_host`) reads the child's lines and calls the handler. The handler moved here from
//! `protocol-zcode` in W7-5 so the run service in `runtime` can implement it without depending on the protocol crate.
//! The wire shapes moved unchanged from `protocol-zcode`'s `workflow_wire`.
//!
//! The shapes are those of `dynamic-workflow-runtime/src/protocol.ts`, which is the source of truth: a field added there is
//! added here. Unknown fields are ignored, so a newer child with extra fields still reads; a missing required field, or a
//! `kind`/`type` this module does not know, is a malformed line.

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The engine side of Boundary A. Methods are synchronous except the request's future, which runs while the host
/// keeps reading lines, so asks in flight do not hold up the child's next message.
pub trait ChildHandler: Send + Sync {
    /// Creates the actor in the engine and returns its engine id. An `Err` refuses the actor and carries the reason,
    /// which ends the run.
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String>;

    /// Starts one request. `actor_id` is the engine id of the request's actor, resolved by the host.
    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>>;

    /// Handles one event, in the order the child wrote it.
    fn event(&self, event: ChildEvent);
}

/// A child → host message. The tag is `kind`, as in `ChildMessage`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChildMessage {
    CreateActor(CreateActor),
    Request(ChildRequest),
    Event(ChildEvent),
    Complete(Completion),
}

/// `create-actor`: no answer. `local_id` is the child's handle, mapped to the engine's id before any later request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateActor {
    pub local_id: String,
    pub site_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub persona: Option<Value>,
}

/// The kinds of `request`: an ask, a world read, a content artifact publish, or a hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestType {
    Ask,
    WorldRead,
    PublishArtifact,
    Hole,
}

/// `request`: answered by a `response` with the same `id`. `actor` is the child's handle; the host resolves it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildRequest {
    pub id: String,
    #[serde(rename = "type")]
    pub request_type: RequestType,
    pub site_id: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub artifact_op: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<Value>>,
}

/// `event`: fire and forget, handled in line order. The `type` tag is the event kind.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ChildEvent {
    Log {
        message: String,
    },
    Report {
        site_id: String,
        #[serde(default)]
        item: Value,
        #[serde(default)]
        artifact_id: Option<String>,
    },
    DeclareArtifact {
        site_id: String,
        op: String,
        args: Vec<Value>,
    },
    PhaseEntered {
        name: String,
    },
}

/// `complete`: the script's end, a value or an error. The child sends nothing after it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub ok: bool,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub error: Option<WireError>,
}

/// `WireError`: a structured error that crosses the boundary (ask refusals keep `code`, `violations` and `finalText`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub violations: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// The host → child line that answers one request.
pub fn response_line(id: &str, answer: &Result<Value, WireError>) -> String {
    let line = match answer {
        Ok(value) => json!({"kind": "response", "id": id, "ok": true, "value": value}),
        Err(error) => json!({"kind": "response", "id": id, "ok": false, "error": error}),
    };
    format!("{line}\n")
}
