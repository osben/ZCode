//! Fork (D2, specs/fork-rust-node-helper.md "D2 end-of-turn screenshot"): Node's `appendBrowserTurnScreenshot` at the
//! session's turn end. The capture goes through the helper (the port the protocol server bound for this session); the
//! stored entry is a fork entry, never a message, so no model request sees it. Node logs and skips every failure, and
//! so does this module: a failed capture or write leaves the turn as it was.

use rust_cli_kernel_api::browser_turn::{
    self, BrowserCandidate, BrowserScreenshotRecord, TURN_SCREENSHOT_ENTRY_KIND,
};
use rust_cli_kernel_api::ids::{MessageId, ToolUseId, TurnId};
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_kernel_api::store::Fact;
use tokio_util::sync::CancellationToken;

use crate::actor::Actor;

impl Actor {
    /// Cold open: the screenshots stored by earlier processes. A failed read is logged and leaves none, as the turn
    /// loop does not depend on them.
    pub(crate) async fn browser_screenshots_open(&mut self) {
        let id = self.meta.id.clone();
        match self
            .deps
            .store
            .entries(&id, TURN_SCREENSHOT_ENTRY_KIND)
            .await
        {
            Ok(entries) => {
                self.browser_screenshots = entries
                    .into_iter()
                    .filter_map(|(_, data)| serde_json::from_value(data).ok())
                    .collect();
            }
            Err(error) => {
                tracing::warn!(%error, "browser turn screenshots could not be read");
            }
        }
    }

    /// Captures and stores the end-of-turn screenshot of `turn`, when it has a candidate, a prompt and a bound port.
    /// Returns the row event to log before `TurnFinished`; `None` when there is nothing to show.
    pub(crate) async fn browser_turn_screenshot(
        &mut self,
        turn: &TurnId,
        prompt: Option<&MessageId>,
        candidate: Option<BrowserCandidate>,
    ) -> Option<KernelEvent> {
        let candidate = candidate?;
        let anchor = prompt?.clone();
        let session = self.meta.id.as_str().to_owned();
        let port = browser_turn::port_for(&session)?;
        let shot = port
            .capture(
                &session,
                turn.as_str(),
                &candidate,
                CancellationToken::new(),
            )
            .await?;
        if !browser_turn::fits_display(&shot.base64) {
            tracing::warn!(
                event = "browser.turn_screenshot.over_budget",
                "a browser turn screenshot is over the display budget"
            );
            return None;
        }
        let display = browser_turn::display(&shot);
        let tool_use = ToolUseId::new(self.deps.ids.operation().as_str());
        let record = BrowserScreenshotRecord {
            anchor,
            tool_use: tool_use.clone(),
            display: display.clone(),
        };
        let data = serde_json::to_value(&record).ok()?;
        let fact = Fact::Entry {
            kind: TURN_SCREENSHOT_ENTRY_KIND.to_owned(),
            id: tool_use.as_str().to_owned(),
            data,
        };
        if let Err(reason) = self.commit(None, vec![fact]).await {
            tracing::warn!(%reason, "the browser turn screenshot could not be stored");
            return None;
        }
        self.browser_screenshots.push(record);
        Some(KernelEvent::BrowserTurnScreenshot {
            turn: turn.clone(),
            tool_use,
            display,
        })
    }
}
