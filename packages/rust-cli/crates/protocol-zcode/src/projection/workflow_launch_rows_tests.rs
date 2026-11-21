//! Fork (9.63): a workflow settings record draws Node's control-only `workflowLaunch` turn, live and cold alike
//! (Node `product-projection.ts` TurnStarted, `transcript-hydration.ts` `workflowLaunchOfMessage`).

use rust_cli_kernel_api::ids::{MessageId, TurnId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::session_api::KernelEvent;
use serde_json::{Map, Value, json};

use super::{Feed, Followup, Projection, assistant, user, view};

fn launch_meta() -> Value {
    json!({
        "runId": "dwfrun-2",
        "toolCallId": "settings-1",
        "name": "nightly",
        "amend": {
            "predecessorRunId": "dwfrun-1",
            "subagentModel": {"to": "deepseek/deepseek-v4-pro"},
            "ceiling": 6
        }
    })
}

fn settings_record(id: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        workflow_meta: Some(json!({ "workflowLaunch": launch_meta() })),
        epilogue_start: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "Changed the settings of workflow run dwfrun-1 from the GUI.".into(),
        }],
        origin: UserOrigin::Meta {
            source: "workflow_settings".into(),
        },
    })
}

fn rows_of<'a>(projection: &'a Projection, kind: &str) -> Vec<&'a Map<String, Value>> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] == kind)
        .collect()
}

fn assert_launch_turn(projection: &Projection) {
    let header = rows_of(projection, "turnHeader")
        .into_iter()
        .find(|row| row["origin"] == "workflowLaunch")
        .expect("a workflowLaunch turn header");
    assert_eq!(header["executionKind"], "controlOnly");
    assert_eq!(header["workflowLaunch"], launch_meta());
    assert_eq!(header["state"], "completedSuccess");
    let input = rows_of(projection, "userInput")
        .into_iter()
        .find(|row| row["origin"] == "workflowLaunch")
        .expect("a workflowLaunch user input");
    assert_eq!(input["entityId"], "msg_set");
    assert_eq!(input["turnId"], header["turnId"]);
    assert_eq!(input["workflowLaunch"], launch_meta());
    assert_eq!(
        input["text"],
        "Changed the settings of workflow run dwfrun-1 from the GUI."
    );
}

/// Live: the record commits while the session is idle; its turn opens and settles on its own.
#[test]
fn a_live_settings_record_draws_a_control_only_workflow_launch_turn() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "start it"),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: rust_cli_kernel_api::session_api::TurnOutcome::Success,
        usage: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: settings_record("msg_set"),
    });
    assert_launch_turn(&feed.projection);
}

/// Cold: the stored record replays as the same turn, between the turns around it.
#[test]
fn a_cold_settings_record_draws_the_same_turn() {
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "start it"),
            assistant(
                "msg_a1",
                vec![ContentBlock::Text {
                    text: "started".into(),
                }],
            ),
            settings_record("msg_set"),
            user("msg_u2", "and now"),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    assert_launch_turn(&projection);
    let headers = rows_of(&projection, "turnHeader");
    assert_eq!(
        headers.len(),
        3,
        "the launch turn sits between the two typed turns"
    );
    assert_eq!(headers[1]["origin"], "workflowLaunch");
}

/// A record without `workflowLaunch` metadata (a hub launch, divergence 916) draws nothing, as before.
#[test]
fn a_record_without_launch_metadata_draws_no_row() {
    let mut feed = Feed::new();
    let mut record = settings_record("msg_set");
    if let Message::User(user) = &mut record {
        user.workflow_meta = None;
    }
    feed.apply(KernelEvent::MessageDone { message: record });
    assert!(feed.projection.rows.is_empty());
}
