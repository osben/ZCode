//! The `LSP` tool's query path through the fake pool (specs/fork-rust-lsp.md "Tool (D2)", acceptance 4).

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rust_cli_kernel_api::lsp::{LspOperation, LspOutput, LspQuery, LspResultStatus};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{Harness, harness_with, publish};
use crate::lsp::runtime::LspError;
use crate::lsp::runtime::documents::Disk;
use crate::lsp::runtime::documents::tests::MemoryDisk;

const SOURCE: &str = "import { use } from './b';\nconst user = use();\n";

fn harness() -> Harness {
    let disk = Arc::new(MemoryDisk::default());
    disk.put("/w/a.ts", SOURCE, 1);
    harness_with(disk as Arc<dyn Disk>)
}

fn query(operation: LspOperation) -> LspQuery {
    LspQuery {
        operation,
        file_path: "/w/a.ts".to_owned(),
        line: None,
        character: None,
        symbol: None,
        query: None,
        include_declaration: None,
    }
}

fn at_symbol(operation: LspOperation, line: f64, symbol: &str) -> LspQuery {
    LspQuery {
        line: Some(line),
        symbol: Some(symbol.to_owned()),
        ..query(operation)
    }
}

async fn run(harness: &Harness, query: LspQuery) -> Result<LspOutput, LspError> {
    harness
        .session
        .query(&query, &CancellationToken::new())
        .await
}

/// Runs the query in the background while the test plays the server.
fn spawn(
    harness: &Harness,
    query: LspQuery,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<Result<LspOutput, LspError>> {
    let session = Arc::clone(&harness.session);
    tokio::spawn(async move { session.query(&query, &cancel).await })
}

#[tokio::test(start_paused = true)]
async fn a_disabled_runtime_answers_before_anything_starts() {
    let mut harness = harness();
    harness.preferences.lock().unwrap().enabled = false;
    let error = run(&harness, query(LspOperation::Diagnostics))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        ("lsp_disabled", "Code intelligence is turned off")
    );
    assert!(harness.launched.try_recv().is_err(), "nothing was launched");
}

#[tokio::test(start_paused = true)]
async fn a_file_without_a_server_names_the_operation() {
    let harness = harness();
    let error = run(
        &harness,
        LspQuery {
            file_path: "/w/README.md".to_owned(),
            ..query(LspOperation::DocumentSymbol)
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (
            "lsp_no_server_for_file",
            "No language server is configured for documentSymbol on this file type"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn a_missing_command_is_reported_before_an_acquire() {
    let mut harness = harness();
    harness.probe.0.store(false, Ordering::Relaxed);
    let error = run(&harness, query(LspOperation::Diagnostics))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (
            "lsp_server_not_installed",
            "Language server p/ts is not installed on this machine"
        )
    );
    assert!(harness.launched.try_recv().is_err(), "nothing was launched");
}

#[tokio::test(start_paused = true)]
async fn a_starting_server_answers_retry_shortly() {
    let mut harness = harness();
    let error = run(
        &harness,
        at_symbol(LspOperation::GoToDefinition, 2.0, "use"),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (
            "lsp_server_starting",
            "Language server p/ts is starting; retry shortly; use Grep meanwhile"
        )
    );
    assert!(
        harness.launched.recv().await.is_some(),
        "the query started it"
    );
}

#[tokio::test(start_paused = true)]
async fn a_missing_capability_is_unsupported() {
    let mut harness = harness();
    let _process = harness.start_with(json!({"hoverProvider": false})).await;
    let error = run(&harness, at_symbol(LspOperation::Hover, 2.0, "use"))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (
            "lsp_operation_unsupported",
            "Language server p/ts does not support hover"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn definition_opens_the_file_resolves_the_symbol_and_projects_the_answer() {
    let mut harness = harness();
    let mut process = harness.start_with(json!({"definitionProvider": {}})).await;
    let answer = spawn(
        &harness,
        at_symbol(LspOperation::GoToDefinition, 2.0, "use"),
        CancellationToken::new(),
    );
    let open = process.expect("textDocument/didOpen").await;
    assert_eq!(open["params"]["textDocument"]["text"], SOURCE);
    let request = process.expect("textDocument/definition").await;
    assert_eq!(
        request["params"],
        json!({"textDocument": {"uri": "file:///w/a.ts"}, "position": {"line": 1, "character": 13}})
    );
    process
        .reply(
            &request,
            json!({"uri": "file:///w/a.ts", "range": {"start": {"line": 0, "character": 9}, "end": {"line": 0, "character": 12}}}),
        )
        .await;
    let output = answer.await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&output).unwrap(),
        json!({
            "operation": "goToDefinition",
            "server": "p/ts",
            "status": "ok",
            "locations": [{"path": "a.ts", "line": 1, "character": 10, "endLine": 1, "endCharacter": 13, "preview": "import { use } from './b';"}],
            "truncated": false,
            "total": 1,
        })
    );
    assert_eq!(output.model_text(), "a.ts:1:10  import { use } from './b';");
}

#[tokio::test(start_paused = true)]
async fn references_send_include_declaration() {
    let mut harness = harness();
    let mut process = harness
        .start_with(json!({"referencesProvider": true}))
        .await;
    let answer = spawn(
        &harness,
        LspQuery {
            line: Some(2.0),
            character: Some(14.0),
            include_declaration: Some(true),
            ..query(LspOperation::FindReferences)
        },
        CancellationToken::new(),
    );
    let request = process.expect("textDocument/references").await;
    assert_eq!(
        request["params"]["context"],
        json!({"includeDeclaration": true})
    );
    assert_eq!(
        request["params"]["position"],
        json!({"line": 1, "character": 13})
    );
    process.reply(&request, Value::Null).await;
    assert_eq!(answer.await.unwrap().unwrap().model_text(), "No results");
}

#[tokio::test(start_paused = true)]
async fn a_symbol_missing_from_the_synced_line_fails_after_the_open() {
    let mut harness = harness();
    let mut process = harness
        .start_with(json!({"definitionProvider": true}))
        .await;
    let answer = spawn(
        &harness,
        at_symbol(LspOperation::GoToDefinition, 2.0, "nothing"),
        CancellationToken::new(),
    );
    process.expect("textDocument/didOpen").await;
    let error = answer.await.unwrap().unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (
            "lsp_symbol_not_found_on_line",
            "Symbol \"nothing\" does not occur as a whole word on line 2"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn workspace_symbol_opens_nothing() {
    let mut harness = harness();
    let mut process = harness
        .start_with(json!({"workspaceSymbolProvider": true}))
        .await;
    let answer = spawn(
        &harness,
        LspQuery {
            query: Some("use".to_owned()),
            ..query(LspOperation::WorkspaceSymbol)
        },
        CancellationToken::new(),
    );
    let request = loop {
        let message = process.next().await;
        let method = message.get("method").and_then(Value::as_str);
        assert_ne!(method, Some("textDocument/didOpen"));
        if method == Some("workspace/symbol") {
            break message;
        }
    };
    assert_eq!(request["params"], json!({"query": "use"}));
    process
        .reply(
            &request,
            json!([{"name": "use", "kind": 12, "location": {"uri": "file:///w/b.ts", "range": {"start": {"line": 0, "character": 16}, "end": {"line": 0, "character": 19}}}}]),
        )
        .await;
    assert_eq!(
        answer.await.unwrap().unwrap().model_text(),
        "function use  b.ts:1"
    );
}

#[tokio::test(start_paused = true)]
async fn diagnostics_without_a_fresh_result_are_pending() {
    let mut harness = harness();
    let mut process = harness.start().await;
    let answer = spawn(
        &harness,
        query(LspOperation::Diagnostics),
        CancellationToken::new(),
    );
    process.expect("textDocument/didOpen").await;
    let output = answer.await.unwrap().unwrap();
    assert_eq!(output.status, LspResultStatus::Pending);
    assert_eq!(output.diagnostics.as_deref(), Some(&[][..]));
    assert_eq!(
        output.model_text(),
        "Diagnostics pending: the language server has not reported fresh results for this file yet. This is not the same as no errors."
    );
}

#[tokio::test(start_paused = true)]
async fn diagnostics_with_a_fresh_result_keep_errors_and_warnings() {
    let mut harness = harness();
    let mut process = harness.start().await;
    let answer = spawn(
        &harness,
        query(LspOperation::Diagnostics),
        CancellationToken::new(),
    );
    process.expect("textDocument/didOpen").await;
    let hint = json!({
        "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
        "severity": 4,
        "message": "hint",
    });
    let error = json!({
        "range": {"start": {"line": 1, "character": 6}, "end": {"line": 1, "character": 10}},
        "severity": 1,
        "message": "bad",
        "source": "ts",
        "code": 2322,
    });
    publish(&mut process, "/w/a.ts", vec![hint, error]).await;
    let output = answer.await.unwrap().unwrap();
    assert_eq!(output.status, LspResultStatus::Ok);
    assert_eq!(output.model_text(), "a.ts:2:7 error bad [ts 2322]");
    assert_eq!(output.total, Some(1));
}

#[tokio::test(start_paused = true)]
async fn cancelling_the_call_cancels_the_request() {
    let mut harness = harness();
    let mut process = harness
        .start_with(json!({"definitionProvider": true}))
        .await;
    let cancel = CancellationToken::new();
    let answer = spawn(
        &harness,
        at_symbol(LspOperation::GoToDefinition, 2.0, "use"),
        cancel.clone(),
    );
    let request = process.expect("textDocument/definition").await;
    cancel.cancel();
    let cancelled = process.expect("$/cancelRequest").await;
    assert_eq!(cancelled["params"]["id"], request["id"]);
    assert_eq!(answer.await.unwrap().unwrap_err().code, "lsp_cancelled");
}

/// Node's request flow (`runLspQuery` over a fake port, generated by `pnpm rust-agent:lsp-tool:update`): the order of
/// its checks, each error, whether the file is opened, the request sent and the answer's text.
#[tokio::test(start_paused = true)]
async fn the_request_flow_matches_node() {
    let goldens: Value = serde_json::from_str(rust_cli_base::include_lf!(
        "../fixtures/lsp_tool_goldens.json"
    ))
    .unwrap();
    let flow = &goldens["flow"];
    assert_eq!(flow["source"], SOURCE, "the harness serves Node's file");
    let cases = flow["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 9);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let number = |key: &str| input.get(key).and_then(Value::as_f64);
        let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
        let query = LspQuery {
            operation: serde_json::from_value(case["operation"].clone()).unwrap(),
            file_path: text("filePath").unwrap(),
            line: number("line"),
            character: number("character"),
            symbol: text("symbol"),
            query: text("query"),
            include_declaration: input.get("includeDeclaration").and_then(Value::as_bool),
        };
        let mut harness = harness();
        if case.get("installed") == Some(&Value::Bool(false)) {
            harness.probe.0.store(false, Ordering::Relaxed);
        }
        let mut process = match case.get("state").and_then(Value::as_str) {
            Some("starting") => None,
            _ if case.get("capabilities").is_some() => {
                Some(harness.start_with(case["capabilities"].clone()).await)
            }
            _ => None,
        };
        let answer = spawn(&harness, query, CancellationToken::new());
        let mut opened = false;
        if let (Some(process), Some(request)) = (process.as_mut(), case.get("request")) {
            let method = request["method"].as_str().unwrap();
            let sent = loop {
                let message = process.next().await;
                match message.get("method").and_then(Value::as_str) {
                    Some("textDocument/didOpen") => opened = true,
                    Some(other) if other == method => break message,
                    _ => {}
                }
            };
            assert_eq!(sent["params"], request["params"], "{name}");
            process.reply(&sent, case["raw"].clone()).await;
        }
        let result = answer.await.unwrap();
        if case.get("request").is_none()
            && let Some(process) = process.as_mut()
        {
            // Without a request to wait for, a didOpen is either on the wire already or never sent.
            let open = process.expect("textDocument/didOpen");
            opened = tokio::time::timeout(std::time::Duration::from_secs(1), open)
                .await
                .is_ok();
        }
        assert_eq!(opened, case["opened"].as_bool().unwrap(), "{name}: opened");
        match case.get("error").and_then(Value::as_str) {
            Some(error) => {
                let failure = result.unwrap_err();
                assert_eq!(
                    (failure.code, failure.message.as_str()),
                    (case["errorCode"].as_str().unwrap(), error),
                    "{name}"
                );
            }
            None => {
                let output = result.unwrap();
                assert_eq!(
                    serde_json::to_value(&output).unwrap(),
                    case["output"],
                    "{name}"
                );
                assert_eq!(
                    output.model_text(),
                    case["text"].as_str().unwrap(),
                    "{name}"
                );
            }
        }
    }
}
