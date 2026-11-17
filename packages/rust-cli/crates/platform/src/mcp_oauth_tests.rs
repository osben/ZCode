//! Platform adapter over the sealed credential file: values Node sealed with its system cipher
//! (env secret, `enc:v2:env:`) must decrypt and parse through the Rust store.

use std::sync::Arc;

use rust_cli_ext::mcp::oauth::{load_canonical, load_pending};

use super::*;
use crate::credentials::CredentialSecret;
use crate::system_cipher::{SystemCipher, SystemCipherInputs};

const SEALED: &str = include_str!("../testdata/node_sealed_credentials.json");
const NODE_PREFIX: &str = "mcp:oauth:169077245c7eff5a2c01d143";
const NOW: i64 = 1_700_000_000_000;

async fn node_store(dir: &std::path::Path) -> CredentialsMcpOAuthStore {
    let fixture: serde_json::Value = serde_json::from_str(SEALED).expect("fixture json");
    // The store's own path (under the config dir), so the file written here is the one read back.
    let storage =
        rust_cli_paths::StoragePaths::resolve(&Default::default(), dir, dir).credentials();
    let file = storage.as_path().to_path_buf();
    rust_cli_fs::create_dir_all(file.parent().unwrap())
        .await
        .unwrap();
    rust_cli_fs::atomic_write(
        &file,
        serde_json::to_string_pretty(&fixture["raw"])
            .unwrap()
            .as_bytes(),
        crate::credentials::PRIVATE_WRITE,
    )
    .await
    .unwrap();
    let secret = fixture["secret"].as_str().unwrap().to_owned();
    let cipher = SystemCipher::new(SystemCipherInputs {
        credentials: file,
        env_secret: Some(rust_cli_base::secret::RedactedString::new(secret)),
        env_secret_file: None,
        legacy: CredentialSecret {
            explicit: None,
            platform: "darwin".to_owned(),
            home: "/Users/dev".to_owned(),
            username: "dev".to_owned(),
        },
    });
    CredentialsMcpOAuthStore::new(CredentialStore::with_cipher(storage, Arc::new(cipher)))
}

#[tokio::test]
async fn node_sealed_pending_record_is_decrypted_and_parsed() {
    let dir = tempfile::tempdir().unwrap();
    let store = node_store(dir.path()).await;
    let pending = load_pending(&store, NODE_PREFIX, NOW + 1_000)
        .await
        .expect("read")
        .expect("pending");
    assert_eq!(pending.attempt_id, "attempt-sealed-1");
    assert_eq!(
        pending.authorization_url,
        "https://auth.example.test/authorize?state=sealed"
    );
}

#[tokio::test]
async fn node_sealed_canonical_record_is_decrypted_and_parsed() {
    let dir = tempfile::tempdir().unwrap();
    let store = node_store(dir.path()).await;
    let canonical = load_canonical(&store, NODE_PREFIX)
        .await
        .expect("read")
        .expect("canonical");
    assert_eq!(canonical.generation, "gen-sealed-1");
}
