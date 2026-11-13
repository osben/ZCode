//! Fork: the agent catalog from the Host's subagent snapshot (specs/fork-rust-subagent-runtime-config.md).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, RunId, SessionId};
use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles};
use rust_cli_kernel_api::listing::ListingSource;
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{ContextRequest, OrchestrationError};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::subagent_config::{
    ProfileSource, SubagentConfigSource, SubagentProfile, SubagentSnapshot,
};
use rust_cli_kernel_api::testing::{MemoryEnvironment, selection};

use super::AgentCatalog;
use crate::definitions::{AgentDefinition, AgentSource};
use crate::plugin::PluginAgentFile;

const PARENT: &str = "sess_parent";
const CHILD: &str = "sess_child";
const PLUGIN_ROOT: &str = "/Users/dev/plugins/kit";

/// The Host double: counts the reads and answers what the test set.
struct Host {
    reads: AtomicUsize,
    answer: Mutex<Result<Option<SubagentSnapshot>, String>>,
}

impl Host {
    fn new(answer: Result<Option<SubagentSnapshot>, String>) -> Arc<Self> {
        Arc::new(Self {
            reads: AtomicUsize::new(0),
            answer: Mutex::new(answer),
        })
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn answer(&self, answer: Result<Option<SubagentSnapshot>, String>) {
        *self.answer.lock_unpoisoned() = answer;
    }
}

#[async_trait]
impl SubagentConfigSource for Host {
    async fn read(&self, session: &SessionId) -> Result<Option<SubagentSnapshot>, String> {
        // The read is always for the root session.
        assert_eq!(session.as_str(), PARENT);
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.answer.lock_unpoisoned().clone()
    }
}

fn profile(name: &str, source: ProfileSource) -> SubagentProfile {
    SubagentProfile {
        name: name.to_owned(),
        description: format!("{name} from the Host."),
        source,
        system_prompt: format!("You are {name}.\n"),
        selection: None,
        tools: Some(vec!["Read".to_owned()]),
        disallowed_tools: vec!["Bash".to_owned()],
        max_turns: Some(4),
        background: true,
        permission_mode: Some(PermissionMode::AcceptEdits),
    }
}

/// An incognito profile that keeps every capability.
fn keep_all() -> IncognitoProfile {
    IncognitoProfile {
        project_instructions: true,
        skills: true,
        hooks: true,
        plugins: true,
        mcp: true,
        custom_agents: true,
        memory: true,
        output_style: true,
        system_prompt_overrides: true,
        identity: true,
        harness: true,
        environment: true,
        automation_tools: true,
    }
}

fn full(provider: &str, model: &str, reasoning: &str) -> ModelSelection {
    ModelSelection {
        reasoning: Some(reasoning.to_owned()),
        ..ModelSelection::new(provider, model)
    }
}

fn ready(profiles: Vec<SubagentProfile>) -> SubagentSnapshot {
    SubagentSnapshot::Ready {
        profiles,
        explore: None,
        general_purpose: None,
    }
}

/// The agent files a file-based catalog would read: a user agent the Host's snapshot leaves out (disabled in
/// Settings), a project agent and a plugin agent.
fn catalog() -> AgentCatalog {
    let facts = EnvFacts {
        cwd: EnvPath::new("/Users/dev/repo"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    };
    let env = Arc::new(
        MemoryEnvironment::new(facts)
            .with_file(
                "/Users/dev/.zcode/agents/disabled.md",
                "---\nname: disabled\ndescription: Disabled in Settings.\n---\nD.",
            )
            .with_file(
                "/Users/dev/repo/.zcode/agents/walked.md",
                "---\nname: walked\ndescription: Found by the cwd walk.\n---\nW.",
            )
            .with_file(
                &format!("{PLUGIN_ROOT}/agents/review.md"),
                "---\nname: review\ndescription: Plugin review.\n---\nP.",
            ),
    );
    let catalog = AgentCatalog::new(env.clone(), env);
    catalog.set_plugins(vec![PluginAgentFile {
        plugin: "kit".to_owned(),
        root: PLUGIN_ROOT.to_owned(),
        path: format!("{PLUGIN_ROOT}/agents/review.md"),
        namespace: Vec::new(),
    }]);
    catalog.set_roots(Arc::new(|session: &SessionId| {
        if session.as_str() == CHILD {
            SessionId::new(PARENT)
        } else {
            session.clone()
        }
    }));
    catalog
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/repo"),
    }
}

fn session(id: &str) -> SessionId {
    SessionId::new(id)
}

fn run(id: &str) -> RunId {
    RunId::new(id)
}

fn names(definitions: &[AgentDefinition]) -> Vec<&str> {
    definitions
        .iter()
        .map(|definition| definition.agent_type.as_str())
        .collect()
}

fn find<'a>(definitions: &'a [AgentDefinition], name: &str) -> &'a AgentDefinition {
    definitions
        .iter()
        .find(|definition| definition.agent_type == name)
        .unwrap_or_else(|| panic!("{name} in {:?}", names(definitions)))
}

fn listing_request(session_id: &str, run_id: Option<&str>) -> ContextRequest {
    ContextRequest {
        run: run_id.map(run),
        ..ContextRequest::new(
            session(session_id),
            workspace(),
            QuerySource::MainThread,
            PermissionMode::Default,
            selection(),
        )
    }
}

/// Rule 5: a `ready` snapshot replaces the agent files: an agent disabled in Settings (absent from the snapshot) is
/// not available even though its file is there, and the cwd walk's project agents are not read either.
#[tokio::test]
async fn a_ready_snapshot_replaces_the_agent_files() {
    let catalog = catalog();
    let host = Host::new(Ok(Some(ready(vec![
        profile("enabled", ProfileSource::User),
        profile("team", ProfileSource::Project),
    ]))));
    catalog.set_host(host.clone());
    let found = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("read");
    assert_eq!(
        names(&found),
        [
            "general-purpose",
            "Explore",
            "Plan",
            "kit:review",
            "enabled",
            "team"
        ]
    );
    let enabled = find(&found, "enabled");
    assert_eq!(enabled.source, AgentSource::User);
    assert_eq!(enabled.when_to_use, "enabled from the Host.");
    assert_eq!(enabled.prompt, "You are enabled.\n");
    assert_eq!(enabled.tools, Some(vec!["Read".to_owned()]));
    assert_eq!(enabled.disallowed_tools, vec!["Bash".to_owned()]);
    assert_eq!(enabled.max_turns, Some(4));
    assert!(enabled.background);
    assert_eq!(enabled.permission_mode, Some(PermissionMode::AcceptEdits));
    assert_eq!(find(&found, "team").source, AgentSource::Project);
    assert_eq!(host.reads(), 1);
}

/// Rules 7 and 8: the Settings overrides set the built-ins' full selection; a profile named like a built-in replaces
/// it outright, its own selection included.
#[tokio::test]
async fn overrides_set_the_built_ins_and_a_profile_replaces_a_built_in() {
    let catalog = catalog();
    let mut explore = profile("Explore", ProfileSource::Project);
    explore.selection = Some(full("custom-openai", "gpt-x", "low"));
    catalog.set_host(Host::new(Ok(Some(SubagentSnapshot::Ready {
        profiles: vec![explore],
        explore: Some(full("zai", "glm-5.3", "max")),
        general_purpose: Some(full("custom-openai", "gpt-y", "high")),
    }))));
    let found = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("read");
    let general = find(&found, "general-purpose");
    assert_eq!(general.source, AgentSource::BuiltIn);
    assert_eq!(
        general.selection,
        Some(full("custom-openai", "gpt-y", "high"))
    );
    let explore = find(&found, "Explore");
    assert_eq!(explore.source, AgentSource::Project);
    assert_eq!(
        explore.selection,
        Some(full("custom-openai", "gpt-x", "low"))
    );
    assert_eq!(find(&found, "Plan").selection, None);
}

/// Rule 6: `built-in-fallback` leaves the built-ins only: no plugin agents, no agent files.
#[tokio::test]
async fn the_fallback_keeps_the_built_ins_only() {
    let catalog = catalog();
    catalog.set_host(Host::new(Ok(Some(SubagentSnapshot::BuiltInFallback))));
    let found = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("read");
    assert_eq!(names(&found), ["general-purpose", "Explore", "Plan"]);
    assert!(
        found
            .iter()
            .all(|definition| definition.selection.is_none())
    );
}

/// Rule 1: when the Host does not offer a snapshot (`Ok(None)`), and without a source, the agent files apply.
#[tokio::test]
async fn without_a_snapshot_the_agent_files_apply() {
    let catalog = catalog();
    let files = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("files");
    assert!(names(&files).contains(&"disabled"));
    assert!(names(&files).contains(&"walked"));
    let host = Host::new(Ok(None));
    catalog.set_host(host.clone());
    let gated = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_2")))
        .await
        .expect("files");
    assert_eq!(names(&gated), names(&files));
    assert_eq!(host.reads(), 1);
}

/// Rule 10: without custom agents an incognito session sees the built-ins and sends no request; without plugins the
/// snapshot is still read and the plugin layer is dropped.
#[tokio::test]
async fn incognito_sessions_send_no_request_without_custom_agents() {
    let catalog = catalog();
    let host = Host::new(Ok(Some(ready(vec![profile(
        "enabled",
        ProfileSource::User,
    )]))));
    catalog.set_host(host.clone());
    let profiles = IncognitoProfiles::default();
    catalog.set_incognito(profiles.clone());
    profiles.record(
        &session(PARENT),
        Some(IncognitoProfile {
            custom_agents: false,
            ..keep_all()
        }),
    );
    let found = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("built-ins");
    assert_eq!(names(&found), ["general-purpose", "Explore", "Plan"]);
    assert_eq!(host.reads(), 0);
    // A profile never changes, so the second case is a second catalog.
    let catalog = self::catalog();
    catalog.set_host(host.clone());
    let profiles = IncognitoProfiles::default();
    catalog.set_incognito(profiles.clone());
    profiles.record(
        &session(PARENT),
        Some(IncognitoProfile {
            plugins: false,
            ..keep_all()
        }),
    );
    let found = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_2")))
        .await
        .expect("read");
    assert_eq!(
        names(&found),
        ["general-purpose", "Explore", "Plan", "enabled"]
    );
    assert_eq!(host.reads(), 1);
}

/// Rule 3: one parent run reads once: its two listings, an Agent lookup in the run and a child's listing share the
/// read; the next parent run reads again, and the child then sees the new snapshot.
#[tokio::test]
async fn one_parent_run_reads_the_snapshot_once() {
    let catalog = catalog();
    let host = Host::new(Ok(Some(ready(vec![profile("first", ProfileSource::User)]))));
    catalog.set_host(host.clone());
    for _ in 0..2 {
        let listed = catalog
            .listings(&listing_request(PARENT, Some("run_1")))
            .await
            .expect("listed");
        assert!(listed.agents.iter().any(|entry| entry.name == "first"));
    }
    catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("agent lookup");
    let child = catalog
        .listings(&listing_request(CHILD, Some("run_child")))
        .await
        .expect("child listing");
    assert!(child.agents.iter().any(|entry| entry.name == "first"));
    // A lookup without a run (compaction, `/context` usage) uses the cache too.
    catalog
        .listings(&listing_request(PARENT, None))
        .await
        .expect("compaction listing");
    assert_eq!(host.reads(), 1);

    host.answer(Ok(Some(ready(vec![profile(
        "second",
        ProfileSource::User,
    )]))));
    let next = catalog
        .listings(&listing_request(PARENT, Some("run_2")))
        .await
        .expect("listed");
    assert!(next.agents.iter().any(|entry| entry.name == "second"));
    assert!(!next.agents.iter().any(|entry| entry.name == "first"));
    let child = catalog
        .definitions_in(&workspace(), Some(&session(CHILD)))
        .await;
    assert!(names(&child).contains(&"second"));
    assert_eq!(host.reads(), 2);
}

/// Rule 3: a subagent's listings never start a read of their own, whatever their run.
#[tokio::test]
async fn subagent_listings_use_the_cached_snapshot() {
    let catalog = catalog();
    let host = Host::new(Ok(Some(ready(vec![profile("first", ProfileSource::User)]))));
    catalog.set_host(host.clone());
    for run_id in ["run_a", "run_b"] {
        let request = ContextRequest {
            source: QuerySource::Subagent("general-purpose".to_owned()),
            ..listing_request(PARENT, Some(run_id))
        };
        let listed = catalog.listings(&request).await.expect("listed");
        assert!(listed.agents.iter().any(|entry| entry.name == "first"));
    }
    assert_eq!(host.reads(), 1);
}

/// Rule 4: a failed read fails the listing (and so the turn) and is not cached: the next lookup reads again. An
/// Agent lookup that has to read returns the error.
#[tokio::test]
async fn a_failed_read_fails_the_listing_and_is_not_cached() {
    let catalog = catalog();
    let host = Host::new(Err("the Host did not reply in time".to_owned()));
    catalog.set_host(host.clone());
    let error = catalog
        .listings(&listing_request(PARENT, Some("run_1")))
        .await
        .expect_err("the read failed");
    match error {
        OrchestrationError::Failed { message } => {
            assert!(
                message.contains("the Host did not reply in time"),
                "{message}"
            );
        }
        other => panic!("{other:?}"),
    }
    let error = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect_err("the read failed again");
    assert!(error.contains("the Host did not reply in time"), "{error}");
    assert_eq!(host.reads(), 2);
    host.answer(Ok(Some(ready(vec![profile("back", ProfileSource::User)]))));
    let found = catalog
        .prepared_definitions(&workspace(), &session(PARENT), Some(&run("run_1")))
        .await
        .expect("read");
    assert!(names(&found).contains(&"back"));
    assert_eq!(host.reads(), 3);
}
