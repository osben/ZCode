use super::*;

#[test]
fn lines_are_numbered_with_a_tab_and_lose_carriage_returns() {
    assert_eq!(number_lines("a\r\nb", 1), "1\ta\n2\tb");
    assert_eq!(number_lines("x", 0), "0\tx");
}

#[test]
fn binary_and_device_paths_are_recognized() {
    assert!(is_binary("/w/app.EXE"));
    assert!(!is_binary("/w/shot.png"));
    assert!(!is_binary("/w/doc.pdf"));
    assert!(!is_binary("/w/main.rs"));
    assert!(is_device("/dev/zero"));
    assert!(is_device("/proc/42/environ"));
    assert!(!is_device("/proc/42/task/1/environ"));
}

#[test]
fn token_estimates_follow_the_extension() {
    assert_eq!(estimate_tokens(&"x".repeat(100), ".json"), 50);
    assert_eq!(estimate_tokens(&"x".repeat(100), ".rs"), 25);
    assert!(check_tokens(&"x".repeat(100_004), ".rs").is_err());
    assert!(check_tokens(&"x".repeat(100_000), ".rs").is_ok());
}

/// 文件头的判断（修复线 F58，kernel-api `image::media_type`，TUI 的粘贴也用它）：GIF 要 `GIF87a` / `GIF89a`，
/// 不足 4 字节的不认。以前 `GIF8` 开头就算 GIF。
#[test]
fn image_headers_need_the_full_signature() {
    assert_eq!(image_type(b"GIF89a.."), Some("image/gif"));
    assert_eq!(image_type(b"GIF8xa.."), None);
    assert_eq!(image_type(&[0xff, 0xd8, 0xff]), None);
    assert_eq!(image_type(b"\x89PNG"), Some("image/png"));
}

/// Fork (node_desktop): the partial view's notice is Node's, byte for byte (core `read-text.ts`
/// `createTokenCapPartialView`): the line page names the next offset and limit, and a file that cannot be paginated
/// by line falls back to its character count.
#[test]
fn partial_view_notices_match_node() {
    let lines = vec!["x".repeat(60); 2_000].join("\n");
    let view = partial_view(
        &lines,
        estimate_tokens(&lines, ".rs"),
        2_000,
        1,
        ".rs",
        "/w/big.rs",
    )
    .unwrap();
    assert_eq!(view.shown_lines, 1_393);
    assert_eq!(view.content.lines().count(), 1_393);
    assert_eq!(
        view.notice,
        "[Truncated: PARTIAL view \u{2014} /w/big.rs: showing lines 1-1393 of 2000 total (30500 tokens, cap 25000). Call Read with offset=1394 limit=1393 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]"
    );
    let one_line = "x".repeat(100_004);
    let view = partial_view(
        &one_line,
        estimate_tokens(&one_line, ".rs"),
        1,
        1,
        ".rs",
        "/w/big.rs",
    )
    .unwrap();
    assert_eq!(view.content.len(), 85_000);
    assert_eq!(
        view.notice,
        "[Truncated: PARTIAL view \u{2014} /w/big.rs: showing the first 85000 of 100004 characters (25001 tokens, cap 25000); this file has very long lines and cannot be paginated by line. Use Grep to find a specific section, or Read with offset/limit to page through it. Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]"
    );
}

/// Fork (node_desktop): a whole-file Read over the token cap returns Node's partial view — the numbered head without
/// the notice as the tool_result, the notice as the `read_truncation_notice` attachment after the result. A ranged
/// read, and a Read without the node view, keep the token error (Node `isInitialWholeFileRead`).
#[tokio::test]
async fn a_node_read_over_the_token_cap_returns_the_partial_view_and_its_notice() {
    use std::sync::Arc;

    use crate::test_more::{Ctx, TextEnv, output_text};
    use rust_cli_kernel_api::ids::MessageId;
    use rust_cli_kernel_api::message::{AttachmentMessage, Message};
    use rust_cli_kernel_api::testing::{FixedGate, ScriptedInteractions, SequentialIds};
    use rust_cli_kernel_api::tool::Tool;
    use serde_json::{Value, json};

    use crate::ReadTool;
    use crate::common::FileTools;
    use rust_cli_kernel_api::message::READ_TRUNCATION_NOTICE;
    use tokio::sync::mpsc;

    const PATH: &str = "/Users/dev/work/big.rs";
    let big = vec!["x".repeat(60); 2_000].join("\n");
    let env = Arc::new(TextEnv::new(&[(PATH, &big)]));
    let context = || {
        let mut ctx = Ctx::new(Arc::new(ScriptedInteractions::default()));
        ctx.set_text_env(env.clone());
        ctx.build()
    };
    let node_files = || {
        FileTools::new(Arc::default(), Arc::new(FixedGate::passthrough()))
            .with_node_read(Arc::new(SequentialIds::default()))
    };
    let plain_files = || FileTools::new(Arc::default(), Arc::new(FixedGate::passthrough()));

    // The node view: the numbered head, without the notice, and the notice attachment after it.
    let (progress, _) = mpsc::channel(1);
    let done = ReadTool::new(node_files())
        .call_with_messages(json!({"file_path": PATH}), context(), progress)
        .await
        .unwrap();
    let body = output_text(&done.output);
    assert!(body.starts_with("1\t"), "{body:?}");
    assert_eq!(body.lines().count(), 1_393);
    assert!(!body.contains("Truncated: PARTIAL view"));
    assert_eq!(done.output.display["file"]["numLines"], json!(1_393));
    assert_eq!(
        done.new_messages,
        vec![Message::Attachment(AttachmentMessage {
            id: MessageId::new("msg_1"),
            source: READ_TRUNCATION_NOTICE.to_owned(),
            text: rust_cli_base::reminder::wrap(
                "[Truncated: PARTIAL view \u{2014} /Users/dev/work/big.rs: showing lines 1-1393 of 2000 total (30500 tokens, cap 25000). Call Read with offset=1394 limit=1393 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]"
            ),
            data: Value::Null,
        })]
    );

    // A ranged read over the cap keeps the error.
    let (progress, _) = mpsc::channel(1);
    let error = ReadTool::new(node_files())
        .call(
            json!({"file_path": PATH, "limit": 2_000}),
            context(),
            progress,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("exceeds maximum allowed tokens"));

    // Without the node view the whole-file read keeps the error too.
    let (progress, _) = mpsc::channel(1);
    let error = ReadTool::new(plain_files())
        .call(json!({"file_path": PATH}), context(), progress)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("exceeds maximum allowed tokens"));
}
