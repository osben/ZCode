use super::*;

fn file(body: AttachedBody) -> AttachedFile {
    AttachedFile {
        name: "note.txt".into(),
        mime: "text/plain".into(),
        bytes: 5,
        reference: Some("zcode-artifact://sess/attachment-1".into()),
        preview_reference: None,
        stored: None,
        material: None,
        image: None,
        body,
    }
}

#[test]
fn text_parts_have_the_shape_node_reads_as_a_read_reminder() {
    let part = part(
        "prt_1".into(),
        ("sess", "msg"),
        &file(AttachedBody::Text {
            text: "hello".into(),
            read: None,
        }),
    );
    assert_eq!(part["type"], "file");
    assert_eq!(part["mime"], "text/plain");
    assert_eq!(part["filename"], "note.txt");
    assert_eq!(part["source"]["type"], "file");
    assert_eq!(part["source"]["text"]["value"], "note.txt");
    let metadata = &part["metadata"];
    assert_eq!(metadata["preview"]["text"], "hello");
    assert_eq!(metadata["storageKind"], "inline");
    assert_eq!(metadata["recoverability"], "provider_ready");
    assert_eq!(metadata["sizeBytes"], 5);
    assert_eq!(
        metadata["originalUrl"],
        "zcode-artifact://sess/attachment-1"
    );
}

#[test]
fn every_body_round_trips() {
    let image = ImageSource::Base64 {
        media_type: "image/png".into(),
        data: "iVBO".into(),
    };
    for body in [
        AttachedBody::Text {
            text: "a\nb".into(),
            read: None,
        },
        AttachedBody::Text {
            text: "x".into(),
            read: Some(Box::new(TextRead {
                path: "/w/big.log".into(),
                start_line: 1,
                total_lines: 9,
                original_bytes: 300_000,
                truncated: true,
                truncated_by_token_cap: true,
                notice: Some("[Truncated: PARTIAL view — /w/big.log: …]".into()),
            })),
        },
        AttachedBody::Image { source: image },
        AttachedBody::Omitted,
        AttachedBody::ReadFailed,
    ] {
        let mut original = file(body);
        if matches!(original.body, AttachedBody::Image { .. }) {
            original.mime = "image/png".into();
            original.preview_reference = Some("zcode-artifact://sess/preview".into());
        }
        // A read file's size is the one on disk (Node `sizeBytes` from the read).
        if let AttachedBody::Text {
            read: Some(read), ..
        } = &original.body
        {
            original.bytes = read.original_bytes;
        }
        let stored = part("prt_1".into(), ("sess", "msg"), &original);
        assert_eq!(from_part(&stored, 0), Some(original));
    }
}

#[test]
fn reads_a_node_desktop_text_part() {
    let part = json!({"type": "file", "mime": "text/plain", "filename": "a.md", "url": "/w/a.md",
        "source": {"type": "file", "path": "/w/a.md", "text": {"value": "/w/a.md", "start": 0, "end": 7}},
        "metadata": {"originalUrl": "/w/a.md", "preview": {"text": "body", "truncated": false},
            "recoverability": "provider_ready", "sizeBytes": 4, "storageKind": "inline"}});
    let file = from_part(&part, 0).unwrap();
    assert_eq!(file.name, "a.md");
    assert_eq!(file.reference.as_deref(), Some("/w/a.md"));
    assert_eq!(
        file.body,
        AttachedBody::Text {
            text: "body".into(),
            read: Some(Box::new(TextRead {
                path: "/w/a.md".into(),
                start_line: 1,
                total_lines: 1,
                original_bytes: 4,
                truncated: false,
                truncated_by_token_cap: false,
                notice: None,
            })),
        }
    );
}

#[test]
fn a_read_desktop_text_part_has_nodes_shape() {
    let mut original = file(AttachedBody::Text {
        text: "l1\nl2".into(),
        read: Some(Box::new(TextRead {
            path: "/w/big.log".into(),
            start_line: 1,
            total_lines: 30_001,
            original_bytes: 300_000,
            truncated: false,
            truncated_by_token_cap: false,
            notice: None,
        })),
    });
    original.reference = Some("/w/big.log".into());
    original.bytes = 300_000;
    let part = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(part["url"], "/w/big.log");
    assert_eq!(part["source"]["path"], "/w/big.log");
    assert_eq!(part["source"]["text"]["value"], "/w/big.log");
    let metadata = &part["metadata"];
    assert_eq!(
        metadata["preview"],
        json!({"text": "l1\nl2", "truncated": false, "originalBytes": 300_000, "startLine": 1,
            "totalLines": 30_001})
    );
    assert_eq!(metadata["recoverability"], "provider_ready");
    assert_eq!(metadata["sizeBytes"], 300_000);
    assert_eq!(from_part(&part, 0), Some(original));
}

#[test]
fn a_failed_text_read_is_nodes_placeholder_both_ways() {
    let mut original = file(AttachedBody::ReadFailed);
    original.reference = Some("/w/gone.txt".into());
    let stored = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(stored["mime"], "text/plain");
    assert_eq!(stored["metadata"]["errorCode"], "attachment_read_failed");
    assert_eq!(stored["metadata"]["recoverability"], "metadata_only");
    assert_eq!(stored["metadata"]["storageKind"], "local_ref");
    // Node's own placeholder (no `sizeBytes` for a failed read).
    let node = json!({"type": "file", "mime": "text/plain", "filename": "gone.txt", "url": "/w/gone.txt",
        "source": {"type": "file", "path": "/w/gone.txt", "text": {"value": "/w/gone.txt", "start": 0, "end": 11}},
        "metadata": {"errorCode": "attachment_read_failed", "originalUrl": "/w/gone.txt",
            "recoverability": "metadata_only", "storageKind": "local_ref"}});
    assert_eq!(from_part(&node, 0).unwrap().body, AttachedBody::ReadFailed);
}

#[test]
fn a_node_artifact_image_comes_back_stored_and_a_placeholder_metadata_only() {
    let artifact = json!({"type": "file", "mime": "image/png", "filename": "p.png",
        "url": "zcode-artifact://s/a", "metadata": {"artifactUri": "zcode-artifact://s/a",
            "recoverability": "provider_ready", "storageKind": "artifact", "sizeBytes": 9}});
    let file = from_part(&artifact, 0).unwrap();
    assert_eq!(file.body, AttachedBody::Omitted);
    assert_eq!(file.reference.as_deref(), Some("zcode-artifact://s/a"));
    assert_eq!(file.stored.as_deref(), Some("zcode-artifact://s/a"));
    let placeholder = json!({"type": "file", "mime": "application/pdf", "filename": "d.pdf",
        "url": "/w/d.pdf", "metadata": {"recoverability": "metadata_only", "sizeBytes": 3}});
    assert_eq!(
        from_part(&placeholder, 0).unwrap().body,
        AttachedBody::Omitted
    );
}

#[test]
fn a_tui_image_without_a_filename_is_not_an_attachment() {
    let part = json!({"type": "file", "mime": "image/png", "url": "data:image/png;base64,iVBO"});
    assert_eq!(from_part(&part, 0), None);
}

/// An image stored in a session artifact has Node's `persistAttachmentDataUrl` shape, so Node shows its chip with a
/// ref and reads the image from the artifact; read back, it waits for the store to load the artifact.
#[test]
fn a_stored_image_has_nodes_artifact_shape() {
    let original = AttachedFile {
        mime: "image/png".into(),
        reference: Some("/w/p.png".into()),
        stored: Some("zcode-artifact://sess/tool-result-1".into()),
        material: None,
        image: None,
        ..file(AttachedBody::Image {
            source: ImageSource::Base64 {
                media_type: "image/png".into(),
                data: "iVBO".into(),
            },
        })
    };
    let stored = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(stored["url"], "zcode-artifact://sess/tool-result-1");
    let metadata = &stored["metadata"];
    assert_eq!(
        metadata["artifactUri"],
        "zcode-artifact://sess/tool-result-1"
    );
    assert_eq!(metadata["storageKind"], "artifact");
    assert_eq!(metadata["originalUrl"], "/w/p.png");
    assert_eq!(
        from_part(&stored, 0),
        Some(AttachedFile {
            body: AttachedBody::Omitted,
            ..original
        })
    );
}

#[test]
fn a_path_reference_keeps_its_note_like_node() {
    let mut original = file(AttachedBody::PathReference {
        text: "Attached application/octet-stream: /p/a.zip\nThe file was sent by local path because x.\nUse tools."
            .into(),
    });
    original.name = "a.zip".into();
    original.reference = Some("/p/a.zip".into());
    let stored = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(stored["mime"], "application/octet-stream");
    assert_eq!(stored["url"], "/p/a.zip");
    assert_eq!(stored["source"]["path"], "/p/a.zip");
    assert_eq!(stored["metadata"]["storageKind"], "local_ref");
    assert_eq!(stored["metadata"]["recoverability"], "metadata_only");
    assert_eq!(
        stored["metadata"]["pathReferenceText"],
        "Attached application/octet-stream: /p/a.zip\nThe file was sent by local path because x.\nUse tools."
    );
    let back = from_part(&stored, 0).unwrap();
    assert_eq!(back.body, original.body);
    assert_eq!(back.reference, original.reference);
}

#[test]
fn text_material_names_its_stored_file_like_node() {
    // Node `resolveTurnAttachment`: the part's url, originalUrl and note name the written artifact file, mime text/plain.
    let note = "Attached text/plain: /data/s/attachment-tool-result-1.txt\nThe file was sent by local path because \
                topic history is provided for on-demand reading.\nUse tools.";
    let mut original = file(AttachedBody::PathReference { text: note.into() });
    original.name = "History.txt".into();
    original.reference = Some("zcode-artifact://sess/attachment-1".into());
    original.stored = Some("/data/s/attachment-tool-result-1.txt".into());
    original.material = Some(Box::new(rust_cli_kernel_api::message::Material {
        kind: rust_cli_kernel_api::message::MaterialKind::TopicHistory,
        message_count: Some(3),
    }));
    let stored = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(stored["mime"], "text/plain");
    assert_eq!(stored["url"], "/data/s/attachment-tool-result-1.txt");
    assert_eq!(
        stored["metadata"]["originalUrl"],
        "/data/s/attachment-tool-result-1.txt"
    );
    assert_eq!(stored["metadata"]["pathReferenceText"], note);
    // The marks are the live row's only; Node's cold chip has neither.
    assert!(!stored.to_string().contains("topic-history"));
    let back = from_part(&stored, 0).unwrap();
    assert_eq!(back.body, original.body);
    assert_eq!(
        back.reference.as_deref(),
        Some("/data/s/attachment-tool-result-1.txt")
    );
    assert_eq!(back.material, None);
}

#[test]
fn an_oversized_image_path_reference_keeps_its_image_mime() {
    let mut original = file(AttachedBody::PathReference {
        text:
            "Attached image/png: /p/big.png\nThe file was sent by local path because x.\nUse tools."
                .into(),
    });
    original.reference = Some("/p/big.png".into());
    assert_eq!(
        part("prt_1".into(), ("sess", "msg"), &original)["mime"],
        "image/png"
    );
}

/// A video is always stored (Node `persistAttachmentDataUrl` stops the turn otherwise), so its part has the artifact
/// shape and is read back from the artifact; a part holding the data URL itself is read inline.
#[test]
fn a_stored_video_has_nodes_artifact_shape() {
    let source = ImageSource::Base64 {
        media_type: "video/mp4".into(),
        data: "AAAA".into(),
    };
    let original = AttachedFile {
        name: "clip.mp4".into(),
        mime: "video/mp4".into(),
        reference: Some("/w/clip.mp4".into()),
        stored: Some("zcode-artifact://sess/attachment-2".into()),
        ..file(AttachedBody::Video {
            source: source.clone(),
        })
    };
    let stored = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(stored["url"], "zcode-artifact://sess/attachment-2");
    assert_eq!(stored["mime"], "video/mp4");
    assert_eq!(stored["metadata"]["storageKind"], "artifact");
    assert_eq!(stored["metadata"]["recoverability"], "provider_ready");
    assert_eq!(
        from_part(&stored, 0),
        Some(AttachedFile {
            body: AttachedBody::Omitted,
            ..original
        })
    );
    let inline = json!({"type": "file", "mime": "video/mp4", "filename": "clip.mp4",
        "url": "data:video/mp4;base64,AAAA", "metadata": {"recoverability": "provider_ready", "sizeBytes": 3}});
    assert_eq!(
        from_part(&inline, 0).unwrap().body,
        AttachedBody::Video { source }
    );
}

/// A video part Node wrote (`persistAttachmentDataUrl`) reads back like its image: stored, filled from the artifact.
#[test]
fn a_node_artifact_video_comes_back_stored() {
    let part = json!({"type": "file", "mime": "video/mp4", "filename": "clip.mp4",
        "url": "zcode-artifact://s/attachment-v", "metadata": {"artifactUri": "zcode-artifact://s/attachment-v",
            "originalUrl": "/w/clip.mp4", "recoverability": "provider_ready", "storageKind": "artifact", "sizeBytes": 3}});
    let file = from_part(&part, 0).unwrap();
    assert_eq!(file.body, AttachedBody::Omitted);
    assert_eq!(
        file.stored.as_deref(),
        Some("zcode-artifact://s/attachment-v")
    );
    assert_eq!(file.reference.as_deref(), Some("/w/clip.mp4"));
}

/// A prepared image keeps Node's `metadata.image`; a WebP one has no pixel sizes.
#[test]
fn a_prepared_images_metadata_round_trips_like_node() {
    let resized = ImageInfo {
        width: Some(2000),
        height: Some(1000),
        original_width: Some(4000),
        original_height: Some(2000),
        max_dimension: 2000,
        resized: true,
        transformed_size_bytes: 123_456,
    };
    let original = AttachedFile {
        mime: "image/png".into(),
        reference: Some("/w/p.png".into()),
        stored: Some("zcode-artifact://sess/tool-result-1".into()),
        image: Some(Box::new(resized.clone())),
        ..file(AttachedBody::Image {
            source: ImageSource::Base64 {
                media_type: "image/jpeg".into(),
                data: "/9j/".into(),
            },
        })
    };
    let stored = part("prt_1".into(), ("sess", "msg"), &original);
    assert_eq!(stored["mime"], "image/jpeg");
    assert_eq!(
        stored["metadata"]["image"],
        json!({"width": 2000, "height": 1000, "originalWidth": 4000, "originalHeight": 2000,
            "maxDimension": 2000, "resized": true, "transformedSizeBytes": 123_456})
    );
    let back = from_part(&stored, 0).unwrap();
    assert_eq!(back.image.as_deref(), Some(&resized));
    let webp = ImageInfo {
        width: None,
        height: None,
        original_width: None,
        original_height: None,
        max_dimension: 2000,
        resized: false,
        transformed_size_bytes: 9,
    };
    let stored = part(
        "prt_2".into(),
        ("sess", "msg"),
        &AttachedFile {
            image: Some(Box::new(webp.clone())),
            ..original
        },
    );
    assert_eq!(
        stored["metadata"]["image"],
        json!({"maxDimension": 2000, "resized": false, "transformedSizeBytes": 9})
    );
    assert_eq!(from_part(&stored, 0).unwrap().image.as_deref(), Some(&webp));
}

/// Node `resolvedPlaceholderAttachment(…, "attachment_image_resize_failed")`, read back from either runtime; a web-remote
/// one is not loaded from its artifact.
#[test]
fn a_failed_image_is_nodes_placeholder_both_ways() {
    let mut desktop = file(AttachedBody::ImageFailed {
        code: "attachment_image_resize_failed".into(),
    });
    desktop.mime = "image/tiff".into();
    desktop.reference = Some("/w/scan.tiff".into());
    let stored = part("prt_1".into(), ("sess", "msg"), &desktop);
    assert_eq!(stored["mime"], "image/tiff");
    assert_eq!(stored["url"], "/w/scan.tiff");
    assert_eq!(stored["source"]["path"], "/w/scan.tiff");
    let metadata = &stored["metadata"];
    assert_eq!(metadata["errorCode"], "attachment_image_resize_failed");
    assert_eq!(metadata["recoverability"], "metadata_only");
    assert_eq!(metadata["storageKind"], "local_ref");
    assert_eq!(from_part(&stored, 0).unwrap(), desktop);

    let mut remote = file(AttachedBody::ImageFailed {
        code: "attachment_image_invalid".into(),
    });
    remote.mime = "image/png".into();
    let stored = part("prt_2".into(), ("sess", "msg"), &remote);
    assert_eq!(stored["metadata"]["storageKind"], "metadata_only");
    assert_eq!(stored["source"], Value::Null);
    let back = from_part(&stored, 0).unwrap();
    assert_eq!(back.body, remote.body);
    assert_eq!(back.stored, None);
    // Node's own part of a web-remote image (its `url` is the artifact; there is no `artifactUri`).
    let node = json!({"type": "file", "mime": "image/png", "filename": "p.png", "url": "zcode-artifact://s/a",
        "metadata": {"errorCode": "attachment_image_resize_failed", "originalUrl": "zcode-artifact://s/a",
            "recoverability": "metadata_only", "storageKind": "metadata_only"}});
    assert_eq!(
        from_part(&node, 0).unwrap().body,
        AttachedBody::ImageFailed {
            code: "attachment_image_resize_failed".into()
        }
    );
}

/// The `file` parts of web-remote uploads carry what Node's `resolveTurnAttachments` resolved for the same input (its
/// output for a 68-byte PNG data URL artifact and a 29-byte video artifact, below): Share compares the chip's `bytes`,
/// which is `metadata.sizeBytes`, with its stat of the artifact, in either runtime.
#[test]
fn web_remote_upload_parts_match_nodes_resolved_metadata() {
    let node = serde_json::json!([
        {"mime": "image/png", "url": "zcode-artifact://s1/img", "metadata": {"recoverability": "provider_ready",
            "sizeBytes": 114, "storageKind": "artifact", "artifactUri": "zcode-artifact://s1/img"}},
        {"mime": "video/mp4", "url": "zcode-artifact://s1/vid", "metadata": {"recoverability": "provider_ready",
            "sizeBytes": 29, "storageKind": "artifact", "artifactUri": "zcode-artifact://s1/vid"}},
    ]);
    // `zcode-rs` resolves these with Node's measures (protocol-zcode `web_remote_uploads_carry_nodes_size_bytes`).
    let upload = |mime: &str, uri: &str, bytes: u64, body: AttachedBody| AttachedFile {
        mime: mime.into(),
        bytes,
        reference: Some(uri.into()),
        stored: Some(uri.into()),
        ..file(body)
    };
    let base64 = |media_type: &str| ImageSource::Base64 {
        media_type: media_type.into(),
        data: "AAAA".into(),
    };
    let rust = [
        upload(
            "image/png",
            "zcode-artifact://s1/img",
            114,
            AttachedBody::Image {
                source: base64("image/png"),
            },
        ),
        upload(
            "video/mp4",
            "zcode-artifact://s1/vid",
            29,
            AttachedBody::Video {
                source: base64("video/mp4"),
            },
        ),
    ];
    for (node, rust) in node.as_array().unwrap().iter().zip(&rust) {
        let stored = part("prt_1".into(), ("s1", "msg"), rust);
        assert_eq!(stored["mime"], node["mime"]);
        assert_eq!(stored["url"], node["url"]);
        for (key, value) in node["metadata"].as_object().unwrap() {
            assert_eq!(&stored["metadata"][key], value, "{key}");
        }
        // Read back by either runtime, the chip keeps Node's size.
        assert_eq!(
            from_part(&stored, 0).unwrap().bytes,
            node["metadata"]["sizeBytes"]
        );
    }
}

/// Node's web-remote image and video resolvers return no `filename`, and `persistUserPrompt` stores the part without
/// one (exact parts below: an artifact-backed video and image, and an inline video when Node has no artifact store).
/// Node names the chip `filename ?? basename(url) || attachment-${index + 1}` (`attachmentMetasOfMessage`); read
/// back, they stay App attachments with that name, their stored bytes and Node's size.
#[test]
fn nodes_web_remote_parts_without_a_filename_are_attachments() {
    let video = json!({"id": "prt_1", "sessionID": "s1", "messageID": "msg_1", "type": "file", "mime": "video/mp4",
        "url": "zcode-artifact://s1/vid", "metadata": {"recoverability": "provider_ready", "sizeBytes": 29,
            "storageKind": "artifact", "artifactUri": "zcode-artifact://s1/vid"}});
    let file = from_part(&video, 0).unwrap();
    assert_eq!(file.name, "vid");
    assert_eq!(file.mime, "video/mp4");
    assert_eq!(file.bytes, 29);
    assert_eq!(file.reference.as_deref(), Some("zcode-artifact://s1/vid"));
    assert_eq!(file.stored.as_deref(), Some("zcode-artifact://s1/vid"));
    let image = json!({"id": "prt_2", "sessionID": "s1", "messageID": "msg_1", "type": "file", "mime": "image/png",
        "url": "zcode-artifact://s1/img", "metadata": {"recoverability": "provider_ready", "sizeBytes": 114,
            "storageKind": "artifact", "artifactUri": "zcode-artifact://s1/img"}});
    let file = from_part(&image, 1).unwrap();
    assert_eq!((file.name.as_str(), file.bytes), ("img", 114));
    assert_eq!(file.stored.as_deref(), Some("zcode-artifact://s1/img"));
    let inline = json!({"id": "prt_3", "sessionID": "s1", "messageID": "msg_1", "type": "file", "mime": "video/mp4",
        "url": "data:video/mp4;base64,AAAA", "metadata": {"recoverability": "provider_ready", "sizeBytes": 3,
            "storageKind": "inline"}});
    let file = from_part(&inline, 2).unwrap();
    assert_eq!((file.name.as_str(), file.bytes), ("attachment-3", 3));
    assert!(matches!(file.body, AttachedBody::Video { .. }));
    assert_eq!(file.reference, None);
}

/// A Rust TUI image has no `filename` either; it is told apart by what Node never writes: an inline one has no
/// `sizeBytes`, an artifact one carries `metadata.rustCli`. Both stay plain images.
#[test]
fn a_tui_artifact_image_is_not_an_attachment() {
    let part = json!({"type": "file", "mime": "image/png", "url": "zcode-artifact://s/a", "metadata": {
        "artifactUri": "zcode-artifact://s/a", "storageKind": "artifact", "sizeBytes": 9,
        "rustCli": {"artifact": {"id": "a"}}}});
    assert_eq!(from_part(&part, 0), None);
}

/// Read back through the history, an unnamed attachment takes its place among the message's file parts, a TUI image
/// included: the second file part here is `attachment-2`.
#[test]
fn the_history_names_an_unnamed_attachment_by_its_place() {
    let record = crate::row::WithParts {
        info: json!({"id": "msg_1", "role": "user"}),
        parts: vec![
            json!({"type": "text", "text": "look"}),
            json!({"type": "file", "mime": "image/png", "url": "data:image/png;base64,iVBO"}),
            json!({"type": "file", "mime": "video/mp4", "url": "data:video/mp4;base64,AAAA",
                "metadata": {"recoverability": "provider_ready", "sizeBytes": 3, "storageKind": "inline"}}),
        ],
    };
    let messages = crate::hydrate::hydrate(&[std::borrow::Cow::Owned(record)]);
    let [rust_cli_kernel_api::message::Message::User(user)] = messages.as_slice() else {
        panic!("one user message: {messages:?}");
    };
    let names: Vec<&str> = user
        .content
        .iter()
        .filter_map(|block| match block {
            rust_cli_kernel_api::message::ContentBlock::File { file } => Some(file.name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(names, ["attachment-2"]);
    assert!(matches!(
        user.content[1],
        rust_cli_kernel_api::message::ContentBlock::Image { .. }
    ));
}
