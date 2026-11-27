use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::off_peak::{OffPeakError, OffPeakPort};
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionMode};
use rust_cli_kernel_api::session_ops::RunView;
use rust_cli_kernel_api::testing::{NoOneToAsk, OpsOverride};
use rust_cli_kernel_api::tool::{PromptContext, Tool, ToolError, ToolUseContext, Validation};
use rust_cli_kernel_api::turn_limits::TurnLimits;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

type Answer = Result<Value, OffPeakError>;

/// The Host: records each request and answers the next scripted reply.
#[derive(Default)]
struct Host {
    requests: Mutex<Vec<(String, String, Value)>>,
    answers: Mutex<VecDeque<Answer>>,
}

impl Host {
    fn answering(answers: Vec<Answer>) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::default(),
            answers: Mutex::new(answers.into()),
        })
    }

    fn requests(&self) -> Vec<(String, String, Value)> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn methods(&self) -> Vec<String> {
        self.requests()
            .into_iter()
            .map(|(_, method, _)| method)
            .collect()
    }
}

#[async_trait]
impl OffPeakPort for Host {
    async fn request(&self, session: &SessionId, method: &str, params: Value) -> Answer {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((session.as_str().to_owned(), method.to_owned(), params));
        self.answers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
            .unwrap_or_else(|| Err(OffPeakError::new("no scripted answer")))
    }
}

/// The session: its turn limits. Its owner is the session itself.
#[derive(Default)]
struct Session {
    limits: TurnLimits,
}

#[async_trait]
impl OpsOverride for Session {
    async fn view(&self) -> Option<RunView> {
        let mut view = RunView::new(
            PermissionMode::Default,
            WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/work"),
            },
        );
        view.selection = Some(ModelSelection {
            provider: "zai".to_owned(),
            model: "glm-5".to_owned(),
            reasoning: Some("high".to_owned()),
            connection: None,
        });
        view.turn = self.limits.clone();
        Some(view)
    }
}

fn context(limits: TurnLimits) -> ToolUseContext {
    let session = Arc::new(Session { limits });
    let mut ctx = Ctx::new(Arc::new(NoOneToAsk));
    ctx.session_ops = session;
    ctx.mode = PermissionMode::Default;
    ctx.build()
}

fn tool(host: &Arc<Host>, name: &str) -> Arc<dyn Tool> {
    let port: Arc<dyn OffPeakPort> = host.clone();
    off_peak_tools(port)
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("{name}"))
}

async fn call(
    tool: &Arc<dyn Tool>,
    input: Value,
    context: ToolUseContext,
) -> Result<Value, ToolError> {
    let (progress, _rx) = mpsc::channel(1);
    let output = tool.call(input, context, progress).await?;
    Ok(serde_json::from_str(&output_text(&output)).unwrap_or_else(|e| panic!("{e}")))
}

fn failure(result: Result<Value, ToolError>) -> String {
    match result {
        Err(error) => error.to_string(),
        Ok(value) => panic!("expected a failure, got {value}"),
    }
}

fn invalid_message(validation: Validation) -> String {
    match validation {
        Validation::Invalid { message, .. } => message,
        Validation::Ok => panic!("expected an invalid input"),
    }
}

fn task(id: &str, session: &str, status: &str) -> Value {
    json!({
        "offPeakTaskId": id, "title": "Refactor utils", "status": status,
        "sessionId": session, "createdAt": 1_800_000_000_000_u64,
        "serverTicketId": "secret-ticket", "providerName": "zai",
    })
}

fn created(id: &str) -> Value {
    json!({
        "ok": true,
        "task": task(id, "sess_1", "queued"),
    })
}

#[test]
fn the_two_contracts_are_node_s_deferred_tools_with_their_approval() {
    let host = Arc::new(Host::default());
    let port: Arc<dyn OffPeakPort> = host;
    let tools = off_peak_tools(port);
    let names: Vec<&str> = tools.iter().map(|tool| tool.name()).collect();
    assert_eq!(names, ["OffPeakCreate", "OffPeakList"]);
    let create = &tools[0];
    let list = &tools[1];
    // Node marks both `shouldDefer: true`, so they are deferred under tool search.
    assert!(create.should_defer());
    assert!(list.should_defer());
    assert!(!create.is_read_only(&json!({})));
    assert!(list.is_read_only(&json!({})));
    assert!(list.is_concurrency_safe(&json!({})));
    assert!(!create.is_concurrency_safe(&json!({})));
    let prompt = PromptContext {
        tool_names: Vec::new(),
        mode: PermissionMode::Default,
    };
    assert!(create.description(&prompt).contains("idle-time task"));
}

#[tokio::test]
async fn create_asks_for_approval_and_list_does_not() {
    let host = Host::answering(vec![]);
    let create = tool(&host, "OffPeakCreate");
    let list = tool(&host, "OffPeakList");
    let ask = create
        .check_permissions(&json!({}), &context(TurnLimits::default()))
        .await;
    assert!(matches!(ask, PermissionDecision::Passthrough));
    let allowed = list
        .check_permissions(&json!({}), &context(TurnLimits::default()))
        .await;
    assert!(matches!(allowed, PermissionDecision::Allow { .. }));
}

#[tokio::test]
async fn an_off_peak_turn_refuses_create_before_any_request() {
    let host = Host::answering(vec![]);
    let create = tool(&host, "OffPeakCreate");
    let limits = TurnLimits::new(None, vec!["OffPeakCreate".to_owned()]);
    let message = failure(
        call(
            &create,
            json!({"title": "t", "prompt": "p"}),
            context(limits),
        )
        .await,
    );
    assert_eq!(
        message,
        "OffPeakCreate is not allowed while running an idle-time task."
    );
    assert!(host.requests().is_empty());
}

#[tokio::test]
async fn an_off_peak_turn_still_lists() {
    let host = Host::answering(vec![Ok(json!({"tasks": []}))]);
    let list = tool(&host, "OffPeakList");
    let limits = TurnLimits::new(None, vec!["OffPeakCreate".to_owned()]);
    let listed = call(&list, json!({}), context(limits)).await.unwrap();
    assert_eq!(listed, json!({"tasks": []}));
    assert_eq!(host.methods(), ["offPeak/list"]);
}

#[test]
fn create_input_refuses_unknown_blank_and_unlisted_fields() {
    let host = Host::answering(vec![]);
    let create = tool(&host, "OffPeakCreate");
    let ctx = context(TurnLimits::default());
    for input in [
        json!({"title": "t", "prompt": "p", "workspace": "/elsewhere"}),
        json!({"title": "   ", "prompt": "p"}),
        json!({"title": "t", "prompt": ""}),
        json!({"title": "t", "prompt": "p", "permissionMode": "turbo"}),
        json!({"title": "t", "prompt": "p", "model": null}),
    ] {
        let message = invalid_message(futures_block_on(create.validate_input(&input, &ctx)));
        assert!(!message.is_empty(), "{input}");
    }
    assert!(matches!(
        futures_block_on(create.validate_input(&json!({"title": "t", "prompt": "p"}), &ctx)),
        Validation::Ok
    ));
}

/// The validation is async; the test runs it on a current-thread runtime.
fn futures_block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

#[tokio::test]
async fn create_checks_the_bound_session_then_sends_node_s_params() {
    let host = Host::answering(vec![Ok(json!({"tasks": []})), Ok(created("oft_1"))]);
    let create = tool(&host, "OffPeakCreate");
    let output = call(
        &create,
        json!({"title": " Refactor utils ", "prompt": "Clean up the helpers"}),
        context(TurnLimits::default()),
    )
    .await
    .unwrap();
    assert_eq!(host.methods(), ["offPeak/list", "offPeak/create"]);
    let (owner, method, params) = host.requests().remove(1);
    assert_eq!(owner, "sess_1");
    assert_eq!(method, "offPeak/create");
    // Node passes only the fields the model set, plus the bound session; the title is trimmed by the input schema.
    assert_eq!(
        params,
        json!({"title": "Refactor utils", "prompt": "Clean up the helpers", "boundSessionId": "sess_1"})
    );
    assert_eq!(output["task"]["offPeakTaskId"], "oft_1");
    assert_eq!(output["message"], "Created idle-time task oft_1.");
}

#[tokio::test]
async fn create_forwards_the_optional_fields_it_was_given() {
    let host = Host::answering(vec![Ok(json!({"tasks": []})), Ok(created("oft_2"))]);
    let create = tool(&host, "OffPeakCreate");
    call(
        &create,
        json!({
            "title": "t", "prompt": "p", "permissionMode": "plan",
            "model": "glm-5", "thoughtLevel": "low",
        }),
        context(TurnLimits::default()),
    )
    .await
    .unwrap();
    let params = host.requests().remove(1).2;
    assert_eq!(params["permissionMode"], "plan");
    assert_eq!(params["model"], "glm-5");
    assert_eq!(params["thoughtLevel"], "low");
}

#[tokio::test]
async fn the_message_names_the_queue_position_when_the_host_gives_one() {
    let mut queued = created("oft_3");
    queued["task"]["queuePosition"] = json!(2);
    let host = Host::answering(vec![Ok(json!({"tasks": []})), Ok(queued)]);
    let create = tool(&host, "OffPeakCreate");
    let output = call(
        &create,
        json!({"title": "t", "prompt": "p"}),
        context(TurnLimits::default()),
    )
    .await
    .unwrap();
    assert_eq!(
        output["message"],
        "Created idle-time task oft_3 (#2 in queue)."
    );
}

#[tokio::test]
async fn a_pending_task_of_this_session_refuses_before_any_create() {
    let host = Host::answering(vec![Ok(
        json!({"tasks": [task("oft_9", "sess_1", "running")]}),
    )]);
    let create = tool(&host, "OffPeakCreate");
    let message = failure(
        call(
            &create,
            json!({"title": "t", "prompt": "p"}),
            context(TurnLimits::default()),
        )
        .await,
    );
    assert_eq!(
        message,
        "This session already has a pending idle-time task. Wait for it to finish (or cancel it in Automations) before creating another one here."
    );
    assert_eq!(host.methods(), ["offPeak/list"]);
}

#[tokio::test]
async fn finished_tasks_and_other_sessions_do_not_block_a_create() {
    let host = Host::answering(vec![
        Ok(json!({"tasks": [
            task("oft_1", "sess_1", "completed"),
            task("oft_2", "sess_1", "failed"),
            task("oft_3", "sess_1", "cancelled"),
            task("oft_4", "sess_other", "queued"),
        ]})),
        Ok(created("oft_5")),
    ]);
    let create = tool(&host, "OffPeakCreate");
    call(
        &create,
        json!({"title": "t", "prompt": "p"}),
        context(TurnLimits::default()),
    )
    .await
    .unwrap();
    assert_eq!(host.methods(), ["offPeak/list", "offPeak/create"]);
}

#[tokio::test]
async fn a_failed_bound_check_fails_closed_without_a_create() {
    let host = Host::answering(vec![Err(OffPeakError::new("database is locked"))]);
    let create = tool(&host, "OffPeakCreate");
    let message = failure(
        call(
            &create,
            json!({"title": "t", "prompt": "p"}),
            context(TurnLimits::default()),
        )
        .await,
    );
    assert_eq!(
        message,
        "Cannot verify whether this session already has a pending idle-time task; try again later."
    );
    assert_eq!(host.methods(), ["offPeak/list"]);
}

#[tokio::test]
async fn business_failures_keep_node_s_texts_by_category() {
    let cases = [
        (
            json!({"ok": false, "failureStage": "ticket", "errorCategory": "quota_3103", "errorCode": "3103"}),
            "The idle-time task quota is used up for now. Tell the user the free quota is exhausted and they can retry later or review tasks in Automations.",
        ),
        (
            json!({"ok": false, "failureStage": "ticket", "errorCategory": "eligibility_3101", "errorCode": "3101"}),
            "The current account has no eligible Coding Plan connection for idle-time tasks. Tell the user to select a ZAI/BigModel Coding Plan connection first.",
        ),
        (
            json!({"ok": false, "failureStage": "validate", "errorCategory": "client_validation", "errorCode": "model_not_allowed"}),
            "The requested model is not in the idle-time allowed model list. Omit the model field to use the default allowed model.",
        ),
        (
            json!({"ok": false, "failureStage": "validate", "errorCategory": "client_validation", "errorCode": "session_bound"}),
            "This session already has a pending idle-time task. Tell the user to wait for it to finish or cancel it in Automations before creating another one here.",
        ),
        (
            json!({"ok": false, "failureStage": "validate", "errorCategory": "client_validation", "errorCode": "offpeak_disabled"}),
            "Idle-time tasks are not enabled for this account right now. Tell the user the feature is unavailable; do not retry with different parameters.",
        ),
        (
            json!({"ok": false, "failureStage": "validate", "errorCategory": "client_validation", "errorCode": "other"}),
            "The idle-time task input was rejected by validation.",
        ),
        (
            json!({"ok": false, "failureStage": "ticket", "errorCategory": "network", "errorCode": "x"}),
            "The idle-time ticket service is unreachable. Tell the user to retry later.",
        ),
        (
            json!({"ok": false, "failureStage": "create", "errorCategory": "unknown", "errorCode": "x"}),
            "Creating the idle-time task failed. Tell the user to retry from the Automations page.",
        ),
    ];
    for (outcome, expected) in cases {
        let host = Host::answering(vec![Ok(json!({"tasks": []})), Ok(outcome.clone())]);
        let create = tool(&host, "OffPeakCreate");
        let message = failure(
            call(
                &create,
                json!({"title": "t", "prompt": "p"}),
                context(TurnLimits::default()),
            )
            .await,
        );
        assert_eq!(message, expected, "{outcome}");
    }
}

#[tokio::test]
async fn list_returns_only_the_model_fields_of_each_task() {
    let host = Host::answering(vec![Ok(
        json!({"tasks": [task("oft_1", "sess_1", "queued")]}),
    )]);
    let list = tool(&host, "OffPeakList");
    let listed = call(&list, json!({}), context(TurnLimits::default()))
        .await
        .unwrap();
    assert_eq!(
        listed,
        json!({"tasks": [{
            "offPeakTaskId": "oft_1", "title": "Refactor utils", "status": "queued",
            "sessionId": "sess_1", "createdAt": 1_800_000_000_000_u64,
        }]})
    );
}

/// A port that offers the tools to the sessions in `enabled` only.
struct Gate {
    enabled: Mutex<Vec<String>>,
}

#[async_trait]
impl OffPeakPort for Gate {
    fn tools_enabled(&self, session: &SessionId) -> bool {
        self.enabled
            .lock()
            .unwrap()
            .iter()
            .any(|id| id == session.as_str())
    }

    async fn request(&self, _: &SessionId, _: &str, _: Value) -> Answer {
        Err(OffPeakError::new("unused"))
    }
}

fn names(registry: &dyn ToolRegistry, session: &SessionId) -> Vec<String> {
    registry
        .snapshot(session)
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect()
}

/// Node injects `offPeakPort` per session: only a session with the tools on sees OffPeakCreate and OffPeakList.
#[test]
fn the_tools_are_offered_per_session() {
    let gate = Arc::new(Gate {
        enabled: Mutex::new(vec!["sess_on".to_owned()]),
    });
    let inner: Arc<dyn ToolRegistry> = Arc::new(rust_cli_kernel_api::testing::ListTools(vec![]));
    let registry = OffPeakTools::new(inner, gate.clone());
    let on = SessionId::new("sess_on");
    let off = SessionId::new("sess_off");
    assert_eq!(names(&registry, &on), ["OffPeakCreate", "OffPeakList"]);
    assert!(names(&registry, &off).is_empty());
    assert!(registry.find_for(&on, "OffPeakCreate").is_some());
    assert!(registry.find_for(&off, "OffPeakCreate").is_none());
    assert!(registry.find_for(&off, "OffPeakList").is_none());
    assert!(
        registry.find("OffPeakList").is_none(),
        "no session, no tool"
    );
    assert!(registry.withheld("OffPeakList").is_none());
    gate.enabled.lock().unwrap().push("sess_off".to_owned());
    assert_eq!(names(&registry, &off), ["OffPeakCreate", "OffPeakList"]);
}

#[tokio::test]
async fn list_refuses_unknown_keys_before_any_request() {
    let host = Host::answering(vec![]);
    let list = tool(&host, "OffPeakList");
    let message = invalid_message(
        list.validate_input(
            &json!({"status": "queued"}),
            &context(TurnLimits::default()),
        )
        .await,
    );
    assert!(!message.is_empty());
    assert!(host.requests().is_empty());
}
