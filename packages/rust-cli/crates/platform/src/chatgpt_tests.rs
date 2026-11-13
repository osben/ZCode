//! Fork: ChatGPT Plan accounts in the registry (specs/fork-rust-chatgpt-plan.md, R1-R5).

use std::sync::Arc;

use rust_cli_base::secret::RedactedString;
use rust_cli_paths::StoragePaths;
use serde_json::{Value, json};

use super::*;
use crate::credentials::{CredentialSecret, CredentialStore};
use crate::providers::{BUNDLED_BUILTIN, Registry};
use crate::test_support::write;

const K1: &str = "0123456789abcdef";
const K2: &str = "fedcba9876543210";
const K3: &str = "00000000000000aa";

fn secret() -> CredentialSecret {
    CredentialSecret {
        explicit: Some(RedactedString::new("s")),
        platform: "linux".to_owned(),
        home: "/home/dev".to_owned(),
        username: "dev".to_owned(),
    }
}

/// K1 entitled with an email, K2 identity-only with only a name, K3 indexed without tokens.
fn credentials_file() -> Value {
    let index = json!([
        {"accountKey": K1, "sub": "user-1", "email": "one@example.com", "name": "One", "addedAt": "x"},
        {"accountKey": K2, "sub": "user-2", "email": "  ", "name": "Two"},
        {"accountKey": K3, "sub": "user-3", "email": "three@example.com"},
        {"accountKey": "not-a-key", "sub": "user-4"},
        {"accountKey": K1, "sub": "user-1-again", "email": "dup@example.com"},
    ]);
    json!({
        "oauth:chatgpt:accounts": index.to_string(),
        format!("oauth:chatgpt:{K1}:access_token"): "at-1",
        format!("oauth:chatgpt:{K1}:scopes"): "openid offline_access chatgpt.tokens.use.direct",
        format!("oauth:chatgpt:{K2}:refresh_token"): "rt-2",
        format!("oauth:chatgpt:{K2}:scopes"): "openid profile",
    })
}

async fn store(dir: &std::path::Path, value: &Value) -> (CredentialStore, StoragePaths) {
    let paths = StoragePaths::resolve(&Default::default(), dir, dir);
    write(paths.credentials().as_path(), value.to_string()).await;
    (CredentialStore::new(paths.credentials(), &secret()), paths)
}

#[tokio::test]
async fn accounts_follow_the_node_listing() {
    let dir = tempfile::tempdir().unwrap();
    let (signed_in, _) = store(dir.path(), &credentials_file()).await;
    let credentials = signed_in.read().await.unwrap();
    assert_eq!(
        accounts(&credentials).await.unwrap(),
        [
            ChatGptAccount {
                key: K1.to_owned(),
                label: "one@example.com".to_owned(),
                entitled: true,
            },
            ChatGptAccount {
                key: K2.to_owned(),
                label: "Two".to_owned(),
                entitled: false,
            },
        ]
    );
}

#[tokio::test]
async fn a_missing_or_broken_index_is_no_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let (broken, _) = store(dir.path(), &json!({"oauth:chatgpt:accounts": "{not json"})).await;
    let credentials = broken.read().await.unwrap();
    assert!(accounts(&credentials).await.unwrap().is_empty());
    let (empty, _) = store(dir.path(), &json!({})).await;
    let credentials = empty.read().await.unwrap();
    assert!(accounts(&credentials).await.unwrap().is_empty());
}

#[test]
fn derivation_replaces_the_template_rule_and_clones_its_model_rules() {
    let builtin: Value = serde_json::from_str(BUNDLED_BUILTIN).unwrap();
    let mut config = builtin["config"].clone();
    let accounts = [
        ChatGptAccount {
            key: K1.to_owned(),
            label: "one@example.com".to_owned(),
            entitled: true,
        },
        ChatGptAccount {
            key: K2.to_owned(),
            label: "Two".to_owned(),
            entitled: false,
        },
    ];
    derive(&mut config, &accounts);
    let providers: Vec<&Value> = config["providerConfigRules"]["providerRules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|rule| {
            rule["providerId"]
                .as_str()
                .unwrap()
                .starts_with(CHATGPT_PLAN_PROVIDER)
        })
        .collect();
    assert_eq!(providers.len(), 2);
    assert_eq!(
        providers[0]["providerId"],
        format!("account:chatgpt-plan:{K1}")
    );
    assert_eq!(providers[0]["providerName"], "one@example.com");
    assert_eq!(
        providers[0]["config"]["access"],
        json!({"type": "chatgpt-account", "entitled": true})
    );
    assert_eq!(providers[0]["config"]["api"]["type"], "openai-responses");
    assert_eq!(providers[1]["config"]["access"]["entitled"], false);
    let model_rules: Vec<&Value> = config["modelConfigRules"]["builtinProviderModelRules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|rule| {
            rule["providerId"]
                .as_str()
                .is_some_and(|id| id.starts_with(CHATGPT_PLAN_PROVIDER))
        })
        .collect();
    let template_rules = builtin["config"]["modelConfigRules"]["builtinProviderModelRules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|rule| rule["providerId"] == CHATGPT_PLAN_PROVIDER)
        .count();
    assert!(template_rules > 0);
    assert_eq!(model_rules.len(), template_rules * 2);
    assert!(
        model_rules
            .iter()
            .all(|rule| rule["providerId"] != CHATGPT_PLAN_PROVIDER)
    );

    // No accounts: the family is absent.
    let mut empty = builtin["config"].clone();
    derive(&mut empty, &[]);
    assert!(!empty.to_string().contains("\"account:chatgpt-plan"));
}

/// A broken operator builtin file (the template's `config` or `access` is not an object) publishes no account entry
/// and no derived model rule, and does not panic.
#[test]
fn a_malformed_template_rule_is_dropped_without_a_panic() {
    let account = ChatGptAccount {
        key: K1.to_owned(),
        label: "one".to_owned(),
        entitled: true,
    };
    for config in [
        json!("text"),
        json!({"access": "chatgpt-account"}),
        json!(null),
    ] {
        let mut builtin = json!({
            "providerConfigRules": {"providerRules": [
                {"providerId": CHATGPT_PLAN_PROVIDER, "config": config},
                {"providerId": "other"},
            ]},
            "modelConfigRules": {"builtinProviderModelRules": [
                {"providerId": CHATGPT_PLAN_PROVIDER, "modelId": "m"},
            ]},
        });
        derive(&mut builtin, std::slice::from_ref(&account));
        assert_eq!(
            builtin["providerConfigRules"]["providerRules"],
            json!([{"providerId": "other"}])
        );
        assert_eq!(
            builtin["modelConfigRules"]["builtinProviderModelRules"],
            json!([])
        );
    }
}

async fn registry(store: CredentialStore, paths: &StoragePaths) -> Registry {
    Registry::new(
        None,
        paths.provider_config(),
        store.clone(),
        crate::test_support::offline_account(store).await,
    )
}

#[tokio::test]
async fn the_registry_publishes_one_entry_per_signed_in_account() {
    let dir = tempfile::tempdir().unwrap();
    let (credentials, paths) = store(dir.path(), &json!({})).await;
    let registry = registry(credentials, &paths).await;
    let first = registry.current().await;
    // R1/R2: no accounts, the template id is not even listed.
    assert!(
        first
            .snapshot
            .listed
            .iter()
            .all(|m| !m.provider.starts_with(CHATGPT_PLAN_PROVIDER))
    );

    // R5: an account signed in while running shows up on the next read.
    write(
        paths.credentials().as_path(),
        credentials_file().to_string(),
    )
    .await;
    let second = registry.current().await;
    assert_eq!(second.revision, first.revision + 1);
    let k1 = format!("account:chatgpt-plan:{K1}");
    let k2 = format!("account:chatgpt-plan:{K2}");
    let executable: Vec<&str> = second
        .snapshot
        .templates
        .iter()
        .filter(|t| t.provider.starts_with(CHATGPT_PLAN_PROVIDER))
        .map(|t| t.provider.as_str())
        .collect();
    // R1: K1 executable; R2: K2 identity-only is listed but not executable; R3: K3 has no tokens.
    assert!(!executable.is_empty());
    assert!(executable.iter().all(|provider| *provider == k1));
    assert!(second.snapshot.listed.iter().any(|m| m.provider == k2));
    assert!(
        second
            .snapshot
            .listed
            .iter()
            .all(|m| m.provider != CHATGPT_PLAN_PROVIDER && !m.provider.ends_with(K3))
    );
    // R4: the cloned model rule keeps the window and the label is the email.
    let sol = second
        .snapshot
        .templates
        .iter()
        .find(|t| t.provider == k1 && t.model == "gpt-6.1-sol")
        .expect("gpt-6.1-sol on K1");
    assert_eq!(sol.capabilities.context_window, 500_000);
    assert_eq!(sol.provider_name, "one@example.com");
    assert_eq!(sol.access, crate::providers::catalog::Access::ChatGpt);
    assert_eq!(sol.base_url, "https://api.openai.com/v1");
    // The revision is a counter: it never carries an account key or a label.
    let revision = second.revision.to_string();
    assert!(!revision.contains(K1) && !revision.contains("example.com"));
}

#[tokio::test]
async fn an_unreadable_token_keeps_the_last_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut value = credentials_file();
    let (credentials, paths) = store(dir.path(), &value).await;
    let registry = registry(credentials, &paths).await;
    let first = registry.current().await;
    assert!(
        first
            .snapshot
            .templates
            .iter()
            .any(|t| t.provider.ends_with(K1))
    );
    // A v1 value that does not decrypt is unreadable, not "signed out".
    value[format!("oauth:chatgpt:{K1}:scopes")] = json!("enc:v1:broken");
    write(paths.credentials().as_path(), value.to_string()).await;
    let second = registry.current().await;
    assert!(Arc::ptr_eq(&first, &second));
}
