//! Fork: the per-turn file summary (Node's `v4/conversation/fileChanges` and per-turn
//! `fileRewindPreview`, crates/session changes nothing by the two queries): the turn's own
//! checkpoints only — a later turn writing the same file keeps its writes — and the summary
//! rewind restoring exactly that turn.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WritePrecondition};
use rust_cli_kernel_api::env_files::PutFile;
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::session_api::{
    Ack, Command, CommandResult, KernelEvent, RewindPreview, RewindSafeFile, RewindUnsafeFile,
    RewindUnsafeReason, SessionHandle,
};
use rust_cli_kernel_api::store::{ArtifactPurpose, SessionStore};
use rust_cli_kernel_api::testing::{
    MemoryArtifacts, MemoryEnvironment, ScriptedModel, text_response, tool_use_response,
};
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::test_support::{Built, Setup, envelope, submit, until};

/// The Write double from `rewind_tests`, with the write's real hunk in the artifact (the way
/// tools/checkpoint.rs records it) so the summary counts the '+' / '-' lines like the App does.
pub(crate) struct Writing;

/// One write's hunk, shaped like tools/checkpoint.rs (a single hunk around the changed region).
fn hunk(before: Option<&str>, after: &str) -> Value {
    let old: Vec<&str> = before.unwrap_or_default().split('\n').filter(|l| !l.is_empty()).collect();
    let new: Vec<&str> = after.split('\n').filter(|l| !l.is_empty()).collect();
    let mut lines: Vec<String> = old.iter().map(|line| format!("-{line}")).collect();
    lines.extend(new.iter().map(|line| format!("+{line}")));
    json!({
        "oldStart": 1,
        "oldLines": old.len(),
        "newStart": 1,
        "newLines": new.len(),
        "lines": lines,
    })
}

#[async_trait]
impl Tool for Writing {
    fn name(&self) -> &str {
        "Write"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn description(&self, _context: &rust_cli_kernel_api::tool::PromptContext) -> String {
        "write".into()
    }
    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let path = input["file_path"].as_str().unwrap_or_default().to_owned();
        let after = input["content"].as_str().unwrap_or_default().to_owned();
        let read = ReadFile {
            path: EnvPath::new(&path),
        };
        let before = context
            .machine
            .files()
            .read_file(&context.workspace, read)
            .await
            .ok()
            .map(|file| String::from_utf8(file.bytes).unwrap_or_default());
        let put = PutFile {
            path: EnvPath::new(&path),
            bytes: after.clone().into_bytes(),
            precondition: WritePrecondition::Any,
            create_parents: true,
        };
        context
            .machine
            .files()
            .put_file(&context.workspace, context.operation.clone(), put)
            .await?;
        let artifact = json!({"files": [{"path": path, "existedBefore": before.is_some(),
            "beforeContent": before, "afterContent": after,
            "structuredPatch": [hunk(before.as_deref(), &after)]}],
            "toolName": "Write"});
        let reference = context
            .artifacts
            .put(
                &context.session,
                ArtifactPurpose::Checkpoint,
                "application/json".into(),
                artifact.to_string().into_bytes(),
            )
            .await
            .map_err(|error| ToolError::Failed {
                message: error.to_string(),
            })?;
        Ok(ToolOutput {
            content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
                text: "written".into(),
            }],
            is_error: false,
            display: json!({"checkpoint": {"artifact": reference, "path": path,
                "additions": 1, "deletions": 1}}),
        })
    }
}

/// Two turns that both write `path` (seeded with `seed`); returns the session, the environment,
/// both turns' user messages and the shared artifacts.
async fn two_turns(
    path: &str,
    seed: &str,
    first: &str,
    second: &str,
) -> (Built, Arc<MemoryEnvironment>, MessageId, MessageId, Arc<MemoryArtifacts>) {
    let model = Arc::new(ScriptedModel::new(vec![
        tool_use_response(
            "toolu_1",
            "Write",
            &json!({"file_path": path, "content": first}),
        ),
        text_response(&["done"]),
        tool_use_response(
            "toolu_2",
            "Write",
            &json!({"file_path": path, "content": second}),
        ),
        text_response(&["done"]),
    ]));
    let env = crate::test_support::env();
    env.set_file(path, seed);
    let artifacts = Arc::new(MemoryArtifacts::default());
    let mut setup = Setup::new(model);
    setup.set_env(env.clone());
    setup.artifacts = artifacts.clone();
    setup.tools = vec![Arc::new(Writing)];
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "write it")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnFinished { .. })
    })
    .await;
    built.session.send(submit("c2", "write again")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnFinished { .. })
    })
    .await;
    let messages = built.session.view().await.unwrap().messages;
    let (first, second) = (messages[0].id().clone(), messages[4].id().clone());
    (built, env, first, second, artifacts)
}

fn file(env: &MemoryEnvironment, path: &str) -> Option<String> {
    crate::rewind::tests::file(env, path)
}

/// Turn 2's summary, preview and rewind touch only turn 2's checkpoints: the file goes back to
/// turn 1's content (not the seed), turn 1 keeps its own restorable checkpoint, and turn 2 flips
/// to reverted.
#[tokio::test]
async fn turn_two_changes_preview_and_rewind_touch_only_turn_two() {
    let (built, env, first, second, _artifacts) =
        two_turns("/work/a.txt", "old\n", "mid\n", "end\n").await;

    // The summary of each turn reports only that turn's write.
    let turn_one = built.session.turn_file_changes(&first).await.unwrap();
    assert_eq!(turn_one.reverted, false);
    assert_eq!(turn_one.items.len(), 1);
    assert_eq!(turn_one.items[0].path, "/work/a.txt");
    assert_eq!(turn_one.items[0].additions, 1);
    assert_eq!(turn_one.items[0].deletions, 1);
    assert_eq!(turn_one.items[0].write_count, 1);
    assert_eq!(turn_one.items[0].tool_names, vec!["Write".to_owned()]);
    assert_eq!(turn_one.items[0].patches.len(), 1);
    let turn_two = built.session.turn_file_changes(&second).await.unwrap();
    assert_eq!(turn_two.reverted, false);
    assert_eq!(turn_two.items.len(), 1);
    assert_eq!(turn_two.items[0].additions, 1);
    assert_eq!(turn_two.items[0].write_count, 1);

    // Turn 1's restore alone would conflict (turn 2 rewrote the file after it); turn 2's is safe.
    let preview = built.session.turn_rewind_preview(&first).await.unwrap();
    let RewindPreview { safe, unsafe_files } = preview;
    assert!(safe.is_empty());
    assert_eq!(unsafe_files.len(), 1);
    assert_eq!(unsafe_files[0].reason, RewindUnsafeReason::ExternalModified);
    let preview = built.session.turn_rewind_preview(&second).await.unwrap();
    let RewindPreview { safe, unsafe_files } = preview;
    assert!(unsafe_files.is_empty());
    assert_eq!(
        safe,
        [RewindSafeFile {
            path: "/work/a.txt".to_owned(),
            delete: false,
            operation_count: 1,
            tool_names: vec!["Write".to_owned()],
        }]
    );

    // The command restores only turn 2's checkpoint: the file becomes turn 1's content, the
    // history is not cut, and the reverted event names turn 2.
    let mut events = built.session.subscribe(Some(0));
    let ack = built
        .session
        .send(envelope(
            "rewind-turn",
            Command::RewindTurnFiles { target: second.clone() },
        ))
        .await;
    match ack {
        Ack::Accepted {
            result: CommandResult::Rewound { restored, removed },
        } => {
            assert_eq!(removed, 0);
            assert_eq!(restored.len(), 1);
        }
        other => panic!("the turn rewind was not accepted: {other:?}"),
    }
    until(&mut events, |event| {
        matches!(
            event,
            KernelEvent::TurnFilesReverted { turn_input } if turn_input == &second
        )
    })
    .await;
    assert_eq!(file(&env, "/work/a.txt").as_deref(), Some("mid\n"));
    assert_eq!(built.session.view().await.unwrap().messages.len(), 8);

    // Turn 2 reports reverted with no unrestored checkpoints; turn 1 is untouched (its checkpoint
    // now matches the disk again, so it became restorable).
    let turn_two = built.session.turn_file_changes(&second).await.unwrap();
    assert_eq!(turn_two.reverted, true);
    assert!(turn_two.items.is_empty());
    let turn_one = built.session.turn_file_changes(&first).await.unwrap();
    assert_eq!(turn_one.reverted, false);
    assert_eq!(turn_one.items.len(), 1);
    let preview = built.session.turn_rewind_preview(&second).await;
    assert!(preview.is_err());
    let preview = built.session.turn_rewind_preview(&first).await.unwrap();
    assert_eq!(preview.safe.len(), 1);
}

/// An externally modified file makes the per-turn preview unsafe and the command rejected, with
/// nothing written.
#[tokio::test]
async fn an_externally_changed_file_blocks_the_turn_rewind() {
    let (built, env, _first, second, _artifacts) =
        two_turns("/work/a.txt", "old\n", "mid\n", "end\n").await;
    env.set_file("/work/a.txt", "edited by hand\n");
    let preview = built.session.turn_rewind_preview(&second).await.unwrap();
    let RewindPreview { safe, unsafe_files } = preview;
    assert!(safe.is_empty());
    assert_eq!(unsafe_files.len(), 1);
    assert_eq!(
        unsafe_files[0],
        RewindUnsafeFile {
            path: "/work/a.txt".to_owned(),
            reason: RewindUnsafeReason::ExternalModified,
            operation_count: 1,
            tool_names: vec!["Write".to_owned()],
            current_hash: Some(rust_cli_kernel_api::env_rewind::content_hash(
                b"edited by hand\n"
            )),
            expected_hash: Some(rust_cli_kernel_api::env_rewind::content_hash(b"end\n")),
            message: None,
        }
    );
    let ack = built
        .session
        .send(envelope(
            "rewind-turn",
            Command::RewindTurnFiles { target: second.clone() },
        ))
        .await;
    match ack {
        Ack::Rejected { reason } => assert!(!reason.is_empty()),
        other => panic!("the turn rewind should have been rejected: {other:?}"),
    }
    // Nothing written: the file and the history are as they were, and neither turn is reverted.
    assert_eq!(
        file(&env, "/work/a.txt").as_deref(),
        Some("edited by hand\n")
    );
    assert_eq!(built.session.view().await.unwrap().messages.len(), 8);
    let changes = built.session.turn_file_changes(&second).await.unwrap();
    assert_eq!(changes.reverted, false);
    assert_eq!(changes.items.len(), 1);
}

/// A cold reopen rebuilds the per-turn summaries from the stored checkpoints and the persisted
/// reverted markers: the active turns keep their counts, the restored one stays reverted.
#[tokio::test]
async fn a_cold_reopen_keeps_the_summaries() {
    let (built, env, first, second, artifacts) =
        two_turns("/work/a.txt", "old\n", "mid\n", "end\n").await;
    let ack = built
        .session
        .send(envelope(
            "rewind-turn",
            Command::RewindTurnFiles { target: second.clone() },
        ))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }));

    // Reopen from the same store and artifacts (a cold load of the same session).
    let loaded = built
        .store
        .load(&rust_cli_kernel_api::ids::SessionId::new("sess_1"))
        .await
        .unwrap();
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
    setup.set_env(env.clone());
    setup.artifacts = artifacts;
    setup.store = Some(built.store.clone());
    setup.opened = crate::Opened::Loaded;
    setup.messages = loaded.messages;
    setup.earlier = loaded.earlier;
    setup.checkpoints = loaded.checkpoints;
    let reopened = setup.build().await;
    // The actor rebuilds its summaries when it starts; a view waits for the actor.
    let view = reopened.session.view().await.unwrap();
    assert_eq!(view.messages.len(), 8);
    let first_facts = view.turn_files.get(&first).expect("turn one's summary");
    assert_eq!(first_facts.reverted, false);
    assert_eq!(first_facts.rewindable, true);
    assert_eq!(first_facts.files.len(), 1);
    assert_eq!(first_facts.files[0].path, "/work/a.txt");
    assert_eq!((first_facts.files[0].additions, first_facts.files[0].deletions), (1, 1));
    let second_facts = view.turn_files.get(&second).expect("turn two's summary");
    assert_eq!(second_facts.reverted, true);
    assert_eq!(second_facts.files.len(), 1);
    assert_eq!(second_facts.files[0].path, "/work/a.txt");
    // The query agrees: turn one still restorable, turn two reverted with no items.
    let turn_one = reopened.session.turn_file_changes(&first).await.unwrap();
    assert_eq!(turn_one.reverted, false);
    assert_eq!(turn_one.items.len(), 1);
    let turn_two = reopened.session.turn_file_changes(&second).await.unwrap();
    assert_eq!(turn_two.reverted, true);
    assert!(turn_two.items.is_empty());
}
