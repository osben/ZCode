use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use serde_json::json;

use super::{MAX_DIAGNOSTICS, MAX_MESSAGE_UNITS, card};

fn diagnostic(line: i64, message: &str) -> WorkflowDiagnostic {
    WorkflowDiagnostic {
        code: 9005,
        line,
        column: 3,
        message: message.to_owned(),
    }
}

#[test]
fn a_failing_script_is_a_bounded_create_workflow_card() {
    let long = "é".repeat(MAX_MESSAGE_UNITS + 5);
    let mut diagnostics: Vec<WorkflowDiagnostic> = (1..=MAX_DIAGNOSTICS as i64 + 2)
        .map(|line| diagnostic(line, "x"))
        .collect();
    diagnostics[0] = diagnostic(1, &long);
    let card = card(None, false, &diagnostics);
    assert_eq!(card["kind"], "create_workflow");
    assert_eq!(card["ok"], false);
    assert_eq!(card["errorCount"], json!(MAX_DIAGNOSTICS + 2));
    assert_eq!(card["truncated"], true);
    assert_eq!(
        card["diagnostics"].as_array().unwrap().len(),
        MAX_DIAGNOSTICS
    );
    assert_eq!(
        card["diagnostics"][0],
        json!({"line": 1, "column": 3, "code": 9005, "message": "é".repeat(MAX_MESSAGE_UNITS)})
    );
}

#[test]
fn a_clean_script_keeps_its_graph_and_has_no_truncation_flag() {
    let graph = json!({"steps": []});
    let card = card(Some(&graph), true, &[]);
    assert_eq!(
        card,
        json!({"kind": "create_workflow", "ok": true, "errorCount": 0, "diagnostics": [], "causalityGraph": {"steps": []}})
    );
}
