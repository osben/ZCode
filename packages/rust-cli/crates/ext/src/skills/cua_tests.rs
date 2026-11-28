//! Fork (specs/fork-rust-subagent-runtime-config.md, rule 17 "Computer Use"): the official Computer Use plugin's skills
//! never reach a subagent child (Node `FilteredSkillPort` with `cuaPolicy`).

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::subagent_config::{COMPUTER_USE_UNAVAILABLE, SubagentSkillGrants};
use rust_cli_kernel_api::testing::{MemoryEnvironment, SequentialIds};
use rust_cli_kernel_api::tool::{Tool, Validation};
use serde_json::json;

use super::tool::SkillTool;
use super::*;
use crate::test_support::{CWD, facts, tool_context, workspace};

const OFFICIAL: &str = "/plugins/cua/skills";
const THIRD_PARTY: &str = "/plugins/other/skills";

fn env() -> Arc<MemoryEnvironment> {
    let file = |name: &str| format!("---\ndescription: {name}\n---\nBody.\n");
    Arc::new(
        MemoryEnvironment::new(facts())
            .with_file(
                &format!("{OFFICIAL}/screen/SKILL.md"),
                &file("Official screen"),
            )
            .with_file(
                &format!("{OFFICIAL}/shared/SKILL.md"),
                &file("Official shared"),
            )
            .with_file(
                &format!("{THIRD_PARTY}/screen/SKILL.md"),
                &file("Third party screen"),
            )
            .with_file(
                &format!("{THIRD_PARTY}/lookalike/SKILL.md"),
                &file("Third party lookalike"),
            )
            .with_file(
                &format!("{CWD}/.zcode/skills/greet/SKILL.md"),
                &file("Greet"),
            ),
    )
}

/// The official plugin (name `computer-use`) and a third-party plugin that is not flagged.
fn catalog(env: &Arc<MemoryEnvironment>) -> Arc<SkillCatalog> {
    let catalog = Arc::new(SkillCatalog::new(env.clone(), env.clone()));
    catalog.set_plugin_roots(vec![
        PluginSkillRoot {
            plugin: "computer-use".to_owned(),
            dir: OFFICIAL.to_owned(),
            official_cua: true,
        },
        PluginSkillRoot {
            plugin: "other".to_owned(),
            dir: THIRD_PARTY.to_owned(),
            official_cua: false,
        },
    ]);
    catalog
}

fn names(skills: &[Arc<Skill>]) -> Vec<&str> {
    skills.iter().map(|skill| skill.name.as_str()).collect()
}

#[tokio::test]
async fn an_enrolled_child_never_lists_the_official_skills() {
    let env = env();
    let catalog = catalog(&env);
    let ws = workspace();
    let main = SessionId::new("main");
    let child = SessionId::new("child");
    catalog.enroll(&child);
    let main_view = catalog.skills_in(&ws, Some(&main)).await;
    assert!(names(&main_view).contains(&"computer-use:shared"));
    let child_view = catalog.skills_in(&ws, Some(&child)).await;
    assert!(!names(&child_view).contains(&"computer-use:shared"));
    assert!(
        catalog
            .find_in(&ws, Some(&child), "computer-use:shared")
            .await
            .is_none()
    );
    // A same-named skill of another plugin and the user's own skills stay.
    assert!(names(&child_view).contains(&"greet"));
    assert!(names(&child_view).contains(&"other:lookalike"));
    // The listing the child's prompt shows follows the same view.
    let listed = catalog.listing(&ws, Some(&child), &[], "m").await;
    assert!(listed.iter().all(|entry| !entry.name.contains("shared")));
    // The enrolment ends with the run.
    catalog.forget(&child);
    assert!(names(&catalog.skills_in(&ws, Some(&child)).await).contains(&"computer-use:shared"));
}

#[tokio::test]
async fn a_grant_never_brings_an_official_skill_back() {
    let env = env();
    let catalog = catalog(&env);
    let ws = workspace();
    let child = SessionId::new("child");
    catalog.enroll(&child);
    let entries = ["computer-use:shared".to_owned(), "greet".to_owned()];
    catalog.grant(&child, &ws, &entries).await;
    assert_eq!(
        names(&catalog.skills_in(&ws, Some(&child)).await),
        vec!["greet"]
    );
}

#[tokio::test]
async fn the_refusal_names_a_qualified_or_uniquely_bare_official_entry() {
    let env = env();
    let catalog = catalog(&env);
    let ws = workspace();
    let refuse = |entries: &[&str]| {
        let entries: Vec<String> = entries.iter().map(|entry| (*entry).to_owned()).collect();
        let catalog = catalog.clone();
        let ws = ws.clone();
        async move { catalog.computer_use_refusal(&ws, &entries).await }
    };
    let message = Some(COMPUTER_USE_UNAVAILABLE.to_owned());
    // A qualified official name.
    assert_eq!(refuse(&["computer-use:shared"]).await, message);
    // A bare name that matches one skill, which is official.
    assert_eq!(refuse(&["shared"]).await, message);
    // A bare name that matches two skills (the official one and a third party's) is not "unique".
    assert_eq!(refuse(&["screen"]).await, None);
    // The third party's qualified name matches no official skill, and an unknown or empty list is fine.
    assert_eq!(refuse(&["other:lookalike"]).await, None);
    assert_eq!(refuse(&["greet", "nothing"]).await, None);
    assert_eq!(refuse(&[]).await, None);
}

#[tokio::test]
async fn the_skill_tool_refuses_an_official_load_for_a_child() {
    let env = env();
    let catalog = catalog(&env);
    let ids: Arc<dyn rust_cli_kernel_api::clock::Ids> = Arc::new(SequentialIds::default());
    let tool = SkillTool::new(catalog.clone(), ids, None);
    let context = tool_context(env, PermissionMode::DontAsk);
    catalog.enroll(&context.session);
    let message_of = |validation: Validation| match validation {
        Validation::Invalid { message, .. } => message,
        _ => "ok".to_owned(),
    };
    // Qualified and unique-bare requests name the Computer Use refusal, not "Unknown skill".
    for name in ["computer-use:shared", "shared"] {
        let message = message_of(tool.validate_input(&json!({"skill": name}), &context).await);
        assert_eq!(message, COMPUTER_USE_UNAVAILABLE, "{name}");
    }
    // A bare name shared with a third party's skill is not unique, so it is unknown to the child.
    let message = message_of(
        tool.validate_input(&json!({"skill": "screen"}), &context)
            .await,
    );
    assert!(message.starts_with("Unknown skill: screen"), "{message}");
    // A normal skill still validates.
    let message = message_of(
        tool.validate_input(&json!({"skill": "greet"}), &context)
            .await,
    );
    assert_eq!(message, "ok");
}
