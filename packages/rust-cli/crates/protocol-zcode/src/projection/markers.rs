//! Fork: compaction timeline markers, like Node's `onCompactLifecycle` (bootstrap
//! `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-agent-parity.md). One `timelineMarker` row per
//! compaction, in the `assistantWork` lane of the current (or latest) turn: `running` when it starts, then `success`,
//! `failed`, or `cancelled` when its turn ends first. A skipped compaction (too little history) is one `noop` row.
//! A cold projection shows each stored compact boundary as a `success` marker.

use rust_cli_kernel_api::message::CompactTrigger;
use serde_json::{Value, json};

use super::{Projection, RowKind};

fn origin(trigger: CompactTrigger) -> &'static str {
    match trigger {
        CompactTrigger::Manual => "manual",
        CompactTrigger::Auto | CompactTrigger::Reactive => "auto",
    }
}

fn marker_key(count: u64) -> String {
    format!("compact:{count}")
}

impl Projection {
    /// Node's `turnIdOf`: the running turn, else the latest one.
    fn marker_turn(&self) -> String {
        if let Some(turn) = &self.turn {
            return turn.id.clone();
        }
        self.rows
            .iter()
            .rev()
            .find_map(|row| row.get("turnId").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default()
    }

    fn append_compact_marker(
        &mut self,
        trigger: CompactTrigger,
        status: &str,
        tokens_before: Option<u64>,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.compactions += 1;
        let key = marker_key(self.compactions);
        let entity = format!("compact_{}", self.compactions);
        let turn = self.marker_turn();
        let mut row = self.base(&turn, &entity, RowKind::TimelineMarker, now, seq);
        let mut marker = json!({"type": "compact", "origin": origin(trigger), "status": status});
        if let Some(tokens) = tokens_before {
            marker["tokensBefore"] = json!(tokens);
        }
        row.insert("lane".into(), json!("assistantWork"));
        row.insert("marker".into(), marker);
        // Node `onCompactLifecycle`: a manual compaction carries the input that asked for it.
        if trigger == CompactTrigger::Manual
            && let Some(command) = self.turn.as_ref().and_then(|turn| turn.command.clone())
        {
            row.insert("sourceCommandId".into(), json!(command));
        }
        self.append(key, row, out);
    }

    pub(super) fn compact_started(
        &mut self,
        trigger: CompactTrigger,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.append_compact_marker(trigger, "running", None, now, seq, out);
    }

    /// Settles the running marker; a terminal event without a started marker changes nothing.
    pub(super) fn compact_settled(&mut self, status: &str, out: &mut Vec<Value>) {
        let key = marker_key(self.compactions);
        self.upsert(
            &key,
            |row| {
                if let Some(marker) = row.get_mut("marker")
                    && marker["status"] == "running"
                {
                    marker["status"] = json!(status);
                }
            },
            out,
        );
    }

    /// Node `skipped`: one settled `noop` row, no compact work.
    pub(super) fn compact_skipped(
        &mut self,
        trigger: CompactTrigger,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.append_compact_marker(trigger, "noop", None, now, seq, out);
    }

    /// A stored compact boundary (cold projection).
    pub(super) fn compacted(
        &mut self,
        trigger: CompactTrigger,
        tokens_before: u64,
        now: u64,
        out: &mut Vec<Value>,
    ) {
        self.append_compact_marker(trigger, "success", Some(tokens_before), now, 0, out);
    }
}
