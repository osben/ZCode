//! `/cd` 的规则文件（tui-manage.md §7.1）。
use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId};
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use rust_cli_kernel_api::testing::{FixedClock, MemoryEnvironment, SequentialIds};
use serde_json::json;

use crate::{ContextConfig, ContextPorts, NoListings, PromptAssembler, Surface};

fn assembler() -> PromptAssembler {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/w"),
        platform: "linux".to_owned(),
        os_version: "Linux".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    })
    .with_file("/Users/dev/AGENTS.md", "dev rules")
    .with_file("/Users/dev/other/AGENTS.md", "other rules")
    .with_file("/Users/dev/other/AGENTS.local.md", "local notes")
    .with_file("/Users/dev/other/.zcode/rules/style.md", "style rule")
    .with_file(
        "/Users/dev/other/.zcode/rules/scoped.md",
        "---\npaths: src/**\n---\nonly src",
    );
    let env = Arc::new(env);
    PromptAssembler::new(
        ContextPorts {
            info: env.clone(),
            files: env.clone(),
            shell: env.clone(),
            git: env,
            clock: Arc::new(FixedClock(1_792_224_000_000)),
            ids: Arc::new(SequentialIds::default()),
            listings: Arc::new(NoListings),
        },
        ContextConfig::new(Surface::Print),
    )
}

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

#[tokio::test]
async fn new_directory_rules_skip_what_was_announced() {
    let assembler = assembler();
    // 会话开始时已宣布过 /Users/dev/AGENTS.md。
    let history = vec![Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_1"),
        source: "instructions".to_owned(),
        text: String::new(),
        data: json!({"files": [{"path": "/Users/dev/AGENTS.md", "type": "Project", "content": "dev rules"}]}),
    })];
    let text = assembler
        .directory_rules(
            &SessionId::new("s"),
            &workspace("/Users/dev/other"),
            &history,
        )
        .await
        .unwrap();
    assert!(
        text.starts_with("Codebase and user instructions are shown below."),
        "{text}"
    );
    assert!(!text.contains("dev rules"), "{text}");
    let other = text.find("Contents of /Users/dev/other/AGENTS.md").unwrap();
    let local = text
        .find("Contents of /Users/dev/other/AGENTS.local.md")
        .unwrap();
    let style = text
        .find("Contents of /Users/dev/other/.zcode/rules/style.md")
        .unwrap();
    assert!(other < local && local < style, "{text}");
    assert!(
        !text.contains("only src"),
        "conditional rules are not listed: {text}"
    );
    // 没有新的文件：None。
    assert_eq!(
        assembler
            .directory_rules(
                &SessionId::new("s"),
                &workspace("/Users/dev/empty"),
                &history
            )
            .await,
        None
    );
}

/// Fork (specs/fork-rust-agent-parity.md, "Incognito sessions"): `/cd` loads the new directory's rule files through the
/// same gate as the startup rules, so an incognito profile without `projectInstructions` gets none (the actor's note
/// keeps only the move sentence); with the key it gets them like a normal session.
#[tokio::test]
async fn an_incognito_session_without_project_instructions_gets_no_directory_rules() {
    use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles};
    let profiles = IncognitoProfiles::default();
    profiles.record(&SessionId::new("locked"), Some(IncognitoProfile::LOCKDOWN));
    profiles.record(
        &SessionId::new("kept"),
        Some(IncognitoProfile {
            project_instructions: true,
            ..IncognitoProfile::LOCKDOWN
        }),
    );
    let assembler = assembler().with_incognito(profiles);
    let rules = |session: &'static str| {
        let assembler = &assembler;
        async move {
            assembler
                .directory_rules(
                    &SessionId::new(session),
                    &workspace("/Users/dev/other"),
                    &[],
                )
                .await
        }
    };
    assert_eq!(rules("locked").await, None);
    assert!(rules("kept").await.unwrap().contains("other rules"));
    assert!(rules("s").await.unwrap().contains("other rules"));
}
