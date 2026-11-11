//! Fork: the turn header's `fileChanges` summary and the `canRewindFiles` action from
//! `KernelEvent::FileChanges` (Node's product projection: counts on the header row, the rewind-files
//! action only once the turn settles and the checkpoints are rewindable), the reverted flip on
//! `KernelEvent::TurnFilesReverted`, and the cold projection from a view with the kernel's
//! per-turn summaries.

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId, TraceId, TurnId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    FileChange, KernelEvent, SequencedEvent, SessionView, TurnFileCount, TurnFileFacts, TurnOutcome,
};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use serde_json::{Value, json};

use super::*;

fn empty_view() -> SessionView {
    SessionView::new(
        SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: None,
        },
        Vec::new(),
        selection(),
        PermissionMode::Default,
    )
}

/// Feeds events in order (seq from 1; revision bumps on every state change, like the session actor).
struct Feed {
    projection: Projection,
    seq: u64,
    revision: u64,
}

impl Feed {
    fn new() -> Self {
        Self {
            projection: Projection::from_view(&empty_view(), Followup::Queue, vec!["high".into()]),
            seq: 0,
            revision: 0,
        }
    }

    fn apply(&mut self, event: KernelEvent) -> Vec<Value> {
        self.seq += 1;
        if !matches!(
            event,
            KernelEvent::StreamDelta { .. } | KernelEvent::ContextUsage { .. }
        ) {
            self.revision += 1;
        }
        self.projection.apply(
            &SequencedEvent {
                seq: self.seq,
                event,
                revision: self.revision,
            },
            2000 + self.seq,
        )
    }
}

fn change(path: &str, additions: u64, deletions: u64) -> FileChange {
    FileChange {
        path: path.into(),
        additions,
        deletions,
        machine: Default::default(),
    }
}

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        origin: UserOrigin::Human,
    })
}

fn assistant(id: &str, text: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        model: "m".into(),
        stop_reason: None,
        usage: None,
    })
}

/// The last turn header row delta of a batch (refresh_actions appends its own header upsert after
/// turn state changes, so the last one carries the settled row).
fn header(deltas: &[Value]) -> &Value {
    deltas
        .iter()
        .rev()
        .find(|delta| delta["row"]["kind"] == "turnHeader")
        .map(|delta| &delta["row"])
        .expect("a turn header row delta")
}

#[test]
fn batches_merge_per_path_and_offer_rewind_files_when_the_turn_settles() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let first = feed.apply(KernelEvent::FileChanges {
        turn: TurnId::new("turn_1"),
        files: vec![change("src/a.txt", 3, 1)],
        rewindable: true,
        turn_input: None,
    });
    assert_eq!(
        header(&first)["fileChanges"],
        json!({"additions": 3, "deletions": 1, "files": 1, "state": "active"})
    );
    // The turn is still running: the summary shows, the rewind action does not.
    assert!(header(&first)["actions"].is_null());

    let second = feed.apply(KernelEvent::FileChanges {
        turn: TurnId::new("turn_1"),
        files: vec![change("src/a.txt", 2, 2), change("src/b.rs", 5, 0)],
        rewindable: true,
        turn_input: None,
    });
    // a.txt sums across batches (3+2 added, 1+2 removed) and is counted once; b.rs is new.
    assert_eq!(
        header(&second)["fileChanges"],
        json!({"additions": 10, "deletions": 3, "files": 2, "state": "active"})
    );
    assert!(header(&second)["actions"].is_null());

    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let row = header(&finished);
    assert_eq!(row["state"], "completedSuccess");
    assert_eq!(
        row["fileChanges"],
        json!({"additions": 10, "deletions": 3, "files": 2, "state": "active"})
    );
    assert_eq!(row["actions"], json!({"canRewindFiles": true}));
}

#[test]
fn batches_without_rewindable_checkpoints_keep_the_summary_but_not_the_action() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::FileChanges {
        turn: TurnId::new("turn_1"),
        files: vec![change("src/a.txt", 4, 2)],
        rewindable: false,
        turn_input: None,
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let row = header(&finished);
    assert_eq!(
        row["fileChanges"],
        json!({"additions": 4, "deletions": 2, "files": 1, "state": "active"})
    );
    assert!(row["actions"].is_null());
}

/// The turn's checkpoints were all restored: the header's state flips to `reverted`, the counts
/// stay, and the rewind-files action is dropped.
#[test]
fn the_reverted_event_flips_the_header_and_drops_the_action() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_1", "write it"),
    });
    feed.apply(KernelEvent::FileChanges {
        turn: TurnId::new("turn_1"),
        files: vec![change("src/a.txt", 3, 1)],
        rewindable: true,
        turn_input: None,
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    assert_eq!(
        header(&finished)["actions"],
        json!({"canRewindFiles": true})
    );

    let reverted = feed.apply(KernelEvent::TurnFilesReverted {
        turn_input: MessageId::new("msg_1"),
    });
    let row = header(&reverted);
    // The counts stay; only the state flips.
    assert_eq!(
        row["fileChanges"],
        json!({"additions": 3, "deletions": 1, "files": 1, "state": "reverted"})
    );
    assert!(row["actions"].is_null());
}

/// A turn opened by a model-only message (a background task notification) has no typed user
/// row: the per-turn file queries address its header through the turn input the kernel's
/// `FileChanges` carried, and the reverted event finds the turn the same way.
#[test]
fn a_notification_turn_header_is_targeted_through_its_turn_input() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_n"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: Message::User(UserMessage {
            intent: None,
            id: MessageId::new("msg_notice"),
            content: vec![ContentBlock::Text {
                text: "<task-notification>done</task-notification>".into(),
            }],
            origin: UserOrigin::Meta {
                source: "notification".into(),
            },
        }),
    });
    feed.apply(KernelEvent::FileChanges {
        turn: TurnId::new("turn_n"),
        files: vec![change("result.md", 1, 1)],
        rewindable: true,
        turn_input: Some(MessageId::new("msg_notice")),
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_n"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let row = header(&finished).clone();
    let row_id = row["rowId"].as_u64().unwrap();
    let entity = row["entityId"].as_str().unwrap();
    for action in [RowAction::FileChanges, RowAction::FileRewind] {
        let target = feed
            .projection
            .row_target(row_id, entity, action)
            .expect("the notification turn header is a file query target");
        assert_eq!(target.user_message, "msg_notice");
    }

    let reverted = feed.apply(KernelEvent::TurnFilesReverted {
        turn_input: MessageId::new("msg_notice"),
    });
    assert_eq!(header(&reverted)["fileChanges"]["state"], "reverted");
}

/// A cold projection from a view with the kernel's per-turn summaries shows the same header the
/// live one had: counts, `state`, and the `canRewindFiles` action for the active turns.
#[test]
fn a_cold_projection_from_the_view_shows_the_same_header() {
    let mut view = empty_view();
    view.messages = vec![user("msg_1", "write it"), assistant("msg_2", "done")];
    view.turn_files.insert(
        MessageId::new("msg_1"),
        TurnFileFacts {
            files: vec![
                TurnFileCount {
                    path: "src/a.txt".into(),
                    additions: 3,
                    deletions: 1,
                },
                TurnFileCount {
                    path: "src/b.rs".into(),
                    additions: 5,
                    deletions: 0,
                },
            ],
            rewindable: true,
            reverted: false,
        },
    );
    let projection = Projection::from_view(&view, Followup::Queue, vec!["high".into()]);
    let snapshot = projection.snapshot(1, "epoch");
    let row = snapshot["rows"]["window"]
        .as_array()
        .expect("rows")
        .iter()
        .rev()
        .find(|row| row["kind"] == "turnHeader")
        .expect("the turn header");
    assert_eq!(
        row["fileChanges"],
        json!({"additions": 8, "deletions": 1, "files": 2, "state": "active"})
    );
    assert_eq!(row["actions"], json!({"canRewindFiles": true}));

    // A reverted turn carries the same counts with `state: "reverted"` and no action.
    let mut view = empty_view();
    view.messages = vec![user("msg_1", "write it"), assistant("msg_2", "done")];
    view.turn_files.insert(
        MessageId::new("msg_1"),
        TurnFileFacts {
            files: vec![TurnFileCount {
                path: "src/a.txt".into(),
                additions: 3,
                deletions: 1,
            }],
            rewindable: true,
            reverted: true,
        },
    );
    let projection = Projection::from_view(&view, Followup::Queue, vec!["high".into()]);
    let snapshot = projection.snapshot(1, "epoch");
    let row = snapshot["rows"]["window"]
        .as_array()
        .expect("rows")
        .iter()
        .rev()
        .find(|row| row["kind"] == "turnHeader")
        .expect("the turn header");
    assert_eq!(
        row["fileChanges"],
        json!({"additions": 3, "deletions": 1, "files": 1, "state": "reverted"})
    );
    assert!(row["actions"].is_null());
}
