//! The legacy session methods behind the Host's automation runs (specs/fork-rust-automations.md, slice 1): what reaches
//! the kernel and what the answer carries, through the protocol server with a recording kernel.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CommandResult, CreateSession, Kernel, KernelError,
    SequencedEvent, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    Admission, FrontendRecord, SessionFilter, SessionKind, SessionMeta, SessionStore,
    SessionSummary, StoreError, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Server};

/// What the kernel saw, in order: `create`, `persist`, and the commands sent to a session.
type Log = Arc<StdMutex<Vec<String>>>;

struct TestHandle {
    id: SessionId,
    view: StdMutex<SessionView>,
    log: Log,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, envelope: CommandEnvelope) -> KernelAck {
        let name = match &envelope.command {
            Command::SetMode { mode } => {
                self.view.lock().unwrap().mode = *mode;
                format!("SetMode {}", mode.node_name())
            }
            Command::SetModel { selection } => {
                self.view.lock().unwrap().selection = selection.clone();
                format!(
                    "SetModel {} {}",
                    selection.model,
                    selection.reasoning.as_deref().unwrap_or("-")
                )
            }
            Command::SetPlan { enabled } => format!("SetPlan {enabled}"),
            other => format!("{other:?}"),
        };
        self.log.lock().unwrap().push(name);
        KernelAck::Accepted {
            result: CommandResult::Done,
        }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.lock().unwrap().clone())
    }
}

/// The memory store, recording the draft persistence.
struct Queries {
    store: Arc<MemoryStore>,
    log: Log,
}

#[async_trait]
impl StoreQueries for Queries {
    async fn metering(
        &self,
        session: &SessionId,
    ) -> Result<rust_cli_kernel_api::metering::SessionMetering, StoreError> {
        self.store.metering(session).await
    }

    async fn request_stats(
        &self,
        session: &SessionId,
    ) -> Result<rust_cli_kernel_api::metering::RequestStats, StoreError> {
        self.store.request_stats(session).await
    }

    async fn activity(
        &self,
        query: rust_cli_kernel_api::metering::ActivityQuery,
    ) -> Result<rust_cli_kernel_api::metering::ActivityStats, StoreError> {
        self.store.activity(query).await
    }

    async fn put_record(
        &self,
        session: &SessionId,
        record: &FrontendRecord,
    ) -> Result<(), StoreError> {
        self.store.put_record(session, record).await
    }

    async fn records(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<Vec<FrontendRecord>, StoreError> {
        self.store.records(session, kind).await
    }

    async fn persist_for_input(
        &self,
        session: &SessionId,
        input: &str,
    ) -> Result<Admission, StoreError> {
        self.log
            .lock()
            .unwrap()
            .push(format!("persist {} {input:?}", session.as_str()));
        Ok(Admission::default())
    }
}

struct TestKernel {
    store: Arc<MemoryStore>,
    handles: StdMutex<HashMap<SessionId, Arc<TestHandle>>>,
    created: StdMutex<HashMap<SessionId, (ModelSelection, PermissionMode)>>,
    log: Log,
}

impl TestKernel {
    fn handle(&self, id: &SessionId) -> Result<Arc<TestHandle>, KernelError> {
        if let Some(handle) = self.handles.lock().unwrap().get(id) {
            return Ok(handle.clone());
        }
        let meta = self.store.meta(id).ok_or_else(|| KernelError::NotFound {
            session: id.clone(),
        })?;
        let (chosen, mode) = self
            .created
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or((selection(), PermissionMode::Default));
        let handle = Arc::new(TestHandle {
            id: id.clone(),
            view: StdMutex::new(SessionView::new(meta, Vec::new(), chosen, mode)),
            log: self.log.clone(),
        });
        self.handles
            .lock()
            .unwrap()
            .insert(id.clone(), handle.clone());
        Ok(handle)
    }

    fn stored(&self, id: &str) {
        let meta = SessionMeta {
            id: SessionId::new(id),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: rust_cli_kernel_api::env::EnvPath::new("/w"),
            },
            title: "Stored".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: None,
        };
        futures_util::FutureExt::now_or_never(self.store.create(meta))
            .expect("the memory store answers at once")
            .unwrap();
    }
}

#[async_trait]
impl Kernel for TestKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        Arc::new(Queries {
            store: self.store.clone(),
            log: self.log.clone(),
        })
    }

    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError> {
        let id = request.id.unwrap_or_else(|| SessionId::new("generated"));
        self.log.lock().unwrap().push(format!(
            "create {} {} {} {}",
            id.as_str(),
            request.selection.model,
            request.selection.reasoning.as_deref().unwrap_or("-"),
            request.mode.node_name()
        ));
        self.created
            .lock()
            .unwrap()
            .insert(id.clone(), (request.selection, request.mode));
        let meta = SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: request.workspace,
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: request.incognito,
        };
        self.store
            .create(meta)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?;
        Ok(id)
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(self.handle(session)?)
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn session_snapshot(&self, session: &SessionId) -> Result<SessionView, KernelError> {
        HandleOverride::view(self.handle(session)?.as_ref()).await
    }
}

fn server() -> (TaskScope, Arc<Server>, Arc<TestKernel>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(TestKernel {
        store: Arc::new(MemoryStore::default()),
        handles: StdMutex::new(HashMap::new()),
        created: StdMutex::new(HashMap::new()),
        log: Arc::new(StdMutex::new(Vec::new())),
    });
    let server = Arc::new(Server::new(
        context,
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server, kernel)
}

const WORKSPACE: &str = "/w";

/// The Host's create for an automation run (`zcodeTaskServiceAdapter.createTask` with an `automationId`).
fn automation_create(id: &str) -> Value {
    json!({
        "sessionId": id,
        "workspace": {"workspacePath": WORKSPACE, "workspaceKey": WORKSPACE},
        "mode": "edit",
        "model": {"providerId": "p", "modelId": "m2", "options": {"reasoningLevel": "low"}},
        "thoughtLevel": "high",
        "persistence": "deferred",
        "titleGenerationEnabled": false,
        "mcpServers": [],
    })
}

/// The method as the connection runs it: the inbound schema first, then the dispatch.
async fn call(server: &Server, method: &str, params: Value) -> Result<Value, RpcError> {
    crate::inbound::Inbound::get().method(method, &params)?;
    server
        .dispatch(method, params)
        .await
        .map(|reply| reply.result)
}

fn log(kernel: &TestKernel) -> Vec<String> {
    kernel.log.lock().unwrap().clone()
}

#[tokio::test]
async fn an_automation_create_leaves_a_draft_with_the_requested_config_and_no_titles() {
    let (_scope, server, kernel) = server();
    let snapshot = call(&server, "session/create", automation_create("run_s1"))
        .await
        .unwrap();
    assert_eq!(
        log(&kernel),
        vec![
            "create run_s1 m2 high edit".to_owned(),
            "DisableTitleGeneration".to_owned(),
        ],
        "deferred: no persistence before the first input"
    );
    assert_eq!(snapshot["session"]["sessionId"], "run_s1");
    assert_eq!(snapshot["session"]["status"], "idle");
    assert_eq!(snapshot["session"]["workspace"]["workspacePath"], WORKSPACE);
    assert_eq!(snapshot["settings"]["mode"]["current"], "edit");
    assert_eq!(
        snapshot["settings"]["model"]["current"],
        json!({"providerId": "p", "modelId": "m2", "options": {"reasoningLevel": "high"}})
    );
    assert_eq!(snapshot["messages"], json!([]));
}

#[tokio::test]
async fn an_immediate_create_persists_the_session_and_keeps_titles() {
    let (_scope, server, kernel) = server();
    let mut params = automation_create("s2");
    params["persistence"] = json!("immediate");
    params
        .as_object_mut()
        .unwrap()
        .remove("titleGenerationEnabled");
    call(&server, "session/create", params).await.unwrap();
    assert_eq!(
        log(&kernel),
        vec![
            "create s2 m2 high edit".to_owned(),
            "persist s2 \"\"".to_owned()
        ]
    );
    // Node's default persistence is immediate.
    let mut params = automation_create("s3");
    params.as_object_mut().unwrap().remove("persistence");
    call(&server, "session/create", params).await.unwrap();
    assert!(log(&kernel).contains(&"persist s3 \"\"".to_owned()));
}

#[tokio::test]
async fn an_existing_id_is_refused() {
    let (_scope, server, kernel) = server();
    kernel.stored("taken");
    let error = call(&server, "session/create", automation_create("taken"))
        .await
        .unwrap_err();
    assert_eq!(error.code, -32602);
    assert!(
        error.message.contains("sessionId already exists"),
        "{error:?}"
    );
    assert!(log(&kernel).is_empty(), "{:?}", log(&kernel));
}

#[tokio::test]
async fn fields_the_agent_cannot_honour_refuse_the_create_before_the_kernel() {
    let (_scope, server, kernel) = server();
    for (field, value) in [
        ("toolDenylist", json!(["Bash"])),
        ("toolAllowlist", json!(["Read"])),
        ("parentSessionId", json!("p1")),
    ] {
        let mut params = automation_create("s4");
        params[field] = value;
        let error = call(&server, "session/create", params).await.unwrap_err();
        assert_eq!(error.code, -32602, "{field}");
        assert!(error.message.contains(field), "{error:?}");
        assert!(
            !error.message.contains("nrecognized"),
            "the Host's compatibility retry must not drop {field}"
        );
    }
    // Empty lists limit nothing.
    let mut params = automation_create("s5");
    params["toolDenylist"] = json!([]);
    call(&server, "session/create", params).await.unwrap();
    assert_eq!(log(&kernel)[0], "create s5 m2 high edit");
    // An unknown key is the schema's (strict) refusal.
    let mut params = automation_create("s6");
    params["unknownField"] = json!(1);
    assert_eq!(
        call(&server, "session/create", params)
            .await
            .unwrap_err()
            .code,
        -32602
    );
}

#[tokio::test]
async fn resume_opens_a_stored_session_and_a_missing_one_is_the_read_error() {
    let (_scope, server, kernel) = server();
    kernel.stored("cold");
    let snapshot = call(
        &server,
        "session/resume",
        json!({"sessionId": "cold", "workspace": {"workspacePath": WORKSPACE, "workspaceKey": WORKSPACE},
               "thoughtLevel": "high", "mcpServers": []}),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["session"]["sessionId"], "cold");
    assert_eq!(snapshot["session"]["title"], "Stored");
    assert!(
        server.bridge.get(&SessionId::new("cold")).is_some(),
        "now live"
    );
    // The live session answers again.
    call(&server, "session/resume", json!({"sessionId": "cold"}))
        .await
        .unwrap();

    let missing = call(&server, "session/resume", json!({"sessionId": "nope"}))
        .await
        .unwrap_err();
    let read = crate::legacy::read(&server, &json!({"sessionId": "nope"}))
        .await
        .unwrap_err();
    assert_eq!((missing.code, missing.message), (read.code, read.message));
}

#[tokio::test]
async fn set_mode_thought_and_model_switch_the_live_session() {
    let (_scope, server, kernel) = server();
    kernel.stored("s7");
    let snapshot = call(
        &server,
        "session/setMode",
        json!({"sessionId": "s7", "mode": "auto"}),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["settings"]["mode"]["current"], "auto");
    call(
        &server,
        "session/setModel",
        json!({"sessionId": "s7", "model": {"providerId": "p", "modelId": "m9"}}),
    )
    .await
    .unwrap();
    call(
        &server,
        "session/setThoughtLevel",
        json!({"sessionId": "s7", "thoughtLevel": "max"}),
    )
    .await
    .unwrap();
    assert_eq!(
        log(&kernel),
        vec![
            "SetMode auto".to_owned(),
            "SetModel m9 -".to_owned(),
            format!("SetModel {} max", selection().model),
        ],
        "setThoughtLevel keeps the model the projection holds"
    );
    let missing = call(
        &server,
        "session/setMode",
        json!({"sessionId": "nope", "mode": "build"}),
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, crate::server::SESSION_UNAVAILABLE);
}

#[tokio::test]
async fn the_off_peak_tool_policy_answers_disabled_until_the_tools_are_ported() {
    let (_scope, server, _kernel) = server();
    let workspace = json!({"workspacePath": WORKSPACE, "workspaceKey": WORKSPACE});
    let reply = call(
        &server,
        "workspace/updateOffPeakToolPolicy",
        json!({"workspace": workspace, "enabled": true}),
    )
    .await
    .unwrap();
    assert_eq!(reply, json!({"workspace": workspace, "enabled": false}));
}
