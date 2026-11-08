//! Fork: the running Bash row's `outputPreview` (specs/fork-rust-agent-parity.md, "Bash direct
//! output"). Node's `product-projection-bash-progress.ts`: a progress event may only update a
//! running, non-backgrounded Bash row (it never creates a row or revives a settled one), and every
//! delta that settles a row drops the preview in the same transaction (`clearSettledOutputPreviews`).

use serde_json::{Map, Value};

use super::kinds::ToolStatus;
use super::{Projection, tool_key};

/// Node's `OUTPUT_PREVIEW_MAX_CHARACTERS` (packages/shared/src/execution-output-preview.ts).
const MAX_CHARACTERS: usize = 4096;

impl Projection {
    /// `ToolProgress` with an `outputPreview` that matches Node's `executionOutputPreviewSchema`.
    pub(super) fn bash_progress(&mut self, tool_use: &str, data: &Value, out: &mut Vec<Value>) {
        let Some(preview) = data.get("outputPreview").filter(|value| valid(value)) else {
            return;
        };
        let key = tool_key(tool_use);
        let Some(&at) = self.index.get(&key) else {
            return;
        };
        let row = &self.rows[at];
        if row.get("toolName").and_then(Value::as_str) != Some("Bash")
            || ToolStatus::of(row) != Some(ToolStatus::Running)
            || row.get("backgrounded").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let preview = preview.clone();
        self.upsert(
            &key,
            |row| {
                row.insert("outputPreview".into(), preview);
            },
            out,
        );
    }

    /// Node's `clearSettledOutputPreviews`, applied to the stored rows as well so a later snapshot
    /// never shows a preview on a settled row.
    pub(super) fn clear_settled_output_previews(&mut self, out: &mut [Value]) {
        for delta in out.iter_mut() {
            let op = delta.get("op").and_then(Value::as_str);
            if op != Some("row.upserted") && op != Some("row.appended") {
                continue;
            }
            let Some(row) = delta.get_mut("row").and_then(Value::as_object_mut) else {
                continue;
            };
            if !settled_with_preview(row) {
                continue;
            }
            row.remove("outputPreview");
            let id = row.get("rowId").cloned();
            if let Some(stored) = self
                .rows
                .iter_mut()
                .find(|stored| stored.get("rowId") == id.as_ref())
            {
                stored.remove("outputPreview");
            }
        }
    }
}

fn settled_with_preview(row: &Map<String, Value>) -> bool {
    row.get("kind").and_then(Value::as_str) == Some("toolCall")
        && row.contains_key("outputPreview")
        && (ToolStatus::of(row) != Some(ToolStatus::Running)
            || row.get("backgrounded").and_then(Value::as_bool) == Some(true))
}

fn valid(preview: &Value) -> bool {
    let text = |key: &str| {
        preview
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| text.chars().count() <= MAX_CHARACTERS)
    };
    let count = |key: &str| preview.get(key).and_then(Value::as_u64).is_some();
    text("text")
        && text("fullText")
        && count("totalLines")
        && count("totalBytes")
        && preview.get("linesEstimated").is_some_and(Value::is_boolean)
}

#[cfg(test)]
#[path = "bash_progress_tests.rs"]
mod tests;
