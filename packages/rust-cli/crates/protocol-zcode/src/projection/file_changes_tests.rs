//! Fork: the turn header's `fileChanges` summary and the `canRewindFiles` action from
//! `KernelEvent::FileChanges` (Node's product projection: counts on the header row, the rewind-files
//! action only once the turn settles and the checkpoints are rewindable).

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId, TurnId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    FileChange, KernelEvent, SequencedEvent, SessionView, TurnOutcome,
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
