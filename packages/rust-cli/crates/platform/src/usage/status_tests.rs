//! 内置家族的账号状态（platform.md §11.4）。
use serde_json::json;

use super::*;
use crate::fake_server_tests::{Harness, ZAI};
use crate::usage::tests::manual_login;

/// 没有凭据时两个家族都没有登录、算个人的计划；OAuth 登录（profile 与 access token）算登录，账号取 user_info 的邮箱；
/// 个人 provider 的手工 key 也算登录。
#[tokio::test]
async fn sign_in_comes_from_the_oauth_profile_or_a_manual_key() {
    let harness = Harness::new("http://127.0.0.1:9").await;
    let none = harness.platform.family_accounts().await;
    assert_eq!(
        none.iter().map(|f| f.family).collect::<Vec<_>>(),
        [Family::Zai, Family::Bigmodel]
    );
    assert!(
        none.iter()
            .all(|f| f.login == FamilyLogin::SignedOut && f.account.is_empty())
    );
    assert_eq!(none[0].plan, AccountPlan::Individual);
    assert_eq!(none[0].provider, ZAI);
    harness
        .write_credentials(&json!({
            "oauth:zai:access_token": "at-zai",
            "oauth:zai:user_info": json!({"user_id": "u1", "name": "Dev", "email": "dev@example.com"}).to_string(),
        }))
        .await;
    let oauth = harness.platform.family_accounts().await;
    assert_eq!(oauth[0].login, FamilyLogin::SignedIn);
    assert_eq!(oauth[0].account, "dev@example.com");
    assert_eq!(oauth[1].login, FamilyLogin::SignedOut);
    harness
        .write_credentials(&manual_login(ZAI, "sk-zai"))
        .await;
    let manual = harness.platform.family_accounts().await;
    assert_eq!(manual[0].login, FamilyLogin::SignedIn);
    assert_eq!(manual[0].account, "");
}

/// bigmodel 的 user_info 是 App 的 profile：账号取它的原始对象里的邮箱，没有时是显示名。
#[tokio::test]
async fn the_bigmodel_profile_names_the_account() {
    let harness = Harness::new("http://127.0.0.1:9").await;
    let profile = |raw: serde_json::Value| {
        json!({"id": "1", "username": "dev", "displayName": "Dev", "rawProfile": raw}).to_string()
    };
    harness
        .write_credentials(&json!({
            "oauth:bigmodel:access_token": "at-bm",
            "oauth:bigmodel:user_info": profile(json!({"email": "dev@example.com"})),
        }))
        .await;
    let with_email = harness.platform.family_accounts().await;
    assert_eq!(with_email[1].login, FamilyLogin::SignedIn);
    assert_eq!(with_email[1].account, "dev@example.com");
    harness
        .write_credentials(&json!({
            "oauth:bigmodel:access_token": "at-bm",
            "oauth:bigmodel:user_info": profile(json!({})),
        }))
        .await;
    assert_eq!(harness.platform.family_accounts().await[1].account, "Dev");
}

/// Desktop credentials that cannot be decrypted: only the value's own family is unreadable (fork spec F2, B7/B8).
struct OneBadValue;

#[async_trait::async_trait]
impl rust_cli_kernel_api::provider::CredentialCipher for OneBadValue {
    async fn encrypt(
        &self,
        plaintext: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        Ok(plaintext.to_owned())
    }

    async fn decrypt(
        &self,
        value: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        if value.starts_with("enc:v2:") {
            return Err(rust_cli_kernel_api::provider::CipherError::Decrypt {
                reason: "the stored credential could not be decrypted",
            });
        }
        Ok(value.to_owned())
    }
}

async fn platform_with(
    cipher: std::sync::Arc<dyn rust_cli_kernel_api::provider::CredentialCipher>,
    record: serde_json::Value,
) -> (tempfile::TempDir, crate::Platform) {
    let dir = tempfile::tempdir().unwrap();
    let paths = rust_cli_paths::StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    crate::test_support::write(paths.credentials().as_path(), record.to_string()).await;
    let services = crate::test_support::offline_services().await;
    let platform = crate::Platform::with_cipher(&paths, cipher, services);
    (dir, platform)
}

/// B7: the cipher cannot read the stored values: no family with values is reported signed out.
#[tokio::test]
async fn unreadable_credentials_are_not_signed_out() {
    let (_dir, platform) = platform_with(
        std::sync::Arc::new(crate::test_support::UnavailableCipher),
        json!({
            "oauth:zai:access_token": "enc:v2:os:0123456789abcdef01234567:x",
            "oauth:zai:user_info": "enc:v2:os:0123456789abcdef01234567:y",
            "oauth:bigmodel:access_token": "enc:v2:os:0123456789abcdef01234567:z",
        }),
    )
    .await;
    let families = platform.family_accounts().await;
    assert!(
        families.iter().all(|f| f.login == FamilyLogin::Unreadable),
        "{families:?}"
    );
    assert!(families.iter().all(|f| f.account.is_empty()));
}

/// B8: one family's token cannot be decrypted; the other family is read as usual.
#[tokio::test]
async fn one_undecryptable_family_does_not_mark_the_other() {
    let (_dir, platform) = platform_with(
        std::sync::Arc::new(OneBadValue),
        json!({
            "oauth:zai:access_token": "enc:v2:os:0123456789abcdef01234567:x",
            "oauth:bigmodel:access_token": "at-bm",
            "oauth:bigmodel:user_info": json!({"id": "1", "username": "dev", "displayName": "Dev"}).to_string(),
        }),
    )
    .await;
    let families = platform.family_accounts().await;
    assert_eq!(families[0].login, FamilyLogin::Unreadable);
    assert_eq!(families[1].login, FamilyLogin::SignedIn);
    assert_eq!(families[1].account, "Dev");
}
