//! The `oauth` block of a Node MCP server config (`packages/shared/src/zcode-protocol/index.ts`
//! `zcodeProtocolMcpOAuthSchema`). The parser for user servers lives in `mcp/node_config.rs`.

use super::FlowInput;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpOAuthConfig {
    /// Interactive authorization (Node `type: "authorization_code"`).
    AuthorizationCode {
        client_id: Option<String>,
        client_secret: Option<String>,
        client_name: Option<String>,
        redirect_path: Option<String>,
        scope: Option<String>,
    },
    /// Machine-to-machine grant (Node `type: "client_credentials"`); no browser and no lease.
    ClientCredentials {
        client_id: String,
        client_secret: String,
        client_name: Option<String>,
        scope: Option<String>,
    },
}

impl McpOAuthConfig {
    /// The credential key prefix of an `authorization_code` server (Node `createCredentialKeyPrefix`).
    /// `None` for `client_credentials`, which stores nothing in the credential file.
    pub fn key_prefix(&self, name: &str, url: &str) -> Option<String> {
        match self {
            Self::AuthorizationCode {
                client_id,
                redirect_path,
                scope,
                ..
            } => Some(super::credential_key_prefix(
                name,
                url,
                client_id.as_deref(),
                scope.as_deref(),
                redirect_path.as_deref(),
            )),
            Self::ClientCredentials { .. } => None,
        }
    }

    /// The flow input of an `authorization_code` block for the server `name` at `url`.
    /// Returns `None` for `client_credentials`, which has no interactive flow.
    pub fn flow_input(&self, name: &str, url: &str) -> Option<FlowInput> {
        match self {
            Self::AuthorizationCode {
                client_id,
                client_secret,
                client_name,
                redirect_path,
                scope,
            } => Some(FlowInput {
                server_name: name.to_owned(),
                server_url: url.to_owned(),
                client_id: client_id.clone(),
                client_secret: client_secret.clone(),
                client_name: client_name
                    .clone()
                    .unwrap_or_else(|| format!("ZCode {name}")),
                scope: scope.clone(),
                redirect_path: redirect_path.clone(),
                transaction_ttl_ms: 5 * 60 * 1000,
                requested_scope: None,
                resource_metadata: None,
            }),
            Self::ClientCredentials { .. } => None,
        }
    }
}
