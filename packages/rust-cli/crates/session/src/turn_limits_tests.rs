//! Fork: turn-scoped automation identity and tool limits (specs/fork-rust-automations.md, slice 1 item 4): an
//! automation turn hides the automation mutation tools and offers CronPauseSelf; an ordinary turn hides
//! CronPauseSelf; a disallowlist applies to its own turn only.

use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{InputExecution, QueuedKind};
use rust_cli_kernel_api::testing::FakeTool;
use rust_cli_kernel_api::turn_limits::TurnLimits;

use crate::test_support::envelope;

use super::*;

const TOOLS: [&str; 5] = [
    "CronCreate",
    "CronUpdate",
    "CronDelete",
    "CronPauseSelf",
    "Bash",
];

fn submit_limited(id: &str, limits: TurnLimits) -> CommandEnvelope {
    submit_with_state(id, limits, false)
}

/// An input whose execution records the default state; `keeps` marks it as naming no mode (limits alone).
fn submit_with_state(id: &str, limits: TurnLimits, keeps: bool) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::SubmitWith {
            intent: None,
            kind: QueuedKind::Text,
            text: "run".to_owned(),
            content: Vec::new(),
            delivery: Delivery::Queue,
            execution: Some(InputExecution {
                state: ExecutionState {
                    mode: PermissionMode::Default,
                    plan: false,
                },
                selection: None,
                limits,
                keeps_session_state: keeps,
            }),
            behind_held: false,
            lease: None,
        },
    }
}

fn tools() -> Vec<Arc<dyn rust_cli_kernel_api::tool::Tool>> {
    TOOLS
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "ok")) as _)
        .collect()
}

fn scripted(turns: usize) -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(
        (0..turns).map(|_| text_response(&["done"])).collect(),
    ))
}

async fn session_with_tools(scope: &TaskScope, turns: usize) -> (Arc<ScriptedModel>, Session) {
    let model = scripted(turns);
    let (_store, session) = tool_session(scope, Arc::new(NoHooks), model.clone(), tools()).await;
    (model, session)
}

/// The scripted model whose first request waits for the gate, so the inputs sent meanwhile queue behind a running turn.
struct FirstGated {
    inner: Arc<ScriptedModel>,
    gate: Arc<tokio::sync::Notify>,
    first: std::sync::atomic::AtomicBool,
}

impl rust_cli_kernel_api::model::ModelPort for FirstGated {
    fn stream(
        &self,
        request: ModelRequest,
        cancel: tokio_util::sync::CancellationToken,
    ) -> futures_util::stream::BoxStream<
        'static,
        Result<rust_cli_kernel_api::model::ModelEvent, rust_cli_kernel_api::model::ModelError>,
    > {
        use futures_util::StreamExt;
        let inner = self.inner.stream(request, cancel);
        if !self.first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return inner;
        }
        let gate = self.gate.clone();
        futures_util::stream::once(async move { gate.notified().await })
            .filter_map(|()| async { None })
            .chain(inner)
            .boxed()
    }
}

fn offered(request: &ModelRequest) -> std::collections::BTreeSet<&str> {
    request
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect()
}

fn names<const N: usize>(names: [&'static str; N]) -> std::collections::BTreeSet<&'static str> {
    names.into_iter().collect()
}

#[tokio::test]
async fn an_automation_turn_hides_mutations_and_the_next_ordinary_turn_does_not() {
    let scope = TaskScope::root("test", |_| {});
    let (model, session) = session_with_tools(&scope, 3).await;
    let mut events = session.subscribe(Some(0));

    let automation = TurnLimits::new(
        Some(" auto_1 "),
        vec![
            "CronCreate".into(),
            "CronUpdate".into(),
            "CronDelete".into(),
        ],
    );
    session.send(submit_limited("run_1", automation)).await;
    until_finished(&mut events, 1).await;
    session
        .send(submit_limited("c2", TurnLimits::default()))
        .await;
    until_finished(&mut events, 1).await;
    session
        .send(submit_limited(
            "c3",
            TurnLimits::new(None, vec!["Bash".into()]),
        ))
        .await;
    until_finished(&mut events, 1).await;

    let requests = model.requests();
    assert_eq!(offered(&requests[0]), names(["CronPauseSelf", "Bash"]));
    assert_eq!(
        offered(&requests[1]),
        names(["CronCreate", "CronUpdate", "CronDelete", "Bash"])
    );
    assert_eq!(
        offered(&requests[2]),
        names(["CronCreate", "CronUpdate", "CronDelete"])
    );
    assert_eq!(session.view().await.unwrap().queue.len(), 0);
}

/// Inputs queued behind a running turn keep their own limits when they drain: the automation item's turn has its
/// limits, the ordinary items before and after it have none (the queued path, `start_next`).
#[tokio::test]
async fn queued_inputs_drain_with_their_own_limits() {
    let scope = TaskScope::root("test", |_| {});
    let model = scripted(3);
    let gate = Arc::new(tokio::sync::Notify::new());
    let gated = Arc::new(FirstGated {
        inner: model.clone(),
        gate: gate.clone(),
        first: std::sync::atomic::AtomicBool::new(true),
    });
    let (_store, session) = tool_session(&scope, Arc::new(NoHooks), gated, tools()).await;
    let mut events = session.subscribe(Some(0));

    session
        .send(submit_limited("o1", TurnLimits::default()))
        .await;
    let automation = TurnLimits::new(
        Some("auto_1"),
        vec![
            "CronCreate".into(),
            "CronUpdate".into(),
            "CronDelete".into(),
        ],
    );
    session.send(submit_limited("run_1", automation)).await;
    session
        .send(submit_limited("o3", TurnLimits::default()))
        .await;
    assert_eq!(session.view().await.unwrap().queue.len(), 2, "both queued");
    gate.notify_one();
    until_finished(&mut events, 3).await;

    let requests = model.requests();
    let ordinary = names(["CronCreate", "CronUpdate", "CronDelete", "Bash"]);
    assert_eq!(offered(&requests[0]), ordinary);
    assert_eq!(offered(&requests[1]), names(["CronPauseSelf", "Bash"]));
    assert_eq!(offered(&requests[2]), ordinary);
}

/// An automation input that named no mode leaves the session's mode alone, started at once or drained from the queue
/// (Node gives such an input no execution state); its recorded state is not applied.
#[tokio::test]
async fn a_limits_only_input_leaves_the_session_mode_alone() {
    let scope = TaskScope::root("test", |_| {});
    let model = scripted(3);
    let gate = Arc::new(tokio::sync::Notify::new());
    let gated = Arc::new(FirstGated {
        inner: model.clone(),
        gate: gate.clone(),
        first: std::sync::atomic::AtomicBool::new(false),
    });
    let (_store, session) = tool_session(&scope, Arc::new(NoHooks), gated.clone(), tools()).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(envelope(
            "m1",
            Command::SetMode {
                mode: PermissionMode::AcceptEdits,
            },
        ))
        .await;
    let automation = || TurnLimits::new(Some("auto_1"), Vec::new());
    session
        .send(submit_with_state("run_1", automation(), true))
        .await;
    until_finished(&mut events, 1).await;
    assert_eq!(
        session.view().await.unwrap().mode,
        PermissionMode::AcceptEdits,
        "started at once"
    );

    gated.first.store(true, std::sync::atomic::Ordering::SeqCst);
    session
        .send(submit_limited("o2", TurnLimits::default()))
        .await;
    session
        .send(submit_with_state("run_3", automation(), true))
        .await;
    session
        .send(envelope(
            "m2",
            Command::SetMode {
                mode: PermissionMode::AcceptEdits,
            },
        ))
        .await;
    gate.notify_one();
    until_finished(&mut events, 2).await;
    assert_eq!(
        session.view().await.unwrap().mode,
        PermissionMode::AcceptEdits,
        "drained from the queue"
    );
}
