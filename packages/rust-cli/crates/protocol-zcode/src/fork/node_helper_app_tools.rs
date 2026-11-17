//! Fork: the app-provided tools of an MCP App page, held by the Node helper (specs/fork-rust-node-helper.md F3b(b)).
//! `helper/appTools/replace` (helper to Rust) sets a session's set; the registry reads it through [`AppToolHost`]. A
//! model call is `helper/appTools/call` (Rust to helper, a request, session-scoped), and an abandoned one is
//! `helper/appTools/cancel` (a notification). Neither is advertised in `helper/initialize`, so neither goes through
//! [`NodeHelper::forward`]: the call takes a link of the process that owns the set, and the cancel a link of the running
//! process, and neither ever starts a helper. A set belongs to the helper process that replaced it: when that process
//! is gone its sets are dropped, and [`NodeHelper::app_tools`] never returns a set of a process that is not running.

use std::collections::HashMap;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::app_tool::{AppToolHost, AppToolSpec};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::connection::Peer;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use super::{InFlight, NodeHelper, Slot};

pub(crate) const APP_TOOLS_REPLACE: &str = "helper/appTools/replace";
pub(crate) const APP_TOOLS_CALL: &str = "helper/appTools/call";
pub(crate) const APP_TOOLS_CANCEL: &str = "helper/appTools/cancel";

/// The sets the helper replaced, by session, with the generation of the process that replaced each.
#[derive(Default)]
pub(super) struct AppToolSets {
    by_session: HashMap<String, (u64, Vec<AppToolSpec>)>,
}

impl NodeHelper {
    /// `helper/appTools/replace {sessionId, tools}` of `generation`: the whole set of the session, answered with the
    /// names it holds. A duplicate `modelName` keeps the first entry, as Node's `replaceMcpAppProvidedTools` does, and an
    /// entry Rust cannot take is left out, not a rejection: the helper has applied the whole set already and reads
    /// `registered` as the subset Rust serves.
    pub(super) fn replace_app_tools(
        &self,
        generation: u64,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let session = params
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|session| !session.is_empty())
            .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?;
        let tools = params
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| RpcError::invalid_params("tools is required"))?;
        let mut specs: Vec<AppToolSpec> = Vec::new();
        let mut dropped = 0_usize;
        for tool in tools {
            let Some(spec) = parse_spec(tool) else {
                dropped += 1;
                continue;
            };
            if !specs
                .iter()
                .any(|known| known.model_name == spec.model_name)
            {
                specs.push(spec);
            }
        }
        // Left out without an error, so the app's set and what the model sees can differ: say how many.
        if dropped > 0 {
            tracing::warn!(
                event = "helper.app_tools.dropped",
                session,
                dropped,
                "app tool entries without the names a call needs are not served"
            );
        }
        let registered: Vec<String> = specs.iter().map(|spec| spec.model_name.clone()).collect();
        {
            let mut sets = self.app_tools.lock_unpoisoned();
            // The replace tasks outlive their reader's ordering, so a late answer of an older process must not
            // overwrite the set a newer process already holds for this session.
            if sets
                .by_session
                .get(session)
                .is_some_and(|(owner, _)| *owner > generation)
            {
                return Ok(json!({"registered": registered}));
            }
            sets.by_session
                .insert(session.to_owned(), (generation, specs));
        }
        // The reader drops a process's sets once, when the process exits. A replace that ran after that would leave
        // its set behind: checked after the insert, either the reader's drop or this one removes it.
        if !self.with_running(generation, |_| ()) {
            self.app_tools_lost(generation);
        }
        Ok(json!({"registered": registered}))
    }

    /// `generation`'s process is gone: its sets are dropped.
    pub(super) fn app_tools_lost(&self, generation: u64) {
        self.app_tools
            .lock_unpoisoned()
            .by_session
            .retain(|_, (owner, _)| *owner != generation);
    }

    /// The link of `generation` when that process is still running, without starting one. The caller holds the link's
    /// in-flight count, as [`NodeHelper::forward`] does.
    fn running_link(&self, generation: u64) -> Option<(u64, Peer)> {
        let mut state = self.state.lock_unpoisoned();
        match &mut state.slot {
            Slot::Running(running)
                if running.generation == generation && !running.peer.is_closed() =>
            {
                running.in_flight += 1;
                Some((generation, running.peer.clone()))
            }
            _ => None,
        }
    }

    /// The peer of the running helper, if any, without starting one or counting a call in flight. A cancel of a call
    /// `Starting` or `Idle` has nothing to reach: the helper that ran the call is gone.
    fn running_peer(&self) -> Option<Peer> {
        match &self.state.lock_unpoisoned().slot {
            Slot::Running(running) if !running.peer.is_closed() => Some(running.peer.clone()),
            _ => None,
        }
    }

    /// The number of sessions holding a set, whatever process owns it (tests).
    #[cfg(test)]
    pub(super) fn app_tool_sets(&self) -> usize {
        self.app_tools.lock_unpoisoned().by_session.len()
    }
}

#[async_trait]
impl AppToolHost for NodeHelper {
    fn app_tools(&self, session: &SessionId) -> Vec<AppToolSpec> {
        // The entry is copied out first: the running check takes the helper's state lock, never nested in this one.
        let entry = self
            .app_tools
            .lock_unpoisoned()
            .by_session
            .get(session.as_str())
            .cloned();
        match entry {
            Some((generation, specs)) if self.with_running(generation, |_| ()) => specs,
            _ => Vec::new(),
        }
    }

    fn app_tool(&self, session: &SessionId, name: &str) -> Option<AppToolSpec> {
        // Only the named spec is copied, under the lock; the running check runs after the lock is released.
        let entry = {
            let sets = self.app_tools.lock_unpoisoned();
            sets.by_session
                .get(session.as_str())
                .and_then(|(generation, specs)| {
                    specs
                        .iter()
                        .find(|spec| spec.model_name == name)
                        .map(|spec| (*generation, spec.clone()))
                })
        };
        match entry {
            Some((generation, spec)) if self.with_running(generation, |_| ()) => Some(spec),
            _ => None,
        }
    }

    async fn call(
        &self,
        session: &SessionId,
        turn: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String> {
        // The set dies with its process, and a fresh helper never holds it: a call whose owner is gone fails here,
        // without starting a helper that could only answer "not registered".
        let owner = self
            .app_tools
            .lock_unpoisoned()
            .by_session
            .get(session.as_str())
            .map(|(generation, _)| *generation);
        let Some((generation, peer)) = owner.and_then(|generation| self.running_link(generation))
        else {
            return Err("the helper that provided this app tool is gone".to_owned());
        };
        let _in_flight = InFlight {
            helper: self,
            generation,
        };
        let params = json!({
            "sessionId": session.as_str(),
            "turnId": turn,
            "toolCallId": tool_call,
            "name": name,
            "input": input,
        });
        self.send_on(generation, &peer, APP_TOOLS_CALL, &params)
            .await
            .map_err(|error| error.to_string())
    }

    async fn cancel(&self, session: &SessionId, tool_call: &str) {
        // Never opens a session and never starts the helper: the helper ignores a cancel it does not know, and a session
        // opened here would never be closed.
        let Some(peer) = self.running_peer() else {
            return;
        };
        let params = json!({"sessionId": session.as_str(), "toolCallId": tool_call});
        // The same deadline as an abandoned call's cancel (`cancel_abandoned`): the same notification, the same bound.
        let _ =
            tokio::time::timeout(self.timing.cancel, peer.notify(APP_TOOLS_CANCEL, &params)).await;
    }
}

/// One entry of `tools`, as the helper's `replaceMcpAppProvidedTools` sends it (`core/src/mcp/app-tools.ts` fields).
/// `None` for an entry without the names a call needs.
fn parse_spec(tool: &Value) -> Option<AppToolSpec> {
    let text = |key: &str| tool.get(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| tool.get(key).and_then(Value::as_bool) == Some(true);
    let model_name = text("modelName").filter(|name| !name.is_empty())?;
    let input_schema = tool
        .get("inputSchema")
        .filter(|schema| schema.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"type": "object"}));
    Some(AppToolSpec {
        model_name,
        server_name: text("serverName").filter(|name| !name.is_empty())?,
        plugin_id: text("pluginId").unwrap_or_default(),
        tool_name: text("toolName").filter(|name| !name.is_empty())?,
        title: text("title"),
        description: text("description"),
        input_schema,
        read_only: flag("readOnlyHint"),
        destructive: flag("destructiveHint"),
        idempotent: flag("idempotentHint"),
    })
}
