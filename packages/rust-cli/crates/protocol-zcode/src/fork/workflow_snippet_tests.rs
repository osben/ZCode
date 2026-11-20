//! The snippet runner's mapping of the helper's answers (specs/fork-rust-workflow-engine.md, 9.28). The launch itself is
//! covered by `workflow_runner_tests` (the same `launch_compiled`); these tests pin what the snippet port sees.

use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_snippet::{SnippetCheck, WorkflowSnippetError};
use rust_cli_protocol_core::rpc::RpcError;

use super::*;

#[test]
fn a_clean_check_reports_ready_with_the_world_run_flag() {
    let compiled = Ok(SnippetCompiled::Ready {
        world_run: true,
        entry_source: "export const payload = {};\n".to_owned(),
    });
    assert_eq!(
        check_of(compiled).unwrap(),
        SnippetCheck::Ready { world_run: true }
    );
}

#[test]
fn a_check_with_diagnostics_reports_them_without_a_start() {
    let diagnostic = WorkflowDiagnostic {
        code: 2304,
        line: 1,
        column: 1,
        message: "Cannot find name 'agent'.".to_owned(),
    };
    let compiled = Ok(SnippetCompiled::Rejected {
        diagnostics: vec![diagnostic.clone()],
    });
    assert_eq!(
        check_of(compiled).unwrap(),
        SnippetCheck::Diagnostics(vec![diagnostic])
    );
}

#[test]
fn a_helper_failure_is_a_snippet_error_that_names_the_compile_helper() {
    let error = check_of(Err(RpcError::internal("the helper is down"))).expect_err("a failed call");
    assert_eq!(
        error,
        WorkflowSnippetError {
            message: "the compile helper failed: the helper is down".to_owned(),
        }
    );
}
