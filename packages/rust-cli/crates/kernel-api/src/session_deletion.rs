//! Fork: the archived-session permanent deletion snapshot and admission (Node `repositories/sessions.ts`
//! `inspectSessionDeletion` / `beginSessionDeletion` / `completeSessionDeletion`, served by
//! `v4/storage/sessionData/deletionPreview` and `deletionExecute`). The store reads the rows; the protocol layer owns
//! the runtimes, the files and the Node result shapes (specs/fork-rust-agent-parity.md "Context composition, session
//! deletion and model-request metrics").

/// A session that refers to an artifact of a deleted session (Node `SessionDeletionReference.referrers`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionReferrer {
    pub session_id: String,
    pub title: String,
}

/// A retained artifact: `zcode-artifact://<session>/<artifact>` still appears in a session that is not deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionReference {
    pub session_id: String,
    pub artifact_id: String,
    pub referrers: Vec<DeletionReferrer>,
}

/// An independent fork that survives the deletion of its source tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionFork {
    pub session_id: String,
    pub title: String,
}

/// Node `SessionDeletionSnapshot`: the owned tree of a root, its forks and references, the runtimes holding it, and
/// the revision that a later execute must present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDeletionSnapshot {
    pub workspace_path: Option<String>,
    pub workspace_identity: Option<String>,
    pub revision: String,
    pub session_ids: Vec<String>,
    pub forks: Vec<DeletionFork>,
    pub references: Vec<DeletionReference>,
    /// A live runtime of another process holds a session of the tree.
    pub foreign_runtime: bool,
    /// Sessions of the tree whose presence row belongs to this process.
    pub local_runtime_ids: Vec<String>,
    /// Admitted input or an active target in the tree (only when no purge row exists yet).
    pub pending_work: bool,
    /// A purge row of the tree is in state `deleting`.
    pub deleting: bool,
    /// Every purge row of the tree is in state `deleted`.
    pub completed: bool,
}

/// Node `beginSessionDeletion` outcome when the barrier is not written: `Running` (a foreign runtime or pending work)
/// or `Changed` (the revision moved since the preview). Other failures are `StoreError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletionBegin {
    Admitted,
    Running,
    Changed,
}

/// Node `localeCompare` (ICU root collation) for session ids, artifact ids and file paths: punctuation sorts before
/// digits, digits before letters; letters compare without case first, then lowercase before uppercase. Covers the
/// identifier charset of those values; other characters sort after letters by code point.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let primary = |text: &str| text.chars().map(primary_weight).collect::<Vec<u32>>();
    match primary(a).cmp(&primary(b)) {
        Ordering::Equal => {}
        other => return other,
    }
    for (x, y) in a.chars().zip(b.chars()) {
        if x != y && x.eq_ignore_ascii_case(&y) {
            return if x.is_ascii_lowercase() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
    }
    a.cmp(b)
}

fn primary_weight(c: char) -> u32 {
    const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if let Some(index) = PUNCTUATION.chars().position(|known| known == c) {
        return 1 + index as u32;
    }
    if c.is_ascii_digit() {
        return 100 + (c as u32 - '0' as u32);
    }
    if c.is_ascii_alphabetic() {
        return 200 + (c.to_ascii_lowercase() as u32 - 'a' as u32);
    }
    300 + c as u32
}
