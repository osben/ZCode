//! 会话标题的三种来源（titles.md §4）：首条输入、生成（按 Node 的来源条件）、改名。
use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::json;

use crate::tests::{TestStore, batch, meta, user};

fn row(test: &TestStore) -> Vec<serde_json::Value> {
    test.rows("select title, title_source, title_message_id from session")
        .remove(0)
}

#[tokio::test]
async fn generated_titles_follow_the_node_source_condition() {
    let test = TestStore::new();
    let session = SessionId::new("sess_title");
    test.store
        .create(meta("sess_title", "/w", ""))
        .await
        .unwrap();
    assert_eq!(row(&test), [json!(""), json!("default"), json!(null)]);
    // Fork: a cold load reports whether the stored title is still automatic (a later input may retry it).
    let pending = async || test.store.load(&session).await.unwrap().title_pending;
    assert!(pending().await);
    test.store
        .commit(
            &session,
            batch(None, vec![user("msg_1", "  explain   the digest ")]),
        )
        .await
        .unwrap();
    assert_eq!(
        row(&test),
        [
            json!("explain the digest"),
            json!("first_input"),
            json!(null)
        ]
    );
    assert!(pending().await);
    let generated = Fact::TitleGenerated {
        title: "Hook trust digest".to_owned(),
        message: Some(MessageId::new("msg_1")),
    };
    test.store
        .commit(&session, batch(None, vec![generated]))
        .await
        .unwrap();
    assert_eq!(row(&test), ["Hook trust digest", "generated", "msg_1"]);
    assert!(!pending().await);
    // 改名之后（custom）生成的标题不再写入，整批失败。
    let renamed = Fact::TitleChanged {
        title: "Mine".to_owned(),
    };
    test.store
        .commit(&session, batch(None, vec![renamed]))
        .await
        .unwrap();
    let late = Fact::TitleGenerated {
        title: "Too late".to_owned(),
        message: None,
    };
    assert!(
        test.store
            .commit(&session, batch(None, vec![late]))
            .await
            .is_err()
    );
    assert_eq!(row(&test)[..2], ["Mine", "custom"]);
}

/// 用户调用 skill：首条输入是命令标签，临时标题按用户输入的样子（ext.md §2.7）。
#[tokio::test]
async fn a_command_input_titles_the_session_as_typed() {
    let test = TestStore::new();
    let session = SessionId::new("sess_title");
    test.store
        .create(meta("sess_title", "/w", ""))
        .await
        .unwrap();
    let tags = rust_cli_kernel_api::user_command::command_tags("greet", "Ada");
    test.store
        .commit(&session, batch(None, vec![user("msg_1", &tags)]))
        .await
        .unwrap();
    assert_eq!(
        row(&test),
        [json!("/greet Ada"), json!("first_input"), json!(null)]
    );
}

/// Fork: an input without text (an attachment-only message) keeps the `New session` placeholder as `default`, and the
/// first real input replaces it (Node `persistSession`, specs/fork-rust-agent-parity.md, Blank first input title).
#[tokio::test]
async fn a_blank_first_input_keeps_the_placeholder_until_a_real_input() {
    let test = TestStore::new();
    let session = SessionId::new("sess_title");
    test.store
        .create(meta("sess_title", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(&session, batch(None, vec![user("msg_1", "  \n ")]))
        .await
        .unwrap();
    assert_eq!(
        row(&test),
        [json!("New session"), json!("default"), json!(null)]
    );
    test.store
        .commit(&session, batch(None, vec![user("msg_2", "real question")]))
        .await
        .unwrap();
    assert_eq!(
        row(&test),
        [json!("real question"), json!("first_input"), json!(null)]
    );
    test.store
        .commit(&session, batch(None, vec![user("msg_3", " ")]))
        .await
        .unwrap();
    assert_eq!(row(&test)[..2], ["real question", "first_input"]);
}

/// Fork: quotes are an input intent's (quote_intent_tests.rs); a text that merely ends with a quote block, without an
/// intent, is plain text: the title and the part keep it whole.
#[tokio::test]
async fn a_quote_block_without_an_intent_is_plain_text() {
    use rust_cli_kernel_api::conversation_quote::{Quote, compose};
    let test = TestStore::new();
    let session = SessionId::new("sess_quoted");
    test.store
        .create(meta("sess_quoted", "/w", ""))
        .await
        .unwrap();
    let quoted = compose(
        "explain this",
        &[Quote {
            text: "E2E selection".to_owned(),
            path: None,
            sender_name: None,
            sender_id: None,
            message_id: None,
            sent_at: None,
        }],
    );
    test.store
        .commit(&session, batch(None, vec![user("msg_1", &quoted)]))
        .await
        .unwrap();
    assert_eq!(
        row(&test)[0],
        json!(rust_cli_node_records::records::title_from_input(&quoted))
    );
    let parts = test.rows("select data from part");
    let text: serde_json::Value = serde_json::from_str(parts[0][0].as_str().unwrap()).unwrap();
    assert_eq!(text["text"], quoted);
    assert!(text.get("metadata").is_none());
}
