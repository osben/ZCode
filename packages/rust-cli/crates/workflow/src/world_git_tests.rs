//! Pure git world reads: argv, validation and parsers (Node `workflow-git-world-read.ts`).

use super::*;

fn driver_message(error: &WorkflowError) -> &str {
    assert_eq!(error.code, ErrorCode::DriverError);
    &error.message
}

#[test]
fn a_base_ref_rejects_a_leading_dash_so_git_cannot_read_it_as_an_option() {
    let error = validate_git_ref("git-diff", "-x").expect_err("a dash is refused");
    assert!(driver_message(&error).contains("starts with '-'"));
}

#[test]
fn a_base_ref_rejects_a_range_and_syntax_characters() {
    assert!(
        driver_message(&validate_git_ref("git-diff", "a..b").unwrap_err()).contains("'..' range")
    );
    assert!(
        driver_message(&validate_git_ref("git-diff", "main:x").unwrap_err())
            .contains("not a valid ref")
    );
    assert!(
        driver_message(&validate_git_ref("git-diff", "").unwrap_err())
            .contains("must not be empty")
    );
    assert_eq!(
        validate_git_ref("git-diff", "release/1.2^~").unwrap(),
        "release/1.2^~"
    );
}

#[test]
fn a_path_rejects_absolute_forms_on_every_platform_and_dot_dot_segments() {
    for bad in ["/etc/passwd", "\\\\server\\x", "C:\\x", "C:x", "-foo"] {
        assert!(
            validate_git_path("git-diff", bad).is_err(),
            "{bad} is refused"
        );
    }
    let error =
        validate_git_path("git-diff", "..\\secret").expect_err("a dot dot segment is refused");
    assert!(driver_message(&error).contains("'..' segment"));
    assert_eq!(
        validate_git_path("git-diff", "src\\a.ts").unwrap(),
        "src/a.ts"
    );
}

#[test]
fn changed_files_without_a_base_runs_the_tracked_diff_and_the_untracked_list() {
    let plans = git_changed_files_plans(None).unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(
        plans[0],
        argv(&["diff", "--name-only", "-z", "HEAD", "--", "."])
    );
    assert_eq!(plans[1], argv(GIT_UNTRACKED_ARGV));
}

#[test]
fn changed_files_with_a_base_runs_one_diff_and_no_untracked_list() {
    let plans = git_changed_files_plans(Some("main")).unwrap();
    assert_eq!(
        plans,
        vec![argv(&["diff", "--name-only", "-z", "main", "--", "."])]
    );
}

#[test]
fn git_diff_argv_is_relative_and_puts_the_path_after_the_separator() {
    assert_eq!(
        git_diff_argv(None, None).unwrap(),
        argv(&["diff", "--relative", "HEAD", "--", "."])
    );
    assert_eq!(
        git_diff_argv(Some("main"), Some("src/a.ts")).unwrap(),
        argv(&["diff", "--relative", "main", "--", "src/a.ts"])
    );
}

#[test]
fn git_log_argv_uses_the_count_and_the_fixed_format() {
    assert_eq!(git_log_argv(20), argv(&["log", "-n20", GIT_LOG_PRETTY]));
}

#[test]
fn the_show_prefix_loses_one_trailing_newline_only() {
    assert_eq!(parse_git_show_prefix("sub/nested/\n"), "sub/nested/");
    assert_eq!(parse_git_show_prefix(""), "");
    assert_eq!(parse_git_show_prefix("\n"), "");
}

#[test]
fn status_reports_branch_staged_unstaged_and_untracked_with_the_prefix_stripped() {
    let stdout = concat!(
        "# branch.oid abc\0",
        "# branch.head main\0",
        "1 M. N... 100644 100644 100644 a b sub/staged.md\0",
        "1 .M N... 100644 100644 100644 a b sub/unstaged.md\0",
        "? sub/new file.md\0",
    );
    let status = parse_git_status_porcelain_v2(stdout, "sub/").unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.staged, vec!["staged.md"]);
    assert_eq!(status.unstaged, vec!["unstaged.md"]);
    assert_eq!(status.untracked, vec!["new file.md"]);
    assert!(!status.clean);
}

#[test]
fn a_detached_head_has_no_branch_key() {
    let status = parse_git_status_porcelain_v2("# branch.head (detached)\0", "").unwrap();
    assert_eq!(status.branch, None);
    assert!(status.clean);
    let json = status.to_json();
    assert!(json.get("branch").is_none());
}

#[test]
fn a_rename_consumes_its_original_path_segment() {
    let stdout = "2 R. N... 100644 100644 100644 a b R100 new name.md\0old.md\0? x.md\0";
    let status = parse_git_status_porcelain_v2(stdout, "").unwrap();
    assert_eq!(status.staged, vec!["new name.md"]);
    assert_eq!(status.untracked, vec!["x.md"]);
    assert!(!status.staged.contains(&"old.md".to_owned()));
}

#[test]
fn an_unmerged_entry_is_reported_as_unstaged() {
    let stdout = "u UU N... 100644 100644 100644 100644 a b c conflict.md\0";
    let status = parse_git_status_porcelain_v2(stdout, "").unwrap();
    assert_eq!(status.unstaged, vec!["conflict.md"]);
    assert!(status.staged.is_empty());
}

#[test]
fn a_status_path_outside_the_prefix_is_a_driver_error() {
    let error = parse_git_status_porcelain_v2("? other/x.md\0", "sub/").expect_err("outside");
    assert!(driver_message(&error).contains("outside the workspace prefix"));
}

#[test]
fn status_lists_are_sorted_by_utf16_code_units_and_deduplicated() {
    let stdout = "? b.md\0? a.md\0? a.md\0? \u{1F600}.md\0? \u{FF5E}.md\0";
    let status = parse_git_status_porcelain_v2(stdout, "").unwrap();
    // U+1F600 is a surrogate pair (0xD83D first), U+FF5E sorts after it in UTF-16 but before in code points.
    assert_eq!(
        status.untracked,
        vec!["a.md", "b.md", "\u{1F600}.md", "\u{FF5E}.md"]
    );
}

#[test]
fn log_parses_four_fields_per_record_and_skips_blank_lines() {
    let stdout = "h1\0subject one\0Ann\u{0}2024-01-01T00:00:00+00:00\n\nh2\0two\0Bo\u{0}2024-01-02T00:00:00+00:00\r\n";
    let commits = parse_git_log(stdout).unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[1].subject, "two");
    assert_eq!(commits[1].date, "2024-01-02T00:00:00+00:00");
    assert_eq!(commits[0].to_json()["hash"], "h1");
}

#[test]
fn a_log_record_with_the_wrong_field_count_is_refused() {
    let error = parse_git_log("only\0three\0fields\n").expect_err("three fields");
    assert!(driver_message(&error).contains("got 3"));
}

#[test]
fn path_lists_split_on_nul_and_strip_the_prefix_once() {
    assert_eq!(
        parse_git_path_list("sub/a.md\0sub/b c.md\0", "sub/").unwrap(),
        vec!["a.md", "b c.md"]
    );
    assert_eq!(parse_git_path_list("x\0", "").unwrap(), vec!["x"]);
    assert!(parse_git_path_list("other.md\0", "sub/").is_err());
}
