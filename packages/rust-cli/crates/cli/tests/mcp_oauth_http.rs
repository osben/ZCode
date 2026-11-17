//! Integration test over real HTTP for MCP OAuth (`specs/fork-rust-mcp-oauth.md`, PR2).
//!
//! A mock MCP server and OAuth server listen on 127.0.0.1. The manager uses the real streamable-HTTP transport
//! (`LocalMcpTransport`), the platform's credential store and runtime (loopback listener, egress), and
//! `enable_oauth`. The browser is simulated by a GET on the loopback callback. This test mirrors the scenarios of
//! Node's `mcp-oauth.e2e.test.ts` and stands in for a desktop E2E of user servers, which this box cannot run.

#![allow(
    clippy::disallowed_methods,
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "集成测试：准备临时目录、起本地 HTTP 夹具（net 是套接字入口，测试自己拨号与监听）"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rust_cli_base::TaskScope;
use rust_cli_base::clock::SystemClock;
use rust_cli_base::secret::{EnvSnapshot, RedactedString};
use rust_cli_env_local::LocalMcpTransport;
use rust_cli_ext::mcp::McpServerOptions;
use rust_cli_ext::mcp::oauth::{
    McpOAuthConfig, McpOAuthRuntime, McpOAuthStore, McpOAuthWrite, RefreshInput, credential_key,
    credential_key_prefix, refresh_under_lock,
};
use rust_cli_ext::{McpManager, McpScope, McpServer, McpSettings};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::testing::tool_use_context;
use rust_cli_net::{Egress, NetworkPolicy};
use rust_cli_paths::{StoragePaths, StorageSettings};
use rust_cli_platform::{AccountOrigins, AccountServices, CredentialSecret, Platform};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// `Basic` value the client-credentials token request must carry: base64("cc-id:cc-secret").
const CC_BASIC: &str = "Basic Y2MtaWQ6Y2Mtc2VjcmV0";
const WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Mock {
    /// Every token request: grant type and whether it carried an `Authorization` header.
    token_requests: Vec<(String, Option<String>)>,
    /// MCP methods answered, by bearer that was presented.
    mcp_methods: Vec<(String, String)>,
    /// The `refresh_token` of every refresh grant (PR3).
    refresh_grants: Vec<String>,
    /// The `Authorization` header values the MCP endpoint refused with 401 (PR3).
    rejected: Vec<String>,
    /// `Authorization` header values the server no longer accepts (revoked mid-session).
    revoked: Vec<String>,
    /// Every GET path the mock answered (discovery and the custom `resource_metadata`).
    get_paths: Vec<String>,
}

async fn serve(state: Arc<Mutex<Mock>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let accept_base = base.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let state = state.clone();
            let base = accept_base.clone();
            tokio::spawn(async move {
                let _ = handle(stream, &base, &state).await;
            });
        }
    });
    base
}

async fn handle(stream: TcpStream, base: &str, state: &Mutex<Mock>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default().to_owned();
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    let body = String::from_utf8_lossy(&body).into_owned();
    let authorization = headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .map(|(_, value)| value.clone());
    let path = target.split('?').next().unwrap_or_default();
    let (status, extra, reply) = route(&method, path, authorization, &body, base, state);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{reply}",
        reply.len()
    );
    let mut stream = reader.into_inner();
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

type Reply = (&'static str, String, String);

fn route(
    method: &str,
    path: &str,
    authorization: Option<String>,
    body: &str,
    base: &str,
    state: &Mutex<Mock>,
) -> Reply {
    if method == "GET" {
        state.lock().expect("mock").get_paths.push(path.to_owned());
    }
    match (method, path) {
        ("GET", "/prm-custom") => {
            ok(json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]}))
        }
        ("GET", p) if p.starts_with("/.well-known/oauth-protected-resource") => {
            // The resource is the server path the metadata was asked for (RFC 9728), so every test server
            // (`/mcp`, `/mcp-live`, `/mcp-concurrent`, ...) is covered by its own metadata.
            let server_path = p.trim_start_matches("/.well-known/oauth-protected-resource");
            let server_path = if server_path.is_empty() {
                "/mcp"
            } else {
                server_path
            };
            ok(json!({"resource": format!("{base}{server_path}"), "authorization_servers": [base]}))
        }
        ("GET", "/.well-known/oauth-authorization-server") => ok(json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"),
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
        })),
        ("POST", "/register") => (
            "201 Created",
            String::new(),
            json!({"client_id": "dcr-client"}).to_string(),
        ),
        ("POST", "/token") => token(body, authorization, state),
        (_, p) if p == "/mcp" || p.starts_with("/mcp-") => {
            mcp(method, p, authorization, body, base, state)
        }
        _ => ("404 Not Found", String::new(), "{}".to_owned()),
    }
}

fn ok(value: Value) -> Reply {
    ("200 OK", String::new(), value.to_string())
}

fn form(body: &str) -> BTreeMap<String, String> {
    body.split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

fn token(body: &str, authorization: Option<String>, state: &Mutex<Mock>) -> Reply {
    let fields = form(body);
    let grant = fields.get("grant_type").cloned().unwrap_or_default();
    state
        .lock()
        .expect("mock")
        .token_requests
        .push((grant.clone(), authorization.clone()));
    match grant.as_str() {
        "authorization_code"
            if fields.get("code").map(String::as_str) == Some("the-code")
                && fields.get("code_verifier").is_some_and(|v| !v.is_empty()) =>
        {
            ok(json!({"access_token": "real-token", "token_type": "Bearer", "expires_in": 3600}))
        }
        "client_credentials" if authorization.as_deref() == Some(CC_BASIC) => {
            ok(json!({"access_token": "cc-token", "token_type": "Bearer", "expires_in": 3600}))
        }
        "refresh_token" => {
            let refresh = fields.get("refresh_token").cloned().unwrap_or_default();
            state
                .lock()
                .expect("mock")
                .refresh_grants
                .push(refresh.clone());
            match refresh.as_str() {
                // Omits refresh_token: the client must keep the one it spent (PR3 acceptance 4).
                r if r.starts_with("refresh-ok") => ok(json!({
                    "access_token": "refreshed-token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                })),
                "refresh-broken" => (
                    "503 Service Unavailable",
                    String::new(),
                    json!({"error": "server_error"}).to_string(),
                ),
                _ => (
                    "400 Bad Request",
                    String::new(),
                    json!({"error": "invalid_grant"}).to_string(),
                ),
            }
        }
        _ => (
            "400 Bad Request",
            String::new(),
            json!({"error": "invalid_grant"}).to_string(),
        ),
    }
}

fn mcp(
    method: &str,
    path: &str,
    authorization: Option<String>,
    body: &str,
    base: &str,
    state: &Mutex<Mock>,
) -> Reply {
    if method != "POST" {
        return ("405 Method Not Allowed", String::new(), "{}".to_owned());
    }
    let revoked = authorization
        .as_ref()
        .is_some_and(|value| state.lock().expect("mock").revoked.contains(value));
    if revoked {
        state
            .lock()
            .expect("mock")
            .rejected
            .push(authorization.unwrap_or_default());
        let challenge = format!(
            "WWW-Authenticate: Bearer error=\"invalid_token\", resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"\r\n"
        );
        return ("401 Unauthorized", challenge, "unauthorized".to_owned());
    }
    // A scope-restricted server: the token it was issued lacks `mcp:write`, so the server answers 403 with the
    // scope and a custom `resource_metadata` (RFC 6750 section 3, RFC 9728).
    if path == "/mcp-scope" && authorization.as_deref() == Some("Bearer scope-token") {
        let challenge = format!(
            "WWW-Authenticate: Bearer error=\"insufficient_scope\", scope=\"mcp:write\", resource_metadata=\"{base}/prm-custom\"\r\n"
        );
        return ("403 Forbidden", challenge, "forbidden".to_owned());
    }
    let bearer = match authorization.as_deref() {
        Some("Bearer real-token") => "real-token",
        Some("Bearer cc-token") => "cc-token",
        Some("Bearer refreshed-token") => "refreshed-token",
        Some("Bearer live-old") => "live-old",
        _ => {
            state
                .lock()
                .expect("mock")
                .rejected
                .push(authorization.clone().unwrap_or_default());
            let challenge = format!(
                "WWW-Authenticate: Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"\r\n"
            );
            return ("401 Unauthorized", challenge, "unauthorized".to_owned());
        }
    };
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let rpc = request["method"].as_str().unwrap_or_default().to_owned();
    state
        .lock()
        .expect("mock")
        .mcp_methods
        .push((rpc.clone(), bearer.to_owned()));
    let id = request.get("id").cloned();
    let result = match rpc.as_str() {
        "initialize" => json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "mock", "version": "1"},
        }),
        "tools/list" => json!({"tools": [{"name": "ping", "inputSchema": {"type": "object"}}]}),
        "tools/call" => json!({"content": [{"type": "text", "text": "pong"}]}),
        "notifications/initialized" => return ("202 Accepted", String::new(), String::new()),
        _ => return (
            "200 OK",
            String::new(),
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "unknown"}})
                .to_string(),
        ),
    };
    ok(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn server(name: &str, url: String, oauth: Option<McpOAuthConfig>) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::User,
        transport: McpTransportConfig::http(url, BTreeMap::new()),
        options: McpServerOptions {
            timeout_ms: None,
            always_load: true,
        },
        machine: Default::default(),
        oauth,
    }
}

fn workspace(root: &Path) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root.to_string_lossy().into_owned()),
    }
}

async fn until<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&text[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_value(url: &str, key: &str) -> String {
    let query = url.split_once('?').map_or("", |(_, query)| query);
    let value = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value)
        .unwrap_or_default();
    percent_decode(value)
}

/// The browser's part: GET the loopback callback with the code and the state.
async fn browser_callback(redirect_uri: &str, state: &str) -> String {
    let rest = redirect_uri.strip_prefix("http://").expect("http loopback");
    let (host, path) = rest.split_once('/').expect("path");
    let mut stream = TcpStream::connect(host).await.expect("connect loopback");
    let request = format!(
        "GET /{path}?code=the-code&state={state} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut response = String::new();
    stream.read_to_string(&mut response).await.expect("read");
    response
}

#[tokio::test(flavor = "multi_thread")]
async fn authorization_code_and_client_credentials_work_over_real_http() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let base = serve(mock.clone()).await;
    let home = tempfile::tempdir().expect("home");
    let work = tempfile::tempdir().expect("work");
    let paths = StoragePaths::resolve(&StorageSettings::default(), home.path(), work.path());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.expect("egress"));
    let clock = Arc::new(SystemClock::utc());
    let origin = "http://127.0.0.1:9".to_owned();
    let services = AccountServices {
        egress: egress.clone(),
        clock: clock.clone(),
        origins: AccountOrigins {
            zcode_api: format!("{origin}/api/v1"),
            zai_api: origin.clone(),
            bigmodel_team_plans: format!("{origin}/coding-plan/team/plans"),
            bigmodel_api: origin,
            client_version: "0.0.0-test".to_owned(),
            usage_quota_url: None,
        },
    };
    let secret = CredentialSecret {
        explicit: Some(RedactedString::new("test-secret")),
        platform: rust_cli_platform::node_platform().to_owned(),
        home: home.path().to_string_lossy().into_owned(),
        username: "dev".to_owned(),
    };
    let platform = Arc::new(Platform::new(&paths, &secret, services));

    let transport = Arc::new(LocalMcpTransport::new(
        work.path().join("ledger.json"),
        EnvSnapshot::default(),
        Some(egress.clone()),
    ));
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        transport,
        scope.spawner(),
        McpSettings::default(),
        clock.clone(),
    );
    manager.enable_oauth(platform.mcp_oauth_store(), platform.mcp_oauth_runtime());
    let cc = McpOAuthConfig::ClientCredentials {
        client_id: "cc-id".to_owned(),
        client_secret: "cc-secret".to_owned(),
        client_name: None,
        scope: None,
    };
    manager.start(
        workspace(work.path()),
        vec![
            server("e2e-remote", format!("{base}/mcp"), None),
            server("cc", format!("{base}/mcp-cc"), Some(cc)),
        ],
    );
    let store = platform.mcp_oauth_store();

    // 1. The first connect is refused with 401; the pending authorization appears with its URL.
    let prefix = credential_key_prefix("e2e-remote", &format!("{base}/mcp"), None, None, None);
    let pending_key = credential_key(&prefix, "pending_authorization");
    let pending = until("the pending authorization", || {
        let raw = futures_block(store.load(&pending_key)).ok().flatten()?;
        serde_json::from_str::<Value>(&raw).ok()
    })
    .await;
    let authorization_url = pending["authorization_url"]
        .as_str()
        .expect("url")
        .to_owned();
    assert!(
        authorization_url.starts_with(&format!("{base}/authorize?")),
        "{authorization_url}"
    );
    let state_value = query_value(&authorization_url, "state");
    let redirect_uri = query_value(&authorization_url, "redirect_uri");
    assert!(
        redirect_uri.starts_with("http://127.0.0.1:"),
        "{redirect_uri}"
    );

    // 2. The browser answers the callback; the token is stored and the server reconnects with it.
    let response = browser_callback(&redirect_uri, &state_value).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let canonical_key = credential_key(&prefix, "authorization_credentials");
    let canonical = until("the canonical credentials", || {
        let raw = futures_block(store.load(&canonical_key)).ok().flatten()?;
        serde_json::from_str::<Value>(&raw).ok()
    })
    .await;
    assert_eq!(canonical["tokens"]["access_token"], "real-token");
    assert_eq!(canonical["version"], 2);
    until("the pending record is removed", || {
        futures_block(store.load(&pending_key))
            .ok()
            .flatten()
            .is_none()
            .then_some(())
    })
    .await;
    until("the authorized server lists its tool", || {
        manager
            .tools()
            .iter()
            .any(|tool| tool.name().contains("e2e-remote") && tool.name().ends_with("ping"))
            .then_some(())
    })
    .await;

    // 3. client_credentials: the bearer is fetched before the connect, so the first connect succeeds.
    until("the client-credentials server lists its tool", || {
        manager
            .tools()
            .iter()
            .any(|tool| tool.name().contains("cc") && tool.name().ends_with("ping"))
            .then_some(())
    })
    .await;

    let mock = mock.lock().expect("mock");
    let code_exchange = mock
        .token_requests
        .iter()
        .find(|(grant, _)| grant == "authorization_code")
        .expect("authorization_code exchange");
    assert_eq!(code_exchange.1, None);
    let cc_request = mock
        .token_requests
        .iter()
        .find(|(grant, _)| grant == "client_credentials")
        .expect("client_credentials request");
    assert_eq!(cc_request.1.as_deref(), Some(CC_BASIC));
    assert!(
        mock.mcp_methods
            .iter()
            .any(|(method, bearer)| method == "tools/list" && bearer == "real-token")
    );
    assert!(
        mock.mcp_methods
            .iter()
            .any(|(method, bearer)| method == "tools/list" && bearer == "cc-token")
    );
}

/// The platform store and runtime of a fresh home, with the manager wired to them. Shared by the PR3 scenarios.
struct Harness {
    _home: tempfile::TempDir,
    work: tempfile::TempDir,
    platform: Arc<Platform>,
    manager: McpManager,
    _scope: TaskScope,
}

async fn harness() -> Harness {
    let home = tempfile::tempdir().expect("home");
    let work = tempfile::tempdir().expect("work");
    let paths = StoragePaths::resolve(&StorageSettings::default(), home.path(), work.path());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.expect("egress"));
    let clock = Arc::new(SystemClock::utc());
    let origin = "http://127.0.0.1:9".to_owned();
    let services = AccountServices {
        egress: egress.clone(),
        clock: clock.clone(),
        origins: AccountOrigins {
            zcode_api: format!("{origin}/api/v1"),
            zai_api: origin.clone(),
            bigmodel_team_plans: format!("{origin}/coding-plan/team/plans"),
            bigmodel_api: origin,
            client_version: "0.0.0-test".to_owned(),
            usage_quota_url: None,
        },
    };
    let secret = CredentialSecret {
        explicit: Some(RedactedString::new("test-secret")),
        platform: rust_cli_platform::node_platform().to_owned(),
        home: home.path().to_string_lossy().into_owned(),
        username: "dev".to_owned(),
    };
    let platform = Arc::new(Platform::new(&paths, &secret, services));
    let transport = Arc::new(LocalMcpTransport::new(
        work.path().join("ledger.json"),
        EnvSnapshot::default(),
        Some(egress),
    ));
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(transport, scope.spawner(), McpSettings::default(), clock);
    manager.enable_oauth(platform.mcp_oauth_store(), platform.mcp_oauth_runtime());
    Harness {
        _home: home,
        work,
        platform,
        manager,
        _scope: scope,
    }
}

/// The canonical record and its legacy mirror (`client_information`, `tokens`), written in one batch as Node's
/// `publishCanonicalCredentials` does. A v2 record without its mirror reads as invalidated (Node).
fn mirrored(prefix: &str, canonical: String) -> Vec<McpOAuthWrite> {
    let parsed: serde_json::Value = serde_json::from_str(&canonical).expect("canonical JSON");
    vec![
        McpOAuthWrite::Put {
            key: credential_key(prefix, "authorization_credentials"),
            value: canonical,
        },
        McpOAuthWrite::Put {
            key: credential_key(prefix, "client_information"),
            value: parsed["client_information"].to_string(),
        },
        McpOAuthWrite::Put {
            key: credential_key(prefix, "tokens"),
            value: parsed["tokens"].to_string(),
        },
    ]
}

/// A stored canonical record as Node writes it (version 2), for one server's credential key prefix.
fn canonical_record(access: &str, refresh: &str, expires_at_ms: i64) -> String {
    json!({
        "client_information": {"client_id": "client-1"},
        "tokens": {"access_token": access, "token_type": "Bearer", "refresh_token": refresh},
        "generation": "gen-seed",
        "expires_at": expires_at_ms,
        "obtained_at": 0,
        "published_by": "seed",
        "version": 2,
    })
    .to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

/// PR3 scenarios over real HTTP (`specs/fork-rust-mcp-oauth.md`, PR3 acceptance 2, 3, 5, 7, 9, 10). Four servers
/// share one mock, each with its own stored token and refresh token, so the outcomes stay separate:
/// `fresh` (expired token refreshed before connect), `retry` (401 on connect, refresh and retry),
/// `revoked` (invalid_grant, re-authorization) and `broken` (5xx on refresh, credentials kept).
#[tokio::test(flavor = "multi_thread")]
async fn refresh_and_reauthorization_work_over_real_http() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let base = serve(mock.clone()).await;
    let home = tempfile::tempdir().expect("home");
    let work = tempfile::tempdir().expect("work");
    let paths = StoragePaths::resolve(&StorageSettings::default(), home.path(), work.path());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.expect("egress"));
    let clock = Arc::new(SystemClock::utc());
    let origin = "http://127.0.0.1:9".to_owned();
    let services = AccountServices {
        egress: egress.clone(),
        clock: clock.clone(),
        origins: AccountOrigins {
            zcode_api: format!("{origin}/api/v1"),
            zai_api: origin.clone(),
            bigmodel_team_plans: format!("{origin}/coding-plan/team/plans"),
            bigmodel_api: origin,
            client_version: "0.0.0-test".to_owned(),
            usage_quota_url: None,
        },
    };
    let secret = CredentialSecret {
        explicit: Some(RedactedString::new("test-secret")),
        platform: rust_cli_platform::node_platform().to_owned(),
        home: home.path().to_string_lossy().into_owned(),
        username: "dev".to_owned(),
    };
    let platform = Arc::new(Platform::new(&paths, &secret, services));
    let transport = Arc::new(LocalMcpTransport::new(
        work.path().join("ledger.json"),
        EnvSnapshot::default(),
        Some(egress.clone()),
    ));
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        transport,
        scope.spawner(),
        McpSettings::default(),
        clock.clone(),
    );
    manager.enable_oauth(platform.mcp_oauth_store(), platform.mcp_oauth_runtime());
    let store = platform.mcp_oauth_store();

    // Seed the stored tokens. `fresh` is past its expiry; the others are valid far into the future, so their
    // first connect sends the stale token and the mock refuses it.
    let later = now_ms() + 3_600_000;
    let seeds = [
        (
            "fresh",
            "stale-fresh",
            "refresh-ok-fresh",
            now_ms() - 60_000,
        ),
        ("retry", "stale-retry", "refresh-ok-retry", later),
        ("revoked", "stale-revoked", "refresh-revoked", later),
        ("broken", "stale-broken", "refresh-broken", later),
    ];
    for (name, access, refresh, expires_at) in seeds {
        let prefix = credential_key_prefix(name, &format!("{base}/mcp-{name}"), None, None, None);
        store
            .apply(&mirrored(
                &prefix,
                canonical_record(access, refresh, expires_at),
            ))
            .await
            .expect("seed");
    }

    let servers = ["fresh", "retry", "revoked", "broken"]
        .into_iter()
        .map(|name| server(name, format!("{base}/mcp-{name}"), None))
        .collect();
    manager.start(workspace(work.path()), servers);

    // 1. `fresh`: refreshed before the connect, so the first request already carries the new token.
    until("the refreshed server lists its tool", || {
        manager
            .tools()
            .iter()
            .any(|tool| tool.name().contains("fresh") && tool.name().ends_with("ping"))
            .then_some(())
    })
    .await;

    // 2. `retry`: the stale token is refused with 401, the refresh runs, and the connect is retried once.
    until("the retried server lists its tool", || {
        manager
            .tools()
            .iter()
            .any(|tool| tool.name().contains("retry") && tool.name().ends_with("ping"))
            .then_some(())
    })
    .await;

    // 3. `revoked`: invalid_grant drops the tokens and the authorization flow starts (a pending record appears).
    let revoked_prefix =
        credential_key_prefix("revoked", &format!("{base}/mcp-revoked"), None, None, None);
    let pending_key = credential_key(&revoked_prefix, "pending_authorization");
    until("re-authorization after invalid_grant", || {
        let raw = futures_block(store.load(&pending_key)).ok().flatten()?;
        serde_json::from_str::<Value>(&raw).ok()
    })
    .await;
    let revoked_canonical = futures_block(store.load(&credential_key(
        &revoked_prefix,
        "authorization_credentials",
    )))
    .expect("store");
    assert!(
        revoked_canonical.is_none(),
        "invalid_grant must drop the tokens"
    );

    // 4. `broken`: a 5xx on refresh keeps the stored credentials and starts no flow.
    until("the broken refresh was attempted", || {
        mock.lock()
            .expect("mock")
            .refresh_grants
            .iter()
            .any(|grant| grant == "refresh-broken")
            .then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let broken_prefix =
        credential_key_prefix("broken", &format!("{base}/mcp-broken"), None, None, None);
    let kept =
        futures_block(store.load(&credential_key(&broken_prefix, "authorization_credentials")))
            .expect("store");
    assert!(
        kept.is_some(),
        "a temporary refresh failure keeps the credentials"
    );
    let started =
        futures_block(store.load(&credential_key(&broken_prefix, "pending_authorization")))
            .expect("store");
    assert!(
        started.is_none(),
        "a temporary refresh failure starts no authorization flow"
    );

    let mock = mock.lock().expect("mock");
    // Each scenario refreshed exactly once: the refresh token is spent once.
    for refresh in [
        "refresh-ok-fresh",
        "refresh-ok-retry",
        "refresh-revoked",
        "refresh-broken",
    ] {
        let count = mock
            .refresh_grants
            .iter()
            .filter(|grant| *grant == refresh)
            .count();
        assert_eq!(count, 1, "{refresh} was refreshed {count} times");
    }
    assert!(
        !mock.rejected.contains(&"Bearer stale-fresh".to_owned()),
        "{:?}",
        mock.rejected
    );
    assert!(
        mock.rejected.contains(&"Bearer stale-retry".to_owned()),
        "{:?}",
        mock.rejected
    );
    assert!(
        mock.mcp_methods
            .iter()
            .any(|(method, bearer)| method == "tools/list" && bearer == "refreshed-token")
    );
}

/// Mid-session 401 on a tool call (Node `recoverToolCallAuthorization`): the server revokes the token of a live
/// connection; the call refreshes once, reconnects with the new token and returns the tool's result.
#[tokio::test(flavor = "multi_thread")]
async fn a_401_during_a_tool_call_refreshes_and_retries_over_real_http() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let base = serve(mock.clone()).await;
    let h = harness().await;
    let store = h.platform.mcp_oauth_store();
    let prefix = credential_key_prefix("live", &format!("{base}/mcp-live"), None, None, None);
    store
        .apply(&mirrored(
            &prefix,
            canonical_record("live-old", "refresh-ok-live", now_ms() + 3_600_000),
        ))
        .await
        .expect("seed");
    h.manager.start(
        workspace(h.work.path()),
        vec![server("live", format!("{base}/mcp-live"), None)],
    );
    let tool = until("the live server lists its tool", || {
        h.manager
            .tools()
            .into_iter()
            .find(|tool| tool.name().contains("live") && tool.name().ends_with("ping"))
    })
    .await;

    // The server revokes the token it issued; the next call is refused with 401.
    mock.lock()
        .expect("mock")
        .revoked
        .push("Bearer live-old".to_owned());
    let (progress, _events) = tokio::sync::mpsc::channel(8);
    let output = tool
        .call(json!({}), tool_use_context(), progress)
        .await
        .expect("the call recovers");
    assert!(
        output
            .content
            .iter()
            .any(|part| matches!(part, ToolResultContent::Text { text } if text == "pong")),
        "{output:?}"
    );
    let mock = mock.lock().expect("mock");
    assert_eq!(
        mock.refresh_grants
            .iter()
            .filter(|grant| *grant == "refresh-ok-live")
            .count(),
        1,
        "one refresh for one 401"
    );
    assert!(
        mock.mcp_methods
            .iter()
            .any(|(method, bearer)| method == "tools/call" && bearer == "refreshed-token"),
        "the retried call carries the refreshed token"
    );
}

/// A 403 `insufficient_scope` starts re-authorization with the scope named in the header, and the discovery
/// uses the header's `resource_metadata` (RFC 6750, RFC 9728; Node `resourceMetadataUrl`).
#[tokio::test(flavor = "multi_thread")]
async fn a_403_insufficient_scope_reauthorizes_with_the_header_scope_over_real_http() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let base = serve(mock.clone()).await;
    let h = harness().await;
    let store = h.platform.mcp_oauth_store();
    let prefix = credential_key_prefix("scope", &format!("{base}/mcp-scope"), None, None, None);
    store
        .apply(&mirrored(
            &prefix,
            canonical_record("scope-token", "refresh-ok-scope", now_ms() + 3_600_000),
        ))
        .await
        .expect("seed");
    h.manager.start(
        workspace(h.work.path()),
        vec![server("scope", format!("{base}/mcp-scope"), None)],
    );
    let pending_key = credential_key(&prefix, "pending_authorization");
    let pending = until("the scope re-authorization", || {
        let raw = futures_block(store.load(&pending_key)).ok().flatten()?;
        serde_json::from_str::<Value>(&raw).ok()
    })
    .await;
    let authorization_url = pending["authorization_url"]
        .as_str()
        .expect("url")
        .to_owned();
    assert_eq!(
        query_value(&authorization_url, "scope"),
        "mcp:write",
        "{authorization_url}"
    );
    let mock = mock.lock().expect("mock");
    assert!(
        mock.get_paths.iter().any(|path| path == "/prm-custom"),
        "discovery starts at the header's resource_metadata: {:?}",
        mock.get_paths
    );
    assert!(
        mock.refresh_grants.is_empty(),
        "a 403 is not a token expiry: it does not refresh"
    );
}

/// Two refreshes that read the same generation make one token request over the real platform lock.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_refreshes_make_one_token_request_over_real_http() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let base = serve(mock.clone()).await;
    let h = harness().await;
    let store = h.platform.mcp_oauth_store();
    let runtime = h.platform.mcp_oauth_runtime();
    let url = format!("{base}/mcp-concurrent");
    let prefix = credential_key_prefix("concurrent", &url, None, None, None);
    store
        .apply(&mirrored(
            &prefix,
            canonical_record("stale-c", "refresh-ok-concurrent", now_ms() - 60_000),
        ))
        .await
        .expect("seed");

    // Hold the refresh lock so both callers read the same generation and queue behind it.
    let holder = store
        .try_acquire_refresh_lock(&prefix)
        .await
        .expect("lock")
        .expect("free lock");
    let input = RefreshInput {
        server_name: "concurrent".to_owned(),
        server_url: url,
        key_prefix: prefix,
        static_client_id: None,
        client_secret: None,
        reactive: true,
    };
    let spawn =
        |store: Arc<dyn McpOAuthStore>, runtime: Arc<dyn McpOAuthRuntime>, input: RefreshInput| {
            tokio::spawn(async move { refresh_under_lock(&*store, &*runtime, &input).await })
        };
    let first = spawn(store.clone(), runtime.clone(), input.clone());
    let second = spawn(store.clone(), runtime.clone(), input.clone());
    tokio::time::sleep(Duration::from_millis(300)).await;
    holder.release().await;

    assert_eq!(
        first.await.expect("join").expect("refresh"),
        "refreshed-token"
    );
    assert_eq!(
        second.await.expect("join").expect("refresh"),
        "refreshed-token"
    );
    let mock = mock.lock().expect("mock");
    assert_eq!(
        mock.refresh_grants
            .iter()
            .filter(|grant| *grant == "refresh-ok-concurrent")
            .count(),
        1,
        "the second caller reuses the winner's token"
    );
}

/// `DeleteGuarded` on the platform store: a publication made after the failure was observed survives.
#[tokio::test(flavor = "multi_thread")]
async fn delete_guarded_keeps_a_newer_write_in_the_platform_store() {
    let h = harness().await;
    let store = h.platform.mcp_oauth_store();
    let prefix = credential_key_prefix("guard", "https://guard.example.test/mcp", None, None, None);
    let canonical_key = credential_key(&prefix, "authorization_credentials");
    let tokens_key = credential_key(&prefix, "tokens");
    let observed = canonical_record("older", "refresh-older", now_ms() + 3_600_000);
    store
        .apply(&[
            McpOAuthWrite::Put {
                key: canonical_key.clone(),
                value: observed.clone(),
            },
            McpOAuthWrite::Put {
                key: tokens_key.clone(),
                value: "{}".to_owned(),
            },
        ])
        .await
        .expect("seed");
    let newer = canonical_record("newer", "refresh-newer", now_ms() + 7_200_000);
    store
        .apply(&[McpOAuthWrite::Put {
            key: canonical_key.clone(),
            value: newer.clone(),
        }])
        .await
        .expect("newer publication");

    store
        .apply(&[McpOAuthWrite::DeleteGuarded {
            guard_key: canonical_key.clone(),
            expected: observed,
            keys: vec![canonical_key.clone(), tokens_key.clone()],
        }])
        .await
        .expect("guarded delete");
    assert_eq!(
        store.load(&canonical_key).await.expect("load").as_deref(),
        Some(newer.as_str()),
        "the newer publication survives a stale invalidation"
    );

    store
        .apply(&[McpOAuthWrite::DeleteGuarded {
            guard_key: canonical_key.clone(),
            expected: newer,
            keys: vec![canonical_key.clone(), tokens_key.clone()],
        }])
        .await
        .expect("guarded delete");
    assert!(store.load(&canonical_key).await.expect("load").is_none());
    assert!(store.load(&tokens_key).await.expect("load").is_none());
}

/// Run a store read to completion inside a synchronous probe (the probe runs on the test task).
fn futures_block<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
}

/// Acceptance 9 (PR4 follower reconnect): a second lane's manager waits on the lead's authorization and
/// reconnects with the credentials the lead publishes, over real HTTP.
#[tokio::test(flavor = "multi_thread")]
async fn a_follower_lane_reconnects_after_the_lead_publishes_over_real_http() {
    // A bounded scenario: a stall fails the test instead of hanging the run.
    tokio::time::timeout(
        Duration::from_secs(90),
        follower_lane_scenario(),
    )
    .await
    .expect("the follower scenario did not finish within 90 s");
}

async fn follower_lane_scenario() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let base = serve(mock.clone()).await;
    let harness = harness().await;
    let work = harness.work.path().to_path_buf();
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.expect("egress"));
    let follower = McpManager::new(
        Arc::new(LocalMcpTransport::new(
            work.join("follower-ledger.json"),
            EnvSnapshot::default(),
            Some(egress),
        )),
        harness._scope.spawner(),
        McpSettings::default(),
        Arc::new(SystemClock::utc()),
    );
    follower.enable_oauth(
        harness.platform.mcp_oauth_store(),
        harness.platform.mcp_oauth_runtime(),
    );
    let url = format!("{base}/mcp");
    let servers = vec![server("e2e-remote", url.clone(), None)];

    // The lead lane starts first and is refused with 401; it publishes the pending authorization.
    harness.manager.start(workspace(&work), servers.clone());
    let store = harness.platform.mcp_oauth_store();
    let prefix = credential_key_prefix("e2e-remote", &url, None, None, None);
    let pending_key = credential_key(&prefix, "pending_authorization");
    let pending = until("the lead's pending authorization", || {
        let raw = futures_block(store.load(&pending_key)).ok().flatten()?;
        serde_json::from_str::<Value>(&raw).ok()
    })
    .await;
    let authorization_url = pending["authorization_url"]
        .as_str()
        .expect("url")
        .to_owned();

    // The follower lane starts while the lead's transaction is open: it follows instead of opening a second one.
    follower.start(workspace(&work), servers);
    // The follower's first connect is refused with 401, and its flow is registered only after it has read the
    // follower baseline (`McpOAuthCoordinator::start`). A registered flow is therefore the point where the lead's
    // publish can be observed as a change. Publishing before it would leave the follower waiting for a change that
    // already happened.
    until("the follower's authorization flow is registered", || {
        follower.oauth_flow_running("e2e-remote").then_some(())
    })
    .await;

    // The browser answers the lead's callback; the lead publishes, and the follower's client reconnects.
    let state_value = query_value(&authorization_url, "state");
    let redirect_uri = query_value(&authorization_url, "redirect_uri");
    let response = browser_callback(&redirect_uri, &state_value).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    // The follower's reconnect starts after the lead publishes; give it the full wait budget and report the
    // follower's state when it does not list its tool.
    let lists_ping = |manager: &McpManager| {
        manager
            .tools()
            .iter()
            .any(|tool| tool.name().contains("e2e-remote") && tool.name().ends_with("ping"))
    };
    let deadline = Instant::now() + WAIT;
    while !lists_ping(&follower) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // One snapshot of the mock: taking the lock twice inside one assertion deadlocks on the same thread.
    let (methods, rejected, token_requests) = {
        let guard = mock.lock().expect("mock");
        (
            guard.mcp_methods.clone(),
            guard.rejected.clone(),
            guard.token_requests.clone(),
        )
    };
    assert!(
        lists_ping(&follower),
        "the follower did not reconnect: {:?}; mock: {methods:?}; rejected: {rejected:?}; token requests: {token_requests:?}",
        follower.server_infos(),
    );
    let mock = mock.lock().expect("mock");
    assert!(
        mock.mcp_methods
            .iter()
            .any(|(method, bearer)| method == "tools/list" && bearer == "real-token"),
        "the follower must reconnect with the published token: {:?}",
        mock.mcp_methods
    );
    assert_eq!(
        mock.token_requests
            .iter()
            .filter(|(grant, _)| grant == "authorization_code")
            .count(),
        1,
        "only the lead exchanges the code"
    );
}
