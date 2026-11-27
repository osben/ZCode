//! 新增请求选项（工具标记、消息级 output_config）与 Provider 补丁的编码。

use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::{ApiContent, ApiMessage, ApiRole, ToolFlags, TurnOutputConfig};
use serde_json::json;

use super::tests::request;
use super::*;

fn plain(block: ContentBlock) -> ApiContent {
    ApiContent {
        block,
        cache_control: None,
        meta: false,
    }
}

fn text_block(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.to_owned(),
    }
}

fn cache(ttl: Option<&str>, scope: Option<&str>) -> Option<CacheControl> {
    Some(CacheControl {
        kind: "ephemeral".to_owned(),
        ttl: ttl.map(str::to_owned),
        scope: scope.map(str::to_owned),
    })
}

fn body(request: ModelRequest) -> Result<String, ModelError> {
    super::body(request, false, &[])
}

#[test]
fn tool_flags_and_message_output_keep_their_key_order() {
    let mut request = request(vec![
        ApiMessage {
            role: ApiRole::User,
            content: vec![plain(text_block("hi"))],
            output_config: None,
        },
        ApiMessage {
            role: ApiRole::System,
            content: vec![plain(text_block("env"))],
            output_config: Some(TurnOutputConfig {
                effort: Some("medium".to_owned()),
            }),
        },
    ]);
    // `strict` goes out only for a first-party model id.
    request.selection.model = "claude-opus-5-5".to_owned();
    request.tools = vec![ToolDefinition {
        contract: Default::default(),
        name: "Search".to_owned(),
        description: "d".to_owned(),
        input_schema: json!({"type": "object"}),
        cache_control: cache(None, None),
    }];
    request.options.tool_flags.insert(
        "Search".to_owned(),
        ToolFlags {
            defer_loading: true,
            strict: true,
            eager_input_streaming: false,
        },
    );
    let body = body(request.clone()).unwrap();
    assert!(
        body.contains(r#"{"name":"Search","description":"d","input_schema":{"type":"object","additionalProperties":false,"properties":{}},"strict":true,"defer_loading":true,"cache_control":{"type":"ephemeral"}}"#),
        "{body}"
    );
    assert!(
        body.contains(r#"{"role":"system","content":[{"type":"text","text":"env"}],"output_config":{"effort":"medium"}}"#),
        "{body}"
    );
}

#[test]
fn provider_patches_are_merged_last() {
    let mut request = request(Vec::new());
    request.thinking = Some(ThinkingConfig::Adaptive { display: None });
    let patches = [
        json!({"thinking": {"type": "enabled"}, "max_tokens": 128000, "output_config": {"effort": "high"}}),
    ];
    let body = super::body(request, false, &patches).unwrap();
    assert_eq!(
        body,
        r#"{"model":"<model>","messages":[],"system":[],"tools":[],"max_tokens":128000,"thinking":{"type":"enabled"},"stream":true,"output_config":{"effort":"high"}}"#
            .replace("<model>", rust_cli_base::models::GLM_5_3)
    );
}

/// structured output（titles.md §8.4）：`output_config` 里 effort 在前、format 在后，
/// beta `structured-outputs-2025-12-15` 随 format 生成；没有 effort 时只有 format。
#[test]
fn output_format_goes_after_effort() {
    use rust_cli_kernel_api::model::OutputFormat;
    let schema = json!({"type": "object", "properties": {"name": {"type": "string"}}});
    let mut request = request(Vec::new());
    request.options.effort = Some("medium".to_owned());
    request.options.output_format = Some(OutputFormat::JsonSchema { schema });
    let encoded = body(request.clone()).unwrap();
    assert!(
        encoded.contains(r#""output_config":{"effort":"medium","format":{"type":"json_schema","schema":{"type":"object","properties":{"name":{"type":"string"}}}}},"stream":true"#),
        "{encoded}"
    );
    let encoded = super::encode(request.clone(), super::tests::profile(false), &[], &[]).unwrap();
    assert_eq!(
        encoded.betas,
        [
            crate::anthropic::betas::EFFORT,
            crate::anthropic::betas::STRUCTURED_OUTPUTS
        ]
    );
    request.options.effort = None;
    let encoded = body(request).unwrap();
    assert!(
        encoded.contains(r#""output_config":{"format":{"type":"json_schema","#),
        "{encoded}"
    );
}

#[test]
fn strict_is_dropped_for_a_model_or_schema_that_cannot_use_it() {
    let strict = |model: &str, schema: serde_json::Value| {
        let mut request = request(Vec::new());
        request.selection.model = model.to_owned();
        request.tools = vec![ToolDefinition {
            contract: Default::default(),
            name: "Submit".to_owned(),
            description: "d".to_owned(),
            input_schema: schema,
            cache_control: None,
        }];
        request.options.tool_flags.insert(
            "Submit".to_owned(),
            ToolFlags {
                strict: true,
                ..ToolFlags::default()
            },
        );
        body(request).unwrap()
    };
    let typed =
        json!({"type": "object", "properties": {"result": {"type": "string", "minLength": 1}}});
    let folded = strict("claude-opus-5-5", typed.clone());
    assert!(
        folded.contains(r#""input_schema":{"type":"object","properties":{"result":{"type":"string","description":"at least 1 characters"}},"additionalProperties":false},"strict":true"#),
        "{folded}"
    );
    // A gateway route id and a non-Claude model get the original schema and no flag.
    for model in ["anthropic/claude-opus-5-5", "glm-5.3"] {
        let plain = strict(model, typed.clone());
        assert!(!plain.contains("strict"), "{plain}");
        assert!(plain.contains(r#""minLength":1"#), "{plain}");
    }
    // A schema the subset cannot express goes out as it is, without the flag.
    let open = strict(
        "claude-opus-5-5",
        json!({"type": "object", "properties": {"a": {}}}),
    );
    assert!(!open.contains("strict"), "{open}");
}
