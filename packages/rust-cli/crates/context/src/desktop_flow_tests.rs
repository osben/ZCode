//! Which requests announce the ZCode Desktop Context, and what a refused Gen UI directory does
//! (specs/fork-rust-desktop-context-announcement.md; Node adds the `desktop_context` section only for the main
//! session with the default prompt and `harness` on, and `withDesktopContext` copies that into the announcement).

use std::sync::Arc;

use rust_cli_kernel_api::env::{
    EnvError, EnvFacts, EnvPath, FileContent, OperationContext, ReadFile, WorkspaceRef, WriteFile,
    WriteReceipt,
};
use rust_cli_kernel_api::env_files::EnsureDir;
use rust_cli_kernel_api::ids::{AgentId, EnvironmentId, MessageId, SessionId};
use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles};
use rust_cli_kernel_api::machine::Files;
use rust_cli_kernel_api::message::{
    AttachmentMessage, ContentBlock, Message, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{ContextBuilder, ContextRequest};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryEnvironment, SequentialIds, UnusedEnvironment,
};

use crate::config::DesktopContext;
use crate::desktop::content;
use crate::{ContextConfig, ContextPorts, PromptAssembler, Surface};

const ROOT: &str = "/root/visualizations";

/// The in-memory environment, whose files port can create directories.
struct Dirs(Arc<MemoryEnvironment>);

#[async_trait::async_trait]
impl Files for Dirs {
    async fn read_file(
        &self,
        workspace: &WorkspaceRef,
        request: ReadFile,
    ) -> Result<FileContent, EnvError> {
        self.0.read_file(workspace, request).await
    }

    async fn write_file(
        &self,
        workspace: &WorkspaceRef,
        context: OperationContext,
        request: WriteFile,
    ) -> Result<WriteReceipt, EnvError> {
        self.0.write_file(workspace, context, request).await
    }

    async fn ensure_dir(
        &self,
        _workspace: &WorkspaceRef,
        _request: EnsureDir,
    ) -> Result<(), EnvError> {
        Ok(())
    }
}

fn ports(env: Arc<MemoryEnvironment>) -> ContextPorts {
    ContextPorts {
        info: env.clone(),
        files: Arc::new(Dirs(env.clone())),
        shell: env.clone(),
        git: env,
        clock: Arc::new(FixedClock(1_792_224_000_000)),
        ids: Arc::new(SequentialIds::default()),
        listings: Arc::new(crate::NoListings),
    }
}

fn assembler(config: ContextConfig) -> PromptAssembler {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/w"),
        platform: "linux".to_owned(),
        os_version: "Linux 6.8.0".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: false,
        home: None,
        uid: None,
    });
    PromptAssembler::new(ports(Arc::new(env)), config)
}

fn desktop(root: Option<&str>) -> ContextConfig {
    let mut config = ContextConfig::new(Surface::Print);
    config.desktop = Some(DesktopContext {
        gen_ui_root: root.map(str::to_owned),
    });
    config
}

fn request(source: QuerySource, agent: Option<&str>) -> ContextRequest {
    ContextRequest {
        agent: agent.map(AgentId::new),
        ..ContextRequest::new(
            SessionId::new("s"),
            WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            source,
            PermissionMode::Default,
            ModelSelection::new("p".to_owned(), rust_cli_base::models::GLM_5_3.to_owned()),
        )
    }
}

fn history() -> Vec<Message> {
    vec![Message::User(UserMessage {
        stall_execution: None,
        workflow_meta: None,
        epilogue_start: None,
        intent: None,
        id: MessageId::new("u"),
        content: vec![ContentBlock::Text {
            text: "hi".to_owned(),
        }],
        origin: UserOrigin::Human,
    })]
}

fn environment(attachments: &[AttachmentMessage]) -> Option<&AttachmentMessage> {
    attachments
        .iter()
        .find(|attachment| attachment.source == crate::environment::SOURCE)
}

async fn announced(assembler: &PromptAssembler, request: ContextRequest) -> Option<String> {
    let attachments = assembler
        .turn_attachments(request, &history())
        .await
        .unwrap();
    environment(&attachments).map(|attachment| attachment.text.clone())
}

#[tokio::test]
async fn the_main_thread_announces_the_text_with_the_session_directory() {
    let assembler = assembler(desktop(Some(ROOT)));
    let text = announced(&assembler, request(QuerySource::MainThread, None))
        .await
        .unwrap();
    assert!(
        text.contains(&format!("\n\n{}\n</system-reminder>", content(true))),
        "{text}"
    );
    assert!(text.contains(" - Visualization directory for this session: /root/visualizations/"));
    // The system prompt holds nothing of it.
    let built = assembler
        .build(request(QuerySource::MainThread, None), &history())
        .await
        .unwrap();
    assert!(
        built
            .system
            .iter()
            .all(|block| !block.text.contains("Desktop Context"))
    );
}

/// The loop's first step of a run calls `start_attachments`; for the main thread it is the same group.
#[tokio::test]
async fn the_first_step_of_a_main_thread_run_announces_it_too() {
    let assembler = assembler(desktop(Some(ROOT)));
    let attachments = assembler
        .start_attachments(request(QuerySource::MainThread, None), &history())
        .await
        .unwrap();
    let text = environment(&attachments).unwrap().text.clone();
    assert!(text.contains("# ZCode Desktop Context"), "{text}");
    assert!(text.contains("Visualization directory for this session"));
}

#[tokio::test]
async fn without_a_root_the_text_has_no_interactive_views() {
    let assembler = assembler(desktop(None));
    let text = announced(&assembler, request(QuerySource::MainThread, None))
        .await
        .unwrap();
    assert!(
        text.contains(&format!("\n\n{}\n</system-reminder>", content(false))),
        "{text}"
    );
    assert!(!text.contains("Visualization directory"));
}

#[tokio::test]
async fn off_the_desktop_there_is_no_text() {
    let assembler = assembler(ContextConfig::new(Surface::Print));
    let text = announced(&assembler, request(QuerySource::MainThread, None))
        .await
        .unwrap();
    assert!(!text.contains("ZCode Desktop Context"));
}

/// Node children do not inherit the surface or the root.
#[tokio::test]
async fn a_subagent_request_gets_none() {
    let assembler = assembler(desktop(Some(ROOT)));
    let text = announced(
        &assembler,
        request(QuerySource::Subagent("Explore".to_owned()), Some("agent_1")),
    )
    .await
    .unwrap();
    assert!(!text.contains("ZCode Desktop Context"));
    assert!(!text.contains("Visualization directory"));
}

/// Node: `hasCustomSystemPrompt` skips the default sections, the desktop one with them.
#[tokio::test]
async fn a_custom_system_prompt_gets_none() {
    let mut config = desktop(Some(ROOT));
    config.custom_system_prompt = Some("You are terse.".to_owned());
    let text = announced(&assembler(config), request(QuerySource::MainThread, None))
        .await
        .unwrap();
    assert!(!text.contains("ZCode Desktop Context"));
    assert!(!text.contains("Visualization directory"));
}

/// Node: `harnessOff` drops the section. With `harness` on it stays; without `environment` there is no announcement.
#[tokio::test]
async fn an_incognito_profile_without_harness_gets_none() {
    let with = |profile: IncognitoProfile| {
        let profiles = IncognitoProfiles::default();
        profiles.record(&SessionId::new("s"), Some(profile));
        assembler(desktop(Some(ROOT))).with_incognito(profiles)
    };
    let kept = IncognitoProfile {
        environment: true,
        harness: true,
        ..IncognitoProfile::LOCKDOWN
    };
    let text = announced(&with(kept), request(QuerySource::MainThread, None))
        .await
        .unwrap();
    assert!(text.contains("# ZCode Desktop Context"));
    let no_harness = IncognitoProfile {
        environment: true,
        ..IncognitoProfile::LOCKDOWN
    };
    let text = announced(&with(no_harness), request(QuerySource::MainThread, None))
        .await
        .unwrap();
    assert!(!text.contains("ZCode Desktop Context"));
    assert!(!text.contains("Visualization directory"));
    let no_environment = IncognitoProfile {
        harness: true,
        ..IncognitoProfile::LOCKDOWN
    };
    assert_eq!(
        announced(
            &with(no_environment),
            request(QuerySource::MainThread, None)
        )
        .await,
        None
    );
}

/// The directory is created before it is named; a refusal fails the step, as it failed the request when the text was
/// a system section. `UnusedEnvironment` refuses `ensure_dir`.
#[tokio::test]
async fn a_refused_directory_fails_the_main_thread_step() {
    let env = Arc::new(UnusedEnvironment);
    let assembler = PromptAssembler::new(
        ContextPorts {
            info: env.clone(),
            files: env.clone(),
            shell: env.clone(),
            git: env,
            clock: Arc::new(FixedClock(1_792_224_000_000)),
            ids: Arc::new(SequentialIds::default()),
            listings: Arc::new(crate::NoListings),
        },
        desktop(Some(ROOT)),
    );
    let error = assembler
        .turn_attachments(request(QuerySource::MainThread, None), &history())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Gen UI output directory unavailable"),
        "{error}"
    );
    // A child's steps never try.
    assembler
        .turn_attachments(
            request(QuerySource::Subagent("Explore".to_owned()), Some("agent_1")),
            &history(),
        )
        .await
        .unwrap();
}
