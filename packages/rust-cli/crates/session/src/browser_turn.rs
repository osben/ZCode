//! Fork (D2, specs/fork-rust-node-helper.md "D2 end-of-turn screenshot"): Node's `appendBrowserTurnScreenshot` at the
//! session's turn end. The capture goes through the helper (the port the protocol server bound for this session); the
//! stored entry is a fork entry, never a message, so no model request sees it. Node logs and skips every failure, and
//! so does this module: a failed capture or write leaves the turn as it was.

use rust_cli_kernel_api::browser_turn::{
    self, BrowserCandidate, BrowserScreenshotRecord, TURN_SCREENSHOT_ENTRY_KIND,
};
use rust_cli_kernel_api::ids::{MessageId, ToolUseId, TurnId};
use rust_cli_kernel_api::session_api::{Command, KernelEvent};
use rust_cli_kernel_api::store::Fact;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::actor::{Actor, Request};

/// The requests the end-of-turn capture serves at once: an interrupt or a shutdown ends the capture (Node aborts the
/// turn signal for both). Everything else waits for the turn end.
fn is_capture_interrupt(request: &Request) -> bool {
    matches!(
        request,
        Request::Command { envelope, .. }
            if matches!(envelope.command, Command::Interrupt | Command::Shutdown)
    )
}

impl Actor {
    /// Awaits `capture` while the actor keeps serving `requests`: an interrupt or shutdown is handled now (it cancels
    /// `cancel` through `capture_cancel`), any other request is pushed to `deferred`. The capture future must not
    /// borrow the actor, which is why the caller builds it from locals.
    pub(crate) async fn serve_while_capturing<F>(
        &mut self,
        requests: &mut mpsc::Receiver<Request>,
        deferred: &mut Vec<Request>,
        cancel: CancellationToken,
        capture: F,
    ) -> Option<rust_cli_kernel_api::browser_turn::CapturedScreenshot>
    where
        F: std::future::Future<
                Output = Option<rust_cli_kernel_api::browser_turn::CapturedScreenshot>,
            >,
    {
        self.capture_cancel = Some(cancel);
        tokio::pin!(capture);
        let shot = loop {
            tokio::select! {
                shot = &mut capture => break shot,
                Some(request) = requests.recv() => {
                    if is_capture_interrupt(&request) {
                        self.handle(request).await;
                    } else {
                        deferred.push(request);
                    }
                }
            }
        };
        self.capture_cancel = None;
        shot
    }
}

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
    ///
    /// Fork (D2 follow-up, C2): while the capture runs the actor keeps serving `requests`. An interrupt or shutdown
    /// is handled at once and cancels the capture through `cancel`, as Node's turn abort does; every other request is
    /// pushed to `deferred`, in arrival order, and handled after the turn ends.
    pub(crate) async fn browser_turn_screenshot(
        &mut self,
        turn: &TurnId,
        prompt: Option<&MessageId>,
        candidate: Option<BrowserCandidate>,
        cancel: CancellationToken,
        requests: &mut mpsc::Receiver<Request>,
        deferred: &mut Vec<Request>,
    ) -> Option<KernelEvent> {
        let candidate = candidate?;
        let anchor = prompt?.clone();
        let session = self.meta.id.as_str().to_owned();
        let port = browser_turn::port_for(&session)?;
        let capture = port.capture(&session, turn.as_str(), &candidate, cancel.clone());
        let shot = self
            .serve_while_capturing(requests, deferred, cancel, capture)
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

#[cfg(test)]
#[path = "browser_turn_tests.rs"]
mod tests;
