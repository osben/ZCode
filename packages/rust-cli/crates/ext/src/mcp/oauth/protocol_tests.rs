//! Red tests for discovery order, PKCE, DCR and the callback check (PR2 acceptance 4, 5, 6, 7).
//! Discovery order is copied from the MCP SDK `buildDiscoveryUrls` and `discoverMetadataWithFallback`.

use super::callback::{CallbackError, parse_callback_target};
use super::pkce::{code_challenge, verifier_from_bytes};
use super::protocol::{
    as_metadata_urls, prm_urls, registration_body, token_form_authorization_code,
};

#[test]
fn as_metadata_urls_without_path_use_oauth_then_openid_at_origin() {
    let urls = as_metadata_urls("https://auth.example.test/").expect("urls");
    assert_eq!(
        urls,
        vec![
            "https://auth.example.test/.well-known/oauth-authorization-server",
            "https://auth.example.test/.well-known/openid-configuration",
        ]
    );
}

#[test]
fn as_metadata_urls_with_path_insert_the_path_as_the_sdk_does() {
    let urls = as_metadata_urls("https://auth.example.test/tenant1").expect("urls");
    assert_eq!(
        urls,
        vec![
            "https://auth.example.test/.well-known/oauth-authorization-server/tenant1",
            "https://auth.example.test/.well-known/openid-configuration/tenant1",
            "https://auth.example.test/tenant1/.well-known/openid-configuration",
        ]
    );
}

#[test]
fn prm_urls_try_the_path_inserted_form_then_root() {
    // SDK: buildWellKnownPath (no prependPathname) then `/.well-known/<type>` at the root.
    let urls = prm_urls("https://mcp.example.test/mcp").expect("urls");
    assert_eq!(
        urls,
        vec![
            "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
            "https://mcp.example.test/.well-known/oauth-protected-resource",
        ]
    );
}

#[test]
fn prm_urls_for_a_root_server_are_one_url() {
    let urls = prm_urls("https://mcp.example.test/").expect("urls");
    assert_eq!(
        urls,
        vec!["https://mcp.example.test/.well-known/oauth-protected-resource"]
    );
}

#[test]
fn pkce_challenge_matches_rfc7636_appendix_b() {
    // RFC 7636 Appendix B: the S256 challenge of this verifier.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert_eq!(
        code_challenge(verifier),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn pkce_verifier_from_32_bytes_is_43_url_safe_chars() {
    let verifier = verifier_from_bytes(&[0xAB; 32]);
    assert_eq!(verifier.len(), 43);
    assert!(
        verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
}

#[test]
fn dcr_body_registers_the_current_callback_url_and_auth_code_grant() {
    let body = registration_body(
        "http://127.0.0.1:49152/callback",
        "zcode-test",
        Some("mcp:tools"),
    );
    assert_eq!(
        body["redirect_uris"],
        serde_json::json!(["http://127.0.0.1:49152/callback"])
    );
    assert_eq!(
        body["grant_types"],
        serde_json::json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(body["response_types"], serde_json::json!(["code"]));
    assert_eq!(body["scope"], serde_json::json!("mcp:tools"));
    assert_eq!(body["client_name"], serde_json::json!("zcode-test"));
}

#[test]
fn authorization_code_token_form_carries_verifier_and_redirect() {
    let form =
        token_form_authorization_code("the-code", "verifier-x", "http://127.0.0.1:1/callback");
    assert!(form.contains("grant_type=authorization_code"));
    assert!(form.contains("code=the-code"));
    assert!(form.contains("code_verifier=verifier-x"));
    assert!(form.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback"));
}

#[test]
fn callback_with_the_right_state_yields_the_code() {
    let params =
        parse_callback_target("/callback?code=abc&state=s1", "/callback", "s1").expect("callback");
    assert_eq!(params.code, "abc");
}

#[test]
fn callback_with_a_wrong_state_is_rejected_and_keeps_waiting() {
    assert_eq!(
        parse_callback_target("/callback?code=abc&state=evil", "/callback", "s1"),
        Err(CallbackError::StateMismatch)
    );
}

#[test]
fn callback_on_another_path_is_not_the_callback() {
    assert_eq!(
        parse_callback_target("/other?code=abc&state=s1", "/callback", "s1"),
        Err(CallbackError::NotCallbackPath)
    );
}

#[test]
fn callback_with_an_authorization_error_reports_it_without_a_code() {
    assert_eq!(
        parse_callback_target("/callback?error=access_denied&state=s1", "/callback", "s1"),
        Err(CallbackError::Denied("access_denied".to_owned()))
    );
}
