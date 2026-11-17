use super::*;

/// 收拢前的三种写法（逐字照抄）：kernel-api 的 `(units + 2) / 4`、runtime 的 `(units * 2 + per) / (per * 2)`、
/// tools 的浮点 `round`。
#[test]
fn estimate_matches_the_old_formulas() {
    for units in 0..100_000_u64 {
        assert_eq!(estimate(units, CHARS_PER_TOKEN), (units + 2) / 4, "{units}");
        for per in [
            JSON_CHARS_PER_TOKEN,
            NEWER_MODEL_CHARS_PER_TOKEN,
            CHARS_PER_TOKEN,
        ] {
            assert_eq!(estimate(units, per), (units * 2 + per) / (per * 2));
            assert_eq!(
                estimate(units, per),
                (units as f64 / per as f64).round() as u64,
                "{units} / {per}"
            );
        }
    }
}

/// Node's `estimateTokens` (apps/zcode-cli/packages/core/src/context/utils.ts) with `ESTIMATED_TOKEN_CHAR_DIVISOR = 3`.
/// Expected values are Node's own output (2026-11-16, verbatim copies of the two functions run under Node 26).
#[test]
fn estimate_text_matches_node_estimate_tokens() {
    let cases: [(&str, u64); 11] = [
        ("", 0),
        ("abcd", 2),
        ("中文😀", 2),
        ("\u{4dff}", 1),
        ("\u{4e00}", 1),
        ("\u{9fff}", 1),
        ("\u{a000}", 1),
        ("𠀀", 1),
        ("a\u{4e00}b\u{9fff}c", 3),
        ("line\nwith \"quotes\" and \\ backslash\t", 12),
        ("中中中中中中中xxxxx", 7),
    ];
    for (text, tokens) in cases {
        assert_eq!(estimate_text(text), tokens, "{text:?}");
    }
}
