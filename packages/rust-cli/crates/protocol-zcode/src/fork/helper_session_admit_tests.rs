//! Fork: which session-scoped calls Rust forwards to the Node helper (specs/fork-rust-node-helper.md F3,
//! "Session-scoped forwarded methods").

use serde_json::json;

use super::*;
use crate::fork::node_helper::HelperCatalog;

fn catalog() -> HelperCatalog {
    HelperCatalog {
        workspace: json!({"workspacePath": "/w"}),
        plugin_ids: vec!["viewer@inline".to_owned(), "skills@inline".to_owned()],
        helper_plugins: vec!["viewer@inline".to_owned()],
        servers: vec!["plugin:viewer:view".to_owned()],
    }
}

/// The stored workspace key of a session of this process's workspace (`/w`, stored with no `workspace_id`).
const OWN: Option<&str> = Some("/w");

fn reason(error: Option<RpcError>) -> Option<(i64, Value)> {
    error.map(|error| (error.code, error.data.unwrap_or_default()))
}

fn not_hosted() -> Option<(i64, Value)> {
    Some((
        -32602,
        json!({"reasonCode": MCP_UI_SERVER_NOT_HELPER_HOSTED}),
    ))
}

#[test]
fn a_helper_hosted_server_of_an_own_session_is_forwarded() {
    let params =
        json!({"sessionId": "s1", "pluginId": "viewer@inline", "serverName": "plugin:viewer:view"});
    assert!(refusal("mcp/uiCallTool", &params, OWN, Some(&catalog())).is_none());
    // Methods without a server name check the session only.
    assert!(
        refusal(
            "mcp/uiCancelCall",
            &json!({"sessionId": "s1", "callId": "c"}),
            OWN,
            Some(&catalog())
        )
        .is_none()
    );
}

#[test]
fn a_server_rust_runs_itself_is_refused() {
    let params = json!({"sessionId": "s1", "pluginId": "user", "serverName": "github"});
    assert_eq!(
        reason(refusal(
            "mcp/uiOpenInstance",
            &params,
            OWN,
            Some(&catalog())
        )),
        not_hosted()
    );
    // Without a catalog nothing is helper-hosted.
    let hosted = json!({"sessionId": "s1", "serverName": "plugin:viewer:view"});
    assert_eq!(
        reason(refusal("mcp/readResource", &hosted, OWN, None)),
        not_hosted()
    );
}

#[test]
fn a_session_rust_does_not_own_is_refused() {
    let params = json!({"sessionId": "elsewhere", "serverName": "plugin:viewer:view"});
    assert_eq!(
        reason(refusal("mcp/uiCallTool", &params, None, Some(&catalog()))),
        not_hosted()
    );
}

#[test]
fn mention_items_need_a_helper_hosted_plugin() {
    let hosted =
        json!({"sessionId": "s1", "pluginId": "viewer@inline", "tool": "search", "query": ""});
    assert!(refusal("plugins/mentionItems", &hosted, OWN, Some(&catalog())).is_none());
    let skills =
        json!({"sessionId": "s1", "pluginId": "skills@inline", "tool": "search", "query": ""});
    assert_eq!(
        reason(refusal(
            "plugins/mentionItems",
            &skills,
            OWN,
            Some(&catalog())
        )),
        not_hosted()
    );
}

#[test]
fn a_session_method_without_a_session_is_invalid() {
    let error = refusal(
        "mcp/uiCallTool",
        &json!({"serverName": "plugin:viewer:view"}),
        OWN,
        Some(&catalog()),
    )
    .expect("refused");
    assert_eq!(error.code, -32602);
    assert!(error.data.is_none());
}

#[test]
fn the_session_catalog_needs_an_own_session_and_the_draft_catalog_does_not() {
    let session = json!({"sessionId": "s1"});
    assert!(refusal("plugins/referenceCatalog", &session, OWN, Some(&catalog())).is_none());
    assert_eq!(
        reason(refusal(
            "plugins/referenceCatalogWithCategory",
            &session,
            None,
            Some(&catalog())
        )),
        not_hosted()
    );
    assert!(refusal("plugins/referenceCatalog", &json!({}), None, None).is_none());
    assert!(refusal("plugins/list", &json!({"sessionId": "x"}), None, None).is_none());
}

/// A helper serves one workspace: the shared session database also holds other workspaces' sessions and the upstream
/// app's remote ones, which Rust must not forward for.
#[test]
fn a_session_of_another_workspace_is_refused() {
    let params = json!({"sessionId": "s1", "serverName": "plugin:viewer:view"});
    for key in ["/other", "remote-identity", "/w/sub", ""] {
        assert_eq!(
            reason(refusal(
                "mcp/uiCallTool",
                &params,
                Some(key),
                Some(&catalog())
            )),
            not_hosted(),
            "{key}"
        );
    }
    // Without a catalog no workspace is known yet: nothing is Rust's.
    assert_eq!(
        reason(refusal("mcp/uiCallTool", &params, OWN, None)),
        not_hosted()
    );
}

/// The catalog's key is the identity key, `workspaceIdentity?.trim() || workspacePath`.
#[test]
fn the_workspace_identity_key_names_the_helpers_workspace() {
    let mut identified = catalog();
    identified.workspace = json!({"workspacePath": "/w", "workspaceIdentity": " id-1 "});
    let params = json!({"sessionId": "s1", "serverName": "plugin:viewer:view"});
    assert!(refusal("mcp/uiCallTool", &params, Some("id-1"), Some(&identified)).is_none());
    assert_eq!(
        reason(refusal("mcp/uiCallTool", &params, OWN, Some(&identified))),
        not_hosted()
    );
    let mut blank = catalog();
    blank.workspace = json!({"workspacePath": "/w", "workspaceIdentity": "  "});
    assert!(refusal("mcp/uiCallTool", &params, OWN, Some(&blank)).is_none());
}
