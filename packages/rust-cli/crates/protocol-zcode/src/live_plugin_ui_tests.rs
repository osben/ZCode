//! Fork (specs/fork-rust-plugin-ui-tool-result.md, rules 6 to 8): the live session sends `v4/plugin-ui/tool-result` once
//! for a successful MCP UI tool result, before the conversation frame of that result, and never for anything else.

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{SessionId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_kernel_api::tool::ToolOutput;
use rust_cli_protocol_core::connection::{self, Options};
use rust_cli_protocol_core::sessions::SessionSink;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use super::launch_tests::{Handle, event, view};
use super::*;
use crate::wire::Purpose;

const METHOD: &str = "v4/plugin-ui/tool-result";

async fn open() -> (Live, tokio::io::DuplexStream, TaskScope) {
    let scope = TaskScope::root("test", |_| {});
    let (out, reader) = tokio::io::duplex(1 << 20);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let topics = Arc::new(Topics::new(context.clone(), &scope.spawner()));
    let live = Live::new(
        context,
        topics,
        Arc::new(Handle {
            id: SessionId::new("s1"),
        }),
        &view(),
        Followup::Queue,
        Arc::from(Vec::new()),
        Restored::default(),
    );
    live.subscribe("sub-1", "conn-1");
    live.start("sub-1", Purpose::Online).await;
    (live, reader, scope)
}

fn ui_display() -> Value {
    json!({"kind": "mcp_tool", "serverName": "viewer", "toolName": "open",
           "ui": {"pluginId": "viewer@market", "resourceUri": "ui://viewer/editor.html"}})
}

fn output(display: Value, is_error: bool) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text {
            text: "opened".into(),
        }],
        is_error,
        display,
    }
}

async fn start_tool(live: &Live, seq: u64, tool: &str) {
    live.event(event(
        seq,
        KernelEvent::ToolStarted {
            tool_use: ToolUseId::new(tool),
            name: "mcp__viewer__open".into(),
            input: json!({"file": "a.md"}),
        },
    ))
    .await;
}

async fn finish_tool(live: &Live, seq: u64, tool: &str, output: ToolOutput) {
    live.event(event(
        seq,
        KernelEvent::ToolDone {
            tool_use: ToolUseId::new(tool),
            output,
        },
    ))
    .await;
}

async fn run_tool(live: &Live, seq: u64, tool: &str, output: ToolOutput) {
    start_tool(live, seq, tool).await;
    finish_tool(live, seq + 1, tool, output).await;
    live.flush().await;
}

async fn wire(mut reader: tokio::io::DuplexStream) -> String {
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        reader.read_to_end(&mut bytes),
    )
    .await;
    // A frame's payload may sit inside a string: compare on the unescaped text.
    String::from_utf8_lossy(&bytes).replace("\\\"", "\"")
}

async fn turn(live: &Live) {
    live.event(event(
        1,
        KernelEvent::TurnStarted {
            turn: TurnId::new("turn_1"),
            command: None,
        },
    ))
    .await;
}

#[tokio::test]
async fn a_successful_ui_result_is_sent_once_before_its_frame() {
    let (live, reader, _scope) = open().await;
    turn(&live).await;
    run_tool(&live, 2, "toolu_1", output(ui_display(), false)).await;
    let text = wire(reader).await;
    assert_eq!(text.matches(METHOD).count(), 1, "{text}");
    let note = text.find(METHOD).unwrap();
    let params = &text[note..];
    assert!(params.contains("\"toolCallId\":\"toolu_1\""), "{text}");
    assert!(params.contains("\"serverName\":\"viewer\""), "{text}");
    assert!(params.contains("\"input\":{\"file\":\"a.md\"}"), "{text}");
    // Node sends it at ingest, before the flush that carries the row update.
    let frame = text.find("\"status\":\"success\"").expect("the row frame");
    assert!(note < frame, "the notification precedes the frame: {text}");
}

#[tokio::test]
async fn an_error_a_tool_without_ui_and_an_is_error_result_send_nothing() {
    let (live, reader, _scope) = open().await;
    turn(&live).await;
    run_tool(&live, 2, "toolu_1", output(ui_display(), true)).await;
    let mut errored = ui_display();
    errored["ui"]["isError"] = json!(true);
    run_tool(&live, 4, "toolu_2", output(errored, false)).await;
    let plain = json!({"kind": "mcp_tool", "serverName": "viewer", "toolName": "open"});
    run_tool(&live, 6, "toolu_3", output(plain, false)).await;
    let text = wire(reader).await;
    assert!(!text.contains(METHOD), "{text}");
}

#[tokio::test]
async fn a_replayed_event_and_a_rebuild_send_nothing() {
    let (live, reader, _scope) = open().await;
    turn(&live).await;
    live.state().skip_through = 10;
    run_tool(&live, 2, "toolu_1", output(ui_display(), false)).await;
    live.event(event(11, KernelEvent::HistoryRewritten { generation: 1 }))
        .await;
    live.flush().await;
    let text = wire(reader).await;
    assert!(!text.contains(METHOD), "{text}");
}

#[tokio::test]
async fn two_results_go_out_in_event_order() {
    let (live, reader, _scope) = open().await;
    turn(&live).await;
    start_tool(&live, 2, "toolu_1").await;
    finish_tool(&live, 3, "toolu_1", output(ui_display(), false)).await;
    start_tool(&live, 4, "toolu_2").await;
    finish_tool(&live, 5, "toolu_2", output(ui_display(), false)).await;
    live.flush().await;
    let text = wire(reader).await;
    assert_eq!(text.matches(METHOD).count(), 2, "{text}");
    let first = text.find("\"toolCallId\":\"toolu_1\"").unwrap();
    let second = text.find("\"toolCallId\":\"toolu_2\"").unwrap();
    assert!(first < second, "{text}");
}
