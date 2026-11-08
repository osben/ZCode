//! Fork: the per-turn file summary (the App's per-turn `fileChanges` / `fileRewindPreview` over
//! one product turn): which checkpoints belong to the turn opened by a typed user message, and the
//! per-path counts the App's summary panel shows. Read-only; the restore itself is the rewind
//! transaction ([`crate::rewind`]).


use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::session_api::{
    FileChange, KernelEvent, TurnFileChanges, TurnFileCount, TurnFileFacts, TurnFileItem,
};
use rust_cli_kernel_api::store::{ArtifactStore, Fact, WorkspaceCheckpoint};

use crate::actor::Actor;
use crate::rewind_plan::{self, Artifact};

/// The `Fact::Entry` kind marking a turn's checkpoints as restored (`rust-cli/turn_files`
/// session entries; Node ignores them). Written in the same batch as the restore so a cold open
/// can rebuild the reverted header — the checkpoints themselves leave the loaded list.
pub(crate) const ENTRY_TURN_FILES: &str = "turn_files";

/// The turn's checkpoints the caller reads artifacts for, plus whether they were already restored.
pub(crate) struct Files {
    pub checkpoints: Vec<WorkspaceCheckpoint>,
    pub reverted: bool,
}

/// The per-turn summary the session keeps in memory for its view (path → summed counts), so the
/// turn headers survive a restart. Updated when checkpoints settle and when they are restored.
#[derive(Debug, Clone, Default)]
pub(crate) struct TurnFileSummary {
    /// path → summed (additions, deletions), first-seen order.
    pub files: Vec<(String, u64, u64)>,
    /// The turn's checkpoints could be rewound (they were when they settled).
    pub rewindable: bool,
    /// Every checkpoint of the turn was already restored.
    pub reverted: bool,
}

impl TurnFileSummary {
    fn add(&mut self, path: &str, additions: u64, deletions: u64) {
        match self.files.iter_mut().find(|(known, _, _)| known == path) {
            Some((_, add, remove)) => {
                *add = add.saturating_add(additions);
                *remove = remove.saturating_add(deletions);
            }
            None => self.files.push((path.to_owned(), additions, deletions)),
        }
    }

    /// The view's facts, sorted by path.
    pub(crate) fn facts(&self) -> TurnFileFacts {
        let mut files: Vec<TurnFileCount> = self
            .files
            .iter()
            .map(|(path, additions, deletions)| TurnFileCount {
                path: path.clone(),
                additions: *additions,
                deletions: *deletions,
            })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        TurnFileFacts {
            files,
            rewindable: self.rewindable,
            reverted: self.reverted,
        }
    }
}

/// The checkpoints of the turn opened by `turn_input`, in write order: every checkpoint records
/// the message that opened its turn (`WorkspaceCheckpoint::prompt`, Node `messageId`), typed or
/// model-only (a background task notification opens its own turn). Unlike
/// [`rewind_plan::checkpoints_from`] this is only the turn's own writes — later turns, including
/// notification turns before the next typed message, keep theirs.
pub(crate) fn turn_checkpoints<'a>(
    checkpoints: &'a [WorkspaceCheckpoint],
    turn_input: &MessageId,
) -> Vec<&'a WorkspaceCheckpoint> {
    checkpoints
        .iter()
        .filter(|c| c.prompt == *turn_input)
        .collect()
}

/// One write's added/removed line counts: the artifact's structuredPatch hunks when it has them
/// (the same counts the live `FileChanges` event carried at write time), else a line diff of the
/// contents around the write.
fn write_counts(file: &rewind_plan::ArtifactFile) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    let mut hunks = false;
    for hunk in &file.structured_patch {
        let Some(lines) = hunk["lines"].as_array() else {
            continue;
        };
        hunks = true;
        for line in lines {
            match line.as_str() {
                Some(text) if text.starts_with('+') => additions += 1,
                Some(text) if text.starts_with('-') => deletions += 1,
                _ => {}
            }
        }
    }
    if hunks {
        return (additions, deletions);
    }
    rewind_plan::line_changes(
        file.before_content.as_deref().unwrap_or_default(),
        file.after_content.as_deref().unwrap_or_default(),
    )
}

/// The per-path summary of the turn's writes, sorted by path (Node's `fileChanges` items).
pub(crate) fn summarize(artifacts: &[Artifact]) -> Vec<TurnFileItem> {
    let mut items: Vec<TurnFileItem> = Vec::new();
    for artifact in artifacts {
        for file in &artifact.files {
            let (additions, deletions) = write_counts(file);
            // Older artifacts record no tool name; those report none.
            let tool = artifact.tool_name.clone();
            match items.iter_mut().find(|item| item.path == file.path) {
                Some(item) => {
                    item.additions = item.additions.saturating_add(additions);
                    item.deletions = item.deletions.saturating_add(deletions);
                    item.write_count += 1;
                    if let Some(tool) = tool.filter(|tool| !item.tool_names.contains(tool)) {
                        item.tool_names.push(tool);
                    }
                    item.patches.extend(file.structured_patch.iter().cloned());
                }
                None => items.push(TurnFileItem {
                    path: file.path.clone(),
                    additions,
                    deletions,
                    write_count: 1,
                    tool_names: tool.into_iter().collect(),
                    patches: file.structured_patch.clone(),
                }),
            }
        }
    }
    for item in &mut items {
        item.tool_names.sort();
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
    items
}

/// The query result for one turn (Node `v4/conversation/fileChanges`): the artifacts are read
/// here, in the caller's task; a restored turn has no unrestored checkpoints left and reports no
/// items, only `reverted`.
pub(crate) async fn changes(store: &dyn ArtifactStore, snapshot: Files) -> TurnFileChanges {
    if snapshot.reverted {
        return TurnFileChanges {
            items: Vec::new(),
            reverted: true,
        };
    }
    let mut artifacts = Vec::new();
    for checkpoint in &snapshot.checkpoints {
        if let Ok(bytes) = store.get(&checkpoint.snapshot).await
            && let Ok(artifact) = serde_json::from_slice::<Artifact>(&bytes)
        {
            artifacts.push(artifact);
        }
    }
    TurnFileChanges {
        items: summarize(&artifacts),
        reverted: false,
    }
}

impl Actor {
    /// The snapshot for [`rust_cli_kernel_api::session_api::SessionHandle::turn_file_changes`]:
    /// the turn's unrestored checkpoints, and whether they were all restored before.
    pub(crate) fn turn_files_snapshot(&self, turn_input: &MessageId) -> Files {
        let checkpoints: Vec<_> = turn_checkpoints(&self.checkpoints, turn_input)
            .into_iter()
            .cloned()
            .collect();
        let reverted = checkpoints.is_empty()
            && self
                .turn_files
                .get(turn_input)
                .is_some_and(|summary| summary.reverted);
        Files { checkpoints, reverted }
    }

    /// One of the turn's checkpoints settled (committed with its tool result): keep the per-turn
    /// summary the view serves, summed per path like the turn header's `FileChanges` batches.
    pub(crate) fn turn_files_settled(&mut self, prompt: &MessageId, change: &FileChange) {
        let summary = self.turn_files.entry(prompt.clone()).or_default();
        summary.rewindable = true;
        summary.add(&change.path, change.additions, change.deletions);
    }

    /// Cold open: the previous process's `FileChanges` events are gone; rebuild the per-turn
    /// summaries from the stored checkpoints' artifacts (each write's counts summed per path — the
    /// same numbers the live events carried), and from the persisted reverted markers. A
    /// checkpoint that cannot be read leaves its turn without a summary, like an unreadable one
    /// leaves the rewind picker without changes.
    pub(crate) async fn restore_turn_files(&mut self) {
        let markers = self
            .deps
            .store
            .entries(&self.meta.id, ENTRY_TURN_FILES)
            .await
            .unwrap_or_default();
        for (id, data) in markers {
            let Ok(facts) = serde_json::from_value::<TurnFileFacts>(data) else {
                continue;
            };
            // Later markers replace earlier ones (idempotent replay of the same turn).
            let summary = self.turn_files.entry(MessageId::new(&id)).or_default();
            summary.reverted = true;
            summary.files = facts
                .files
                .iter()
                .map(|file| (file.path.clone(), file.additions, file.deletions))
                .collect();
        }
        if self.checkpoints.is_empty() {
            return;
        }
        let store = self.deps.artifacts.clone();
        let checkpoints = self.checkpoints.clone();
        for checkpoint in checkpoints {
            let artifact = match store.get(&checkpoint.snapshot).await {
                Ok(bytes) => serde_json::from_slice::<Artifact>(&bytes),
                Err(_) => continue,
            };
            let Ok(artifact) = artifact else {
                continue;
            };
            let summary = self.turn_files.entry(checkpoint.prompt.clone()).or_default();
            summary.rewindable = true;
            for file in &artifact.files {
                let (additions, deletions) = write_counts(file);
                summary.add(&file.path, additions, deletions);
            }
        }
    }

    /// The turn's checkpoints were all restored: keep the summary (now reverted) and tell the
    /// front ends ([`KernelEvent::TurnFilesReverted`]).
    pub(crate) fn turn_files_reverted(&mut self, turn_input: &MessageId) {
        if let Some(summary) = self.turn_files.get_mut(turn_input) {
            summary.reverted = true;
        }
        self.log.append(KernelEvent::TurnFilesReverted {
            turn_input: turn_input.clone(),
        });
    }

    /// The prompts whose checkpoints `restored` empties entirely (every checkpoint of the turn is
    /// in the set).
    pub(crate) fn fully_restored(&self, restored: &[String]) -> Vec<MessageId> {
        let mut prompts: Vec<MessageId> = Vec::new();
        for checkpoint in &self.checkpoints {
            if restored.contains(&checkpoint.id) && !prompts.contains(&checkpoint.prompt) {
                prompts.push(checkpoint.prompt.clone());
            }
        }
        prompts.retain(|prompt| {
            self.checkpoints
                .iter()
                .all(|c| &c.prompt != prompt || restored.contains(&c.id))
        });
        prompts
    }

    /// The durable reverted markers for the turns a restore batch empties ([`ENTRY_TURN_FILES`]):
    /// one `Fact::Entry` per turn, committed together with [`Fact::CheckpointsRestored`].
    pub(crate) fn reverted_entries(&self, restored: &[String]) -> Vec<Fact> {
        self.fully_restored(restored)
            .into_iter()
            .filter_map(|prompt| {
                let summary = self.turn_files.get(&prompt)?;
                let mut facts = summary.facts();
                facts.reverted = true;
                Some(Fact::Entry {
                    kind: ENTRY_TURN_FILES.to_owned(),
                    id: prompt.as_str().to_owned(),
                    data: serde_json::to_value(facts).ok()?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "turn_files_tests.rs"]
mod tests;
