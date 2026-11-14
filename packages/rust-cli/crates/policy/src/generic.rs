//! Fork: content rules on a tool with no permission subject, such as an MCP tool (specs/fork-rust-agent-parity.md,
//! "Content rules on MCP tools"). Node matches `Tool(content)` against the input's subject for every tool
//! (`PermissionService.ruleSubjects` / `matchesRuleContent`); Rust only had subjects for shell, path, URL and skill
//! tools, so a content rule on any other tool never matched, including the rule "always allow" remembers for it.

use rust_cli_kernel_api::permission::RuleBehavior;
use serde_json::Value;

use crate::check::{AskKind, Check, Inputs};
use crate::texts;

/// Node `ruleSubjects`: the input's fields that a content rule is matched against, first string wins.
const SUBJECT_FIELDS: &[&str] = &[
    "command",
    "url",
    "file_path",
    "path",
    "pattern",
    "patch_text",
];

/// The subject a content rule is matched against: a string input itself, or the first string field.
fn subject(input: &Value) -> Option<&str> {
    if let Some(text) = input.as_str() {
        return Some(text);
    }
    let fields = input.as_object()?;
    SUBJECT_FIELDS
        .iter()
        .find_map(|field| fields.get(*field).and_then(Value::as_str))
}

/// Node `matchesRuleContent`: `x:*` is `x` alone or followed by a space or tab, a `*` matches any text within one
/// line, otherwise the content must be equal.
fn matches(subject: &str, content: &str) -> bool {
    if let Some(prefix) = content.strip_suffix(":*") {
        return subject
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '\t']));
    }
    if content.contains('*') {
        return wildcard(subject, content);
    }
    subject == content
}

/// `^part*part*part$` with literal parts (Node `wildcardToRegExp`). Node's `.*` has no `s` flag, so the text a `*`
/// stands for holds no line terminator. Taking each part at its first match is enough: a later match only makes the
/// gap before it longer.
fn wildcard(subject: &str, pattern: &str) -> bool {
    let gap = |text: &str| !text.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = subject.strip_prefix(first) else {
        return false;
    };
    let middle: Vec<&str> = parts.collect();
    let Some((last, middle)) = middle.split_last() else {
        return rest.is_empty();
    };
    for part in middle {
        match rest.find(part) {
            Some(at) if gap(&rest[..at]) => rest = &rest[at + part.len()..],
            _ => return false,
        }
    }
    rest.strip_suffix(last).is_some_and(gap)
}

/// The built-in check of a tool with no subject: its content deny, ask and allow rules, in that order.
pub(crate) fn check(tool: &str, input: &Value, inputs: &Inputs<'_>) -> Check {
    let passthrough = Check::Passthrough {
        reason: None,
        suggestions: Vec::new(),
    };
    let Some(subject) = subject(input) else {
        return passthrough;
    };
    let hit = |behavior| {
        inputs
            .rules
            .contents(tool, behavior)
            .iter()
            .any(|(content, _)| matches(subject, content))
    };
    if hit(RuleBehavior::Deny) {
        return Check::deny(texts::tool_denied(tool));
    }
    if hit(RuleBehavior::Ask) {
        return Check::Ask {
            message: texts::request_message(tool, None),
            kind: AskKind::Rule,
            suggestions: Vec::new(),
        };
    }
    if hit(RuleBehavior::Allow) {
        return Check::Allow;
    }
    passthrough
}
