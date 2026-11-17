//! Red tests for PR3 refresh under lock, reactive refresh and guarded invalidation
//! (`specs/fork-rust-mcp-oauth.md`, PR3 acceptance 1 to 8).
//! The authorization server is scripted per URL. The refresh lock is a real async mutex, so concurrent
//! callers queue on it as they would on the file lock.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::refresh::{RefreshError, RefreshInput, refresh_under_lock};
use super::*;
use crate::mcp::oauth::coordinator::McpOAuthCoordinator;

const SERVER_URL: &str = "https://mcp.example.test/mcp";
const AS_URL: &str = "https://auth.example.test";
const TOKEN_URL: &str = "https://auth.example.test/token";
const NOW: i64 = 1_700_000_000_000;

fn prefix() -> String {
    credential_key_prefix("e2e-remote", SERVER_URL, Some("client-1"), None, None)
}

fn key(name: &str) -> String {
    credential_key(&prefix(), name)
}

/// Canonical v2 record as Node writes it. `expires_at` in epoch ms.
fn canonical(access: &str, refresh: Option<&str>, generation: &str, expires_at: i64) -> String {
    let mut tokens = json!({"access_token": access, "token_type": "Bearer", "expires_in": 3600});
    if let Some(refresh) = refresh {
        tokens["refresh_token"] = json!(refresh);
    }
    json!({
        "client_information": {"client_id": "client-1"},
        "tokens": tokens,
        "generation": generation,
        "expires_at": expires_at,
        "issuer": AS_URL,
        "obtained_at": NOW - 1_000,
        "published_by": "seed",
        "version": 2,
    })
    .to_string()
}

/// A store with a real async refresh lock. Every write goes through `apply`, as in the platform.
/// The refresh lock is a one-permit semaphore: a permit is held across awaits in the test, which clippy
/// forbids for tokio mutex guards (`await-holding-invalid-types`).
struct RefreshStore {
    raw: Mutex<BTreeMap<String, String>>,
    refresh_lock: Arc<tokio::sync::Semaphore>,
}

impl Default for RefreshStore {
    fn default() -> Self {
        Self {
            raw: Mutex::new(BTreeMap::new()),
            refresh_lock: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
}

impl RefreshStore {
    fn value(&self, name: &str) -> Option<String> {
        self.raw.lock().unwrap().get(&key(name)).cloned()
    }

    /// Writes the canonical record and its legacy mirror in one batch, as Node's `publishCanonicalCredentials`
    /// does. A v2 record without its mirror means an older provider invalidated the tokens (Node), so the mirror
    /// is part of a usable record.
    async fn seed(&self, value: String) {
        let parsed: Value = serde_json::from_str(&value).expect("canonical JSON");
        self.apply(&[
            McpOAuthWrite::Put {
                key: key("authorization_credentials"),
                value: value.clone(),
            },
            McpOAuthWrite::Put {
                key: key("client_information"),
                value: parsed["client_information"].to_string(),
            },
            McpOAuthWrite::Put {
                key: key("tokens"),
                value: parsed["tokens"].to_string(),
            },
        ])
        .await
        .unwrap();
    }
}

struct OwnedLease(#[allow(dead_code)] tokio::sync::OwnedSemaphorePermit);

#[async_trait::async_trait]
impl AuthorizationLease for OwnedLease {
    async fn release(self: Box<Self>) {}
}

struct FakeLease;

#[async_trait::async_trait]
impl AuthorizationLease for FakeLease {
    async fn release(self: Box<Self>) {}
}

#[async_trait::async_trait]
impl McpOAuthStore for RefreshStore {
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
        Ok(Some(Box::new(FakeLease)))
    }

    async fn try_acquire_refresh_lock(
        &self,
        _key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        let permit = self
            .refresh_lock
            .clone()
            .acquire_owned()
            .await
            .expect("refresh lock semaphore is open");
        Ok(Some(Box::new(OwnedLease(permit))))
    }
}

/// What the token endpoint answers.
#[derive(Clone)]
enum TokenReply {
    /// 200 with this JSON body.
    Json(Value),
    /// A 4xx or 5xx with this JSON body.
    Status(u16, Value),
    /// The request never completes (network failure).
    Network,
}

type Route =
    Box<dyn Fn(&OAuthHttpRequest) -> Result<OAuthHttpResponse, OAuthHttpError> + Send + Sync>;

/// Scripted runtime: discovery answers from fixed documents, the token endpoint from `reply`.
struct ScriptedRuntime {
    route: Route,
    posts: Mutex<Vec<OAuthHttpRequest>>,
    gets: Mutex<Vec<String>>,
}

impl ScriptedRuntime {
    fn new(reply: TokenReply) -> Arc<Self> {
        Self::with_metadata(
            reply,
            Some(json!({"authorization_servers": [AS_URL], "resource": SERVER_URL})),
        )
    }

    /// `metadata` is the protected-resource document; `None` answers 404 (no metadata).
    fn with_metadata(reply: TokenReply, metadata: Option<Value>) -> Arc<Self> {
        let route: Route = Box::new(move |request: &OAuthHttpRequest| {
            let url = request.url.as_str();
            if url.ends_with("/.well-known/oauth-protected-resource/mcp") {
                return Ok(match &metadata {
                    Some(document) => response(200, document.clone()),
                    None => response(404, json!({})),
                });
            }
            if url.ends_with("/.well-known/oauth-authorization-server") {
                return Ok(response(
                    200,
                    json!({
                        "issuer": AS_URL,
                        "authorization_endpoint": "https://auth.example.test/authorize",
                        "token_endpoint": TOKEN_URL,
                        "response_types_supported": ["code"],
                        "code_challenge_methods_supported": ["S256"],
                    }),
                ));
            }
            if url == TOKEN_URL {
                return match &reply {
                    TokenReply::Json(body) => Ok(response(200, body.clone())),
                    TokenReply::Status(status, body) => Ok(response(*status, body.clone())),
                    TokenReply::Network => Err(OAuthHttpError("connection reset".to_owned())),
                };
            }
            Ok(response(404, json!({})))
        });
        Arc::new(Self {
            route,
            posts: Mutex::new(Vec::new()),
            gets: Mutex::new(Vec::new()),
        })
    }

    fn token_posts(&self) -> Vec<OAuthHttpRequest> {
        self.posts.lock().unwrap().clone()
    }

    /// The URLs fetched with GET, in order (discovery requests).
    fn gets(&self) -> Vec<String> {
        self.gets.lock().unwrap().clone()
    }
}

fn response(status: u16, body: Value) -> OAuthHttpResponse {
    OAuthHttpResponse {
        status,
        body: body.to_string(),
        www_authenticate: None,
    }
}

#[async_trait::async_trait]
impl McpOAuthRuntime for ScriptedRuntime {
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, OAuthHttpError> {
        Ok(vec![7; len])
    }

    fn now_ms(&self) -> i64 {
        NOW
    }

    async fn http(&self, request: OAuthHttpRequest) -> Result<OAuthHttpResponse, OAuthHttpError> {
        if request.method == "POST" {
            self.posts.lock().unwrap().push(request.clone());
        } else {
            self.gets.lock().unwrap().push(request.url.clone());
        }
        // Yield so that concurrent callers reach the lock while this request is in flight.
        tokio::task::yield_now().await;
        (self.route)(&request)
    }

    async fn bind_loopback(&self) -> Result<Box<dyn LoopbackListener>, OAuthHttpError> {
        Err(OAuthHttpError(
            "no loopback listener in refresh tests".to_owned(),
        ))
    }
}

fn input(reactive: bool, static_client_id: Option<&str>) -> RefreshInput {
    RefreshInput {
        server_name: "e2e-remote".to_owned(),
        server_url: SERVER_URL.to_owned(),
        key_prefix: prefix(),
        static_client_id: static_client_id.map(str::to_owned),
        client_secret: None,
        reactive,
    }
}

fn fresh_tokens(access: &str, refresh: Option<&str>) -> Value {
    let mut tokens = json!({"access_token": access, "token_type": "Bearer", "expires_in": 3600});
    if let Some(refresh) = refresh {
        tokens["refresh_token"] = json!(refresh);
    }
    tokens
}

/// The Node-generated fixture (`testdata/node_pr3_fixture.json`, generator `gen-pr3-fixture.mts`): Node's
/// `resolveRefreshLockPath` and the record its `publishCanonicalCredentials` writes after a refresh.
#[derive(serde::Deserialize)]
struct NodeFixture {
    #[serde(rename = "keyPrefix")]
    key_prefix: String,
    #[serde(rename = "refreshLockPath")]
    refresh_lock_path: String,
    raw: BTreeMap<String, String>,
}

#[tokio::test]
async fn node_written_refresh_lock_path_and_published_record_are_read_by_rust() {
    let fixture: NodeFixture =
        serde_json::from_str(include_str!("testdata/node_pr3_fixture.json")).expect("fixture");
    assert_eq!(
        refresh_lock_path(
            Path::new("/home/u/.zcode/v2/credentials.json"),
            &fixture.key_prefix
        )
        .to_string_lossy(),
        fixture.refresh_lock_path
    );

    let store = Arc::new(RefreshStore::default());
    store.raw.lock().unwrap().extend(fixture.raw);
    let runtime = ScriptedRuntime::new(TokenReply::Network);
    let coordinator =
        McpOAuthCoordinator::new(store.clone(), runtime.clone(), Arc::new(|_: &str| {}));
    // The record expires at 1_700_003_600_000 and the fake clock reads 1_700_000_000_000: fresh, no refresh.
    let bearer = coordinator
        .fresh_bearer(&RefreshInput {
            key_prefix: fixture.key_prefix,
            ..input(false, None)
        })
        .await
        .expect("store readable");
    assert_eq!(bearer.as_deref(), Some("Bearer new-access"));
    assert!(
        runtime.token_posts().is_empty(),
        "a fresh Node record is not refreshed"
    );
}

#[test]
fn refresh_lock_is_the_prefix_with_a_refresh_suffix() {
    // Node `resolveRefreshLockPath`: `<credentials dir>/<sanitized prefix>.refresh`, separate from `.authz`.
    let path = refresh_lock_path(
        Path::new("/home/u/.zcode/v2/credentials.json"),
        "mcp:oauth:0123",
    );
    assert_eq!(path, Path::new("/home/u/.zcode/v2/mcp-oauth-0123.refresh"));
    assert_ne!(
        path,
        lease_path(
            Path::new("/home/u/.zcode/v2/credentials.json"),
            "mcp:oauth:0123"
        )
    );
}

#[tokio::test]
async fn expired_token_is_refreshed_before_the_connect() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW + 10_000))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", Some("refresh-2"))));
    let coordinator =
        McpOAuthCoordinator::new(store.clone(), runtime.clone(), Arc::new(|_: &str| {}));

    let bearer = coordinator
        .fresh_bearer(&input(false, None))
        .await
        .expect("store readable");

    assert_eq!(bearer.as_deref(), Some("Bearer new"));
    assert_eq!(runtime.token_posts().len(), 1);
    let published: Value =
        serde_json::from_str(&store.value("authorization_credentials").unwrap()).unwrap();
    assert_ne!(published["generation"], json!("gen-1"));
    assert_eq!(
        published["published_by"],
        json!(format!("refresh:{}", prefix()))
    );
}

#[tokio::test]
async fn concurrent_refreshes_make_one_token_request() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", Some("refresh-2"))));

    // Hold the lock so both callers read generation gen-1 and queue behind it.
    let holder = store
        .refresh_lock
        .clone()
        .acquire_owned()
        .await
        .expect("refresh lock semaphore is open");
    let first = tokio::spawn({
        let (store, runtime) = (store.clone(), runtime.clone());
        async move { refresh_under_lock(&*store, &*runtime, &input(true, None)).await }
    });
    let second = tokio::spawn({
        let (store, runtime) = (store.clone(), runtime.clone());
        async move { refresh_under_lock(&*store, &*runtime, &input(true, None)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(holder);

    let a = first.await.unwrap().expect("refresh");
    let b = second.await.unwrap().expect("refresh");
    assert_eq!(a, "new");
    assert_eq!(b, "new");
    assert_eq!(
        runtime.token_posts().len(),
        1,
        "the second caller must reuse the winner's token, not rotate the refresh token again"
    );
}

#[tokio::test]
async fn refresh_keeps_the_refresh_token_when_the_response_omits_it() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", None)));

    refresh_under_lock(&*store, &*runtime, &input(true, None))
        .await
        .expect("refresh");

    let published: Value =
        serde_json::from_str(&store.value("authorization_credentials").unwrap()).unwrap();
    assert_eq!(published["tokens"]["access_token"], json!("new"));
    assert_eq!(published["tokens"]["refresh_token"], json!("refresh-1"));
    let mirror: Value = serde_json::from_str(&store.value("tokens").unwrap()).unwrap();
    assert_eq!(
        mirror["refresh_token"],
        json!("refresh-1"),
        "legacy mirror is written in the same batch"
    );
}

#[tokio::test]
async fn invalid_grant_drops_the_tokens_and_asks_for_authorization() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    store
        .apply(&[McpOAuthWrite::Put {
            key: key("tokens"),
            value: fresh_tokens("old", Some("refresh-1")).to_string(),
        }])
        .await
        .unwrap();
    store
        .apply(&[McpOAuthWrite::Put {
            key: key("client_information"),
            value: json!({"client_id": "client-1"}).to_string(),
        }])
        .await
        .unwrap();
    let runtime = ScriptedRuntime::new(TokenReply::Status(400, json!({"error": "invalid_grant"})));

    let error = refresh_under_lock(&*store, &*runtime, &input(true, None))
        .await
        .expect_err("invalid_grant must not return a token");

    assert_eq!(
        error,
        RefreshError::InteractiveRequired {
            reason: "invalid_grant"
        }
    );
    assert!(store.value("authorization_credentials").is_none());
    assert!(store.value("tokens").is_none());
    assert!(
        store.value("client_information").is_some(),
        "invalid_grant keeps the client registration as the seed for re-authorization"
    );
}

#[tokio::test]
async fn invalid_client_drops_the_registration_too() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    store
        .apply(&[McpOAuthWrite::Put {
            key: key("client_information"),
            value: json!({"client_id": "client-1"}).to_string(),
        }])
        .await
        .unwrap();
    let runtime = ScriptedRuntime::new(TokenReply::Status(401, json!({"error": "invalid_client"})));

    let error = refresh_under_lock(&*store, &*runtime, &input(true, None))
        .await
        .expect_err("invalid_client must not return a token");

    assert_eq!(
        error,
        RefreshError::InteractiveRequired {
            reason: "invalid_client"
        }
    );
    assert!(store.value("authorization_credentials").is_none());
    assert!(store.value("client_information").is_none());
}

#[tokio::test]
async fn invalid_client_with_a_static_client_id_is_a_configuration_error_and_deletes_nothing() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Status(401, json!({"error": "invalid_client"})));

    let error = refresh_under_lock(&*store, &*runtime, &input(true, Some("client-1")))
        .await
        .expect_err("a static client cannot be fixed by re-authorization");

    assert!(
        matches!(error, RefreshError::Configuration(_)),
        "got {error:?}"
    );
    assert!(store.value("authorization_credentials").is_some());
}

#[tokio::test]
async fn a_server_error_on_refresh_keeps_the_credentials() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Status(503, json!({"error": "server_error"})));

    let reactive = refresh_under_lock(&*store, &*runtime, &input(true, None)).await;
    assert!(
        matches!(reactive, Err(RefreshError::Temporary(_))),
        "got {reactive:?}"
    );

    // Proactive refresh falls back to the current token: the server has not rejected it yet.
    let proactive = refresh_under_lock(&*store, &*runtime, &input(false, None)).await;
    assert_eq!(proactive.expect("current token"), "old");

    assert!(store.value("authorization_credentials").is_some());
}

#[tokio::test]
async fn a_network_failure_on_refresh_keeps_the_credentials() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Network);

    let error = refresh_under_lock(&*store, &*runtime, &input(true, None))
        .await
        .expect_err("network failure is temporary");

    assert!(matches!(error, RefreshError::Temporary(_)), "got {error:?}");
    assert!(store.value("authorization_credentials").is_some());
}

#[tokio::test]
async fn guarded_delete_keeps_a_newer_write() {
    // Node `invalidateCanonicalCredentials` is a CAS on the canonical raw value: a record published
    // after the failure was observed must survive.
    let store = RefreshStore::default();
    let observed = canonical("old", Some("refresh-1"), "gen-1", NOW - 1);
    store
        .seed(canonical(
            "newer",
            Some("refresh-9"),
            "gen-2",
            NOW + 3_600_000,
        ))
        .await;

    store
        .apply(&[McpOAuthWrite::DeleteGuarded {
            guard_key: key("authorization_credentials"),
            expected: observed,
            keys: vec![key("authorization_credentials"), key("tokens")],
        }])
        .await
        .unwrap();

    assert!(
        store
            .value("authorization_credentials")
            .unwrap()
            .contains("refresh-9")
    );
}

#[tokio::test]
async fn coordinator_reports_no_bearer_when_the_grant_is_invalid() {
    let store = Arc::new(RefreshStore::default());
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW + 10_000))
        .await;
    let runtime = ScriptedRuntime::new(TokenReply::Status(400, json!({"error": "invalid_grant"})));
    let coordinator = McpOAuthCoordinator::new(store.clone(), runtime, Arc::new(|_: &str| {}));

    let bearer = coordinator
        .fresh_bearer(&input(false, None))
        .await
        .expect("store readable");

    assert_eq!(bearer, None);
}

/// Node `deriveCredentialPair` for a legacy-only record (no canonical key): the old `client_information` and
/// `tokens` keys refresh like a canonical record, and the refreshed record is published as canonical v2.
#[tokio::test]
async fn a_legacy_only_record_refreshes_and_is_published_canonical() {
    let store = RefreshStore::default();
    store.raw.lock().unwrap().insert(
        key("client_information"),
        json!({"client_id": "client-1"}).to_string(),
    );
    store.raw.lock().unwrap().insert(
        key("tokens"),
        json!({"access_token": "old", "token_type": "Bearer", "refresh_token": "refresh-1"})
            .to_string(),
    );
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", Some("refresh-2"))));
    let token = refresh_under_lock(&store, &*runtime, &input(true, None))
        .await
        .expect("a legacy refresh token is spent");
    assert_eq!(token, "new");
    assert_eq!(runtime.token_posts().len(), 1);
    let canonical: Value = serde_json::from_str(&store.value("authorization_credentials").unwrap())
        .expect("canonical record");
    assert_eq!(canonical["version"], json!(2));
    assert_eq!(canonical["tokens"]["access_token"], json!("new"));
}

/// Node `refreshAuthorization({ resource })`: the protected-resource metadata names the resource, and it covers
/// the server URL, so the refresh request carries RFC 8707 `resource`.
#[tokio::test]
async fn refresh_sends_the_resource_the_protected_resource_metadata_names() {
    let store = RefreshStore::default();
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::with_metadata(
        TokenReply::Json(fresh_tokens("new", Some("refresh-2"))),
        Some(json!({"authorization_servers": [AS_URL], "resource": SERVER_URL})),
    );
    refresh_under_lock(&store, &*runtime, &input(true, None))
        .await
        .expect("refresh");
    let body = runtime.token_posts()[0].body.clone().unwrap_or_default();
    assert!(
        body.contains("resource=https%3A%2F%2Fmcp.example.test%2Fmcp"),
        "resource missing from {body}"
    );
}

/// Without protected-resource metadata in the discovery record, Node passes no `resource`.
#[tokio::test]
async fn refresh_omits_resource_without_protected_resource_metadata() {
    let store = RefreshStore::default();
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    store
        .apply(&[
            McpOAuthWrite::Put {
                key: key("discovery_state"),
                value: json!({
                    "authorizationServerUrl": AS_URL,
                    "authorizationServerMetadata": {"issuer": AS_URL, "token_endpoint": TOKEN_URL},
                })
                .to_string(),
            },
            McpOAuthWrite::Put {
                key: key("discovery_state_fetched_at"),
                value: (NOW - 60_000).to_string(),
            },
        ])
        .await
        .unwrap();
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", Some("refresh-2"))));
    refresh_under_lock(&store, &*runtime, &input(true, None))
        .await
        .expect("refresh");
    let body = runtime.token_posts()[0].body.clone().unwrap_or_default();
    assert!(!body.contains("resource="), "unexpected resource in {body}");
}

/// Metadata whose `resource` does not cover the server is a discovery failure: proactive refresh keeps the
/// current token and sends no token request (Node `selectResourceURL` throws, `failSoft`).
#[tokio::test]
async fn a_resource_that_does_not_cover_the_server_fails_soft_without_a_token_request() {
    let store = RefreshStore::default();
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    let runtime = ScriptedRuntime::with_metadata(
        TokenReply::Json(fresh_tokens("new", Some("refresh-2"))),
        Some(
            json!({"authorization_servers": [AS_URL], "resource": "https://other.example.test/mcp"}),
        ),
    );
    let token = refresh_under_lock(&store, &*runtime, &input(false, None))
        .await
        .expect("proactive refresh keeps the current token");
    assert_eq!(token, "old");
    assert!(runtime.token_posts().is_empty());
}

/// A cached discovery record that is fresh and matches the issuer is used: no discovery request.
#[tokio::test]
async fn a_fresh_cached_discovery_record_is_used_without_discovery_requests() {
    let store = RefreshStore::default();
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    store
        .apply(&[
            McpOAuthWrite::Put {
                key: key("discovery_state"),
                value: json!({
                    "authorizationServerUrl": AS_URL,
                    "authorizationServerMetadata": {
                        "issuer": AS_URL,
                        "token_endpoint": TOKEN_URL,
                    },
                })
                .to_string(),
            },
            McpOAuthWrite::Put {
                key: key("discovery_state_fetched_at"),
                value: (NOW - 60_000).to_string(),
            },
        ])
        .await
        .unwrap();
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", Some("refresh-2"))));
    refresh_under_lock(&store, &*runtime, &input(true, None))
        .await
        .expect("refresh");
    assert!(
        runtime.gets().is_empty(),
        "discovery was fetched: {:?}",
        runtime.gets()
    );
    assert_eq!(runtime.token_posts().len(), 1);
}

/// An expired discovery record is rediscovered, and the new record is saved with its timestamp (Node
/// `resolveAsMetadata` saves what it discovered).
#[tokio::test]
async fn an_expired_discovery_record_is_rediscovered_and_saved() {
    let store = RefreshStore::default();
    store
        .seed(canonical("old", Some("refresh-1"), "gen-1", NOW - 1))
        .await;
    store.apply(&[
        McpOAuthWrite::Put {
            key: key("discovery_state"),
            value: json!({"authorizationServerUrl": AS_URL, "authorizationServerMetadata": {"issuer": AS_URL, "token_endpoint": TOKEN_URL}}).to_string(),
        },
        McpOAuthWrite::Put {
            key: key("discovery_state_fetched_at"),
            value: (NOW - 25 * 60 * 60 * 1000).to_string(),
        },
    ]).await.unwrap();
    let runtime = ScriptedRuntime::new(TokenReply::Json(fresh_tokens("new", Some("refresh-2"))));
    refresh_under_lock(&store, &*runtime, &input(true, None))
        .await
        .expect("refresh");
    assert!(
        !runtime.gets().is_empty(),
        "an expired record must be rediscovered"
    );
    assert_eq!(
        store.value("discovery_state_fetched_at").as_deref(),
        Some(NOW.to_string().as_str())
    );
}
