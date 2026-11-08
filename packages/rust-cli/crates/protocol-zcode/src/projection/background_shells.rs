//! Fork: background shell commands in the snapshot `backgroundWorks` (Node `product-projection.ts`
//! `onBackgroundTaskLifecycle` for `kind: "bash"`; specs/fork-rust-agent-parity.md).
//!
//! The kernel's background ledger (`SessionHandle::background_tasks`) owns the commands; the adapter re-reads
//! it after the events that can change it ([`super::Projection::shell_table`]). The list holds the running
//! commands only: an ended command leaves it, as the UI reads only running works.

use std::collections::HashMap;

use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::manage::{BackgroundEntry, BackgroundKind};
use serde_json::{Map, Value, json};

use super::{Projection, tool_key};

/// The Bash result text of a backgrounded command (`tools` `bash_output.rs`); the id ends at the period.
const BACKGROUND_PREFIX: &str = "Command running in background with ID: ";

#[derive(Debug, Clone, Default)]
pub(super) struct Shells {
    /// The running commands as `backgroundWorks` items, in start order.
    pub(super) works: Vec<Value>,
    /// The Bash call's `description` of each backgrounded command (Node's work title).
    titles: HashMap<String, String>,
}

impl Projection {
    /// A Bash call that went to the background: remember its description as the work's title.
    pub(super) fn remember_shell_title(&mut self, tool_use: &str, text: &str) {
        let Some(rest) = text.strip_prefix(BACKGROUND_PREFIX) else {
            return;
        };
        let Some(task) = rest.split('.').next().filter(|task| !task.is_empty()) else {
            return;
        };
        let Some(&at) = self.index.get(&tool_key(tool_use)) else {
            return;
        };
        let description = self.rows[at]
            .get("input")
            .and_then(|input| input["description"].as_str())
            .map(str::trim)
            .filter(|description| !description.is_empty());
        if let Some(description) = description {
            self.shells
                .titles
                .insert(task.to_owned(), description.to_owned());
        }
    }

    /// The snapshot `backgroundWorks`: shell commands, then background subagents.
    pub(super) fn background_works_value(&self) -> Value {
        Value::Array(
            self.shells
                .works
                .iter()
                .chain(&self.subagents.works)
                .cloned()
                .collect(),
        )
    }

    /// Fork: the kernel's background ledger was re-read. Returns the `backgroundWorks` patch when the running
    /// commands changed.
    pub fn shell_table(&mut self, entries: &[BackgroundEntry], now: u64) -> Vec<Value> {
        let previous = &self.shells.works;
        let works: Vec<Value> = entries
            .iter()
            .filter(|entry| {
                matches!(entry.kind, BackgroundKind::Shell | BackgroundKind::Monitor)
                    && entry.status == BackgroundStatus::Running
            })
            .map(|entry| {
                let existing = previous.iter().find(|work| work["workId"] == entry.id);
                let title = self
                    .shells
                    .titles
                    .get(&entry.id)
                    .map(String::as_str)
                    .or(Some(entry.description.trim()).filter(|text| !text.is_empty()))
                    .unwrap_or(&entry.id);
                json!({
                    "workId": entry.id,
                    "kind": "bash",
                    "title": title,
                    "status": "running",
                    "startedAt": existing
                        .and_then(|work| work["startedAt"].as_u64())
                        .unwrap_or(now),
                    "cancellable": true,
                    "anchorRowId": Value::Null,
                })
            })
            .collect();
        if works == *previous {
            return Vec::new();
        }
        self.shells.works = works;
        let mut patch = Map::new();
        patch.insert("backgroundWorks".into(), self.background_works_value());
        vec![json!({"op": "state.updated", "patch": patch})]
    }
}
