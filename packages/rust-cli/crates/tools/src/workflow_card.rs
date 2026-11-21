//! Fork (9.61): the `create_workflow` result card (Node `createCreateWorkflowDisplay`, core
//! `tool/executor/create-workflow-display.ts`). CreateWorkflow and AmendWorkflow answer with it on every path that
//! compiled a script, clean or not, so the desktop draws the draft row, the diagnostics card and the run card's graph
//! from one shape. Node's field set is frozen and the desktop parses it strictly (`toolCallCreateWorkflowDisplaySchema`):
//! a key outside it drops the whole card, so run facts never travel here.

use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use serde_json::{Map, Value, json};

/// Node `CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS`.
pub(crate) const MAX_DIAGNOSTICS: usize = 100;
/// Node `CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS`, in UTF-16 units as JavaScript's `slice` counts them.
pub(crate) const MAX_MESSAGE_UNITS: usize = 2048;

/// The card: `kind`, `ok`, the full error count, at most [`MAX_DIAGNOSTICS`] diagnostics with bounded messages,
/// `truncated` when some were left out, and the script's causality graph when the analyzer drew one.
pub(crate) fn card(graph: Option<&Value>, ok: bool, diagnostics: &[WorkflowDiagnostic]) -> Value {
    card_with_fill(graph, ok, diagnostics, None)
}

/// [`card`] with Node's `fill` block (`{siteId, name, draftPath?, line?}`), which FillWorkflowHole adds so the desktop's
/// fill row names the hole it filled.
pub(crate) fn card_with_fill(
    graph: Option<&Value>,
    ok: bool,
    diagnostics: &[WorkflowDiagnostic],
    fill: Option<&Value>,
) -> Value {
    let bounded: Vec<Value> = diagnostics
        .iter()
        .take(MAX_DIAGNOSTICS)
        .map(|diagnostic| {
            json!({
                "line": diagnostic.line,
                "column": diagnostic.column,
                "code": diagnostic.code,
                "message": cut_units(&diagnostic.message, MAX_MESSAGE_UNITS),
            })
        })
        .collect();
    let truncated = diagnostics.len() > bounded.len();
    let mut card = Map::new();
    card.insert("kind".to_owned(), json!("create_workflow"));
    card.insert("ok".to_owned(), json!(ok));
    card.insert("errorCount".to_owned(), json!(diagnostics.len()));
    card.insert("diagnostics".to_owned(), Value::Array(bounded));
    if let Some(graph) = graph.filter(|graph| !graph.is_null()) {
        card.insert("causalityGraph".to_owned(), graph.clone());
    }
    if truncated {
        card.insert("truncated".to_owned(), json!(true));
    }
    if let Some(fill) = fill {
        card.insert("fill".to_owned(), fill.clone());
    }
    Value::Object(card)
}

/// The longest prefix of `text` within `limit` UTF-16 units. JavaScript's `slice` may split a surrogate pair; a Rust
/// string cannot hold half of one, so a pair across the limit is left out whole.
fn cut_units(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > limit {
            return &text[..index];
        }
    }
    text
}

#[cfg(test)]
#[path = "workflow_card_tests.rs"]
mod tests;
