//! Fork: the language-server host reads the runtime's incognito profiles (specs/incognito-session.md "plugins").

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::incognito::{IncognitoKey, IncognitoProfile, IncognitoProfiles};
use rust_cli_kernel_api::lsp::{
    CodeIntelligence, FileMutation, LspOutput, LspQuery, LspQueryError,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryEnvironment, MemoryStore, ScriptedModel, SequentialIds, environments,
    selection,
};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::{CompactConfig, ContextConfig, Defaults, LocalKernel, Ports, Surface};
use rust_cli_agents::MemoryTaskLists;

#[derive(Default)]
struct Profiles(OnceLock<IncognitoProfiles>);

#[async_trait]
impl CodeIntelligence for Profiles {
    async fn prewarm(&self, _session: &SessionId, _workspace: &WorkspaceRef, _path: &str) {}
    async fn file_mutated(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _mutation: FileMutation,
    ) {
    }
    async fn edit_diagnostics(&self, _session: &SessionId) -> Option<String> {
        None
    }
    fn session_closed(&self, _session: &SessionId) {}
    fn set_incognito(&self, profiles: IncognitoProfiles) {
        assert!(self.0.set(profiles).is_ok(), "set once");
    }
    async fn settle_tool(&self, _session: &SessionId, _workspace: &WorkspaceRef) {}
    fn tool_offered(&self, _session: &SessionId) -> bool {
        false
    }
    async fn query(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _query: LspQuery,
        _cancel: &CancellationToken,
    ) -> Result<LspOutput, LspQueryError> {
        unreachable!("never queried")
    }
}

/// The kernel hands its profiles to the code intelligence: a session created incognito is seen there.
#[tokio::test]
async fn the_code_intelligence_sees_the_session_profiles() {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    });
    let store = Arc::new(MemoryStore::default());
    let code = Arc::new(Profiles::default());
    let kernel = LocalKernel::with_extensions(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(Arc::new(env)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
        ContextConfig::new(Surface::Print),
        CompactConfig::default(),
        Arc::new(MemoryTaskLists::default()),
        Extensions {
            config: ExtConfig::default(),
            cron_store: None,
            peers: rust_cli_session::PeerDeps::off(),
            streaming_input: false,
            monitor: false,
            node_desktop: false,
            automation: None,
            topic_resources: None,
            acp: None,
            code_intelligence: Some(code.clone()),
            hook_transcripts: None,
            subagent_config: None,
            models: None,
        },
    );
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/work"),
    };
    let create = |incognito| CreateSession {
        id: None,
        workspace: workspace.clone(),
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        incognito,
    };
    let bare = kernel
        .create_session(create(Some(IncognitoProfile::LOCKDOWN)))
        .await
        .unwrap();
    let normal = kernel.create_session(create(None)).await.unwrap();
    let profiles = code.0.get().expect("the kernel set the profiles");
    assert!(profiles.excludes(&bare, IncognitoKey::Plugins));
    assert!(!profiles.excludes(&normal, IncognitoKey::Plugins));
}
