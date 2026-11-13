use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, OwnerEpoch, SessionId, TraceId};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::UserMessage;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{
    ArtifactRef, ArtifactStore, Fact, FactBatch, SessionKind, SessionMeta, StoreError,
};
use rust_cli_kernel_api::testing::MemoryStore;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::test_more::output_text;

const SESSION: &str = "sess_1";
const CONTENT: &[u8] = b"E2E_ARCHIVE_FILE_CONTENT";

fn source(authorization: &str) -> Value {
    json!({"botId": "b1", "chatId": "oc_1", "threadId": "omt_1", "authorizationId": authorization})
}

fn intent(command: &str, source: Option<Value>) -> Value {
    let mut fields = json!({"text": "hi", "sourceCommandId": command});
    if let Some(source) = source {
        fields["botGroupSource"] = source;
    }
    fields
}

fn user(id: &str, origin: UserOrigin, intent: Option<Value>) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: Vec::new(),
        origin,
        intent: intent.map(|value| {
            let Value::Object(fields) = value else {
                panic!("intent must be an object")
            };
            Box::new(InputIntent::from_fields(fields))
        }),
        stall_execution: None,
    })
}

fn human(id: &str, intent: Value) -> Message {
    user(id, UserOrigin::Human, Some(intent))
}

/// Records each request; answers with `reply` (a clone), or never answers when `hold` is set.
#[derive(Default)]
struct Port {
    requests: Mutex<Vec<TopicResourceRequest>>,
    reply: Mutex<Option<Result<TopicResource, String>>>,
    hold: bool,
    dropped: Arc<tokio::sync::Notify>,
}

struct DropFlag(Arc<tokio::sync::Notify>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[async_trait]
impl TopicResources for Port {
    async fn read(&self, request: TopicResourceRequest) -> Result<TopicResource, String> {
        self.requests.lock_unpoisoned().push(request);
        let _flag = DropFlag(self.dropped.clone());
        if self.hold {
            std::future::pending::<()>().await;
        }
        self.reply
            .lock_unpoisoned()
            .clone()
            .unwrap_or_else(|| Err("no reply".to_owned()))
    }
}

/// Artifacts with lookup by id and a local path per artifact, like the node store.
#[derive(Default)]
struct Files {
    objects: Mutex<HashMap<String, (ArtifactRef, Vec<u8>)>>,
}

impl Files {
    fn add(&self, session: &str, id: &str, media_type: &str, bytes: &[u8]) {
        let artifact = ArtifactRef {
            session: SessionId::new(session),
            id: rust_cli_kernel_api::ids::ArtifactId::new(id),
            purpose: ArtifactPurpose::Attachment,
            media_type: media_type.to_owned(),
            size: bytes.len() as u64,
        };
        self.objects
            .lock_unpoisoned()
            .insert(id.to_owned(), (artifact, bytes.to_vec()));
    }

    fn bytes(&self, id: &str) -> Option<(ArtifactRef, Vec<u8>)> {
        self.objects.lock_unpoisoned().get(id).cloned()
    }
}

#[async_trait]
impl ArtifactStore for Files {
    async fn put(
        &self,
        session: &SessionId,
        purpose: ArtifactPurpose,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ArtifactRef, StoreError> {
        let id = format!("tool-output-{}", self.objects.lock_unpoisoned().len() + 1);
        let artifact = ArtifactRef {
            session: session.clone(),
            id: rust_cli_kernel_api::ids::ArtifactId::new(id.clone()),
            purpose,
            media_type,
            size: bytes.len() as u64,
        };
        self.objects
            .lock_unpoisoned()
            .insert(id, (artifact.clone(), bytes));
        Ok(artifact)
    }

    async fn get(&self, artifact: &ArtifactRef) -> Result<Vec<u8>, StoreError> {
        self.bytes(artifact.id.as_str())
            .filter(|(stored, _)| stored.session == artifact.session)
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| StoreError::Storage {
                message: "missing".to_owned(),
            })
    }

    async fn find(
        &self,
        session: &SessionId,
        id: &rust_cli_kernel_api::ids::ArtifactId,
    ) -> Result<Option<ArtifactRef>, StoreError> {
        Ok(self
            .bytes(id.as_str())
            .map(|(artifact, _)| artifact)
            .filter(|artifact| &artifact.session == session))
    }

    fn local_path(&self, artifact: &ArtifactRef) -> Option<PathBuf> {
        Some(PathBuf::from(format!(
            "/home/u/.zcode/artifacts/{}/{}.txt",
            artifact.session, artifact.id
        )))
    }
}

struct Fixture {
    store: Arc<MemoryStore>,
    port: Arc<Port>,
    files: Arc<Files>,
}

impl Fixture {
    async fn new(messages: Vec<Message>, port: Port) -> Self {
        let store = Arc::new(MemoryStore::default());
        let session = SessionId::new(SESSION);
        store
            .create(SessionMeta {
                id: session.clone(),
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
            })
            .await
            .unwrap();
        store
            .commit(
                &session,
                FactBatch {
                    owner_epoch: OwnerEpoch::LOCAL,
                    command: None,
                    facts: messages
                        .into_iter()
                        .map(|message| Fact::MessageAppended { message })
                        .collect(),
                    turn: None,
                },
            )
            .await
            .unwrap();
        Self {
            store,
            port: Arc::new(port),
            files: Arc::new(Files::default()),
        }
    }

    fn tool(&self) -> ReadTopicResourceTool {
        ReadTopicResourceTool::new(self.store.clone(), self.port.clone())
    }

    fn context(&self) -> ToolUseContext {
        ToolUseContext {
            artifacts: self.files.clone(),
            ..rust_cli_kernel_api::testing::tool_use_context()
        }
    }

    /// The Host's upload: `data:<mime>;base64,<payload>` committed as `upload-1`, and the reply naming it.
    fn upload(&self, mime: &str, payload: &str, bytes: u64) {
        self.files.add(
            SESSION,
            "upload-1",
            mime,
            format!("data:{mime};base64,{payload}").as_bytes(),
        );
        *self.port.reply.lock_unpoisoned() = Some(Ok(TopicResource {
            reference: format!("zcode-artifact://{SESSION}/upload-1"),
            file_name: "archive.txt".to_owned(),
            mime: "text/plain".to_owned(),
            bytes,
        }));
    }

    async fn call(&self, input: Value) -> Result<ToolOutput, ToolError> {
        let (sender, _receiver) = mpsc::channel(4);
        self.tool().call(input, self.context(), sender).await
    }
}

fn error_text(result: Result<ToolOutput, ToolError>) -> String {
    match result {
        Err(ToolError::Failed { message }) => message,
        other => panic!("expected a failure, got {other:?}"),
    }
}

/// Acceptance case 3: the definition is Node's, the tool is deferred, concurrency-safe, not read-only, and needs no
/// approval.
#[tokio::test]
async fn the_tool_metadata_matches_node() {
    let fixture = Fixture::new(Vec::new(), Port::default()).await;
    let tool = fixture.tool();
    let prompt = PromptContext {
        tool_names: Vec::new(),
        mode: PermissionMode::Default,
    };
    assert_eq!(tool.name(), "ReadTopicResource");
    assert!(
        tool.description(&prompt)
            .starts_with("Download a file or image listed in the current task's topic history")
    );
    assert!(tool.description(&prompt).contains("\n\nUsage:\n- "));
    let schema = tool.input_schema();
    assert_eq!(schema["required"], json!(["messageId"]));
    assert_eq!(schema["additionalProperties"], json!(false));
    assert!(tool.should_defer());
    assert!(!tool.is_read_only(&json!({})));
    assert!(tool.is_concurrency_safe(&json!({})));
    assert_eq!(tool.max_result_size_chars(), Some(4096));
    assert_eq!(
        tool.check_permissions(&json!({}), &fixture.context()).await,
        PermissionDecision::Allow {
            updated_input: None
        }
    );
}

/// Acceptance case 4: the newest human intent with a valid source wins; newer inputs without a source, tool results
/// and kernel messages do not hide it; a malformed source stops the search; `inputId` selects one snapshot.
#[test]
fn authorization_follows_node_s_search() {
    let older = human("m1", intent("c1", Some(source("a1"))));
    let newer = human("m2", intent("c2", Some(source("a2"))));
    let plain = human("m3", intent("c3", None));
    let meta = user(
        "m4",
        UserOrigin::Meta {
            source: "reminder".to_owned(),
        },
        Some(intent("c4", Some(source("a4")))),
    );
    let no_intent = user("m5", UserOrigin::Human, None);
    let found = |messages: &[&Message], input: Option<&str>| {
        authorize(messages, input).map(|identity| (identity.input, identity.authorization))
    };
    let all = [&older, &newer, &plain, &meta, &no_intent];
    assert_eq!(found(&all, None), Some(("c2".to_owned(), "a2".to_owned())));
    assert_eq!(
        found(&all, Some("c1")),
        Some(("c1".to_owned(), "a1".to_owned()))
    );
    assert_eq!(found(&all, Some("c9")), None);
    let broken = human(
        "m6",
        intent("c6", Some(json!({"botId": "b1", "chatId": "oc_1"}))),
    );
    assert_eq!(found(&[&older, &broken], None), None);
    let bad_history = human(
        "m7",
        intent(
            "c7",
            Some(json!({
                "botId": "b", "chatId": "c", "threadId": "t", "authorizationId": "a7",
                "topicHistory": {"resourceMessages": [{"messageId": "om_1", "count": 0}]},
            })),
        ),
    );
    assert_eq!(found(&[&older, &bad_history], None), None);
    assert_eq!(found(&[&plain, &no_intent], None), None);
}

#[tokio::test]
async fn without_an_admitted_input_the_read_fails_with_node_s_text() {
    let fixture = Fixture::new(vec![human("m1", intent("c1", None))], Port::default()).await;
    let error = error_text(fixture.call(json!({"messageId": "om_1"})).await);
    assert_eq!(error, NO_AUTHORIZATION);
    assert!(fixture.port.requests.lock_unpoisoned().is_empty());
}

/// Acceptance case 5: with `inputId`, `topicHistory` bounds the index; without it the `topicContext` attachment must
/// exist. An unindexed resource fails before any request.
#[tokio::test]
async fn an_explicit_input_must_index_the_resource() {
    let mut history = source("a1");
    history["topicHistory"] = json!({"resourceMessages": [{"messageId": "om_1", "count": 2}]});
    let mut context = source("a2");
    context["topicContext"] =
        json!({"messages": [{"id": "om_2", "attachments": [{"key": "f1"}, null]}]});
    let messages = vec![
        human("m1", intent("c1", Some(history))),
        human("m2", intent("c2", Some(context))),
    ];
    let fixture = Fixture::new(messages, Port::default()).await;
    for input in [
        json!({"inputId": "c1", "messageId": "om_1", "index": 2}),
        json!({"inputId": "c1", "messageId": "om_9"}),
        json!({"inputId": "c2", "messageId": "om_2", "index": 1}),
        json!({"inputId": "c2", "messageId": "om_9"}),
    ] {
        assert_eq!(error_text(fixture.call(input).await), NOT_INDEXED);
    }
    assert!(fixture.port.requests.lock_unpoisoned().is_empty());
    for (input, message, index) in [
        (
            json!({"inputId": "c1", "messageId": "om_1", "index": 1}),
            "om_1",
            1,
        ),
        (json!({"inputId": "c2", "messageId": "om_2"}), "om_2", 0),
    ] {
        fixture.call(input).await.unwrap_err();
        let last = fixture
            .port
            .requests
            .lock_unpoisoned()
            .last()
            .cloned()
            .unwrap();
        assert_eq!((last.message.as_str(), last.index), (message, index));
    }
}

/// Acceptance case 6: a good reply is checked and written as a tool output artifact; the result is Node's JSON.
#[tokio::test]
async fn a_good_reply_is_materialized_as_a_tool_output() {
    let fixture = Fixture::new(
        vec![human("m1", intent("c1", Some(source("a1"))))],
        Port::default(),
    )
    .await;
    fixture.upload("text/plain", &base64::encode(CONTENT), CONTENT.len() as u64);
    let output = fixture
        .call(json!({"messageId": "om_archive", "index": 0}))
        .await
        .unwrap();
    assert_eq!(
        fixture.port.requests.lock_unpoisoned().clone(),
        vec![TopicResourceRequest {
            task: SESSION.to_owned(),
            input: "c1".to_owned(),
            authorization: "a1".to_owned(),
            message: "om_archive".to_owned(),
            index: 0,
        }]
    );
    let text = output_text(&output);
    let path = format!("/home/u/.zcode/artifacts/{SESSION}/tool-output-2.txt");
    assert_eq!(
        text,
        json!({
            "status": "success",
            "path": path,
            "fileName": "archive.txt",
            "mime": "text/plain",
            "bytes": CONTENT.len(),
            "messageId": "om_archive",
            "index": 0,
        })
        .to_string()
    );
    let (artifact, bytes) = fixture.files.bytes("tool-output-2").unwrap();
    assert_eq!(artifact.purpose, ArtifactPurpose::ToolOutput);
    assert_eq!(artifact.media_type, "text/plain");
    assert_eq!(bytes, CONTENT);
}

/// Acceptance case 7: each bad reply fails and writes nothing.
#[tokio::test]
async fn bad_replies_fail() {
    let good = base64::encode(CONTENT);
    let size = CONTENT.len() as u64;
    let cases: Vec<(&str, String, u64, &str)> = vec![
        ("text/plain", good.clone(), MAX_BYTES + 1, BAD_SIZE),
        ("image/png", good.clone(), size, BAD_ARTIFACT),
        ("text/plain", good.clone(), size + 1, MISMATCH),
        (
            "text/plain",
            format!("{}=", &good[..good.len() - 1]),
            size,
            MISMATCH,
        ),
        ("text/plain", "Zh==".to_owned(), 1, MISMATCH),
        ("text/plain", "a-b".to_owned(), 2, BAD_ARTIFACT),
    ];
    for (mime, payload, bytes, expected) in cases {
        let fixture = Fixture::new(
            vec![human("m1", intent("c1", Some(source("a1"))))],
            Port::default(),
        )
        .await;
        fixture.upload(mime, &payload, bytes);
        let error = error_text(fixture.call(json!({"messageId": "om_1"})).await);
        assert_eq!(error, expected, "{mime} {payload} {bytes}");
        assert!(fixture.files.bytes("tool-output-2").is_none());
    }
    // A ref of another session, or one that names no artifact.
    for reference in [
        "zcode-artifact://sess_other/upload-1",
        "zcode-artifact://sess_1/missing",
        "https://example.com/a.txt",
    ] {
        let fixture = Fixture::new(
            vec![human("m1", intent("c1", Some(source("a1"))))],
            Port::default(),
        )
        .await;
        fixture.upload("text/plain", &good, size);
        if let Some(Ok(reply)) = fixture.port.reply.lock_unpoisoned().as_mut() {
            reply.reference = reference.to_owned();
        }
        let error = error_text(fixture.call(json!({"messageId": "om_1"})).await);
        assert_eq!(error, format!("Artifact not found: {reference}"));
    }
    // The port's own error reaches the model as is.
    let fixture = Fixture::new(
        vec![human("m1", intent("c1", Some(source("a1"))))],
        Port::default(),
    )
    .await;
    *fixture.port.reply.lock_unpoisoned() = Some(Err("Topic resource is unavailable".to_owned()));
    assert_eq!(
        error_text(fixture.call(json!({"messageId": "om_1"})).await),
        "Topic resource is unavailable"
    );
}

#[tokio::test]
async fn input_outside_the_contract_is_rejected() {
    let fixture = Fixture::new(
        vec![human("m1", intent("c1", Some(source("a1"))))],
        Port::default(),
    )
    .await;
    for input in [
        json!({}),
        json!({"messageId": ""}),
        json!({"messageId": "x".repeat(257)}),
        json!({"messageId": "om", "inputId": ""}),
        json!({"messageId": "om", "index": -1}),
        json!({"messageId": "om", "extra": true}),
    ] {
        assert!(error_text(fixture.call(input).await).starts_with("Invalid input"));
    }
    assert!(fixture.port.requests.lock_unpoisoned().is_empty());
}

/// Acceptance case 8: cancelling the call while the read is pending ends it as cancelled and drops the port's read
/// (the Host port sends `topic/resource/cancel` from that drop).
#[tokio::test]
async fn cancelling_a_pending_read_drops_it() {
    let fixture = Fixture::new(
        vec![human("m1", intent("c1", Some(source("a1"))))],
        Port {
            hold: true,
            ..Port::default()
        },
    )
    .await;
    let cancel = CancellationToken::new();
    let context = ToolUseContext {
        cancel: cancel.clone(),
        ..fixture.context()
    };
    let tool = fixture.tool();
    let dropped = fixture.port.dropped.clone();
    let (sender, _receiver) = mpsc::channel(4);
    let call = tool.call(json!({"messageId": "om_1"}), context, sender);
    let canceller = async {
        while fixture.port.requests.lock_unpoisoned().is_empty() {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(call, canceller);
    assert!(matches!(result, Err(ToolError::Cancelled)));
    tokio::time::timeout(Duration::from_secs(1), dropped.notified())
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_read_past_the_tool_timeout_fails() {
    let fixture = Fixture::new(
        vec![human("m1", intent("c1", Some(source("a1"))))],
        Port {
            hold: true,
            ..Port::default()
        },
    )
    .await;
    let error = error_text(fixture.call(json!({"messageId": "om_1"})).await);
    assert_eq!(error, "ReadTopicResource timed out after 300 seconds");
}
