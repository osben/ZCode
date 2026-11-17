//! The MCP OAuth seams (`rust_cli_ext::mcp::oauth`) over the platform: the credential file, the
//! authorization lease, the network egress, the loopback listener and the entropy source. Values are the
//! sealed ones Node writes; [`CredentialStore`] decrypts and encrypts them with the credential cipher
//! (`enc:v2`, see `system_cipher.rs`), so this module adds no cipher or file of its own.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use ring::rand::{SecureRandom, SystemRandom};
use rust_cli_ext::mcp::oauth::{
    AuthorizationLease, LoopbackConnection, LoopbackListener, McpOAuthRuntime, McpOAuthStore,
    McpOAuthStoreError, McpOAuthWrite, OAuthHttpError, OAuthHttpRequest, OAuthHttpResponse,
    REFRESH_LOCK_MAX_WAIT,
};
use rust_cli_fs::{FileLock, LockOptions, acquire_file_lock};
use rust_cli_net::{Egress, HttpRequest, loopback};

use crate::credentials::{CredentialError, CredentialStore};

/// Node `oauth-lease.ts` wait budget (its comments explain why it is not zero).
const LEASE_RETRY: Duration = Duration::from_millis(25);
const LEASE_MAX_WAIT: Duration = Duration::from_millis(250);
const LEASE_OWNERLESS_GRACE: Duration = Duration::from_millis(100);
/// Largest discovery, registration or token response read in full.
const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub(crate) struct CredentialsMcpOAuthStore {
    store: CredentialStore,
}

impl CredentialsMcpOAuthStore {
    pub(crate) fn new(store: CredentialStore) -> Self {
        Self { store }
    }

    pub(crate) fn into_dyn(self) -> Arc<dyn McpOAuthStore> {
        Arc::new(self)
    }
}

#[async_trait]
impl McpOAuthStore for CredentialsMcpOAuthStore {
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError> {
        let credentials = self.store.read().await.map_err(store_error)?;
        let value = credentials.get(key).await.map_err(store_error)?;
        Ok(value.map(|secret| secret.expose().to_owned()))
    }

    async fn apply(&self, writes: &[McpOAuthWrite]) -> Result<(), McpOAuthStoreError> {
        self.store
            .mutate(async |credentials| {
                for write in writes {
                    match write {
                        McpOAuthWrite::Put { key, value } => {
                            let sealed = self.store.seal(value).await?;
                            credentials.put_sealed(key, sealed);
                        }
                        McpOAuthWrite::DeleteIfValue { key, expected } => {
                            let current = credentials.get(key).await?;
                            if current.is_some_and(|secret| secret.expose() == expected.as_str()) {
                                credentials.remove(key);
                            }
                        }
                        // Node `invalidateCanonicalCredentials`: the guard is checked before any key is removed.
                        McpOAuthWrite::DeleteGuarded {
                            guard_key,
                            expected,
                            keys,
                        } => {
                            let current = credentials.get(guard_key).await?;
                            if current.is_some_and(|secret| secret.expose() == expected.as_str()) {
                                for key in keys {
                                    credentials.remove(key);
                                }
                            }
                        }
                    }
                }
                Ok(())
            })
            .await
            .map_err(store_error)
    }

    async fn try_acquire_lease(
        &self,
        key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        let path = rust_cli_ext::mcp::oauth::lease_path(self.store.file().as_path(), key_prefix);
        self.try_lock(&path, LEASE_MAX_WAIT)
            .await
            .map(|lease| lease.map(|lock| Box::new(lock) as Box<dyn AuthorizationLease>))
    }

    async fn try_acquire_refresh_lock(
        &self,
        key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        let path =
            rust_cli_ext::mcp::oauth::refresh_lock_path(self.store.file().as_path(), key_prefix);
        self.try_lock(&path, REFRESH_LOCK_MAX_WAIT)
            .await
            .map(|lease| lease.map(|lock| Box::new(lock) as Box<dyn AuthorizationLease>))
    }
}

impl CredentialsMcpOAuthStore {
    /// Take the file lock at `path`, waiting at most `max_wait`. `Ok(None)` means the wait ran out.
    async fn try_lock(
        &self,
        path: &std::path::Path,
        max_wait: Duration,
    ) -> Result<Option<FileLease>, McpOAuthStoreError> {
        // The lock directory sits beside `credentials.json`; on a fresh home that directory may not exist yet,
        // and the lock must not fail for it (it is the first write of an authorization or of a refresh).
        if let Some(dir) = path.parent() {
            rust_cli_fs::create_private_dir_all(dir)
                .await
                .map_err(|error| McpOAuthStoreError(format!("OAuth lock: {error}")))?;
        }
        let options = LockOptions {
            retry_delays: vec![LEASE_RETRY],
            ownerless_grace: LEASE_OWNERLESS_GRACE,
            max_wait,
        };
        match acquire_file_lock(path, &options).await {
            Ok(lock) => Ok(Some(FileLease(lock))),
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(error) => Err(McpOAuthStoreError(format!("OAuth lock: {error}"))),
        }
    }
}

/// The lease held by one flow. The lock directory is removed on release only for this owner.
struct FileLease(FileLock);

#[async_trait]
impl AuthorizationLease for FileLease {
    async fn release(self: Box<Self>) {
        let lease = *self;
        lease.0.release().await;
    }
}

/// Only the static reason reaches the caller: a value or a key never appears in the message.
fn store_error(error: CredentialError) -> McpOAuthStoreError {
    McpOAuthStoreError(error.to_string())
}

/// Entropy, clock, egress and loopback for the OAuth flow. The entry crate owns these categories
/// (`clippy.toml`), so the ext crate reaches them only through this type.
pub(crate) struct McpOAuthRuntimeImpl {
    egress: Arc<Egress>,
}

impl McpOAuthRuntimeImpl {
    pub(crate) fn new(egress: Arc<Egress>) -> Self {
        Self { egress }
    }

    pub(crate) fn into_dyn(self) -> Arc<dyn McpOAuthRuntime> {
        Arc::new(self)
    }
}

#[async_trait]
impl McpOAuthRuntime for McpOAuthRuntimeImpl {
    #[expect(
        clippy::disallowed_methods,
        reason = "platform is the entropy entry crate (README §4, F58): OAuth verifiers, state and attempt ids"
    )]
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, OAuthHttpError> {
        let mut buffer = vec![0u8; len];
        SystemRandom::new()
            .fill(&mut buffer)
            .map_err(|_| OAuthHttpError("system random source is unavailable".to_owned()))?;
        Ok(buffer)
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "platform is the clock entry crate (README §4): the transaction TTL is wall-clock time"
    )]
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64)
    }

    async fn http(&self, request: OAuthHttpRequest) -> Result<OAuthHttpResponse, OAuthHttpError> {
        let mut http = match request.method {
            "POST" => HttpRequest::post(request.url, request.body.unwrap_or_default().into_bytes()),
            _ => HttpRequest::get(request.url),
        };
        for (name, value) in request.headers {
            http = http.header(name, value);
        }
        let response = self
            .egress
            .send(http)
            .await
            .map_err(|error| OAuthHttpError(error.to_string()))?;
        let status = response.status();
        let www_authenticate = response
            .headers()
            .get("www-authenticate")
            .map(str::to_owned);
        let body = response
            .text(RESPONSE_LIMIT)
            .await
            .map_err(|error| OAuthHttpError(error.to_string()))?;
        Ok(OAuthHttpResponse {
            status,
            body,
            www_authenticate,
        })
    }

    async fn bind_loopback(&self) -> Result<Box<dyn LoopbackListener>, OAuthHttpError> {
        let listener = loopback::LoopbackListener::bind_ephemeral()
            .await
            .map_err(|error| OAuthHttpError(format!("callback listener: {error}")))?;
        let addr = listener
            .local_addr()
            .map_err(|error| OAuthHttpError(format!("callback listener: {error}")))?;
        Ok(Box::new(CallbackListener { listener, addr }))
    }
}

struct CallbackListener {
    listener: loopback::LoopbackListener,
    addr: SocketAddr,
}

#[async_trait]
impl LoopbackListener for CallbackListener {
    fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    async fn accept(&mut self) -> Result<Box<dyn LoopbackConnection>, OAuthHttpError> {
        let connection = self
            .listener
            .accept()
            .await
            .map_err(|error| OAuthHttpError(format!("callback connection: {error}")))?;
        Ok(Box::new(CallbackConnection { connection }))
    }
}

struct CallbackConnection {
    connection: loopback::LoopbackConnection,
}

#[async_trait]
impl LoopbackConnection for CallbackConnection {
    async fn request_target(&mut self) -> Result<String, OAuthHttpError> {
        self.connection
            .request_target()
            .await
            .map_err(|error| OAuthHttpError(format!("callback request: {error}")))
    }

    async fn respond(&mut self, status: u16, body: &str) -> Result<(), OAuthHttpError> {
        self.connection
            .respond(status, body)
            .await
            .map_err(|error| OAuthHttpError(format!("callback response: {error}")))
    }
}

#[cfg(test)]
#[path = "mcp_oauth_tests.rs"]
mod tests;
