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
    AttachedBody, AttachedFile, ContentBlock, ImageSource, Material, MaterialKind,
};
use rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME;
use rust_cli_kernel_api::prompt_attachment::INLINE_IMAGE_MAX_BYTES;
use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactRef, ArtifactStore};
use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

use crate::server::Server;
use crate::uploads::{Began, Begin, CHUNK_MAX_BYTES, Commit, MAX_BYTES, Target};

/// Node `INLINE_TEXT_ATTACHMENT_MAX_BYTES`: larger text files are sent as a metadata-only reminder.
const INLINE_TEXT_MAX_BYTES: u64 = 64 * 1024;

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
    let (owner, id) = rust_cli_kernel_api::prompt_attachment::parse_artifact_uri(reference)
        .ok_or_else(|| fault("refInvalid"))?;
    if &owner != session {
        return Err(fault("previewRefNotAuthorized"));
    }
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
        let (body, stored) = if let Some(kind) = attachment.source_kind
            && is_uri_ref(&attachment.reference)
        {
            let store = artifacts(server).map_err(|_| material_failed())?;
            let content = artifact_content(server, session, &attachment.reference, MAX_BYTES)
                .await
                .map_err(|_| material_failed())?;
            let (body, path) = write_material(store.as_ref(), session, kind, &content).await?;
            (body, Some(path))
        } else {
            let body = body(server, session, &attachment).await;
            let stored = match &body {
                AttachedBody::Image { source } => {
                    stored_image(server, session, &attachment, source).await
                }
                _ => None,
            };
            (body, stored)
        };
        let material = attachment.material();
        out.push(ContentBlock::File {
            file: AttachedFile {
                name: attachment.file_name,
                mime: attachment.mime,
                bytes: attachment.bytes,
                reference: Some(attachment.reference).filter(|reference| !reference.is_empty()),
                preview_reference: attachment.preview_ref,
                stored,
                material,
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
/// model gets the deferred path reference naming that file. Returns the body and the file's path.
async fn write_material(
    store: &dyn ArtifactStore,
    session: &SessionId,
    kind: MaterialKind,
    content: &[u8],
) -> Result<(AttachedBody, String), RpcError> {
    use rust_cli_kernel_api::prompt_attachment::{PathReason, path_reference};
    let text = material_text(content).ok_or_else(material_failed)?;
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
    Ok((body, path))
}

/// The session artifact holding an inline image's data URL (Node `persistAttachmentDataUrl`): a web-remote ref already
/// is one (`read` checked it belongs to this session) and is reused; a desktop image is written now. `None` when the
/// write fails: the part then keeps the inline data URL, which both runtimes still read.
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
                "storing an attached image failed; it stays inline"
            );
            None
        }
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
        (declared_bytes <= INLINE_IMAGE_MAX_BYTES as u64).then_some(Inline::Image)
    } else if kind.starts_with("video/") || kind == "application/pdf" {
        None
    } else {
        (declared_bytes <= INLINE_TEXT_MAX_BYTES).then_some(Inline::Text)
    }
}

impl Inline {
    fn limit(self) -> u64 {
        match self {
            Inline::Image => INLINE_IMAGE_MAX_BYTES as u64,
            Inline::Text => INLINE_TEXT_MAX_BYTES,
        }
    }
}

/// The inline part of bytes that were read. Their real length is checked against the form's limit, because the declared
/// size is the client's word. Over the limit, or text that is not UTF-8 or holds a NUL, is metadata only.
fn admit(form: Inline, mime: &str, bytes: Vec<u8>) -> AttachedBody {
    if bytes.len() as u64 > form.limit() {
        return AttachedBody::Omitted;
    }
    match form {
        Inline::Image => AttachedBody::Image {
            source: ImageSource::Base64 {
                media_type: essence(mime),
                data: base64().encode(&bytes),
            },
        },
        Inline::Text => match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => AttachedBody::Text { text },
            _ => AttachedBody::Omitted,
        },
    }
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
        if attachment.bytes <= INLINE_IMAGE_MAX_BYTES as u64 {
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

/// What of one attachment reaches the model (the stored file part keeps it for both runtimes).
async fn body(server: &Server, session: &SessionId, attachment: &AttachmentRef) -> AttachedBody {
    if let Some(reference) = path_reference(attachment).await {
        return reference;
    }
    let Some(form) = inline_form(&attachment.mime, attachment.bytes) else {
        return AttachedBody::Omitted;
    };
    // The read is bounded by the form's limit, so a file that grew past its declared size is refused, not loaded.
    let (bytes, mime) = match read(
        server,
        session,
        &attachment.reference,
        &attachment.mime,
        form.limit(),
    )
    .await
    {
        Ok(read) => read,
        Err(error) => {
            // The fault code only: a local ref is a user path.
            tracing::warn!(event = "attachment.read_failed", mime = %attachment.mime, fault = %error.message, "an attachment could not be read");
            return AttachedBody::Omitted;
        }
    };
    admit(form, &mime, bytes)
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
    let (mime, material) = live
        .sink
        .attachment_mime(&params.reference)
        .ok_or_else(|| fault("previewRefNotAuthorized"))?;
    let (bytes, media_type) = read(server, &session, &params.reference, &mime, MAX_BYTES).await?;
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

/// `v4/attachment/previewSource`: the fork serves every preview in chunks.
pub async fn preview_source(_server: &Server, _params: &Value) -> Result<Reply, RpcError> {
    Ok(Reply::new(json!({"kind": "chunked"})))
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;
