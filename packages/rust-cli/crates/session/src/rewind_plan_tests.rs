use rust_cli_kernel_api::env_rewind::content_hash;

use super::*;

fn write(path: &str, before: Option<&str>, after: &str) -> Artifact {
    Artifact {
        files: vec![ArtifactFile {
            path: path.into(),
            existed_before: before.is_some(),
            before_content: before.map(str::to_owned),
            after_content: Some(after.into()),
            structured_patch: Vec::new(),
        }],
        tool_name: None,
    }
}

/// 同一路径多次写入：期望最后一次写入后的内容，恢复成最早一次写入前的内容；新建的文件删除。
#[test]
fn plans_collapse_writes_per_path_in_reverse() {
    let artifacts = [
        write("/a", Some("v0"), "v1"),
        write("/new", None, "n1"),
        write("/a", Some("v1"), "v2"),
    ];
    let files = plan(&artifacts).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path.as_str(), "/a");
    assert_eq!(files[0].expected, Some(content_hash(b"v2")));
    assert_eq!(files[0].restore.as_deref(), Some(b"v0".as_slice()));
    assert_eq!(files[1].path.as_str(), "/new");
    assert_eq!(files[1].restore, None);
}

/// 两次写入之间文件被别的方式改过（接不上）：冲突。
#[test]
fn a_gap_between_writes_is_a_conflict() {
    let artifacts = [write("/a", Some("v0"), "v1"), write("/a", Some("vX"), "v2")];
    assert_eq!(
        plan(&artifacts).unwrap_err(),
        "Cannot restore code: /a was changed after ZCode edited it"
    );
}

#[test]
fn changes_count_lines_from_first_before_to_last_after() {
    let artifacts = [
        write("/b", Some("1\n2\n3\n"), "1\nx\n3\n"),
        write("/b", Some("1\nx\n3\n"), "1\nx\n3\n4\n"),
    ];
    let changes = changes(&artifacts);
    assert_eq!(changes.len(), 1);
    assert_eq!((changes[0].additions, changes[0].deletions), (2, 1));
}

mod anchor {
    //! Fork: the file anchor of a rewind target (`rewind_anchor`).

    use rust_cli_kernel_api::hooks::{SteerSender, queued_command};
    use rust_cli_kernel_api::message::AttachmentMessage;

    use super::*;

    fn user(id: &str, text: &str, origin: UserOrigin) -> Message {
        Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text { text: text.into() }],
            origin,
        })
    }

    fn guided(id: &str) -> Message {
        Message::Attachment(queued_command::steer_attachment(
            MessageId::new(id),
            "also b",
            SteerSender::User,
            Some("c2"),
            None,
        ))
    }

    fn tool_result(id: &str) -> Message {
        user(
            id,
            "ok",
            UserOrigin::ToolResult {
                assistant: MessageId::new("a1"),
            },
        )
    }

    #[test]
    fn a_typed_input_anchors_at_itself() {
        let messages = [user("u1", "hi", UserOrigin::Human)];
        let anchor = rewind_anchor(&messages, &MessageId::new("u1"));
        assert_eq!(anchor.map(MessageId::as_str), Some("u1"));
    }

    #[test]
    fn a_guided_steer_anchors_at_the_turns_typed_input() {
        let messages = [
            user("u0", "earlier", UserOrigin::Human),
            user("u1", "hi", UserOrigin::Human),
            tool_result("t1"),
            guided("g1"),
        ];
        let anchor = rewind_anchor(&messages, &MessageId::new("g1"));
        assert_eq!(anchor.map(MessageId::as_str), Some("u1"));
    }

    #[test]
    fn a_guided_steer_in_a_notice_turn_anchors_at_the_notice() {
        let notice = UserOrigin::Meta {
            source: NOTICE_SOURCE.to_owned(),
        };
        let messages = [
            user("u1", "hi", UserOrigin::Human),
            user("n1", "<task-notification>done</task-notification>", notice),
            tool_result("t1"),
            guided("g1"),
        ];
        let anchor = rewind_anchor(&messages, &MessageId::new("g1"));
        assert_eq!(anchor.map(MessageId::as_str), Some("n1"));
    }

    #[test]
    fn a_guided_steer_without_an_opener_anchors_at_itself() {
        let messages = [tool_result("t1"), guided("g1")];
        let anchor = rewind_anchor(&messages, &MessageId::new("g1"));
        assert_eq!(anchor.map(MessageId::as_str), Some("g1"));
    }

    #[test]
    fn other_attachments_and_replies_are_no_target() {
        let messages = [
            user("u1", "hi", UserOrigin::Human),
            Message::Attachment(AttachmentMessage {
                id: MessageId::new("x1"),
                source: "hook_additional_context".into(),
                text: "context".into(),
                data: serde_json::Value::Null,
            }),
            tool_result("t1"),
        ];
        assert_eq!(rewind_anchor(&messages, &MessageId::new("x1")), None);
        assert_eq!(rewind_anchor(&messages, &MessageId::new("t1")), None);
        assert_eq!(rewind_anchor(&messages, &MessageId::new("missing")), None);
    }
}
