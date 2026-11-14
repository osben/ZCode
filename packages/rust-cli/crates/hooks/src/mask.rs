//! Fork: Node's masking of hook text shown to the user (`sanitizeHookDisplayText`, `core/src/hooks/display-metadata.ts`)
//! and its preview rules (`trimForPreview`, `sanitizeHookDiagnostics`; specs/fork-rust-agent-parity.md HK-UP-01).

/// Node `sanitizeHookDisplayText`.
#[cfg_attr(not(test), expect(dead_code, reason = "the HK-UP-01 fix wires it"))]
pub(crate) fn text(value: &str) -> String {
    value.to_owned()
}

/// Node `trimForPreview`: trimmed, capped at 4000 characters with `...`; `None` when empty.
#[cfg_attr(not(test), expect(dead_code, reason = "the HK-UP-01 fix wires it"))]
pub(crate) fn preview(_value: &str) -> Option<String> {
    None
}

/// A diagnostic of a blocked run: Node's `trimForPreview`, then `sanitizeHookDiagnostics` (trim, mask, 4000
/// characters).
#[cfg_attr(not(test), expect(dead_code, reason = "the HK-UP-01 fix wires it"))]
pub(crate) fn diagnostic(_value: &str) -> Option<String> {
    None
}
