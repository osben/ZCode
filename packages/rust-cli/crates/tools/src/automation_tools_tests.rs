use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::automation::{AutomationError, AutomationPort};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionMode};
use rust_cli_kernel_api::session_ops::RunView;
use rust_cli_kernel_api::testing::{NoOneToAsk, OpsOverride};
use rust_cli_kernel_api::tool::{PromptContext, Tool, ToolError, ToolUseContext, Validation};
use rust_cli_kernel_api::turn_limits::TurnLimits;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

type Answer = Result<Value, AutomationError>;

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
impl AutomationPort for Host {
    async fn request(&self, session: &SessionId, method: &str, params: Value) -> Answer {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((session.as_str().to_owned(), method.to_owned(), params));
        self.answers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
            .unwrap_or_else(|| Err(AutomationError::new("no scripted answer")))
    }
}

/// The session: its selection and turn limits, and the titles it was asked to freeze.
#[derive(Default)]
struct Session {
    limits: TurnLimits,
    /// The actor is gone: `view` answers nothing.
    gone: bool,
    frozen: Mutex<Vec<String>>,
}

#[async_trait]
impl OpsOverride for Session {
    async fn view(&self) -> Option<RunView> {
        if self.gone {
            return None;
        }
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

    async fn freeze_title(&self, title: String) {
        self.frozen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(title);
    }
}

fn context(session: Arc<Session>, mode: PermissionMode) -> ToolUseContext {
    let mut ctx = Ctx::new(Arc::new(NoOneToAsk));
    ctx.session_ops = session;
    ctx.mode = mode;
    ctx.build()
}

fn tool(host: &Arc<Host>, name: &str) -> Arc<dyn Tool> {
    let port: Arc<dyn AutomationPort> = host.clone();
    automation_tools(port)
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

fn automation(id: &str, title: &str) -> Value {
    json!({
        "automationId": id, "title": title, "cronExpr": "0 9 * * *", "prompt": "check the build",
        "modelSelection": {"providerId": "zai", "modelId": "glm-5"}, "mode": "build", "targetTaskId": "sess_1",
        "enabled": true, "lifecycleStatus": "active", "nextRunAt": 1_800_000_000_000_u64, "runCount": 0,
        "recurring": true,
    })
}

fn invalid_message(validation: Validation) -> String {
    match validation {
        Validation::Invalid { message, .. } => message,
        Validation::Ok => panic!("expected an invalid input"),
    }
}

fn failure(result: Result<Value, ToolError>) -> String {
    match result {
        Err(error) => error.to_string(),
        Ok(value) => panic!("expected a failure, got {value}"),
    }
}

#[test]
fn the_five_contracts_are_node_s_and_not_deferred() {
    let host = Arc::new(Host::default());
    let port: Arc<dyn AutomationPort> = host;
    let tools = automation_tools(port);
    let names: Vec<&str> = tools.iter().map(|tool| tool.name()).collect();
    assert_eq!(
        names,
        [
            "CronCreate",
            "CronList",
            "CronUpdate",
            "CronDelete",
            "CronPauseSelf"
        ]
    );
    let prompt = PromptContext {
        tool_names: Vec::new(),
        mode: PermissionMode::Default,
    };
    for tool in &tools {
        assert!(!tool.should_defer(), "{}", tool.name());
        // Node `toolDescriptionForProvider`: the model instructions follow as a `Usage:` list where a tool has any.
        let usage = tool.description(&prompt).contains("\n\nUsage:\n- ");
        assert_eq!(
            usage,
            !matches!(tool.name(), "CronList" | "CronDelete"),
            "{}",
            tool.name()
        );
        assert_eq!(tool.input_schema()["type"], "object", "{}", tool.name());
    }
    let create = &tools[0];
    assert!(
        create
            .description(&prompt)
            .contains("must never ask the run to create")
    );
    assert_eq!(
        create.search_hint(),
        Some("schedule a recurring or one-shot prompt")
    );
    assert!(tools[1].is_read_only(&json!({})));
    assert!(tools[3].is_destructive(&json!({"id": "a"})));
}

#[tokio::test]
async fn create_update_and_delete_ask_while_list_and_pause_self_are_allowed() {
    let host = Arc::new(Host::default());
    let session = Arc::new(Session::default());
    for (name, asks) in [
        ("CronCreate", true),
        ("CronUpdate", true),
        ("CronDelete", true),
        ("CronList", false),
        ("CronPauseSelf", false),
    ] {
        let decision = tool(&host, name)
            .check_permissions(
                &json!({}),
                &context(session.clone(), PermissionMode::Default),
            )
            .await;
        assert_eq!(
            matches!(decision, PermissionDecision::Passthrough),
            asks,
            "{name}"
        );
    }
}

/// Node sends the base mode (`getMode()`; plan is a separate switch), so a task created in plan mode keeps the
/// session's base mode, never `plan`.
#[tokio::test]
async fn create_in_plan_mode_saves_the_session_s_base_mode() {
    let host = Host::answering(vec![
        Ok(json!({"bound": false})),
        Ok(json!({"automation": automation("auto_1", "t")})),
    ]);
    let mut context = context(Arc::new(Session::default()), PermissionMode::AcceptEdits);
    context.mode = PermissionMode::Plan;
    let input = json!({"cron": "0 9 * * *", "prompt": "p", "title": "t"});
    call(&tool(&host, "CronCreate"), input, context)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let requests = host.requests();
    assert_eq!(requests[1].1, "automation/create");
    assert_eq!(requests[1].2["mode"], "edit");
}

#[tokio::test]
async fn create_checks_the_binding_then_sends_node_s_params_and_freezes_the_title() {
    let host = Host::answering(vec![
        Ok(json!({"bound": false})),
        Ok(json!({"automation": automation("auto_1", "Check the build every day at 9")})),
    ]);
    let session = Arc::new(Session::default());
    let context = context(session.clone(), PermissionMode::Auto);
    let owner = context.session.as_str().to_owned();
    let input = json!({"cron": " 0 9 * * * ", "prompt": " check the build ", "title": "Check the build every day at 9"});
    let output = call(&tool(&host, "CronCreate"), input, context)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let requests = host.requests();
    assert_eq!(
        requests[0],
        (
            owner.clone(),
            "automation/checkTaskBinding".to_owned(),
            json!({"targetTaskId": owner})
        )
    );
    assert_eq!(requests[1].1, "automation/create");
    // The trimmed values (zod `trim()`), the session's selection, `auto` saved as `build`, and Node's key order.
    assert_eq!(
        requests[1].2.to_string(),
        json!({
            "cronExpr": "0 9 * * *", "prompt": "check the build", "title": "Check the build every day at 9",
            "recurring": true, "modelSelection": {"providerId": "zai", "modelId": "glm-5", "options": {"reasoningLevel": "high"}},
            "mode": "build", "targetTaskId": owner,
        })
        .to_string()
    );
    // The model sees no model selection, mode or target; only the reply's fields, in Node's order.
    assert_eq!(
        output.to_string(),
        json!({
            "automation": {
                "automationId": "auto_1", "title": "Check the build every day at 9", "cronExpr": "0 9 * * *",
                "prompt": "check the build", "enabled": true, "lifecycleStatus": "active",
                "nextRunAt": 1_800_000_000_000_u64, "runCount": 0, "recurring": true,
            },
            "message": "Created automation auto_1.",
        })
        .to_string()
    );
    assert_eq!(
        *session
            .frozen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        ["Check the build every day at 9"]
    );
}

#[test]
fn create_params_follow_the_relative_carrier_and_finite_rules() {
    let target = SessionId::new("sess_1");
    let params = |input: Value| {
        let input = create_input(&input).unwrap_or_else(|e| panic!("{e}"));
        let mut params = create_params(&input, None, PermissionMode::AcceptEdits, &target);
        params
            .as_object_mut()
            .map(|params| params.remove("targetTaskId"));
        params
    };
    // A relative delay: the placeholder cron, the host's delay, one-shot.
    assert_eq!(
        params(json!({"delayMinutes": 8, "prompt": "p", "title": "In 8 minutes"})),
        json!({"cronExpr": "* * * * *", "relativeDelayMinutes": 8, "prompt": "p", "title": "In 8 minutes",
            "recurring": false, "mode": "edit"})
    );
    // `delayMinutes: null` is not relative.
    assert_eq!(
        params(json!({"cron": "0 9 * * *", "delayMinutes": null, "prompt": "p", "title": "t"}))["recurring"],
        true
    );
    // An interval carrier is recurring and sends no maxRuns.
    assert_eq!(
        params(
            json!({"cron": "49 */31 * * *", "prompt": "p", "title": "Every 31 hours", "intervalUnit": "hourly", "interval": 31})
        ),
        json!({"cronExpr": "49 */31 * * *", "prompt": "p", "title": "Every 31 hours", "recurring": true,
            "mode": "edit", "intervalUnit": "hourly", "interval": 31})
    );
    // A finite automation.
    assert_eq!(
        params(
            json!({"cron": "0 9 * * *", "prompt": "p", "title": "t", "recurring": false, "maxRuns": 3})
        ),
        json!({"cronExpr": "0 9 * * *", "prompt": "p", "title": "t", "recurring": false, "mode": "edit", "maxRuns": 3})
    );
}

#[test]
fn create_refuses_what_node_s_refinements_refuse() {
    for (input, message) in [
        (
            json!({"prompt": "p", "title": "t"}),
            "cron is required when delayMinutes is not set",
        ),
        (
            json!({"cron": "* * * * *", "delayMinutes": 5, "prompt": "p", "title": "t"}),
            "a relative delay must omit cron",
        ),
        (
            json!({"delayMinutes": 5, "recurring": true, "prompt": "p", "title": "t"}),
            "cannot use recurring=true",
        ),
        (
            json!({"delayMinutes": 5, "maxRuns": 2, "prompt": "p", "title": "t"}),
            "cannot use maxRuns",
        ),
        (
            json!({"delayMinutes": 5, "intervalUnit": "daily", "interval": 2, "prompt": "p", "title": "t"}),
            "cannot combine with a relative delayMinutes",
        ),
        (
            json!({"cron": "0 9 * * *", "intervalUnit": "daily", "prompt": "p", "title": "t"}),
            "intervalUnit and interval must be set together",
        ),
        (
            json!({"cron": "0 9 * * *", "intervalUnit": "daily", "interval": 2, "recurring": false, "prompt": "p", "title": "t"}),
            "requires recurring=true",
        ),
        (
            json!({"cron": "0 9 * * *", "intervalUnit": "daily", "interval": 2, "maxRuns": 2, "prompt": "p", "title": "t"}),
            "cannot combine with maxRuns",
        ),
        (
            json!({"cron": "0 9 * * *", "prompt": "  ", "title": "t"}),
            "prompt: String must contain",
        ),
        (
            json!({"cron": "0 9 * * *", "prompt": "p", "title": "t", "extra": 1}),
            "unknown field",
        ),
    ] {
        let message_seen = create_input(&input).err().unwrap_or_default();
        assert!(message_seen.contains(message), "{input}: {message_seen}");
    }
}

#[tokio::test]
async fn validate_input_reports_the_refinements() {
    let host = Arc::new(Host::default());
    let context = context(Arc::new(Session::default()), PermissionMode::Default);
    let message = invalid_message(
        tool(&host, "CronUpdate")
            .validate_input(&json!({"id": "a", "title": "t", "maxRuns": null}), &context)
            .await,
    );
    assert_eq!(
        message,
        "Clearing maxRuns requires recurring=true in the same update"
    );
    let ok = tool(&host, "CronCreate")
        .validate_input(
            &json!({"delayMinutes": 3, "prompt": "p", "title": "t"}),
            &context,
        )
        .await;
    assert_eq!(ok, Validation::Ok);
}

#[test]
fn update_params_switch_a_carrier_to_an_unbounded_recurrence() {
    let update =
        |input: Value| update_params(&update_input(&input).unwrap_or_else(|e| panic!("{e}")));
    assert_eq!(
        update(json!({"id": " a1 ", "title": "Every 50 hours", "intervalUnit": "hourly", "interval": 50})).to_string(),
        json!({"automationId": "a1", "title": "Every 50 hours", "recurring": true, "maxRuns": null,
            "intervalUnit": "hourly", "interval": 50})
        .to_string()
    );
    assert_eq!(
        update(json!({"id": "a1", "title": "t", "cron": "*/6 * * * *", "recurring": true, "maxRuns": null})).to_string(),
        json!({"automationId": "a1", "title": "t", "cronExpr": "*/6 * * * *", "recurring": true, "maxRuns": null}).to_string()
    );
    assert_eq!(
        update(json!({"id": "a1", "title": "t", "recurring": false, "maxRuns": 2})),
        json!({"automationId": "a1", "title": "t", "recurring": false, "maxRuns": 2})
    );
    for (input, message) in [
        (
            json!({"id": "a", "title": "t", "recurring": true, "maxRuns": 2}),
            "cannot be combined with a numeric maxRuns",
        ),
        (
            json!({"id": "a", "title": "t", "intervalUnit": "daily", "interval": 2, "recurring": false}),
            "cannot combine with recurring=false",
        ),
        (
            json!({"id": "a", "title": "t", "intervalUnit": "daily", "interval": 2, "maxRuns": 2, "recurring": false}),
            "cannot combine with recurring=false",
        ),
        (
            json!({"id": "a", "title": "t", "intervalUnit": "weekly", "interval": 0}),
            "interval: must be an integer from 1 to 200",
        ),
        (
            json!({"id": "a", "title": "t", "intervalUnit": "fortnightly", "interval": 2}),
            "intervalUnit: Invalid enum value",
        ),
    ] {
        let seen = update_input(&input).err().unwrap_or_default();
        assert!(seen.contains(message), "{input}: {seen}");
    }
}

#[tokio::test]
async fn create_in_a_bound_session_is_refused_before_any_create() {
    let host = Host::answering(vec![Ok(json!({"bound": true}))]);
    let context = context(Arc::new(Session::default()), PermissionMode::Default);
    let input = json!({"cron": "0 9 * * *", "prompt": "p", "title": "t"});
    let message = failure(call(&tool(&host, "CronCreate"), input, context).await);
    assert_eq!(message, CREATE_IN_BOUND_SESSION);
    assert_eq!(host.methods(), ["automation/checkTaskBinding"]);
}

#[tokio::test]
async fn only_method_not_found_falls_back_to_the_list_and_other_failures_fail_closed() {
    let input = json!({"cron": "0 9 * * *", "prompt": "p", "title": "t"});
    // An older Host: -32601, then the list shows an automation targeting this session.
    let ctx = context(Arc::new(Session::default()), PermissionMode::Default);
    let owner = ctx.session.as_str().to_owned();
    let host = Host::answering(vec![
        Err(AutomationError {
            code: Some(-32601),
            message: "Method not found".to_owned(),
        }),
        Ok(json!({"automations": [{"targetTaskId": "other"}, {"targetTaskId": owner}]})),
    ]);
    let message = failure(call(&tool(&host, "CronCreate"), input.clone(), ctx).await);
    assert_eq!(message, CREATE_IN_BOUND_SESSION);
    assert_eq!(
        host.methods(),
        ["automation/checkTaskBinding", "automation/list"]
    );
    // Any other failure (a database error, a timeout) is "cannot verify", never "unbound".
    let host = Host::answering(vec![Err(AutomationError {
        code: Some(-32603),
        message: "database is locked".to_owned(),
    })]);
    let ctx = context(Arc::new(Session::default()), PermissionMode::Default);
    let message = failure(call(&tool(&host, "CronCreate"), input, ctx).await);
    assert_eq!(message, BOUND_SESSION_CHECK_FAILED);
    assert_eq!(host.methods(), ["automation/checkTaskBinding"]);
}

#[tokio::test]
async fn a_restricted_turn_refuses_the_mutations_before_any_request() {
    let restricted = [
        TurnLimits::new(Some("auto_1"), Vec::new()),
        TurnLimits::new(
            None,
            vec![
                "CronCreate".to_owned(),
                "CronUpdate".to_owned(),
                "CronDelete".to_owned(),
            ],
        ),
    ];
    for limits in restricted {
        let session = Arc::new(Session {
            limits,
            ..Session::default()
        });
        for (name, input) in [
            (
                "CronCreate",
                json!({"cron": "0 9 * * *", "prompt": "p", "title": "t"}),
            ),
            ("CronUpdate", json!({"id": "a", "title": "t"})),
            ("CronDelete", json!({"id": "a"})),
        ] {
            let host = Arc::new(Host::default());
            let message = failure(
                call(
                    &tool(&host, name),
                    input,
                    context(session.clone(), PermissionMode::Default),
                )
                .await,
            );
            assert_eq!(
                message,
                format!("{name} is not allowed while running a scheduled automation.")
            );
            assert!(host.requests().is_empty(), "{name}");
        }
    }
}

/// Node checks the turn before it parses the input (`assertNotAutomationTurn` first), so on a restricted turn an
/// input that breaks a refinement still gets the refusal, not the field's error.
#[tokio::test]
async fn a_restricted_turn_refuses_before_the_input_refinements() {
    let session = Arc::new(Session {
        limits: TurnLimits::new(Some("auto_1"), Vec::new()),
        ..Session::default()
    });
    for (name, input) in [
        (
            "CronCreate",
            json!({"cron": "0 9 * * *", "prompt": "p", "title": "t", "recurring": false, "maxRuns": 0}),
        ),
        (
            "CronUpdate",
            json!({"id": "a", "title": "t", "maxRuns": null}),
        ),
    ] {
        let host = Arc::new(Host::default());
        let tool = tool(&host, name);
        let ctx = context(session.clone(), PermissionMode::Default);
        assert!(
            matches!(tool.validate_input(&input, &ctx).await, Validation::Ok),
            "{name}"
        );
        let message = failure(call(&tool, input, ctx).await);
        assert_eq!(
            message,
            format!("{name} is not allowed while running a scheduled automation.")
        );
        assert!(host.requests().is_empty(), "{name}");
    }
    // An ordinary turn still reports the refinement.
    let host = Arc::new(Host::default());
    let ctx = context(Arc::new(Session::default()), PermissionMode::Default);
    let input =
        json!({"cron": "0 9 * * *", "prompt": "p", "title": "t", "recurring": false, "maxRuns": 0});
    assert!(matches!(
        tool(&host, "CronCreate").validate_input(&input, &ctx).await,
        Validation::Invalid { .. }
    ));
}

/// Node parses CronList and CronPauseSelf with `z.object({}).strict()`; here the pipeline's schema check refuses the
/// extra key before the tool runs (Node's executor checks the same JSON schema first too).
#[test]
fn list_and_pause_self_refuse_unknown_keys_at_the_schema() {
    let host = Arc::new(Host::default());
    for name in ["CronList", "CronPauseSelf"] {
        let tool = tool(&host, name);
        let message =
            crate::validate::validate(name, &tool.input_schema(), &json!({"includePaused": true}));
        assert!(message.is_some(), "{name}");
        assert!(
            crate::validate::validate(name, &tool.input_schema(), &json!({})).is_none(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn pause_self_pauses_only_the_turn_s_automation() {
    let host = Arc::new(Host::default());
    let ordinary = context(Arc::new(Session::default()), PermissionMode::Default);
    let message = failure(call(&tool(&host, "CronPauseSelf"), json!({}), ordinary).await);
    assert_eq!(
        message,
        "CronPauseSelf is only available while running a scheduled automation."
    );
    assert!(host.requests().is_empty());

    let host = Host::answering(vec![
        Ok(json!({"paused": true})),
        Ok(json!({"paused": false})),
    ]);
    let session = Arc::new(Session {
        limits: TurnLimits::new(Some("auto_7"), Vec::new()),
        ..Session::default()
    });
    let paused = call(
        &tool(&host, "CronPauseSelf"),
        json!({}),
        context(session.clone(), PermissionMode::Default),
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        paused,
        json!({"paused": true, "id": "auto_7",
            "message": "Paused automation auto_7. It will not run on schedule until the user resumes it."})
    );
    let not_active = call(
        &tool(&host, "CronPauseSelf"),
        json!({}),
        context(session, PermissionMode::Default),
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(not_active["paused"], false);
    assert_eq!(
        not_active["message"],
        "Automation auto_7 is not active (already paused, completed, failed, or deleted), so nothing changed."
    );
    assert_eq!(host.requests()[0].2, json!({"automationId": "auto_7"}));
}

#[tokio::test]
async fn list_update_and_delete_answer_node_s_shapes() {
    let host = Host::answering(vec![
        Ok(json!({"automations": [automation("a1", "One")]})),
        Ok(json!({"automation": automation("a1", "One every 6 minutes")})),
        Ok(json!({"deleted": true})),
        Ok(json!({"deleted": false})),
        Err(AutomationError {
            code: Some(-32603),
            message: "Automation not found".to_owned(),
        }),
    ]);
    let ctx = || context(Arc::new(Session::default()), PermissionMode::Default);
    let listed = call(&tool(&host, "CronList"), json!({}), ctx())
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(listed["automations"][0]["automationId"], "a1");
    assert!(listed["automations"][0].get("modelSelection").is_none());
    let updated = call(
        &tool(&host, "CronUpdate"),
        json!({"id": "a1", "title": "One every 6 minutes"}),
        ctx(),
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(updated["message"], "Updated automation a1.");
    let deleted = call(&tool(&host, "CronDelete"), json!({"id": "a1"}), ctx())
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        deleted,
        json!({"deleted": true, "id": "a1", "message": "Deleted automation a1."})
    );
    let missing = call(&tool(&host, "CronDelete"), json!({"id": "a2"}), ctx())
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        missing["message"],
        "Automation a2 was not found in the current workspace."
    );
    // A Host error is the tool's failure, with the Host's text.
    let message = failure(
        call(
            &tool(&host, "CronUpdate"),
            json!({"id": "zz", "title": "t"}),
            ctx(),
        )
        .await,
    );
    assert_eq!(message, "Automation not found");
}

/// A Host that answers every request after `delay`.
struct SlowHost {
    delay: std::time::Duration,
    requests: Mutex<Vec<String>>,
}

#[async_trait]
impl AutomationPort for SlowHost {
    async fn request(&self, _session: &SessionId, method: &str, _params: Value) -> Answer {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(method.to_owned());
        tokio::time::sleep(self.delay).await;
        Ok(json!({"bound": false}))
    }
}

#[tokio::test(start_paused = true)]
async fn the_binding_check_and_the_create_share_one_deadline() {
    // Each request fits in the 30 s budget, both together do not (Node times the whole handler).
    let host = Arc::new(SlowHost {
        delay: std::time::Duration::from_secs(20),
        requests: Mutex::default(),
    });
    let port: Arc<dyn AutomationPort> = host.clone();
    let create = automation_tools(port)
        .into_iter()
        .find(|tool| tool.name() == "CronCreate")
        .unwrap_or_else(|| panic!("CronCreate"));
    let session = Arc::new(Session::default());
    let input = json!({"cron": "0 9 * * *", "prompt": "check the build", "title": "Build"});
    let message = failure(
        call(
            &create,
            input,
            context(session.clone(), PermissionMode::Default),
        )
        .await,
    );
    assert!(
        message.contains("Tool execution timed out after 30000ms"),
        "{message}"
    );
    let sent = host
        .requests
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_eq!(sent, ["automation/checkTaskBinding", "automation/create"]);
    assert!(
        session
            .frozen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    );
}

#[tokio::test]
async fn a_mutation_without_the_session_view_fails_closed() {
    let session = Arc::new(Session {
        gone: true,
        ..Session::default()
    });
    for (name, input) in [
        (
            "CronCreate",
            json!({"cron": "0 9 * * *", "prompt": "check the build", "title": "Build"}),
        ),
        ("CronUpdate", json!({"id": "auto_1", "title": "Build"})),
        ("CronDelete", json!({"id": "auto_1"})),
    ] {
        let host = Host::answering(Vec::new());
        let message = failure(
            call(
                &tool(&host, name),
                input,
                context(session.clone(), PermissionMode::Default),
            )
            .await,
        );
        assert!(
            message.contains("Session state is unavailable."),
            "{name}: {message}"
        );
        assert!(host.requests().is_empty(), "{name}");
    }
    // Reads do not need the turn's limits.
    let host = Host::answering(vec![Ok(json!({"automations": []}))]);
    call(
        &tool(&host, "CronList"),
        json!({}),
        context(session, PermissionMode::Default),
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(host.methods(), ["automation/list"]);
}

#[test]
fn null_is_refused_where_node_s_schema_has_no_null() {
    let base = json!({"cron": "0 9 * * *", "prompt": "check the build", "title": "Build"});
    for field in ["cron", "recurring", "maxRuns", "intervalUnit", "interval"] {
        let mut input = base.clone();
        input[field] = Value::Null;
        assert!(create_input(&input).is_err(), "create {field}");
    }
    let mut relative = base;
    relative["delayMinutes"] = Value::Null;
    assert!(
        create_input(&relative).is_ok(),
        "create delayMinutes: null is absent"
    );
    for field in ["cron", "prompt", "recurring", "intervalUnit", "interval"] {
        let mut input = json!({"id": "auto_1", "title": "Build"});
        input[field] = Value::Null;
        assert!(update_input(&input).is_err(), "update {field}");
    }
    assert!(
        update_input(
            &json!({"id": "auto_1", "title": "Build", "recurring": true, "maxRuns": null})
        )
        .is_ok()
    );
}
