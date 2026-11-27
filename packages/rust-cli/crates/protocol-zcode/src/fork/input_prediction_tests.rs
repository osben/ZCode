//! Input prediction (specs/fork-rust-input-prediction.md): the cases of Node's `input-prediction-sidecar.test.ts` and
//! `input-prediction-handler.test.ts`, the turn pairing, and the model request a prediction sends.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::message::{
    AssistantMessage, AttachmentMessage, ContentBlock, Message, ToolResultContent, UserMessage,
    UserOrigin,
};
use rust_cli_kernel_api::model::{ApiRole, ModelSelection, QuerySource};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::provider::{
    CatalogModel, ModelCapabilities, ModelCatalog, ModelDirectory, WireProtocol,
};
use rust_cli_kernel_api::session_api::{CreateSession, Kernel, KernelError, SessionHandle};
use rust_cli_kernel_api::side_request::SideSource;
use rust_cli_kernel_api::store::{SessionFilter, SessionSummary, StoreQueries};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore};
use rust_cli_kernel_api::testing::{ScriptedModel, selection, text_response};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::context::Context;
use crate::server::{Defaults, Server};

/// A kernel that opens nothing: the sessions of these tests are never resident.
struct NoKernel {
    store: Arc<MemoryStore>,
}

#[async_trait]
impl Kernel for NoKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.store.clone()
    }

    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "open".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, _session: &SessionId) -> Result<(), KernelError> {
        Ok(())
    }
}

struct Directory(Vec<CatalogModel>);

#[async_trait]
impl ModelDirectory for Directory {
    async fn catalog(&self) -> ModelCatalog {
        ModelCatalog {
            revision: 1,
            models: self.0.clone(),
            default: None,
        }
    }
}

fn entry(model: &str, levels: &[&str], max_output: u64) -> CatalogModel {
    CatalogModel {
        provider: "p".to_owned(),
        provider_name: "p".to_owned(),
        model: model.to_owned(),
        protocol: WireProtocol::OpenAiChatCompletions,
        reasoning_levels: levels.iter().map(|level| (*level).to_owned()).collect(),
        default_reasoning_level: None,
        context_window: 200_000,
        max_output_tokens: max_output,
        capabilities: ModelCapabilities::default(),
        connection: None,
        host: None,
    }
}

fn server(model: Arc<ScriptedModel>) -> (TaskScope, Arc<Server>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    context.set_models(Arc::new(Directory(vec![entry(
        "big",
        &["low", "medium", "high"],
        128_000,
    )])));
    context.set_model_port(model);
    let kernel = Arc::new(NoKernel {
        store: Arc::new(MemoryStore::default()),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server)
}

fn turn(user: &str, assistant: Option<&str>) -> Turn {
    Turn {
        user_text: user.to_owned(),
        assistant_text: assistant.map(str::to_owned),
    }
}

fn turns() -> Vec<Turn> {
    vec![
        turn("帮我看下 lint 报错", Some("已修复 3 处")),
        turn("再跑一遍单测", Some("全部通过")),
    ]
}

fn candidate(text: &str, confidence: f64) -> Candidate {
    Candidate {
        text: text.to_owned(),
        confidence,
    }
}

fn texts(candidates: &[Candidate]) -> Vec<(&str, f64)> {
    candidates
        .iter()
        .map(|candidate| (candidate.text.as_str(), candidate.confidence))
        .collect()
}

// ---- parse_response

#[test]
fn parses_plain_json() {
    let parsed = parse_response(r#"{"candidates":[{"text":"提交吧","confidence":0.9}]}"#).unwrap();
    assert_eq!(texts(&parsed), [("提交吧", 0.9)]);
}

#[test]
fn tolerates_think_blocks_fences_trailing_commas_and_surrounding_prose() {
    let raw = "<think>想一想</think>\n```json\n{\"candidates\":[{\"text\":\"提交吧\",\"confidence\":0.9},]}\n```";
    assert_eq!(texts(&parse_response(raw).unwrap()), [("提交吧", 0.9)]);
    let raw = r#"结果如下：{"candidates":[{"text":"好","confidence":0.5}]} 完"#;
    assert_eq!(texts(&parse_response(raw).unwrap()), [("好", 0.5)]);
    // The think tag is matched without regard to case.
    let raw = r#"<THINK>x</THINK>{"candidates":[{"text":"好","confidence":0.5}]}"#;
    assert_eq!(texts(&parse_response(raw).unwrap()), [("好", 0.5)]);
}

#[test]
fn a_wrong_shape_or_no_valid_entry_is_none() {
    assert!(parse_response("不是 JSON").is_none());
    assert!(parse_response(r#"{"candidates":[]}"#).is_none());
    assert!(parse_response(r#"{"candidates":[{"text":1,"confidence":0.9}]}"#).is_none());
    assert!(parse_response("[]").is_none());
    // An entry with empty text is dropped, and nothing is left.
    assert!(parse_response(r#"{"candidates":[{"text":"","confidence":0.9}]}"#).is_none());
}

// ---- to_suffix

#[test]
fn without_a_draft_the_text_is_one_trimmed_line() {
    assert_eq!(to_suffix("  提交\n代码  ", ""), "提交 代码");
}

#[test]
fn a_repeated_draft_prefix_goes_and_a_leading_space_stays() {
    assert_eq!(to_suffix("run the tests", "run the"), " tests");
    assert_eq!(to_suffix(" tests  ", "run the"), " tests");
}

#[test]
fn a_draft_ending_in_space_leaves_no_leading_space() {
    assert_eq!(to_suffix("run the tests", "run the "), "tests");
    assert_eq!(to_suffix("  tests", "run the "), "tests");
}

#[test]
fn the_text_is_cut_to_40_utf16_units_without_splitting_a_pair() {
    let long = "好".repeat(50);
    assert_eq!(to_suffix(&long, "").encode_utf16().count(), 40);
    let emoji = "😀".repeat(30);
    assert_eq!(to_suffix(&emoji, ""), "😀".repeat(20));
}

// ---- decide

fn decide_with(raw: &[Candidate], draft: &str, recent: &[&str], turn_count: usize) -> Outcome {
    let recent: Vec<String> = recent.iter().map(|text| (*text).to_owned()).collect();
    decide(raw, draft, &recent, turn_count)
}

#[test]
fn too_few_turns_is_no_context() {
    let outcome = decide_with(&[candidate("好", 1.0)], "", &["a"], 1);
    assert_eq!(outcome.decision, Decision::SuppressNoContext);
    assert!(outcome.candidates.is_empty());
    assert_eq!(outcome.top_confidence, 0.0);
    // A draft needs one turn, no draft needs two.
    assert_eq!(min_turns("草稿"), 1);
    assert_eq!(min_turns(""), 2);
}

#[test]
fn recent_inputs_and_repeats_go_and_the_top_three_show() {
    let raw = [
        candidate("再跑一遍 单测", 0.99),
        candidate("提交代码", 0.7),
        candidate("提交 代码", 0.85),
        candidate("推送", 0.6),
        candidate("看下覆盖率", 0.5),
        candidate("合并", 0.4),
        candidate("   ", 0.95),
    ];
    let outcome = decide_with(&raw, "", &["帮我看下 lint 报错", "再跑一遍单测"], 2);
    assert_eq!(outcome.decision, Decision::Show);
    assert_eq!(
        texts(&outcome.candidates),
        [("提交 代码", 0.85), ("推送", 0.6), ("看下覆盖率", 0.5)]
    );
    assert_eq!(outcome.top_confidence, 0.85);
}

#[test]
fn below_the_threshold_is_suppressed_and_confidence_is_clamped() {
    let outcome = decide_with(&[candidate("提交", 0.79)], "", &[], 3);
    assert_eq!(outcome.decision, Decision::SuppressBelowThreshold);
    let outcome = decide_with(&[candidate("提交", 3.0)], "", &[], 3);
    assert_eq!(outcome.decision, Decision::Show);
    assert_eq!(outcome.top_confidence, 1.0);
}

#[test]
fn a_draft_is_compared_with_the_recent_inputs_as_draft_plus_text() {
    let outcome = decide_with(&[candidate("单测", 0.9)], "再跑一遍", &["再跑一遍单测"], 1);
    assert!(outcome.candidates.is_empty());
}

#[test]
fn only_the_last_two_inputs_count_for_the_repeat_check() {
    let outcome = decide_with(&[candidate("a", 0.9)], "", &["a", "b", "c"], 3);
    assert_eq!(texts(&outcome.candidates), [("a", 0.9)]);
}

// ---- context and prompts

#[test]
fn the_context_keeps_6_turns_cuts_replies_and_drops_the_oldest_text_over_budget() {
    let many: Vec<Turn> = (0..8)
        .map(|index| Turn {
            user_text: format!("问题{index}"),
            assistant_text: (index == 7).then(|| "长".repeat(900)),
        })
        .collect();
    let context = build_context(&many);
    assert!(!context.contains("问题1"));
    assert!(context.contains("问题2"));
    assert!(context.contains("（无回复）"));
    assert!(context.contains(&format!("{}…", "长".repeat(800))));
    assert_eq!(
        build_context_with(&many, 6, 800, 20).encode_utf16().count(),
        20
    );
}

#[test]
fn a_draft_switches_the_prompt_and_is_appended() {
    assert_eq!(normalize_draft("   "), "");
    assert_eq!(normalize_draft(" 帮我"), " 帮我");
    let (system, user) = build_messages(&turns(), "帮我");
    assert!(system.contains("输入补全器"));
    assert!(user.contains("【用户正在输入的草稿】\n帮我"));
    let (system, user) = build_messages(&turns(), "");
    assert!(system.contains("输入预测器"));
    assert!(!user.contains("草稿"));
    assert!(system.contains("不超过 40 个字"));
}

// ---- turn pairing

fn id(text: &str) -> MessageId {
    MessageId::new(text)
}

fn user(text: &str, origin: UserOrigin) -> Message {
    Message::User(UserMessage {
        id: id(&format!("u-{text}")),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin,
        intent: None,
        stall_execution: None,
        workflow_meta: None,
        epilogue_start: None,
    })
}

fn human(text: &str) -> Message {
    user(text, UserOrigin::Human)
}

fn assistant(text: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: id(&format!("a-{text}")),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

#[test]
fn a_turn_is_a_real_input_with_the_last_reply_before_the_next_one() {
    let messages = vec![
        human("one"),
        assistant("first reply"),
        // A tool result is a user row that is not a real input and does not end the turn.
        Message::User(UserMessage {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: rust_cli_kernel_api::ids::ToolUseId::new("t"),
                content: vec![ToolResultContent::Text {
                    text: "ok".to_owned(),
                }],
                is_error: false,
            }],
            ..match user("x", UserOrigin::Human) {
                Message::User(message) => message,
                _ => unreachable!(),
            }
        }),
        assistant("final reply"),
        assistant("   "),
        human("two"),
    ];
    let turns = collect_turns(&messages);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].user_text, "one");
    assert_eq!(turns[0].assistant_text.as_deref(), Some("final reply"));
    assert_eq!(turns[1].user_text, "two");
    assert_eq!(turns[1].assistant_text, None);
}

#[test]
fn hidden_rows_between_a_prompt_and_its_reply_do_not_end_the_turn() {
    let messages = vec![
        human("go"),
        user(
            "hook note",
            UserOrigin::Meta {
                source: "hook".to_owned(),
            },
        ),
        Message::Attachment(AttachmentMessage {
            id: id("att"),
            source: "x".to_owned(),
            text: "reminder".to_owned(),
            data: Value::Null,
        }),
        assistant("answer"),
        user("summary", UserOrigin::CompactSummary),
        human("   "),
    ];
    let turns = collect_turns(&messages);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].assistant_text.as_deref(), Some("answer"));
}

// ---- handler

/// A session's scripted turns and whether it has a model, or the error its read fails with.
type Scripted = Result<Option<(Vec<Turn>, bool)>, String>;

/// A scripted session source and model: `reply` answers a call; `gate` holds it until the call is cancelled.
struct Fake {
    materials: Mutex<HashMap<String, Scripted>>,
    calls: AtomicUsize,
    replies: Mutex<Vec<Reply>>,
    seen: Mutex<Vec<(String, String, String)>>,
}

enum Reply {
    Text(&'static str),
    Fail,
    /// Waits until the token is cancelled, then fails like a model port that honors it.
    UntilCancelled,
    /// Never returns, like a model port that ignores its token.
    Forever,
}

impl Fake {
    fn new(replies: Vec<Reply>) -> Self {
        let fake = Self {
            materials: Mutex::new(HashMap::new()),
            calls: AtomicUsize::new(0),
            replies: Mutex::new(replies),
            seen: Mutex::new(Vec::new()),
        };
        fake.session("s1", turns());
        fake
    }

    fn session(&self, name: &str, turns: Vec<Turn>) {
        self.materials
            .lock()
            .unwrap()
            .insert(name.to_owned(), Ok(Some((turns, true))));
    }
}

#[async_trait]
impl Backend for Fake {
    async fn material(&self, session: &SessionId) -> Result<Option<Material>, String> {
        let found = self
            .materials
            .lock()
            .unwrap()
            .get(session.as_str())
            .cloned();
        match found {
            None | Some(Ok(None)) => Ok(None),
            Some(Err(error)) => Err(error),
            Some(Ok(Some((turns, has_model)))) => Ok(Some(Material {
                turns,
                model: has_model.then(selection),
            })),
        }
    }

    async fn complete(
        &self,
        session: &SessionId,
        _model: &ModelSelection,
        system: &str,
        user: &str,
        cancel: CancellationToken,
    ) -> Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push((
            session.as_str().to_owned(),
            system.to_owned(),
            user.to_owned(),
        ));
        let reply = {
            let mut replies = self.replies.lock().unwrap();
            if replies.is_empty() {
                Reply::Fail
            } else {
                replies.remove(0)
            }
        };
        match reply {
            Reply::Text(text) => Ok(text.to_owned()),
            Reply::Fail => Err("model down".to_owned()),
            Reply::UntilCancelled => {
                cancel.cancelled().await;
                Err("aborted".to_owned())
            }
            Reply::Forever => std::future::pending().await,
        }
    }
}

const SHOW: &str = r#"{"candidates":[{"text":"提交吧","confidence":0.9}]}"#;

fn params(session: &str, revision: u64, draft: Option<&str>, request: Option<&str>) -> Value {
    let mut value = json!({"sessionId": session, "revision": revision});
    if let Some(draft) = draft {
        value["draft"] = json!(draft);
    }
    if let Some(request) = request {
        value["requestId"] = json!(request);
    }
    value
}

#[tokio::test]
async fn shows_echoes_the_request_id_and_caches_by_session_revision_and_draft() {
    let fake = Fake::new(vec![Reply::Text(SHOW)]);
    let handler = Handler::default();
    let first = handler
        .handle(&fake, &params("s1", 4, None, Some("r1")))
        .await
        .unwrap();
    assert_eq!(first["decision"], "show");
    assert_eq!(
        first["candidates"],
        json!([{"text": "提交吧", "confidence": 0.9}])
    );
    assert_eq!(first["topConfidence"], 0.9);
    assert_eq!(first["requestId"], "r1");
    // The same key hits the cache: no second model call, the new request id.
    let second = handler
        .handle(&fake, &params("s1", 4, Some("   "), Some("r2")))
        .await
        .unwrap();
    assert_eq!(second["decision"], "show");
    assert_eq!(second["requestId"], "r2");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    // No request id: none in the result.
    let third = handler
        .handle(&fake, &params("s1", 4, None, None))
        .await
        .unwrap();
    assert!(third.get("requestId").is_none());
    // A new revision asks again.
    fake.replies.lock().unwrap().push(Reply::Text(SHOW));
    handler
        .handle(&fake, &params("s1", 5, None, None))
        .await
        .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen[0].0, "s1");
    assert!(seen[0].1.contains("输入预测器"));
}

#[tokio::test]
async fn the_cache_keeps_16_entries() {
    let fake = Fake::new(Vec::new());
    let handler = Handler::default();
    for revision in 0..17 {
        fake.replies.lock().unwrap().push(Reply::Text(SHOW));
        handler
            .handle(&fake, &params("s1", revision, None, None))
            .await
            .unwrap();
    }
    assert_eq!(fake.calls.load(Ordering::SeqCst), 17);
    // Revision 0 was pushed out, revision 16 is still there.
    handler
        .handle(&fake, &params("s1", 16, None, None))
        .await
        .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 17);
    fake.replies.lock().unwrap().push(Reply::Text(SHOW));
    handler
        .handle(&fake, &params("s1", 0, None, None))
        .await
        .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 18);
}

#[tokio::test]
async fn a_newer_request_for_the_session_cancels_the_older_one() {
    // The model port honors its token.
    let fake = Fake::new(vec![Reply::UntilCancelled, Reply::Text(SHOW)]);
    let handler = Handler::default();
    let (older, newer) = (
        params("s1", 1, None, Some("old")),
        params("s1", 2, None, Some("new")),
    );
    let (old, new) = tokio::join!(handler.handle(&fake, &older), async {
        // The older call is in flight before the newer one arrives.
        while fake.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        handler.handle(&fake, &newer).await
    });
    let old = old.unwrap();
    assert_eq!(old["decision"], "cancelled");
    assert_eq!(old["requestId"], "old");
    assert_eq!(old["candidates"], json!([]));
    assert_eq!(old["topConfidence"].as_f64(), Some(0.0));
    assert_eq!(new.unwrap()["decision"], "show");
}

#[tokio::test]
async fn a_model_that_ignores_cancellation_is_still_given_up_on() {
    let fake = Fake::new(vec![Reply::Forever, Reply::Text(SHOW)]);
    let handler = Handler::default();
    let (older, newer) = (
        params("s1", 1, None, Some("old")),
        params("s1", 2, None, Some("new")),
    );
    let (old, new) = tokio::join!(handler.handle(&fake, &older), async {
        while fake.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        handler.handle(&fake, &newer).await
    });
    assert_eq!(old.unwrap()["decision"], "cancelled");
    assert_eq!(new.unwrap()["decision"], "show");
}

#[tokio::test]
async fn other_sessions_do_not_cancel_each_other() {
    let fake = Fake::new(vec![Reply::Text(SHOW), Reply::Text(SHOW)]);
    fake.session("s2", turns());
    let handler = Handler::default();
    let (first, second) = (params("s1", 1, None, None), params("s2", 1, None, None));
    let (one, two) = tokio::join!(
        handler.handle(&fake, &first),
        handler.handle(&fake, &second)
    );
    assert_eq!(one.unwrap()["decision"], "show");
    assert_eq!(two.unwrap()["decision"], "show");
}

#[tokio::test]
async fn a_missing_session_or_too_few_turns_is_no_context_without_a_model_call() {
    let fake = Fake::new(Vec::new());
    fake.session("short", vec![turn("only one", None)]);
    let handler = Handler::default();
    let missing = handler
        .handle(&fake, &params("nope", 1, None, Some("r")))
        .await
        .unwrap();
    assert_eq!(missing["decision"], "suppress_no_context");
    assert_eq!(missing["requestId"], "r");
    let short = handler
        .handle(&fake, &params("short", 1, None, None))
        .await
        .unwrap();
    assert_eq!(short["decision"], "suppress_no_context");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    // One turn is enough when there is a draft.
    fake.replies.lock().unwrap().push(Reply::Text(SHOW));
    let with_draft = handler
        .handle(&fake, &params("short", 1, Some("帮我"), None))
        .await
        .unwrap();
    assert_eq!(with_draft["decision"], "show");
    assert!(fake.seen.lock().unwrap()[0].1.contains("输入补全器"));
}

#[tokio::test]
async fn no_model_a_failed_model_or_transcript_is_unavailable_and_not_cached() {
    let fake = Fake::new(vec![Reply::Fail, Reply::Text(SHOW)]);
    fake.materials
        .lock()
        .unwrap()
        .insert("nomodel".to_owned(), Ok(Some((turns(), false))));
    fake.materials
        .lock()
        .unwrap()
        .insert("broken".to_owned(), Err("read failed".to_owned()));
    let handler = Handler::default();
    for session in ["nomodel", "broken"] {
        let result = handler
            .handle(&fake, &params(session, 1, None, None))
            .await
            .unwrap();
        assert_eq!(result["decision"], "unavailable", "{session}");
    }
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    let failed = handler
        .handle(&fake, &params("s1", 1, None, None))
        .await
        .unwrap();
    assert_eq!(failed["decision"], "unavailable");
    // Not cached: the same key asks again and now shows.
    let again = handler
        .handle(&fake, &params("s1", 1, None, None))
        .await
        .unwrap();
    assert_eq!(again["decision"], "show");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn a_model_that_runs_past_20_seconds_is_unavailable() {
    let fake = Fake::new(vec![Reply::Forever]);
    let handler = Handler::default();
    let started = tokio::time::Instant::now();
    let result = handler
        .handle(&fake, &params("s1", 1, None, None))
        .await
        .unwrap();
    assert_eq!(result["decision"], "unavailable");
    assert_eq!(started.elapsed(), Duration::from_secs(20));
}

#[tokio::test]
async fn an_unparseable_reply_is_below_the_threshold() {
    let fake = Fake::new(vec![Reply::Text("sorry, no")]);
    let handler = Handler::default();
    let result = handler
        .handle(&fake, &params("s1", 1, None, None))
        .await
        .unwrap();
    assert_eq!(result["decision"], "suppress_below_threshold");
    assert_eq!(result["candidates"], json!([]));
}

#[tokio::test]
async fn params_are_strict() {
    let fake = Fake::new(Vec::new());
    let handler = Handler::default();
    let bad = [
        json!({"revision": 1}),
        json!({"sessionId": "", "revision": 1}),
        json!({"sessionId": "s1"}),
        json!({"sessionId": "s1", "revision": -1}),
        json!({"sessionId": "s1", "revision": 1.5}),
        json!({"sessionId": "s1", "revision": 1, "extra": true}),
        json!({"sessionId": "s1", "revision": 1, "draft": "x".repeat(4_001)}),
        json!({"sessionId": "s1", "revision": 1, "requestId": ""}),
        json!({"sessionId": "s1", "revision": 1, "requestId": "r".repeat(129)}),
        json!("s1"),
    ];
    for value in bad {
        let error = handler.handle(&fake, &value).await.unwrap_err();
        assert_eq!(
            error.code,
            rust_cli_protocol_core::rpc::codes::INVALID_PARAMS,
            "{value}"
        );
    }
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
}

// ---- the model request

#[tokio::test]
async fn the_request_uses_the_session_model_the_lowest_tier_and_the_prediction_source() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&[SHOW])]));
    let (_scope, server) = server(model.clone());
    let main = ModelSelection {
        provider: "p".to_owned(),
        model: "big".to_owned(),
        reasoning: Some("high".to_owned()),
        connection: None,
    };
    let text = server
        .complete(
            &SessionId::new("sess_live"),
            &main,
            "SYSTEM",
            "CONTEXT",
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(text, SHOW);
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(
        request.source,
        QuerySource::Side(SideSource::InputPrediction)
    );
    assert_eq!(request.selection.model, "big");
    assert_eq!(request.selection.reasoning.as_deref(), Some("low"));
    assert_eq!(request.max_tokens, 5_000);
    assert_eq!(request.options.provider_max_output_tokens, Some(5_000));
    assert_eq!(
        request.options.session_id,
        Some(SessionId::new("sess_live"))
    );
    assert_eq!(request.system.len(), 1);
    assert_eq!(request.system[0].text, "SYSTEM");
    assert_eq!(request.messages.len(), 1);
    assert_eq!(request.messages[0].role, ApiRole::User);
    assert!(request.tools.is_empty());
}

#[tokio::test]
async fn a_model_missing_from_the_catalog_or_a_port_error_is_an_error_string() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let (_scope, server) = server(model);
    let unknown = ModelSelection {
        provider: "p".to_owned(),
        model: "gone".to_owned(),
        reasoning: None,
        connection: None,
    };
    let result = server
        .complete(
            &SessionId::new("s"),
            &unknown,
            "S",
            "U",
            CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn through_the_server_a_session_that_is_not_resident_is_no_context() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let (_scope, server) = server(model.clone());
    let result = handle(&server, &params("sess_cold", 1, None, Some("r")))
        .await
        .unwrap();
    assert_eq!(result["decision"], "suppress_no_context");
    assert_eq!(result["requestId"], "r");
    assert!(model.requests().is_empty());
}
