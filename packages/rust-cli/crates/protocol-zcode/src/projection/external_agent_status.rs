//! Fork: the ACP context-reset divider and stall status (specs/fork-rust-agent-parity.md "ACP external agents",
//! rule 14). Node: bootstrap `zcode-protocol-v4/product-projection.ts` `onSystemMessage` (an
//! `external_agent_context_reset` system message) and `onExternalAgentStatus` / `clearedExternalAgentStall`. Neither is
//! stored: Node keeps both in its in-memory event log only, so a rebuilt projection shows neither.

use rust_cli_kernel_api::orchestration::ExternalAgentStatus;
use serde_json::{Map, Value, json};

use super::{Projection, RowKind};

impl Projection {
    /// A new ACP session replaced one the agent could not load: a divider in the running turn. Outside a turn (the
    /// event is only emitted by one) nothing is drawn.
    pub(super) fn external_agent_context_reset(
        &mut self,
        agent: &str,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(turn) = self.turn.as_ref().map(|turn| turn.id.clone()) else {
            return;
        };
        let key = format!("agent-context-reset:{turn}");
        if self.index.contains_key(&key) {
            return;
        }
        let mut row = self.base(&turn, &key, RowKind::TimelineMarker, now, seq);
        row.insert("lane".into(), json!("lightBoundary"));
        row.insert(
            "marker".into(),
            json!({"type": "agentContextReset", "agentId": agent}),
        );
        self.append(key, row, out);
    }

    /// The running prompt went silent (`control.externalAgentStall`) or spoke again (cleared). Only a running turn's
    /// status counts (Node `acceptsActiveModelEvent`); a `resumed` with no stall shown rewrites nothing.
    pub(super) fn external_agent_status(
        &mut self,
        agent: &str,
        status: ExternalAgentStatus,
        now: u64,
        patch: &mut Map<String, Value>,
    ) {
        if self.active.is_none() {
            return;
        }
        let changed = match status {
            ExternalAgentStatus::Stalled { silent_ms } if !agent.is_empty() => {
                self.external_agent_stall = Some(json!({
                    "agentId": agent,
                    "since": now,
                    "silentMs": silent_ms,
                }));
                true
            }
            ExternalAgentStatus::Stalled { .. } => false,
            ExternalAgentStatus::Resumed => self.clear_external_agent_stall(),
        };
        if changed {
            patch.insert("control".into(), self.control());
        }
    }

    /// Clears a stall still shown (`null`, as Node writes it); `false` when none was. The field stays absent until
    /// the first stall.
    pub(super) fn clear_external_agent_stall(&mut self) -> bool {
        match &self.external_agent_stall {
            Some(stall) if !stall.is_null() => {
                self.external_agent_stall = Some(Value::Null);
                true
            }
            _ => false,
        }
    }
}
