//! Fork (desktop App): the goal completion verifier (specs/fork-rust-goal-verifier.md §5).

use std::sync::Arc;
use std::time::Duration;

use rust_cli_kernel_api::goal::{GoalPhase, VerificationOutcome, VerificationStatus};
use rust_cli_kernel_api::ids::{CommandId, SessionId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{ModelRequest, QuerySource};
use rust_cli_kernel_api::session_api::{Command, CommandEnvelope, KernelEvent, SessionHandle};
use rust_cli_kernel_api::side_request::SideSource;
use rust_cli_kernel_api::store::Fact;
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use tokio::sync::Notify;

use crate::test_support::{Built, Setup, submit, until};

const PASSED: &str = r#"{"passed": true, "reason": "All done."}"#;
const NOT_MET: &str =
    r#"{"passed": false, "reason": "Tests fail.", "nextAction": "Fix the parser."}"#;

const NOT_MET_ONLY: &str = r#"{"passed": false, "reason": "Tests fail."}"#;

fn is_goal(event: &KernelEvent, phase: GoalPhase) -> bool {
    matches!(event, KernelEvent::GoalChanged { goal: Some(goal) } if goal.status == phase)
}

fn steps(events: &[KernelEvent]) -> Vec<(VerificationStatus, u32)> {
    events
        .iter()
        .filter_map(|event| match event {
            KernelEvent::GoalVerification { verification, .. } => {
                Some((verification.status, verification.goal_iteration))
            }
            _ => None,
        })
        .collect()
}

async fn desktop(model: Arc<ScriptedModel>) -> Built {
    let mut setup = Setup::new(model);
    setup.desktop_goals = true;
    setup.build().await
}

fn scripted(replies: &[&str]) -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(
        replies
            .iter()
            .map(|reply| text_response(&[reply]))
            .collect(),
    ))
}

fn is_verification(request: &ModelRequest) -> bool {
    request.source == QuerySource::Side(SideSource::GoalVerification)
}

fn command(id: &str, command: Command) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command,
    }
}

/// A verification that is not met and names a next action starts a continuation whose meta message carries the
/// verifier's result; that turn is verified again with the next iteration.
#[tokio::test]
async fn a_not_met_verification_continues_with_its_next_action() {
    let model = scripted(&["reply 0", NOT_MET, "reply 1", PASSED]);
    let built = desktop(model.clone()).await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "/goal tests pass")).await;
    let seen = until(&mut events, |event| is_goal(event, GoalPhase::Verified)).await;
    assert_eq!(
        steps(&seen),
        [
            (VerificationStatus::Started, 1),
            (VerificationStatus::Completed, 1),
            (VerificationStatus::Started, 2),
            (VerificationStatus::Completed, 2),
        ]
    );
    let requests = model.requests();
    assert_eq!(requests.len(), 4);
    assert!(is_verification(&requests[1]) && is_verification(&requests[3]));
    assert!(requests[1].tools.is_empty());
    let verify = format!("{:?}", requests[1].messages);
    assert!(verify.contains("Verify whether the active session goal is actually complete."));
    assert!(verify.contains("reply 0"));
    let continued = format!("{:?}", requests[2].messages);
    assert!(continued.contains("Completion verifier result:"));
    assert!(continued.contains("Next action: Fix the parser."));
    let goal = built.session.view().await.unwrap().goal.unwrap();
    let outcomes: Vec<_> = goal
        .verifications
        .iter()
        .map(|item| (item.iteration, item.outcome))
        .collect();
    assert_eq!(
        outcomes,
        [
            (1, VerificationOutcome::NotSatisfied),
            (2, VerificationOutcome::Pass)
        ]
    );
    assert_eq!(goal.iteration, 2);
    // One Node session entry per step.
    let stored = built
        .store
        .facts(&SessionId::new("sess_1"))
        .into_iter()
        .filter(|fact| matches!(fact, Fact::GoalVerificationRecorded { .. }))
        .count();
    assert_eq!(stored, 4);
}

/// A reply that is not JSON fails open (verified); a failed request is marked `failed_closed` and also verified.
#[tokio::test]
async fn an_unreadable_or_failed_verification_fails_open() {
    for (replies, status) in [
        (&["reply 0", "not json"][..], VerificationStatus::Completed),
        (&["reply 0"][..], VerificationStatus::FailedClosed),
    ] {
        let built = desktop(scripted(replies)).await;
        let mut events = built.session.subscribe(None);
        built.session.send(submit("c1", "/goal tests pass")).await;
        let seen = until(&mut events, |event| is_goal(event, GoalPhase::Verified)).await;
        assert_eq!(
            steps(&seen),
            [(VerificationStatus::Started, 1), (status, 1)]
        );
    }
}

/// `Interrupt` while verifying cancels it and pauses the goal; no continuation follows.
#[tokio::test]
async fn an_interrupted_verification_pauses_the_goal() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(
        ScriptedModel::new(vec![text_response(&["reply 0"]), text_response(&[NOT_MET])])
            .gated_at(1, gate),
    );
    let built = desktop(model.clone()).await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "/goal tests pass")).await;
    let mut seen = until(&mut events, |event| is_goal(event, GoalPhase::Verifying)).await;
    built.session.send(command("c2", Command::Interrupt)).await;
    seen.extend(until(&mut events, |event| is_goal(event, GoalPhase::Paused)).await);
    assert_eq!(
        steps(&seen),
        [
            (VerificationStatus::Started, 1),
            (VerificationStatus::Cancelled, 1)
        ]
    );
    let goal = built.session.view().await.unwrap().goal.unwrap();
    assert!(goal.verifications.is_empty());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(model.requests().len(), 2);
}

/// Input submitted while verifying waits for it, runs before any continuation, and its turn is verified.
#[tokio::test]
async fn input_queued_while_verifying_runs_first() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(
        ScriptedModel::new(vec![
            text_response(&["reply 0"]),
            text_response(&[NOT_MET]),
            text_response(&["queued reply"]),
            text_response(&[PASSED]),
        ])
        .gated_at(1, gate.clone()),
    );
    let built = desktop(model.clone()).await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "/goal tests pass")).await;
    until(&mut events, |event| is_goal(event, GoalPhase::Verifying)).await;
    built.session.send(submit("c2", "also check lint")).await;
    gate.notify_one();
    until(&mut events, |event| is_goal(event, GoalPhase::Verified)).await;
    let requests = model.requests();
    assert_eq!(requests.len(), 4);
    let third = format!("{:?}", requests[2].messages);
    assert!(third.contains("also check lint"));
    assert!(!third.contains("Completion verifier result:"));
    assert!(is_verification(&requests[3]));
}

/// Plan mode skips the verification: a turn of a not-met goal is verified only with plan off.
#[tokio::test]
async fn plan_mode_skips_the_verification() {
    let model = scripted(&["reply 0", NOT_MET_ONLY, "reply 1"]);
    let built = desktop(model.clone()).await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "/goal tests pass")).await;
    until(&mut events, |event| is_goal(event, GoalPhase::NotSatisfied)).await;
    built
        .session
        .send(command("c2", Command::SetPlan { enabled: true }))
        .await;
    built.session.send(submit("c3", "look around")).await;
    let seen = until(&mut events, crate::test_support::finished).await;
    assert!(steps(&seen).is_empty());
    tokio::time::sleep(Duration::from_millis(50)).await;
    let requests = model.requests();
    assert_eq!(requests.len(), 3);
    assert!(!is_verification(&requests[2]));
    let messages = built.session.view().await.unwrap().messages;
    assert!(
        messages
            .iter()
            .any(|message| matches!(message, Message::Assistant(_)))
    );
}

/// Stop while verifying with queued input (the app-server holds the queue first, specs/stop-queue-hold.md): the goal
/// pauses and the queued input stays queued.
#[tokio::test]
async fn a_stopped_verification_keeps_queued_input_held() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(
        ScriptedModel::new(vec![text_response(&["reply 0"]), text_response(&[NOT_MET])])
            .gated_at(1, gate),
    );
    let built = desktop(model.clone()).await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "/goal tests pass")).await;
    until(&mut events, |event| is_goal(event, GoalPhase::Verifying)).await;
    built.session.send(submit("c2", "also check lint")).await;
    built
        .session
        .send(command("c3", Command::HoldQueue { held: true }))
        .await;
    built.session.send(command("c4", Command::Interrupt)).await;
    until(&mut events, |event| is_goal(event, GoalPhase::Paused)).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(model.requests().len(), 2);
    let view = built.session.view().await.unwrap();
    assert_eq!(view.queue.len(), 1);
}
