//! Fork: app-provided tools of an MCP App page (specs/fork-rust-node-helper.md F3b(b)). The overlay is the helper's
//! `helper/appTools/replace` set; a call goes to the host and its answer maps like an MCP tool's.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::app_tool::{AppToolHost, AppToolSpec};
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::tool::{PromptContext, Tool, ToolError, ToolUseContext};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::app_provided_tools;

/// Records what it was asked; answers with `answer`, or waits for the cancel when `hang` is set.
#[derive(Default)]
struct Host {
    specs: Vec<AppToolSpec>,
    answer: Option<Value>,
    hang: bool,
    calls: Mutex<Vec<(String, String, String, Value)>>,
    cancels: Mutex<Vec<String>>,
}

#[async_trait]
impl AppToolHost for Host {
    fn app_tools(&self, _session: &SessionId) -> Vec<AppToolSpec> {
        self.specs.clone()
    }

    async fn call(
        &self,
        _session: &SessionId,
        turn: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String> {
        self.calls.lock().unwrap().push((
            turn.to_owned(),
            tool_call.to_owned(),
            name.to_owned(),
            input,
        ));
        if self.hang {
            std::future::pending::<()>().await;
        }
        Ok(self
            .answer
            .clone()
            .unwrap_or_else(|| json!({"content": [{"type": "text", "text": "done"}]})))
    }

    async fn cancel(&self, _session: &SessionId, tool_call: &str) {
        self.cancels.lock().unwrap().push(tool_call.to_owned());
    }
}

fn spec(model: &str) -> AppToolSpec {
    AppToolSpec {
        model_name: model.to_owned(),
        server_name: "calc".to_owned(),
        plugin_id: "calc".to_owned(),
        tool_name: "pick".to_owned(),
        title: Some("Pick".to_owned()),
        description: Some("Chooses one".to_owned()),
        input_schema: json!({"properties": {"x": {"type": "number"}}}),
        read_only: true,
        destructive: false,
        idempotent: false,
    }
}

fn context(cancel: CancellationToken) -> ToolUseContext {
    ToolUseContext {
        session: SessionId::new("s1"),
        tool_use: ToolUseId::new("toolu_7"),
        cancel,
        ..rust_cli_kernel_api::testing::tool_use_context()
    }
}

fn host(specs: Vec<AppToolSpec>) -> Arc<Host> {
    Arc::new(Host {
        specs,
        ..Host::default()
    })
}

fn one(host: &Arc<Host>) -> Arc<dyn Tool> {
    let host: Arc<dyn AppToolHost> = host.clone();
    app_provided_tools(&host, &SessionId::new("s1"))
        .into_iter()
        .next()
        .expect("one tool")
}

#[test]
fn the_overlay_of_the_session_is_the_hosts_set() {
    let host = host(vec![spec("app__calc__pick")]);
    let host_dyn: Arc<dyn AppToolHost> = host;
    let names: Vec<String> = app_provided_tools(&host_dyn, &SessionId::new("s1"))
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(names, vec!["app__calc__pick".to_owned()]);
}

#[test]
fn the_tool_is_named_and_described_as_node_describes_it() {
    let tool = one(&host(vec![spec("app__calc__pick")]));
    assert_eq!(tool.name(), "app__calc__pick");
    let prompt = PromptContext {
        tool_names: Vec::new(),
        mode: PermissionMode::Default,
    };
    let text = tool.description(&prompt);
    assert!(text.starts_with("Pick\n\nChooses one"), "{text}");
    assert!(
        text.ends_with(
            "(Tool provided by the calc app page; available only while the app is open.)"
        ),
        "{text}"
    );
}

#[test]
fn the_tool_offers_the_session_allow_and_reads_its_hints() {
    let mut read_write = spec("app__calc__save");
    read_write.read_only = false;
    read_write.destructive = true;
    let tool = one(&host(vec![read_write]));
    assert!(tool.allow_session());
    assert!(!tool.is_read_only(&json!({})));
    assert!(tool.is_destructive(&json!({})));
    assert!(
        !tool.should_defer(),
        "an app tool is listed directly, as Node lists it"
    );
}

#[test]
fn the_schema_is_an_object_schema_with_its_properties() {
    let tool = one(&host(vec![spec("app__calc__pick")]));
    let schema = tool.input_schema();
    assert_eq!(schema["type"], json!("object"));
    assert_eq!(schema["properties"]["x"]["type"], json!("number"));
}

#[tokio::test]
async fn an_answer_maps_to_the_tool_output_and_the_call_names_run_and_tool_use() {
    let host = host(vec![spec("app__calc__pick")]);
    let tool = one(&host);
    let (tx, _rx) = mpsc::channel(8);
    let output = tool
        .call(json!({"x": 2}), context(CancellationToken::new()), tx)
        .await
        .expect("answered");
    assert!(!output.is_error);
    assert!(matches!(
        output.content.as_slice(),
        [ToolResultContent::Text { text }] if text == "done"
    ));
    let calls = host.calls.lock().unwrap().clone();
    assert_eq!(
        calls,
        vec![(
            "run_1".to_owned(),
            "toolu_7".to_owned(),
            "app__calc__pick".to_owned(),
            json!({"x": 2}),
        )]
    );
}

#[tokio::test]
async fn an_error_answer_is_an_error_output() {
    let mut answered = host(vec![spec("app__calc__pick")]);
    Arc::get_mut(&mut answered).unwrap().answer =
        Some(json!({"content": [{"type": "text", "text": "nope"}], "isError": true}));
    let tool = one(&answered);
    let (tx, _rx) = mpsc::channel(8);
    let output = tool
        .call(json!({}), context(CancellationToken::new()), tx)
        .await
        .expect("answered");
    assert!(output.is_error);
}

#[tokio::test]
async fn a_cancelled_call_tells_the_helper_and_returns_cancelled() {
    let mut waiting = host(vec![spec("app__calc__pick")]);
    Arc::get_mut(&mut waiting).unwrap().hang = true;
    let tool = one(&waiting);
    let cancel = CancellationToken::new();
    let (tx, _rx) = mpsc::channel(8);
    let call = {
        let cancel = cancel.clone();
        tokio::spawn(async move { tool.call(json!({}), context(cancel), tx).await })
    };
    while waiting.calls.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    let result = call.await.expect("joined");
    assert!(matches!(result, Err(ToolError::Cancelled)), "{result:?}");
    assert_eq!(*waiting.cancels.lock().unwrap(), vec!["toolu_7".to_owned()]);
}
