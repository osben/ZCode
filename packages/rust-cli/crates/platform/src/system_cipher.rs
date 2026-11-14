// Fork: a port of Node `packages/shared/src/credential-security/systemCredentialCipher.ts`
// (`createSystemCredentialCipher`) for standalone Rust. Differences are listed in the spec (F4).
//! Standalone `enc:v2` credential cipher (specs/fork-rust-credential-cipher.md F4).
//!
//! The key comes from `ZCODE_CREDENTIAL_SECRET`, `ZCODE_CREDENTIAL_SECRET_FILE`, the private default
//! `<dir>/credential-secret`, or the OS credential store entry the desktop app uses (service
//! [`SYSTEM_SERVICE`], account = hex sha256 of the `credentials.json` path). Values are
//! `enc:v2:<os|env>:<fingerprint>:<iv>.<tag>.<ciphertext>` (AES-256-GCM, unpadded base64url).
//! `enc:v1:` and plaintext values are read without the OS store.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use base64::Engine;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use rust_cli_base::TaskError;
use rust_cli_base::secret::RedactedString;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_fs::LockOptions;
use rust_cli_kernel_api::provider::{CipherError, CredentialCipher};
use sha2::{Digest, Sha256};

use crate::credentials::{BASE64URL, CredentialSecret, PRIVATE_WRITE};

/// The OS credential store service (Node `SYSTEM_SERVICE`).
pub const SYSTEM_SERVICE: &str = "ZCode Credential Encryption";
const SYSTEM_PREFIX: &str = "enc:v2:";
const LEGACY_PREFIX: &str = "enc:v1:";
const KEY_BYTES: usize = 32;
const TAG_BYTES: usize = 16;
/// Length of an unpadded base64url 32-byte key.
const ENCODED_KEY_CHARS: usize = 43;
const FINGERPRINT_CHARS: usize = 24;
/// Bounds of a managed secret, in UTF-8 bytes.
const SECRET_BYTES: std::ops::RangeInclusive<usize> = 32..=4096;
/// Node `unavailable()`: a locked or missing store is not a corrupt value (OAuth recovery must not drop the login).
const UNAVAILABLE: &str = "System credential storage is unavailable. Unlock the OS credential store and restart to retry; headless servers require Secret Service, ZCODE_CREDENTIAL_SECRET, or a readable ZCODE_CREDENTIAL_SECRET_FILE of 32–4096 bytes. Do not configure both managed secret sources.";

fn unavailable() -> CipherError {
    CipherError::Unavailable {
        reason: UNAVAILABLE,
    }
}

fn invalid() -> CipherError {
    CipherError::Decrypt {
        reason: "Invalid encrypted credential",
    }
}

/// The OS store failed (locked, denied, missing backend). The cipher logs the cause and reports it as unavailable.
/// The cause names no value or key.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct KeyStoreError(pub String);

/// Logs an OS store failure once and reports it as unavailable.
fn store_failed(error: &KeyStoreError) -> CipherError {
    tracing::warn!(
        event = "credentials.key_store.failed",
        error = %error,
        "the OS credential store failed"
    );
    unavailable()
}

/// Node `path.resolve` for an absolute path, lexically: `.` and repeated or trailing separators dropped, `..`
/// applied. The OS store account hashes this form, so it must match the desktop's.
fn resolved(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The OS store account: hex sha256 of the resolved credentials path (Node `createHash("sha256").update(filePath)`).
fn account_of(credentials: &Path) -> String {
    hex(&Sha256::digest(
        resolved(credentials).to_string_lossy().as_bytes(),
    ))
}

/// Where the OS key lives. Injected in tests: they never construct the OS store.
#[async_trait]
pub trait KeyStore: Send + Sync {
    /// The stored key; `None` when there is no entry.
    async fn get(&self) -> Result<Option<String>, KeyStoreError>;
    async fn set(&self, value: &str) -> Result<(), KeyStoreError>;
}

/// What the entry point read for the cipher.
pub struct SystemCipherInputs {
    /// The absolute `credentials.json` path.
    pub credentials: PathBuf,
    /// `ZCODE_CREDENTIAL_SECRET` as given (not trimmed; empty is unset).
    pub env_secret: Option<RedactedString>,
    /// `ZCODE_CREDENTIAL_SECRET_FILE` (empty is unset).
    pub env_secret_file: Option<PathBuf>,
    /// The legacy fallback material (`enc:v1:` only).
    pub legacy: CredentialSecret,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Os,
    Env,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Self::Os => "os",
            Self::Env => "env",
        }
    }
}

/// Key material. No `Debug`: it must never be printed.
#[derive(Clone)]
struct Key {
    bytes: [u8; KEY_BYTES],
    source: Source,
    /// The managed secret this key came from: the `enc:v1:` candidates start with it.
    legacy: Option<Arc<str>>,
}

impl Key {
    fn env(secret: &str) -> Self {
        Self {
            bytes: Sha256::digest(secret.as_bytes()).into(),
            source: Source::Env,
            legacy: Some(Arc::from(secret)),
        }
    }

    fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.bytes);
        let mut hex = hex(&digest);
        hex.truncate(FINGERPRINT_CHARS);
        hex
    }
}

type Lookup = Shared<BoxFuture<'static, Result<Key, CipherError>>>;
type LookupSlot = Mutex<Option<Lookup>>;

/// Clears the cached lookup when the lookup ends without a key and without having taken the `.keyring` lock: a lock
/// timeout or a panic before the lock is retried by the next call. Dropped on every exit of the task body, unwind
/// included.
struct Uncache {
    slot: Weak<LookupSlot>,
    acquired: Arc<AtomicBool>,
    succeeded: bool,
}

impl Drop for Uncache {
    fn drop(&mut self) {
        if self.succeeded || self.acquired.load(Ordering::SeqCst) {
            return;
        }
        if let Some(slot) = self.slot.upgrade() {
            // The owning task is the slot's only clearer, and a new lookup is cached only into an empty slot (under
            // this lock), so the cached lookup is this task's own.
            *slot.lock_unpoisoned() = None;
        }
    }
}

/// Runs `work` as its own task, owned by the returned lookup: it may hold the `.keyring` lock, and a `Shared` future
/// whose only caller gave up would stay suspended with the lock held. The task, not a caller, un-caches its retriable
/// failure, since no caller may be left. Call it with `slot` locked and cache the result before unlocking.
fn owned_lookup(
    slot: Weak<LookupSlot>,
    acquired: Arc<AtomicBool>,
    work: impl Future<Output = Result<Key, CipherError>> + Send + 'static,
) -> Lookup {
    let task = rust_cli_base::owned(async move {
        let mut uncache = Uncache {
            slot,
            acquired,
            succeeded: false,
        };
        let result = work.await;
        uncache.succeeded = result.is_ok();
        result
    });
    async move {
        task.await.unwrap_or_else(|error| {
            tracing::warn!(
                event = "credentials.key_lookup.failed",
                reason = match error {
                    TaskError::Panicked(_) => "panicked",
                    _ => "aborted",
                },
                "credential key lookup ended without a result"
            );
            Err(unavailable())
        })
    }
    .boxed()
    .shared()
}

/// The standalone `enc:v2` cipher (TUI, `-p`, `zcode login`).
pub struct SystemCipher {
    inner: Arc<Inner>,
    /// One key lookup per cipher, shared by concurrent calls. A failure stays cached only when the lock was taken
    /// (a denied prompt is not repeated; a lock timeout is retried).
    key: Arc<LookupSlot>,
    /// The managed secret for `enc:v1:` values once resolved (Node memoizes the key lookup it comes from).
    legacy: Mutex<Option<Option<Arc<str>>>>,
}

struct Inner {
    file: PathBuf,
    env_secret: Option<RedactedString>,
    env_secret_file: Option<PathBuf>,
    fallback: String,
    store: Arc<dyn KeyStore>,
    lock: LockOptions,
}

impl SystemCipher {
    /// With the OS credential store. The store is opened only when a lookup reaches it.
    #[must_use]
    pub fn new(inputs: SystemCipherInputs) -> Self {
        let account = account_of(&inputs.credentials);
        Self::with_store(
            inputs,
            Arc::new(OsKeyStore {
                account,
                #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
                entry: Arc::default(),
            }),
        )
    }

    /// With an injected key store (tests).
    #[must_use]
    pub fn with_store(inputs: SystemCipherInputs, store: Arc<dyn KeyStore>) -> Self {
        Self {
            inner: Arc::new(Inner {
                file: resolved(&inputs.credentials),
                env_secret: inputs.env_secret,
                env_secret_file: inputs.env_secret_file,
                fallback: inputs.legacy.fallback(),
                store,
                lock: LockOptions::default(),
            }),
            key: Arc::default(),
            legacy: Mutex::new(None),
        }
    }

    /// A shorter `.keyring` lock wait (tests).
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_lock_wait(mut self, wait: std::time::Duration) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("not shared yet")
            .lock
            .max_wait = wait;
        self
    }

    async fn key(&self, create: bool) -> Result<Key, CipherError> {
        let lookup = {
            let mut slot = self.key.lock_unpoisoned();
            match slot.as_ref() {
                Some(cached) => cached.clone(),
                None => {
                    let acquired = Arc::new(AtomicBool::new(false));
                    let lookup = owned_lookup(Arc::downgrade(&self.key), acquired.clone(), {
                        let inner = self.inner.clone();
                        async move { inner.lookup(create, &acquired).await }
                    });
                    *slot = Some(lookup.clone());
                    lookup
                }
            }
        };
        lookup.await
    }

    /// The managed secret for `enc:v1:` candidates, without the OS store.
    async fn legacy_secret(&self) -> Result<Option<Arc<str>>, CipherError> {
        if let Some(secret) = self.legacy.lock_unpoisoned().clone() {
            return Ok(secret);
        }
        let cached = self.key.lock_unpoisoned().clone();
        let secret = if let Some(Ok(key)) = cached.as_ref().and_then(Shared::peek) {
            key.legacy.clone()
        } else if let Some(key) = self.inner.explicit().await? {
            key.legacy
        } else {
            let inner = self.inner.clone();
            inner
                .locked(async || inner.default_source().await)
                .await?
                .and_then(|key| key.legacy)
        };
        // Only a resolved secret is kept: a lock timeout is retried by the next value.
        *self.legacy.lock_unpoisoned() = Some(secret.clone());
        Ok(secret)
    }

    async fn decrypt_legacy(&self, value: &str) -> Result<String, CipherError> {
        let secret = self.legacy_secret().await?;
        let fallback = self.inner.fallback.as_str();
        let mut candidates: Vec<&str> = Vec::new();
        let first = secret
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback);
        let trimmed = secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback);
        for candidate in [first, trimmed, fallback] {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
        let payload = &value[LEGACY_PREFIX.len()..];
        candidates
            .into_iter()
            .find_map(|candidate| open(payload, &Sha256::digest(candidate.as_bytes()).into()).ok())
            .ok_or_else(invalid)
    }
}

impl Inner {
    /// `ZCODE_CREDENTIAL_SECRET` or `ZCODE_CREDENTIAL_SECRET_FILE`; both set is unavailable.
    async fn explicit(&self) -> Result<Option<Key>, CipherError> {
        match (&self.env_secret, &self.env_secret_file) {
            (Some(_), Some(_)) => Err(unavailable()),
            (Some(secret), None) => Ok(Some(Key::env(secret.expose()))),
            (None, Some(path)) => match read_secret(path, false).await? {
                Some(secret) => Ok(Some(Key::env(&secret))),
                None => Err(unavailable()),
            },
            (None, None) => Ok(None),
        }
    }

    async fn lookup(&self, create: bool, acquired: &AtomicBool) -> Result<Key, CipherError> {
        if self.env_secret.is_some() || self.env_secret_file.is_some() {
            // Node caches the managed secret's lookup, failures included.
            acquired.store(true, Ordering::SeqCst);
        }
        if let Some(key) = self.explicit().await? {
            return Ok(key);
        }
        self.locked(async || {
            acquired.store(true, Ordering::SeqCst);
            self.os_or_default(create).await
        })
        .await
    }

    /// Runs `work` under the `<credentials.json>.keyring` lock (Node `withFileLock`); every failure is unavailable.
    async fn locked<T>(
        &self,
        work: impl AsyncFnOnce() -> Result<T, CipherError>,
    ) -> Result<T, CipherError> {
        let mut lock = self.file.clone().into_os_string();
        lock.push(".keyring");
        rust_cli_fs::with_file_lock(Path::new(&lock), &self.lock, async || {
            work().await.map_err(|_| Locked)
        })
        .await
        .map_err(|Locked| unavailable())
    }

    fn dir(&self) -> &Path {
        self.file.parent().unwrap_or_else(|| Path::new(""))
    }

    /// Inside the lock: the pinned source and the stored values decide between the default secret file and the OS
    /// store. `Ok(None)` when the OS store is the source.
    async fn default_source(&self) -> Result<Option<Key>, CipherError> {
        let (_, raw, use_os) = self.pinned().await?;
        if use_os {
            return Ok(None);
        }
        self.default_file(&raw).await
    }

    /// The default `credential-secret` when the OS source is not pinned; a file with `enc:v2:env:` values and no
    /// secret is unavailable.
    async fn default_file(&self, raw: &str) -> Result<Option<Key>, CipherError> {
        if let Some(secret) = read_secret(&self.dir().join("credential-secret"), true).await? {
            return Ok(Some(Key::env(&secret)));
        }
        if raw.contains("enc:v2:env:") {
            return Err(unavailable());
        }
        Ok(None)
    }

    /// `credential-source` (absent or `os\n`), the raw credentials file, and whether the OS source is pinned.
    async fn pinned(&self) -> Result<(Option<String>, String, bool), CipherError> {
        let pinned = read_text(&self.dir().join("credential-source")).await?;
        if pinned.as_deref().is_some_and(|source| source != "os\n") {
            return Err(unavailable());
        }
        let raw = read_text(&self.file).await?.unwrap_or_default();
        let use_os = pinned.is_some() || raw.contains("enc:v2:os:");
        Ok((pinned, raw, use_os))
    }

    async fn os_or_default(&self, create: bool) -> Result<Key, CipherError> {
        let (pinned, raw, use_os) = self.pinned().await?;
        if !use_os && let Some(key) = self.default_file(&raw).await? {
            return Ok(key);
        }
        let store = &self.store;
        let mut encoded = store.get().await.map_err(|error| store_failed(&error))?;
        if encoded.is_none() && create && !use_os && !raw.contains(SYSTEM_PREFIX) {
            let created = random_key()?;
            store
                .set(&created)
                .await
                .map_err(|error| store_failed(&error))?;
            let read_back = store.get().await.map_err(|error| store_failed(&error))?;
            if read_back.as_deref() != Some(created.as_str()) {
                return Err(unavailable());
            }
            encoded = Some(created);
        }
        let encoded = encoded
            .filter(|value| {
                value.len() == ENCODED_KEY_CHARS
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .ok_or_else(unavailable)?;
        let bytes: [u8; KEY_BYTES] = BASE64URL
            .decode(encoded)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(unavailable)?;
        if pinned.is_none() {
            rust_cli_fs::atomic_write(
                &self.dir().join("credential-source"),
                b"os\n",
                PRIVATE_WRITE,
            )
            .await
            .map_err(|_| unavailable())?;
        }
        Ok(Key {
            bytes,
            source: Source::Os,
            legacy: None,
        })
    }
}

/// A lock failure or the work's own: Node reports both as unavailable.
struct Locked;

impl From<std::io::Error> for Locked {
    fn from(_: std::io::Error) -> Self {
        Self
    }
}

/// A file read as text (Node `readFile(..., "utf8")`); `None` when it does not exist, unavailable on other errors.
async fn read_text(path: &Path) -> Result<Option<String>, CipherError> {
    rust_cli_fs::read_optional(path)
        .await
        .map(|bytes| bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
        .map_err(|_| unavailable())
}

/// Node `resolveManagedSecret` for one file. The default file (`discovered`) may be missing and must be private on
/// Unix; an explicit file must exist. Either must be a regular file of 32–4096 bytes.
async fn read_secret(path: &Path, discovered: bool) -> Result<Option<String>, CipherError> {
    let Some(stat) = rust_cli_fs::stat(path).await.map_err(|_| unavailable())? else {
        return if discovered {
            Ok(None)
        } else {
            Err(unavailable())
        };
    };
    if !stat.is_file || (discovered && !stat.owner_only) {
        return Err(unavailable());
    }
    let value = read_text(path).await?.ok_or_else(unavailable)?;
    if !SECRET_BYTES.contains(&value.len()) {
        return Err(unavailable());
    }
    Ok(Some(value))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

#[expect(
    clippy::disallowed_methods,
    reason = "platform 是加密强度随机数的入口：凭据密钥与 IV（README §4 的随机类别，F58）"
)]
fn random<const N: usize>() -> Result<[u8; N], CipherError> {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| CipherError::Encrypt {
            reason: "random bytes",
        })?;
    Ok(bytes)
}

fn random_key() -> Result<String, CipherError> {
    Ok(BASE64URL.encode(random::<KEY_BYTES>()?))
}

fn aead(key: &[u8; KEY_BYTES]) -> LessSafeKey {
    // A 32-byte key always fits AES-256.
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).unwrap_or_else(|_| unreachable!()))
}

/// Node `seal`: `<iv>.<tag>.<ciphertext>`.
fn seal(value: &str, key: &[u8; KEY_BYTES], iv: [u8; NONCE_LEN]) -> Result<String, CipherError> {
    let mut data = value.as_bytes().to_vec();
    let tag = aead(key)
        .seal_in_place_separate_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut data)
        .map_err(|_| CipherError::Encrypt {
            reason: "AES-GCM seal",
        })?;
    Ok(format!(
        "{}.{}.{}",
        BASE64URL.encode(iv),
        BASE64URL.encode(tag.as_ref()),
        BASE64URL.encode(&data)
    ))
}

/// Node `open`: three base64url parts (each may be empty), a 12-byte IV and a 16-byte tag.
fn open(payload: &str, key: &[u8; KEY_BYTES]) -> Result<String, CipherError> {
    let parts: Vec<&str> = payload.split('.').collect();
    let base64url = |part: &&str| {
        part.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if parts.len() != 3 || !parts.iter().all(base64url) {
        return Err(invalid());
    }
    let decode = |part: &str| BASE64URL.decode(part).map_err(|_| invalid());
    let iv: [u8; NONCE_LEN] = decode(parts[0])?.try_into().map_err(|_| invalid())?;
    let tag = decode(parts[1])?;
    if tag.len() != TAG_BYTES {
        return Err(invalid());
    }
    let mut data = decode(parts[2])?;
    data.extend_from_slice(&tag);
    let plain = aead(key)
        .open_in_place(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut data)
        .map_err(|_| invalid())?;
    Ok(String::from_utf8_lossy(plain).into_owned())
}

impl SystemCipher {
    async fn encrypt_with_iv(
        &self,
        value: &str,
        iv: [u8; NONCE_LEN],
    ) -> Result<String, CipherError> {
        let key = self.key(true).await?;
        Ok(format!(
            "{SYSTEM_PREFIX}{}:{}:{}",
            key.source.as_str(),
            key.fingerprint(),
            seal(value, &key.bytes, iv)?
        ))
    }
}

#[async_trait]
impl CredentialCipher for SystemCipher {
    async fn encrypt(&self, plaintext: &str) -> Result<String, CipherError> {
        self.encrypt_with_iv(plaintext, random::<NONCE_LEN>()?)
            .await
    }

    async fn decrypt(&self, value: &str) -> Result<String, CipherError> {
        let Some(rest) = value.strip_prefix(SYSTEM_PREFIX) else {
            if value.starts_with(LEGACY_PREFIX) {
                return self.decrypt_legacy(value).await;
            }
            if value.starts_with("enc:") {
                return Err(invalid());
            }
            return Ok(value.to_owned());
        };
        let parts: Vec<&str> = rest.split(':').collect();
        let [source, fingerprint, payload] = parts.as_slice() else {
            return Err(invalid());
        };
        let fingerprint_ok = fingerprint.len() == FINGERPRINT_CHARS
            && fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if payload.is_empty() || !["os", "env"].contains(source) || !fingerprint_ok {
            return Err(invalid());
        }
        let key = self.key(false).await?;
        if key.source.as_str() != *source || key.fingerprint() != *fingerprint {
            return Err(unavailable());
        }
        open(payload, &key.bytes)
    }
}

/// The OS store entry `@napi-rs/keyring` 2.1.2 addresses for `new AsyncEntry(service, account, {linux: {store:
/// "secret-service"}})`: no target, no modifiers. Built once per cipher, like Node's memoized entry; calls run on the
/// blocking pool.
struct OsKeyStore {
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "linux", target_os = "windows")),
        expect(dead_code, reason = "no OS store on this platform")
    )]
    account: String,
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    entry: Arc<std::sync::OnceLock<keyring_core::Entry>>,
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn os_entry<'a>(
    cell: &'a std::sync::OnceLock<keyring_core::Entry>,
    account: &str,
) -> Result<&'a keyring_core::Entry, KeyStoreError> {
    use keyring_core::api::CredentialStoreApi as _;
    if let Some(entry) = cell.get() {
        return Ok(entry);
    }
    let empty = std::collections::HashMap::new();
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::keychain::Store::new_with_configuration(&empty);
    #[cfg(target_os = "linux")]
    let store = dbus_secret_service_keyring_store::Store::new_with_configuration(&empty);
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new_with_configuration(&empty);
    let entry = store
        .and_then(|store| store.build(SYSTEM_SERVICE, account, None))
        .map_err(|error| KeyStoreError(error.to_string()))?;
    Ok(cell.get_or_init(|| entry))
}

#[async_trait]
impl KeyStore for OsKeyStore {
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    async fn get(&self) -> Result<Option<String>, KeyStoreError> {
        let (cell, account) = (self.entry.clone(), self.account.clone());
        rust_cli_base::blocking(move || match os_entry(&cell, &account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(KeyStoreError(error.to_string())),
        })
        .await
        .map_err(|error| KeyStoreError(error.to_string()))?
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    async fn set(&self, value: &str) -> Result<(), KeyStoreError> {
        let (cell, account, value) = (self.entry.clone(), self.account.clone(), value.to_owned());
        rust_cli_base::blocking(move || {
            os_entry(&cell, &account)?
                .set_password(&value)
                .map_err(|error| KeyStoreError(error.to_string()))
        })
        .await
        .map_err(|error| KeyStoreError(error.to_string()))?
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    async fn get(&self) -> Result<Option<String>, KeyStoreError> {
        Err(KeyStoreError(
            "no OS credential store on this platform".to_owned(),
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    async fn set(&self, _: &str) -> Result<(), KeyStoreError> {
        Err(KeyStoreError(
            "no OS credential store on this platform".to_owned(),
        ))
    }
}

#[cfg(test)]
#[path = "system_cipher_tests.rs"]
mod tests;
