//! 平台层对内核暴露的两个端口（platform.md §4）：目录、默认选择与每请求的端点。

use rust_cli_base::{hosts, models};
use serde_json::json;

use super::*;
use crate::test_support::write;

const PERSONAL: &str = include_str!("../tests/fixtures/personal.json");
const ZAI: &str = "account:zai-individual-coding-plan";
const IDENTITY: &str = "key-0123456789abcdef01234567";

fn secret() -> CredentialSecret {
    CredentialSecret {
        explicit: Some(RedactedString::new("test-secret")),
        platform: "linux".to_owned(),
        home: "/home/dev".to_owned(),
        username: "dev".to_owned(),
    }
}

async fn platform(dir: &std::path::Path) -> (Platform, StoragePaths) {
    let paths = StoragePaths::resolve(&Default::default(), dir, dir);
    write(paths.provider_config().as_path(), PERSONAL).await;
    let services = crate::test_support::offline_services().await;
    (Platform::new(&paths, &secret(), services), paths)
}

fn selection(provider: &str, model: &str, reasoning: Option<&str>) -> ModelSelection {
    ModelSelection {
        reasoning: reasoning.map(str::to_owned),
        ..ModelSelection::new(provider.to_owned(), model.to_owned())
    }
}

#[tokio::test]
async fn the_catalog_and_default_come_from_the_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, _paths) = platform(dir.path()).await;
    let catalog = platform.catalog().await;
    assert_eq!(catalog.revision, 1);
    let names: Vec<String> = catalog
        .models
        .iter()
        .map(|model| format!("{}/{}", model.provider, model.model))
        .collect();
    assert_eq!(
        names,
        [
            format!("personal:responses/{}", models::GPT_5_4),
            format!("personal:gateway/{}", models::GLM_5),
            "personal:gateway/custom-chat".to_owned(),
            format!("personal:anthropic/{}", models::OPUS_5),
        ]
    );
    assert_eq!(
        platform.default_selection().await,
        Some(selection("personal:gateway", "custom-chat", Some("low")))
    );
}

#[tokio::test]
async fn api_key_providers_resolve_with_headers_and_patches() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, _paths) = platform(dir.path()).await;
    let endpoint = platform
        .endpoint(EndpointQuery::new(&selection(
            "personal:gateway",
            "custom-chat",
            Some("high"),
        )))
        .await
        .unwrap();
    assert_eq!(endpoint.protocol, WireProtocol::OpenAiChatCompletions);
    assert_eq!(endpoint.base_url, "https://gateway.example.com/v1");
    assert_eq!(endpoint.model, "custom-chat");
    assert_eq!(
        endpoint.credential,
        Credential::ApiKey(RedactedString::new("sk-personal-fixture"))
    );
    assert_eq!(
        endpoint.headers,
        vec![("X-Team".to_owned(), RedactedString::new("dev"))]
    );
    assert_eq!(
        endpoint.body_patches[1],
        json!({"max_completion_tokens": 8192})
    );
    assert!(!endpoint.renewable && !endpoint.capabilities.supports_mid_conversation_system);
    // `inputFormat.supportsImage` 为假：适配器把图片换成占位文字（model.md §10.5）。
    assert!(!endpoint.capabilities.supports_image);

    // Anthropic 协议的 provider 另带 Bearer（Node 的 Provider 适配器）；claude-opus-5 支持中途 system 消息。
    let opus = platform
        .endpoint(EndpointQuery::new(&selection(
            "personal:anthropic",
            models::OPUS_5,
            None,
        )))
        .await
        .unwrap();
    assert_eq!(
        opus.headers,
        vec![(
            "authorization".to_owned(),
            RedactedString::new("Bearer sk-ant-fixture")
        )]
    );
    assert!(opus.capabilities.supports_mid_conversation_system);
    assert!(opus.capabilities.supports_image);

    let missing = platform
        .endpoint(EndpointQuery::new(&selection(
            "personal:nokey",
            models::OPUS_5,
            None,
        )))
        .await;
    assert!(matches!(missing, Err(ModelError::InvalidRequest { .. })));
}

/// 请求交来的输出上限进 `maxOutputTokens` 补丁的输入（工作线 F95，platform.md §3.3）：取配置的 max、
/// `ZCODE_MAX_OUTPUT_TOKENS` 与它三者的最小值；不给时照旧是配置的 max（custom-chat 是 8192）。
#[tokio::test]
async fn the_request_output_limit_feeds_the_max_output_tokens_patch() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, _paths) = platform(dir.path()).await;
    let chat = selection("personal:gateway", "custom-chat", Some("high"));
    let patch = |endpoint: ModelEndpoint| endpoint.body_patches[1].clone();
    let limited = |limit| {
        platform.endpoint(EndpointQuery {
            output_limit: limit,
            ..EndpointQuery::new(&chat)
        })
    };
    assert_eq!(
        patch(limited(Some(4096)).await.unwrap()),
        json!({"max_completion_tokens": 4096})
    );
    assert_eq!(
        patch(limited(Some(500_000)).await.unwrap()),
        json!({"max_completion_tokens": 8192})
    );
    assert_eq!(
        patch(limited(None).await.unwrap()),
        patch(platform.endpoint(EndpointQuery::new(&chat)).await.unwrap())
    );
    let capped = platform.with_max_output_tokens(Some(2000));
    let both = capped
        .endpoint(EndpointQuery {
            output_limit: Some(4096),
            ..EndpointQuery::new(&chat)
        })
        .await
        .unwrap();
    assert_eq!(patch(both), json!({"max_completion_tokens": 2000}));
}

#[tokio::test]
async fn account_models_take_the_credential_on_every_request() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, paths) = platform(dir.path()).await;
    let select = selection(ZAI, models::GLM_5_3_ACCOUNT, Some("high"));
    assert!(matches!(
        platform.endpoint(EndpointQuery::new(&select)).await,
        Err(ModelError::InvalidRequest { .. })
    ));
    let login = |key: &str| {
        json!({
            account::identity_key(ZAI): IDENTITY,
            account::source_key(ZAI): "manual",
            account::manual_key(ZAI, IDENTITY): key,
        })
        .to_string()
    };
    write(paths.credentials().as_path(), login("sk-first")).await;
    let first = platform
        .endpoint(EndpointQuery::new(&select))
        .await
        .unwrap();
    assert_eq!(
        first.credential,
        Credential::ApiKey(RedactedString::new("sk-first"))
    );
    assert!(first.renewable);
    assert_eq!(first.base_url, hosts::ZAI_ANTHROPIC);
    // 同一个 key 被拒：不能续期。
    assert!(matches!(
        platform
            .endpoint(EndpointQuery {
                rejected: Some(&first),
                ..EndpointQuery::new(&select)
            })
            .await,
        Err(ModelError::Authentication { .. })
    ));
    // 凭据换了：下一次请求拿到新的。
    write(paths.credentials().as_path(), login("sk-second")).await;
    let renewed = platform
        .endpoint(EndpointQuery {
            rejected: Some(&first),
            ..EndpointQuery::new(&select)
        })
        .await
        .unwrap();
    assert_eq!(
        renewed.credential,
        Credential::ApiKey(RedactedString::new("sk-second"))
    );
    assert_eq!(
        platform.catalog().await.models[0].model,
        models::GLM_5_3_ACCOUNT,
        "account models come first"
    );
}

/// 缺口 G8（app-protocol.md §5.2）：注入的来源记下每次请求，给固定的 key 与一个请求头。
struct Supplied(std::sync::Mutex<Vec<rust_cli_kernel_api::provider::HeaderRequest>>);

#[async_trait]
impl rust_cli_kernel_api::provider::HeaderSource for Supplied {
    async fn request_auth(
        &self,
        request: rust_cli_kernel_api::provider::HeaderRequest,
    ) -> Result<rust_cli_kernel_api::provider::SuppliedAuth, ModelError> {
        let count = {
            let mut seen = self.0.lock().unwrap();
            seen.push(request);
            seen.len()
        };
        Ok(rust_cli_kernel_api::provider::SuppliedAuth {
            api_key: Some(RedactedString::new(format!("sk-host-{count}"))),
            headers: vec![("x-host-sign".to_owned(), RedactedString::new("signed"))],
        })
    }
}

/// 有注入的来源时，账号模型的凭据与请求头都向它要（带上会话与被拒凭据的指纹）；API key 的 provider 不问它。
#[tokio::test]
async fn an_injected_header_source_supplies_account_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, paths) = platform(dir.path()).await;
    let source = Arc::new(Supplied(std::sync::Mutex::new(Vec::new())));
    let platform = platform.with_header_source(source.clone());
    write(
        paths.credentials().as_path(),
        json!({
            account::identity_key(ZAI): IDENTITY,
            account::source_key(ZAI): "manual",
            account::manual_key(ZAI, IDENTITY): "sk-own",
        })
        .to_string(),
    )
    .await;
    let select = selection(ZAI, models::GLM_5_3_ACCOUNT, Some("high"));
    let session = rust_cli_kernel_api::ids::SessionId::new("session_1");
    let first = platform
        .endpoint(EndpointQuery {
            session: Some(&session),
            ..EndpointQuery::new(&select)
        })
        .await
        .unwrap();
    assert_eq!(
        first.credential,
        Credential::ApiKey(RedactedString::new("sk-host-1"))
    );
    let header = |endpoint: &ModelEndpoint, name: &str| {
        endpoint
            .headers
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, value)| value.expose().to_owned())
    };
    assert_eq!(header(&first, "x-host-sign").as_deref(), Some("signed"));
    assert_eq!(
        header(&first, "authorization").as_deref(),
        Some("Bearer sk-host-1")
    );
    let renewed = platform
        .endpoint(EndpointQuery {
            rejected: Some(&first),
            session: Some(&session),
            ..EndpointQuery::new(&select)
        })
        .await
        .unwrap();
    assert_eq!(
        renewed.credential,
        Credential::ApiKey(RedactedString::new("sk-host-2"))
    );
    let seen = source.0.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].session, Some(session.clone()));
    assert_eq!(seen[0].rejected_fingerprint, None);
    assert_eq!(
        seen[1].rejected_fingerprint.as_deref(),
        Some(token::fingerprint("sk-host-1").as_str())
    );
    assert!(!seen[0].account_type.is_empty() && !seen[0].mode.is_empty());
    // API key 的 provider 照旧用配置里的 key，不问来源。
    let personal = platform
        .endpoint(EndpointQuery {
            session: Some(&session),
            ..EndpointQuery::new(&selection("personal:gateway", "custom-chat", Some("high")))
        })
        .await
        .unwrap();
    assert!(matches!(personal.credential, Credential::ApiKey(_)));
    assert_eq!(source.0.lock().unwrap().len(), 2);
}

/// 修复线 F61（platform.md §4）：压缩的上限同步读已发布的快照——还没取过目录时答不出；取过之后是配置的
/// `contextWindow` 与 `maxOutputTokens.max`，不看团队项目；改了配置不重读，下一次取目录或端点之后才是新值。
#[tokio::test]
async fn limits_come_from_the_published_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, paths) = platform(dir.path()).await;
    let chat = selection("personal:gateway", "custom-chat", None);
    assert_eq!(platform.limits(&chat), None);
    platform.catalog().await;
    let expected = TokenLimits {
        context_window: 64_000,
        max_output_tokens: Some(8_192),
    };
    assert_eq!(platform.limits(&chat), Some(expected));
    // 内置规则 `.*glm-5.*`：200000 / 64000。
    let glm = platform.limits(&selection("personal:gateway", models::GLM_5, None));
    assert_eq!(
        glm,
        Some(TokenLimits {
            context_window: 200_000,
            max_output_tokens: Some(64_000),
        })
    );
    let mut teamed = chat.clone();
    teamed.connection = Some(Box::new(rust_cli_kernel_api::model::ModelConnection {
        product_id: "prod".to_owned(),
        organization_id: "org".to_owned(),
        project_id: "proj".to_owned(),
    }));
    assert_eq!(platform.limits(&teamed), Some(expected));
    assert_eq!(
        platform.limits(&selection("personal:gateway", "missing", None)),
        None
    );
    // 改配置：同步查询不重读；取端点（每个请求都取）之后是新值。
    let changed = PERSONAL.replace("\"contextWindow\": 64000", "\"contextWindow\": 100000");
    assert_ne!(changed, PERSONAL);
    write(paths.provider_config().as_path(), changed).await;
    assert_eq!(platform.limits(&chat), Some(expected));
    let _ = platform.endpoint(EndpointQuery::new(&chat)).await;
    assert_eq!(
        platform.limits(&chat).map(|limits| limits.context_window),
        Some(100_000)
    );
}

/// 工作线 F64（model.md §2.4）：账号登录的 provider 去掉配置里静态的 `authorization` 与 `x-api-key`（不分大小写），其余照发。
#[test]
fn account_providers_drop_static_auth_headers() {
    let header = |name: &str, value: &str| (name.to_owned(), RedactedString::new(value));
    let mut headers = vec![
        header("Authorization", "Bearer static"),
        header("X-API-KEY", "static"),
        header("X-Team", "dev"),
        header("x-api-key-id", "kept"),
    ];
    without_auth_headers(&mut headers);
    assert_eq!(
        headers,
        [header("X-Team", "dev"), header("x-api-key-id", "kept")]
    );
}

/// A15: the first read is already unreadable (nothing published yet). API-key models stay listed, the account
/// model's error says the credentials could not be read, and the credentials file is not rewritten.
#[tokio::test]
async fn a_first_read_that_is_unreadable_keeps_the_api_key_models() {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    write(paths.provider_config().as_path(), PERSONAL).await;
    let record = r#"{"oauth:zai:access_token":"enc:v2:os:0123456789abcdef01234567:x"}"#;
    write(paths.credentials().as_path(), record).await;
    let services = crate::test_support::offline_services().await;
    let platform = Platform::with_cipher(
        &paths,
        std::sync::Arc::new(crate::test_support::UnavailableCipher),
        services,
    );
    let catalog = platform.catalog().await;
    assert!(
        catalog
            .models
            .iter()
            .any(|model| model.provider == "personal:gateway"),
        "API-key models stay listed"
    );
    assert!(
        !catalog.models.iter().any(|model| model.provider == ZAI),
        "no account model is listed without readable credentials"
    );
    let error = platform
        .endpoint(EndpointQuery::new(&selection(
            ZAI,
            models::GLM_5_3_ACCOUNT,
            None,
        )))
        .await
        .unwrap_err();
    match error {
        ModelError::Authentication { message } => {
            assert!(message.contains("could not be read"), "{message}");
            assert!(!message.contains("not available"), "{message}");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    platform
        .endpoint(EndpointQuery::new(&selection(
            "personal:gateway",
            "custom-chat",
            None,
        )))
        .await
        .unwrap();
    assert_eq!(
        crate::test_support::read_text(paths.credentials().as_path())
            .await
            .unwrap(),
        record
    );
}

/// Fork: one entitled ChatGPT Plan account (specs/fork-rust-chatgpt-plan.md).
const CHATGPT_KEY: &str = "0123456789abcdef";

async fn chatgpt_signed_in(paths: &StoragePaths) -> String {
    let index = json!([{"accountKey": CHATGPT_KEY, "sub": "user-1", "email": "one@example.com"}]);
    write(
        paths.credentials().as_path(),
        json!({
            "oauth:chatgpt:accounts": index.to_string(),
            format!("oauth:chatgpt:{CHATGPT_KEY}:access_token"): "at-1",
            format!("oauth:chatgpt:{CHATGPT_KEY}:scopes"): "openid chatgpt.tokens.use.direct",
        })
        .to_string(),
    )
    .await;
    rust_cli_base::account::chatgpt_plan_provider(CHATGPT_KEY)
}

/// R14: standalone `zcode-rs` has no Host to ask, so a ChatGPT Plan request is refused (the token is never read).
#[tokio::test]
async fn standalone_refuses_chatgpt_plan_models() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, paths) = platform(dir.path()).await;
    let provider = chatgpt_signed_in(&paths).await;
    assert!(
        platform
            .catalog()
            .await
            .models
            .iter()
            .any(|model| model.provider == provider && model.model == "gpt-6.1-sol")
    );
    let error = platform
        .endpoint(EndpointQuery::new(&selection(
            &provider,
            "gpt-6.1-sol",
            Some("high"),
        )))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        ModelError::Authentication {
            message:
                "chatgpt_plan_host_required: ChatGPT Plan models need the ZCode app in Rust mode"
                    .to_owned(),
        }
    );
}

/// R6 (platform half) and R10: hosted, the token comes from the Host by provider id (no zhipu account fields); the
/// endpoint is renewable, compresses over 1 MiB, and its last patch is the SIWC shaping.
#[tokio::test]
async fn hosted_chatgpt_plan_requests_ask_the_host_and_shape_the_body() {
    let dir = tempfile::tempdir().unwrap();
    let (platform, paths) = platform(dir.path()).await;
    let source = Arc::new(Supplied(std::sync::Mutex::new(Vec::new())));
    let platform = platform.with_header_source(source.clone());
    let provider = chatgpt_signed_in(&paths).await;
    let select = selection(&provider, "gpt-6.1-sol", Some("high"));
    let endpoint = platform
        .endpoint(EndpointQuery::new(&select))
        .await
        .unwrap();
    assert_eq!(
        endpoint.credential,
        Credential::ApiKey(RedactedString::new("sk-host-1"))
    );
    assert!(endpoint.renewable);
    assert_eq!(endpoint.compress_body_over, Some(1_048_576));
    assert_eq!(endpoint.protocol, WireProtocol::OpenAiResponses);
    let seen = source.0.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].selection.provider, provider);
    assert!(seen[0].account_type.is_empty() && seen[0].mode.is_empty());
    // The bundled option maps (as Node applies them, before the SIWC shaping): effort, then the output cap.
    assert_eq!(endpoint.body_patches.len(), 3);
    assert_eq!(
        endpoint.body_patches[0],
        json!({"reasoning": {"effort": "high"}})
    );
    assert!(endpoint.body_patches[1]["max_output_tokens"].is_u64());
    let shaping = endpoint.body_patches.last().unwrap();
    for field in [
        "max_output_tokens",
        "temperature",
        "metadata",
        "user",
        "previous_response_id",
    ] {
        assert_eq!(shaping[field], serde_json::Value::Null, "{field}");
    }
    assert_eq!(shaping["store"], false);
    assert_eq!(shaping["stream"], true);
    // gpt-6.x is not an AI SDK reasoning model: no `include`. gpt-5.6 is, so `include` stays.
    assert_eq!(shaping["include"], serde_json::Value::Null);
    let older = platform
        .endpoint(EndpointQuery::new(&selection(
            &provider,
            "gpt-5.6-sol",
            None,
        )))
        .await
        .unwrap();
    assert!(older.body_patches.last().unwrap().get("include").is_none());
}
