// Semantics copied from apps/zcode-cli/packages/adapters/src/auth/siwc/siwc-access-token-resolver.ts
// (`listSiwcPlanAccounts`), siwc-account-store.ts (`readSiwcAccountIndex`), packages/provider/src/
// chatgpt-plan-account-derivation.ts (`deriveChatGptPlanAccountConfigSnapshot`) and
// apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts (the provider label).
//! Fork: ChatGPT Plan (SIWC) accounts in the provider registry (specs/fork-rust-chatgpt-plan.md, rules 1-6).
//!
//! The Desktop Host owns sign-in, refresh and every `oauth:chatgpt:*` write; this module only reads the account index,
//! token presence and the granted scopes, then replaces the builtin template rule `account:chatgpt-plan` with one
//! rule per signed-in account.

use rust_cli_base::account::{
    CHATGPT_PLAN_PROVIDER, chatgpt_plan_account_provider, is_chatgpt_plan_account_key,
};
use serde_json::{Value, json};

use crate::credentials::{CredentialError, Credentials};

/// Node `SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY`.
const ACCOUNT_INDEX: &str = "oauth:chatgpt:accounts";
/// Node `SIWC_PLAN_USAGE_SCOPE`: without it the account is identity-only (no plan inference).
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";

/// One signed-in account as the registry needs it. It enters the snapshot signature (hashed, never logged).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChatGptAccount {
    pub key: String,
    /// Node standalone label: `email ?? name ?? accountKey`.
    pub label: String,
    pub entitled: bool,
}

impl ChatGptAccount {
    /// The registry input form (it enters the snapshot signature).
    pub fn to_json(accounts: &[Self]) -> Value {
        accounts
            .iter()
            .map(|account| json!({"key": account.key, "label": account.label, "entitled": account.entitled}))
            .collect()
    }

    pub fn from_json(value: &Value) -> Vec<Self> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                Some(Self {
                    key: entry["key"].as_str()?.to_owned(),
                    label: entry["label"].as_str()?.to_owned(),
                    entitled: entry["entitled"] == true,
                })
            })
            .collect()
    }
}

/// Node `buildSiwcAccountCredentialKeys` (only the keys read here).
fn slot(key: &str, name: &str) -> String {
    format!("oauth:chatgpt:{key}:{name}")
}

/// Node `parseAccountRecord`: a valid key and a non-empty `sub`; empty email / name count as absent.
fn record(entry: &Value) -> Option<(String, String)> {
    let key = entry["accountKey"]
        .as_str()
        .filter(|key| is_chatgpt_plan_account_key(key))?;
    entry["sub"].as_str().filter(|sub| !sub.trim().is_empty())?;
    let text = |name: &str| {
        entry[name]
            .as_str()
            .filter(|value| !value.trim().is_empty())
    };
    let key = key.trim().to_owned();
    let label = text("email")
        .or_else(|| text("name"))
        .map_or_else(|| key.clone(), str::to_owned);
    Some((key, label))
}

/// Node `listSiwcPlanAccounts`: index records that still hold an access or refresh token, with the plan entitlement.
/// An unparsable index is no accounts (Node returns `[]`); a value that cannot be decrypted is an error (the caller
/// keeps the last snapshot, specs/fork-rust-credential-cipher.md).
pub(crate) async fn accounts(
    credentials: &Credentials,
) -> Result<Vec<ChatGptAccount>, CredentialError> {
    let Some(index) = credentials.get(ACCOUNT_INDEX).await? else {
        return Ok(Vec::new());
    };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(index.expose()) else {
        return Ok(Vec::new());
    };
    let mut accounts: Vec<ChatGptAccount> = Vec::new();
    for (key, label) in entries.iter().filter_map(record) {
        // Node dedupes by key in the derivation (first record wins).
        if accounts.iter().any(|account| account.key == key) {
            continue;
        }
        // Node: `values[key]?.trim() !== undefined`, so any stored value counts, even an empty one. Only presence is
        // needed: the tokens are not decrypted here (the Host hands out the access token per request).
        let tokens = credentials.has(&slot(&key, "access_token"))
            || credentials.has(&slot(&key, "refresh_token"));
        if !tokens {
            continue;
        }
        let entitled = credentials
            .get(&slot(&key, "scopes"))
            .await?
            .is_some_and(|scopes| scopes.expose().split_whitespace().any(|s| s == PLAN_SCOPE));
        accounts.push(ChatGptAccount {
            key,
            label,
            entitled,
        });
    }
    Ok(accounts)
}

/// Node `deriveChatGptPlanAccountConfigSnapshot` on the builtin `config`: the template provider rule becomes one rule
/// per account (`access.entitled` from the scopes; the Node worker gets the same flag from the Host's account
/// overlay) and every builtin model rule of the template id is cloned per account in place. The template id itself
/// is never published.
pub(crate) fn derive(builtin: &mut Value, accounts: &[ChatGptAccount]) {
    let template = |rule: &Value| rule["providerId"] == CHATGPT_PLAN_PROVIDER;
    // A template provider rule whose `config.access` is not an object (a broken operator builtin file) publishes no
    // account entry and none of the template's model rules: fail-closed, and no panic on the JSON index assignments.
    let usable = builtin["providerConfigRules"]["providerRules"]
        .as_array()
        .is_some_and(|rules| {
            rules
                .iter()
                .filter(|rule| template(rule))
                .all(|rule| rule["config"]["access"].is_object())
        });
    let accounts = if usable { accounts } else { &[] };
    if let Some(rules) = builtin["providerConfigRules"]["providerRules"].as_array_mut() {
        *rules = std::mem::take(rules)
            .into_iter()
            .flat_map(|rule| {
                if !template(&rule) {
                    return vec![rule];
                }
                accounts
                    .iter()
                    .map(|account| {
                        let mut next = rule.clone();
                        next["providerId"] = json!(chatgpt_plan_account_provider(&account.key));
                        next["providerName"] = json!(account.label);
                        next["config"]["access"]["entitled"] = json!(account.entitled);
                        next
                    })
                    .collect()
            })
            .collect();
    }
    if let Some(rules) = builtin["modelConfigRules"]["builtinProviderModelRules"].as_array_mut() {
        *rules = std::mem::take(rules)
            .into_iter()
            .flat_map(|rule| {
                if !template(&rule) {
                    return vec![rule];
                }
                // `providerId` matched, so the rule is an object and the assignment below cannot panic.
                accounts
                    .iter()
                    .map(|account| {
                        let mut next = rule.clone();
                        next["providerId"] = json!(chatgpt_plan_account_provider(&account.key));
                        next
                    })
                    .collect()
            })
            .collect();
    }
}

/// Node `SIWC_FORBIDDEN_REQUEST_FIELDS` (siwc-request-compat.ts): the direct route rejects them.
const FORBIDDEN_FIELDS: [&str; 17] = [
    "background",
    "conversation",
    "max_output_tokens",
    "max_completion_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
];

/// Node `SIWC_COMPRESSION_THRESHOLD_BYTES`: larger bodies go out compressed (rule 14).
pub(crate) const COMPRESS_BODY_OVER: usize = 1024 * 1024;

/// Rules 12-13 as one trailing RFC 7396 patch (after the option-map patches, so it wins): forbidden fields removed,
/// `store: false` and `stream: true` forced, and `include` kept only for the models the AI SDK treats as reasoning
/// models (`store === false && isReasoningModel` is the only place Node adds it).
pub(crate) fn request_patch(model: &str) -> Value {
    let mut patch: serde_json::Map<String, Value> = FORBIDDEN_FIELDS
        .iter()
        .map(|field| ((*field).to_owned(), Value::Null))
        .collect();
    patch.insert("store".to_owned(), json!(false));
    patch.insert("stream".to_owned(), json!(true));
    if !ai_sdk_reasoning_model(model) {
        patch.insert("include".to_owned(), Value::Null);
    }
    Value::Object(patch)
}

/// AI SDK 3.0.65 `getOpenAILanguageModelCapabilities().isReasoningModel` (the Responses encoder's own predicate).
fn ai_sdk_reasoning_model(model: &str) -> bool {
    rust_cli_base::models::openai_reasoning_model(model)
}

#[cfg(test)]
#[path = "chatgpt_tests.rs"]
mod tests;
