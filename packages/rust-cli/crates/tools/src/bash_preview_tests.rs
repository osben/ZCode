//! Fork (node_desktop): cases mirroring the Node adapter's `buildBashOutputPreview` semantics
//! (`bash-output-preview.ts`): 5/100-line windows, partial-read estimates, `previousLines` carry.

use super::*;

fn lines(count: usize) -> String {
    (1..=count)
        .map(|n| format!("line-{n}\n"))
        .collect::<Vec<_>>()
        .join("")
}

#[test]
fn short_output_is_kept_whole() {
    let preview = build("one\ntwo\nthree", 15, 15, 0);
    assert_eq!(preview.text, "one\ntwo\nthree");
    assert_eq!(preview.full_text, "one\ntwo\nthree");
    assert_eq!(preview.total_lines, 3);
    assert!(!preview.lines_estimated);
}

#[test]
fn a_trailing_newline_still_counts_the_empty_last_segment() {
    // "a\n" scans the newline and then the segment left of it: 2 lines like Node.
    let preview = build("a\n", 2, 2, 0);
    assert_eq!(preview.total_lines, 2);
}

#[test]
fn text_keeps_the_last_five_lines_and_fulltext_the_last_hundred() {
    // Each trailing newline adds an empty segment, so a 6-line text has 7 counted lines and the
    // 5-line window keeps line-3..line-6 (the empty tail segment counts as one).
    let preview = build(&lines(6), 42, 42, 0);
    assert_eq!(preview.text, "line-3\nline-4\nline-5\nline-6\n");
    assert_eq!(preview.full_text, lines(6));
    assert_eq!(preview.total_lines, 7);

    // 120 lines = 121 counted segments; the 100-line window starts at line-22.
    let preview = build(&lines(120), 840, 840, 0);
    assert_eq!(
        preview.full_text,
        (22..=120)
            .map(|n| format!("line-{n}\n"))
            .collect::<String>()
    );
    assert_eq!(preview.total_lines, 121);
}

#[test]
fn four_lines_with_a_trailing_newline_stay_whole_in_the_short_window() {
    // 4 lines + the empty tail segment = 5 counted lines: the whole text fits the window.
    let preview = build("a\nb\nc\nd\n", 8, 8, 0);
    assert_eq!(preview.text, "a\nb\nc\nd\n");
    assert_eq!(preview.total_lines, 5);
}

#[test]
fn a_leading_newline_at_the_window_boundary_is_kept() {
    // The 5th newline from the end sits at index 0: Node clamps the start to 0, so the short
    // preview keeps the leading newline instead of dropping the first character.
    let text = "\na\nb\nc\nd\n";
    let preview = build(text, 8, 8, 0);
    assert_eq!(preview.text, text);
    assert_eq!(preview.total_lines, 5);
}

#[test]
fn a_partial_read_estimates_the_line_count_from_previous_lines() {
    // 4096 of 8192 bytes read, 11 counted lines in the tail: round(2 * 11) = 22.
    let preview = build(&lines(10), 4096, 8192, 0);
    assert!(preview.lines_estimated);
    assert_eq!(preview.total_lines, 22);

    // The estimate never goes below the previous tick's count.
    let preview = build(&lines(10), 4096, 8192, 40);
    assert_eq!(preview.total_lines, 40);
}

#[test]
fn an_empty_read_keeps_the_previous_line_count() {
    let preview = build("", 0, 0, 7);
    assert_eq!(preview.total_lines, 7); // previousLines carries over
    assert_eq!(preview.text, "");
    assert!(!preview.lines_estimated);
}

#[test]
fn the_json_object_uses_nodes_field_names() {
    let value = to_value(&build("hi", 2, 2, 0));
    assert_eq!(
        value,
        serde_json::json!({
            "text": "hi",
            "fullText": "hi",
            "totalLines": 1,
            "totalBytes": 2,
            "linesEstimated": false,
        })
    );
}
