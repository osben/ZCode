//! Fork (node_desktop): the Bash progress preview object, built exactly like the Node adapter's
//! `buildBashOutputPreview` (`apps/zcode-cli/packages/adapters/src/exec/bash-output-preview.ts`).
//! The desktop app renders the bounded window from these fields, so the values must match: the
//! short text keeps the last 5 lines, the full text the last 100, both from the bounded tail the
//! caller read (Node reads at most 4096 bytes of the output file per tick).

use serde::Serialize;
use serde_json::Value;

/// Node's `SHORT_PREVIEW_LINES`: lines kept in `text`.
const SHORT_PREVIEW_LINES: u64 = 5;
/// Node's `FULL_PREVIEW_LINES`: lines kept in `fullText`.
const FULL_PREVIEW_LINES: u64 = 100;

/// The preview sent under the progress data key `outputPreview`; field names are Node's
/// (`ExecutionOutputPreview`, packages/shared/src/execution-output-preview.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashOutputPreview {
    /// The last lines of the bounded tail (at most [`SHORT_PREVIEW_LINES`]).
    pub text: String,
    /// The last lines of the bounded tail (at most [`FULL_PREVIEW_LINES`]).
    pub full_text: String,
    /// Lines counted in the bounded tail; an estimate when only part of the output was read.
    pub total_lines: u64,
    /// The whole output file's size at the tick.
    pub total_bytes: u64,
    /// `total_lines` was extrapolated from a partial read.
    pub lines_estimated: bool,
}

/// Scan the bounded tail backwards over `\n` like Node: each found newline adds a line, and the
/// segment after the 5th (or 100th) newline from the end starts `text` (or `fullText`). A tail
/// without a trailing newline still counts its last partial segment, which is why the scan keeps
/// going while anything remains to the left.
pub fn build(
    text: &str,
    bytes_read: u64,
    total_bytes: u64,
    previous_lines: u64,
) -> BashOutputPreview {
    let bytes = text.as_bytes();
    // Node scans with `cursor = text.lastIndexOf("\n", cursor - 1)`; -1 (nothing left of the
    // first segment) still counts that segment as a line and clamps the starts to 0, then the
    // `cursor > 0` guard ends the loop.
    let mut cursor: i64 = bytes.len() as i64;
    let mut short_start = 0_usize;
    let mut full_start = 0_usize;
    let mut lines = 0_u64;
    while cursor > 0 {
        let found: i64 = bytes[..cursor as usize]
            .iter()
            .rposition(|&byte| byte == b'\n')
            .map_or(-1, |at| at as i64);
        cursor = found;
        lines += 1;
        // Node clamps the starts to 0 when the found newline sits at index 0 or none was found.
        let start = if cursor <= 0 {
            0
        } else {
            (cursor + 1) as usize
        };
        if lines == SHORT_PREVIEW_LINES {
            short_start = start;
        }
        if lines == FULL_PREVIEW_LINES {
            full_start = start;
        }
    }
    let lines_estimated = bytes_read > 0 && bytes_read < total_bytes;
    let total_lines = if bytes_read == 0 {
        previous_lines
    } else if lines_estimated {
        // Node: `Math.max(previousLines, Math.round((totalBytes / bytesRead) * lines))`.
        let estimate = (total_bytes as f64 / bytes_read as f64 * lines as f64).round();
        previous_lines.max(estimate as u64)
    } else {
        lines
    };
    let short = &bytes[short_start..];
    let full = &bytes[full_start..];
    BashOutputPreview {
        text: String::from_utf8_lossy(short).into_owned(),
        full_text: String::from_utf8_lossy(full).into_owned(),
        total_lines,
        total_bytes,
        lines_estimated,
    }
}

/// The progress payload's `outputPreview` object.
pub fn to_value(preview: &BashOutputPreview) -> Value {
    serde_json::to_value(preview).unwrap_or(Value::Null)
}

#[cfg(test)]
#[path = "bash_preview_tests.rs"]
mod tests;
