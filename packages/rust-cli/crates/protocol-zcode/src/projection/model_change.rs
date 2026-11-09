//! Fork: the model switch divider, like Node's `onTurnStarted` `lastTurnModel` (bootstrap
//! `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-agent-parity.md, Model switch timeline markers). A turn
//! that starts on another provider or model than the previous turn gets a `modelChange` marker before its header.
//! Choosing a model draws nothing: draft sessions that switch before the first message stay clean.

use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::session_api::SessionView;
use serde_json::json;

use super::{Projection, RowKind};

impl Projection {
    /// Called by `start_turn` before the turn header with the model the turn runs on: the session's selection on a
    /// live turn; on a cold one the stored model of its first assistant message, `None` when unknown (nothing drawn,
    /// the previous model kept, like Node's cold resume without a stored selection). The first turn only records its
    /// model; a reasoning change alone is not a switch.
    pub(super) fn model_change(
        &mut self,
        turn: &str,
        selection: Option<ModelSelection>,
        now: u64,
        seq: u64,
        out: &mut Vec<serde_json::Value>,
    ) {
        let Some(selection) = selection else {
            return;
        };
        let ModelSelection {
            provider,
            model,
            reasoning,
            ..
        } = selection;
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
                "toThought": reasoning.unwrap_or_default(),
            }),
        );
        self.append(key, row, out);
    }

    /// After a cold projection: a session whose stored turns name no model (older Rust sessions) takes the current
    /// selection as the previous model, so a switch made after reopening still draws the divider.
    pub(super) fn seed_turn_model(&mut self, turns: u64) {
        if turns > 0 && self.last_turn_model.is_none() {
            self.last_turn_model = Some((
                self.selection.provider.clone(),
                self.selection.model.clone(),
            ));
        }
    }
}

/// The stored model of a cold turn: that of the first assistant message after `start` (the message that opened the
/// turn) with a known model, before the next message that opens a turn.
pub(super) fn cold_turn_model(
    view: &SessionView,
    start: usize,
    opens_turn: impl Fn(&Message) -> bool,
) -> Option<ModelSelection> {
    view.messages
        .iter()
        .skip(start + 1)
        .take_while(|message| !opens_turn(message))
        .find_map(|message| match message {
            Message::Assistant(assistant) => view.message_models.get(&assistant.id).cloned(),
            _ => None,
        })
}
