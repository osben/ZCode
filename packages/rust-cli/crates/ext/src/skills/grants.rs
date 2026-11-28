//! Fork (rule 17, specs/fork-rust-subagent-runtime-config.md): the skills a subagent's `skills` list grants.
//!
//! The grant is a set of physical identities (a skill's directory; `builtin:<name>` for a bundled skill). Node
//! `resolveSubagentSkillGrants` and `filterSkillsByGrants`.

use std::collections::HashSet;
use std::sync::Arc;

use super::{Skill, SkillSource};

/// The grant one `skills` list resolves to against one discovery.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub(crate) identities: HashSet<String>,
    /// Entries that matched no discovered skill, in the order given.
    pub(crate) unresolved: Vec<String>,
}

/// The physical identity of a skill (Node `skillIdentity`).
pub(crate) fn identity(skill: &Skill) -> String {
    if skill.dir.is_empty() {
        format!("builtin:{}", skill.name)
    } else {
        skill.dir.clone()
    }
}

/// Resolves `entries` against `skills` (in discovery order). A qualified entry (it contains `:` or `/`) matches the
/// skill's call name exactly; a bare entry matches the skill's own name, and for a plugin skill the part after `:`.
/// A bare entry takes the first non-plugin match alone; when all matches are plugin skills it takes them all.
pub(crate) fn resolve(entries: &[String], skills: &[Arc<Skill>]) -> Resolved {
    let mut resolved = Resolved::default();
    for raw in entries {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        let qualified = entry.contains(':') || entry.contains('/');
        let matches: Vec<&Arc<Skill>> = skills
            .iter()
            .filter(|skill| {
                if qualified {
                    skill.name == entry
                } else {
                    skill.name == entry || bare(skill) == entry
                }
            })
            .collect();
        if matches.is_empty() {
            resolved.unresolved.push(entry.to_owned());
            continue;
        }
        let first_non_plugin = if qualified {
            None
        } else {
            matches
                .iter()
                .find(|skill| !matches!(skill.source, SkillSource::Plugin { .. }))
        };
        let granted: Vec<&Arc<Skill>> = match first_non_plugin {
            Some(skill) => vec![skill],
            None => matches,
        };
        for skill in granted {
            resolved.identities.insert(identity(skill));
        }
    }
    resolved
}

/// The part of a plugin skill's call name after the plugin prefix (`kit:review` gives `review`).
pub(super) fn bare(skill: &Skill) -> &str {
    match skill.source {
        SkillSource::Plugin { .. } => skill
            .name
            .split_once(':')
            .map_or(skill.name.as_str(), |(_, bare)| bare),
        _ => skill.name.as_str(),
    }
}

/// The skills whose identity is granted, one per identity, in discovery (root) order.
pub(crate) fn filter_granted(skills: &[Arc<Skill>], granted: &HashSet<String>) -> Vec<Arc<Skill>> {
    let mut seen = HashSet::new();
    skills
        .iter()
        .filter(|skill| {
            let id = identity(skill);
            granted.contains(&id) && seen.insert(id)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
#[path = "grants_tests.rs"]
mod tests;
