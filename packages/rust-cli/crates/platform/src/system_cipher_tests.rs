//! Standalone system cipher (fork spec `fork-rust-credential-cipher.md` F4). Parity vectors come from Node
//! `createSystemCredentialCipher` with an injected key store (OS key = bytes 0..31; env secret below), generated
//! 2026-11-13; the fixed-IV ones are Node's `seal` with IV `000102…0b`, which Node also decrypts.
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

use super::*;

const OS_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const ENV_SECRET: &str = "  test-only env secret with spaces, 32+ bytes  ";
const NODE_OS: &str = "enc:v2:os:630dcd2966c4336691125448:cs2odDAW9KY0hhYT.kv0g9ygY_AkWt3hsQOnWuQ.H_fwCNmhkO2Xd-iIDOnFEwCAdIZ7";
const NODE_ENV: &str = "enc:v2:env:f8827786463c9e14abf913d4:3CzlxJm2lDuyumpB.u89zHaDcTqDRxIkGJSxfDQ.dH4WeQKbzkT2ojlwB2LkM_zT";
const NODE_V1_TRIMMED: &str = "enc:v1:90_LIBZrg8D8Daz0.lmLqC66_sWx2s2guveFDtQ.xXG_UbukliQCr1CbeV4";
const NODE_V1_RAW: &str = "enc:v1:frhtriw0VXaY3YTB.AjhybdYJ-emRDiTfdRCmQQ.LB2gzvHNOxftQw";
const FIXED_OS: &str = "enc:v2:os:630dcd2966c4336691125448:AAECAwQFBgcICQoL.0W7N4ZWoxCTEEMQ68Lq2VA.NXelb-WKsTv9Lfbi350dFfc";
const FIXED_ENV: &str = "enc:v2:env:f8827786463c9e14abf913d4:AAECAwQFBgcICQoL.htdMryeOOI3Qehu9M9v55Q.S8OxrI0XIRgGA4I9b6iE_tFB";
const IV: [u8; NONCE_LEN] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/// An in-memory key store that counts its calls.
#[derive(Default)]
struct Memory {
    value: Mutex<Option<String>>,
    calls: AtomicUsize,
    broken: bool,
}

impl Memory {
    fn holding(value: &str) -> Arc<Self> {
        Arc::new(Self {
            value: Mutex::new(Some(value.to_owned())),
            ..Self::default()
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl KeyStore for Memory {
    async fn get(&self) -> Result<Option<String>, KeyStoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.broken {
            return Err(KeyStoreError("broken".to_owned()));
        }
        Ok(self.value.lock().unwrap().clone())
    }

    async fn set(&self, value: &str) -> Result<(), KeyStoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.broken {
            return Err(KeyStoreError("broken".to_owned()));
        }
        *self.value.lock().unwrap() = Some(value.to_owned());
        Ok(())
    }
}

fn legacy() -> CredentialSecret {
    CredentialSecret {
        explicit: None,
        platform: "darwin".to_owned(),
        home: "/Users/dev".to_owned(),
        username: "dev".to_owned(),
    }
}

struct Setup {
    dir: tempfile::TempDir,
    env_secret: Option<&'static str>,
    env_secret_file: Option<PathBuf>,
}

impl Setup {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            env_secret: None,
            env_secret_file: None,
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.path().join("credentials.json")
    }

    fn cipher(&self, store: Arc<dyn KeyStore>) -> SystemCipher {
        SystemCipher::with_store(
            SystemCipherInputs {
                credentials: self.file(),
                env_secret: self.env_secret.map(RedactedString::new),
                env_secret_file: self.env_secret_file.clone(),
                legacy: legacy(),
            },
            store,
        )
    }

    async fn write(&self, name: &str, text: &str) {
        crate::test_support::write(&self.dir.path().join(name), text).await;
    }

    async fn read(&self, name: &str) -> Option<String> {
        crate::test_support::read_text(&self.dir.path().join(name)).await
    }
}

#[cfg(unix)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test sets the secret file's mode"
)]
async fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// B10: Node-encrypted values decrypt.
#[tokio::test]
async fn node_values_decrypt_with_the_same_key() {
    let os = Setup::new();
    os.write("credential-source", "os\n").await;
    let cipher = os.cipher(Memory::holding(OS_KEY));
    assert_eq!(
        cipher.decrypt(NODE_OS).await.unwrap(),
        "node os plaintext ✓"
    );
    assert_eq!(cipher.decrypt(FIXED_OS).await.unwrap(), "rust os plaintext");

    let env = Setup {
        env_secret: Some(ENV_SECRET),
        ..Setup::new()
    };
    let store = Arc::new(Memory::default());
    let cipher = env.cipher(store.clone());
    assert_eq!(
        cipher.decrypt(NODE_ENV).await.unwrap(),
        "node env plaintext"
    );
    assert_eq!(
        cipher.decrypt(FIXED_ENV).await.unwrap(),
        "rust env plaintext"
    );
    // v1 tries the raw secret, the trimmed one, then the fallback.
    assert_eq!(cipher.decrypt(NODE_V1_RAW).await.unwrap(), "legacy raw");
    assert_eq!(
        cipher.decrypt(NODE_V1_TRIMMED).await.unwrap(),
        "legacy trimmed"
    );
    assert_eq!(store.calls(), 0, "an env secret never touches the OS store");
}

/// B10: Rust output is what Node writes (and decrypts) for the same IV.
#[tokio::test]
async fn rust_writes_what_node_writes_for_the_same_iv() {
    let os = Setup::new();
    let cipher = os.cipher(Memory::holding(OS_KEY));
    assert_eq!(
        cipher
            .encrypt_with_iv("rust os plaintext", IV)
            .await
            .unwrap(),
        FIXED_OS
    );
    let env = Setup {
        env_secret: Some(ENV_SECRET),
        ..Setup::new()
    };
    let cipher = env.cipher(Arc::new(Memory::default()));
    assert_eq!(
        cipher
            .encrypt_with_iv("rust env plaintext", IV)
            .await
            .unwrap(),
        FIXED_ENV
    );
}

/// B13: a fresh store creates the OS key once, pins `credential-source`, and round-trips.
#[tokio::test]
async fn the_first_encrypt_creates_and_pins_the_os_key() {
    let setup = Setup::new();
    let store = Arc::new(Memory::default());
    let cipher = setup.cipher(store.clone());
    let sealed = cipher.encrypt("token").await.unwrap();
    assert!(sealed.starts_with("enc:v2:os:"), "{sealed}");
    assert_eq!(
        setup.read("credential-source").await.as_deref(),
        Some("os\n")
    );
    let key = store.value.lock().unwrap().clone().unwrap();
    assert_eq!(key.len(), ENCODED_KEY_CHARS);
    assert_eq!(cipher.decrypt(&sealed).await.unwrap(), "token");
    let calls = store.calls();
    let _ = cipher.encrypt("again").await.unwrap();
    assert_eq!(store.calls(), calls, "one key lookup per cipher");
}

/// B14: decrypting never creates a key: a v2 value without the OS key is unavailable, not corrupt.
#[tokio::test]
async fn a_missing_os_key_is_unavailable_and_never_created_by_decrypt() {
    let setup = Setup::new();
    setup
        .write("credentials.json", &format!(r#"{{"k":"{NODE_OS}"}}"#))
        .await;
    let store = Arc::new(Memory::default());
    let cipher = setup.cipher(store.clone());
    assert!(matches!(
        cipher.decrypt(NODE_OS).await,
        Err(CipherError::Unavailable { .. })
    ));
    assert!(store.value.lock().unwrap().is_none());
    // An existing `enc:v2:` value forbids creating a replacement key on encrypt too.
    let cipher = setup.cipher(store.clone());
    assert!(matches!(
        cipher.encrypt("x").await,
        Err(CipherError::Unavailable { .. })
    ));
    assert!(store.value.lock().unwrap().is_none());
}

/// B11: a fingerprint mismatch is unavailable; a bad shape or tag is corrupt.
#[tokio::test]
async fn a_wrong_key_is_unavailable_and_a_bad_tag_is_corrupt() {
    let setup = Setup::new();
    setup.write("credential-source", "os\n").await;
    let other = "BBECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    let cipher = setup.cipher(Memory::holding(other));
    assert!(matches!(
        cipher.decrypt(NODE_OS).await,
        Err(CipherError::Unavailable { .. })
    ));
    let cipher = setup.cipher(Memory::holding(OS_KEY));
    let tampered = NODE_OS.replace(".kv0g", ".Kv0g");
    assert!(matches!(
        cipher.decrypt(&tampered).await,
        Err(CipherError::Decrypt { .. })
    ));
    for bad in [
        "enc:v2:os:630dcd2966c4336691125448",
        "enc:v2:xx:630dcd2966c4336691125448:a.b.c",
        "enc:v2:os:630DCD2966C4336691125448:a.b.c",
        "enc:v3:whatever",
    ] {
        assert!(
            matches!(cipher.decrypt(bad).await, Err(CipherError::Decrypt { .. })),
            "{bad}"
        );
    }
}

/// Plaintext and v1 values never touch the OS store.
#[tokio::test]
async fn plaintext_and_v1_values_skip_the_os_store() {
    let setup = Setup::new();
    let store = Arc::new(Memory {
        broken: true,
        ..Memory::default()
    });
    let cipher = setup.cipher(store.clone());
    assert_eq!(cipher.decrypt("plain").await.unwrap(), "plain");
    let v1 = crate::credentials::V1Codec::new(&legacy())
        .encrypt_with_iv("old", IV)
        .unwrap();
    assert_eq!(cipher.decrypt(&v1).await.unwrap(), "old");
    assert_eq!(store.calls(), 0);
}

/// B12: both env sources, or a pinned source other than `os`.
#[tokio::test]
async fn both_managed_sources_or_a_foreign_pin_are_unavailable() {
    let both = Setup {
        env_secret: Some(ENV_SECRET),
        env_secret_file: Some(PathBuf::from("/nonexistent")),
        ..Setup::new()
    };
    assert!(matches!(
        both.cipher(Arc::new(Memory::default())).encrypt("x").await,
        Err(CipherError::Unavailable { .. })
    ));
    let pinned = Setup::new();
    pinned.write("credential-source", "env\n").await;
    assert!(matches!(
        pinned.cipher(Memory::holding(OS_KEY)).encrypt("x").await,
        Err(CipherError::Unavailable { .. })
    ));
}

/// The explicit secret file and the private default `credential-secret` are `env` keys; a short file is unavailable.
#[tokio::test]
async fn secret_files_are_env_keys() {
    let explicit = Setup::new();
    explicit.write("secret.txt", ENV_SECRET).await;
    let explicit = Setup {
        env_secret_file: Some(explicit.dir.path().join("secret.txt")),
        ..explicit
    };
    let store = Arc::new(Memory::default());
    assert_eq!(
        explicit
            .cipher(store.clone())
            .decrypt(NODE_ENV)
            .await
            .unwrap(),
        "node env plaintext"
    );
    let default = Setup::new();
    default.write("credential-secret", ENV_SECRET).await;
    #[cfg(unix)]
    chmod(&default.dir.path().join("credential-secret"), 0o600).await;
    let cipher = default.cipher(store.clone());
    let sealed = cipher.encrypt("x").await.unwrap();
    assert!(
        sealed.starts_with("enc:v2:env:f8827786463c9e14abf913d4:"),
        "{sealed}"
    );
    assert_eq!(store.calls(), 0);
    assert_eq!(default.read("credential-source").await, None);

    let short = Setup::new();
    short.write("credential-secret", "too short").await;
    #[cfg(unix)]
    chmod(&short.dir.path().join("credential-secret"), 0o600).await;
    assert!(matches!(
        short.cipher(Arc::new(Memory::default())).encrypt("x").await,
        Err(CipherError::Unavailable { .. })
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn a_shared_default_secret_file_is_unavailable() {
    let setup = Setup::new();
    setup.write("credential-secret", ENV_SECRET).await;
    chmod(&setup.dir.path().join("credential-secret"), 0o644).await;
    assert!(matches!(
        setup.cipher(Arc::new(Memory::default())).encrypt("x").await,
        Err(CipherError::Unavailable { .. })
    ));
}

/// A store failure after the lock was taken stays cached: a denied prompt is not repeated.
#[tokio::test]
async fn a_store_failure_is_not_retried() {
    let setup = Setup::new();
    let store = Arc::new(Memory {
        broken: true,
        ..Memory::default()
    });
    let cipher = setup.cipher(store.clone());
    assert!(cipher.encrypt("x").await.is_err());
    let calls = store.calls();
    assert!(cipher.encrypt("x").await.is_err());
    assert_eq!(store.calls(), calls);
}

/// The managed secret for `enc:v1:` values is resolved once per cipher, like Node's memoized key lookup: later v1
/// values neither take the `.keyring` lock again nor read the secret file again.
#[cfg(unix)]
#[tokio::test]
async fn the_legacy_secret_is_resolved_once_per_cipher() {
    let setup = Setup::new();
    setup.write("credential-secret", ENV_SECRET).await;
    chmod(&setup.dir.path().join("credential-secret"), 0o600).await;
    let key: [u8; KEY_BYTES] = Sha256::digest(ENV_SECRET.as_bytes()).into();
    let value = format!("{LEGACY_PREFIX}{}", seal("legacy", &key, IV).unwrap());
    let cipher = setup.cipher(Arc::new(Memory::default()));
    assert_eq!(cipher.decrypt(&value).await.unwrap(), "legacy");
    rust_cli_fs::remove_optional(&setup.dir.path().join("credential-secret"))
        .await
        .unwrap();
    assert_eq!(
        cipher.decrypt(&value).await.unwrap(),
        "legacy",
        "the resolved secret is reused"
    );
}

/// A key store that answers only once released.
struct Gated {
    release: tokio::sync::Notify,
}

#[async_trait]
impl KeyStore for Gated {
    async fn get(&self) -> Result<Option<String>, KeyStoreError> {
        self.release.notified().await;
        Ok(Some(OS_KEY.to_owned()))
    }

    async fn set(&self, _value: &str) -> Result<(), KeyStoreError> {
        Err(KeyStoreError("broken".to_owned()))
    }
}

/// A caller that gives up while the key lookup holds the `.keyring` lock does not park the lookup: it finishes on its
/// own and releases the lock for other processes.
#[tokio::test]
async fn a_cancelled_caller_does_not_park_the_held_lock() {
    let setup = Setup::new();
    setup.write("credential-source", "os\n").await;
    let store = Arc::new(Gated {
        release: tokio::sync::Notify::new(),
    });
    let cipher = setup.cipher(store.clone());
    let lock = setup.dir.path().join("credentials.json.keyring.lock");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), cipher.decrypt(FIXED_OS))
            .await
            .is_err(),
        "the lookup waits for the store"
    );
    assert!(
        rust_cli_fs::is_dir(&lock).await,
        "the lookup holds the lock"
    );
    store.release.notify_one();
    let released = async {
        while rust_cli_fs::is_dir(&lock).await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), released)
        .await
        .expect("the lookup finishes without a caller and releases the lock");
    assert_eq!(cipher.decrypt(FIXED_OS).await.unwrap(), "rust os plaintext");
}

/// A lookup that times out on the `.keyring` lock after its only caller gave up is not cached: the next call takes
/// the lock again once it is free.
#[tokio::test]
async fn a_lock_timeout_after_the_caller_gave_up_is_retried() {
    let setup = Setup::new();
    setup.write("credential-source", "os\n").await;
    let cipher = setup
        .cipher(Memory::holding(OS_KEY))
        .with_lock_wait(Duration::from_millis(300));
    let mut lock = setup.file().into_os_string();
    lock.push(".keyring");
    let lock = PathBuf::from(lock);
    let (held, release) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    );
    let holder = tokio::spawn({
        let (lock, held, release) = (lock.clone(), held.clone(), release.clone());
        async move {
            rust_cli_fs::with_file_lock(&lock, &LockOptions::default(), async || {
                held.notify_one();
                release.notified().await;
                Ok::<_, std::io::Error>(())
            })
            .await
        }
    });
    held.notified().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), cipher.decrypt(FIXED_OS))
            .await
            .is_err(),
        "the lookup waits for the held lock"
    );
    // The orphaned lookup times out on the lock without a caller.
    tokio::time::sleep(Duration::from_millis(800)).await;
    release.notify_one();
    holder.await.unwrap().unwrap();
    assert_eq!(cipher.decrypt(FIXED_OS).await.unwrap(), "rust os plaintext");
}

/// A lookup that panics before it takes the lock is not cached either: the slot is cleared on the unwind, so the next
/// call starts a new lookup.
#[tokio::test]
async fn a_lookup_that_panics_before_the_lock_is_retried() {
    let slot: Arc<Mutex<Option<Lookup>>> = Arc::default();
    {
        let mut held = slot.lock().unwrap();
        let lookup = owned_lookup(
            Arc::downgrade(&slot),
            Arc::new(AtomicBool::new(false)),
            async { panic!("before the lock") },
        );
        *held = Some(lookup);
    }
    let lookup = slot.lock().unwrap().clone().expect("cached while it runs");
    assert!(lookup.await.is_err());
    assert!(
        slot.lock().unwrap().is_none(),
        "the failed lookup is not cached"
    );
}

/// The OS store account hashes the path Node's `path.resolve` gives, so the desktop's entry is found even when the
/// home directory is spelled with `.`, `..` or repeated separators.
#[cfg(unix)]
#[test]
fn the_account_hashes_the_resolved_path() {
    let expected = hex(&Sha256::digest(b"/Users/dev/.zcode/v2/credentials.json"));
    assert_eq!(
        account_of(Path::new("/Users/dev//./.zcode/v2/../v2/credentials.json")),
        expected
    );
    assert_eq!(
        account_of(Path::new("/Users/dev/.zcode/v2/credentials.json")),
        expected
    );
}
