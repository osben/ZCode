//! Fork: App attachments (`v4/attachment/*` and the `attachments` of `sendText`), ported from Node's
//! `v4-gateway.ts` attachment methods, `writePromptAttachment` and `commands/attachment-refs.ts`
//! (specs/fork-agent-runtime-selection.md, "Attachments in Rust mode").
//!
//! Storage matches Node: a committed upload is a session artifact holding `data:<mime>;base64,<bytes>` as
//! `text/plain`, referenced as `zcode-artifact://<session>/<artifact>`; Node finds it by id and decodes the data URL.

use base64::Engine;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_fs::BoundedRead;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{
    AttachedBody, AttachedFile, ContentBlock, ImageInfo, ImageSource, Material, MaterialKind,
};
use rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME;
use rust_cli_kernel_api::prompt_attachment::VIDEO_INPUT_MAX_BYTES;
use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactRef, ArtifactStore};
use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::server::Server;
use crate::uploads::{Began, Begin, CHUNK_MAX_BYTES, Commit, MAX_BYTES, Target};

/// Node `INLINE_TEXT_ATTACHMENT_MAX_BYTES`: larger text files are sent as a metadata-only reminder.
const INLINE_TEXT_MAX_BYTES: u64 = 64 * 1024;

/// Node `INLINE_MEDIA_ATTACHMENT_MAX_BYTES`: the largest image read and prepared for the model; a larger desktop image
/// goes by path (`image_too_large`).
const INLINE_MEDIA_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Node's `errorCode` of an image that could not be prepared, and of an empty one.
const IMAGE_RESIZE_FAILED: &str = "attachment_image_resize_failed";
const IMAGE_INVALID: &str = "attachment_image_invalid";

/// A `fault.attachment.*` error: the code is the message and `data.code`, like Node's `ZCodeAttachmentFaultError`
/// through `toProtocolError` (the Host reads either).
pub(crate) fn fault(code: &str) -> RpcError {
    let code = format!("fault.attachment.{code}");
    RpcError::internal(code.clone()).with_data(json!({ "code": code }))
}

pub(crate) fn base64() -> &'static base64::engine::GeneralPurpose {
    &base64::engine::general_purpose::STANDARD
}

pub(crate) fn artifacts(server: &Server) -> Result<Arc<dyn ArtifactStore>, RpcError> {
    server
        .kernel
        .artifacts()
        .ok_or_else(|| fault("putUnsupported"))
}

pub(crate) fn parse<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T, RpcError> {
    serde_json::from_value(params.clone())
        .map_err(|error| RpcError::invalid_params(error.to_string()))
}

/// JS `encodeURIComponent` (Node writes artifact URIs with it).
fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn uri(artifact: &ArtifactRef) -> String {
    format!(
        "{ARTIFACT_SCHEME}{}/{}",
        encode(artifact.session.as_str()),
        encode(artifact.id.as_str())
    )
}

/// The bytes and MIME of a data URL (`data:<mime>;base64,<payload>`); other content is returned as is.
fn from_data_url(content: Vec<u8>, fallback: &str) -> (Vec<u8>, String) {
    if let Some(rest) = content.strip_prefix(b"data:")
        && let Some(comma) = rest.iter().position(|b| *b == b',')
        && let Ok(header) = std::str::from_utf8(&rest[..comma])
        && let Some(mime) = header.strip_suffix(";base64")
        && let Ok(bytes) = base64().decode(&rest[comma + 1..])
    {
        return (bytes, mime.to_owned());
    }
    (content, fallback.to_owned())
}

/// Room for the `data:<mime>;base64,` prefix of a stored data URL, when the artifact's size is checked before it is read.
const DATA_URL_HEADER_ALLOWANCE: u64 = 1024;

/// The largest stored data URL that can hold `decoded` bytes. The artifact's ref size is checked against it before
/// `get` loads the content; the decoded size is checked again after decoding.
pub(crate) fn encoded_cap(decoded: u64) -> u64 {
    decoded.div_ceil(3) * 4 + DATA_URL_HEADER_ALLOWANCE
}

/// Reads an attachment ref: a session artifact (`zcode-artifact://`, what `v4/attachment/commit` answers) or, from the
/// desktop, a local absolute path (the Host's prompt attachment transfer is zero-copy on a local Host). The result never
/// exceeds `limit` bytes: an oversized file or artifact is refused before its content is loaded.
async fn read(
    server: &Server,
    session: &SessionId,
    reference: &str,
    mime: &str,
    limit: u64,
) -> Result<(Vec<u8>, String), RpcError> {
    if !reference.starts_with(ARTIFACT_SCHEME) {
        return read_local(Path::new(reference), mime, limit).await;
    }
    let content = artifact_content(server, session, reference, limit).await?;
    bounded_data_url(content, mime, limit)
}

/// An artifact's data URL decoded, refused over `limit` decoded bytes.
fn bounded_data_url(
    content: Vec<u8>,
    mime: &str,
    limit: u64,
) -> Result<(Vec<u8>, String), RpcError> {
    let (bytes, media_type) = from_data_url(content, mime);
    if bytes.len() as u64 > limit {
        return Err(fault("tooLarge"));
    }
    Ok((bytes, media_type))
}

/// The stored content of a session artifact ref (a data URL for an attachment), refused when it cannot hold at most
/// `limit` decoded bytes.
async fn artifact_content(
    server: &Server,
    session: &SessionId,
    reference: &str,
    limit: u64,
) -> Result<Vec<u8>, RpcError> {
    let (owner, _) = rust_cli_kernel_api::prompt_attachment::parse_artifact_uri(reference)
        .ok_or_else(|| fault("refInvalid"))?;
    if &owner != session {
        return Err(fault("previewRefNotAuthorized"));
    }
    stored_artifact_content(server, reference, limit).await
}

/// The content of the artifact a stored `file` part holds, whichever session wrote it: a fork's part keeps its
/// parent's artifact (Node `clonePartForFork`), and Node's `readToolResultArtifact` reads it. Only for a URI taken from
/// the session's own part, never one the App sends.
async fn stored_artifact_content(
    server: &Server,
    reference: &str,
    limit: u64,
) -> Result<Vec<u8>, RpcError> {
    let (owner, id) = rust_cli_kernel_api::prompt_attachment::parse_artifact_uri(reference)
        .ok_or_else(|| fault("refInvalid"))?;
    let store = artifacts(server)?;
    // Store errors can name storage paths, so only the fault code leaves this function.
    let artifact = store
        .find(&owner, &id)
        .await
        .map_err(|_| fault("storeFailed"))?
        .ok_or_else(|| fault("artifactNotFound"))?;
    if artifact.size > encoded_cap(limit) {
        return Err(fault("tooLarge"));
    }
    store.get(&artifact).await.map_err(|_| fault("storeFailed"))
}

/// A local ref: a regular file of at most `limit` bytes. A directory, FIFO or device is refused, since reading one can
/// block or never end.
async fn read_local(path: &Path, mime: &str, limit: u64) -> Result<(Vec<u8>, String), RpcError> {
    if !path.is_absolute() {
        return Err(fault("refInvalid"));
    }
    match rust_cli_fs::read_regular_bounded(path, limit)
        .await
        .map_err(|_| fault("readFailed"))?
    {
        BoundedRead::Bytes(bytes) => Ok((bytes, mime.to_owned())),
        BoundedRead::Missing => Err(fault("fileNotFound")),
        BoundedRead::NotRegular => Err(fault("refInvalid")),
        BoundedRead::TooLarge => Err(fault("tooLarge")),
    }
}

fn essence(mime: &str) -> String {
    mime.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// One `attachments` entry of `sendText`, read the way Node's strict `attachmentRefSchema` reads it: every schema field
/// is accepted and nothing else is.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentRef {
    #[serde(rename = "ref")]
    reference: String,
    file_name: String,
    mime: String,
    bytes: u64,
    #[serde(default)]
    source_kind: Option<MaterialKind>,
    #[serde(default)]
    message_count: Option<u64>,
    #[serde(default)]
    preview_ref: Option<String>,
}

impl AttachmentRef {
    /// Fork: the App's ref (a stored attachment keeps it as [`rust_cli_kernel_api::message::AttachedFile::reference`]).
    pub(crate) fn reference(&self) -> &str {
        &self.reference
    }

    /// Node `displayMetaOf`: `messageCount` counts only with a `sourceKind`.
    fn material(&self) -> Option<Box<Material>> {
        self.source_kind.map(|kind| {
            Box::new(Material {
                kind,
                message_count: self.message_count,
            })
        })
    }
}

/// Parses the `attachments` of a `sendText` or a `createSession` first input. Node's schema refuses the whole command when
/// one entry does not match, so a malformed entry is refused here too, before any session is created. Silently dropping it
/// would leave the model unaware of the file. The message does not echo the entry: a value there can be a user path.
pub(crate) fn parse_refs(refs: &[Value]) -> Result<Vec<AttachmentRef>, RpcError> {
    refs.iter()
        .map(|value| {
            serde_json::from_value::<AttachmentRef>(value.clone()).map_err(|_| {
                RpcError::invalid_params("an attachment ref does not match attachmentRefSchema")
            })
        })
        .collect()
}

/// The content of an input with attachments (Node `mapAttachmentRef` → `resolveAttachment`): the user's text, then one
/// [`ContentBlock::File`] per attachment, read now (inline text or a base64 image). A ref that cannot be read still
/// reaches the model as a metadata-only reminder, never silently dropped. Text material that cannot be written refuses
/// the input (Node throws and fails the turn), so its text never reaches the model another way.
pub(crate) async fn content(
    server: &Server,
    session: &SessionId,
    text: &str,
    refs: Vec<AttachmentRef>,
) -> Result<Vec<ContentBlock>, RpcError> {
    let mut out = Vec::new();
    if !text.is_empty() {
        out.push(ContentBlock::Text {
            text: text.to_owned(),
        });
    }
    for attachment in refs {
        // `size` is the `metadata.sizeBytes` Node writes for the same input, when it is not the App's declared size.
        let (body, stored, image, size) = if let Some(kind) = attachment.source_kind
            && is_uri_ref(&attachment.reference)
        {
            let store = artifacts(server).map_err(|_| material_failed())?;
            let content = artifact_content(server, session, &attachment.reference, MAX_BYTES)
                .await
                .map_err(|_| material_failed())?;
            let (body, path, size) =
                write_material(store.as_ref(), session, kind, &content).await?;
            (body, Some(path), None, Some(size))
        } else if let Some(video) = video(server, session, &attachment).await {
            match video {
                AttachedBody::Video { source } => {
                    // Node stops the turn when a video cannot be persisted: a part that cannot be read back would make
                    // a cold load differ from what the model saw, and a 30 MiB data URL does not belong in the part.
                    let stored = stored_image(server, session, &attachment, &source)
                        .await
                        .ok_or_else(|| fault("putFailed"))?;
                    let size = decoded_len(&source);
                    (AttachedBody::Video { source }, Some(stored), None, size)
                }
                other => (other, None, None, None),
            }
        } else {
            let (body, image, read_size) = body(server, session, &attachment).await;
            let stored = match &body {
                AttachedBody::Image { source } => {
                    stored_image(server, session, &attachment, source).await
                }
                _ => None,
            };
            // Node: a prepared image states what it read (a web-remote data URL's length, a desktop file's size); an
            // image that cannot be prepared states the file's size on the desktop and nothing for a web-remote ref.
            let size = match &body {
                AttachedBody::Image { .. } => read_size,
                AttachedBody::ImageFailed { .. } if !is_uri_ref(&attachment.reference) => read_size,
                _ => None,
            };
            (body, stored, image, size)
        };
        // Node states a local path reference's `stat` size (binary file, deferred material, an image or video too
        // large to inline), so Share's stat of the same file agrees with the chip.
        let size = match (&body, size) {
            (AttachedBody::PathReference { .. }, None) if !is_uri_ref(&attachment.reference) => {
                rust_cli_fs::stat(Path::new(&attachment.reference))
                    .await
                    .ok()
                    .flatten()
                    .map(|stat| stat.len)
            }
            (_, size) => size,
        };
        let material = attachment.material();
        out.push(ContentBlock::File {
            file: AttachedFile {
                name: attachment.file_name,
                mime: attachment.mime,
                bytes: size.unwrap_or(attachment.bytes),
                reference: Some(attachment.reference).filter(|reference| !reference.is_empty()),
                preview_reference: attachment.preview_ref.map(String::into_boxed_str),
                stored,
                material,
                image,
                body,
            },
        });
    }
    Ok(out)
}

/// Node `isUriAttachmentRef`: `<scheme>://…` (a web-remote upload), not a local path.
fn is_uri_ref(reference: &str) -> bool {
    reference.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    })
}

fn material_failed() -> RpcError {
    fault("textMaterializationFailed")
}

/// The text of uploaded material: exactly `data:text/plain[;charset=utf-8];base64,<payload>` (Node's pattern), the
/// payload decoded as Node's `Buffer.from(…, "base64")` does.
fn material_text(content: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(content).ok()?;
    let payload = text
        .strip_prefix("data:text/plain;charset=utf-8;base64,")
        .or_else(|| text.strip_prefix("data:text/plain;base64,"))?;
    let body = payload.trim_end_matches('=');
    if payload.len() - body.len() > 2
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    {
        return None;
    }
    let lenient = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    lenient.decode(body).ok()
}

/// Node's web-remote text material: the decoded text is written as a new session artifact (raw text, `.txt`) and the
/// model gets the deferred path reference naming that file. Returns the body, the file's path and the text's length.
async fn write_material(
    store: &dyn ArtifactStore,
    session: &SessionId,
    kind: MaterialKind,
    content: &[u8],
) -> Result<(AttachedBody, String, u64), RpcError> {
    use rust_cli_kernel_api::prompt_attachment::{PathReason, path_reference};
    let text = material_text(content).ok_or_else(material_failed)?;
    let size = text.len() as u64;
    let artifact = store
        .put(
            session,
            ArtifactPurpose::Attachment,
            "text/plain".to_owned(),
            text,
        )
        .await
        .map_err(|_| material_failed())?;
    let path = store
        .local_path(&artifact)
        .and_then(|path| path.to_str().map(str::to_owned))
        .ok_or_else(material_failed)?;
    let body = AttachedBody::PathReference {
        text: path_reference("text/plain", &path, PathReason::deferred(kind)),
    };
    Ok((body, path, size))
}

/// The session artifact holding an inline image's or video's data URL (Node `persistAttachmentDataUrl`): a web-remote
/// ref already is one (`read` checked it belongs to this session) and is reused; a desktop file is written now. `None`
/// when the write fails: an image part then keeps the inline data URL, which both runtimes still read.
async fn stored_image(
    server: &Server,
    session: &SessionId,
    attachment: &AttachmentRef,
    source: &ImageSource,
) -> Option<String> {
    if attachment.reference.starts_with(ARTIFACT_SCHEME) {
        return Some(attachment.reference.clone());
    }
    let ImageSource::Base64 { media_type, data } = source else {
        return None;
    };
    let content = format!("data:{media_type};base64,{data}");
    let store = artifacts(server).ok()?;
    match store
        .put(
            session,
            ArtifactPurpose::Attachment,
            "text/plain".to_owned(),
            content.into_bytes(),
        )
        .await
    {
        Ok(artifact) => Some(uri(&artifact)),
        Err(_) => {
            // No error text: a storage error names the storage path.
            tracing::warn!(
                event = "attachment.store_failed",
                "storing an attached image or video failed"
            );
            None
        }
    }
}

/// Node `resolveLocalVideoAttachment` and the video branch of `resolveInlineMediaAttachment`: a video of at most
/// [`VIDEO_INPUT_MAX_BYTES`] is read whole and sent as a video block; a larger desktop video goes by path
/// (`video_too_large`); an empty, unreadable or malformed one keeps only its metadata. `None` when it is not a video.
async fn video(
    server: &Server,
    session: &SessionId,
    attachment: &AttachmentRef,
) -> Option<AttachedBody> {
    use rust_cli_kernel_api::prompt_attachment::video_of_data_url;
    if !essence(&attachment.mime).starts_with("video/") {
        return None;
    }
    let reference = attachment.reference.as_str();
    let omitted = |fault: &str| {
        // The fault code only: a local ref is a user path.
        tracing::warn!(event = "attachment.read_failed", mime = %attachment.mime, fault, "an attached video could not be read");
        Some(AttachedBody::Omitted)
    };
    if reference.starts_with(ARTIFACT_SCHEME) {
        let content =
            match artifact_content(server, session, reference, VIDEO_INPUT_MAX_BYTES).await {
                Ok(content) => content,
                Err(error) => return omitted(&error.message),
            };
        return match std::str::from_utf8(&content)
            .ok()
            .and_then(video_of_data_url)
        {
            Some(source) => Some(AttachedBody::Video { source }),
            None => omitted("attachment_video_invalid"),
        };
    }
    local_video(attachment).await
}

/// The desktop half of [`video`]: the App's absolute path, read up to [`VIDEO_INPUT_MAX_BYTES`].
async fn local_video(attachment: &AttachmentRef) -> Option<AttachedBody> {
    use rust_cli_kernel_api::prompt_attachment::{PathReason, path_reference, video_mime_of_path};
    let reference = attachment.reference.as_str();
    let omitted = |fault: &str| {
        // The fault code only: a local ref is a user path.
        tracing::warn!(event = "attachment.read_failed", mime = %attachment.mime, fault, "an attached video could not be read");
        Some(AttachedBody::Omitted)
    };
    let path = Path::new(reference);
    if !path.is_absolute() {
        return omitted("refInvalid");
    }
    let mime = video_mime_of_path(reference)
        .map(str::to_owned)
        .unwrap_or_else(|| essence(&attachment.mime));
    match rust_cli_fs::read_regular_bounded(path, VIDEO_INPUT_MAX_BYTES).await {
        Ok(BoundedRead::Bytes(bytes)) if bytes.is_empty() => omitted("attachment_video_invalid"),
        Ok(BoundedRead::Bytes(bytes)) => Some(AttachedBody::Video {
            source: ImageSource::Base64 {
                media_type: mime,
                data: base64().encode(&bytes),
            },
        }),
        Ok(BoundedRead::TooLarge) => Some(AttachedBody::PathReference {
            text: path_reference(&mime, reference, PathReason::VideoTooLarge),
        }),
        Ok(BoundedRead::Missing | BoundedRead::NotRegular) => omitted("fileNotFound"),
        Err(_) => omitted("readFailed"),
    }
}

/// The inline form an attachment may take, from its MIME and the client's declared size. The declared size only decides
/// whether to read at all; [`admit`] checks the real length of what was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Inline {
    Image,
    Text,
}

fn inline_form(mime: &str, declared_bytes: u64) -> Option<Inline> {
    let kind = essence(mime);
    if kind.starts_with("image/") {
        (declared_bytes <= INLINE_MEDIA_MAX_BYTES).then_some(Inline::Image)
    } else if kind.starts_with("video/") || kind == "application/pdf" {
        None
    } else {
        (declared_bytes <= INLINE_TEXT_MAX_BYTES).then_some(Inline::Text)
    }
}

impl Inline {
    fn limit(self) -> u64 {
        match self {
            Inline::Image => INLINE_MEDIA_MAX_BYTES,
            Inline::Text => INLINE_TEXT_MAX_BYTES,
        }
    }
}

/// What of bytes that were read reaches the model. Their real length is checked against the form's limit, because the
/// declared size is the client's word: over it is metadata only. An image is prepared for the model ([`prepare_image`]);
/// text that is not UTF-8 or holds a NUL is metadata only.
async fn admit(form: Inline, mime: &str, bytes: Vec<u8>) -> (AttachedBody, Option<Box<ImageInfo>>) {
    if bytes.len() as u64 > form.limit() {
        return (AttachedBody::Omitted, None);
    }
    match form {
        Inline::Image => prepare_image(bytes, mime).await,
        Inline::Text => match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => (AttachedBody::Text { text, read: None }, None),
            _ => (AttachedBody::Omitted, None),
        },
    }
}

/// Node `prepareImageDataUrl` with the Jimp adapter (specs/fork-agent-runtime-selection.md "Image preparation"): the
/// image block the model gets and Node's `metadata.image`, or Node's placeholder when the image cannot be prepared.
async fn prepare_image(bytes: Vec<u8>, mime: &str) -> (AttachedBody, Option<Box<ImageInfo>>) {
    if bytes.is_empty() {
        return (
            AttachedBody::ImageFailed {
                code: IMAGE_INVALID.to_owned(),
            },
            None,
        );
    }
    let declared = essence(mime);
    // Decoding and encoding are CPU bound.
    let prepared = tokio::task::spawn_blocking(move || {
        rust_cli_image::prepare(bytes, &declared, &rust_cli_image::MODEL)
    })
    .await;
    let prepared = match prepared {
        Ok(Ok(prepared)) => prepared,
        failed => {
            let reason = match failed {
                Ok(Err(error)) => error.to_string(),
                _ => "the preparation task ended".to_owned(),
            };
            tracing::warn!(event = "attachment.image_prepare_failed", %reason, "an attached image could not be prepared for the model");
            return (
                AttachedBody::ImageFailed {
                    code: IMAGE_RESIZE_FAILED.to_owned(),
                },
                None,
            );
        }
    };
    let dimensions = prepared.dimensions;
    let info = ImageInfo {
        width: dimensions.map(|size| size.width),
        height: dimensions.map(|size| size.height),
        original_width: dimensions.map(|size| size.original_width),
        original_height: dimensions.map(|size| size.original_height),
        max_dimension: rust_cli_image::MAX_DIMENSION,
        resized: prepared.resized,
        transformed_size_bytes: prepared.data.len() as u64,
    };
    let body = AttachedBody::Image {
        source: ImageSource::Base64 {
            media_type: prepared.media_type.to_owned(),
            data: base64().encode(&prepared.data),
        },
    };
    (body, Some(Box::new(info)))
}

/// Node `resolveLocalFileAttachment` / `resolveLocalImageAttachment`: a desktop file (an absolute local path) that is
/// not read inline goes by path, so the model can read it with its tools. Only an existing regular file does (Node stats
/// it first; anything else is a placeholder).
async fn path_reference(attachment: &AttachmentRef) -> Option<AttachedBody> {
    use rust_cli_kernel_api::prompt_attachment::{
        PathReason, is_text_like_path, mime_of_path, path_reference,
    };
    let path = attachment.reference.as_str();
    if path.starts_with(ARTIFACT_SCHEME) || !Path::new(path).is_absolute() {
        return None;
    }
    let kind = essence(&attachment.mime);
    let (mime, reason) = if kind.starts_with("image/") {
        if attachment.bytes <= INLINE_MEDIA_MAX_BYTES {
            return None;
        }
        (kind, PathReason::ImageTooLarge)
    } else if kind.starts_with("video/") || kind == "application/pdf" {
        return None;
    } else if !is_text_like_path(path) {
        (mime_of_path(path).to_owned(), PathReason::BinaryFile)
    } else if let Some(material) = attachment.source_kind {
        // Node: pasted text and topic history are already a local file; reading it would put the body back in.
        ("text/plain".to_owned(), PathReason::deferred(material))
    } else {
        return None;
    };
    if !rust_cli_fs::is_file(Path::new(path)).await {
        return None;
    }
    Some(AttachedBody::PathReference {
        text: path_reference(&mime, path, reason),
    })
}

/// A desktop ref (an absolute local path) whose App MIME is not an image, a video or a PDF, and that is not text
/// material (Node maps those by MIME; [`path_reference`] takes material and non-text-like files first).
fn is_local_text(attachment: &AttachmentRef) -> bool {
    let kind = essence(&attachment.mime);
    attachment.source_kind.is_none()
        && !is_uri_ref(&attachment.reference)
        && !attachment.reference.starts_with(ARTIFACT_SCHEME)
        && Path::new(&attachment.reference).is_absolute()
        && !kind.starts_with("image/")
        && !kind.starts_with("video/")
        && kind != "application/pdf"
}

/// What of one attachment reaches the model (the stored file part keeps it for both runtimes), with Node's
/// `metadata.image` of a prepared image and the length of what was read: a web-remote artifact's stored data URL, a
/// desktop file's bytes.
async fn body(
    server: &Server,
    session: &SessionId,
    attachment: &AttachmentRef,
) -> (AttachedBody, Option<Box<ImageInfo>>, Option<u64>) {
    if let Some(reference) = path_reference(attachment).await {
        return (reference, None, None);
    }
    // Node `mapAttachmentRef` → `resolveLocalFileAttachment`: a desktop file that is not media is read by the agent,
    // with no 64 KiB limit (that one is for web-remote refs).
    if is_local_text(attachment) {
        return (
            crate::attachment_text::local_text(&attachment.reference).await,
            None,
            None,
        );
    }
    let Some(form) = inline_form(&attachment.mime, attachment.bytes) else {
        return (AttachedBody::Omitted, None, None);
    };
    // The read is bounded by the form's limit, so a file that grew past its declared size is refused, not loaded.
    let read = if attachment.reference.starts_with(ARTIFACT_SCHEME) {
        match artifact_content(server, session, &attachment.reference, form.limit()).await {
            Ok(content) => {
                let size = content.len() as u64;
                bounded_data_url(content, &attachment.mime, form.limit())
                    .map(|(bytes, mime)| (bytes, mime, size))
            }
            Err(error) => Err(error),
        }
    } else {
        read_local(
            Path::new(&attachment.reference),
            &attachment.mime,
            form.limit(),
        )
        .await
        .map(|(bytes, mime)| {
            let size = bytes.len() as u64;
            (bytes, mime, size)
        })
    };
    let (bytes, mime, size) = match read {
        Ok(read) => read,
        Err(error) => {
            // The fault code only: a local ref is a user path.
            tracing::warn!(event = "attachment.read_failed", mime = %attachment.mime, fault = %error.message, "an attachment could not be read");
            return (AttachedBody::Omitted, None, None);
        }
    };
    let (body, image) = admit(form, &mime, bytes).await;
    (body, image, Some(size))
}

/// Node `base64PayloadByteLength`: the bytes a base64 video payload holds.
fn decoded_len(source: &ImageSource) -> Option<u64> {
    let ImageSource::Base64 { data, .. } = source else {
        return None;
    };
    let padding = data.len() - data.trim_end_matches('=').len();
    Some((data.len() * 3 / 4 - padding.min(2)) as u64)
}

/// `v4/attachment/begin`.
pub async fn begin(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params: Begin = parse(params)?;
    artifacts(server)?;
    let session = SessionId::new(&params.session_id);
    if server.kernel.session_snapshot(&session).await.is_err() {
        return Err(fault("sessionNotFound"));
    }
    let now = server.context.now();
    let began = server
        .uploads
        .lock_unpoisoned()
        .begin(&params, now)
        .map_err(RpcError::internal)?;
    Ok(Reply::new(match began {
        Began::Staging { next_chunk } => {
            json!({"uploadId": params.upload_id, "state": "staging", "nextChunkIndex": next_chunk})
        }
        Began::Committed {
            next_chunk,
            reference,
        } => json!({"uploadId": params.upload_id,
            "state": "committed", "nextChunkIndex": next_chunk, "ref": reference}),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    #[serde(flatten)]
    target: Target,
    chunk_index: usize,
    data_base64: String,
}

/// `v4/attachment/chunk`.
pub async fn chunk(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params: Chunk = parse(params)?;
    let bytes = base64()
        .decode(&params.data_base64)
        .map_err(|_| RpcError::invalid_params("invalid base64"))?;
    if bytes.len() > CHUNK_MAX_BYTES {
        return Err(RpcError::invalid_params(
            "attachment chunk exceeds decoded byte limit",
        ));
    }
    let now = server.context.now();
    let next = server
        .uploads
        .lock_unpoisoned()
        .chunk(&params.target, params.chunk_index, bytes, now)
        .map_err(RpcError::internal)?;
    Ok(Reply::new(
        json!({"uploadId": params.target.upload_id, "nextChunkIndex": next}),
    ))
}

/// `v4/attachment/commit`: stores the validated bytes the way Node's `writePromptAttachment` does.
pub async fn commit(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let target: Target = parse(params)?;
    let store = artifacts(server)?;
    let now = server.context.now();
    let step = server
        .uploads
        .lock_unpoisoned()
        .commit(&target, now)
        .map_err(RpcError::internal)?;
    let (mime, bytes) = match step {
        Commit::Done(reference) => return Ok(Reply::new(json!({"ref": reference}))),
        Commit::Store { mime, bytes, .. } => (mime, bytes),
    };
    let content = format!("data:{mime};base64,{}", base64().encode(&bytes));
    let session = SessionId::new(&target.session_id);
    match store
        .put(
            &session,
            ArtifactPurpose::Attachment,
            "text/plain".to_owned(),
            content.into_bytes(),
        )
        .await
    {
        Ok(artifact) => {
            let reference = uri(&artifact);
            server.uploads.lock_unpoisoned().committed(
                &target,
                reference.clone(),
                server.context.now(),
            );
            Ok(Reply::new(json!({"ref": reference})))
        }
        Err(_) => {
            server.uploads.lock_unpoisoned().release(&target);
            // No error text: a storage error can name the storage path.
            tracing::warn!(
                event = "attachment.commit_failed",
                "storing an attachment failed"
            );
            Err(fault("putFailed"))
        }
    }
}

/// `v4/attachment/abort`.
pub async fn abort(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let target: Target = parse(params)?;
    let now = server.context.now();
    server.uploads.lock_unpoisoned().abort(&target, now);
    Ok(Reply::new(json!({})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    session_id: String,
    #[serde(rename = "ref")]
    reference: String,
    target: Option<crate::attachment_share::RowTarget>,
    attachment_index: Option<usize>,
    offset: usize,
    limit: usize,
}

/// Node `isPreviewable`: media, and text only when the chip marks it as text material.
fn previewable(mime: &str, material: bool) -> bool {
    let kind = essence(mime);
    kind.starts_with("image/")
        || kind.starts_with("video/")
        || kind == "application/pdf"
        || (kind == "text/plain" && material)
}

/// `v4/attachment/read`: a ref is served only when a `userInput` row of the session carries it (never a raw path).
/// With a row target (Node `resolvePromptAttachment`) the read opens what that row's stored `file` part holds, its
/// immutable artifact first, so a later change of the local file never changes the preview; without one, the ref.
pub async fn read_chunk(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params: ReadParams = parse(params)?;
    if params.limit == 0 || params.limit > CHUNK_MAX_BYTES {
        return Err(RpcError::invalid_params("limit out of range"));
    }
    let session = SessionId::new(&params.session_id);
    let live = server
        .live(&session)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let denied = || fault("previewRefNotAuthorized");
    let (mime, material, stored) = match (&params.target, params.attachment_index) {
        (Some(target), Some(index)) => {
            let (mime, material) = live
                .sink
                .row_chip_mime(target.row_id, &target.entity_id, index, &params.reference)
                .ok_or_else(denied)?;
            // The part may not be committed yet: the chip's authorised ref is read until it is.
            let stored = live
                .sink
                .row_attachment(target.row_id, &target.entity_id, index, &params.reference)
                .and_then(|part| Some((part.source?, part.mime)));
            (mime, material, stored)
        }
        (None, None) => {
            let (mime, material) = live
                .sink
                .attachment_mime(&params.reference)
                .ok_or_else(denied)?;
            (mime, material, None)
        }
        _ => {
            return Err(RpcError::invalid_params(
                "target and attachmentIndex must be provided together",
            ));
        }
    };
    // Node `PROTOCOL_V4_LIMITS`: a video preview may be as large as the video the model takes.
    let limit = if essence(&mime).starts_with("video/") {
        VIDEO_INPUT_MAX_BYTES
    } else {
        MAX_BYTES
    };
    let (bytes, media_type) = match &stored {
        Some((source, part_mime)) if source.starts_with(ARTIFACT_SCHEME) => bounded_data_url(
            stored_artifact_content(server, source, limit).await?,
            part_mime,
            limit,
        )?,
        Some((source, part_mime)) => read_local(Path::new(source), part_mime, limit).await?,
        None => read(server, &session, &params.reference, &mime, limit).await?,
    };
    if !previewable(&media_type, material) {
        return Err(fault("previewUnsupported"));
    }
    if params.offset > bytes.len() {
        return Err(fault("previewRangeInvalid"));
    }
    let end = bytes.len().min(params.offset + params.limit);
    Ok(Reply::new(json!({
        "dataBase64": base64().encode(&bytes[params.offset..end]),
        "mediaType": media_type,
        "totalBytes": bytes.len(),
        "nextOffset": if end < bytes.len() { json!(end) } else { Value::Null },
    })))
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ClientMode {
    DesktopContinuous,
    WebRemoteReplayable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewSourceParams {
    session_id: String,
    #[serde(rename = "ref")]
    reference: String,
    target: Option<crate::attachment_share::RowTarget>,
    attachment_index: Option<usize>,
    client_mode: ClientMode,
}

/// Node `extensionForDerivedMediaContentType` (its video rows): the derived copy's extension.
fn video_extension(mime: &str) -> Option<&'static str> {
    Some(match essence(mime).as_str() {
        "video/mp4" => ".mp4",
        "video/quicktime" => ".mov",
        "video/webm" => ".webm",
        "video/x-matroska" => ".mkv",
        "video/x-m4v" => ".m4v",
        "video/x-msvideo" => ".avi",
        _ => return None,
    })
}

/// Node `derivedMediaAttachmentPath` for a video: `<storageRoot>/cli/video-cache/<session>/video-<hash><ext>`, the hash
/// being the first 32 hex digits of the artifact URI's SHA-256. `None` for a MIME without an extension or a session id
/// that is not a plain path segment.
fn video_cache_path(root: &Path, session: &SessionId, uri: &str, mime: &str) -> Option<PathBuf> {
    let extension = video_extension(mime)?;
    if !crate::fork::session_tree::is_plain_segment(session.as_str()) {
        return None;
    }
    let digest = rust_cli_base::hash::sha256_hex(uri.as_bytes());
    Some(
        root.join("cli")
            .join("video-cache")
            .join(session.as_str())
            .join(format!("video-{}{extension}", &digest[..32])),
    )
}

/// Node `writeDerivedMediaAttachment`: the derived copy is reused when it is a file, else the artifact's video data URL
/// is decoded and written atomically. `None` when the content is not a video data URL or the write fails.
async fn derived_video(
    path: &Path,
    content: impl AsyncFnOnce() -> Option<Vec<u8>>,
    mime: &str,
) -> Option<String> {
    const WRITE: rust_cli_fs::WriteOptions = rust_cli_fs::WriteOptions {
        mode: rust_cli_fs::FileMode::Default,
        temp_name: rust_cli_fs::TempName::Visible,
        parent: rust_cli_fs::ParentDir::Create,
        rename_retry: &[],
    };
    let path_text = path.to_str()?.to_owned();
    if rust_cli_fs::is_file(path).await {
        return Some(path_text);
    }
    let content = content().await?;
    let (bytes, media_type) =
        crate::attachment_share::decode_data_url(&content, mime, VIDEO_INPUT_MAX_BYTES).ok()?;
    if !media_type.starts_with("video/") {
        return None;
    }
    if rust_cli_fs::atomic_write(path, &bytes, WRITE)
        .await
        .is_err()
    {
        // No error text: a storage error names the storage path.
        tracing::warn!(
            event = "attachment.video_cache_failed",
            "writing a video's playback copy failed"
        );
        return None;
    }
    Some(path_text)
}

/// `v4/attachment/previewSource` (Node `attachmentPreviewSource` and `resolvePromptAttachmentPreviewSource`): a desktop
/// video plays from a local file, its artifact's derived copy or, without an artifact, its absolute path; everything
/// else is read in chunks. An artifact-backed part never falls back to its mutable original path.
pub async fn preview_source(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params: PreviewSourceParams = parse(params)?;
    if params.target.is_some() != params.attachment_index.is_some() {
        return Err(RpcError::invalid_params(
            "target and attachmentIndex must be provided together",
        ));
    }
    let session = SessionId::new(&params.session_id);
    let live = server
        .live(&session)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let attachment = match (&params.target, params.attachment_index) {
        (Some(target), Some(index)) => {
            live.sink
                .row_attachment(target.row_id, &target.entity_id, index, &params.reference)
        }
        _ => live.sink.attachment_source(&params.reference),
    }
    .ok_or_else(|| fault("previewRefNotAuthorized"))?;
    let chunked = || Ok(Reply::new(json!({"kind": "chunked"})));
    let media_type = essence(&attachment.mime);
    if params.client_mode != ClientMode::DesktopContinuous || !media_type.starts_with("video/") {
        return chunked();
    }
    let Some(source) = attachment.source else {
        return chunked();
    };
    let path = if source.starts_with(ARTIFACT_SCHEME) {
        match server
            .context
            .storage_root()
            .and_then(|root| video_cache_path(root, &session, &source, &media_type))
        {
            Some(path) => {
                let content = async || {
                    stored_artifact_content(server, &source, VIDEO_INPUT_MAX_BYTES)
                        .await
                        .ok()
                };
                derived_video(&path, content, &media_type).await
            }
            None => None,
        }
    } else if Path::new(&source).is_absolute() {
        Some(source)
    } else {
        None
    };
    match path {
        Some(path) => Ok(Reply::new(
            json!({"kind": "local_path", "path": path, "mediaType": media_type}),
        )),
        None => chunked(),
    }
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;
