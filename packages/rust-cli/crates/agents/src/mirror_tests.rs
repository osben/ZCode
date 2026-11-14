use futures_util::StreamExt;
use rust_cli_kernel_api::agents::ChildLive;
use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::message::{AssistantMessage, ContentBlock, Message};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::QueryEvent;
use rust_cli_kernel_api::session_api::TurnOutcome;

use super::Mirrors;

fn started(run: u64) -> ChildLive {
    ChildLive::Started {
        run,
        selection: rust_cli_kernel_api::model::ModelSelection {
            provider: "p".to_owned(),
            model: "m".to_owned(),
            reasoning: None,
            connection: None,
        },
    }
}

fn delta(text: &str) -> ChildLive {
    ChildLive::Event(QueryEvent::Delta {
        message: 0,
        index: 0,
        delta: BlockDelta::Text(text.to_owned()),
    })
}

fn assistant(id: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: id.to_owned(),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

#[tokio::test]
async fn a_late_subscriber_gets_the_run_so_far_with_the_partial_text() {
    let mirrors = Mirrors::default();
    let child = SessionId::new("child");
    mirrors.publish(&child, started(1));
    mirrors.publish(&child, ChildLive::Committed(assistant("a1")));
    mirrors.publish(&child, delta("E2E_"));
    mirrors.publish(&child, delta("CHILD_"));

    let mut feed = mirrors.feed(&child);
    assert_eq!(
        feed.replay,
        vec![
            started(1),
            ChildLive::Committed(assistant("a1")),
            delta("E2E_CHILD_"),
        ]
    );
    mirrors.publish(&child, delta("DONE"));
    assert_eq!(feed.live.next().await, Some(delta("DONE")));
}

#[tokio::test]
async fn a_stored_message_clears_the_deltas_and_a_finished_run_replays_nothing() {
    let mirrors = Mirrors::default();
    let child = SessionId::new("child");
    mirrors.publish(&child, started(1));
    mirrors.publish(&child, delta("partial"));
    mirrors.publish(&child, ChildLive::Committed(assistant("a1")));
    assert_eq!(
        mirrors.feed(&child).replay,
        vec![started(1), ChildLive::Committed(assistant("a1"))]
    );
    mirrors.publish(&child, ChildLive::Finished(TurnOutcome::Success));
    assert!(mirrors.feed(&child).replay.is_empty());
}

#[tokio::test]
async fn only_the_latest_progress_of_a_tool_is_replayed() {
    let mirrors = Mirrors::default();
    let child = SessionId::new("child");
    let progress = |n: u64| {
        ChildLive::Event(QueryEvent::ToolProgress {
            tool_use: rust_cli_kernel_api::ids::ToolUseId::new("t1"),
            progress: rust_cli_kernel_api::tool::ToolProgress {
                data: serde_json::json!({ "n": n }),
            },
        })
    };
    mirrors.publish(&child, started(1));
    mirrors.publish(&child, progress(1));
    mirrors.publish(&child, progress(2));
    assert_eq!(mirrors.feed(&child).replay, vec![started(1), progress(2)]);
}

#[tokio::test]
async fn a_run_that_finished_unread_is_replayed_once_to_the_run_feed() {
    let mirrors = Mirrors::default();
    let child = SessionId::new("child");
    mirrors.publish(&child, started(7));
    mirrors.publish(&child, delta("fast"));
    mirrors.publish(&child, ChildLive::Committed(assistant("a1")));
    mirrors.publish(&child, ChildLive::Finished(TurnOutcome::Success));

    // The side tab sees a finished child as idle.
    assert!(mirrors.feed(&child).replay.is_empty());
    assert_eq!(
        mirrors.run_feed(&child).replay,
        vec![
            started(7),
            ChildLive::Committed(assistant("a1")),
            ChildLive::Finished(TurnOutcome::Success),
        ]
    );
    // Taken once.
    assert!(mirrors.run_feed(&child).replay.is_empty());
}

#[tokio::test]
async fn a_run_read_live_or_followed_by_another_is_not_kept() {
    let mirrors = Mirrors::default();
    let child = SessionId::new("child");
    let feed = mirrors.run_feed(&child);
    mirrors.publish(&child, started(1));
    mirrors.publish(&child, ChildLive::Finished(TurnOutcome::Success));
    drop(feed);
    assert!(mirrors.run_feed(&child).replay.is_empty());

    mirrors.publish(&child, started(2));
    mirrors.publish(&child, ChildLive::Finished(TurnOutcome::Success));
    mirrors.publish(&child, started(3));
    assert_eq!(mirrors.run_feed(&child).replay, vec![started(3)]);
}

#[tokio::test]
async fn run_numbers_increase() {
    let mirrors = Mirrors::default();
    let first = mirrors.next_run();
    assert!(mirrors.next_run() > first);
}
