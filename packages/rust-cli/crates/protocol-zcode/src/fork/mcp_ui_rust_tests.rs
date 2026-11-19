use serde_json::{Value, json};

use super::{
    base64_decoded_len, bound_contents, call_key, mime_allowed, visibility_error, workspace_key,
};

#[test]
fn mime_allowlist_matches_prefixes_and_exact_essences() {
    assert!(mime_allowed("text/html"));
    assert!(mime_allowed("Text/HTML; charset=utf-8"));
    assert!(mime_allowed("application/json"));
    assert!(mime_allowed("image/svg+xml"));
    assert!(!mime_allowed("application/javascript"));
    assert!(!mime_allowed("application/x-msdownload"));
    assert!(!mime_allowed(""));
    assert!(!mime_allowed("   "));
}

#[test]
fn base64_length_counts_the_decoded_bytes() {
    assert_eq!(base64_decoded_len("aGVsbG8="), 5);
    assert_eq!(base64_decoded_len("aGVsbG8h"), 6);
    assert_eq!(base64_decoded_len(""), 0);
}

#[test]
fn bound_contents_strips_meta_and_keeps_allowed_items() {
    let contents = vec![json!({
        "uri": "ui://a",
        "mimeType": "text/html",
        "text": "<p>hi</p>",
        "_meta": {"ui": {"csp": {}}},
    })];
    let (bounded, bytes) = bound_contents("ui://a", &contents).expect("allowed");
    assert_eq!(bytes, 9);
    assert_eq!(
        bounded,
        vec![json!({"uri": "ui://a", "mimeType": "text/html", "text": "<p>hi</p>"})]
    );
}

#[test]
fn bound_contents_refuses_a_disallowed_mime_and_a_blob_without_one() {
    let refused = bound_contents(
        "ui://a",
        &[json!({"uri": "ui://a", "mimeType": "application/javascript", "text": "x"})],
    )
    .unwrap_err();
    assert_eq!(refused.code, -32001);
    assert_eq!(refused.data.as_ref().unwrap()["reason"], "mime_not_allowed");

    let no_mime =
        bound_contents("ui://a", &[json!({"uri": "ui://a", "blob": "aGk="})]).unwrap_err();
    assert_eq!(
        no_mime.data.as_ref().unwrap()["detail"]["mimeType"],
        "(missing)"
    );
}

#[test]
fn bound_contents_refuses_more_than_eight_mebibytes() {
    let text = "a".repeat(8 * 1024 * 1024 + 1);
    let refused = bound_contents(
        "ui://big",
        &[json!({"uri": "ui://big", "mimeType": "text/plain", "text": text})],
    )
    .unwrap_err();
    assert_eq!(refused.data.as_ref().unwrap()["reason"], "too_large");
    let fits = "a".repeat(8 * 1024 * 1024);
    assert!(
        bound_contents(
            "ui://big",
            &[json!({"uri": "ui://big", "mimeType": "text/plain", "text": fits})]
        )
        .is_ok()
    );
}

#[test]
fn a_tool_must_exist_and_name_the_app_in_its_visibility() {
    assert!(visibility_error(Some(&["app".to_owned()]), "s", "t").is_none());
    let missing = visibility_error(None, "s", "t").expect("missing tool refused");
    assert_eq!(missing.data.as_ref().unwrap()["reason"], "tool_not_found");
    let model_only =
        visibility_error(Some(&["model".to_owned()]), "s", "t").expect("model-only refused");
    assert_eq!(
        model_only.data.as_ref().unwrap()["reason"],
        "tool_not_app_visible"
    );
    let empty = visibility_error(Some(&[]), "s", "t").expect("no visibility refused");
    assert_eq!(
        empty.data.as_ref().unwrap()["reason"],
        "tool_not_app_visible"
    );
}

#[test]
fn the_workspace_key_prefers_the_identity_and_falls_back_to_the_path() {
    let by_identity: Value =
        json!({"workspace": {"workspaceIdentity": " id-1 ", "workspacePath": "/w"}});
    assert_eq!(workspace_key(&by_identity), "id-1");
    let by_path: Value = json!({"workspace": {"workspaceIdentity": "  ", "workspacePath": "/w"}});
    assert_eq!(workspace_key(&by_path), "/w");
}

#[test]
fn a_call_id_is_scoped_to_its_session_and_instance() {
    assert_ne!(call_key("s1", "t1", "c1"), call_key("s2", "t1", "c1"));
    assert_ne!(call_key("s1", "t1", "c1"), call_key("s1", "t2", "c1"));
}
