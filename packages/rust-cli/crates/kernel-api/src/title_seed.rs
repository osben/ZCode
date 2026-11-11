//! Fork: Node `sanitizeTitleSeed` (packages/shared/src/zcode-session-visible-content.ts), the text a first-input title
//! is derived from. Composer mentions (`[a.ts](./src/a.ts)`, `[@Linear](plugin://…)`, `[#Cache work](#sess_…)`,
//! `[$skill](…/SKILL.md)`) keep their label, bare `#sess_…` tokens are dropped, and the manual `/skill` prompt
//! template becomes its user request (or `$<skill>`).
//!
//! Node's patterns use a lookbehind, a lookahead and a backreference, which the `regex` crate does not have. Each
//! pattern is deterministic (its alternatives start with different characters, so a backtrack can never find another
//! match), so it is ported as a scanner with the same result, and it stays linear like Node's.

use rust_cli_base::js::string::{is_space, trim, utf16_prefix};

/// Node `MAX_TITLE_SEED_SCAN_CHARS`: only the head of a long paste can reach a title.
const MAX_SCAN_UNITS: usize = 8192;

/// Node `buildManualSkillPrompt`'s template (apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts).
const SKILL_HEAD: &str = "Use the skill named `";
const SKILL_CALL: &str = "` for this turn.\nFirst call the `Skill` tool with name `";
const SKILL_TAIL: &str = "` before doing the task.\nAfter the skill content is loaded, follow its instructions and continue.\n\n";
const SKILL_REQUEST: &str = "User request:\n";
const SKILL_NO_REQUEST: &str = "No additional user request was provided. Load the skill and respond according to its instructions.";

/// Node `sanitizeTitleSeed`. Known difference: a scan cut inside a surrogate pair keeps the whole character out, where
/// Node keeps a lone surrogate.
pub fn seed(input: &str) -> String {
    let scanned = utf16_prefix(input, MAX_SCAN_UNITS);
    let source = match manual_skill(trim(scanned)) {
        Some((_, Some(request))) if !trim(request).is_empty() => request.to_owned(),
        Some((name, _)) => format!("${name}"),
        None => scanned.to_owned(),
    };
    let sanitized = bare_sessions(&links(&source));
    if trim(&sanitized).is_empty() {
        input.to_owned()
    } else {
        sanitized
    }
}

/// Node `MANUAL_SKILL_PROMPT_PATTERN` on the trimmed text: the skill name and the user request (`None` for the
/// "no additional request" form).
fn manual_skill(text: &str) -> Option<(&str, Option<&str>)> {
    let rest = text.strip_prefix(SKILL_HEAD)?;
    // `([^`\n]+)`: the name ends at the first backtick.
    let end = rest.find('`')?;
    let name = &rest[..end];
    if name.is_empty() || name.contains('\n') {
        return None;
    }
    let rest = rest[end..].strip_prefix(SKILL_CALL)?;
    let rest = rest.strip_prefix(name)?;
    let rest = rest.strip_prefix(SKILL_TAIL)?;
    if let Some(request) = rest.strip_prefix(SKILL_REQUEST) {
        return Some((name, Some(request)));
    }
    (rest == SKILL_NO_REQUEST).then_some((name, None))
}

/// JS `.`: any character but a line terminator.
fn is_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Node `LINK_MENTION_PATTERN` replaced through `linkLabelToSeed`, left to right over the original text (its
/// lookbehind reads the original character before each `[`).
fn links(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        let preceded = at.checked_sub(1).is_some_and(
            |before| matches!(chars[before], 'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | ']' | ')'),
        );
        if chars[at] == '['
            && !preceded
            && let Some(link) = link_at(&chars, at)
        {
            let matched: String = chars[at..link.end].iter().collect();
            out.push_str(&label_to_seed(&matched, &link.label, &link.destination));
            at = link.end;
            continue;
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

struct Link {
    label: String,
    destination: String,
    /// One past the closing `)`.
    end: usize,
}

/// `(?:\\.|[^<excluded>\\])*` from `at`: the end of the run.
fn escaped_run(chars: &[char], mut at: usize, excluded: &[char]) -> usize {
    loop {
        match chars.get(at) {
            Some('\\') => match chars.get(at + 1) {
                Some(&next) if is_dot(next) => at += 2,
                _ => return at,
            },
            Some(c) if !excluded.contains(c) => at += 1,
            _ => return at,
        }
    }
}

/// One `[label](destination)` starting at the `[` at `at`.
fn link_at(chars: &[char], at: usize) -> Option<Link> {
    let label_end = escaped_run(chars, at + 1, &[']']);
    if chars.get(label_end) != Some(&']') || chars.get(label_end + 1) != Some(&'(') {
        return None;
    }
    let label: String = chars[at + 1..label_end].iter().collect();
    let open = label_end + 2;
    // `<((?:\\.|[^>\\])*)>` first; when it does not close with `>)`, the plain form is tried from the same place.
    if chars.get(open) == Some(&'<') {
        let close = escaped_run(chars, open + 1, &['>']);
        if chars.get(close) == Some(&'>') && chars.get(close + 1) == Some(&')') {
            return Some(Link {
                label,
                destination: chars[open + 1..close].iter().collect(),
                end: close + 2,
            });
        }
    }
    // `((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*)\)`: one level of balanced parentheses.
    let mut end = open;
    loop {
        end = escaped_run(chars, end, &['(', ')']);
        if chars.get(end) != Some(&'(') {
            break;
        }
        let inner = escaped_run(chars, end + 1, &['(', ')']);
        if chars.get(inner) != Some(&')') {
            break;
        }
        end = inner + 1;
    }
    (chars.get(end) == Some(&')')).then(|| Link {
        label,
        destination: chars[open..end].iter().collect(),
        end: end + 1,
    })
}

/// Node `unescapeMarkdownLabel`: `\\(.)` → `$1`.
fn unescape(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && is_dot(next)
        {
            out.push(next);
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

/// Node `MENTION_DESTINATION_PATTERN`: paths, Windows drive paths, `file:`, plugin and session ids.
fn is_mention_destination(destination: &str) -> bool {
    let bytes = destination.as_bytes();
    destination.starts_with('/')
        || destination.starts_with("./")
        || destination.starts_with("../")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
        || destination.starts_with("file:")
        || destination.starts_with("plugin://")
        || destination.starts_with("#sess_")
}

/// `[a-zA-Z0-9._-]`.
fn is_session_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// Node `linkLabelToSeed`.
fn label_to_seed(matched: &str, raw_label: &str, destination: &str) -> String {
    let label = unescape(raw_label);
    if !label.starts_with('$') && !is_mention_destination(destination) {
        return matched.to_owned();
    }
    let strip = |prefix: char| label.strip_prefix(prefix).unwrap_or(&label).to_owned();
    if destination.starts_with("plugin://") {
        return strip('@');
    }
    if let Some(id) = destination.strip_prefix("#sess_")
        && !id.is_empty()
        && id.chars().all(is_session_char)
    {
        return strip('#');
    }
    if label.starts_with('$') {
        return label;
    }
    strip('@')
}

/// Node `BARE_SESSION_TOKEN_PATTERN` (`(^|\s)#sess_[a-zA-Z0-9._-]+(?=$|\s)` → `$1`): drops the token, keeps the
/// whitespace before it.
fn bare_sessions(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        let starts = at == 0 || is_space(chars[at - 1]);
        if starts && chars[at..].starts_with(&['#', 's', 'e', 's', 's', '_']) {
            let mut end = at + 6;
            while chars.get(end).copied().is_some_and(is_session_char) {
                end += 1;
            }
            if end > at + 6 && chars.get(end).is_none_or(|&c| is_space(c)) {
                at = end;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

#[cfg(test)]
#[path = "title_seed_tests.rs"]
mod tests;
