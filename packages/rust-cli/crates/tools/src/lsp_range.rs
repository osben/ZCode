//! Fork: the changed line range of a file mutation (specs/fork-rust-lsp.md "Diagnostics after edits"), Node core
//! `tool/file-mutation.ts` `writeChangedRange` and `lsp/results.ts` `changedRangeBetweenLines` /
//! `changedRangeFromHunks`. Lines are 1-based and inclusive.

use rust_cli_kernel_api::lsp::ChangedRange;
use serde_json::Value;

/// Node `splitLines`: split on `\n`, drop one trailing `\r` per line; an empty text is one empty line.
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

fn line_number(index: usize) -> u32 {
    u32::try_from(index).unwrap_or(u32::MAX)
}

/// Node `writeChangedRange`: a created file is one range; an overwrite is the lines that differ.
pub(crate) fn for_write(original: Option<&str>, content: &str) -> ChangedRange {
    let new = split_lines(content);
    match original {
        None => ChangedRange {
            start_line: 1,
            end_line: line_number(new.len()).max(1),
        },
        Some(original) => between(&split_lines(original), &new),
    }
}

/// Node `changedRangeBetweenLines`: the lines between the common prefix and suffix; a pure deletion marks the line
/// where lines were removed.
pub(crate) fn between(old: &[&str], new: &[&str]) -> ChangedRange {
    let limit = old.len().min(new.len());
    let prefix = old
        .iter()
        .zip(new)
        .take(limit)
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(limit - prefix)
        .take_while(|(left, right)| left == right)
        .count();
    let start = prefix + 1;
    let end = new.len() - suffix;
    if end < start {
        let at = line_number(start).max(1);
        return ChangedRange {
            start_line: at,
            end_line: at,
        };
    }
    ChangedRange {
        start_line: line_number(start),
        end_line: line_number(end),
    }
}

/// Node `changedRangeFromHunks`: the union of the hunks' new-file sides.
pub(crate) fn from_hunks(hunks: &[Value]) -> Option<ChangedRange> {
    let mut range: Option<ChangedRange> = None;
    for hunk in hunks {
        let new_start = hunk.get("newStart").and_then(Value::as_i64).unwrap_or(0);
        let new_lines = hunk.get("newLines").and_then(Value::as_i64).unwrap_or(0);
        let start = new_start.max(1);
        let end = if new_lines > 0 {
            new_start + new_lines - 1
        } else {
            start
        };
        let (start, end) = (
            u32::try_from(start).unwrap_or(u32::MAX),
            u32::try_from(end).unwrap_or(u32::MAX),
        );
        range = Some(match range {
            None => ChangedRange {
                start_line: start,
                end_line: end,
            },
            Some(range) => ChangedRange {
                start_line: range.start_line.min(start),
                end_line: range.end_line.max(end),
            },
        });
    }
    range
}

#[cfg(test)]
#[path = "lsp_range_tests.rs"]
mod tests;
