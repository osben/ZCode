//! The pure rules of the actor driver (W6a, specs/fork-rust-workflow-engine.md section 9.7). Node's sources:
//! `bootstrap/src/app/workflow-driver-helpers.ts` (prompts, epilogues, escalation budget and fragments),
//! `workflow-driver-submit-profile.ts` and `workflow-driver-submit-bridge.ts` (the submit route),
//! `workflow-actor-permission.ts` (the permission origin and the recorded mode), and
//! `dynamic-workflow-run-launch.ts` (the session title and the task-link path).
//!
//! No state and no I/O here. The actor runtime calls these functions; the engine stays the single writer.
//! Goldens: `fixtures/driver-goldens.json` (`driver_golden_tests.rs`).
use crate::canon::canonical_json;
use crate::engine::SubmitVerdict;
use crate::model::Violation;
use rust_cli_base::js::json::{js_double, write_str};
use rust_cli_base::js::string::trim;
use serde_json::{Map, Value};

pub use rust_cli_node_store::{mint_actor_session_id, sanitize_id_segment};

/// Node `NUDGE_PROMPT`: the fresh turn that asks for a submit when the last turn ended without one.
pub const NUDGE_PROMPT: &str = "You ended your turn without submitting a result. Call the submit_result tool now with a payload conforming to the required schema.";

/// Node `MAX_ESCALATIONS_PER_ASK`. Exceeding it is an ordinary result, not an error.
pub const MAX_ESCALATIONS_PER_ASK: u32 = 3;

/// Node `ESCALATION_BUDGET_EXHAUSTED`, built with `MAX_ESCALATIONS_PER_ASK` as 3.
pub const ESCALATION_BUDGET_EXHAUSTED: &str = concat!(
    "Escalation budget exhausted: at most 3 escalations per task. ",
    "Do not call escalate again. Proceed on your best judgement with the information you have, ",
    "and state in your final result the assumptions you relied on and the doubts that remain.",
);

/// Node `TYPED_TOOL_EPILOGUE` (the mono subagent form; the schema is already in the tool declaration).
pub const TYPED_TOOL_EPILOGUE: &str = "\n\n---\nWhen you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool's declared schema — pass the conforming JSON directly, do not wrap it or add commentary.";

/// Node `SubmitVerdict` rejection text for an ask that does not accept submit_result (submit bridge, untyped).
pub const UNTYPED_ASK_MESSAGE: &str =
    "this ask does not accept submit_result; provide your answer as your final message";

/// Node submit bridge text when a submit arrives with no ask in flight.
pub const NO_ACTIVE_ASK_MESSAGE: &str = "no active ask is awaiting a submitted result";

/// Node `schemaEpilogue`. `None` is an absent schema (`undefined`); `Some(Value::Null)` is `null`.
pub fn schema_epilogue(schema: Option<&Value>) -> String {
    let rendered = match schema {
        None => "(any JSON value)".to_owned(),
        Some(value) => json_pretty(value),
    };
    [
        "",
        "",
        "---",
        "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:",
        "",
        &rendered,
        "",
        "Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.",
    ]
    .join("\n")
}

/// `JSON.stringify(value, null, 2)`: two-space indentation, `[]` and `{}` for empty containers, keys in
/// insertion order, numbers in the JavaScript number form (a JSON number is read as a double, as JS does).
pub fn json_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(&mut out, value, 0);
    out
}

fn write_pretty(out: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&js_double(number.as_f64().unwrap_or(f64::NAN))),
        Value::String(text) => write_str(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(",\n");
                }
                push_indent(out, depth + 1);
                write_pretty(out, item, depth + 1);
            }
            out.push('\n');
            push_indent(out, depth);
            out.push(']');
        }
        Value::Object(map) => write_pretty_object(out, map, depth),
    }
}

fn write_pretty_object(out: &mut String, map: &Map<String, Value>, depth: usize) {
    if map.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push_str("{\n");
    for (index, (key, item)) in map.iter().enumerate() {
        if index > 0 {
            out.push_str(",\n");
        }
        push_indent(out, depth + 1);
        write_str(out, key);
        out.push_str(": ");
        write_pretty(out, item, depth + 1);
    }
    out.push('\n');
    push_indent(out, depth);
    out.push('}');
}

fn push_indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// Node `mintActorSessionId` is `mint_actor_session_id` (re-exported from node-store, the replay's own id).
/// The question-id fragments (Node `questionIdFragments`): the run id without its `dwfrun-` prefix, sanitised,
/// as the candidates 8 characters, 16 characters, and the whole segment, in that order, without repeats.
pub fn question_id_fragments(run_id: &str) -> Vec<String> {
    let body = run_id.strip_prefix("dwfrun-").unwrap_or(run_id);
    // The sanitised form is ASCII, so byte slicing equals the UTF-16 slicing Node does.
    let full = sanitize_id_segment(body);
    let mut candidates: Vec<String> = Vec::new();
    for length in [8, 16] {
        let cut = full.len().min(length);
        candidates.push(full[..cut].to_owned());
    }
    candidates.push(full);
    let mut unique: Vec<String> = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

/// Node `normalizeEscalationContext`: whitespace (JavaScript `trim`) means absent.
pub fn normalize_escalation_context(context: Option<&str>) -> Option<String> {
    let trimmed = trim(context?);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Node `effectiveActorName`: a non-empty persona name, untrimmed. An empty string is anonymous.
pub fn effective_actor_name(name: Option<&str>) -> Option<&str> {
    name.filter(|text| !text.is_empty())
}

/// Node `subagentLabel`: the actor's name when it has one (`??`, so an empty name still wins), else the
/// `site@ordinal` key.
pub fn subagent_label(actor_name: Option<&str>, actor_key: &str) -> String {
    actor_name.unwrap_or(actor_key).to_owned()
}

/// Node `rejectWith`: a binary rejection that the model reads as its tool result.
pub fn reject_with(message: &str) -> SubmitVerdict {
    SubmitVerdict::Reject {
        violations: vec![Violation {
            path: "$".into(),
            expected: message.into(),
            got: "submit_result call".into(),
        }],
    }
}

/// The route of a submit that arrived at the submit port (Node `makeSessionSubmitPort`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitRoute {
    /// No ask is in flight for the session. Rejected at the port; the engine is not told.
    NoActiveAsk,
    /// The ask is untyped. Rejected at the port; the engine is not told (it would hang the deferred).
    UntypedAsk,
    /// Report to the engine and wait for its verdict.
    Engine,
}

pub fn submit_route(has_active_ask: bool, ask_is_typed: bool) -> SubmitRoute {
    if !has_active_ask {
        SubmitRoute::NoActiveAsk
    } else if !ask_is_typed {
        SubmitRoute::UntypedAsk
    } else {
        SubmitRoute::Engine
    }
}

/// The static submit profile of a subagent session (Node `SubmitProfile`).
#[derive(Debug, Clone, PartialEq)]
pub enum SubmitProfile {
    /// The generic `submit_result`, which takes any schema.
    Generic,
    /// One schema, registered for this session. Its canonical form is the comparison key.
    Mono { schema: Value },
    /// No `submit_result` is registered.
    Untyped,
}

/// What a typed ask does with the session's profile (Node `ensureSubmitProfileFits`).
#[derive(Debug, Clone, PartialEq)]
pub enum ProfileFit {
    /// The session serves this ask as it is.
    Fits,
    /// The analysis missed the schema. The session falls back to the generic declaration; the ask continues.
    FallBackToGeneric,
    /// The ask cannot be served. It fails with a `DriverError` naming the ask and the session.
    Fail { message: String },
}

pub fn profile_fit(
    profile: &SubmitProfile,
    ask_schema: &Value,
    instance_key: &str,
    session_id: &str,
) -> ProfileFit {
    match profile {
        SubmitProfile::Generic => ProfileFit::Fits,
        SubmitProfile::Mono { schema } if canonical_json(schema) == canonical_json(ask_schema) => {
            ProfileFit::Fits
        }
        SubmitProfile::Mono { .. } => ProfileFit::FallBackToGeneric,
        SubmitProfile::Untyped => ProfileFit::Fail {
            message: format!(
                "Typed ask {instance_key} reached subagent session {session_id} whose static submit profile is \"untyped\" (no submit_result registered): the ask→actor analysis missed this ask."
            ),
        },
    }
}

/// Declares the enum and its name table from one list, so `ALL` and `as_str` cannot disagree with the variants: a
/// variant added here is in `ALL` and parses, or it does not compile.
macro_rules! subagent_permission_modes {
    ($($variant:ident = $name:literal),+ $(,)?) => {
        /// The permission mode a dynamic-workflow run records for its subagents (Node `WorkflowSubagentPermissionMode`,
        /// `CollaborationMode` without `plan`).
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum SubagentPermissionMode {
            $($variant),+
        }

        impl SubagentPermissionMode {
            /// Every recordable mode, generated from the same list as the variants.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $name),+
                }
            }

            fn parse(text: &str) -> Option<Self> {
                match text {
                    $($name => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

subagent_permission_modes! {
    Build = "build",
    Edit = "edit",
    Yolo = "yolo",
    Guarded = "guarded",
    Auto = "auto",
}

/// Node `workflowSubagentPermissionModeOf`: the session's base mode, with `plan` read as `build`.
/// A mode outside the collaboration set has no Rust form and reads as absent (TypeScript cannot pass one).
pub fn subagent_permission_mode_of(session_mode: Option<&str>) -> Option<SubagentPermissionMode> {
    match session_mode? {
        "plan" => Some(SubagentPermissionMode::Build),
        other => SubagentPermissionMode::parse(other),
    }
}

/// Node `parseWorkflowSubagentPermissionMode`: only the recordable values survive a read. Anything else is absent,
/// which the policy reads as YOLO, the rule for every run before the mode was recorded.
pub fn parse_subagent_permission_mode(raw: Option<&Value>) -> Option<SubagentPermissionMode> {
    raw.and_then(Value::as_str)
        .and_then(SubagentPermissionMode::parse)
}

/// Node `workflowActorPermissionPolicy`: the recorded mode, or YOLO when none is recorded.
pub fn actor_permission_policy(mode: Option<SubagentPermissionMode>) -> SubagentPermissionMode {
    mode.unwrap_or(SubagentPermissionMode::Yolo)
}

/// Node `workflowActorInteractionDescription`: `<persona name ?? "subagent"> (<site>@<ordinal>)`. The `??`
/// keeps an empty persona name, so an empty name gives a leading space, as Node does.
pub fn actor_interaction_description(site_id: &str, ordinal: u64, name: Option<&str>) -> String {
    format!("{} ({site_id}@{ordinal})", name.unwrap_or("subagent"))
}

/// Node `createActorSession` title (`dynamic-workflow-run-launch.ts`): `workflow subagent <site>@<ordinal>`.
pub fn actor_session_title(site_id: &str, ordinal: u64) -> String {
    format!("workflow subagent {site_id}@{ordinal}")
}

/// Node `persistActorSession` task-link path: `dwf/<runId>/<site>@<ordinal>`. The link role is `workflow_actor`.
pub fn actor_task_link_path(run_id: &str, site_id: &str, ordinal: u64) -> String {
    format!("dwf/{run_id}/{site_id}@{ordinal}")
}

/// Node `session_task_link.role` for an actor session (`workflow_agent` is the legacy workflow child).
pub const WORKFLOW_ACTOR_LINK_ROLE: &str = "workflow_actor";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pretty_json_matches_js_stringify_for_empty_and_nested_containers() {
        assert_eq!(json_pretty(&json!({})), "{}");
        assert_eq!(json_pretty(&json!([])), "[]");
        assert_eq!(
            json_pretty(&json!({"a": [], "b": {}})),
            "{\n  \"a\": [],\n  \"b\": {}\n}"
        );
        assert_eq!(json_pretty(&json!([1, [2]])), "[\n  1,\n  [\n    2\n  ]\n]");
    }

    #[test]
    fn a_missing_mono_schema_is_a_fallback_not_a_failure() {
        let fit = profile_fit(
            &SubmitProfile::Mono {
                schema: json!({"type": "number"}),
            },
            &json!({"type": "string"}),
            "a@1",
            "sess_x",
        );
        assert_eq!(fit, ProfileFit::FallBackToGeneric);
    }

    #[test]
    fn the_submit_route_checks_the_active_ask_before_the_typed_flag() {
        assert_eq!(submit_route(false, false), SubmitRoute::NoActiveAsk);
        assert_eq!(submit_route(true, false), SubmitRoute::UntypedAsk);
        assert_eq!(submit_route(true, true), SubmitRoute::Engine);
    }

    #[test]
    fn session_title_and_link_path_follow_the_launch_formats() {
        assert_eq!(
            actor_session_title("plan#1", 2),
            "workflow subagent plan#1@2"
        );
        assert_eq!(
            actor_task_link_path("dwfrun-abc", "plan#1", 2),
            "dwf/dwfrun-abc/plan#1@2"
        );
    }
}
