//! Red tests for the lead/follower flow (`specs/fork-rust-mcp-oauth.md`, PR2 acceptance 1, 7, 8, 9).
//! The runtime is a fake: a scripted authorization server over HTTP, a loopback listener that replays
//! one callback request, and deterministic entropy (every random byte is 7).

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::flow::{FlowInput, FlowOutcome, run_lead};
use super::*;
use tokio_util::sync::CancellationToken;

const SERVER_URL: &str = "https://mcp.example.test/mcp";
const AS_URL: &str = "https://auth.example.test";
const CALLBACK_PORT: u16 = 49_152;
const CODE: &str = "auth-code-1";

/// The state the flow generates: 24 bytes of 7, base64url. The fake entropy makes it predictable.
pub(crate) fn expected_state() -> String {
    URL_SAFE_NO_PAD.encode([7u8; 24])
}

#[derive(Default)]
pub(crate) struct MemoryStore {
    pub(crate) raw: Mutex<BTreeMap<String, String>>,
    pub(crate) lease_acquisitions: Mutex<u32>,
    pub(crate) lease_held: bool,
}

impl MemoryStore {
    pub(crate) fn has_key(&self, key: &str) -> bool {
        self.raw.lock().unwrap().contains_key(key)
    }
}

struct FakeLease;

#[async_trait::async_trait]
impl AuthorizationLease for FakeLease {
    async fn release(self: Box<Self>) {}
}

#[async_trait::async_trait]
impl McpOAuthStore for MemoryStore {
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError> {
        Ok(self.raw.lock().unwrap().get(key).cloned())
    }

    async fn apply(&self, writes: &[McpOAuthWrite]) -> Result<(), McpOAuthStoreError> {
        let mut raw = self.raw.lock().unwrap();
        for write in writes {
            match write {
                McpOAuthWrite::Put { key, value } => {
                    raw.insert(key.clone(), value.clone());
                }
                McpOAuthWrite::DeleteIfValue { key, expected } => {
                    if raw.get(key) == Some(expected) {
                        raw.remove(key);
                    }
                }
                McpOAuthWrite::DeleteGuarded {
                    guard_key,
                    expected,
                    keys,
                } => {
                    if raw.get(guard_key) == Some(expected) {
                        for key in keys {
                            raw.remove(key);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn try_acquire_lease(
        &self,
        _key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        *self.lease_acquisitions.lock().unwrap() += 1;
        if self.lease_held {
            return Ok(None);
        }
        Ok(Some(Box::new(FakeLease)))
    }

    async fn try_acquire_refresh_lock(
        &self,
        _key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        Ok(Some(Box::new(FakeLease)))
    }
}

struct ScriptedConnection {
    target: String,
}

#[async_trait::async_trait]
impl LoopbackConnection for ScriptedConnection {
    async fn request_target(&mut self) -> Result<String, OAuthHttpError> {
        Ok(self.target.clone())
    }
    async fn respond(&mut self, _status: u16, _body: &str) -> Result<(), OAuthHttpError> {
        Ok(())
    }
}

struct ScriptedListener {
    targets: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl LoopbackListener for ScriptedListener {
    fn local_addr(&self) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, CALLBACK_PORT))
    }
    async fn accept(&mut self) -> Result<Box<dyn LoopbackConnection>, OAuthHttpError> {
        // With no scripted callback left the browser never answers: wait forever, as a real listener does.
        let next = {
            let mut targets = self.targets.lock().unwrap();
            if targets.is_empty() {
                None
            } else {
                Some(targets.remove(0))
            }
        };
        match next {
            Some(target) => Ok(Box::new(ScriptedConnection { target })),
            None => std::future::pending().await,
        }
    }
}

pub(crate) struct FakeRuntime {
    /// Callback request targets the browser delivers, in order.
    pub(crate) callbacks: Vec<String>,
    pub(crate) requests: Mutex<Vec<OAuthHttpRequest>>,
    pub(crate) listen_calls: Mutex<u32>,
}

impl FakeRuntime {
    pub(crate) fn new(callbacks: Vec<String>) -> Self {
        Self {
            callbacks,
            requests: Mutex::new(Vec::new()),
            listen_calls: Mutex::new(0),
        }
    }

    pub(crate) fn requests(&self) -> Vec<OAuthHttpRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub(crate) fn listen_count(&self) -> u32 {
        *self.listen_calls.lock().unwrap()
    }
}

#[async_trait::async_trait]
impl McpOAuthRuntime for FakeRuntime {
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, OAuthHttpError> {
        Ok(vec![7; len])
    }

    fn now_ms(&self) -> i64 {
        1_700_000_000_000
    }

    async fn http(&self, request: OAuthHttpRequest) -> Result<OAuthHttpResponse, OAuthHttpError> {
        self.requests.lock().unwrap().push(request.clone());
        let json = |body: serde_json::Value| OAuthHttpResponse {
            status: 200,
            body: body.to_string(),
            www_authenticate: None,
        };
        let not_found = OAuthHttpResponse {
            status: 404,
            body: String::new(),
            www_authenticate: None,
        };
        Ok(match request.url.as_str() {
            // The MCP server advertises its authorization server through RFC 9728 metadata at the
            // path-inserted URL; the root URL is never reached.
            "https://mcp.example.test/.well-known/oauth-protected-resource/mcp" => {
                json(serde_json::json!({
                    "resource": SERVER_URL,
                    "authorization_servers": [AS_URL],
                }))
            }
            u if u.starts_with("https://mcp.example.test/.well-known/") => not_found,
            "https://auth.example.test/.well-known/oauth-authorization-server" => {
                json(serde_json::json!({
                    "issuer": AS_URL,
                    "authorization_endpoint": "https://auth.example.test/authorize",
                    "token_endpoint": "https://auth.example.test/token",
                    "registration_endpoint": "https://auth.example.test/register",
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"],
                }))
            }
            "https://auth.example.test/register" => json(serde_json::json!({
                "client_id": "client-from-dcr",
                "redirect_uris": [format!("http://127.0.0.1:{CALLBACK_PORT}/callback")],
            })),
            "https://auth.example.test/token" => json(serde_json::json!({
                "access_token": "tok-access-1",
                "refresh_token": "tok-refresh-1",
                "token_type": "Bearer",
                "expires_in": 3600,
            })),
            other => panic!("unexpected request {other}"),
        })
    }

    async fn bind_loopback(&self) -> Result<Box<dyn LoopbackListener>, OAuthHttpError> {
        *self.listen_calls.lock().unwrap() += 1;
        Ok(Box::new(ScriptedListener {
            targets: Mutex::new(self.callbacks.clone()),
        }))
    }
}

pub(crate) fn input() -> FlowInput {
    FlowInput {
        server_name: "e2e-remote".to_owned(),
        server_url: SERVER_URL.to_owned(),
        client_id: None,
        client_secret: None,
        client_name: "ZCode e2e-remote".to_owned(),
        scope: Some("mcp:tools".to_owned()),
        redirect_path: None,
        transaction_ttl_ms: 5 * 60 * 1000,
        requested_scope: None,
        resource_metadata: None,
    }
}

pub(crate) fn callback(state: &str) -> String {
    format!("/callback?code={CODE}&state={state}")
}

#[tokio::test]
async fn happy_path_discovers_registers_exchanges_and_publishes_canonical_credentials() {
    let store = MemoryStore::default();
    let runtime = FakeRuntime {
        callbacks: vec![callback(&expected_state())],
        requests: Mutex::new(Vec::new()),
        listen_calls: Mutex::new(0),
    };
    let outcome = run_lead(&store, &runtime, &input(), &CancellationToken::new()).await;
    assert_eq!(outcome, FlowOutcome::Authorized);

    let requests = runtime.requests.lock().unwrap().clone();
    let registration = requests
        .iter()
        .find(|r| r.url.ends_with("/register"))
        .expect("DCR request");
    assert!(
        registration
            .body
            .as_deref()
            .unwrap_or("")
            .contains("127.0.0.1")
    );
    let token = requests
        .iter()
        .find(|r| r.url.ends_with("/token"))
        .expect("token request");
    let form = token.body.as_deref().unwrap_or("");
    assert!(form.contains("code_verifier="));
    assert!(form.contains(&format!("code={CODE}")));

    let key_prefix = credential_key_prefix("e2e-remote", SERVER_URL, None, Some("mcp:tools"), None);
    let canonical = store
        .load(&credential_key(&key_prefix, "authorization_credentials"))
        .await
        .expect("read")
        .expect("canonical record");
    let parsed: serde_json::Value = serde_json::from_str(&canonical).expect("json");
    assert_eq!(parsed["version"], 2);
    assert_eq!(parsed["tokens"]["access_token"], "tok-access-1");
    assert_eq!(parsed["client_information"]["client_id"], "client-from-dcr");
    assert!(parsed["generation"].as_str().is_some_and(|g| !g.is_empty()));
    // The legacy mirror keys are written in the same batch.
    assert!(
        store
            .load(&credential_key(&key_prefix, "tokens"))
            .await
            .unwrap()
            .is_some()
    );
    // The pending record is gone and the lease was taken once.
    assert!(
        store
            .load(&credential_key(&key_prefix, "pending_authorization"))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(*store.lease_acquisitions.lock().unwrap(), 1);
}

#[tokio::test]
async fn follower_returns_pending_without_listening_when_the_lease_is_held() {
    let store = MemoryStore {
        lease_held: true,
        ..MemoryStore::default()
    };
    let runtime = FakeRuntime {
        callbacks: Vec::new(),
        requests: Mutex::new(Vec::new()),
        listen_calls: Mutex::new(0),
    };
    let outcome = run_lead(&store, &runtime, &input(), &CancellationToken::new()).await;
    assert_eq!(
        outcome,
        FlowOutcome::Pending {
            authorization_url: None
        }
    );
    assert_eq!(*runtime.listen_calls.lock().unwrap(), 0);
    assert!(runtime.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_forged_callback_with_the_wrong_state_is_ignored_and_the_real_one_completes() {
    let store = MemoryStore::default();
    let runtime = FakeRuntime {
        callbacks: vec![
            "/callback?code=evil&state=forged".to_owned(),
            callback(&expected_state()),
        ],
        requests: Mutex::new(Vec::new()),
        listen_calls: Mutex::new(0),
    };
    assert_eq!(
        run_lead(&store, &runtime, &input(), &CancellationToken::new()).await,
        FlowOutcome::Authorized
    );
}

#[tokio::test]
async fn an_authorization_error_fails_the_flow_and_removes_the_pending_record() {
    let store = MemoryStore::default();
    let runtime = FakeRuntime {
        callbacks: vec![format!(
            "/callback?error=access_denied&state={}",
            expected_state()
        )],
        requests: Mutex::new(Vec::new()),
        listen_calls: Mutex::new(0),
    };
    let outcome = run_lead(&store, &runtime, &input(), &CancellationToken::new()).await;
    assert!(matches!(outcome, FlowOutcome::Failed { .. }), "{outcome:?}");
    let key_prefix = credential_key_prefix("e2e-remote", SERVER_URL, None, Some("mcp:tools"), None);
    assert!(
        store
            .load(&credential_key(&key_prefix, "pending_authorization"))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn token_request_never_appears_in_an_error_or_outcome() {
    let store = MemoryStore::default();
    let runtime = FakeRuntime {
        callbacks: vec![format!(
            "/callback?error=access_denied&state={}",
            expected_state()
        )],
        requests: Mutex::new(Vec::new()),
        listen_calls: Mutex::new(0),
    };
    let outcome = run_lead(&store, &runtime, &input(), &CancellationToken::new()).await;
    let text = format!("{outcome:?}");
    assert!(!text.contains("tok-access-1"));
    assert!(!text.contains(CODE));
}
