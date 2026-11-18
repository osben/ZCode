//! Parity with Node's driver rules (W6a, specs/fork-rust-workflow-engine.md section 9.7). The fixture is
//! written by `scripts/rust-cli/workflow-driver-goldens.ts`, which calls Node's own functions from
//! `bootstrap/src/app/workflow-driver-helpers.ts` and `workflow-actor-permission.ts`.
use crate::driver_rules::{
    self as rules, ESCALATION_BUDGET_EXHAUSTED, MAX_ESCALATIONS_PER_ASK, NUDGE_PROMPT,
    SubagentPermissionMode, TYPED_TOOL_EPILOGUE,
};
use crate::engine::SubmitVerdict;
use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/driver-goldens.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("driver-goldens.json parses")
}

fn cases(name: &str) -> Vec<Value> {
    fixture()[name]
        .as_array()
        .unwrap_or_else(|| panic!("fixture section {name} is an array"))
        .clone()
}

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}

fn mode_text(mode: Option<SubagentPermissionMode>) -> Value {
    match mode {
        Some(mode) => Value::String(mode.as_str().into()),
        None => Value::Null,
    }
}

#[test]
fn actor_session_ids_are_node_ids() {
    for case in cases("mintActorSessionId") {
        let run_id = text(&case["runId"]).unwrap();
        let site = text(&case["actor"]["siteId"]).unwrap();
        let ordinal = case["actor"]["ordinal"].as_f64().unwrap();
        assert_eq!(
            rules::mint_actor_session_id(run_id, site, ordinal),
            text(&case["id"]).unwrap(),
            "runId {run_id:?}, actor {site:?}"
        );
    }
}

#[test]
fn question_id_fragments_are_node_fragments() {
    for case in cases("questionIdFragments") {
        let run_id = text(&case["runId"]).unwrap();
        let expected: Vec<&str> = case["fragments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| text(f).unwrap())
            .collect();
        assert_eq!(
            rules::question_id_fragments(run_id),
            expected,
            "runId {run_id:?}"
        );
    }
}

#[test]
fn prompts_and_budget_constants_are_node_text() {
    let constants = &fixture()["constants"];
    assert_eq!(NUDGE_PROMPT, text(&constants["nudgePrompt"]).unwrap());
    assert_eq!(
        TYPED_TOOL_EPILOGUE,
        text(&constants["typedToolEpilogue"]).unwrap()
    );
    assert_eq!(
        ESCALATION_BUDGET_EXHAUSTED,
        text(&constants["escalationBudgetExhausted"]).unwrap()
    );
    assert_eq!(
        MAX_ESCALATIONS_PER_ASK as u64,
        constants["maxEscalationsPerAsk"].as_u64().unwrap()
    );
}

#[test]
fn schema_epilogue_is_node_text_for_every_schema_shape() {
    for case in cases("schemaEpilogue") {
        let name = text(&case["name"]).unwrap();
        let schema = if case["absent"].as_bool().unwrap() {
            None
        } else {
            Some(&case["schema"])
        };
        assert_eq!(
            rules::schema_epilogue(schema),
            text(&case["text"]).unwrap(),
            "schema case {name}"
        );
    }
}

#[test]
fn escalation_context_and_actor_name_normalise_as_node_does() {
    for case in cases("normalizeEscalationContext") {
        let input = text(&case["input"]);
        assert_eq!(
            rules::normalize_escalation_context(input),
            text(&case["output"]).map(str::to_owned),
            "context {input:?}"
        );
    }
    for case in cases("effectiveActorName") {
        let name = text(&case["name"]);
        assert_eq!(
            rules::effective_actor_name(name),
            text(&case["output"]),
            "name {name:?}"
        );
    }
    for case in cases("subagentLabel") {
        let key = format!(
            "{}@{}",
            text(&case["actor"]["siteId"]).unwrap(),
            case["actor"]["ordinal"].as_u64().unwrap()
        );
        let actor_name = text(&case["actorName"]);
        assert_eq!(
            rules::subagent_label(actor_name, &key),
            text(&case["output"]).unwrap(),
            "label {actor_name:?}"
        );
    }
}

#[test]
fn reject_with_builds_the_node_binary_rejection() {
    for case in cases("rejectWith") {
        let message = text(&case["message"]).unwrap();
        let SubmitVerdict::Reject { violations } = rules::reject_with(message) else {
            panic!("rejectWith must reject");
        };
        assert_eq!(violations.len(), 1);
        let expected = &case["verdict"]["violations"][0];
        assert_eq!(violations[0].path, text(&expected["path"]).unwrap());
        assert_eq!(violations[0].expected, text(&expected["expected"]).unwrap());
        assert_eq!(violations[0].got, text(&expected["got"]).unwrap());
    }
}

#[test]
fn permission_mode_rules_match_node() {
    let permission = &fixture()["permissionMode"];
    for case in permission["subagentPermissionModeOf"].as_array().unwrap() {
        let input = text(&case["input"]);
        assert_eq!(
            mode_text(rules::subagent_permission_mode_of(input)),
            case["output"],
            "mode of {input:?}"
        );
    }
    for case in permission["parse"].as_array().unwrap() {
        let raw = match &case["input"] {
            Value::Null => None,
            other => Some(other),
        };
        assert_eq!(
            mode_text(rules::parse_subagent_permission_mode(raw)),
            case["output"],
            "parse {raw:?}"
        );
    }
    for case in permission["policy"].as_array().unwrap() {
        let mode = rules::subagent_permission_mode_of(text(&case["input"]));
        assert_eq!(
            Value::String(rules::actor_permission_policy(mode).as_str().into()),
            case["output"],
            "policy of {mode:?}"
        );
    }
    for case in permission["interactionDescription"].as_array().unwrap() {
        let name = text(&case["name"]);
        let site = text(&case["actor"]["siteId"]).unwrap();
        let ordinal = case["actor"]["ordinal"].as_u64().unwrap();
        assert_eq!(
            rules::actor_interaction_description(site, ordinal, name),
            text(&case["output"]).unwrap(),
            "description of {name:?}"
        );
    }
}
