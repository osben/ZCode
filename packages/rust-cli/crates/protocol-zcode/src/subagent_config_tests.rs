//! The Host's subagent snapshot (specs/fork-rust-subagent-runtime-config.md, rules 1, 2 and 8): the gate, the read
//! request, the reply's validation and its mapping.
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::subagent_config::{
    ProfileSource, SubagentConfigSource, SubagentProfile, SubagentSnapshot,
};
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::*;

const SESSION: &str = "sess_root";
const WORKSPACE: &str = "/Users/dev/repo";

struct Nothing;

#[async_trait::async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

/// The Host double: reads the agent's reverse requests; the test decides the replies.
struct Host {
    write: DuplexStream,
    lines: Lines<BufReader<DuplexStream>>,
}

impl Host {
    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("the agent sent a request")
            .unwrap()
            .expect("the connection is open");
        serde_json::from_str(&line).unwrap()
    }

    async fn answer(&mut self, request: &Value, result: Value) {
        let reply = json!({"id": request["id"], "result": result});
        self.write
            .write_all(format!("{reply}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn fail(&mut self, request: &Value, code: i64) {
        let reply = json!({"id": request["id"], "error": {"code": code, "message": "no"}});
        self.write
            .write_all(format!("{reply}\n").as_bytes())
            .await
            .unwrap();
    }

    /// Answer the gate with the flag on and return the read request that follows.
    async fn open_gate(&mut self) -> Value {
        let gate = self.next().await;
        assert_eq!(gate["method"], PREFERENCES);
        self.answer(&gate, preferences(Some(true))).await;
        let read = self.next().await;
        assert_eq!(read["method"], READ);
        read
    }
}

fn preferences(enabled: Option<bool>) -> Value {
    let mut result = json!({"nativeSearchEnhancementsEnabled": false});
    if let Some(enabled) = enabled {
        result["subagentRuntimeConfigEnabled"] = json!(enabled);
    }
    result
}

fn connect() -> (Arc<HostSubagentConfig>, Host, TaskScope) {
    let scope = TaskScope::root("test", |_| {});
    let (host_out, agent_in) = duplex(1 << 20);
    let (agent_out, host_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    drop(scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(agent_in),
            peer.clone(),
            Arc::new(Nothing),
            scope.spawner(),
            Options::default(),
        ),
    ));
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(1))));
    context.register(SESSION, WORKSPACE);
    let source = Arc::new(HostSubagentConfig::with_limit(
        context,
        Duration::from_millis(500),
    ));
    let host = Host {
        write: host_out,
        lines: BufReader::new(host_in).lines(),
    };
    (source, host, scope)
}

fn reading(
    source: &Arc<HostSubagentConfig>,
) -> tokio::task::JoinHandle<Result<Option<SubagentSnapshot>, String>> {
    let source = source.clone();
    tokio::spawn(async move { source.read(&SessionId::new(SESSION)).await })
}

fn workspace() -> Value {
    json!({"workspacePath": WORKSPACE, "workspaceKey": WORKSPACE})
}

/// Rules 1 and 2: the gate asks once with the root session, the scope and the workspace; the read carries the root
/// session and the workspace; a `ready` reply maps to the snapshot with full selections.
#[tokio::test]
async fn an_open_gate_reads_and_maps_the_ready_snapshot() {
    let (source, mut host, _scope) = connect();
    let asking = reading(&source);
    let gate = host.next().await;
    assert_eq!(gate["method"], PREFERENCES);
    assert_eq!(
        gate["params"],
        json!({"sessionId": SESSION, "scope": "runtime-materialization", "workspace": workspace()})
    );
    host.answer(&gate, preferences(Some(true))).await;
    let read = host.next().await;
    assert_eq!(read["method"], READ);
    assert_eq!(
        read["params"],
        json!({"sessionId": SESSION, "workspace": workspace()})
    );
    host.answer(
        &read,
        json!({
            "kind": "ready",
            "profiles": [
                {
                    "name": "reviewer",
                    "description": "Reviews.",
                    "source": "user",
                    "systemPrompt": "You review.",
                    "path": "/Users/dev/.zcode/agents/reviewer.md",
                    "color": "red",
                    "modelSelection": {"providerId": "custom-openai", "modelId": "gpt-x",
                        "options": {"reasoningLevel": "high"}},
                    "background": true,
                    "permissionMode": "acceptEdits",
                    "maxTurns": 3,
                    "tools": ["Read"],
                    "disallowedTools": ["Bash"],
                    "skills": ["s"],
                },
                {"name": "plain", "description": "", "source": "project", "systemPrompt": ""},
            ],
            "builtInModelSelectionOverrides": {
                "Explore": {"providerId": "zai", "modelId": "glm-5.3"},
            },
            "pluginAgentModelSelectionOverrides": {
                "plugin:kit@market:review": {"providerId": "zai", "modelId": "glm-5.3-air",
                    "options": {"reasoningLevel": "low"}},
            },
        }),
    )
    .await;
    let snapshot = asking.await.unwrap().expect("read").expect("offered");
    let mut selection = ModelSelection::new("custom-openai", "gpt-x");
    selection.reasoning = Some("high".to_owned());
    assert_eq!(
        snapshot,
        SubagentSnapshot::Ready {
            profiles: vec![
                SubagentProfile {
                    name: "reviewer".to_owned(),
                    description: "Reviews.".to_owned(),
                    source: ProfileSource::User,
                    system_prompt: "You review.".to_owned(),
                    selection: Some(selection),
                    tools: Some(vec!["Read".to_owned()]),
                    disallowed_tools: vec!["Bash".to_owned()],
                    max_turns: Some(3),
                    background: true,
                    permission_mode: Some(PermissionMode::AcceptEdits),
                },
                SubagentProfile {
                    name: "plain".to_owned(),
                    description: String::new(),
                    source: ProfileSource::Project,
                    system_prompt: String::new(),
                    selection: None,
                    tools: None,
                    disallowed_tools: Vec::new(),
                    max_turns: None,
                    background: false,
                    permission_mode: None,
                },
            ],
            explore: Some(ModelSelection::new("zai", "glm-5.3")),
            general_purpose: None,
            plugins: [(
                "plugin:kit@market:review".to_owned(),
                ModelSelection {
                    reasoning: Some("low".to_owned()),
                    ..ModelSelection::new("zai", "glm-5.3-air")
                },
            )]
            .into(),
        }
    );

    // The gate is remembered: the next read sends only the read request.
    let asking = reading(&source);
    let read = host.next().await;
    assert_eq!(read["method"], READ);
    host.answer(&read, json!({"kind": "built-in-fallback"}))
        .await;
    assert_eq!(
        asking.await.unwrap(),
        Ok(Some(SubagentSnapshot::BuiltInFallback))
    );
}

/// Rule 1: `-32601` and `-32020` close the gate for good; a gate without the flag (a desktop-attached remote Host)
/// is closed too.
#[tokio::test]
async fn a_host_without_the_feature_closes_the_gate_once() {
    for code in [-32601, -32020] {
        let (source, mut host, _scope) = connect();
        let asking = reading(&source);
        let gate = host.next().await;
        host.fail(&gate, code).await;
        assert_eq!(asking.await.unwrap(), Ok(None), "{code}");
        // Remembered: no request at all.
        assert_eq!(source.read(&SessionId::new(SESSION)).await, Ok(None));
    }
    for enabled in [None, Some(false)] {
        let (source, mut host, _scope) = connect();
        let asking = reading(&source);
        let gate = host.next().await;
        host.answer(&gate, preferences(enabled)).await;
        assert_eq!(asking.await.unwrap(), Ok(None), "{enabled:?}");
        assert_eq!(source.read(&SessionId::new(SESSION)).await, Ok(None));
    }
}

/// Rule 1: another gate error, or no reply in time, fails the read and is not remembered.
#[tokio::test]
async fn a_failed_gate_fails_the_read_and_asks_again() {
    let (source, mut host, _scope) = connect();
    let asking = reading(&source);
    let gate = host.next().await;
    host.fail(&gate, -32603).await;
    assert!(asking.await.unwrap().is_err());
    let asking = reading(&source);
    let gate = host.next().await;
    assert_eq!(gate["method"], PREFERENCES);
    // No reply: the limit fails the read.
    assert!(asking.await.unwrap().is_err());
    let asking = reading(&source);
    let read = host.open_gate().await;
    host.answer(&read, json!({"kind": "built-in-fallback"}))
        .await;
    assert_eq!(
        asking.await.unwrap(),
        Ok(Some(SubagentSnapshot::BuiltInFallback))
    );
}

/// Rule 2: an invalid reply, a `built-in` profile and a failed or late read fail the read.
#[tokio::test]
async fn an_invalid_or_failed_read_fails() {
    let invalid = [
        json!({"kind": "ready"}),
        json!({"kind": "ready", "profiles": [], "builtInModelSelectionOverrides": {},
            "pluginAgentModelSelectionOverrides": {}, "extra": 1}),
        json!({"kind": "built-in-fallback", "profiles": []}),
        json!({"kind": "ready", "profiles": [{"name": "Explore", "description": "", "source": "built-in",
            "systemPrompt": ""}], "builtInModelSelectionOverrides": {},
            "pluginAgentModelSelectionOverrides": {}}),
    ];
    for reply in invalid {
        let (source, mut host, _scope) = connect();
        let asking = reading(&source);
        let read = host.open_gate().await;
        host.answer(&read, reply.clone()).await;
        assert!(asking.await.unwrap().is_err(), "{reply}");
    }
    let (source, mut host, _scope) = connect();
    let asking = reading(&source);
    let read = host.open_gate().await;
    host.fail(&read, -32603).await;
    assert!(asking.await.unwrap().is_err());
    let asking = reading(&source);
    let read = host.next().await;
    assert_eq!(read["method"], READ);
    assert!(asking.await.unwrap().is_err());
}

/// A session this agent did not open has no workspace to send: the read fails before any request.
#[tokio::test]
async fn an_unknown_session_fails_without_a_request() {
    let (source, _host, _scope) = connect();
    assert!(source.read(&SessionId::new("sess_other")).await.is_err());
}

/// Rule 11: a released session's gate is forgotten, so its next read asks the gate again.
#[tokio::test]
async fn a_released_session_asks_the_gate_again() {
    let (source, mut host, _scope) = connect();
    for _ in 0..2 {
        let asking = reading(&source);
        let read = host.open_gate().await;
        host.answer(&read, json!({"kind": "built-in-fallback"}))
            .await;
        assert_eq!(
            asking.await.unwrap(),
            Ok(Some(SubagentSnapshot::BuiltInFallback))
        );
        source.forget(&SessionId::new(SESSION));
    }
}
