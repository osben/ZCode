//! Slash command names a custom command or a skill may not take (Node `isReservedZCodeSlashCommandName`,
//! `packages/bootstrap/src/slash-command-surface.ts`). The catalog (`protocol-zcode`) and the expansion (`ext`) both read
//! this list, so a same-named skill cannot take a built-in's place in either. W9b-2 (9.57).

/// Every built-in help-entry name and alias (`packages/shared/src/zcode-slash-command-help.ts`), plus `compress` and
/// `plan` (Composer-local). 29 names, as Node's `RESERVED_SLASH_COMMAND_NAMES`.
const RESERVED: [&str; 29] = [
    "help", "login", "logout", "compact", "dream", "init", "expert", "variant", "effort", "dwf",
    "fork", "language", "locale", "mcp", "plugin", "plugins", "mode", "model", "clear", "new",
    "continue", "resume", "rewind", "skill", "target", "goal", "workflow", "compress", "plan",
];

/// Node `normalizeZCodeSlashCommandName`: trim, drop the leading slashes, lowercase.
pub fn normalize_slash_command_name(name: &str) -> String {
    name.trim().trim_start_matches('/').to_lowercase()
}

/// Whether a custom command or skill may not take this name.
pub fn is_reserved_slash_name(name: &str) -> bool {
    let normalized = normalize_slash_command_name(name);
    RESERVED.contains(&normalized.as_str())
}

/// The one rule for offering a slash command (expansion, the desktop catalog and the TUI shelf all read it): the runtime's
/// own built-in skill is always offered, and any other command with a reserved name is not.
pub fn offered(name: &str, builtin: bool) -> bool {
    builtin || !is_reserved_slash_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_built_in_name_and_alias_is_reserved() {
        for name in [
            "help", "model", "clear", "continue", "target", "language", "plugin", "skill", "goal",
            "workflow", "compact", "init", "dream", "compress", "plan",
        ] {
            assert!(is_reserved_slash_name(name), "{name} is reserved");
        }
    }

    #[test]
    fn the_match_is_normalized_as_node_does() {
        assert!(is_reserved_slash_name("Plan"), "case is ignored");
        assert!(
            is_reserved_slash_name("/GOAL"),
            "a leading slash is ignored"
        );
        assert!(
            is_reserved_slash_name("  /workflow  "),
            "surrounding space is ignored"
        );
        assert!(
            is_reserved_slash_name("//model"),
            "every leading slash is dropped"
        );
    }

    #[test]
    fn a_built_in_skill_is_offered_and_a_reserved_custom_command_is_not() {
        assert!(
            offered("init", true),
            "the runtime's built-in init is offered"
        );
        assert!(!offered("init", false), "a user init is not offered");
        assert!(
            !offered("Model", false),
            "a reserved custom name is not offered"
        );
        assert!(offered("review", false), "a free custom name is offered");
    }

    #[test]
    fn a_custom_name_is_free() {
        assert!(!is_reserved_slash_name("review"));
        assert!(!is_reserved_slash_name("greet"));
    }
}
