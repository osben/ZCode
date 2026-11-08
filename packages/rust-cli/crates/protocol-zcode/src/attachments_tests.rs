use super::*;
use rust_cli_kernel_api::ids::ArtifactId;

#[test]
fn artifact_uris_round_trip_like_node() {
    let artifact = ArtifactRef {
        session: SessionId::new("sess 1"),
        id: ArtifactId::new("tool-result-abc"),
        purpose: ArtifactPurpose::Attachment,
        media_type: "text/plain".into(),
        size: 1,
    };
    let reference = uri(&artifact);
    assert_eq!(reference, "zcode-artifact://sess%201/tool-result-abc");
    assert_eq!(
        rust_cli_kernel_api::prompt_attachment::parse_artifact_uri(&reference),
        Some((SessionId::new("sess 1"), ArtifactId::new("tool-result-abc")))
    );
}

#[test]
fn data_urls_decode_to_their_bytes_and_mime() {
    let content = format!("data:image/png;base64,{}", base64().encode(b"\x89PNG"));
    assert_eq!(
        from_data_url(content.into_bytes(), "text/plain"),
        (b"\x89PNG".to_vec(), "image/png".to_owned())
    );
    assert_eq!(
        from_data_url(b"plain".to_vec(), "text/plain"),
        (b"plain".to_vec(), "text/plain".to_owned())
    );
}

#[tokio::test]
async fn local_reads_refuse_directories_and_files_over_the_limit() {
    // Finding: a huge file, FIFO or directory used to be read whole before the size check.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("note.txt");
    rust_cli_fs::append(&file, b"abcde").await.unwrap();
    let fault_of = |result: Result<(Vec<u8>, String), RpcError>| result.unwrap_err().message;
    assert_eq!(
        fault_of(read_local(Path::new("note.txt"), "text/plain", 64).await),
        "fault.attachment.refInvalid"
    );
    assert_eq!(
        fault_of(read_local(dir.path(), "text/plain", 64).await),
        "fault.attachment.refInvalid"
    );
    assert_eq!(
        fault_of(read_local(&file, "text/plain", 4).await),
        "fault.attachment.tooLarge"
    );
    assert_eq!(
        fault_of(read_local(&dir.path().join("missing"), "text/plain", 4).await),
        "fault.attachment.fileNotFound"
    );
    assert_eq!(
        read_local(&file, "text/plain", 5).await.unwrap().0,
        b"abcde"
    );
}

#[test]
fn the_real_length_decides_the_inline_form() {
    // Finding: the client's declared size gated the read, never the bytes that were read.
    assert_eq!(inline_form("text/plain", 64 * 1024), Some(Inline::Text));
    assert_eq!(inline_form("text/plain", 64 * 1024 + 1), None);
    assert_eq!(inline_form("application/pdf", 1), None);
    assert_eq!(inline_form("video/mp4", 1), None);
    let grown_text = vec![b'a'; 64 * 1024 + 1];
    assert!(matches!(
        admit(Inline::Text, "text/plain", grown_text),
        AttachedBody::Omitted
    ));
    assert!(matches!(
        admit(Inline::Text, "text/plain", b"ok".to_vec()),
        AttachedBody::Text { .. }
    ));
    assert!(matches!(
        admit(Inline::Text, "text/plain", b"a\0b".to_vec()),
        AttachedBody::Omitted
    ));
    let grown_image = vec![0u8; INLINE_IMAGE_MAX_BYTES + 1];
    assert!(matches!(
        admit(Inline::Image, "image/png", grown_image),
        AttachedBody::Omitted
    ));
}

#[test]
fn the_artifact_size_cap_admits_a_full_inline_image() {
    // The cap is checked on the stored data URL before it is loaded, so it must not refuse an image at the limit.
    let image = vec![7u8; INLINE_IMAGE_MAX_BYTES];
    let stored = format!("data:image/png;base64,{}", base64().encode(&image));
    assert!(stored.len() as u64 <= encoded_cap(INLINE_IMAGE_MAX_BYTES as u64));
    assert_eq!(
        from_data_url(stored.into_bytes(), "text/plain").0.len(),
        INLINE_IMAGE_MAX_BYTES
    );
}

#[test]
fn a_malformed_ref_is_refused_not_dropped() {
    // Finding: a malformed entry used to be skipped. Node's strict schema refuses the whole command instead.
    let good = json!({"ref": "/tmp/a.txt", "fileName": "a.txt", "mime": "text/plain", "bytes": 3});
    assert_eq!(parse_refs(std::slice::from_ref(&good)).unwrap().len(), 1);
    let no_size = json!({"ref": "/tmp/a.txt", "fileName": "a.txt", "mime": "text/plain"});
    let refused = parse_refs(&[good, no_size]).unwrap_err();
    assert_eq!(refused.code, RpcError::invalid_params(String::new()).code);
    // The message names no part of the entry, since a value there can be a user path.
    assert!(!refused.message.contains("a.txt"));
    let unknown = json!({"ref": "/tmp/a.txt", "fileName": "a.txt", "mime": "text/plain",
        "bytes": 3, "surprise": true});
    assert!(parse_refs(&[unknown]).is_err());
}

fn local_ref(path: &Path, mime: &str, bytes: u64) -> AttachmentRef {
    serde_json::from_value(json!({
        "ref": path.to_str().unwrap(), "fileName": path.file_name().unwrap().to_str().unwrap(),
        "mime": mime, "bytes": bytes,
    }))
    .unwrap()
}

#[tokio::test]
async fn a_binary_desktop_file_goes_by_path_like_node() {
    // Finding (AR01): a zip was read inline as text; Node sends a local path note instead.
    let dir = tempfile::tempdir().unwrap();
    let zip = dir.path().join("bundle.zip");
    rust_cli_fs::append(&zip, b"binary fixture").await.unwrap();
    let Some(AttachedBody::PathReference { text }) =
        path_reference(&local_ref(&zip, "application/zip", 14)).await
    else {
        panic!("path reference");
    };
    assert!(text.starts_with("Attached application/octet-stream: "));
    assert!(text.contains("The file was sent by local path because"));
    assert_eq!(text.split('\n').count(), 3);
    // Text files are read inline; a missing file or an artifact is not a path reference.
    let note = dir.path().join("note.md");
    rust_cli_fs::append(&note, b"hi").await.unwrap();
    assert_eq!(
        path_reference(&local_ref(&note, "text/markdown", 2)).await,
        None
    );
    assert_eq!(
        path_reference(&local_ref(
            &dir.path().join("gone.zip"),
            "application/zip",
            2
        ))
        .await,
        None
    );
    let small_png = dir.path().join("a.png");
    rust_cli_fs::append(&small_png, b"x").await.unwrap();
    assert_eq!(
        path_reference(&local_ref(&small_png, "image/png", 1)).await,
        None
    );
}
