//! 凭据加解密与读取（platform.md §5.1）：与 Node 的 `credential-cipher.ts` 逐字节兼容。

use super::*;
use crate::test_support::{UnavailableCipher, read_text, write};
use rust_cli_kernel_api::provider::CipherError;
use std::sync::Arc;

fn secret(explicit: Option<&str>) -> CredentialSecret {
    CredentialSecret {
        explicit: explicit.map(RedactedString::new),
        platform: "linux".to_owned(),
        home: "/home/dev".to_owned(),
        username: "dev".to_owned(),
    }
}

/// Node 用同一 secret、IV 01..0c 加密 `sk-fixture-国` 的结果（`crypto.createCipheriv("aes-256-gcm")`）。
const NODE_CIPHERTEXT: &str = "enc:v1:AQIDBAUGBwgJCgsM.ugbwcGz6yNOO7MTsaggOWA.TSZzRstDM_2VG1gJJ9g";

#[test]
fn ciphertexts_match_node() {
    let cipher = V1Codec::new(&secret(None));
    assert_eq!(cipher.decrypt(NODE_CIPHERTEXT).unwrap(), "sk-fixture-国");
    let iv = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    assert_eq!(
        cipher.encrypt_with_iv("sk-fixture-国", iv).unwrap(),
        NODE_CIPHERTEXT
    );
    let other_iv = cipher.encrypt_with_iv("hello", [7; 12]).unwrap();
    assert!(other_iv.starts_with("enc:v1:") && !other_iv.contains('='));
    assert_eq!(cipher.decrypt(&other_iv).unwrap(), "hello");
}

#[test]
fn decrypt_errors_match_node() {
    let cipher = V1Codec::new(&secret(None));
    assert_eq!(cipher.decrypt("plain").unwrap(), "plain");
    assert_eq!(
        cipher.decrypt("enc:v1:a.b"),
        Err(CipherError::Decrypt {
            reason: "密文格式非法"
        })
    );
    assert_eq!(
        cipher.decrypt("enc:v1:AAAA.AAAA.AAAA"),
        Err(CipherError::Decrypt {
            reason: "IV 长度非法"
        })
    );
    assert_eq!(
        cipher.decrypt("enc:v1:AQIDBAUGBwgJCgsM.AAAA.AAAA"),
        Err(CipherError::Decrypt {
            reason: "AuthTag 长度非法"
        })
    );
    let other = V1Codec::new(&secret(Some("other")));
    assert_eq!(
        other.decrypt(NODE_CIPHERTEXT),
        Err(CipherError::Decrypt {
            reason: "密钥不匹配或密文已损坏"
        })
    );
    assert_eq!(
        CipherError::Decrypt {
            reason: "密文格式非法"
        }
        .to_string(),
        "凭据解密失败：密文格式非法"
    );
}

// ---- Red-first tests for the cipher seam (specs/fork-rust-credential-cipher.md, A1-A3, A12-A15). ----

#[tokio::test]
async fn standalone_codec_decrypts_v1_and_rejects_unknown_encrypted_prefixes() {
    let cipher = LocalCipher::new(&secret(None));
    assert_eq!(
        cipher.decrypt(NODE_CIPHERTEXT).await.unwrap(),
        "sk-fixture-国"
    );
    assert_eq!(cipher.decrypt("plain").await.unwrap(), "plain");
    // A3: an `enc:` value this build does not understand is an error, never the raw string.
    for value in ["enc:v9:abc", "enc:", "enc:v1"] {
        assert!(
            matches!(
                cipher.decrypt(value).await,
                Err(CipherError::Decrypt { .. })
            ),
            "{value} must be a decrypt error"
        );
    }
}

#[tokio::test]
async fn standalone_codec_reports_v2_as_unavailable_not_plaintext() {
    let cipher = LocalCipher::new(&secret(None));
    let v2 = "enc:v2:os:0123456789abcdef01234567:AAAA.AAAA.AAAA";
    // A2: the standalone agent cannot read desktop-encrypted values yet; this is not a logout.
    assert!(matches!(
        cipher.decrypt(v2).await,
        Err(CipherError::Unavailable { .. })
    ));
    assert!(matches!(
        cipher.encrypt("x").await.map(|v| v.starts_with("enc:v1:")),
        Ok(true)
    ));
}

#[tokio::test]
async fn an_unavailable_cipher_is_an_error_on_read_not_absence() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::with_cipher(storage(dir.path()), Arc::new(UnavailableCipher));
    let file = store.file().as_path().to_path_buf();
    write(&file, format!(r#"{{"a":"{NODE_CIPHERTEXT}","plain":"x"}}"#)).await;
    let credentials = store.read().await.unwrap();
    // A12: `present` used to turn this into `None`, which read as logged out.
    assert!(matches!(
        credentials.present("a").await,
        Err(CredentialError::Cipher(CipherError::Unavailable { .. }))
    ));
    assert!(matches!(
        credentials.get("plain").await,
        Err(CredentialError::Cipher(CipherError::Unavailable { .. }))
    ));
}

#[tokio::test]
async fn an_unavailable_cipher_aborts_the_write_and_keeps_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::with_cipher(storage(dir.path()), Arc::new(UnavailableCipher));
    let file = store.file().as_path().to_path_buf();
    let original = r#"{"a":"enc:v2:os:0123456789abcdef01234567:AAAA.AAAA.AAAA"}"#;
    write(&file, original).await;
    // A13: the closure reads through the unavailable cipher; nothing may be written.
    // The closure reads a stored value first; the read must fail, so nothing after it runs and nothing is written.
    let result = store
        .mutate(async |credentials| {
            credentials.get("a").await?;
            credentials.remove("other");
            Ok(())
        })
        .await;
    assert!(matches!(
        result,
        Err(CredentialError::Cipher(CipherError::Unavailable { .. }))
    ));
    assert_eq!(read_text(&file).await.unwrap(), original);
}

/// Encrypts before the lock is taken: the Node order (`mutateRawCredentialRecord` seals first, then locks).
struct LockProbe {
    lock: std::path::PathBuf,
    locked_during_seal: std::sync::Mutex<Option<bool>>,
}

#[async_trait::async_trait]
impl rust_cli_kernel_api::provider::CredentialCipher for LockProbe {
    async fn encrypt(&self, plaintext: &str) -> Result<String, CipherError> {
        let held = rust_cli_fs::read_optional(&self.lock)
            .await
            .ok()
            .flatten()
            .is_some();
        *self.locked_during_seal.lock().unwrap() = Some(held);
        Ok(format!("enc:v1:probe:{plaintext}"))
    }
    async fn decrypt(&self, value: &str) -> Result<String, CipherError> {
        Ok(value
            .strip_prefix("enc:v1:probe:")
            .unwrap_or(value)
            .to_owned())
    }
}

#[tokio::test]
async fn values_are_sealed_before_the_file_lock_is_taken() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join(".zcode/v2/credentials.json.lock");
    let probe = Arc::new(LockProbe {
        lock,
        locked_during_seal: std::sync::Mutex::new(None),
    });
    let store = CredentialStore::with_cipher(storage(dir.path()), probe.clone());
    let sealed = store.seal("token-1").await.unwrap();
    store
        .mutate(async |credentials| {
            credentials.put_sealed("k", sealed.clone());
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(*probe.locked_during_seal.lock().unwrap(), Some(false));
    assert_eq!(
        store
            .read()
            .await
            .unwrap()
            .present("k")
            .await
            .unwrap()
            .unwrap()
            .expose(),
        "token-1"
    );
}

#[test]
fn the_explicit_secret_wins_and_is_trimmed() {
    assert_eq!(secret(Some(" x ")).derive(), "x");
    assert_eq!(
        secret(Some("  ")).derive(),
        "zcode-credential-fallback:linux:/home/dev:dev"
    );
    assert!(
        ["darwin", "linux", "win32"].contains(&crate::node_platform())
            || !crate::node_platform().is_empty()
    );
}

fn storage(dir: &std::path::Path) -> StoragePath {
    rust_cli_paths::StoragePaths::resolve(&Default::default(), dir, dir).credentials()
}

#[tokio::test]
async fn records_are_read_from_disk_every_time() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(storage(dir.path()), &secret(None));
    assert_eq!(store.read().await.unwrap().get("a").await.unwrap(), None);
    let file = store.file().as_path().to_path_buf();
    write(
        &file,
        format!(r#"{{"a":"{NODE_CIPHERTEXT}","legacy":"plain","blank":"  ","bad":"enc:v1:x"}}"#),
    )
    .await;
    let credentials = store.read().await.unwrap();
    assert_eq!(
        credentials.present("a").await.unwrap().unwrap().expose(),
        "sk-fixture-国"
    );
    assert_eq!(
        credentials
            .present("legacy")
            .await
            .unwrap()
            .unwrap()
            .expose(),
        "plain"
    );
    assert!(credentials.present("blank").await.unwrap().is_none());
    // 坏密文是错误，不是“没有”：调用方不能把它当成未登录（A12）。
    assert!(credentials.present("bad").await.is_err());
    assert!(credentials.get("bad").await.is_err());

    write(&file, r#"{"a": 1}"#).await;
    assert!(matches!(
        store.read().await,
        Err(CredentialError::Corrupt(_))
    ));
}

#[tokio::test]
async fn writes_are_encrypted_pretty_printed_and_private() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(storage(dir.path()), &secret(None));
    let file = store.file().as_path().to_path_buf();
    write(
        &file,
        format!(r#"{{"keep":"{NODE_CIPHERTEXT}","drop":"x"}}"#),
    )
    .await;
    let sealed = store.seal("token-1").await.unwrap();
    store
        .mutate(async |credentials| {
            credentials.put_sealed("oauth:zai:access_token", sealed.clone());
            credentials.remove("drop");
            Ok(())
        })
        .await
        .unwrap();
    let text = read_text(&file).await.unwrap();
    // Node `JSON.stringify(value, null, 2) + "\n"`：键序保持，新键在末尾。
    let record: serde_json::Map<String, Value> = serde_json::from_str(&text).unwrap();
    let keys: Vec<&String> = record.keys().collect();
    assert_eq!(keys, ["keep", "oauth:zai:access_token"]);
    let encrypted = record["oauth:zai:access_token"].as_str().unwrap();
    assert!(encrypted.starts_with("enc:v1:") && !encrypted.contains("token-1"));
    assert_eq!(
        text,
        format!(
            "{{\n  \"keep\": \"{NODE_CIPHERTEXT}\",\n  \"oauth:zai:access_token\": \"{encrypted}\"\n}}\n"
        )
    );
    let credentials = store.read().await.unwrap();
    assert_eq!(
        credentials
            .present("oauth:zai:access_token")
            .await
            .unwrap()
            .unwrap()
            .expose(),
        "token-1"
    );
    #[cfg(unix)]
    #[expect(clippy::disallowed_methods, reason = "测试检查文件权限")]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let lock = dir.path().join(".zcode/v2/credentials.json.lock");
    // 锁目录已释放（还在的话读目录会报错）。
    assert!(matches!(rust_cli_fs::read_optional(&lock).await, Ok(None)));
}

#[tokio::test]
async fn corrupt_files_and_failed_changes_are_not_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(storage(dir.path()), &secret(None));
    let file = store.file().as_path().to_path_buf();
    write(&file, "not json").await;
    let sealed = store.seal("b").await.unwrap();
    let corrupt = store
        .mutate(async |credentials| {
            credentials.put_sealed("a", sealed.clone());
            Ok(())
        })
        .await;
    assert!(matches!(corrupt, Err(CredentialError::Corrupt(_))));
    assert_eq!(read_text(&file).await.unwrap(), "not json");

    write(&file, "{}").await;
    let sealed = store.seal("b").await.unwrap();
    let failed: Result<(), CredentialError> = store
        .mutate(async |credentials| {
            credentials.put_sealed("a", sealed.clone());
            Err(CredentialError::Write("refused".to_owned()))
        })
        .await;
    assert!(failed.is_err());
    assert_eq!(read_text(&file).await.unwrap(), "{}");
}

/// 同一进程里并发的读改写经目录锁互斥：每个任务写的键都在。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_do_not_lose_keys() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(storage(dir.path()), &secret(None));
    let mut tasks = Vec::new();
    for index in 0..8 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let sealed = store.seal("v").await.unwrap();
            store
                .mutate(async |credentials| {
                    credentials.put_sealed(&format!("key-{index}"), sealed.clone());
                    Ok(())
                })
                .await
                .unwrap();
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let credentials = store.read().await.unwrap();
    for index in 0..8 {
        assert!(
            credentials
                .present(&format!("key-{index}"))
                .await
                .unwrap()
                .is_some()
        );
    }
}
