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
    McpOAuthConfig, McpOAuthWrite, credential_key, credential_key_prefix,
};
use rust_cli_ext::{McpManager, McpScope, McpServer, McpSettings};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::mcp::McpTransportConfig;
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
    match (method, path) {
        ("GET", p) if p.starts_with("/.well-known/oauth-protected-resource") => {
            ok(json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]}))
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
    _path: &str,
    authorization: Option<String>,
    body: &str,
    base: &str,
    state: &Mutex<Mock>,
) -> Reply {
    if method != "POST" {
        return ("405 Method Not Allowed", String::new(), "{}".to_owned());
    }
    let bearer = match authorization.as_deref() {
        Some("Bearer real-token") => "real-token",
        Some("Bearer cc-token") => "cc-token",
        Some("Bearer refreshed-token") => "refreshed-token",
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
            .apply(&[McpOAuthWrite::Put {
                key: credential_key(&prefix, "authorization_credentials"),
                value: canonical_record(access, refresh, expires_at),
            }])
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

/// Run a store read to completion inside a synchronous probe (the probe runs on the test task).
fn futures_block<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
}
