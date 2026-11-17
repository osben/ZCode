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
fn servers_without_an_authorization_code_block_have_no_identity() {
    let stdio = json!({"command": "node", "oauth": {"type": "authorization_code"}});
    assert!(authorization_identity("s", stdio.as_object().unwrap()).is_none());
    let client_credentials = json!({
        "url": "https://mcp.example.test/mcp",
        "oauth": {"type": "client_credentials", "clientId": "c", "clientSecret": "s"}
    });
    assert!(authorization_identity("s", client_credentials.as_object().unwrap()).is_none());
    let plain = json!({"url": "https://mcp.example.test/mcp"});
    assert!(authorization_identity("s", plain.as_object().unwrap()).is_none());
}
