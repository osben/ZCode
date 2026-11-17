//! Fork (rule 17, specs/fork-rust-subagent-runtime-config.md): a subagent's `skills` grants.

use std::collections::HashSet;
use std::sync::Arc;

use super::{filter_granted, resolve};
use crate::skills::load::parse;
use crate::skills::{Skill, SkillSource};

fn skill(name: &str, dir: &str, source: SkillSource) -> Arc<Skill> {
    Arc::new(parse(
        "---\ndescription: A skill.\n---\nBody.\n",
        name.to_owned(),
        dir,
        source,
    ))
}

fn plugin(plugin: &str) -> SkillSource {
    SkillSource::Plugin {
        plugin: plugin.to_owned(),
    }
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn a_bare_entry_grants_the_first_non_plugin_match_alone() {
    let skills = vec![
        skill("kit:review", "/plugin/review", plugin("kit")),
        skill("review", "/project/review", SkillSource::Project),
    ];
    let grant = resolve(&["review".to_owned()], &skills);
    assert_eq!(grant.identities, set(&["/project/review"]));
    assert!(grant.unresolved.is_empty());
}

#[test]
fn all_plugin_matches_of_a_bare_entry_are_granted_together() {
    let skills = vec![
        skill("kit:review", "/p1/review", plugin("kit")),
        skill("other:review", "/p2/review", plugin("other")),
    ];
    let grant = resolve(&["review".to_owned()], &skills);
    assert_eq!(grant.identities, set(&["/p1/review", "/p2/review"]));
}

#[test]
fn a_qualified_entry_matches_its_qualified_name_only() {
    let skills = vec![
        skill("kit:review", "/p1/review", plugin("kit")),
        skill("review", "/project/review", SkillSource::Project),
    ];
    let grant = resolve(&["kit:review".to_owned()], &skills);
    assert_eq!(grant.identities, set(&["/p1/review"]));
}

#[test]
fn blank_entries_are_skipped_and_unmatched_ones_are_reported() {
    let skills = vec![skill("review", "/project/review", SkillSource::Project)];
    let grant = resolve(
        &[" ".to_owned(), "missing".to_owned(), "review ".to_owned()],
        &skills,
    );
    assert_eq!(grant.unresolved, vec!["missing".to_owned()]);
    assert_eq!(grant.identities, set(&["/project/review"]));
}

#[test]
fn a_builtin_skill_has_its_own_identity() {
    let skills = vec![skill("loop", "", SkillSource::Builtin)];
    let grant = resolve(&["loop".to_owned()], &skills);
    assert_eq!(grant.identities, set(&["builtin:loop"]));
}

#[test]
fn the_filter_keeps_one_skill_per_identity_in_root_order() {
    let skills = vec![
        skill("review", "/same", SkillSource::Project),
        skill("review-copy", "/same", SkillSource::User),
        skill("other", "/other", SkillSource::Project),
    ];
    let granted = set(&["/same"]);
    let visible: Vec<String> = filter_granted(&skills, &granted)
        .iter()
        .map(|skill| skill.name.clone())
        .collect();
    assert_eq!(visible, vec!["review".to_owned()]);
}
