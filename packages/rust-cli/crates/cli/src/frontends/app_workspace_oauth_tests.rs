//! The MCP OAuth row hook: which configured servers declare an authorization identity (the inputs of
//! the pending-record key). The row itself is covered by the ext tests (`mcp::oauth`).

use serde_json::json;

use super::*;

#[test]
fn authorization_identity_needs_a_url_and_an_authorization_code_block() {
    let config = json!({
        "url": "https://mcp.example.test/mcp",
        "oauth": {
            "type": "authorization_code",
            "clientId": "client-1",
            "scope": "read write",
            "redirectPath": "/cb"
        }
    });
    let identity =
        authorization_identity("e2e-remote", config.as_object().unwrap()).expect("identity");
    assert_eq!(
        identity,
        ServerOAuthIdentity {
            name: "e2e-remote".to_owned(),
            url: "https://mcp.example.test/mcp".to_owned(),
            client_id: Some("client-1".to_owned()),
            scope: Some("read write".to_owned()),
            redirect_path: Some("/cb".to_owned()),
        }
    );
}

#[test]
fn a_remote_server_without_a_block_is_authorization_code_for_the_row() {
    let stdio = json!({"command": "node", "oauth": {"type": "authorization_code"}});
    assert!(authorization_identity("s", stdio.as_object().unwrap()).is_none());
    let client_credentials = json!({
        "url": "https://mcp.example.test/mcp",
        "oauth": {"type": "client_credentials", "clientId": "c", "clientSecret": "s"}
    });
    assert!(authorization_identity("s", client_credentials.as_object().unwrap()).is_none());
    // Node: a remote server with no oauth block is authorization_code (`resolveOAuthConfig`).
    let plain = json!({"url": "https://mcp.example.test/mcp"});
    assert!(authorization_identity("s", plain.as_object().unwrap()).is_some());
}

/// PR4 (1): a plugin row carries its resolved URL and the identity fields of its OAuth block. The secret and the
/// headers never reach the row, and a remote plugin server with no block gets Node's `authorization_code` default.
#[test]
fn plugin_rows_carry_the_url_and_the_oauth_identity_without_secrets() {
    use rust_cli_kernel_api::mcp::McpTransportConfig;
    let server = |transport, oauth| McpServer {
        name: "plugin:p:canva".to_owned(),
        scope: McpScope::Plugin,
        transport,
        options: Default::default(),
        machine: Default::default(),
        oauth,
    };
    let url = "https://mcp.example.test/mcp";
    let with_block = plugin_row_config(&server(
        McpTransportConfig::http(url.to_owned(), Default::default()),
        Some(McpOAuthConfig::AuthorizationCode {
            client_id: Some("client-1".to_owned()),
            client_secret: Some("s3cret".to_owned()),
            client_name: None,
            redirect_path: None,
            scope: Some("mcp:tools".to_owned()),
        }),
    ));
    assert_eq!(with_block["url"], json!(url));
    assert_eq!(with_block["oauth"]["clientId"], json!("client-1"));
    assert!(
        !Value::Object(with_block.clone())
            .to_string()
            .contains("s3cret")
    );
    let identity = authorization_identity("plugin:p:canva", &with_block).expect("identity");
    assert_eq!(identity.scope.as_deref(), Some("mcp:tools"));

    let default = plugin_row_config(&server(
        McpTransportConfig::http(url.to_owned(), Default::default()),
        None,
    ));
    assert!(authorization_identity("plugin:p:canva", &default).is_some());

    let own_header = plugin_row_config(&server(
        McpTransportConfig::http(
            url.to_owned(),
            [("Authorization".to_owned(), "Bearer static".to_owned())].into(),
        ),
        None,
    ));
    assert!(own_header.get("url").is_none());
    assert!(authorization_identity("plugin:p:canva", &own_header).is_none());
}
