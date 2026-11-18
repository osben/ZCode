//! Parity with Node's driver rules (W6a, specs/fork-rust-workflow-engine.md section 9.7). The fixture is
//! written by `scripts/rust-cli/workflow-driver-goldens.ts`, which calls Node's own functions from
//! `bootstrap/src/app/workflow-driver-helpers.ts` and `workflow-actor-permission.ts`.
use crate::driver_rules::SubmitProfile;
use crate::driver_rules::{
    self as rules, ESCALATION_BUDGET_EXHAUSTED, MAX_ESCALATIONS_PER_ASK, NUDGE_PROMPT,
    SubagentPermissionMode, TYPED_TOOL_EPILOGUE,
};
use crate::engine::SubmitVerdict;
use serde_json::{Value, json};

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

// Node `qualityEpilogue` (workflow-ask-epilogue.ts) and the typed ask's input (workflow-driver.ts, the input composition).
const STANDARD_LINES: [&str; 6] = [
    "- Every finding cites what you read or ran: path and line for code; the exact command and its output for a check; the part of the ask for material the ask itself gave you.",
    "- A check counts as passed only if you ran it during this ask. Otherwise report it as not run.",
    "- Run the check the ask names, at the scale it names. A narrower or faster substitute — one test file for the suite, a build for the tests — is reported as what it is, never as the ask's check; say the exact command you ran.",
    "- Anything you could not do, verify, or find is stated as such — never filled with a plausible guess.",
    "- Put each finding's citation in its `evidence` field.",
    "- If you are blocked by something outside your reach, call `escalate` instead of inventing a value.",
];

#[test]
fn quality_epilogue_is_node_text_without_optional_fields() {
    let expected = [
        "",
        "",
        "---",
        "Standard for this result:",
        STANDARD_LINES[0],
        STANDARD_LINES[1],
        STANDARD_LINES[2],
        STANDARD_LINES[3],
        STANDARD_LINES[5],
    ]
    .join("\n");
    assert_eq!(rules::quality_epilogue(None), expected);
}

#[test]
fn quality_epilogue_names_evidence_and_confidence_when_the_schema_has_them() {
    let schema = json!({"properties": {"evidence": {}, "confidence": {}}});
    let text = rules::quality_epilogue(Some(&schema));
    let confidence =
        "- Rate `confidence` honestly; a low value with a reason beats a confident guess.";
    let positions: Vec<usize> = [
        STANDARD_LINES[3],
        STANDARD_LINES[4],
        confidence,
        STANDARD_LINES[5],
    ]
    .iter()
    .map(|line| text.find(line).unwrap_or_else(|| panic!("missing {line}")))
    .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "Node's order: unverified, evidence, confidence, escalate"
    );
}

#[test]
fn quality_epilogue_reads_only_top_level_properties() {
    let schema = json!({"properties": {"x": {"properties": {"evidence": {}}}}});
    assert!(!rules::quality_epilogue(Some(&schema)).contains("`evidence`"));
}

#[test]
fn an_untyped_ask_input_is_the_instructions_then_the_quality_epilogue() {
    let (input, boundary) = rules::ask_input("do it", false, None, &SubmitProfile::Generic);
    assert_eq!(input, format!("do it{}", rules::quality_epilogue(None)));
    assert_eq!(boundary, 5);
}

#[test]
fn a_typed_generic_ask_input_appends_the_schema_epilogue_after_the_quality_one() {
    let schema = json!({"type": "object"});
    let (input, boundary) = rules::ask_input("do it", true, Some(&schema), &SubmitProfile::Generic);
    assert_eq!(
        input,
        format!(
            "do it{}{}",
            rules::quality_epilogue(Some(&schema)),
            rules::schema_epilogue(Some(&schema))
        )
    );
    assert_eq!(boundary, 5);
}

#[test]
fn a_typed_mono_ask_input_appends_the_tool_epilogue() {
    let schema = json!({"type": "object"});
    let profile = SubmitProfile::Mono {
        schema: schema.clone(),
    };
    let (input, _) = rules::ask_input("do it", true, Some(&schema), &profile);
    assert_eq!(
        input,
        format!(
            "do it{}{}",
            rules::quality_epilogue(Some(&schema)),
            TYPED_TOOL_EPILOGUE
        )
    );
}

#[test]
fn the_boundary_counts_utf16_units_as_node_does() {
    // Node's `instructions.length` counts UTF-16 code units: "é🙂 go" is 1 + 2 + 3 = 6, and 9 UTF-8 bytes.
    let (_, boundary) = rules::ask_input("é🙂 go", false, None, &SubmitProfile::Generic);
    assert_eq!(boundary, 6);
}
