use rust_cli_kernel_api::lsp::ChangedRange;
use serde_json::json;
use tokio::time::Instant;

use super::{
    Diagnostic, PendingEdit, Resolved, Severity, Tracker, model_path, normalize, report,
    split_lines,
};

fn diagnostic(line: u32, severity: Severity, message: &str) -> Diagnostic {
    Diagnostic {
        line,
        character: 1,
        end_line: line,
        end_character: 2,
        severity,
        message: message.to_owned(),
        code: None,
        source: None,
    }
}

fn pending(
    path: &str,
    baseline: Option<Vec<Diagnostic>>,
    range: Option<(u32, u32)>,
) -> PendingEdit {
    PendingEdit {
        path: path.to_owned(),
        server_id: "p/ts".to_owned(),
        changed_range: range.map(|(start_line, end_line)| ChangedRange {
            start_line,
            end_line,
        }),
        syncing: false,
        needs_sync: false,
        baseline: Some(baseline),
        carried_rounds: 0,
    }
}

#[test]
fn raw_diagnostics_become_one_based_code_point_positions() {
    let text = "a😀b\r\nxyz";
    let lines = split_lines(text);
    assert_eq!(lines, ["a😀b", "xyz"]);
    let raw = [
        // UTF-16 index 3 is after the emoji: column 3 in code points.
        json!({"range": {"start": {"line": 0, "character": 3}, "end": {"line": 1, "character": 99}}, "severity": 2, "code": 2322, "source": "ts", "message": "m"}),
        // Missing severity is an error; a string code stays as it is.
        json!({"range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 1}}, "code": "E1", "message": "n"}),
        // Unknown severity is an error too.
        json!({"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}, "severity": 9, "message": "o"}),
        // No message, or a non-numeric position: skipped.
        json!({"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}}),
        json!({"range": {"start": {"line": "0", "character": 0}, "end": {"line": 0, "character": 0}}, "message": "x"}),
    ];
    let items = normalize(&lines, &raw);
    assert_eq!(items.len(), 3);
    assert_eq!(
        (
            items[0].line,
            items[0].character,
            items[0].end_line,
            items[0].end_character
        ),
        (1, 3, 2, 4)
    );
    assert_eq!(items[0].severity, Severity::Warning);
    assert_eq!(items[0].code.as_deref(), Some("2322"));
    assert_eq!(items[0].source.as_deref(), Some("ts"));
    assert_eq!(items[1].severity, Severity::Error);
    assert_eq!(items[1].code.as_deref(), Some("E1"));
    assert_eq!(items[2].severity, Severity::Error);
}

#[test]
fn only_new_issues_are_reported_and_a_shifted_one_is_not_new() {
    let baseline = vec![diagnostic(3, Severity::Error, "old")];
    // The old error moved from line 3 to line 5; a new one appeared.
    let current = vec![
        diagnostic(5, Severity::Error, "old"),
        diagnostic(2, Severity::Error, "new"),
        diagnostic(2, Severity::Info, "noise"),
    ];
    let resolved = [Resolved {
        entry: pending("/w/src/a.ts", Some(baseline), Some((1, 1))),
        current,
    }];
    let built = report(&resolved, 0, "/w", 20, false);
    assert_eq!(
        built.body.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\nsrc/a.ts:2:1 error new")
    );
    assert_eq!((built.error_count, built.warning_count), (1, 0));
    assert!(!built.no_baseline);
}

#[test]
fn a_repeated_identity_is_new_only_beyond_the_baseline_count() {
    let baseline = vec![diagnostic(1, Severity::Warning, "dup")];
    let current = vec![
        diagnostic(1, Severity::Warning, "dup"),
        diagnostic(9, Severity::Warning, "dup"),
    ];
    let resolved = [Resolved {
        entry: pending("/w/a.ts", Some(baseline), None),
        current,
    }];
    let built = report(&resolved, 0, "/w", 20, false);
    assert_eq!(
        built.body.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:9:1 warning dup")
    );
}

#[test]
fn without_a_baseline_only_the_changed_lines_count() {
    let mut on_range = diagnostic(4, Severity::Error, "in");
    on_range.end_line = 6;
    let current = vec![
        diagnostic(1, Severity::Error, "before"),
        on_range,
        diagnostic(9, Severity::Error, "after"),
    ];
    let resolved = [Resolved {
        entry: pending("/w/a.ts", None, Some((5, 7))),
        current: current.clone(),
    }];
    let built = report(&resolved, 0, "/w", 20, false);
    assert_eq!(
        built.body.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:4:1 error in")
    );
    assert!(built.no_baseline);
    // No baseline and no range: nothing counts.
    let resolved = [Resolved {
        entry: pending("/w/a.ts", None, None),
        current,
    }];
    assert_eq!(report(&resolved, 0, "/w", 20, false).body, None);
}

#[test]
fn errors_come_first_then_path_and_the_list_is_capped() {
    let mut tagged = diagnostic(1, Severity::Warning, "w");
    tagged.source = Some("ts".to_owned());
    tagged.code = Some("6133".to_owned());
    let resolved = [
        Resolved {
            entry: pending("/w/b.ts", None, Some((1, 100))),
            current: vec![tagged, diagnostic(7, Severity::Error, "e2")],
        },
        Resolved {
            entry: pending("/w/a.ts", None, Some((1, 100))),
            current: vec![diagnostic(3, Severity::Error, "e1")],
        },
    ];
    let built = report(&resolved, 2, "/w", 2, false);
    assert_eq!(
        built.body.as_deref(),
        Some(
            "Found 3 new diagnostic issues in 2 files\na.ts:3:1 error e1\nb.ts:7:1 error e2\n... and 1 more\nDiagnostics pending for 2 files"
        )
    );
    assert_eq!((built.error_count, built.warning_count), (2, 1));
    assert_eq!(built.server_ids, ["p/ts"]);
    let single = report(&resolved[..1], 0, "/w", 20, false);
    assert_eq!(
        single.body.as_deref(),
        Some(
            "Found 2 new diagnostic issues in 1 files\nb.ts:7:1 error e2\nb.ts:1:1 warning w [ts 6133]"
        )
    );
    // Only a pending notice.
    assert_eq!(
        report(&[], 1, "/w", 20, false).body.as_deref(),
        Some("Diagnostics pending for 1 files")
    );
}

#[test]
fn model_paths_are_workspace_relative_with_slashes() {
    assert_eq!(model_path("/w/src/a.ts", "/w", false), "src/a.ts");
    assert_eq!(model_path("/w/src/a.ts", "/w/", false), "src/a.ts");
    assert_eq!(model_path("/wx/a.ts", "/w", false), "/wx/a.ts");
    assert_eq!(model_path("/w", "/w", false), "/w");
    assert_eq!(model_path("/w/..a", "/w", false), "/w/..a");
    assert_eq!(model_path("C:\\W\\src\\a.ts", "c:\\w", true), "src/a.ts");
}

#[test]
fn the_tracker_merges_ranges_keeps_the_first_baseline_and_drops_after_carry_rounds() {
    let now = Instant::now();
    let mut tracker = Tracker::default();
    let range = |start_line, end_line| {
        Some(ChangedRange {
            start_line,
            end_line,
        })
    };
    tracker.record_syncing("/w/a.ts", "p/ts", range(5, 6), now);
    tracker.settle("/w/a.ts", Some(vec![diagnostic(1, Severity::Error, "x")]));
    tracker.record_syncing("/w/a.ts", "p/ts", range(2, 3), now);
    tracker.settle("/w/a.ts", None);
    let entry = tracker.get("/w/a.ts").unwrap();
    assert_eq!(entry.changed_range, range(2, 6));
    assert_eq!(entry.baseline.as_ref().unwrap().as_ref().unwrap().len(), 1);
    assert!(!entry.syncing);
    tracker.mark_needs_sync("/w/a.ts");
    assert!(tracker.get("/w/a.ts").unwrap().needs_sync);
    assert_eq!(tracker.last_mutation(), Some(now));
    for _ in 0..3 {
        assert!(tracker.carry("/w/a.ts", 3));
    }
    assert!(!tracker.carry("/w/a.ts", 3));
    assert!(tracker.is_empty());
}
