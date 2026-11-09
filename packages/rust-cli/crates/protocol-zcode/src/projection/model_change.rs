//! Fork: the model switch divider, like Node's `onTurnStarted` `lastTurnModel` (bootstrap
//! `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-agent-parity.md, Model switch timeline markers). A turn
//! that starts on another provider or model than the previous turn gets a `modelChange` marker before its header.
//! Choosing a model draws nothing: draft sessions that switch before the first message stay clean.

use serde_json::json;

use super::{Projection, RowKind};

impl Projection {
    /// Called by `start_turn` before the turn header. The first turn only records its model; a reasoning change alone
    /// is not a switch. A cold projection runs this for each stored turn, so it ends with the current selection as the
    /// previous model (assistant messages store no provider to replay past switches).
    pub(super) fn model_change(
        &mut self,
        turn: &str,
        now: u64,
        seq: u64,
        out: &mut Vec<serde_json::Value>,
    ) {
        let provider = self.selection.provider.clone();
        let model = self.selection.model.clone();
        if provider.is_empty() || model.is_empty() {
            return;
        }
        let previous = self
            .last_turn_model
            .replace((provider.clone(), model.clone()));
        let Some((from_provider, from_model)) = previous else {
            return;
        };
        if from_provider == provider && from_model == model {
            return;
        }
        let key = format!("model-change:{turn}:{from_provider}/{from_model}->{provider}/{model}");
        let mut row = self.base(turn, &key, RowKind::TimelineMarker, now, seq);
        row.insert("lane".into(), json!("lightBoundary"));
        row.insert(
            "marker".into(),
            json!({
                "type": "modelChange",
                "fromProvider": from_provider,
                "fromModel": from_model,
                "toProvider": provider,
                "toModel": model,
                "toThought": self.selection.reasoning.clone().unwrap_or_default(),
            }),
        );
        self.append(key, row, out);
    }
}
