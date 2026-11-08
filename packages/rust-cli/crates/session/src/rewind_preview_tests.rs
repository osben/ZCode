//! Fork: the dry-run rewind preview (Node's file rewind preview, crates/session rewinds nothing):
//! which files a code rewind to a message would restore, and which conflicts block — nothing on
//! disk or in the store changes.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WritePrecondition};
use rust_cli_kernel_api::env_files::PutFile;
use rust_cli_kernel_api::env_rewind::content_hash;
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::session_api::{
    KernelEvent, RewindPreview, RewindSafeFile, RewindUnsafeFile, RewindUnsafeReason, SessionHandle,
};
use rust_cli_kernel_api::store::ArtifactPurpose;
use rust_cli_kernel_api::testing::{
    MemoryEnvironment, ScriptedModel, text_response, tool_use_response,
};
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::test_support::{Built, Setup, submit, until};

/// The Write double from `rewind_tests`, with the tool name recorded in the checkpoint artifact the
/// way the production checkpoint writer does (tools/checkpoint.rs).
pub(crate) struct Writing;

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
            "beforeContent": before, "afterContent": after, "structuredPatch": []}],
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
                "additions": 1, "deletions": 0}}),
        })
    }
}

/// One turn that writes `path` (seeded with `seed` when the file existed before the turn); returns
/// the session, the environment and the turn's user message.
pub(crate) async fn wrote(
    path: &str,
    content: &str,
    seed: Option<&str>,
) -> (Built, Arc<MemoryEnvironment>, MessageId) {
    let model = Arc::new(ScriptedModel::new(vec![
        tool_use_response(
            "toolu_1",
            "Write",
            &json!({"file_path": path, "content": content}),
        ),
        text_response(&["done"]),
    ]));
    let env = crate::test_support::env();
    if let Some(seed) = seed {
        env.set_file(path, seed);
    }
    let mut setup = Setup::new(model);
    setup.set_env(env.clone());
    setup.tools = vec![Arc::new(Writing)];
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "write it")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnFinished { .. })
    })
    .await;
    let prompt = built.session.view().await.unwrap().messages[0].id().clone();
    (built, env, prompt)
}

fn file(env: &MemoryEnvironment, path: &str) -> Option<String> {
    crate::rewind::tests::file(env, path)
}

/// After one Write the preview reports the file as safe to restore: one operation, the tool that
/// wrote it — and nothing is applied (the file keeps the turn's content, the history is intact and
/// the prepared token was released).
#[tokio::test]
async fn preview_after_a_write_shows_one_safe_file() {
    let (built, env, prompt) = wrote("/work/a.txt", "new\n", Some("old\n")).await;
    let preview = built.session.rewind_preview(&prompt).await.unwrap();
    let RewindPreview { safe, unsafe_files } = preview;
    assert_eq!(
        safe,
        [RewindSafeFile {
            path: "/work/a.txt".to_owned(),
            delete: false,
            operation_count: 1,
            tool_names: vec!["Write".to_owned()],
        }]
    );
    assert!(unsafe_files.is_empty());
    // Nothing changed: the file and the history are as the turn left them.
    assert_eq!(file(&env, "/work/a.txt").as_deref(), Some("new\n"));
    assert_eq!(built.session.view().await.unwrap().messages.len(), 4);
    // The dry run prepared and released the token without applying it.
    assert_eq!(env.rewinds_finished().len(), 1);
    // The rewind itself still works after the preview.
    let preview = built.session.rewind_preview(&prompt).await.unwrap();
    assert_eq!(preview.safe.len(), 1);
}

/// The file changed on disk after the turn: the preview reports it as externally modified (with
/// both hashes) and leaves it untouched.
#[tokio::test]
async fn an_externally_changed_file_is_reported_and_untouched() {
    let (built, env, prompt) = wrote("/work/a.txt", "new\n", Some("old\n")).await;
    env.set_file("/work/a.txt", "edited by hand\n");
    let preview = built.session.rewind_preview(&prompt).await.unwrap();
    let RewindPreview { safe, unsafe_files } = preview;
    assert!(safe.is_empty());
    assert_eq!(
        unsafe_files,
        [RewindUnsafeFile {
            path: "/work/a.txt".to_owned(),
            reason: RewindUnsafeReason::ExternalModified,
            operation_count: 1,
            tool_names: vec!["Write".to_owned()],
            current_hash: Some(content_hash(b"edited by hand\n")),
            expected_hash: Some(content_hash(b"new\n")),
            message: None,
        }]
    );
    assert_eq!(
        file(&env, "/work/a.txt").as_deref(),
        Some("edited by hand\n")
    );
    assert_eq!(built.session.view().await.unwrap().messages.len(), 4);
}

/// A file the turn created would be deleted by the rewind: `delete` is true.
#[tokio::test]
async fn a_file_created_by_the_turn_shows_delete() {
    let (built, env, prompt) = wrote("/work/made.txt", "made\n", None).await;
    let preview = built.session.rewind_preview(&prompt).await.unwrap();
    let RewindPreview { safe, unsafe_files } = preview;
    assert!(unsafe_files.is_empty());
    assert_eq!(
        safe,
        [RewindSafeFile {
            path: "/work/made.txt".to_owned(),
            delete: true,
            operation_count: 1,
            tool_names: vec!["Write".to_owned()],
        }]
    );
    // Nothing applied: the file the turn created still exists.
    assert_eq!(file(&env, "/work/made.txt").as_deref(), Some("made\n"));
}
