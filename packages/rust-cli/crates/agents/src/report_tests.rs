//! 子代理的结果与通知（agents.md §5）：不读对照数据的用例。读对照数据、逐字比较的在 `report_parity_tests.rs`
//! （docs/specs/rust-cli/export.md §5）。

use super::{Ending, Report, handback, launched, notification};

fn report(text: &str, tokens: u64, duration_ms: u64) -> Report {
    Report {
        text: text.to_owned(),
        tokens,
        tool_uses: 0,
        duration_ms,
    }
}

/// 一次性的 agent 没有尾注；空报告给出占位文本。
#[test]
fn an_empty_one_shot_report_has_the_placeholder() {
    let short = handback("x", &report("", 0, 0), false);
    assert!(short.ends_with("The report follows:\n  (Subagent completed but returned no output.)"));
}

/// 启动结果的 agentId 一行：本工程的 `agent_<uuid>` 带 `-`，按原样写出（对齐脚本取 ID 的模式要认 `[\w-]+`，
/// L18 修正的回归）。
#[test]
fn the_launch_result_keeps_the_dashed_agent_id() {
    let ours = launched("agent_3f2b9c1e-8a4d-4c2e-9f1a-2b3c4d5e6f70");
    assert!(ours.contains("\nagentId: agent_3f2b9c1e-8a4d-4c2e-9f1a-2b3c4d5e6f70 (internal ID"));
}

/// 失败：摘要带错误（没有时 `Unknown error`），已有的文本作 `<result>`，没有 `<usage>`；`<summary>`
/// 与 `<result>` 转义 `&`、`<`、`>`。
#[test]
fn failed_notifications_carry_the_error_and_escape_markup() {
    let text = notification(
        "a1",
        Some("toolu_1"),
        "Fix <b> & c",
        Ending::Failed,
        &report("partial <x>", 3, 4),
        Some("disk full"),
    );
    assert!(
        text.contains("<summary>Agent \"Fix &lt;b&gt; &amp; c\" failed: disk full</summary>"),
        "{text}"
    );
    assert!(text.contains("</note>\n<result>partial &lt;x&gt;</result>\n</task-notification>"));
    assert!(!text.contains("<usage>"));
    let unknown = notification("a1", None, "d", Ending::Failed, &report("", 0, 0), None);
    assert!(unknown.contains("failed: Unknown error</summary>"));
    // 没有工具调用（SendMessage 留下的消息续跑之后，A8）：没有 `<tool-use-id>` 这一行。
    assert!(
        unknown.starts_with("<system-reminder>\n[SYSTEM NOTIFICATION")
            && unknown.contains("<task-id>a1</task-id>\n<status>failed</status>")
    );
    assert!(!unknown.contains("<result>"));
}

/// Fork: an incognito child (Node `buildSubagentContextSections`): without `identity` no identity block; without
/// `harness` the Notes give way to the confirm-first paragraph, while the launcher-messages note stays.
#[test]
fn an_incognito_child_drops_identity_and_keeps_the_confirmation_floor() {
    use rust_cli_kernel_api::incognito::IncognitoProfile;
    use rust_cli_prompts::agents as texts;
    use rust_cli_prompts::texts as context_texts;
    let normal = super::system("PROMPT", None);
    assert_eq!(normal.len(), 2);
    assert_eq!(normal[0].text, context_texts::identity());
    assert!(normal[1].text.contains(texts::notes()));

    let locked = super::system("PROMPT", Some(&IncognitoProfile::LOCKDOWN));
    assert_eq!(locked.len(), 1);
    let body = &locked[0].text;
    assert!(body.starts_with("PROMPT"));
    assert!(body.contains(texts::authority()));
    assert!(body.contains(context_texts::action_caution()));
    assert!(!body.contains(texts::notes()));
    assert!(!body.contains(context_texts::identity()));

    let kept = super::system(
        "PROMPT",
        Some(&IncognitoProfile {
            identity: true,
            harness: true,
            ..IncognitoProfile::LOCKDOWN
        }),
    );
    assert_eq!(kept, normal);
}
