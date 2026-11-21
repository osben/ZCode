//! The bundled skill pack (Node `bootstrap/src/app/bundled-skills.ts`): where it is found, its order, and the
//! dynamic-workflow gate (Node `dynamic-workflow-gate.ts`).

use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, DynamicWorkflowGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::MemoryEnvironment;

use super::*;
use crate::test_support::{HOME, facts, workspace};

/// The Node bundle entry (the dev dist `zcode.cjs`) and the pack two levels above it (`../../bundled-skills`).
const ENTRY_DIR: &str = "/app/apps/zcode-cli/packages/cli/dist";
const PACK_ROOT: &str = "/app/apps/zcode-cli/packages/bundled-skills";

/// The pack at `root`: the skills tree with the three required files.
fn pack_env_at(root: &str) -> MemoryEnvironment {
    let dir = format!("{root}/skills/{DYNAMIC_WORKFLOW_SKILL}");
    MemoryEnvironment::new(facts())
        .with_file(
            &format!("{dir}/SKILL.md"),
            "---\ndescription: Write workflows\n---\nBody\n",
        )
        .with_file(&format!("{dir}/patterns.md"), "patterns")
        .with_file(&format!("{dir}/examples.md"), "examples")
}

/// A catalog whose Host bundle is at [`ENTRY_DIR`].
fn catalog(env: MemoryEnvironment) -> SkillCatalog {
    let env = Arc::new(env);
    let catalog = SkillCatalog::new(env.clone(), env);
    catalog.set_bundled_entry_dir(Some(ENTRY_DIR.to_owned()));
    catalog
}

/// A gate source with one answer for every session (`enabled` is the rollout gate).
struct Gate {
    enabled: Mutex<bool>,
}

impl DynamicWorkflowGates for Gate {
    fn gate(&self, _session: &SessionId) -> Option<DynamicWorkflowGate> {
        Some(DynamicWorkflowGate {
            enabled: *self.enabled.lock().unwrap(),
            tools_on_demand: false,
        })
    }
}

#[tokio::test]
async fn the_bundled_pack_is_a_system_root_that_the_skill_is_found_in() {
    let catalog = catalog(pack_env_at(PACK_ROOT));
    let skill = catalog
        .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
        .await
        .expect("the bundled dynamic-workflows skill is found");
    assert_eq!(skill.source, SkillSource::Bundled);
    assert_eq!(skill.description, "Write workflows");
    assert_eq!(
        skill.dir,
        format!("{PACK_ROOT}/skills/{DYNAMIC_WORKFLOW_SKILL}")
    );
    assert_eq!(skill.name, DYNAMIC_WORKFLOW_SKILL, "no plugin prefix");
}

#[tokio::test]
async fn a_user_skill_of_the_same_name_wins_over_the_bundled_one() {
    let env = pack_env_at(PACK_ROOT).with_file(
        &format!("{HOME}/.zcode/skills/{DYNAMIC_WORKFLOW_SKILL}/SKILL.md"),
        "---\ndescription: mine\n---\n",
    );
    let catalog = catalog(env);
    let skill = catalog
        .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
        .await
        .expect("a skill of that name");
    assert_eq!(skill.source, SkillSource::User);
    assert_eq!(skill.description, "mine");
}

#[tokio::test]
async fn without_a_bundle_entry_there_is_no_bundled_skill() {
    let env = Arc::new(pack_env_at(PACK_ROOT));
    let catalog = SkillCatalog::new(env.clone(), env);
    assert!(
        catalog
            .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn a_closed_gate_hides_the_skill_from_its_session_only() {
    let catalog = catalog(pack_env_at(PACK_ROOT));
    let gate = Arc::new(Gate {
        enabled: Mutex::new(false),
    });
    catalog.set_dynamic_workflow_gates(gate.clone());
    let session = SessionId::new("closed-session");
    assert!(
        catalog
            .find_in(&workspace(), Some(&session), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_none(),
        "a session whose gate is closed does not see the skill (Node disabledPaths)"
    );
    assert!(
        catalog
            .listing(&workspace(), Some(&session), &[], "")
            .await
            .iter()
            .all(|entry| !entry.line.starts_with("- dynamic-workflows:")),
        "nor does its listing"
    );
    assert!(
        catalog
            .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_some(),
        "the draft catalog (no session) keeps it, as Node's discovery does"
    );
    *gate.enabled.lock().unwrap() = true;
    assert!(
        catalog
            .find_in(&workspace(), Some(&session), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_some(),
        "an open gate shows the skill again"
    );
}

#[tokio::test]
async fn the_reference_catalog_leaves_the_bundled_pack_out() {
    let catalog = catalog(pack_env_at(PACK_ROOT));
    let references = catalog.references(&workspace()).await;
    assert!(
        references
            .iter()
            .all(|reference| reference.name != DYNAMIC_WORKFLOW_SKILL),
        "Node skill-reference-catalog filters source bundled"
    );
}

#[test]
fn the_helper_command_names_the_bundle_directory() {
    let raw = r#"{"command":"/usr/bin/node","args":["/App/Resources/glm/zcode.cjs","__zcode-rust-helper","--stdio"],"env":{}}"#;
    assert_eq!(
        helper_entry_dir(Some(raw)).as_deref(),
        Some("/App/Resources/glm")
    );
}

#[test]
fn a_missing_or_malformed_helper_command_names_no_directory() {
    assert_eq!(helper_entry_dir(None), None);
    assert_eq!(helper_entry_dir(Some("")), None);
    assert_eq!(helper_entry_dir(Some("not json")), None);
    assert_eq!(
        helper_entry_dir(Some(r#"{"command":"node","args":[]}"#)),
        None
    );
}

#[tokio::test]
async fn the_dev_layout_finds_the_pack_two_levels_above_the_dist_entry() {
    let env = pack_env_at(PACK_ROOT);
    assert_eq!(
        pack_skills_dir(&env, &workspace(), ENTRY_DIR).await,
        Some(format!("{PACK_ROOT}/skills"))
    );
}

#[tokio::test]
async fn the_packaged_layout_finds_the_pack_next_to_the_bundle() {
    // Desktop resources/glm/zcode.cjs with the pack staged at glm/packages/bundled-skills (prepare-agent-node-bundle).
    let root = "/App/Resources/glm/packages/bundled-skills";
    let env = pack_env_at(root);
    assert_eq!(
        pack_skills_dir(&env, &workspace(), "/App/Resources/glm").await,
        Some(format!("{root}/skills"))
    );
}

#[tokio::test]
async fn a_pack_missing_a_required_file_is_not_used() {
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{PACK_ROOT}/skills/{DYNAMIC_WORKFLOW_SKILL}/SKILL.md"),
        "---\ndescription: partial\n---\n",
    );
    assert_eq!(
        pack_skills_dir(&env, &workspace(), ENTRY_DIR).await,
        None,
        "Node rejects the whole package when one required file is missing"
    );
}

#[tokio::test]
async fn no_pack_anywhere_names_no_directory() {
    let env = MemoryEnvironment::new(facts());
    assert_eq!(pack_skills_dir(&env, &workspace(), ENTRY_DIR).await, None);
}

#[tokio::test]
async fn a_miss_is_memoized_so_the_search_is_not_repeated_per_listing() {
    let env = Arc::new(MemoryEnvironment::new(facts()));
    let catalog = SkillCatalog::new(env.clone(), env.clone());
    catalog.set_bundled_entry_dir(Some(ENTRY_DIR.to_owned()));
    assert!(
        catalog
            .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_none()
    );
    // The pack appears after the miss: the memo answers the same way until the entry is set again.
    let dir = format!("{PACK_ROOT}/skills/{DYNAMIC_WORKFLOW_SKILL}");
    env.set_file(&format!("{dir}/SKILL.md"), "---\ndescription: late\n---\n");
    env.set_file(&format!("{dir}/patterns.md"), "p");
    env.set_file(&format!("{dir}/examples.md"), "e");
    assert!(
        catalog
            .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_none()
    );
    catalog.set_bundled_entry_dir(Some(ENTRY_DIR.to_owned()));
    assert!(
        catalog
            .find(&workspace(), DYNAMIC_WORKFLOW_SKILL)
            .await
            .is_some()
    );
}

#[tokio::test]
async fn a_shallow_entry_dir_still_finds_the_pack_beside_it() {
    // An entry at depth 1 (`/app`): the ancestor walk runs out of parents, which must not discard `/app/packages`.
    let root = "/app/packages/bundled-skills";
    let env = pack_env_at(root);
    assert_eq!(
        pack_skills_dir(&env, &workspace(), "/app").await,
        Some(format!("{root}/skills"))
    );
}
