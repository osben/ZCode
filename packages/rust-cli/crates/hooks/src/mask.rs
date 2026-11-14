//! Fork: Node's masking of hook text shown to the user (`sanitizeHookDisplayText`, `core/src/hooks/display-metadata.ts`)
//! and its preview rules (`trimForPreview`, `sanitizeHookDiagnostics`; specs/fork-rust-agent-parity.md HK-UP-01).

use std::sync::LazyLock;

use regex::Regex;

const MASK: &str = "••••";
/// Node's preview cap, in characters.
const PREVIEW_CHARS: usize = 4000;

const SENSITIVE_KEY: &str =
    "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";

/// Node `SENSITIVE_IDENTIFIER`.
fn identifier() -> String {
    format!("(?:[A-Za-z0-9]+[_-])*{SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*")
}

/// Node's patterns in its order, each with its replacement. JavaScript's `\b` is ASCII even under `u`.
static PATTERNS: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    let id = identifier();
    let value = r#"(?:"[^"]*"|'[^']*'|[^\s,"']+)"#;
    [
        (
            r"(?i)([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@".to_owned(),
            format!("${{1}}{MASK}:{MASK}@"),
        ),
        (
            r#"(?i)(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)"#
                .to_owned(),
            format!("${{1}}{MASK}"),
        ),
        (
            format!(r#"(?i)([?&](?:authorization|{id})=)[^&\s"']+"#),
            format!("${{1}}{MASK}"),
        ),
        (
            format!(r"(?i)((?-u:\b)authorization(?-u:\b)\s*=\s*){value}"),
            format!("${{1}}{MASK}"),
        ),
        (
            format!(r#"(?i)((?:"{id}"|'{id}')\s*[:=]\s*){value}"#),
            format!("${{1}}{MASK}"),
        ),
        (
            format!(r"(?im)(^|[^A-Za-z0-9_])({id}\s*[:=]\s*){value}"),
            format!("${{1}}${{2}}{MASK}"),
        ),
        (
            format!(r#"(?i)((?:--)?{id})(\s+)(?:"[^"]*"|'[^']*'|[^\s]+)"#),
            format!("${{1}}${{2}}{MASK}"),
        ),
    ]
    .into_iter()
    .map(|(pattern, replacement)| {
        #[expect(clippy::expect_used, reason = "the patterns are constants")]
        let regex = Regex::new(&pattern).expect("hook mask pattern");
        (regex, replacement)
    })
    .collect()
});

/// Node `sanitizeHookDisplayText`.
pub(crate) fn text(value: &str) -> String {
    PATTERNS
        .iter()
        .fold(value.to_owned(), |text, (regex, replacement)| {
            regex.replace_all(&text, replacement.as_str()).into_owned()
        })
}

/// Node `trimForPreview`: trimmed, capped at 4000 characters with `...`; `None` when empty.
pub(crate) fn preview(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= PREVIEW_CHARS {
        return Some(trimmed.to_owned());
    }
    Some(format!(
        "{}...",
        trimmed.chars().take(PREVIEW_CHARS).collect::<String>()
    ))
}

/// A diagnostic of a blocked run: Node's `trimForPreview`, then `sanitizeHookDiagnostics` (trim, mask, 4000
/// characters).
pub(crate) fn diagnostic(value: &str) -> Option<String> {
    let previewed = preview(value)?;
    let masked = text(previewed.trim());
    Some(masked.chars().take(PREVIEW_CHARS).collect())
}
