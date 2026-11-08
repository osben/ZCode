use super::*;

fn file(body: AttachedBody) -> AttachedFile {
    AttachedFile {
        name: "note.txt".into(),
        mime: "text/plain".into(),
        bytes: 5,
        reference: Some("zcode-artifact://sess/attachment-1".into()),
        preview_reference: None,
        stored: None,
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
        },
        AttachedBody::Image { source: image },
        AttachedBody::Omitted,
    ] {
        let mut original = file(body);
        if matches!(original.body, AttachedBody::Image { .. }) {
            original.mime = "image/png".into();
            original.preview_reference = Some("zcode-artifact://sess/preview".into());
        }
        let stored = part("prt_1".into(), ("sess", "msg"), &original);
        assert_eq!(from_part(&stored), Some(original));
    }
}

#[test]
fn reads_a_node_desktop_text_part() {
    let part = json!({"type": "file", "mime": "text/plain", "filename": "a.md", "url": "/w/a.md",
        "source": {"type": "file", "path": "/w/a.md", "text": {"value": "/w/a.md", "start": 0, "end": 7}},
        "metadata": {"originalUrl": "/w/a.md", "preview": {"text": "body", "truncated": false},
            "recoverability": "provider_ready", "sizeBytes": 4, "storageKind": "inline"}});
    let file = from_part(&part).unwrap();
    assert_eq!(file.name, "a.md");
    assert_eq!(file.reference.as_deref(), Some("/w/a.md"));
    assert_eq!(
        file.body,
        AttachedBody::Text {
            text: "body".into()
        }
    );
}

#[test]
fn a_node_artifact_image_comes_back_stored_and_a_placeholder_metadata_only() {
    let artifact = json!({"type": "file", "mime": "image/png", "filename": "p.png",
        "url": "zcode-artifact://s/a", "metadata": {"artifactUri": "zcode-artifact://s/a",
            "recoverability": "provider_ready", "storageKind": "artifact", "sizeBytes": 9}});
    let file = from_part(&artifact).unwrap();
    assert_eq!(file.body, AttachedBody::Omitted);
    assert_eq!(file.reference.as_deref(), Some("zcode-artifact://s/a"));
    assert_eq!(file.stored.as_deref(), Some("zcode-artifact://s/a"));
    let placeholder = json!({"type": "file", "mime": "application/pdf", "filename": "d.pdf",
        "url": "/w/d.pdf", "metadata": {"recoverability": "metadata_only", "sizeBytes": 3}});
    assert_eq!(from_part(&placeholder).unwrap().body, AttachedBody::Omitted);
}

#[test]
fn a_tui_image_without_a_filename_is_not_an_attachment() {
    let part = json!({"type": "file", "mime": "image/png", "url": "data:image/png;base64,iVBO"});
    assert_eq!(from_part(&part), None);
}

/// An image stored in a session artifact has Node's `persistAttachmentDataUrl` shape, so Node shows its chip with a
/// ref and reads the image from the artifact; read back, it waits for the store to load the artifact.
#[test]
fn a_stored_image_has_nodes_artifact_shape() {
    let original = AttachedFile {
        mime: "image/png".into(),
        reference: Some("/w/p.png".into()),
        stored: Some("zcode-artifact://sess/tool-result-1".into()),
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
        from_part(&stored),
        Some(AttachedFile {
            body: AttachedBody::Omitted,
            ..original
        })
    );
}
