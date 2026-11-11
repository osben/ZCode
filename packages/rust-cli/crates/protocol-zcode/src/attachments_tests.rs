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
        block_on(admit(Inline::Text, "text/plain", grown_text)).0,
        AttachedBody::Omitted
    ));
    assert!(matches!(
        block_on(admit(Inline::Text, "text/plain", b"ok".to_vec())).0,
        AttachedBody::Text { .. }
    ));
    assert!(matches!(
        block_on(admit(Inline::Text, "text/plain", b"a\0b".to_vec())).0,
        AttachedBody::Omitted
    ));
    assert_eq!(
        inline_form("image/png", INLINE_MEDIA_MAX_BYTES),
        Some(Inline::Image)
    );
    assert_eq!(inline_form("image/png", INLINE_MEDIA_MAX_BYTES + 1), None);
    let grown_image = vec![0u8; INLINE_MEDIA_MAX_BYTES as usize + 1];
    assert!(matches!(
        block_on(admit(Inline::Image, "image/png", grown_image)).0,
        AttachedBody::Omitted
    ));
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn the_artifact_size_cap_admits_a_full_inline_image() {
    // The cap is checked on the stored data URL before it is loaded, so it must not refuse an image at the limit.
    let image = vec![7u8; INLINE_MEDIA_MAX_BYTES as usize];
    let stored = format!("data:image/png;base64,{}", base64().encode(&image));
    assert!(stored.len() as u64 <= encoded_cap(INLINE_MEDIA_MAX_BYTES));
    assert_eq!(
        from_data_url(stored.into_bytes(), "text/plain").0.len() as u64,
        INLINE_MEDIA_MAX_BYTES
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

#[test]
fn text_material_refs_are_parsed_like_node_attachment_ref_schema() {
    let material = json!({"ref": "zcode-artifact://s/a", "fileName": "History.txt", "mime": "text/plain",
        "bytes": 3, "sourceKind": "topic-history", "messageCount": 4});
    let parsed = parse_refs(&[material]).unwrap();
    assert_eq!(
        parsed[0].material().map(|material| *material),
        Some(Material {
            kind: MaterialKind::TopicHistory,
            message_count: Some(4)
        })
    );
    // Node's enum and `int().nonnegative()` refuse the whole command.
    for bad in [
        json!({"ref": "/a.txt", "fileName": "a", "mime": "text/plain", "bytes": 1, "sourceKind": "note"}),
        json!({"ref": "/a.txt", "fileName": "a", "mime": "text/plain", "bytes": 1,
            "sourceKind": "clipboard-text", "messageCount": -1}),
    ] {
        assert!(parse_refs(&[bad]).is_err());
    }
    // A count without a kind is not material (Node `displayMetaOf`).
    let count_only = json!({"ref": "/a.txt", "fileName": "a", "mime": "text/plain", "bytes": 1,
        "messageCount": 2});
    assert!(parse_refs(&[count_only]).unwrap()[0].material().is_none());
}

#[test]
fn uri_refs_follow_node_is_uri_attachment_ref() {
    assert!(is_uri_ref("zcode-artifact://s/a"));
    assert!(is_uri_ref("x+y.z-1://a"));
    assert!(!is_uri_ref("/Users/me/a.txt"));
    assert!(!is_uri_ref("C:\\Users\\a.txt"));
    assert!(!is_uri_ref("1x://a"));
    assert!(!is_uri_ref("://a"));
}

#[test]
fn material_text_takes_only_node_s_text_data_url() {
    let encoded = base64().encode("привет\n");
    for header in [
        "data:text/plain;base64,",
        "data:text/plain;charset=utf-8;base64,",
    ] {
        assert_eq!(
            material_text(format!("{header}{encoded}").as_bytes()).unwrap(),
            "привет\n".as_bytes()
        );
    }
    // Node's `Buffer.from` takes a payload without its padding.
    assert_eq!(material_text(b"data:text/plain;base64,aGk").unwrap(), b"hi");
    for refused in [
        "data:text/markdown;base64,aGk=",
        "data:text/plain;charset=latin1;base64,aGk=",
        "data:TEXT/PLAIN;base64,aGk=",
        "data:text/plain,hi",
        "data:text/plain;base64,aG k=",
        "data:text/plain;base64,aGk===",
        "hi",
    ] {
        assert_eq!(material_text(refused.as_bytes()), None, "{refused}");
    }
}

/// An artifact store keeping objects as files in a directory, like the node store.
struct Files(std::path::PathBuf, bool);

#[async_trait::async_trait]
impl ArtifactStore for Files {
    async fn put(
        &self,
        session: &SessionId,
        purpose: ArtifactPurpose,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ArtifactRef, rust_cli_kernel_api::store::StoreError> {
        let artifact = ArtifactRef {
            session: session.clone(),
            id: rust_cli_kernel_api::ids::ArtifactId::new("tool-result-1"),
            purpose,
            media_type,
            size: bytes.len() as u64,
        };
        rust_cli_fs::append(&self.0.join("attachment-tool-result-1.txt"), &bytes)
            .await
            .unwrap();
        Ok(artifact)
    }

    async fn get(
        &self,
        _artifact: &ArtifactRef,
    ) -> Result<Vec<u8>, rust_cli_kernel_api::store::StoreError> {
        unreachable!()
    }

    fn local_path(&self, _artifact: &ArtifactRef) -> Option<std::path::PathBuf> {
        self.1.then(|| self.0.join("attachment-tool-result-1.txt"))
    }
}

#[tokio::test]
async fn web_remote_text_material_is_written_and_referenced_by_its_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = Files(dir.path().to_path_buf(), true);
    let session = SessionId::new("s");
    let content = format!(
        "data:text/plain;base64,{}",
        base64().encode("line 1\nline 2")
    );
    let (body, path, size) = write_material(
        &store,
        &session,
        MaterialKind::ClipboardText,
        content.as_bytes(),
    )
    .await
    .unwrap();
    // The model reads the raw text from the file the note names, as Node's Read tool would.
    assert_eq!(
        rust_cli_fs::read_optional(Path::new(&path))
            .await
            .unwrap()
            .unwrap(),
        b"line 1\nline 2"
    );
    // Node's `sizeBytes` is the decoded text's length, not the data URL's or the App's declared size.
    assert_eq!(size, 13);
    let AttachedBody::PathReference { text } = body else {
        panic!("path reference");
    };
    assert_eq!(
        text,
        format!(
            "Attached text/plain: {path}\nThe file was sent by local path because it is a pasted-text temporary \
             attachment that is deferred to keep the model context small.\nUse the available file reading tools if \
             you need to inspect the file contents."
        )
    );
    // Not Node's text data URL, or no local file to name: the input is refused (Node throws), never inlined.
    let failed =
        |result: Result<(AttachedBody, String, u64), RpcError>| result.unwrap_err().message;
    assert_eq!(
        failed(write_material(&store, &session, MaterialKind::TopicHistory, b"plain").await),
        "fault.attachment.textMaterializationFailed"
    );
    let pathless = Files(dir.path().to_path_buf(), false);
    assert_eq!(
        failed(
            write_material(
                &pathless,
                &session,
                MaterialKind::TopicHistory,
                content.as_bytes()
            )
            .await
        ),
        "fault.attachment.textMaterializationFailed"
    );
}

#[tokio::test]
async fn desktop_text_material_is_deferred_by_its_path() {
    let dir = tempfile::tempdir().unwrap();
    let pasted = dir.path().join("pasted.txt");
    rust_cli_fs::append(&pasted, b"long pasted text")
        .await
        .unwrap();
    let mut reference = local_ref(&pasted, "text/plain", 16);
    reference.source_kind = Some(MaterialKind::ClipboardText);
    let Some(AttachedBody::PathReference { text }) = path_reference(&reference).await else {
        panic!("path reference");
    };
    assert!(text.starts_with(&format!("Attached text/plain: {}\n", pasted.display())));
    assert!(text.contains("because it is a pasted-text temporary attachment"));
    reference.source_kind = Some(MaterialKind::TopicHistory);
    let Some(AttachedBody::PathReference { text }) = path_reference(&reference).await else {
        panic!("path reference");
    };
    assert!(text.contains("because topic history is provided for on-demand reading."));
    // Node checks the extension first: a non-text file is still `binary_file`.
    let blob = dir.path().join("pasted.bin");
    rust_cli_fs::append(&blob, b"x").await.unwrap();
    let mut reference = local_ref(&blob, "text/plain", 1);
    reference.source_kind = Some(MaterialKind::ClipboardText);
    let Some(AttachedBody::PathReference { text }) = path_reference(&reference).await else {
        panic!("path reference");
    };
    assert!(text.contains("because the file is not a known text attachment."));
}

#[test]
fn text_is_previewed_only_as_material() {
    assert!(previewable("text/plain; charset=utf-8", true));
    assert!(!previewable("text/plain", false));
    assert!(previewable("image/png", false));
    assert!(previewable("application/pdf", false));
    assert!(!previewable("application/zip", true));
}

/// Node `resolveLocalVideoAttachment`: a desktop video is read whole up to 30 MiB with the MIME of its extension;
/// a larger one goes by path (`video_too_large`), an empty or missing one keeps only its metadata.
#[tokio::test]
async fn desktop_videos_are_read_whole_or_sent_by_path_like_node() {
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("clip.mov");
    rust_cli_fs::append(&clip, b"moov").await.unwrap();
    assert_eq!(
        local_video(&local_ref(&clip, "video/mp4", 4)).await,
        Some(AttachedBody::Video {
            source: ImageSource::Base64 {
                media_type: "video/quicktime".into(),
                data: base64().encode(b"moov"),
            }
        })
    );
    // The App's MIME decides (Node `isVideoRef`): a video is never a binary-file path reference, while a `.mov` the
    // App calls octet-stream is one, named with the MIME of its extension.
    let Some(AttachedBody::PathReference { text }) =
        path_reference(&local_ref(&clip, "application/octet-stream", 4)).await
    else {
        panic!("path reference");
    };
    assert!(text.starts_with("Attached video/quicktime: "), "{text}");
    assert_eq!(
        path_reference(&local_ref(&clip, "video/quicktime", 4)).await,
        None
    );
    let big = dir.path().join("big.mp4");
    rust_cli_fs::append(&big, &vec![0u8; VIDEO_INPUT_MAX_BYTES as usize + 1])
        .await
        .unwrap();
    let Some(AttachedBody::PathReference { text }) =
        local_video(&local_ref(&big, "video/mp4", VIDEO_INPUT_MAX_BYTES + 1)).await
    else {
        panic!("path reference");
    };
    assert!(text.starts_with("Attached video/mp4: "), "{text}");
    assert!(
        text.contains("larger than the ZCode video input limit"),
        "{text}"
    );
    let empty = dir.path().join("empty.webm");
    rust_cli_fs::append(&empty, b"").await.unwrap();
    assert_eq!(
        local_video(&local_ref(&empty, "video/webm", 0)).await,
        Some(AttachedBody::Omitted)
    );
    assert_eq!(
        local_video(&local_ref(&dir.path().join("gone.mp4"), "video/mp4", 1)).await,
        Some(AttachedBody::Omitted)
    );
}

#[test]
fn desktop_text_is_read_by_the_agent_whatever_its_declared_size() {
    // Node `mapAttachmentRef`: the 64 KiB limit is only for web-remote refs; a desktop file goes to
    // `resolveLocalFileAttachment`, routed by the App's MIME.
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("big.log");
    assert!(is_local_text(&local_ref(&log, "text/plain", 16 << 20)));
    assert!(is_local_text(&local_ref(
        &log,
        "application/octet-stream",
        1
    )));
    assert!(!is_local_text(&local_ref(&log, "image/png", 1)));
    assert!(!is_local_text(&local_ref(&log, "video/mp4", 1)));
    assert!(!is_local_text(&local_ref(&log, "application/pdf", 1)));
    let mut material = local_ref(&log, "text/plain", 1);
    material.source_kind = Some(MaterialKind::TopicHistory);
    assert!(!is_local_text(&material));
    let remote: AttachmentRef = serde_json::from_value(json!({
        "ref": "zcode-artifact://s/a", "fileName": "a.txt", "mime": "text/plain", "bytes": 1,
    }))
    .unwrap();
    assert!(!is_local_text(&remote));
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb([10, 120, 200]));
    let mut data = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut data),
            image::ImageFormat::Png,
        )
        .unwrap();
    data
}

/// Node `prepareImageDataUrl`: an image over 2000 px is bounded and the part records how (`metadata.image`).
#[tokio::test]
async fn an_attached_image_is_prepared_for_the_model_like_node() {
    let (body, info) = prepare_image(png(3000, 30), "image/png").await;
    let AttachedBody::Image {
        source: ImageSource::Base64 { media_type, data },
    } = body
    else {
        panic!("an image block: {body:?}");
    };
    // A PNG over the size limit goes to the JPEG ladder (Node keeps PNG only at its own size).
    assert_eq!(media_type, "image/jpeg");
    let sent = base64().decode(data).unwrap();
    assert_eq!(
        info.as_deref(),
        Some(&ImageInfo {
            width: Some(2000),
            height: Some(20),
            original_width: Some(3000),
            original_height: Some(30),
            max_dimension: 2000,
            resized: true,
            transformed_size_bytes: sent.len() as u64,
        })
    );
    // Within the limits the original bytes are sent.
    let small = png(40, 30);
    let (body, info) = prepare_image(small.clone(), "image/png").await;
    assert_eq!(
        body,
        AttachedBody::Image {
            source: ImageSource::Base64 {
                media_type: "image/png".into(),
                data: base64().encode(&small),
            }
        }
    );
    assert!(!info.unwrap().resized);
}

#[tokio::test]
async fn an_image_that_cannot_be_prepared_is_nodes_placeholder() {
    assert_eq!(
        prepare_image(Vec::new(), "image/png").await,
        (
            AttachedBody::Placeholder {
                code: "attachment_image_invalid".into(),
                label: None,
                url: None,
            },
            None
        )
    );
    assert_eq!(
        prepare_image(b"not an image".to_vec(), "image/png").await,
        (
            AttachedBody::Placeholder {
                code: "attachment_image_resize_failed".into(),
                label: None,
                url: None,
            },
            None
        )
    );
}

/// Node `derivedMediaAttachmentPath`: the playback copy of a video artifact is keyed by the URI's hash under the
/// session's `video-cache` directory; a MIME Node cannot name or an unsafe session id has none.
#[test]
fn a_video_artifacts_playback_copy_is_named_like_node() {
    let root = Path::new("/data");
    let uri = "zcode-artifact://s1/a1";
    let digest = rust_cli_base::hash::sha256_hex(uri.as_bytes());
    assert_eq!(
        video_cache_path(
            root,
            &SessionId::new("s1"),
            uri,
            "video/QuickTime; codecs=x"
        ),
        Some(PathBuf::from(format!(
            "/data/cli/video-cache/s1/video-{}.mov",
            &digest[..32]
        )))
    );
    assert_eq!(
        video_cache_path(root, &SessionId::new("s1"), uri, "video/ogg"),
        None
    );
    assert_eq!(
        video_cache_path(root, &SessionId::new("../x"), uri, "video/mp4"),
        None
    );
}

/// Node `ensureMediaAttachmentPath`: the decoded video is written once and then reused; content that is not a video
/// data URL leaves no file.
#[test]
fn a_video_artifact_is_written_once_as_its_playback_copy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cli/video-cache/s1/video-x.mp4");
    let data_url = format!(
        "data:video/mp4;base64,{}",
        base64().encode(b"\0\0\0\x18ftyp")
    );
    let written = block_on(derived_video(
        &path,
        async || Some(data_url.clone().into_bytes()),
        "video/mp4",
    ));
    assert_eq!(written.as_deref(), path.to_str());
    assert_eq!(
        block_on(rust_cli_fs::read_optional(&path))
            .unwrap()
            .unwrap(),
        b"\0\0\0\x18ftyp"
    );
    // An existing copy is reused without reading the artifact again.
    let reused = block_on(derived_video(&path, async || None, "video/mp4"));
    assert_eq!(reused.as_deref(), path.to_str());

    let other = dir.path().join("cli/video-cache/s1/video-y.mp4");
    let image = format!("data:image/png;base64,{}", base64().encode(b"\x89PNG"));
    for content in [image.into_bytes(), b"not a data url".to_vec()] {
        assert_eq!(
            block_on(derived_video(
                &other,
                async || Some(content.clone()),
                "video/mp4"
            )),
            None
        );
    }
    assert!(!block_on(rust_cli_fs::is_file(&other)));
}

/// Session artifacts held in memory by URI, answering `find` with the stored object's length like the node store.
struct Uploaded(std::collections::HashMap<String, Vec<u8>>);

impl Uploaded {
    fn key(session: &SessionId, id: &ArtifactId) -> String {
        format!("{}/{}", session.as_str(), id.as_str())
    }
}

#[async_trait::async_trait]
impl ArtifactStore for Uploaded {
    async fn put(
        &self,
        _session: &SessionId,
        _purpose: ArtifactPurpose,
        _media_type: String,
        _bytes: Vec<u8>,
    ) -> Result<ArtifactRef, rust_cli_kernel_api::store::StoreError> {
        unreachable!("a web-remote upload is reused, not written again")
    }

    async fn get(
        &self,
        artifact: &ArtifactRef,
    ) -> Result<Vec<u8>, rust_cli_kernel_api::store::StoreError> {
        Ok(self.0[&Self::key(&artifact.session, &artifact.id)].clone())
    }

    async fn find(
        &self,
        session: &SessionId,
        id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, rust_cli_kernel_api::store::StoreError> {
        Ok(self
            .0
            .get(&Self::key(session, id))
            .map(|content| ArtifactRef {
                session: session.clone(),
                id: id.clone(),
                purpose: ArtifactPurpose::Attachment,
                media_type: "text/plain".to_owned(),
                size: content.len() as u64,
            }))
    }
}

struct UploadKernel(Arc<Uploaded>);

#[async_trait::async_trait]
impl rust_cli_kernel_api::session_api::Kernel for UploadKernel {
    fn queries(&self) -> Arc<dyn rust_cli_kernel_api::store::StoreQueries> {
        unreachable!()
    }

    fn artifacts(&self) -> Option<Arc<dyn ArtifactStore>> {
        Some(self.0.clone())
    }

    async fn create_session(
        &self,
        _request: rust_cli_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, rust_cli_kernel_api::session_api::KernelError> {
        unreachable!()
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<
        Arc<dyn rust_cli_kernel_api::session_api::SessionHandle>,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        unreachable!()
    }

    async fn list_sessions(
        &self,
        _filter: rust_cli_kernel_api::store::SessionFilter,
    ) -> Result<
        Vec<rust_cli_kernel_api::store::SessionSummary>,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        unreachable!()
    }

    async fn delete_session(
        &self,
        _session: &SessionId,
    ) -> Result<(), rust_cli_kernel_api::session_api::KernelError> {
        unreachable!()
    }
}

/// Node's `metadata.sizeBytes` for web-remote uploads, as Node's `resolveTurnAttachments` wrote it for these inputs: a
/// 68-byte PNG's data URL artifact → 114 (the data URL's length, which is also the artifact Share stats), a 29-byte
/// video's → 29 (the decoded payload). `zcode-rs` writes the same value, not the App's declared size.
#[tokio::test]
async fn web_remote_uploads_carry_nodes_size_bytes() {
    // The same input Node's resolver was run on.
    let png = base64()
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=")
        .unwrap();
    let video = b"not really a video but bytes!".to_vec();
    let session = SessionId::new("s");
    let image_url = format!("data:image/png;base64,{}", base64().encode(&png));
    let video_url = format!("data:video/mp4;base64,{}", base64().encode(&video));
    let store = Arc::new(Uploaded(
        [
            ("s/img".to_owned(), image_url.clone().into_bytes()),
            ("s/vid".to_owned(), video_url.clone().into_bytes()),
        ]
        .into(),
    ));
    let (server, _guards) = upload_server(store.clone());
    // The App's declared sizes are deliberately not Node's measure.
    let refs = parse_refs(&[
        json!({"ref": "zcode-artifact://s/img", "fileName": "dot.png", "mime": "image/png", "bytes": png.len()}),
        json!({"ref": "zcode-artifact://s/vid", "fileName": "clip.mp4", "mime": "video/mp4", "bytes": 1}),
    ])
    .unwrap();
    let blocks = content(&server, &session, "", refs).await.unwrap();
    let files: Vec<&AttachedFile> = blocks
        .iter()
        .map(|block| match block {
            ContentBlock::File { file } => file,
            other => panic!("file block expected: {other:?}"),
        })
        .collect();
    assert_eq!(png.len(), 68);
    assert_eq!(image_url.len(), 114);
    assert!(matches!(files[0].body, AttachedBody::Image { .. }));
    assert_eq!(files[0].stored.as_deref(), Some("zcode-artifact://s/img"));
    assert_eq!(files[0].bytes, 114);
    assert!(matches!(files[1].body, AttachedBody::Video { .. }));
    assert_eq!(files[1].stored.as_deref(), Some("zcode-artifact://s/vid"));
    assert_eq!(files[1].bytes, 29);
    // Share's stat states the stored object (Node `statToolResultArtifact`): the image's chip and stat agree.
    let found = store
        .find(&session, &ArtifactId::new("img"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.size, files[0].bytes);
}

/// A server over [`UploadKernel`]; the guards keep its connection and task scope alive.
fn upload_server(store: Arc<Uploaded>) -> (Server, Box<dyn std::any::Any>) {
    use rust_cli_kernel_api::testing::{FixedClock, selection};
    use rust_cli_protocol_core::connection::{self, Options};
    let scope = rust_cli_base::TaskScope::root("test", |_| {});
    let (out, reader) = tokio::io::duplex(1 << 16);
    let (peer, writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(crate::context::Context::new(peer, Arc::new(FixedClock(5))));
    let server = Server::new(
        context,
        Arc::new(UploadKernel(store)),
        scope.spawner(),
        crate::server::Defaults {
            selection: selection(),
            mode: rust_cli_kernel_api::permission::PermissionMode::Default,
            environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        },
    );
    (server, Box::new((scope, reader, writer)))
}

/// Node's local path references (`resolveLocalFileAttachment`, `resolveLocalImageAttachment`, …) state the file's
/// `stat` size, not the App's declared one, so Share's stat of the same file agrees with the chip.
#[tokio::test]
async fn desktop_path_references_carry_the_files_stat_size() {
    let dir = tempfile::tempdir().unwrap();
    let pasted = dir.path().join("pasted.txt");
    rust_cli_fs::append(&pasted, b"long pasted text")
        .await
        .unwrap();
    let zip = dir.path().join("bundle.zip");
    rust_cli_fs::append(&zip, b"binary fixture").await.unwrap();
    let mut material = local_ref(&pasted, "text/plain", 1);
    material.source_kind = Some(MaterialKind::ClipboardText);
    let (server, _guards) = upload_server(Arc::new(Uploaded(Default::default())));
    let blocks = content(
        &server,
        &SessionId::new("s"),
        "",
        vec![material, local_ref(&zip, "application/zip", 2)],
    )
    .await
    .unwrap();
    let sizes: Vec<(bool, u64)> = blocks
        .iter()
        .map(|block| match block {
            ContentBlock::File { file } => (
                matches!(file.body, AttachedBody::PathReference { .. }),
                file.bytes,
            ),
            other => panic!("file block expected: {other:?}"),
        })
        .collect();
    assert_eq!(sizes, [(true, 16), (true, 14)]);
}
