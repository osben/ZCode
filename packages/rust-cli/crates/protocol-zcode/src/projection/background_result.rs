//! Fork: the background result turn header (Node `mapTurnHeaderOrigin("background_task")` and
//! `BackgroundResultOriginMeta`; specs/fork-rust-agent-parity.md). A turn that a background task
//! notification opened has no typed user row; its header reads `origin: "backgroundResult"` with
//! `originMeta {backgroundSource, workId, title}`, so the UI shows the structured title instead of a
//! plain model-only turn. The meta is read from the notification envelope, which is the same live and
//! cold.

use rust_cli_kernel_api::message::ContentBlock;
use serde_json::{Value, json};

use super::{Projection, turn_key};

pub(super) use rust_cli_kernel_api::background_origin::{
    batch_meta, notified_statuses, origin_meta,
};

impl Projection {
    /// Notifications opened the current turn: their header becomes the background result header.
    /// A batch is one user message with a text block per notification (the desktop kernel, like
    /// Node) or one message per notification (the TUI kernel), so the header is retitled as the batch
    /// grows. A notification merged into a turn the user opened leaves the header alone.
    pub(super) fn background_result(&mut self, content: &[ContentBlock], out: &mut Vec<Value>) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        if turn.command.is_some() || turn.keys.iter().any(|key| key.starts_with("user:")) {
            return;
        }
        turn.notified
            .extend(content.iter().filter_map(|block| match block {
                ContentBlock::Text { text } => Some(origin_meta(text)),
                _ => None,
            }));
        let meta = batch_meta(&turn.notified);
        let key = turn_key(&turn.id);
        self.upsert(
            &key,
            |row| match meta {
                Some(meta)
                    if row["origin"] == "userInput" || row["origin"] == "backgroundResult" =>
                {
                    row.insert("origin".into(), json!("backgroundResult"));
                    row.insert("originMeta".into(), meta);
                }
                Some(_) => {}
                None => {
                    row.remove("originMeta");
                }
            },
            out,
        );
    }
}
