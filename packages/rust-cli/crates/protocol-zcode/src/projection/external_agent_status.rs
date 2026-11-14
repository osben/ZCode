//! Fork: the ACP context-reset divider and stall status (specs/fork-rust-agent-parity.md "ACP external agents",
//! rule 14). Node: bootstrap `zcode-protocol-v4/product-projection.ts` `onSystemMessage` (an
//! `external_agent_context_reset` system message) and `onExternalAgentStatus` / `clearedExternalAgentStall`. Neither is
//! stored: Node keeps both in its in-memory event log only. A history rebuild in the same process keeps both (Node's
//! cold merge re-inserts the notice before its turn, `cold-event-merge.ts`); a relaunch shows neither.

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
        // Remembered by the input that opened the turn: a rebuilt history keys its turns by that input, not by the
        // live turn id.
        let opening = self.rows.iter().find_map(|row| {
            (RowKind::of(row) == Some(RowKind::UserInput) && row["turnId"] == turn.as_str())
                .then(|| row["entityId"].as_str().map(str::to_owned))
                .flatten()
        });
        if let Some(opening) = opening {
            self.context_resets.insert(opening, agent.to_owned());
        }
    }

    /// A rebuilt history: the divider of the turn `opening` started, drawn right after that input. Forgets the dividers
    /// whose turn the history no longer has.
    pub(super) fn cold_context_reset(&mut self, opening: &str, at: u64, out: &mut Vec<Value>) {
        if let Some(agent) = self.context_resets.get(opening).cloned() {
            self.external_agent_context_reset(&agent, at, 0, out);
        }
    }

    /// After a rebuilt history: only the dividers whose opening input is still there are kept.
    pub(super) fn retain_context_resets(&mut self, openings: &std::collections::HashSet<String>) {
        self.context_resets
            .retain(|opening, _| openings.contains(opening));
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
