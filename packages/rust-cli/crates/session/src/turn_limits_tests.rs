//! Fork: turn-scoped automation identity and tool limits (specs/fork-rust-automations.md, slice 1 item 4): an
//! automation turn hides the automation mutation tools and offers CronPauseSelf; an ordinary turn hides
//! CronPauseSelf; a disallowlist applies to its own turn only.

use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{InputExecution, QueuedKind};
use rust_cli_kernel_api::testing::FakeTool;
use rust_cli_kernel_api::turn_limits::TurnLimits;

use super::*;

const TOOLS: [&str; 5] = [
    "CronCreate",
    "CronUpdate",
    "CronDelete",
    "CronPauseSelf",
    "Bash",
];

fn submit_limited(id: &str, limits: TurnLimits) -> CommandEnvelope {
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
            }),
            behind_held: false,
            lease: None,
        },
    }
}

async fn session_with_tools(scope: &TaskScope, turns: usize) -> (Arc<ScriptedModel>, Session) {
    let model = Arc::new(ScriptedModel::new(
        (0..turns).map(|_| text_response(&["done"])).collect(),
    ));
    let tools: Vec<Arc<dyn rust_cli_kernel_api::tool::Tool>> = TOOLS
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "ok")) as _)
        .collect();
    let (_store, session) = tool_session(scope, Arc::new(NoHooks), model.clone(), tools).await;
    (model, session)
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
