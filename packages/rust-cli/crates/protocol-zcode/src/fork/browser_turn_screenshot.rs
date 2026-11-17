//! Fork (D2, specs/fork-rust-node-helper.md "D2 end-of-turn screenshot"): the protocol server's capture port. It asks
//! the helper for the active tab's screenshot (D2-H) and fits the image into Node's display budget, as Node's
//! `imageProcessorPort.prepareForModel` does for a display over the limit. The session binds this port while it is
//! open (`Live::new`); the turn end is the only caller.
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rust_cli_kernel_api::browser_turn::{
    BrowserCandidate, CapturedScreenshot, TURN_SCREENSHOT_MAX_BASE64_BYTES,
    TURN_SCREENSHOT_MAX_DIMENSION, TurnScreenshotPort, fits_display,
};
use tokio_util::sync::CancellationToken;

use crate::context::Context;

/// The capture port of one open session, through the helper of the context's server.
pub(crate) struct HelperTurnScreenshots {
    pub(crate) context: Arc<Context>,
}

#[async_trait]
impl TurnScreenshotPort for HelperTurnScreenshots {
    async fn capture(
        &self,
        session: &str,
        turn: &str,
        candidate: &BrowserCandidate,
        cancel: CancellationToken,
    ) -> Option<CapturedScreenshot> {
        let helper = self.context.node_helper()?;
        let answer = helper
            .turn_screenshot(session, turn, candidate, &cancel)
            .await?;
        let image = answer.get("image")?;
        let base64 = image.get("base64")?.as_str()?;
        let mime_type = image.get("mimeType")?.as_str()?;
        fit(base64, mime_type)
    }
}

/// Node's budget: a display over 200 KiB of base64, or over 2048 px, is re-encoded within the budget. An image that
/// cannot fit is dropped (`None`), as Node's display builder drops it.
pub(crate) fn fit(base64: &str, mime_type: &str) -> Option<CapturedScreenshot> {
    if fits_display(base64) {
        return Some(CapturedScreenshot {
            base64: base64.to_owned(),
            mime_type: mime_type.to_owned(),
        });
    }
    let data = STANDARD.decode(base64).ok()?;
    let budget = rust_cli_image::Budget {
        max_base64_bytes: TURN_SCREENSHOT_MAX_BASE64_BYTES as u64,
        max_raw_bytes: (TURN_SCREENSHOT_MAX_BASE64_BYTES as u64) * 3 / 4,
        max_dimension: TURN_SCREENSHOT_MAX_DIMENSION,
    };
    let prepared = rust_cli_image::prepare(data, mime_type, &budget).ok()?;
    let base64 = STANDARD.encode(&prepared.data);
    fits_display(&base64).then(|| CapturedScreenshot {
        base64,
        mime_type: if prepared.media_type.is_empty() {
            mime_type.to_owned()
        } else {
            prepared.media_type.to_owned()
        },
    })
}
