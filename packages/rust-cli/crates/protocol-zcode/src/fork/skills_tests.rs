use rust_cli_kernel_api::user_command::{SkillReference, SkillScope};
use serde_json::json;

use super::result;

fn skill(name: &str, path: &str, scope: SkillScope, plugin: Option<&str>) -> SkillReference {
    SkillReference {
        name: name.to_owned(),
        description: format!("{name} description"),
        path: path.to_owned(),
        scope,
        plugin: plugin.map(str::to_owned),
    }
}

#[test]
fn entries_follow_the_node_catalog_shape() {
    let value = result(
        "workspace",
        &[
            skill(
                "review",
                "/w/.zcode/skills/review/SKILL.md",
                SkillScope::Workspace,
                None,
            ),
            skill(
                "lint",
                "/p/skills/lint/SKILL.md",
                SkillScope::Plugin,
                Some("tools"),
            ),
        ],
    );
    assert_eq!(
        value,
        json!({"authority": "workspace", "skills": [
            {"id": "glm:workspace:/w/.zcode/skills/review/SKILL.md", "name": "review",
             "description": "review description", "path": "/w/.zcode/skills/review/SKILL.md",
             "scope": "workspace", "enabled": true},
            {"id": "glm:plugin:/p/skills/lint/SKILL.md", "name": "lint",
             "description": "lint description", "path": "/p/skills/lint/SKILL.md",
             "scope": "plugin", "enabled": true, "pluginName": "tools"},
        ]})
    );
}

#[test]
fn entries_without_a_name_are_left_out() {
    let value = result(
        "session",
        &[skill("", "/u/SKILL.md", SkillScope::User, None)],
    );
    assert_eq!(value, json!({"authority": "session", "skills": []}));
}
