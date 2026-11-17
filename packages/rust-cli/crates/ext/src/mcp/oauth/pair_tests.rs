//! Node `deriveCredentialPair` branches (`specs/fork-rust-mcp-oauth.md`, PR4 (c)). Each case is one branch of
//! `oauth-credentials.ts`, in Node's order.

use serde_json::json;

use super::flow::union_scopes;
use super::pair::derive_pair;

fn canonical(version: i64, client: &str, access: &str, refresh: Option<&str>) -> String {
    let mut tokens = json!({"access_token": access, "token_type": "Bearer"});
    if let Some(refresh) = refresh {
        tokens["refresh_token"] = json!(refresh);
    }
    json!({
        "client_information": {"client_id": client},
        "tokens": tokens,
        "generation": "gen-1",
        "issuer": "https://auth.example.test",
        "expires_at": 1_700_003_600_000i64,
        "published_by": "att-1",
        "version": version,
    })
    .to_string()
}

fn tokens(access: &str) -> String {
    json!({"access_token": access, "token_type": "Bearer", "refresh_token": "r"}).to_string()
}

fn client(id: &str) -> String {
    json!({"client_id": id}).to_string()
}

#[test]
fn a_legacy_only_record_is_a_pair_without_generation_or_raw() {
    let pair = derive_pair(None, Some(&client("c")), Some(&tokens("old"))).expect("pair");
    assert_eq!(pair.access_token().as_deref(), Some("old"));
    assert_eq!(pair.client, Some(json!({"client_id": "c"})));
    assert!(pair.generation.is_none() && pair.raw.is_none());
    assert!(derive_pair(None, None, None).is_none());
}

#[test]
fn a_v2_record_whose_legacy_tokens_were_removed_is_invalid_as_node_treats_it() {
    // Node keeps the client and drops the tokens: an older provider invalidated them.
    let pair = derive_pair(
        Some(&canonical(2, "c", "a", Some("r"))),
        Some(&client("c")),
        None,
    )
    .expect("pair");
    assert!(pair.tokens.is_none());
    assert_eq!(pair.client, Some(json!({"client_id": "c"})));
}

#[test]
fn a_v2_record_with_its_mirror_is_canonical() {
    let raw = canonical(2, "c", "a", Some("r"));
    let pair = derive_pair(
        Some(&raw),
        Some(&client("c")),
        Some(
            &json!({"access_token": "a", "token_type": "Bearer", "refresh_token": "r"}).to_string(),
        ),
    )
    .expect("pair");
    assert_eq!(pair.access_token().as_deref(), Some("a"));
    assert_eq!(pair.raw.as_deref(), Some(raw.as_str()));
    assert_eq!(pair.generation.as_deref(), Some("gen-1"));
    assert_eq!(pair.expires_at, Some(1_700_003_600_000));
}

#[test]
fn a_v1_record_adopts_a_legacy_token_when_the_client_is_unchanged() {
    let pair = derive_pair(
        Some(&canonical(1, "c", "a", None)),
        Some(&client("c")),
        Some(&tokens("from-legacy")),
    )
    .expect("pair");
    assert_eq!(pair.access_token().as_deref(), Some("from-legacy"));
    assert!(
        pair.raw.is_none(),
        "an adopted legacy token has no canonical raw"
    );
}

#[test]
fn a_changed_client_and_token_are_never_combined() {
    let raw = canonical(2, "c", "a", Some("r"));
    let pair = derive_pair(Some(&raw), Some(&client("other")), Some(&tokens("x"))).expect("pair");
    assert!(pair.tokens.is_none(), "no token may be guessed");
    assert_eq!(pair.client, Some(json!({"client_id": "other"})));
}

#[test]
fn a_legacy_token_that_matches_the_canonical_one_keeps_the_canonical_record() {
    let canonical_tokens =
        json!({"access_token": "a", "token_type": "Bearer", "refresh_token": "r"});
    let raw = canonical(2, "c", "a", Some("r"));
    let pair = derive_pair(
        Some(&raw),
        Some(&client("c")),
        Some(&canonical_tokens.to_string()),
    )
    .expect("pair");
    assert_eq!(pair.raw.as_deref(), Some(raw.as_str()));
}

#[test]
fn the_union_keeps_the_configured_scope_first_and_drops_repeats() {
    assert_eq!(
        union_scopes(&[Some("a b"), Some("c a"), Some("d")]).as_deref(),
        Some("a b c d")
    );
    assert_eq!(union_scopes(&[None, None]), None);
}
