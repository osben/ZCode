//! Red tests for the `WWW-Authenticate` parser (`specs/fork-rust-mcp-oauth.md`, PR3 follow-up: 403 and
//! `resource_metadata`). RFC 6750 section 3 challenge parameters; quoted or bare values.

use super::challenge::{Challenge, parse_www_authenticate};

#[test]
fn insufficient_scope_carries_the_scope_and_the_resource_metadata() {
    let parsed = parse_www_authenticate(
        "Bearer error=\"insufficient_scope\", scope=\"mcp:read mcp:write\", \
         resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource/mcp\"",
    );
    assert_eq!(
        parsed,
        Some(Challenge {
            error: Some("insufficient_scope".to_owned()),
            scope: Some("mcp:read mcp:write".to_owned()),
            resource_metadata: Some(
                "https://mcp.example.test/.well-known/oauth-protected-resource/mcp".to_owned()
            ),
        })
    );
}

#[test]
fn a_bare_bearer_challenge_has_no_parameters() {
    assert_eq!(
        parse_www_authenticate("Bearer"),
        Some(Challenge {
            error: None,
            scope: None,
            resource_metadata: None,
        })
    );
}

#[test]
fn unquoted_values_are_read() {
    let parsed = parse_www_authenticate("Bearer error=invalid_token, scope=mcp:read");
    assert_eq!(
        parsed.as_ref().and_then(|c| c.error.as_deref()),
        Some("invalid_token")
    );
    assert_eq!(
        parsed.as_ref().and_then(|c| c.scope.as_deref()),
        Some("mcp:read")
    );
}

#[test]
fn other_schemes_are_not_bearer_challenges() {
    assert_eq!(parse_www_authenticate("Basic realm=\"x\""), None);
}

#[test]
fn an_escaped_quote_inside_a_value_does_not_end_it() {
    let parsed = parse_www_authenticate("Bearer resource_metadata=\"https://x/\\\"y\\\"\"");
    assert_eq!(
        parsed.and_then(|c| c.resource_metadata),
        Some("https://x/\"y\"".to_owned())
    );
}
