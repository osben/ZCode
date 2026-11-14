use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};

use super::automatic_turn_subject;

fn user(origin: UserOrigin) -> Message {
    Message::User(UserMessage {
        id: MessageId::new("m"),
        content: vec![ContentBlock::Text {
            text: "x".to_owned(),
        }],
        origin,
        intent: None,
        stall_execution: None,
    })
}

fn meta(source: &str) -> Message {
    user(UserOrigin::Meta {
        source: source.to_owned(),
    })
}

#[test]
fn turns_the_session_opens_by_itself_name_their_kind() {
    assert_eq!(
        automatic_turn_subject(&[meta(crate::cron::CRON_SOURCE)]),
        Some("automation turns")
    );
    assert_eq!(
        automatic_turn_subject(&[meta(crate::notices::NOTICE_SOURCE)]),
        Some("background results")
    );
    assert_eq!(
        automatic_turn_subject(&[meta(crate::peers::PEER_SOURCE)]),
        Some("background results")
    );
    assert_eq!(
        automatic_turn_subject(&[meta(rust_cli_kernel_api::goal::CONTINUATION_SOURCE)]),
        Some("runtime continuations")
    );
}

#[test]
fn a_human_input_is_interactive() {
    assert_eq!(automatic_turn_subject(&[user(UserOrigin::Human)]), None);
    // A skill expansion follows the human input with meta messages of its own.
    assert_eq!(
        automatic_turn_subject(&[user(UserOrigin::Human), meta("skill")]),
        None
    );
    assert_eq!(automatic_turn_subject(&[]), None);
}
