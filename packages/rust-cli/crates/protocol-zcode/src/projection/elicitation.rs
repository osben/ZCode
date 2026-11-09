//! Fork: AskUserQuestion and ExitPlanMode asks as `userInput` pending interactions, like Node's
//! `createPendingInteractionFromPermissionEvent` (bootstrap `zcode-protocol-v4/product-projection.ts`;
//! specs/fork-rust-agent-parity.md). The App shows them in its elicitation dialog and answers with
//! `resolveInteraction { action, content }`; [`question_answer`] and [`plan_answer`] map that back to the kernel
//! answers the way Node's interaction broker does.

use std::collections::BTreeMap;

use rust_cli_kernel_api::orchestration::{PlanApprovalAnswer, QuestionAnnotation, QuestionAnswer};
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::{Map, Value, json};

/// Node's `EXIT_PLAN_MODE_APPROVAL_QUESTION`: the plan approval question text, also the answer key.
pub const PLAN_QUESTION: &str = "Review this implementation plan.";
const PLAN_APPROVE: &str = "approve";
const ASK_USER_QUESTION: &str = "AskUserQuestion";
const EXIT_PLAN_MODE: &str = "ExitPlanMode";

fn non_empty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn option_of(value: &Value) -> Option<Value> {
    let label = non_empty(&value["label"]).or_else(|| non_empty(&value["value"]))?;
    let mut option = json!({"value": non_empty(&value["value"]).unwrap_or(label), "label": label});
    for field in ["description", "preview"] {
        if let Some(text) = value[field].as_str() {
            option[field] = json!(text);
        }
    }
    Some(option)
}

fn question_of(value: &Value) -> Option<Value> {
    let text = non_empty(&value["question"])?;
    let header = non_empty(&value["header"]).unwrap_or(text);
    let options: Vec<Value> = value["options"]
        .as_array()
        .map(|options| options.iter().filter_map(option_of).collect())
        .unwrap_or_default();
    if options.is_empty() {
        return None;
    }
    let mut question = json!({"question": text, "header": header, "options": options});
    if value["multiSelect"] == true {
        question["multiSelect"] = json!(true);
    }
    Some(question)
}

/// The raw questions: the tool's `questions` array, or a single question object.
fn raw_questions(questions: &Value) -> Vec<&Value> {
    match questions {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) if questions["question"].is_string() => vec![questions],
        _ => Vec::new(),
    }
}

/// Node's `readAskUserQuestionPayloadQuestions`: questions without text or options are dropped.
fn payload_questions(questions: &Value) -> Vec<Value> {
    raw_questions(questions)
        .into_iter()
        .filter_map(question_of)
        .collect()
}

fn question_texts(questions: &Value) -> Vec<String> {
    raw_questions(questions)
        .into_iter()
        .filter_map(|question| question["question"].as_str().map(str::to_owned))
        .collect()
}

/// A `userInput` pending interaction; `payload` holds the fields that differ between questions and plans.
fn user_input(
    interaction: &str,
    anchor: Option<u64>,
    now: u64,
    tool_use: &str,
    payload: Value,
) -> Value {
    let mut payload = payload;
    payload["kind"] = json!("userInput");
    payload["freeText"] = json!(true);
    payload["toolCallId"] = json!(tool_use);
    json!({
        "interactionId": interaction,
        "kind": "userInput",
        "anchorRowId": anchor,
        "createdAt": now,
        "payload": payload,
    })
}

pub(super) fn question(
    interaction: &str,
    anchor: Option<u64>,
    now: u64,
    tool_use: &str,
    questions: &Value,
) -> Value {
    let payload = json!({
        "prompt": "",
        "toolName": ASK_USER_QUESTION,
        "input": {"questions": questions},
        "schema": {"toolName": ASK_USER_QUESTION},
        "questions": payload_questions(questions),
    });
    user_input(interaction, anchor, now, tool_use, payload)
}

pub(super) fn plan_approval(
    interaction: &str,
    anchor: Option<u64>,
    now: u64,
    tool_use: &str,
    plan: &str,
) -> Value {
    let approve = json!({
        "value": PLAN_APPROVE,
        "label": "Approve",
        "description": "Exit plan mode and start implementation.",
    });
    let payload = json!({
        "prompt": PLAN_QUESTION,
        "toolName": EXIT_PLAN_MODE,
        "input": {"plan": plan},
        "schema": {"interaction": "plan_approval", "toolName": EXIT_PLAN_MODE},
        "questions": [{"question": PLAN_QUESTION, "header": "Plan", "options": [approve]}],
    });
    user_input(interaction, anchor, now, tool_use, payload)
}

/// Node's `normalizeAnswerValue`: trimmed text, a multi-select joined with `, `; blank is no answer.
fn answer_value(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.trim().to_owned(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim))
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn annotations(value: &Value) -> BTreeMap<String, QuestionAnnotation> {
    let Some(entries) = value.as_object() else {
        return BTreeMap::new();
    };
    entries
        .iter()
        .filter_map(|(question, annotation)| {
            let preview = annotation["preview"].as_str().map(str::to_owned);
            let notes = annotation["notes"].as_str().map(str::to_owned);
            (preview.is_some() || notes.is_some())
                .then(|| (question.clone(), QuestionAnnotation { preview, notes }))
        })
        .collect()
}

/// Only `accept` answers; `decline`, `cancel` and an answer without content decline (Node's broker).
fn accepted<'a>(
    action: Option<&str>,
    content: Option<&'a Map<String, Value>>,
) -> Option<&'a Map<String, Value>> {
    match action {
        Some("accept") | None => content,
        Some(_) => None,
    }
}

/// Node's `normalizeAskUserQuestionResponseContent`: answers by question text, else the legacy `answer_<i>` (and
/// `answer` for a single question).
pub fn question_answer(
    questions: &Value,
    action: Option<&str>,
    content: Option<&Map<String, Value>>,
) -> QuestionAnswer {
    let Some(content) = accepted(action, content) else {
        return QuestionAnswer::Declined;
    };
    let texts = question_texts(questions);
    let by_text = content.get("answers").and_then(Value::as_object);
    let answers = texts
        .iter()
        .enumerate()
        .filter_map(|(index, text)| {
            let raw = by_text
                .and_then(|answers| answers.get(text))
                .or_else(|| content.get(&format!("answer_{index}")))
                .or_else(|| (texts.len() == 1).then(|| content.get("answer")).flatten())?;
            answer_value(raw).map(|answer| (text.clone(), answer))
        })
        .collect();
    QuestionAnswer::Answered {
        answers,
        annotations: content
            .get("annotations")
            .map(annotations)
            .unwrap_or_default(),
        response: None,
        follow_up: false,
        afk_timeout_ms: None,
    }
}

/// Node's `planApprovalResponseToBrokerResult`: `approve` approves, other text is feedback, nothing keeps planning.
pub fn plan_answer(
    action: Option<&str>,
    content: Option<&Map<String, Value>>,
    free_text: Option<&str>,
    mode: PermissionMode,
) -> PlanApprovalAnswer {
    let keep = |feedback: Option<String>| PlanApprovalAnswer::KeepPlanning { feedback };
    let Some(content) = accepted(action, content) else {
        return keep(
            free_text
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        );
    };
    let answers = content.get("answers").and_then(Value::as_object);
    let raw = answers
        .and_then(|answers| {
            answers
                .get(PLAN_QUESTION)
                .or_else(|| answers.values().next())
        })
        .or_else(|| content.get("answer_0"))
        .or_else(|| content.get("answer"));
    match raw.and_then(answer_value) {
        Some(answer) if answer == PLAN_APPROVE => PlanApprovalAnswer::Approve { mode },
        Some(feedback) => keep(Some(feedback)),
        None => keep(None),
    }
}

#[cfg(test)]
#[path = "elicitation_tests.rs"]
mod tests;
