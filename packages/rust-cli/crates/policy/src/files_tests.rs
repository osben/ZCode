use rust_cli_kernel_api::permission::{PermissionMode, RuleBehavior};

use super::*;
use crate::test_support::run;

fn verdict(
    mode: PermissionMode,
    entries: &[(RuleBehavior, &str)],
    access: FileAccess,
    path: &str,
) -> Check {
    run(mode, entries, |inputs| check(access, Some(path), inputs))
}

#[test]
fn reads_inside_are_allowed_and_outside_ask() {
    assert_eq!(
        verdict(PermissionMode::Default, &[], FileAccess::Read, "a.txt"),
        Check::Allow
    );
    assert_eq!(
        verdict(PermissionMode::Default, &[], FileAccess::Read, "/etc/hosts"),
        Check::ask(
            "ZCode requested permissions to read from /etc/hosts, but you haven't granted it yet."
        )
    );
    assert_eq!(
        verdict(
            PermissionMode::Default,
            &[(RuleBehavior::Allow, "Read(//etc/**)")],
            FileAccess::Read,
            "/etc/hosts"
        ),
        Check::Allow
    );
    assert_eq!(
        verdict(
            PermissionMode::Default,
            &[(RuleBehavior::Deny, "Read(*.env)")],
            FileAccess::Read,
            ".env"
        ),
        Check::deny("Permission to read /w/.env has been denied.")
    );
}

#[test]
fn writes_need_accept_edits_inside_and_always_ask_for_sensitive_paths() {
    assert_eq!(
        verdict(PermissionMode::Default, &[], FileAccess::Write, "src/a.rs"),
        Check::ask(
            "ZCode requested permissions to write to /w/src/a.rs, but you haven't granted it yet."
        )
    );
    assert_eq!(
        verdict(
            PermissionMode::AcceptEdits,
            &[],
            FileAccess::Write,
            "src/a.rs"
        ),
        Check::Allow
    );
    assert!(matches!(
        verdict(
            PermissionMode::AcceptEdits,
            &[],
            FileAccess::Write,
            "/tmp/x"
        ),
        Check::Ask { .. }
    ));
    assert_eq!(
        verdict(
            PermissionMode::AcceptEdits,
            &[],
            FileAccess::Write,
            ".git/config"
        ),
        Check::Ask {
            independent: false,
            message:
                "ZCode requested permissions to edit /w/.git/config which is a sensitive file."
                    .to_owned(),
            kind: AskKind::Safety,
            suggestions: Vec::new(),
        }
    );
    assert_eq!(
        verdict(
            PermissionMode::Default,
            &[(RuleBehavior::Allow, "Edit(src/**)")],
            FileAccess::Write,
            "src/a.rs"
        ),
        Check::Allow
    );
    assert_eq!(
        verdict(
            PermissionMode::AcceptEdits,
            &[(RuleBehavior::Deny, "Edit(src/**)")],
            FileAccess::Write,
            "src/a.rs"
        ),
        Check::deny("Permission to edit /w/src/a.rs has been denied.")
    );
}

/// 敏感文件表用 zcode 的文件名（修复线 F58，README §4.1）：项目配置是
/// `zcode.json`（带 MCP 服务器与 hooks），zcode 没有 `.zcode.json`。以前表里是机械替换出来的 `.zcode.json`。
#[test]
fn the_project_config_is_a_sensitive_file() {
    assert_eq!(
        verdict(
            PermissionMode::AcceptEdits,
            &[],
            FileAccess::Write,
            "zcode.json"
        ),
        Check::Ask {
            independent: false,
            message: "ZCode requested permissions to edit /w/zcode.json which is a sensitive file."
                .to_owned(),
            kind: AskKind::Safety,
            suggestions: Vec::new(),
        }
    );
    assert_eq!(
        verdict(
            PermissionMode::AcceptEdits,
            &[],
            FileAccess::Write,
            ".zcode.json"
        ),
        Check::Allow
    );
    assert!(matches!(
        verdict(
            PermissionMode::AcceptEdits,
            &[],
            FileAccess::Write,
            ".mcp.json"
        ),
        Check::Ask { .. }
    ));
}

/// F14：判定与工具用同一条路径规则（权限检查与执行都先规范化路径，
/// tools-files.md §3.2）。工具会去掉首尾空白，判定若不去，`" /etc/hosts"` 会被当成工作区里的相对路径而放行。
#[test]
fn file_paths_are_resolved_like_the_tools_resolve_them() {
    assert_eq!(
        verdict(
            PermissionMode::Default,
            &[],
            FileAccess::Read,
            " /etc/hosts\n"
        ),
        Check::ask(
            "ZCode requested permissions to read from /etc/hosts, but you haven't granted it yet."
        )
    );
    // 规则按 NFC 的路径匹配：分解形式的 `é` 也命中按合成形式写的 deny 规则。
    assert_eq!(
        verdict(
            PermissionMode::Default,
            &[(RuleBehavior::Deny, "Read(caf\u{e9}.env)")],
            FileAccess::Read,
            "cafe\u{301}.env"
        ),
        Check::deny("Permission to read /w/caf\u{e9}.env has been denied.")
    );
    // 只认 `~/`：`~x` 是工作区里的文件。
    assert_eq!(
        verdict(PermissionMode::Default, &[], FileAccess::Read, "~x"),
        Check::Allow
    );
}

/// 9.61: Edit and Write into the workspace's workflow draft directory are preapproved (Node
/// `isPreapprovedWorkflowDraftWrite`), after deny and ask rules and never in plan mode. The directory itself, a sibling with
/// the same prefix, traversal out of it and other tools are not.
#[test]
fn edit_and_write_into_the_workflow_draft_directory_are_preapproved() {
    let draft = |mode, entries: &[(RuleBehavior, &str)], tool: &str, path: &str| {
        run(mode, entries, |inputs| {
            check_tool(FileAccess::Write, Some(path), inputs, tool)
        })
    };
    let ok = ".zcode/workflow-drafts/a.dwf.ts";
    assert_eq!(
        draft(PermissionMode::Default, &[], "Write", ok),
        Check::Allow
    );
    assert_eq!(
        draft(
            PermissionMode::Default,
            &[],
            "Edit",
            "/w/.zcode/workflow-drafts/sub/b.ts"
        ),
        Check::Allow
    );
    for (tool, path) in [
        ("ApplyPatch", ok),
        ("Write", ".zcode/workflow-drafts"),
        ("Write", ".zcode/workflow-drafts-other/a.ts"),
        ("Write", ".zcode/workflow-drafts/../x.ts"),
    ] {
        assert!(
            matches!(
                draft(PermissionMode::Default, &[], tool, path),
                Check::Ask { .. }
            ),
            "{tool} {path}"
        );
    }
    assert!(matches!(
        draft(PermissionMode::Plan, &[], "Write", ok),
        Check::Ask { .. }
    ));
    assert!(matches!(
        draft(
            PermissionMode::Default,
            &[(RuleBehavior::Deny, "Edit(.zcode/**)")],
            "Write",
            ok
        ),
        Check::Deny { .. }
    ));
    assert!(matches!(
        draft(
            PermissionMode::Default,
            &[(RuleBehavior::Ask, "Edit(.zcode/**)")],
            "Write",
            ok
        ),
        Check::Ask { .. }
    ));
}
