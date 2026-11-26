//! Fork: the `Live` wiring of ended background commands (specs/fork-rust-background-and-context-usage.md): the session
//! reads the output tail of a command the ledger stopped listing, the list keeps it, and the Activity boundary folds it
//! after the next real message.

use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::manage::{BackgroundEntry, BackgroundKind};
use rust_cli_kernel_api::panels::BashOutputRead;
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_protocol_core::sessions::SessionSink;

use super::*;

fn set_ledger(handle: &TestHandle, entries: Vec<BackgroundEntry>) {
    handle.background.lock_unpoisoned().entries = Some(entries);
}

fn running_shell() -> BackgroundEntry {
    BackgroundEntry::new(
        "b1",
        BackgroundKind::Shell,
        "sleep 1",
        BackgroundStatus::Running,
    )
}

/// An open session whose command `b1` ended: the ledger lists nothing and the output read has `text`; the notice's
/// status reached the projection.
async fn with_ended_command(
    status: BackgroundStatus,
    text: &str,
) -> (TaskScope, Arc<Server>, Arc<Bridged<Live>>) {
    let (scope, server, handle, _queries) = open(false).await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    set_ledger(&handle, vec![running_shell()]);
    live.sink.shells_changed().await;
    assert_eq!(
        live.sink.snapshot()["backgroundWorks"][0]["status"],
        "running"
    );
    set_ledger(&handle, Vec::new());
    handle.background.lock_unpoisoned().output = Some(BashOutputRead::Window {
        status: None,
        text: text.to_owned(),
        truncated: false,
        path: rust_cli_kernel_api::env::EnvPath::new("/t/b1.output"),
    });
    live.sink
        .event(SequencedEvent {
            seq: 1,
            revision: 1,
            event: KernelEvent::BackgroundWork {
                work: "b1".into(),
                status,
            },
        })
        .await;
    // The pump flushes after a batch of events; that is where the ledger is read again.
    live.sink.flush().await;
    (scope, server, live)
}

/// Rule 4: the session reads the tail of the command that ended, once, and the snapshot keeps the work with its end
/// state and the summary.
#[tokio::test]
async fn an_ended_command_stays_in_the_snapshot_with_its_output_tail() {
    let (_scope, _server, live) =
        with_ended_command(BackgroundStatus::Completed, "compiled 3 files\n").await;
    let works = live.sink.snapshot()["backgroundWorks"].clone();
    assert_eq!(works.as_array().unwrap().len(), 1, "{works}");
    assert_eq!(works[0]["workId"], "b1");
    assert_eq!(works[0]["status"], "resultPending", "{works}");
    assert_eq!(works[0]["resultSummary"], "compiled 3 files\n");
    assert_eq!(works[0]["cancellable"], false);
    assert!(works[0]["endedAt"].is_u64(), "{works}");
}

/// Rule 7: a real user message after the end puts the command in the boundary, so the UI folds it.
#[tokio::test]
async fn a_real_message_folds_an_ended_command() {
    let (_scope, _server, live) = with_ended_command(BackgroundStatus::Failed, "boom").await;
    assert!(
        live.sink
            .snapshot()
            .get("activitySummaryDismissed")
            .is_none()
    );
    user_turn(
        &live.sink,
        2,
        rust_cli_kernel_api::message::UserOrigin::Human,
    )
    .await;
    let boundary = live.sink.snapshot()["activitySummaryDismissed"].clone();
    assert_eq!(boundary["workIds"], json!(["b1"]), "{boundary}");
    let works = live.sink.snapshot()["backgroundWorks"].clone();
    assert_eq!(works[0]["status"], "failed", "the record stays: {works}");
}

/// Rule 7: a message the kernel wrote (the background result) does not set the boundary, so the ended command shows.
#[tokio::test]
async fn a_background_result_message_does_not_fold_an_ended_command() {
    let (_scope, _server, live) = with_ended_command(BackgroundStatus::Killed, "").await;
    user_turn(
        &live.sink,
        2,
        rust_cli_kernel_api::message::UserOrigin::Meta {
            source: "task-notification".into(),
        },
    )
    .await;
    let snapshot = live.sink.snapshot();
    assert!(snapshot.get("activitySummaryDismissed").is_none());
    assert_eq!(snapshot["backgroundWorks"][0]["status"], "cancelled");
    assert!(
        snapshot["backgroundWorks"][0]
            .get("resultSummary")
            .is_none()
    );
}
