//! Red tests: the Node `oauth` block of user servers (`specs/fork-rust-mcp-oauth.md`, PR2 row config).
use serde_json::json;

use super::parse_node_servers;
use super::*;
use crate::mcp::oauth::McpOAuthConfig;

#[test]
fn oauth_blocks_are_read_for_user_servers() {
    let (servers, warnings) = parse_node_servers(
        &json!({
            "ac": {"type": "http", "url": "https://mcp.example.com/ac",
                   "oauth": {"type": "authorization_code", "scope": "mcp:tools", "redirectPath": "/cb"}},
            "cc": {"type": "http", "url": "https://mcp.example.com/cc",
                   "oauth": {"type": "client_credentials", "clientId": "id", "clientSecret": "sec", "scope": "x"}},
            "plain": {"type": "http", "url": "https://mcp.example.com/p"}
        }),
        McpScope::User,
    );
    assert!(warnings.is_empty(), "{warnings:?}");
    let by_name = |name: &str| {
        servers
            .iter()
            .find(|found| found.server.name == name)
            .expect("server")
            .server
            .oauth
            .clone()
    };
    assert_eq!(
        by_name("ac"),
        Some(McpOAuthConfig::AuthorizationCode {
            client_id: None,
            client_secret: None,
            client_name: None,
            redirect_path: Some("/cb".into()),
            scope: Some("mcp:tools".into()),
        })
    );
    assert_eq!(
        by_name("cc"),
        Some(McpOAuthConfig::ClientCredentials {
            client_id: "id".into(),
            client_secret: "sec".into(),
            client_name: None,
            scope: Some("x".into()),
        })
    );
    assert_eq!(by_name("plain"), None);
}

#[test]
fn client_credentials_without_a_secret_is_an_invalid_server() {
    // Node's strict schema requires clientId and clientSecret for client_credentials.
    let (servers, warnings) = parse_node_servers(
        &json!({
            "cc": {"type": "http", "url": "https://mcp.example.com/cc",
                   "oauth": {"type": "client_credentials", "clientId": "id"}}
        }),
        McpScope::User,
    );
    assert!(servers.is_empty());
    assert_eq!(warnings.len(), 1, "{warnings:?}");
}
