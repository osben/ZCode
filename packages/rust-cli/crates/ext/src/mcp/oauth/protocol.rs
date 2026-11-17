//! MCP OAuth protocol steps, ported from the MCP SDK `auth()` (`authInternal`, `discoverMetadataWithFallback`,
//! `buildDiscoveryUrls`, `startAuthorization`, `executeTokenRequest`). Pure URL and body builders here;
//! the HTTP calls run through [`super::McpOAuthRuntime::http`] in `flow.rs`.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use url::{Url, form_urlencoded};

const WELL_KNOWN_PRM: &str = "oauth-protected-resource";
const WELL_KNOWN_AS: &str = "oauth-authorization-server";
const WELL_KNOWN_OIDC: &str = "openid-configuration";

fn parse(raw: &str) -> Result<Url, String> {
    Url::parse(raw).map_err(|error| format!("invalid URL {raw}: {error}"))
}

/// The SDK's `buildWellKnownPath` without `prependPathname`: `/.well-known/<type><pathname>`, with a
/// trailing `/` of the pathname removed. A root server has an empty pathname.
fn well_known_path(kind: &str, pathname: &str) -> String {
    let trimmed = pathname.strip_suffix('/').unwrap_or(pathname);
    format!("/.well-known/{kind}{trimmed}")
}

/// RFC 9728 protected-resource metadata URLs in the SDK's order: the path-inserted form first; a
/// server with a path also tries the root form. A root server has a single URL.
pub fn prm_urls(server_url: &str) -> Result<Vec<String>, String> {
    let url = parse(server_url)?;
    let origin = url.origin().ascii_serialization();
    let pathname = url.path();
    let mut urls = vec![format!(
        "{origin}{}",
        well_known_path(WELL_KNOWN_PRM, pathname)
    )];
    if pathname != "/" {
        urls.push(format!("{origin}/.well-known/{WELL_KNOWN_PRM}"));
    }
    Ok(urls)
}

/// RFC 8414 / OIDC discovery URLs for an authorization server, in the SDK's `buildDiscoveryUrls` order.
/// A server without a path tries the two origin-level documents; a server with a path tries the
/// path-inserted RFC 8414 form, then the OIDC form, then the OIDC form with the path appended.
pub fn as_metadata_urls(authorization_server: &str) -> Result<Vec<String>, String> {
    let url = parse(authorization_server)?;
    let origin = url.origin().ascii_serialization();
    let pathname = url.path();
    if pathname == "/" {
        return Ok(vec![
            format!("{origin}/.well-known/{WELL_KNOWN_AS}"),
            format!("{origin}/.well-known/{WELL_KNOWN_OIDC}"),
        ]);
    }
    let trimmed = pathname.strip_suffix('/').unwrap_or(pathname);
    Ok(vec![
        format!("{origin}/.well-known/{WELL_KNOWN_AS}{trimmed}"),
        format!("{origin}/.well-known/{WELL_KNOWN_OIDC}{trimmed}"),
        format!("{origin}{trimmed}/.well-known/{WELL_KNOWN_OIDC}"),
    ])
}

/// RFC 7591 registration body (Node `clientMetadata`). `token_endpoint_auth_method` is added by the caller
/// only when a client secret is configured (Node sends `client_secret_basic` in that case).
pub fn registration_body(redirect_uri: &str, client_name: &str, scope: Option<&str>) -> Value {
    let mut body = json!({
        "client_name": client_name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    });
    if let Some(scope) = scope {
        body["scope"] = json!(scope);
    }
    body
}

/// The form body of the `authorization_code` token request (SDK `prepareAuthorizationCodeRequest`).
pub fn token_form_authorization_code(code: &str, verifier: &str, redirect_uri: &str) -> String {
    form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("code_verifier", verifier)
        .append_pair("redirect_uri", redirect_uri)
        .finish()
}

/// `Authorization` value of `client_secret_basic` (RFC 6749 2.3.1). PR2 red stub.
pub fn basic_auth(client_id: &str, client_secret: &str) -> String {
    format!(
        "Basic {}",
        STANDARD.encode(format!("{client_id}:{client_secret}"))
    )
}

/// Form body of the `client_credentials` token request (SDK `prepareTokenRequest`). PR2 red stub.
pub fn token_form_client_credentials(scope: Option<&str>) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("grant_type", "client_credentials");
    if let Some(scope) = scope {
        serializer.append_pair("scope", scope);
    }
    serializer.finish()
}
