//! Fork: diagnostics after edits (specs/fork-rust-lsp.md "Diagnostics after edits"), Node core
//! `lsp/edit-diagnostics.ts` and `lsp/diagnostics.ts`: the per-session tracker of pending edits, diagnostic
//! normalization and the report text.

use std::collections::{BTreeSet, HashMap};

use rust_cli_kernel_api::lsp::ChangedRange;
use serde_json::Value;
use tokio::time::Instant;

use crate::commands::commander::locale_compare;

/// Node `LspDiagnosticSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

impl Severity {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "info",
            Self::Hint => "hint",
        }
    }

    /// Node `severityOf`: missing or unknown is an error.
    fn of(raw: Option<&Value>) -> Self {
        match raw.and_then(Value::as_f64) {
            Some(2.0) => Self::Warning,
            Some(3.0) => Self::Info,
            Some(4.0) => Self::Hint,
            _ => Self::Error,
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Error => 0,
            Self::Warning => 1,
            Self::Info | Self::Hint => 2,
        }
    }

    pub(crate) fn reportable(self) -> bool {
        matches!(self, Self::Error | Self::Warning)
    }
}

/// Node `LspDiagnostic`: 1-based lines, 1-based code-point columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Diagnostic {
    pub(crate) line: u32,
    pub(crate) character: u32,
    pub(crate) end_line: u32,
    pub(crate) end_character: u32,
    pub(crate) severity: Severity,
    pub(crate) message: String,
    pub(crate) code: Option<String>,
    pub(crate) source: Option<String>,
}

/// Node `splitLines`: split on LF, one trailing CR removed per line.
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// Node `utf16ToCodePointColumn`: the UTF-16 index is clamped to the line.
pub(crate) fn column(line: &str, utf16: f64) -> u32 {
    let utf16 = utf16.floor();
    let mut units = 0_f64;
    let mut points = 0_u32;
    for char in line.chars() {
        if units >= utf16 {
            break;
        }
        // A surrogate pair split by the index still counts its code point, as `slice` keeps the lone high half.
        units += f64::from(u32::try_from(char.len_utf16()).unwrap_or(1));
        points += 1;
    }
    points + 1
}

fn position(lines: &[&str], position: &Value) -> Option<(u32, u32)> {
    let line = position.get("line")?.as_f64()?;
    let character = position.get("character")?.as_f64()?;
    let text = if line >= 0.0 && line.fract() == 0.0 {
        // The guard above keeps the cast exact.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        lines.get(line as usize).copied().unwrap_or("")
    } else {
        ""
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let model_line = (line + 1.0).max(0.0) as u32;
    Some((model_line, column(text, character)))
}

/// Node `normalizeRawDiagnostics`: items without a string message and numeric range positions are skipped.
pub(crate) fn normalize(lines: &[&str], raw: &[Value]) -> Vec<Diagnostic> {
    raw.iter()
        .filter_map(|item| {
            let message = item.get("message")?.as_str()?;
            let range = item.get("range")?;
            let (line, character) = position(lines, range.get("start")?)?;
            let (end_line, end_character) = position(lines, range.get("end")?)?;
            let code = match item.get("code") {
                None => None,
                Some(Value::String(code)) => Some(code.clone()),
                // `String(value)`: numbers print as JS does; other JSON values are not valid codes but still print.
                Some(Value::Number(number)) => Some(rust_cli_base::js::json::js_double(
                    number.as_f64().unwrap_or(0.0),
                )),
                Some(Value::Null) => Some("null".to_owned()),
                Some(other) => Some(other.to_string()),
            };
            Some(Diagnostic {
                line,
                character,
                end_line,
                end_character,
                severity: Severity::of(item.get("severity")),
                message: message.to_owned(),
                code,
                source: item
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

/// Node `diagnosticsNotInBaseline`: a multiset difference on `(severity, code, message)`; positions do not count, so
/// a pre-existing issue that moved is not new.
fn not_in_baseline<'a>(current: &'a [Diagnostic], baseline: &[Diagnostic]) -> Vec<&'a Diagnostic> {
    let key = |item: &Diagnostic| {
        (
            item.severity,
            item.code.clone().unwrap_or_default(),
            item.message.clone(),
        )
    };
    let mut remaining: HashMap<_, usize> = HashMap::new();
    for item in baseline {
        *remaining.entry(key(item)).or_default() += 1;
    }
    current
        .iter()
        .filter(|item| match remaining.get_mut(&key(item)) {
            Some(count) if *count > 0 => {
                *count -= 1;
                false
            }
            _ => true,
        })
        .collect()
}

fn overlaps(diagnostic: &Diagnostic, range: ChangedRange) -> bool {
    diagnostic.line <= range.end_line && diagnostic.end_line >= range.start_line
}

/// Node `formatDiagnosticLocation`.
fn location(diagnostic: &Diagnostic, path: &str) -> String {
    let tags: Vec<&str> = [diagnostic.source.as_deref(), diagnostic.code.as_deref()]
        .into_iter()
        .flatten()
        .filter(|tag| !tag.is_empty())
        .collect();
    let tail = if tags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", tags.join(" "))
    };
    format!(
        "{path}:{}:{} {} {}{tail}",
        diagnostic.line,
        diagnostic.character,
        diagnostic.severity.as_str(),
        diagnostic.message
    )
}

/// Node `toModelPath`: relative to the workspace with `/` when inside it, else the absolute path.
pub(crate) fn model_path(path: &str, workspace: &str, windows: bool) -> String {
    let separators: &[char] = if windows { &['/', '\\'] } else { &['/'] };
    let root = workspace.trim_end_matches(separators);
    let inside = if windows {
        path.get(..root.len())
            .filter(|prefix| prefix.eq_ignore_ascii_case(root))
            .map(|_| &path[root.len()..])
    } else {
        path.strip_prefix(root)
    };
    let Some(rest) = inside.and_then(|rest| rest.strip_prefix(separators)) else {
        return path.to_owned();
    };
    if rest.is_empty() || rest.starts_with("..") {
        return path.to_owned();
    }
    if windows {
        rest.replace('\\', "/")
    } else {
        rest.to_owned()
    }
}

/// Node `PendingEdit`.
#[derive(Debug, Clone)]
pub(crate) struct PendingEdit {
    pub(crate) path: String,
    pub(crate) server_id: String,
    pub(crate) changed_range: Option<ChangedRange>,
    /// The didOpen/didChange of this mutation is still being sent.
    pub(crate) syncing: bool,
    /// The server was not ready; the edit is synced on its ready event.
    pub(crate) needs_sync: bool,
    /// Decided once by the first sync; `None` inside means no fresh result before the edit.
    pub(crate) baseline: Option<Option<Vec<Diagnostic>>>,
    pub(crate) carried_rounds: u32,
    /// The session's ordinal of the last mutation that recorded this entry: a step of an older mutation (its sync
    /// finishing or failing after a newer edit of the file was published) must not settle or remove it.
    pub(crate) ordinal: u64,
}

/// Node `EditDiagnosticsTracker`: files mutated since the last model request, recorded synchronously when the
/// mutation is published so a request that starts right after the tool result cannot miss it.
#[derive(Debug, Default)]
pub(crate) struct Tracker {
    /// In insertion order, as Node's `Map`.
    pending: Vec<PendingEdit>,
    last_mutation: Option<Instant>,
}

impl Tracker {
    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub(crate) fn last_mutation(&self) -> Option<Instant> {
        self.last_mutation
    }

    pub(crate) fn entries(&self) -> &[PendingEdit] {
        &self.pending
    }

    #[cfg(test)]
    pub(crate) fn get(&self, path: &str) -> Option<&PendingEdit> {
        self.pending.iter().find(|entry| entry.path == path)
    }

    fn get_mut(&mut self, path: &str) -> Option<&mut PendingEdit> {
        self.pending.iter_mut().find(|entry| entry.path == path)
    }

    /// Node `recordSyncing`: repeated edits of one file merge their ranges and reset the carry count.
    pub(crate) fn record_syncing(
        &mut self,
        path: &str,
        server_id: &str,
        changed_range: Option<ChangedRange>,
        at: Instant,
        ordinal: u64,
    ) {
        if let Some(existing) = self.get_mut(path) {
            existing.changed_range = merge(existing.changed_range, changed_range);
            existing.syncing = true;
            existing.carried_rounds = 0;
            existing.ordinal = ordinal;
        } else {
            self.pending.push(PendingEdit {
                path: path.to_owned(),
                server_id: server_id.to_owned(),
                changed_range,
                syncing: true,
                needs_sync: false,
                baseline: None,
                carried_rounds: 0,
                ordinal,
            });
        }
        self.last_mutation = Some(at);
    }

    /// Mutation `ordinal` found its server starting; a newer mutation of the file decides for itself.
    pub(crate) fn mark_needs_sync(&mut self, path: &str, ordinal: u64) {
        if let Some(entry) = self.get_mut(path)
            && entry.ordinal <= ordinal
        {
            entry.syncing = false;
            entry.needs_sync = true;
        }
    }

    /// Node `settle`: the first decided baseline is kept for the whole pending period; the entry stops syncing only
    /// once the mutation that last recorded it (or a later step) is synced.
    pub(crate) fn settle(&mut self, path: &str, baseline: Option<Vec<Diagnostic>>, ordinal: u64) {
        if let Some(entry) = self.get_mut(path) {
            if entry.baseline.is_none() {
                entry.baseline = Some(baseline);
            }
            if entry.ordinal <= ordinal {
                entry.syncing = false;
                entry.needs_sync = false;
            }
        }
    }

    pub(crate) fn remove(&mut self, path: &str) {
        self.pending.retain(|entry| entry.path != path);
    }

    /// Removes the entry unless a mutation newer than `ordinal` recorded it.
    pub(crate) fn remove_up_to(&mut self, path: &str, ordinal: u64) {
        self.pending
            .retain(|entry| entry.path != path || entry.ordinal > ordinal);
    }

    pub(crate) fn clear(&mut self) {
        self.pending.clear();
    }

    /// One more round without a fresh result; the entry is dropped after `max` rounds. True when it stays.
    pub(crate) fn carry(&mut self, path: &str, max: u32) -> bool {
        let Some(entry) = self.get_mut(path) else {
            return false;
        };
        entry.carried_rounds += 1;
        if entry.carried_rounds > max {
            self.remove(path);
            return false;
        }
        true
    }
}

fn merge(left: Option<ChangedRange>, right: Option<ChangedRange>) -> Option<ChangedRange> {
    match (left, right) {
        (None, other) | (other, None) => other,
        (Some(left), Some(right)) => Some(ChangedRange {
            start_line: left.start_line.min(right.start_line),
            end_line: left.end_line.max(right.end_line),
        }),
    }
}

/// A pending edit whose diagnostics are fresh, with them.
pub(crate) struct Resolved {
    pub(crate) entry: PendingEdit,
    pub(crate) current: Vec<Diagnostic>,
}

/// Node `EditReport`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub(crate) body: Option<String>,
    pub(crate) error_count: usize,
    pub(crate) warning_count: usize,
    pub(crate) no_baseline: bool,
    pub(crate) server_ids: Vec<String>,
}

/// Node `buildEditReport`: new errors and warnings of the fresh files, errors first, then path, line and column; a
/// pending notice for files still not fresh.
pub(crate) fn report(
    resolved: &[Resolved],
    pending_count: usize,
    workspace: &str,
    max_items: usize,
    windows: bool,
) -> Report {
    let mut issues: Vec<(&Diagnostic, &str)> = Vec::new();
    let mut no_baseline = false;
    let mut server_ids: Vec<String> = Vec::new();
    for Resolved { entry, current } in resolved {
        if !server_ids.contains(&entry.server_id) {
            server_ids.push(entry.server_id.clone());
        }
        let baseline = entry.baseline.as_ref().and_then(Option::as_ref);
        if baseline.is_none() {
            no_baseline = true;
        }
        let added: Vec<&Diagnostic> = match (baseline, entry.changed_range) {
            (Some(baseline), _) => not_in_baseline(current, baseline),
            (None, Some(range)) => current
                .iter()
                .filter(|item| overlaps(item, range))
                .collect(),
            (None, None) => Vec::new(),
        };
        issues.extend(
            added
                .into_iter()
                .filter(|item| item.severity.reportable())
                .map(|item| (item, entry.path.as_str())),
        );
    }
    issues.sort_by(|(left, left_path), (right, right_path)| {
        left.severity
            .rank()
            .cmp(&right.severity.rank())
            .then_with(|| locale_compare(left_path, right_path))
            .then(left.line.cmp(&right.line))
            .then(left.character.cmp(&right.character))
    });
    let error_count = issues
        .iter()
        .filter(|(item, _)| item.severity == Severity::Error)
        .count();
    let files: BTreeSet<&str> = issues.iter().map(|(_, path)| *path).collect();
    let mut lines = Vec::new();
    if !issues.is_empty() {
        lines.push(format!(
            "Found {} new diagnostic issues in {} files",
            issues.len(),
            files.len()
        ));
        for (item, path) in issues.iter().take(max_items) {
            lines.push(location(item, &model_path(path, workspace, windows)));
        }
        if issues.len() > max_items {
            lines.push(format!("... and {} more", issues.len() - max_items));
        }
    }
    if pending_count > 0 {
        lines.push(format!("Diagnostics pending for {pending_count} files"));
    }
    Report {
        body: (!lines.is_empty()).then(|| lines.join("\n")),
        error_count,
        warning_count: issues.len() - error_count,
        no_baseline,
        server_ids,
    }
}

#[cfg(test)]
#[path = "edits_tests.rs"]
mod tests;
