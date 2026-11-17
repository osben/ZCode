//! The seams over the shared credential file and the process runtime. The platform crate implements
//! them (credential file with the `enc:v2` cipher, the authorization lease under `credentials.json`'s
//! directory, `rust-cli-net` for egress and the loopback listener, `ring` for entropy). This crate
//! never touches the file, the network or the entropy source itself: `clippy.toml` reserves those
//! categories for the entry crates (`rust-cli-net`, `rust-cli-platform`).

use std::net::SocketAddr;
use std::time::Duration;

use async_trait::async_trait;

/// The credential store could not be read or written (unreadable file, corrupt JSON, cipher unavailable).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("MCP OAuth credential store unavailable: {0}")]
pub struct McpOAuthStoreError(pub String);

/// One change of the shared credential file. A batch of writes is applied atomically in one
/// read-modify-write (`CredentialStore::mutate`), so a canonical record and its legacy mirror are
/// never observed half-written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpOAuthWrite {
    /// Replace the value of `key`.
    Put { key: String, value: String },
    /// Delete `key` only if its current value still equals `expected` (Node `deleteIfValue`).
    DeleteIfValue { key: String, expected: String },
    /// Delete every key in `keys` only if `guard_key` still holds `expected` (Node
    /// `invalidateCanonicalCredentials`, a compare-and-swap on the canonical raw value). A record published
    /// after the failure was observed therefore survives.
    DeleteGuarded {
        guard_key: String,
        expected: String,
        keys: Vec<String>,
    },
}

/// A held authorization lease. Dropping it without [`AuthorizationLease::release`] leaves the lock
/// directory for the owner-dead recovery path, as Node does.
#[async_trait]
pub trait AuthorizationLease: Send {
    /// Release the lease. Only the owner's lock entry is removed.
    async fn release(self: Box<Self>);
}

#[async_trait]
pub trait McpOAuthStore: Send + Sync {
    /// The decrypted value of `key`, or `None` when absent.
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError>;

    /// Apply `writes` in one atomic read-modify-write of the credential file.
    async fn apply(&self, writes: &[McpOAuthWrite]) -> Result<(), McpOAuthStoreError>;

    /// Try the authorization lease for `key_prefix` (Node `tryAcquireAuthorizationLease`): wait at most
    /// 250 ms with a 25 ms retry and a 100 ms owner-less grace. `Ok(None)` means another live caller
    /// holds it. Lock-path derivation lives in the implementation (`<credentials dir>/<sanitized>.authz`).
    async fn try_acquire_lease(
        &self,
        key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError>;

    /// Take the refresh lock for `key_prefix` (Node `resolveRefreshLockPath`, `withFileLock` with a 45 s wait).
    /// It is a separate file from the authorization lease. `Ok(None)` means the wait ran out.
    async fn try_acquire_refresh_lock(
        &self,
        key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError>;
}

/// Entropy, clock, egress and loopback listening for the flow. Only the entry crates implement it.
#[async_trait]
pub trait McpOAuthRuntime: Send + Sync {
    /// `len` cryptographically secure random bytes. A failing source is an error, never a predictable value.
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, OAuthHttpError>;

    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;

    /// Send one HTTP request through the network egress policy (proxy, trust roots, headers).
    async fn http(&self, request: OAuthHttpRequest) -> Result<OAuthHttpResponse, OAuthHttpError>;

    /// Listen on `127.0.0.1` with an ephemeral port (Node `createLocalhostOAuthCallbackServer`).
    async fn bind_loopback(&self) -> Result<Box<dyn LoopbackListener>, OAuthHttpError>;
}

/// One HTTP request of the OAuth protocol. Bodies are form or JSON encoded by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthHttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthHttpResponse {
    pub status: u16,
    pub body: String,
    /// The `WWW-Authenticate` header, if present (carried for PR3; PR2 does not parse it).
    pub www_authenticate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct OAuthHttpError(pub String);

/// A bound loopback listener. `accept` yields one connection at a time; the caller parses the request
/// line and writes the response through [`LoopbackConnection`].
#[async_trait]
pub trait LoopbackListener: Send {
    fn local_addr(&self) -> SocketAddr;
    async fn accept(&mut self) -> Result<Box<dyn LoopbackConnection>, OAuthHttpError>;
}

#[async_trait]
pub trait LoopbackConnection: Send {
    /// The request target of the first line, for example `/callback?code=...&state=...`.
    async fn request_target(&mut self) -> Result<String, OAuthHttpError>;
    /// Write a complete HTTP/1.1 response with `Connection: close` and close the connection.
    async fn respond(&mut self, status: u16, body: &str) -> Result<(), OAuthHttpError>;
}

/// Refresh lock wait budget (Node `REFRESH_LOCK_MAX_WAIT_MS`): it must cover one discovery and one token request.
pub const REFRESH_LOCK_MAX_WAIT: Duration = Duration::from_secs(45);

/// The lease wait budget of Node `oauth-lease.ts`, shared with the platform implementation.
pub const LEASE_RETRY_DELAY: Duration = Duration::from_millis(25);
pub const LEASE_MAX_WAIT: Duration = Duration::from_millis(250);
pub const LEASE_OWNERLESS_GRACE: Duration = Duration::from_millis(100);
