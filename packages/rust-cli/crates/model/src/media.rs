//! 模型不支持图片或 PDF 时的降级（docs/specs/rust-cli/model.md §10.5；Node `projectMessagesForInputFormat` 与
//! `createUnsupportedModelInputMediaText`）。
//!
//! Provider 配置的 `inputFormat.supportsImage` 为假（[`ModelEndpoint::capabilities`]）时，发送前把 user 内容与
//! 工具结果里的图片换成 Node 的占位文字；`supportsPdf` 为假（[`ModelEndpoint::capabilities`]）时同样换掉工具结果里的
//! document 块（Read 整读 PDF 的结果，修复线 F24：在支持 PDF 的模型上读过、之后换了模型）。只改这次请求：会话历史
//! 不变，换回支持的模型后照常发送。三种协议共用，在按协议编码之前调用（transport 的 `resolve`；工作线 F93 删掉计数请求之前 count_tokens 另调一次）。

use rust_cli_kernel_api::message::{ContentBlock, ImageSource, ToolResultContent};
use rust_cli_kernel_api::model::{ApiMessage, ApiRole, ModelError};
use rust_cli_kernel_api::provider::ModelEndpoint;

/// Node 的占位文字：`[Attached <mime>]`（Fork: `[Attached <mime>: <name>]` for an attached file, Node's
/// `source.placeholder`）加一行说明；`kind` 是 Node 的 `image input` / `PDF input`。
fn placeholder(source: &ImageSource, name: Option<&str>, kind: &str) -> String {
    let label = label(source, name);
    format!(
        "{label}\n[Media omitted from provider request because the selected model does not support {kind}.]"
    )
}

/// Node `modelMessageContentBlockToText` for a media block.
fn label(source: &ImageSource, name: Option<&str>) -> String {
    let (ImageSource::Base64 { media_type, .. } | ImageSource::Artifact { media_type, .. }) =
        source;
    match name.filter(|name| !name.is_empty()) {
        Some(name) => format!("[Attached {media_type}: {name}]"),
        None => format!("[Attached {media_type}]"),
    }
}

fn project_result(content: &mut [ToolResultContent], endpoint: &ModelEndpoint) {
    for item in content {
        let text = match item {
            ToolResultContent::Image { source } if !endpoint.capabilities.supports_image => {
                placeholder(source, None, "image input")
            }
            ToolResultContent::Document { source } if !endpoint.capabilities.supports_pdf => {
                placeholder(source, None, "PDF input")
            }
            _ => continue,
        };
        *item = ToolResultContent::Text { text };
    }
}

/// 端点不接受图片或 PDF 时，把请求消息里的图片与 document 块换成占位文字。Fork: an attached video likewise when the
/// endpoint takes no video (`supportsVideo`, Node `video input`).
pub(crate) fn project(messages: &mut [ApiMessage], endpoint: &ModelEndpoint) {
    let capabilities = &endpoint.capabilities;
    if capabilities.supports_image && capabilities.supports_pdf && capabilities.supports_video {
        return;
    }
    for message in messages {
        for content in &mut message.content {
            match &mut content.block {
                ContentBlock::Image { source, name } if !endpoint.capabilities.supports_image => {
                    content.block = ContentBlock::Text {
                        text: placeholder(source, name.as_deref(), "image input"),
                    };
                }
                ContentBlock::Video { source, name } if !endpoint.capabilities.supports_video => {
                    content.block = ContentBlock::Text {
                        text: placeholder(source, name.as_deref(), "video input"),
                    };
                }
                ContentBlock::ToolResult { content, .. } => project_result(content, endpoint),
                _ => {}
            }
        }
    }
}

/// Fork: Node `DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES`, the media one request may carry.
const MEDIA_BUDGET_BYTES: u64 = 40 * 1024 * 1024;

/// One counted media block: `item` is its index inside a tool result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct MediaKey {
    message: usize,
    block: usize,
    item: Option<usize>,
}

/// Node `mediaRequestBytes`: the length of the data URL the block is sent as.
fn request_bytes(source: &ImageSource) -> u64 {
    let (media_type, data) = match source {
        ImageSource::Base64 { media_type, data } => (media_type, data.len() as u64),
        ImageSource::Artifact {
            media_type,
            artifact,
        } => (media_type, artifact.size.div_ceil(3) * 4),
    };
    ("data:".len() + media_type.len() + ";base64,".len()) as u64 + data
}

/// Node `findLatestRealUserMessageIndex`: a user message with content of its own, not only tool results,
/// `<system-reminder>` text and attachment blocks ([`ApiContent::meta`]; Rust may merge those into the message that
/// carries the user's input).
///
/// [`ApiContent::meta`]: rust_cli_kernel_api::model::ApiContent::meta
fn is_real_user(message: &ApiMessage) -> bool {
    message.role == ApiRole::User
        && message
            .content
            .iter()
            .filter(|content| !content.meta)
            .any(|content| match &content.block {
                ContentBlock::Text { text } => !text.trim_start().starts_with("<system-reminder>"),
                ContentBlock::Image { .. } | ContentBlock::Video { .. } => true,
                _ => false,
            })
}

fn collect(messages: &[ApiMessage], latest: Option<usize>) -> Vec<(MediaKey, u64, bool)> {
    let mut media = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        for (block, content) in message.content.iter().enumerate() {
            match &content.block {
                ContentBlock::Image { source, .. } | ContentBlock::Video { source, .. } => {
                    let key = MediaKey {
                        message: message_index,
                        block,
                        item: None,
                    };
                    // Node protects the real user message's own media, not an attachment merged into it.
                    let protected = latest == Some(message_index) && !content.meta;
                    media.push((key, request_bytes(source), protected));
                }
                // Node keeps tool results in their own tool messages, never the protected user message.
                ContentBlock::ToolResult { content, .. } => {
                    for (item, result) in content.iter().enumerate() {
                        if let ToolResultContent::Image { source }
                        | ToolResultContent::Document { source } = result
                        {
                            let key = MediaKey {
                                message: message_index,
                                block,
                                item: Some(item),
                            };
                            media.push((key, request_bytes(source), false));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    media
}

fn omitted(label: String) -> String {
    format!(
        "{label}\n[Media omitted from provider request to keep the request body under the configured media budget.]"
    )
}

/// Fork: Node `projectMessagesForMediaBudget`. Over 40 MiB of media, keeps the latest real user message's media and
/// then older media newest first while they fit, and replaces the rest with Node's placeholder text; refuses the
/// request when the protected media alone do not fit. Only this request changes.
pub(crate) fn budget(messages: &mut [ApiMessage]) -> Result<(), ModelError> {
    budget_within(messages, MEDIA_BUDGET_BYTES)
}

fn budget_within(messages: &mut [ApiMessage], max_bytes: u64) -> Result<(), ModelError> {
    let latest = messages.iter().rposition(is_real_user);
    let media = collect(messages, latest);
    let total: u64 = media.iter().map(|(_, bytes, _)| bytes).sum();
    if total <= max_bytes {
        return Ok(());
    }
    let protected: u64 = media
        .iter()
        .filter(|(_, _, protected)| *protected)
        .map(|(_, bytes, _)| bytes)
        .sum();
    if protected > max_bytes {
        return Err(ModelError::CurrentAttachmentsTooLarge);
    }
    let mut remaining = max_bytes - protected;
    let mut history: Vec<_> = media
        .iter()
        .filter(|(_, _, protected)| !protected)
        .collect();
    history.sort_by_key(|(key, _, _)| std::cmp::Reverse(*key));
    let mut dropped = Vec::new();
    for (key, bytes, _) in history {
        if *bytes <= remaining {
            remaining -= bytes;
        } else {
            dropped.push(*key);
        }
    }
    for key in &dropped {
        let block = &mut messages[key.message].content[key.block].block;
        match (block, key.item) {
            (ContentBlock::ToolResult { content, .. }, Some(item)) => {
                if let ToolResultContent::Image { source }
                | ToolResultContent::Document { source } = &content[item]
                {
                    content[item] = ToolResultContent::Text {
                        text: omitted(label(source, None)),
                    };
                }
            }
            (block @ (ContentBlock::Image { .. } | ContentBlock::Video { .. }), None) => {
                if let ContentBlock::Image { source, name } | ContentBlock::Video { source, name } =
                    &*block
                {
                    *block = ContentBlock::Text {
                        text: omitted(label(source, name.as_deref())),
                    };
                }
            }
            _ => {}
        }
    }
    tracing::debug!(
        event = "model.media_budget",
        omitted = dropped.len(),
        retained = media.len() - dropped.len(),
        total_bytes = total,
        projected_bytes = max_bytes - remaining,
        "media omitted to keep the request under the media budget"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use rust_cli_base::proto::mime;
    use rust_cli_base::secret::RedactedString;
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::model::{
        ApiContent, ApiRole, ModelRequest, ModelSelection, QuerySource, RequestOptions,
    };
    use rust_cli_kernel_api::provider::{Credential, ModelCapabilities, WireProtocol};

    use super::*;

    fn endpoint(supports_image: bool) -> ModelEndpoint {
        ModelEndpoint {
            protocol: WireProtocol::OpenAiChatCompletions,
            base_url: "https://api.example.com/v1".to_owned(),
            model: "text-only".to_owned(),
            credential: Credential::ApiKey(RedactedString::new("sk-test")),
            headers: Vec::new(),
            body_patches: Vec::new(),
            capabilities: ModelCapabilities {
                supports_image,
                ..ModelCapabilities::default()
            },
            renewable: false,
        }
    }

    fn image() -> ImageSource {
        ImageSource::Base64 {
            media_type: mime::PNG.to_owned(),
            data: "iVBORw0KGgo=".to_owned(),
        }
    }

    fn plain(block: ContentBlock) -> ApiContent {
        ApiContent {
            block,
            cache_control: None,
            meta: false,
        }
    }

    fn request() -> ModelRequest {
        ModelRequest {
            selection: ModelSelection::new("p".to_owned(), "text-only".to_owned()),
            system: Vec::new(),
            messages: vec![ApiMessage {
                role: ApiRole::User,
                content: vec![
                    plain(ContentBlock::ToolResult {
                        tool_use_id: ToolUseId::new("toolu_1"),
                        content: vec![
                            ToolResultContent::Text {
                                text: "An image:".to_owned(),
                            },
                            ToolResultContent::Image { source: image() },
                        ],
                        is_error: false,
                    }),
                    plain(ContentBlock::Text {
                        text: "look".to_owned(),
                    }),
                    plain(ContentBlock::Image {
                        source: image(),
                        name: None,
                    }),
                    plain(ContentBlock::Image {
                        source: image(),
                        name: Some("shot.png".to_owned()),
                    }),
                ],
                output_config: None,
            }],
            tools: Vec::new(),
            tool_choice: None,
            max_tokens: 1024,
            thinking: None,
            temperature: None,
            betas: Vec::new(),
            source: QuerySource::MainThread,
            options: RequestOptions::default(),
        }
    }

    /// F24：不支持 PDF 的端点把 tool_result 里的 document 块换成 Node 的占位（`PDF input`）。
    #[test]
    fn documents_become_node_placeholders_for_models_without_pdf_input() {
        let document = ToolResultContent::Document {
            source: ImageSource::Base64 {
                media_type: mime::PDF.to_owned(),
                data: "JVBERi0=".to_owned(),
            },
        };
        let messages = || {
            vec![ApiMessage {
                role: ApiRole::User,
                content: vec![plain(ContentBlock::ToolResult {
                    tool_use_id: ToolUseId::new("toolu_1"),
                    content: vec![document.clone()],
                    is_error: false,
                })],
                output_config: None,
            }]
        };
        let mut projected = messages();
        // 支持图片、不支持 PDF：只换 document。
        project(&mut projected, &endpoint(true));
        let ContentBlock::ToolResult { content, .. } = &projected[0].content[0].block else {
            panic!("tool result");
        };
        assert_eq!(
            content,
            &vec![ToolResultContent::Text {
                text: "[Attached application/pdf]\n[Media omitted from provider request because the selected model does not support PDF input.]".to_owned()
            }]
        );
        let mut kept = messages();
        project(
            &mut kept,
            &ModelEndpoint {
                capabilities: ModelCapabilities {
                    supports_pdf: true,
                    ..endpoint(true).capabilities
                },
                ..endpoint(true)
            },
        );
        assert_eq!(kept, messages());
    }

    #[test]
    fn images_become_node_placeholders_for_text_only_models() {
        let text = "[Attached image/png]\n[Media omitted from provider request because the selected model does not support image input.]";
        let mut projected = request();
        project(&mut projected.messages, &endpoint(false));
        let blocks: Vec<&ContentBlock> = projected.messages[0]
            .content
            .iter()
            .map(|item| &item.block)
            .collect();
        assert_eq!(
            blocks[0],
            &ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new("toolu_1"),
                content: vec![
                    ToolResultContent::Text {
                        text: "An image:".to_owned()
                    },
                    ToolResultContent::Text {
                        text: text.to_owned()
                    },
                ],
                is_error: false,
            }
        );
        assert_eq!(
            blocks[2],
            &ContentBlock::Text {
                text: text.to_owned()
            }
        );
        // Fork: an attached file's image names the file, like Node's `source.placeholder`.
        assert_eq!(
            blocks[3],
            &ContentBlock::Text {
                text: text.replace("[Attached image/png]", "[Attached image/png: shot.png]")
            }
        );
        let mut kept = request();
        project(&mut kept.messages, &endpoint(true));
        assert_eq!(kept, request());
    }

    /// Node `projectMessagesForProviderCapabilities`: a video goes only to a model that takes video input.
    #[test]
    fn videos_become_node_placeholders_for_models_without_video_input() {
        let messages = || {
            vec![ApiMessage {
                role: ApiRole::User,
                content: vec![plain(ContentBlock::Video {
                    source: ImageSource::Base64 {
                        media_type: "video/mp4".to_owned(),
                        data: "AAAA".to_owned(),
                    },
                    name: Some("clip.mp4".to_owned()),
                })],
                output_config: None,
            }]
        };
        // Image input alone does not let a video through.
        let mut projected = messages();
        project(&mut projected, &endpoint(true));
        assert_eq!(
            projected[0].content[0].block,
            ContentBlock::Text {
                text: "[Attached video/mp4: clip.mp4]\n[Media omitted from provider request because the selected model does not support video input.]".to_owned()
            }
        );
        let mut kept = messages();
        project(
            &mut kept,
            &ModelEndpoint {
                capabilities: ModelCapabilities {
                    supports_video: true,
                    ..endpoint(true).capabilities
                },
                ..endpoint(true)
            },
        );
        assert_eq!(kept, messages());
    }

    fn sized(bytes: usize, name: Option<&str>) -> ContentBlock {
        // `data:image/png;base64,` is 22 bytes.
        ContentBlock::Image {
            source: ImageSource::Base64 {
                media_type: mime::PNG.to_owned(),
                data: "A".repeat(bytes - 22),
            },
            name: name.map(str::to_owned),
        }
    }

    fn user(blocks: Vec<ContentBlock>) -> ApiMessage {
        ApiMessage {
            role: ApiRole::User,
            content: blocks.into_iter().map(plain).collect(),
            output_config: None,
        }
    }

    fn assistant() -> ApiMessage {
        ApiMessage {
            role: ApiRole::Assistant,
            content: vec![plain(ContentBlock::Text {
                text: "ok".to_owned(),
            })],
            output_config: None,
        }
    }

    fn text(text: &str) -> ContentBlock {
        ContentBlock::Text {
            text: text.to_owned(),
        }
    }

    fn omitted_text(label: &str) -> ContentBlock {
        text(&format!(
            "{label}\n[Media omitted from provider request to keep the request body under the configured media budget.]"
        ))
    }

    #[test]
    fn media_are_counted_at_their_data_url_length() {
        let ContentBlock::Image { source, .. } = sized(100, None) else {
            unreachable!()
        };
        assert_eq!(request_bytes(&source), 100);
        let artifact = ImageSource::Artifact {
            media_type: mime::PNG.to_owned(),
            artifact: rust_cli_kernel_api::store::ArtifactRef {
                session: rust_cli_kernel_api::ids::SessionId::new("s"),
                id: rust_cli_kernel_api::ids::ArtifactId::new("a"),
                purpose: rust_cli_kernel_api::store::ArtifactPurpose::Media,
                media_type: mime::PNG.to_owned(),
                size: 4,
            },
        };
        assert_eq!(request_bytes(&artifact), 22 + 8);
    }

    #[test]
    fn a_request_within_the_budget_is_unchanged() {
        let mut messages = vec![
            user(vec![sized(60, None)]),
            assistant(),
            user(vec![sized(40, None)]),
        ];
        let before = messages.clone();
        budget_within(&mut messages, 100).unwrap();
        assert_eq!(messages, before);
    }

    #[test]
    fn older_media_give_way_newest_first_and_the_latest_input_is_kept() {
        let mut messages = vec![
            user(vec![
                text("first"),
                sized(30, Some("old.png")),
                sized(50, None),
            ]),
            assistant(),
            user(vec![text("second"), sized(40, Some("mid.png"))]),
            assistant(),
            user(vec![text("look"), sized(60, Some("now.png"))]),
        ];
        budget_within(&mut messages, 130).unwrap();
        // 60 protected, 70 left: mid (40) fits, then 50 does not (30 left), then old (30) fits.
        assert_eq!(messages[4].content[1].block, sized(60, Some("now.png")));
        assert_eq!(messages[2].content[1].block, sized(40, Some("mid.png")));
        assert_eq!(messages[0].content[1].block, sized(30, Some("old.png")));
        assert_eq!(
            messages[0].content[2].block,
            omitted_text("[Attached image/png]")
        );
    }

    #[test]
    fn the_latest_real_input_skips_reminders_and_tool_results() {
        let result = |bytes: usize| ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("toolu_1"),
            content: vec![ToolResultContent::Image {
                source: match sized(bytes, None) {
                    ContentBlock::Image { source, .. } => source,
                    _ => unreachable!(),
                },
            }],
            is_error: false,
        };
        let mut messages = vec![
            user(vec![text("look"), sized(60, Some("shot.png"))]),
            assistant(),
            // A tool result merged with a reminder is not the user's input; its image is history.
            user(vec![
                result(50),
                text("<system-reminder>\nnote\n</system-reminder>"),
            ]),
        ];
        budget_within(&mut messages, 100).unwrap();
        assert_eq!(messages[0].content[1].block, sized(60, Some("shot.png")));
        let ContentBlock::ToolResult { content, .. } = &messages[2].content[0].block else {
            panic!("tool result");
        };
        assert_eq!(
            content,
            &vec![ToolResultContent::Text {
                text: "[Attached image/png]\n[Media omitted from provider request to keep the request body under the configured media budget.]".to_owned()
            }]
        );
    }

    /// A mention's image (an attachment, [`ApiContent::meta`]) merged into the user's message is history, not the
    /// user's own input (Node keeps it in its own entry): it gives way instead of refusing the request.
    #[test]
    fn a_mention_merged_into_the_input_is_not_protected() {
        let meta = |block: ContentBlock| ApiContent {
            meta: true,
            ..plain(block)
        };
        let mut merged = vec![ApiMessage {
            role: ApiRole::User,
            content: vec![
                plain(text("look")),
                plain(sized(60, Some("clip.png"))),
                meta(text(
                    "<system-reminder>\nCalled the Read tool\n</system-reminder>",
                )),
                meta(sized(50, None)),
            ],
            output_config: None,
        }];
        budget_within(&mut merged, 100).unwrap();
        assert_eq!(merged[0].content[1].block, sized(60, Some("clip.png")));
        assert_eq!(
            merged[0].content[3].block,
            omitted_text("[Attached image/png]")
        );

        // Separate user messages (OpenAI-compatible): the mention's own message is not the latest real input.
        let mut separate = vec![
            user(vec![text("look"), sized(60, Some("clip.png"))]),
            ApiMessage {
                role: ApiRole::User,
                content: vec![meta(sized(50, None))],
                output_config: None,
            },
        ];
        budget_within(&mut separate, 100).unwrap();
        assert_eq!(separate[0].content[1].block, sized(60, Some("clip.png")));
        assert_eq!(
            separate[1].content[0].block,
            omitted_text("[Attached image/png]")
        );
    }

    #[test]
    fn current_attachments_over_the_budget_refuse_the_request() {
        let mut messages = vec![user(vec![text("look"), sized(60, None), sized(60, None)])];
        let error = budget_within(&mut messages, 100).unwrap_err();
        assert_eq!(error, ModelError::CurrentAttachmentsTooLarge);
        // Node's text and code: the App localizes the failed turn by the code.
        assert_eq!(
            error.to_string(),
            rust_cli_kernel_api::model::CURRENT_ATTACHMENTS_TOO_LARGE
        );
        assert_eq!(
            error.code(),
            Some("MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE")
        );
    }
}
