//! Fork: AskUserQuestion and ExitPlanMode asks as `userInput` pending interactions, like Node's
//! `createPendingInteractionFromPermissionEvent` (bootstrap `zcode-protocol-v4/product-projection.ts`;
//! specs/fork-rust-agent-parity.md). The App shows them in its elicitation dialog and answers with
//! `resolveInteraction { action, content }`; [`question_answer`] and [`plan_answer`] map that back to the kernel
//! answers the way Node's interaction broker does.

use std::collections::BTreeMap;

use rust_cli_kernel_api::orchestration::{
    McpElicitationAnswer, PlanApprovalAnswer, QuestionAnnotation, QuestionAnswer,
};
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

/// Node's `MCP_ELICITATION_TOOL_NAME`: the tool name of the synthesized ask, which the projection and the App key on.
pub const MCP_ELICITATION_TOOL_NAME: &str = "McpElicitation";
/// Node's `MCP_ELICITATION_INTERACTION`: `schema.interaction` of an MCP elicitation's pending interaction.
pub const MCP_ELICITATION_INTERACTION: &str = "mcp_elicitation";
/// Node's `MCP_ELICITATION_FREE_TEXT_OPTION`: the value of the "Type your answer" option of a question.
pub const MCP_ELICITATION_FREE_TEXT_OPTION: &str = "__zcode_free_text__";

/// The supported kinds of a form field (Node's `McpElicitationSchemaField.type`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum FieldKind {
    String,
    Number,
    Integer,
    Boolean,
    Enum,
}

/// One form field of a requested schema, in the schema's own order.
struct Field {
    name: String,
    kind: FieldKind,
    title: Option<String>,
    description: Option<String>,
    enum_values: Vec<String>,
    enum_names: Vec<String>,
}

/// Node's `readMcpElicitationFields`: the properties of a flat schema whose type is a primitive or an enum of strings;
/// any other property is left out.
fn mcp_fields(schema: &Value) -> Vec<Field> {
    let Some(properties) = schema["properties"].as_object() else {
        return Vec::new();
    };
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    properties
        .iter()
        .filter_map(|(name, raw)| {
            let raw = raw.as_object()?;
            let is_enum = raw.get("enum").is_some_and(Value::is_array);
            let kind = if is_enum {
                FieldKind::Enum
            } else {
                match raw.get("type").and_then(Value::as_str)? {
                    "number" => FieldKind::Number,
                    "integer" => FieldKind::Integer,
                    "boolean" => FieldKind::Boolean,
                    "string" => FieldKind::String,
                    _ => return None,
                }
            };
            Some(Field {
                name: name.clone(),
                kind,
                title: raw.get("title").and_then(Value::as_str).map(str::to_owned),
                description: raw
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                enum_values: raw.get("enum").map(strings).unwrap_or_default(),
                enum_names: raw.get("enumNames").map(strings).unwrap_or_default(),
            })
        })
        .collect()
}

fn free_text_option() -> Value {
    json!({"value": MCP_ELICITATION_FREE_TEXT_OPTION, "label": "Type your answer"})
}

/// Node's `mcpElicitationQuestions`: one question per field (a boolean is Yes/No, an enum its values, anything else
/// free text). A schema without fields asks the message itself, under the header "Answer".
fn mcp_questions(message: &str, schema: &Value) -> Vec<Value> {
    let fields = mcp_fields(schema);
    if fields.is_empty() {
        return vec![json!({
            "header": "Answer",
            "question": message,
            "options": [free_text_option()],
        })];
    }
    fields
        .iter()
        .map(|field| {
            let header = field.title.clone().unwrap_or_else(|| field.name.clone());
            let question = field
                .description
                .clone()
                .unwrap_or_else(|| format!("{message}\n\n{header}"));
            let options = match field.kind {
                FieldKind::Boolean => vec![
                    json!({"value": "true", "label": "Yes"}),
                    json!({"value": "false", "label": "No"}),
                ],
                FieldKind::Enum if !field.enum_values.is_empty() => field
                    .enum_values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        let label = field.enum_names.get(index).unwrap_or(value);
                        json!({"value": value, "label": label})
                    })
                    .collect(),
                _ => vec![free_text_option()],
            };
            json!({"header": header, "question": question, "options": options})
        })
        .collect()
}

/// Fork: an MCP elicitation's `userInput` pending interaction, like Node's `createPendingInteractionFromPermissionEvent`
/// MCP branch: the questions come from the requested schema, and the App answers them with `resolveInteraction`.
pub fn mcp_elicitation(
    interaction: &str,
    anchor: Option<u64>,
    now: u64,
    tool_use: &str,
    server: &str,
    message: &str,
    schema: &Value,
) -> Value {
    let payload = json!({
        "prompt": message,
        "toolName": MCP_ELICITATION_TOOL_NAME,
        "input": {"serverName": server, "message": message, "requestedSchema": schema},
        "schema": {
            "interaction": MCP_ELICITATION_INTERACTION,
            "serverName": server,
            "requestedSchema": schema,
        },
        "questions": mcp_questions(message, schema),
    });
    user_input(interaction, anchor, now, tool_use, payload)
}

/// The answer under `content` for field `index`: `answer_<index>`, else the answer by question text, else (the first
/// field only) the legacy `answer`. A keyed `answers` object decides alone, as in Node.
fn read_answer<'a>(
    content: &'a Map<String, Value>,
    index: usize,
    question: &str,
) -> Option<&'a Value> {
    if let Some(value) = content.get(&format!("answer_{index}")) {
        return Some(value);
    }
    if let Some(answers) = content.get("answers").and_then(Value::as_object) {
        return answers.get(question);
    }
    if index == 0 {
        return content.get("answer");
    }
    None
}

/// The text of an answer, a string or the first string of a list.
fn first_string(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text),
        Value::Array(items) => items.first().and_then(Value::as_str),
        _ => None,
    }
}

/// One answer converted to its field's type; `None` leaves the field out (Node: a number that does not parse).
fn typed_value(field: &Field, raw: &str) -> Option<Value> {
    match field.kind {
        FieldKind::Boolean => Some(json!(raw == "true" || raw.to_lowercase() == "yes")),
        FieldKind::Number | FieldKind::Integer => {
            let parsed: f64 = raw.trim().parse().ok()?;
            if !parsed.is_finite() {
                return None;
            }
            Some(match field.kind {
                FieldKind::Integer => json!(parsed.trunc() as i64),
                _ => json!(parsed),
            })
        }
        FieldKind::String | FieldKind::Enum => Some(json!(raw)),
    }
}

/// Fork: the App's answer to an MCP elicitation as the kernel answer (Node's `requestMcpElicitation` mapping).
/// `decline` and `cancel` pass through. `accept`, or no action with content or free text, maps the answers to the MCP
/// content by the schema (`mcpElicitationContentFromAnswers`): a field without a usable answer is left out, and the
/// free-text sentinel is no answer. Free text counts as the `answer` key. No action, no content and no text declines.
pub fn mcp_answer(
    message: &str,
    schema: &Value,
    action: Option<&str>,
    content: Option<&Map<String, Value>>,
    free_text: Option<&str>,
) -> McpElicitationAnswer {
    let free = free_text.map(str::trim).filter(|text| !text.is_empty());
    match action {
        Some("decline") | Some("cancel") => {
            return if action == Some("cancel") {
                McpElicitationAnswer::Cancel
            } else {
                McpElicitationAnswer::Decline
            };
        }
        Some("accept") => {}
        Some(_) => return McpElicitationAnswer::Decline,
        None if content.is_none() && free.is_none() => return McpElicitationAnswer::Decline,
        None => {}
    }
    mcp_accepted(message, schema, content, free)
}

/// The accept branch of [`mcp_answer`]: `content` (or the free text as `answer`) converted by the schema.
fn mcp_accepted(
    message: &str,
    schema: &Value,
    content: Option<&Map<String, Value>>,
    free: Option<&str>,
) -> McpElicitationAnswer {
    let free_content;
    let answers = match content {
        Some(content) => Some(content),
        None => {
            free_content = free.map(|text| {
                let mut map = Map::new();
                map.insert("answer".to_owned(), json!(text));
                map
            });
            free_content.as_ref()
        }
    };
    let mut result = Map::new();
    let questions = mcp_questions(message, schema);
    if let Some(answers) = answers {
        for (index, field) in mcp_fields(schema).iter().enumerate() {
            let question = questions[index]["question"].as_str().unwrap_or_default();
            let Some(raw) = read_answer(answers, index, question).and_then(first_string) else {
                continue;
            };
            if raw == MCP_ELICITATION_FREE_TEXT_OPTION {
                continue;
            }
            if let Some(value) = typed_value(field, raw) {
                result.insert(field.name.clone(), value);
            }
        }
        if mcp_fields(schema).is_empty() {
            let question = questions[0]["question"].as_str().unwrap_or_default();
            if let Some(raw) = read_answer(answers, 0, question).and_then(first_string)
                && raw != MCP_ELICITATION_FREE_TEXT_OPTION
            {
                result.insert("answer".to_owned(), json!(raw));
            }
        }
    }
    McpElicitationAnswer::Accept { content: result }
}

#[cfg(test)]
#[path = "elicitation_tests.rs"]
mod tests;
