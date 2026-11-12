//! 人类输入里的图片（docs/specs/rust-cli/tui-input.md §3.2）：写成 Node `file` part（data URL），冷读取按 part
//! 顺序还原成 image 块。
use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::message::{ContentBlock, ImageSource, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::Value;

use crate::tests::{TestStore, batch, started};

#[tokio::test]
async fn pasted_images_round_trip_as_node_file_parts() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let image = ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        },
        name: None,
    };
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_u1"),
        content: vec![
            ContentBlock::Text {
                text: "what is this [Image #1]".into(),
            },
            image,
        ],
        origin: UserOrigin::Human,
    });
    let fact = Fact::MessageAppended {
        message: message.clone(),
    };
    t.store
        .commit(&SessionId::new("sess_1"), batch(Some("cmd"), vec![fact]))
        .await
        .unwrap();
    let parts = t.rows("select data from part where message_id = 'msg_ru_u1' order by sequence");
    let file: Value = parts
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str::<Value>(data).unwrap())
        .find(|part| part["type"] == "file")
        .expect("a file part");
    assert_eq!(file["mime"], "image/png");
    assert_eq!(file["url"], "data:image/png;base64,iVBORw0KGgo=");
    assert_eq!(file["metadata"]["storageKind"], "inline");
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.messages, vec![message]);
    // 标题只取文字。
    assert_eq!(loaded.meta.title, "what is this [Image #1]");
}

/// 带内容块的 attachment（tui-input.md §1.3、node-store.md §4.5）：内容块写成同一条合成消息里 text part 之后的
/// part（文字块是 synthetic text part，图片是 Node `file` part），`rustCli.data` 不重复存；冷读取按 part 顺序还原。
#[tokio::test]
async fn attachment_blocks_round_trip_as_parts_after_the_text() {
    use rust_cli_kernel_api::message::{ATTACHMENT_BLOCKS, AttachmentMessage};
    use serde_json::json;

    let t = TestStore::new();
    started(&t, "sess_1").await;
    let image = ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        },
        name: None,
    };
    let cell = ContentBlock::Text {
        text: "<system-reminder>\n<cell id=\"p\">show()</cell id=\"p\">\n</system-reminder>".into(),
    };
    let human = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_u1"),
        content: vec![ContentBlock::Text {
            text: "look at @plot.ipynb".into(),
        }],
        origin: UserOrigin::Human,
    });
    let attachment = Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_rv_a1"),
        source: "file".into(),
        text: "<system-reminder>\nCalled the Read tool with the following input: {\"file_path\":\"/w/plot.ipynb\"}\n</system-reminder>".into(),
        data: json!({
            "filename": "/w/plot.ipynb",
            "displayPath": "plot.ipynb",
            ATTACHMENT_BLOCKS: [cell.clone(), image.clone()],
        }),
    });
    let facts = [human.clone(), attachment.clone()]
        .into_iter()
        .map(|message| Fact::MessageAppended { message })
        .collect();
    t.store
        .commit(&SessionId::new("sess_1"), batch(Some("cmd"), facts))
        .await
        .unwrap();
    let parts: Vec<Value> = t
        .rows("select data from part where message_id = 'msg_rv_a1' order by sequence")
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str(data).unwrap())
        .collect();
    let kinds: Vec<&str> = parts
        .iter()
        .filter_map(|part| part["type"].as_str())
        .collect();
    assert_eq!(kinds, ["text", "text", "file"]);
    assert_eq!(parts[0]["metadata"]["rustCli"]["message"], "attachment");
    assert_eq!(
        parts[0]["metadata"]["rustCli"]["data"],
        json!({"filename": "/w/plot.ipynb", "displayPath": "plot.ipynb"})
    );
    assert_eq!(parts[1]["synthetic"], true);
    assert_eq!(parts[1]["metadata"]["source"], "file");
    assert_eq!(parts[2]["url"], "data:image/png;base64,iVBORw0KGgo=");
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.messages, vec![human, attachment]);
}

/// Fork: App attachments are Node `file` parts after the user's text part (the one owner both runtimes read); the text
/// part has no `metadata.modelInput`, and a cold read rebuilds the same blocks.
#[tokio::test]
async fn app_attachments_round_trip_as_node_file_parts_without_model_input() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};

    let t = TestStore::new();
    started(&t, "sess_1").await;
    let file = |name: &str, mime: &str, body| ContentBlock::File {
        file: AttachedFile {
            name: name.into(),
            mime: mime.into(),
            bytes: 7,
            reference: Some(format!("/work/{name}")),
            preview_reference: None,
            stored: None,
            material: None,
            image: None,
            unnamed: false,
            body,
        },
    };
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_u1"),
        content: vec![
            ContentBlock::Text {
                text: "read these".into(),
            },
            file(
                "note.txt",
                "text/plain",
                AttachedBody::Text {
                    text: "line one\nline two".into(),
                    read: None,
                },
            ),
            file(
                "pic.png",
                "image/png",
                AttachedBody::Image {
                    source: ImageSource::Base64 {
                        media_type: "image/png".into(),
                        data: "iVBORw0KGgo=".into(),
                    },
                },
            ),
            file("big.pdf", "application/pdf", AttachedBody::Omitted),
        ],
        origin: UserOrigin::Human,
    });
    t.store
        .commit(
            &SessionId::new("sess_1"),
            batch(
                Some("cmd"),
                vec![Fact::MessageAppended {
                    message: message.clone(),
                }],
            ),
        )
        .await
        .unwrap();
    let parts: Vec<Value> = t
        .rows("select data from part where message_id = 'msg_ru_u1' order by sequence")
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str(data).unwrap())
        .collect();
    let kinds: Vec<&str> = parts
        .iter()
        .map(|part| part["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["text", "file", "file", "file"]);
    assert_eq!(parts[0]["text"], "read these");
    assert!(parts[0]["metadata"]["modelInput"].is_null());
    assert_eq!(
        parts[1]["metadata"]["preview"]["text"],
        "line one\nline two"
    );
    assert_eq!(parts[2]["url"], "data:image/png;base64,iVBORw0KGgo=");
    assert_eq!(parts[3]["metadata"]["recoverability"], "metadata_only");
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.messages, vec![message]);
    assert_eq!(loaded.meta.title, "read these");
}

/// Fork: an App image stored in a session artifact (Node's shape) is read back from the artifact on load; one whose
/// artifact is missing stays the metadata reminder.
#[tokio::test]
async fn stored_app_images_are_read_back_from_their_artifacts() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};
    use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactStore};

    let t = TestStore::new();
    started(&t, "sess_1").await;
    let session = SessionId::new("sess_1");
    let artifact = t
        .store
        .put(
            &session,
            ArtifactPurpose::Attachment,
            "text/plain".into(),
            b"data:image/png;base64,iVBORw0KGgo=".to_vec(),
        )
        .await
        .unwrap();
    let image = ImageSource::Base64 {
        media_type: "image/png".into(),
        data: "iVBORw0KGgo=".into(),
    };
    let file = |name: &str, stored: String| ContentBlock::File {
        file: AttachedFile {
            name: name.into(),
            mime: "image/png".into(),
            bytes: 8,
            reference: Some(format!("/work/{name}")),
            preview_reference: None,
            stored: Some(stored.into()),
            material: None,
            image: None,
            unnamed: false,
            body: AttachedBody::Image {
                source: image.clone(),
            },
        },
    };
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_u1"),
        content: vec![
            ContentBlock::Text { text: "see".into() },
            file("a.png", rust_cli_node_records::artifacts::uri(&artifact)),
            file(
                "gone.png",
                "zcode-artifact://sess_1/tool-result-gone".into(),
            ),
            file("other.png", "zcode-artifact://sess_2/tool-result-x".into()),
        ],
        origin: UserOrigin::Human,
    });
    t.store
        .commit(
            &session,
            batch(
                Some("cmd"),
                vec![Fact::MessageAppended {
                    message: message.clone(),
                }],
            ),
        )
        .await
        .unwrap();
    let urls: Vec<String> = t
        .rows("select data from part where message_id = 'msg_ru_u1' order by sequence")
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str::<Value>(data).unwrap()["url"].to_string())
        .collect();
    assert!(
        urls.iter()
            .skip(1)
            .all(|url| url.contains("zcode-artifact://")),
        "{urls:?}"
    );
    let loaded = t.store.load(&session).await.unwrap();
    let Message::User(user) = &loaded.messages[0] else {
        panic!("expected the user message");
    };
    let bodies: Vec<&AttachedBody> = user
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::File { file } => Some(&file.body),
            _ => None,
        })
        .collect();
    assert_eq!(
        bodies,
        [
            &AttachedBody::Image { source: image },
            &AttachedBody::Omitted,
            &AttachedBody::Omitted
        ]
    );
}

/// Fork: an App video is stored like an image (Node `persistAttachmentDataUrl`) and read back from its artifact as a
/// video block on load, so a cold resume sends the model what the first turn did.
#[tokio::test]
async fn stored_app_videos_are_read_back_from_their_artifacts() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};
    use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactStore};

    let t = TestStore::new();
    started(&t, "sess_1").await;
    let session = SessionId::new("sess_1");
    let artifact = t
        .store
        .put(
            &session,
            ArtifactPurpose::Attachment,
            "text/plain".into(),
            b"data:video/mp4;base64,AAAA".to_vec(),
        )
        .await
        .unwrap();
    let video = ImageSource::Base64 {
        media_type: "video/mp4".into(),
        data: "AAAA".into(),
    };
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_v1"),
        content: vec![
            ContentBlock::Text {
                text: "watch".into(),
            },
            ContentBlock::File {
                file: AttachedFile {
                    name: "clip.mp4".into(),
                    mime: "video/mp4".into(),
                    bytes: 3,
                    reference: Some("/work/clip.mp4".into()),
                    preview_reference: None,
                    stored: Some(rust_cli_node_records::artifacts::uri(&artifact).into()),
                    material: None,
                    image: None,
                    unnamed: false,
                    body: AttachedBody::Video {
                        source: video.clone(),
                    },
                },
            },
        ],
        origin: UserOrigin::Human,
    });
    t.store
        .commit(
            &session,
            batch(
                Some("cmd"),
                vec![Fact::MessageAppended {
                    message: message.clone(),
                }],
            ),
        )
        .await
        .unwrap();
    let loaded = t.store.load(&session).await.unwrap();
    assert_eq!(loaded.messages, vec![message]);
}

/// Fork: a forked session's parts keep the parent's artifact URIs (Node `clonePartForFork`); a cold load reads them
/// like Node's `filePartDataUrl`, so the fork's model still gets the video and the image.
#[tokio::test]
async fn a_fork_reads_media_stored_by_its_parent() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};
    use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactStore};

    let t = TestStore::new();
    started(&t, "sess_parent").await;
    started(&t, "sess_child").await;
    let parent = SessionId::new("sess_parent");
    let child = SessionId::new("sess_child");
    let put = |content: &'static [u8]| {
        let store = &t.store;
        let parent = parent.clone();
        async move {
            store
                .put(
                    &parent,
                    ArtifactPurpose::Attachment,
                    "text/plain".into(),
                    content.to_vec(),
                )
                .await
                .unwrap()
        }
    };
    let video = put(b"data:video/mp4;base64,AAAA").await;
    let image = put(b"data:image/png;base64,iVBORw0KGgo=").await;
    let video_body = AttachedBody::Video {
        source: ImageSource::Base64 {
            media_type: "video/mp4".into(),
            data: "AAAA".into(),
        },
    };
    let image_body = AttachedBody::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        },
    };
    let file = |name: &str, mime: &str, stored: String, body: &AttachedBody| ContentBlock::File {
        file: AttachedFile {
            name: name.into(),
            mime: mime.into(),
            bytes: 3,
            reference: Some(format!("/work/{name}")),
            preview_reference: None,
            stored: Some(stored.into()),
            material: None,
            image: None,
            unnamed: false,
            body: body.clone(),
        },
    };
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_f1"),
        content: vec![
            ContentBlock::Text { text: "see".into() },
            file(
                "clip.mp4",
                "video/mp4",
                rust_cli_node_records::artifacts::uri(&video),
                &video_body,
            ),
            file(
                "a.png",
                "image/png",
                rust_cli_node_records::artifacts::uri(&image),
                &image_body,
            ),
        ],
        origin: UserOrigin::Human,
    });
    t.store
        .commit(
            &child,
            batch(Some("cmd"), vec![Fact::MessageAppended { message }]),
        )
        .await
        .unwrap();
    let loaded = t.store.load(&child).await.unwrap();
    let Message::User(user) = &loaded.messages[0] else {
        panic!("expected the user message");
    };
    let bodies: Vec<&AttachedBody> = user
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::File { file } => Some(&file.body),
            _ => None,
        })
        .collect();
    assert_eq!(bodies, [&video_body, &image_body]);
}

/// Fork: a web-remote upload keeps its original artifact (Node `existingArtifactUri`), which can be over the model's
/// image budget. A cold load prepares it again (the ladder the first turn used) instead of dropping it to metadata.
#[tokio::test]
async fn a_stored_image_over_the_budget_is_prepared_again_on_load() {
    use base64::Engine as _;
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};
    use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactStore};

    // Noise does not compress, so the PNG is over 5 MiB of base64.
    let mut state = 0x2545_f491_u32;
    let pixels = image::RgbImage::from_fn(1400, 1400, |_, _| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let [r, g, b, _] = state.to_le_bytes();
        image::Rgb([r, g, b])
    });
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let engine = &base64::engine::general_purpose::STANDARD;
    let original = engine.encode(&png);
    assert!(original.len() as u64 > rust_cli_image::MAX_BASE64_BYTES);

    let t = TestStore::new();
    started(&t, "sess_1").await;
    let session = SessionId::new("sess_1");
    let artifact = t
        .store
        .put(
            &session,
            ArtifactPurpose::Attachment,
            "text/plain".into(),
            format!("data:image/png;base64,{original}").into_bytes(),
        )
        .await
        .unwrap();
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_ru_big"),
        content: vec![ContentBlock::File {
            file: AttachedFile {
                name: "big.png".into(),
                mime: "image/png".into(),
                bytes: png.len() as u64,
                reference: Some(rust_cli_node_records::artifacts::uri(&artifact)),
                preview_reference: None,
                stored: Some(rust_cli_node_records::artifacts::uri(&artifact).into()),
                material: None,
                image: None,
                unnamed: false,
                body: AttachedBody::Omitted,
            },
        }],
        origin: UserOrigin::Human,
    });
    t.store
        .commit(
            &session,
            batch(Some("cmd"), vec![Fact::MessageAppended { message }]),
        )
        .await
        .unwrap();
    let loaded = t.store.load(&session).await.unwrap();
    let Message::User(user) = &loaded.messages[0] else {
        panic!("expected the user message");
    };
    let ContentBlock::File { file } = &user.content[0] else {
        panic!("expected the file");
    };
    let expected = rust_cli_image::prepare(png, "image/png", &rust_cli_image::MODEL).unwrap();
    assert_eq!(
        file.body,
        AttachedBody::Image {
            source: ImageSource::Base64 {
                media_type: expected.media_type.into(),
                data: engine.encode(&expected.data),
            }
        }
    );
}
