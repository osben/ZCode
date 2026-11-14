//! Fork: per-workspace project hook entries (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots and
//! strict project hook discovery").

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::hooks::{HookEvent, HookEventName, HookRunner};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::test_support::{Script, ScriptedEnv, engine, script};

const A: &str = "/Users/dev/a";
const B: &str = "/Users/dev/b";

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

fn event_in(root: &str, name: HookEventName, payload: Value) -> HookEvent {
    HookEvent::new(name, SessionId::new("sess_1"), workspace(root), payload)
}

fn prompt_in(root: &str) -> HookEvent {
    event_in(
        root,
        HookEventName::UserPromptSubmit,
        json!({"prompt": "hi"}),
    )
}

fn settings(event: &str, command: &str) -> HooksSettings {
    let (parsed, warnings) = HooksSettings::from_json(
        &json!({"hooks": {event: [{"hooks": [{"type": "command", "command": command}]}]}}),
    );
    assert!(warnings.is_empty(), "{warnings:?}");
    parsed
}

fn project(event: &str, command: &str) -> ProjectEntry {
    ProjectEntry::Admitted(vec![(HookSource::Project, settings(event, command))])
}

fn user_prompt() -> Value {
    json!({"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "user.sh"}]}]}})
}

fn started(env: &ScriptedEnv) -> Vec<String> {
    env.started()
        .into_iter()
        .map(|(_, request)| request.command)
        .collect()
}

async fn run(engine: &HookEngine, event: HookEvent) {
    engine.run(event, CancellationToken::new()).await;
}

#[tokio::test]
async fn an_event_runs_only_its_own_workspaces_project_hooks() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env.clone(), &user_prompt());
    hooks.put_project(&project_key(A), project("UserPromptSubmit", "a.sh"));
    run(&hooks, prompt_in(B)).await;
    assert_eq!(started(&env), ["user.sh"]);
    run(&hooks, prompt_in(A)).await;
    // The process sources first, then the workspace's project sources (User before Project).
    assert_eq!(started(&env), ["user.sh", "user.sh", "a.sh"]);
}

#[tokio::test]
async fn an_invalid_entry_runs_no_project_hook() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env.clone(), &user_prompt());
    hooks.put_project(&project_key(A), project("UserPromptSubmit", "a.sh"));
    hooks.put_project(&project_key(A), ProjectEntry::Invalid);
    run(&hooks, prompt_in(A)).await;
    assert_eq!(started(&env), ["user.sh"]);
}

#[tokio::test]
async fn a_process_snapshot_change_keeps_the_entries() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env.clone(), &json!({}));
    hooks.put_project(&project_key(A), project("UserPromptSubmit", "a.sh"));
    hooks.replace(crate::test_support::config(&user_prompt()));
    hooks.register_plugins(Vec::new());
    run(&hooks, prompt_in(A)).await;
    assert_eq!(started(&env), ["user.sh", "a.sh"]);
}

#[tokio::test]
async fn has_hooks_reads_the_workspaces_entry() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env, &json!({}));
    hooks.put_project(&project_key(A), project("UserPromptSubmit", "a.sh"));
    assert!(hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(A)));
    assert!(!hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(B)));
    assert!(!hooks.has_hooks(HookEventName::Stop, &workspace(A)));
}

#[tokio::test]
async fn a_swap_does_not_affect_an_event_already_running() {
    let env = Arc::new(ScriptedEnv::with(&[(
        "a.sh",
        Script {
            delay_ms: 100,
            ..script("", "blocked by a", 2)
        },
    )]));
    let hooks = Arc::new(engine(env.clone(), &json!({})));
    hooks.put_project(&project_key(A), project("UserPromptSubmit", "a.sh"));
    let running = {
        let hooks = hooks.clone();
        tokio::spawn(async move { hooks.run(prompt_in(A), CancellationToken::new()).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while started(&env).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the project hook started");
    hooks.put_project(&project_key(A), ProjectEntry::Invalid);
    let outcome = running.await.unwrap();
    assert!(outcome.prevent_continuation || outcome.blocking_error.is_some());
}

/// Counts loads; each load answers the entry of the workspace it was asked for.
struct Loader {
    loads: AtomicUsize,
    gate: Option<Arc<Notify>>,
}

#[async_trait]
impl ProjectHookLoader for Loader {
    async fn load(&self, workspace: &WorkspaceRef) -> ProjectEntry {
        self.loads.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        let name = if workspace.root.as_str() == A {
            "a.sh"
        } else {
            "b.sh"
        };
        project("UserPromptSubmit", name)
    }
}

fn loader(gate: Option<Arc<Notify>>) -> Arc<Loader> {
    Arc::new(Loader {
        loads: AtomicUsize::new(0),
        gate,
    })
}

#[tokio::test]
async fn the_first_event_of_a_workspace_loads_its_entry_once() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env.clone(), &json!({}));
    let loads = loader(None);
    hooks.set_project_loader(loads.clone());
    run(&hooks, prompt_in(A)).await;
    run(&hooks, prompt_in(A)).await;
    // A moved session (`/cd`) names another root: its next event loads that workspace.
    run(&hooks, prompt_in(B)).await;
    assert_eq!(started(&env), ["a.sh", "a.sh", "b.sh"]);
    assert_eq!(loads.loads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_session_start_reloads_the_entry_but_a_compaction_does_not() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env, &json!({}));
    let loads = loader(None);
    hooks.set_project_loader(loads.clone());
    hooks.put_project(&project_key(A), ProjectEntry::Invalid);
    let start = |source: &str| event_in(A, HookEventName::SessionStart, json!({"source": source}));
    run(&hooks, start("compact")).await;
    assert_eq!(loads.loads.load(Ordering::SeqCst), 0);
    assert!(!hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(A)));
    run(&hooks, start("startup")).await;
    assert_eq!(loads.loads.load(Ordering::SeqCst), 1);
    assert!(hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(A)));
}

#[tokio::test]
async fn a_put_during_a_load_is_not_overwritten() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = Arc::new(engine(env.clone(), &json!({})));
    let gate = Arc::new(Notify::new());
    let loads = loader(Some(gate.clone()));
    hooks.set_project_loader(loads.clone());
    let first = {
        let hooks = hooks.clone();
        tokio::spawn(async move { hooks.run(prompt_in(A), CancellationToken::new()).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while loads.loads.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the first event loads the entry");
    hooks.put_project(&project_key(A), ProjectEntry::Invalid);
    gate.notify_one();
    first.await.unwrap();
    run(&hooks, prompt_in(A)).await;
    assert!(started(&env).is_empty(), "{:?}", started(&env));
    assert_eq!(loads.loads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn with_a_loader_an_unloaded_workspace_and_a_session_start_count_as_having_hooks() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env, &json!({}));
    assert!(!hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(A)));
    hooks.set_project_loader(loader(None));
    // The session must enter the hook run for the load to happen at all.
    assert!(hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(A)));
    hooks.put_project(&project_key(A), ProjectEntry::Invalid);
    assert!(!hooks.has_hooks(HookEventName::UserPromptSubmit, &workspace(A)));
    // A session start reloads the entry, so it always runs.
    assert!(hooks.has_hooks(HookEventName::SessionStart, &workspace(A)));
}

#[test]
fn the_key_ignores_a_trailing_separator() {
    assert_eq!(project_key("/Users/dev/a/"), project_key("/Users/dev/a"));
    assert_eq!(project_key("C:\\dev\\a\\"), project_key("C:\\dev\\a"));
    assert_eq!(project_key("/"), "/");
}

/// Each call loads a command named after its order, and waits for its own gate first.
struct InOrder {
    loads: AtomicUsize,
    gates: [Arc<Notify>; 2],
}

#[async_trait]
impl ProjectHookLoader for InOrder {
    async fn load(&self, _workspace: &WorkspaceRef) -> ProjectEntry {
        let call = self.loads.fetch_add(1, Ordering::SeqCst);
        self.gates[call].notified().await;
        project("UserPromptSubmit", ["first.sh", "second.sh"][call])
    }
}

#[tokio::test]
async fn the_later_started_load_wins_when_the_earlier_finishes_first() {
    let env = Arc::new(ScriptedEnv::default());
    let hooks = Arc::new(engine(env.clone(), &json!({})));
    let loads = Arc::new(InOrder {
        loads: AtomicUsize::new(0),
        gates: [Arc::new(Notify::new()), Arc::new(Notify::new())],
    });
    hooks.set_project_loader(loads.clone());
    let spawn = |hooks: Arc<HookEngine>| {
        tokio::spawn(async move { hooks.run(prompt_in(A), CancellationToken::new()).await })
    };
    let loaded = |count: usize| {
        let loads = loads.clone();
        async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while loads.loads.load(Ordering::SeqCst) < count {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the event loads the entry");
        }
    };
    let first = spawn(hooks.clone());
    loaded(1).await;
    let second = spawn(hooks.clone());
    loaded(2).await;
    // The earlier read finishes first; the later one, which saw the newer files, finishes last.
    loads.gates[0].notify_one();
    first.await.unwrap();
    loads.gates[1].notify_one();
    second.await.unwrap();
    run(&hooks, prompt_in(A)).await;
    assert_eq!(
        started(&env).last().map(String::as_str),
        Some("second.sh"),
        "{:?}",
        started(&env)
    );
}

#[tokio::test]
async fn paths_that_differ_only_in_whitespace_are_two_workspaces() {
    // `workspaceIdentity?.trim() || workspacePath`: only an explicit identity is trimmed, never the path fallback.
    assert_ne!(project_key("/work/repo "), project_key("/work/repo"));
    assert_ne!(project_key(" /work/repo"), project_key("/work/repo"));
    let env = Arc::new(ScriptedEnv::default());
    let hooks = engine(env.clone(), &json!({}));
    hooks.put_project(
        &project_key("/work/repo"),
        project("UserPromptSubmit", "a.sh"),
    );
    hooks.put_project(&project_key("/work/repo "), ProjectEntry::Invalid);
    run(&hooks, prompt_in("/work/repo")).await;
    assert_eq!(started(&env), ["a.sh"]);
}
