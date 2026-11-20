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

/// Fork (W7-6): the sessions of a tree that hold a live workflow run, in the tree's order. A session with a live run is
/// busy for deletion and erase, as Node's residency `busy` makes it, so the callers refuse before any side effect.
pub fn live_run_busy_ids(tree: &[String], live: &[crate::ids::SessionId]) -> Vec<String> {
    tree.iter()
        .filter(|id| live.iter().any(|session| session.as_str() == id.as_str()))
        .cloned()
        .collect()
}

/// Node `localeCompare` (ICU root collation) for session ids, artifact ids and file paths. Three levels, as ICU does:
/// primary (the base letter; punctuation before digits, digits before letters), secondary (the accent of a Latin
/// letter), tertiary (lowercase before uppercase). Latin letters with a common accent fold to their base; other
/// characters sort after the Latin letters by code point. Not the full UCA: scripts beyond Latin are approximated.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let (primary_a, secondary_a, tertiary_a) = collation_elements(a);
    let (primary_b, secondary_b, tertiary_b) = collation_elements(b);
    primary_a
        .cmp(&primary_b)
        .then_with(|| secondary_a.cmp(&secondary_b))
        .then_with(|| tertiary_a.cmp(&tertiary_b))
        .then_with(|| a.cmp(b))
}

/// The three weight sequences of `text`, one entry per base letter.
fn collation_elements(text: &str) -> (Vec<u32>, Vec<u32>, Vec<u8>) {
    let mut primary = Vec::new();
    let mut secondary = Vec::new();
    let mut tertiary = Vec::new();
    for character in text.chars() {
        let lower = character.to_lowercase().next().unwrap_or(character);
        let (base, accent) = fold_accent(lower);
        primary.push(primary_weight(base));
        secondary.push(accent);
        tertiary.push(u8::from(character != lower));
    }
    (primary, secondary, tertiary)
}

/// A Latin letter with a common accent, as its base letter and an accent rank (ICU's secondary order, approximated:
/// acute, grave, breve, circumflex, caron, ring, diaeresis, double acute, tilde, dot, stroke, macron, cedilla). Other
/// characters are their own base with no accent.
fn fold_accent(character: char) -> (char, u32) {
    match character {
        'á' => ('a', 1),
        'à' => ('a', 2),
        'â' => ('a', 4),
        'ã' => ('a', 9),
        'ä' => ('a', 7),
        'å' => ('a', 6),
        'ā' => ('a', 12),
        'ç' => ('c', 13),
        'é' => ('e', 1),
        'è' => ('e', 2),
        'ê' => ('e', 4),
        'ë' => ('e', 7),
        'ē' => ('e', 12),
        'í' => ('i', 1),
        'ì' => ('i', 2),
        'î' => ('i', 4),
        'ï' => ('i', 7),
        'ī' => ('i', 12),
        'ñ' => ('n', 9),
        'ó' => ('o', 1),
        'ò' => ('o', 2),
        'ô' => ('o', 4),
        'õ' => ('o', 9),
        'ö' => ('o', 7),
        'ø' => ('o', 11),
        'ō' => ('o', 12),
        'ú' => ('u', 1),
        'ù' => ('u', 2),
        'û' => ('u', 4),
        'ü' => ('u', 7),
        'ū' => ('u', 12),
        'ý' => ('y', 1),
        'ÿ' => ('y', 7),
        other => (other, 0),
    }
}

fn primary_weight(character: char) -> u32 {
    const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if let Some(index) = PUNCTUATION.chars().position(|known| known == character) {
        return 1 + index as u32;
    }
    if character.is_ascii_digit() {
        return 100 + (character as u32 - '0' as u32);
    }
    // Lowercased here: `'A' - 'a'` underflows the u32 arithmetic for a caller that does not lowercase first.
    let lower = character.to_ascii_lowercase();
    if lower.is_ascii_alphabetic() {
        return 200 + (lower as u32 - 'a' as u32);
    }
    300 + character as u32
}

#[cfg(test)]
#[path = "session_deletion_tests.rs"]
mod tests;
