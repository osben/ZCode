//! Fork: the helper's live plugin UI deltas and its panel instances (specs/fork-rust-node-helper.md F3,
//! `helper/session/delta` and "Crash").
//!
//! The helper sends Node's four live-only `pluginUi.*` deltas as `helper/session/delta`; they are handled in the
//! connection's read loop and handed to the protocol server, which appends them to the session's stream in its pump
//! order. A helper that goes away cannot close its panels, so Rust remembers the instances each generation opened
//! (`mcp/uiOpenInstance` answers) and, when that generation's slot is dropped, closes the ones still open with
//! `pluginUi.instanceClosed`, Node's own payload for a closed instance.

use std::sync::Weak;

use rust_cli_base::Spawner;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use super::NodeHelper;

pub(super) const SESSION_DELTA: &str = "helper/session/delta";

/// The live-only deltas the helper may send (Node's `product-projection.ts` mapping of the plugin UI events).
pub(crate) const PLUGIN_UI_OPS: &[&str] = &[
    "pluginUi.resourceUpdated",
    "pluginUi.resourceListChanged",
    "pluginUi.instanceClosed",
    "pluginUi.appToolCall",
];

const INSTANCE_CLOSED: &str = "pluginUi.instanceClosed";
const OPEN_INSTANCE: &str = "mcp/uiOpenInstance";
const CLOSE_INSTANCE: &str = "mcp/uiCloseInstance";

/// One generation's open panel instances, in open order.
pub(super) struct Panels {
    open: Vec<Panel>,
    helper: Weak<NodeHelper>,
    spawner: Spawner,
}

struct Panel {
    token: String,
    session: String,
    /// The `pluginUi.instanceClosed` delta that closes it.
    closed: Value,
}

impl Panels {
    pub(super) fn new(helper: Weak<NodeHelper>, spawner: Spawner) -> Self {
        Self {
            open: Vec::new(),
            helper,
            spawner,
        }
    }

    fn forget(&mut self, token: &str) {
        self.open.retain(|panel| panel.token != token);
    }

    /// The helper closed `session` and its panels with it.
    pub(super) fn forget_session(&mut self, session: &str) {
        self.open.retain(|panel| panel.session != session);
    }
}

impl Drop for Panels {
    /// The slot is dropped outside the state lock, but not always outside other locks, so the closes are sent from a
    /// task.
    fn drop(&mut self) {
        if self.open.is_empty() {
            return;
        }
        let open = std::mem::take(&mut self.open);
        let helper = self.helper.clone();
        drop(self.spawner.spawn("node-helper-panels-closed", async move {
            let Some(answers) = helper.upgrade().and_then(|helper| helper.answers()) else {
                return;
            };
            for panel in open {
                answers.session_delta(&panel.session, panel.closed);
            }
        }));
    }
}

/// The instance's token: Node's `subscribers[0].scopeId` is the instance token.
fn subscriber_token(delta: &Value) -> Option<&str> {
    delta
        .pointer("/subscribers/0/scopeId")
        .and_then(Value::as_str)
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

impl NodeHelper {
    /// `helper/session/delta {sessionId, delta}` of `generation`, in the read loop. Other ops are dropped.
    pub(super) fn session_delta(&self, generation: u64, params: &Value) {
        let Some(session) = non_empty(params.get("sessionId")) else {
            return;
        };
        let Some(delta) = params.get("delta").filter(|delta| {
            delta
                .get("op")
                .and_then(Value::as_str)
                .is_some_and(|op| PLUGIN_UI_OPS.contains(&op))
        }) else {
            tracing::debug!(
                event = "helper.session_delta.dropped",
                "a helper session delta is not a plugin UI delta"
            );
            return;
        };
        if delta["op"] == INSTANCE_CLOSED
            && let Some(token) = subscriber_token(delta)
        {
            self.with_running(generation, |running| running.panels.forget(token));
        }
        if let Some(answers) = self.answers() {
            answers.session_delta(session, delta.clone());
        }
    }

    /// Tracks the panel instances a forwarded call of `generation` opened or closed. An open answered after its
    /// generation is gone fails: nothing could close that panel later.
    pub(super) fn panel_answered(
        &self,
        generation: u64,
        method: &str,
        params: &Value,
        result: Result<Value, RpcError>,
    ) -> Result<Value, RpcError> {
        let Ok(answer) = &result else {
            return result;
        };
        match method {
            OPEN_INSTANCE => {
                let (Some(token), Some(session)) = (
                    non_empty(answer.get("token")),
                    non_empty(params.get("sessionId")),
                ) else {
                    return result;
                };
                let closed = json!({
                    "op": INSTANCE_CLOSED,
                    "pluginId": params.get("pluginId").cloned().unwrap_or(Value::Null),
                    "serverName": params.get("serverName").cloned().unwrap_or(Value::Null),
                    "subscribers": [{
                        "scopeId": token,
                        "generation": answer.get("generation").cloned().unwrap_or(json!(0)),
                        "instance": answer,
                    }],
                });
                let panel = Panel {
                    token: token.to_owned(),
                    session: session.to_owned(),
                    closed,
                };
                if !self.with_running(generation, |running| running.panels.open.push(panel)) {
                    return Err(super::unavailable("the helper exited"));
                }
            }
            // Node answers `{closed: false}` for a busy panel under `onlyIfIdle` and keeps it open
            // (mcp-ui/protocol.ts `closeMcpUiInstance`): only a closed panel is forgotten.
            CLOSE_INSTANCE if answer.get("closed") == Some(&Value::Bool(true)) => {
                if let Some(token) = non_empty(params.pointer("/instance/token")) {
                    self.with_running(generation, |running| running.panels.forget(token));
                }
            }
            _ => {}
        }
        result
    }
}
