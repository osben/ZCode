//! Fork: Share's attachment reads, `v4/conversation/attachmentRead` and `v4/conversation/attachmentStat`, ported from
//! Node's `conversationAttachmentRead` / `conversationAttachmentStat` (`v4-gateway.ts`) and the session app's
//! `readPromptAttachment` / `statPromptAttachment` (`create-app.ts`); specs/fork-agent-runtime-selection.md,
//! "Attachments in Rust mode".
//!
//! Authorisation is the `userInput` row: the target row must carry the ref at `attachmentIndex` (as `ref` or
//! `previewRef`). The read then opens what the row's stored `file` part holds: its session artifact when it has one
//! (immutable), else the local path. The Host refuses an untrusted connection before the call reaches the agent.

use rust_cli_fs::BoundedRead;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME;
use rust_cli_kernel_api::prompt_attachment::parse_artifact_uri;
use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

use crate::attachments::{artifacts, base64, encoded_cap, fault, parse};
use crate::projection::AttachmentSource;
use crate::server::Server;
use crate::uploads::CHUNK_MAX_BYTES;
use base64::Engine;

/// `PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes` (`VIDEO_INPUT_MAX_BYTES`): the largest attachment Share reads.
pub(crate) const PREVIEW_MAX_BYTES: u64 = 30 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentStatMaxBytes`: the largest size a stat may report.
const STAT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RowTarget {
    row_id: u64,
    entity_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadParams {
    session_id: String,
    #[serde(rename = "ref")]
    reference: String,
    target: RowTarget,
    attachment_index: usize,
    offset: usize,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatParams {
    session_id: String,
    #[serde(rename = "ref")]
    reference: String,
    target: RowTarget,
    attachment_index: usize,
}

/// The stored source of the attachment the row authorises, or `denied`.
async fn authorised(
    server: &Server,
    session: &SessionId,
    reference: &str,
    target: &RowTarget,
    index: usize,
    denied: &str,
) -> Result<AttachmentSource, RpcError> {
    if session.as_str().is_empty() || reference.is_empty() || target.entity_id.is_empty() {
        return Err(RpcError::invalid_params(
            "sessionId, ref and target are required",
        ));
    }
    let live = server
        .live(session)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    live.sink
        .row_attachment(target.row_id, &target.entity_id, index, reference)
        .ok_or_else(|| fault(denied))
}

fn essence(mime: &str) -> String {
    mime.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Node `decodePromptAttachmentDataUrl`: an artifact's `data:<mime>;base64,<payload>` content → its bytes and media type.
/// The payload must be strict base64; only media (or text the part also calls `text/plain`) is served.
pub(crate) fn decode_data_url(
    content: &[u8],
    fallback_mime: &str,
    max: u64,
) -> Result<(Vec<u8>, String), RpcError> {
    let invalid = || fault("previewArtifactInvalid");
    let text = std::str::from_utf8(content).map_err(|_| invalid())?;
    let comma = text.find(',').ok_or_else(invalid)?;
    if !text
        .get(..5)
        .is_some_and(|head| head.eq_ignore_ascii_case("data:"))
    {
        return Err(invalid());
    }
    let mut parts = text[5..comma].split(';');
    let first = parts.next().map(str::trim).unwrap_or_default();
    let media_type = essence(if first.is_empty() {
        fallback_mime
    } else {
        first
    });
    let payload = &text[comma + 1..];
    let base64_marked = parts
        .next_back()
        .is_some_and(|last| last.trim().eq_ignore_ascii_case("base64"));
    let body = payload.trim_end_matches('=');
    if !base64_marked
        || payload.len() - body.len() > 2
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
        || payload.len() % 4 != 0
    {
        return Err(invalid());
    }
    let media = media_type.starts_with("image/")
        || media_type.starts_with("video/")
        || media_type == "application/pdf"
        || (media_type == "text/plain" && essence(fallback_mime) == "text/plain");
    if !media {
        return Err(fault("previewNotMedia"));
    }
    let bytes = base64().decode(payload).map_err(|_| invalid())?;
    if bytes.len() as u64 > max {
        return Err(fault("previewTooLarge"));
    }
    Ok((bytes, media_type))
}

/// The bytes of an attachment source (Node `readPromptAttachment` with Share's limit). Missing → `shareStatNotFound`,
/// the one classification Share skips on.
async fn read_source(
    server: &Server,
    reference: &str,
    mime: &str,
    max: u64,
) -> Result<(Vec<u8>, String), RpcError> {
    if reference.starts_with(ARTIFACT_SCHEME) {
        let (owner, id) = parse_artifact_uri(reference).ok_or_else(|| fault("refInvalid"))?;
        let store = artifacts(server)?;
        // Store errors can name storage paths, so only the fault code leaves this function.
        let artifact = store
            .find(&owner, &id)
            .await
            .map_err(|_| fault("storeFailed"))?
            .ok_or_else(|| fault("shareStatNotFound"))?;
        if artifact.size > encoded_cap(max) {
            return Err(fault("previewTooLarge"));
        }
        let content = store
            .get(&artifact)
            .await
            .map_err(|_| fault("storeFailed"))?;
        return decode_data_url(&content, mime, max);
    }
    let path = Path::new(reference);
    if !path.is_absolute() {
        return Err(fault("refInvalid"));
    }
    match rust_cli_fs::read_regular_bounded(path, max)
        .await
        .map_err(|_| fault("readFailed"))?
    {
        BoundedRead::Bytes(bytes) => Ok((bytes, mime.to_owned())),
        BoundedRead::Missing | BoundedRead::NotRegular => Err(fault("shareStatNotFound")),
        // Node's file port answers `too_large`, which is no attachment fault: Share defers the attachment.
        BoundedRead::TooLarge => Err(fault("readFailed")),
    }
}

/// `v4/conversation/attachmentRead`: one chunk of an attachment of a `userInput` row, any MIME, up to 30 MiB.
pub async fn read(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params: ReadParams = parse(params)?;
    if params.limit == 0 || params.limit > CHUNK_MAX_BYTES {
        return Err(RpcError::invalid_params("limit out of range"));
    }
    let session = SessionId::new(&params.session_id);
    let source = authorised(
        server,
        &session,
        &params.reference,
        &params.target,
        params.attachment_index,
        "shareReadNotAuthorized",
    )
    .await?;
    let reference = source.source.as_deref().unwrap_or(&params.reference);
    let (bytes, media_type) =
        read_source(server, reference, &source.mime, PREVIEW_MAX_BYTES).await?;
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

/// `v4/conversation/attachmentStat`: the size Share checks before publishing. An artifact reports the stored object
/// (Node `statToolResultArtifact`: its size and content type), a local file its own size and mtime.
pub async fn stat(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params: StatParams = parse(params)?;
    let session = SessionId::new(&params.session_id);
    let source = authorised(
        server,
        &session,
        &params.reference,
        &params.target,
        params.attachment_index,
        "shareStatNotAuthorized",
    )
    .await?;
    let reference = source.source.as_deref().unwrap_or(&params.reference);
    let out = if reference.starts_with(ARTIFACT_SCHEME) {
        let (owner, id) = parse_artifact_uri(reference).ok_or_else(|| fault("refInvalid"))?;
        let artifact = artifacts(server)?
            .find(&owner, &id)
            .await
            .map_err(|_| fault("storeFailed"))?
            .ok_or_else(|| fault("shareStatNotFound"))?;
        let media_type = if artifact.media_type.is_empty() {
            source.mime.clone()
        } else {
            artifact.media_type
        };
        json!({"totalBytes": artifact.size, "mediaType": media_type})
    } else {
        let path = Path::new(reference);
        if !path.is_absolute() {
            return Err(fault("refInvalid"));
        }
        let found = rust_cli_fs::stat(path)
            .await
            .map_err(|_| fault("readFailed"))?
            .ok_or_else(|| fault("shareStatNotFound"))?;
        if !found.is_file {
            return Err(fault("statNotFile"));
        }
        let mut out = json!({"totalBytes": found.len, "mediaType": source.mime});
        if let Some(modified) = found.modified_ms {
            out["mtimeMs"] = json!(modified);
        }
        out
    };
    if out["totalBytes"].as_u64().unwrap_or(0) > STAT_MAX_BYTES {
        return Err(fault("shareStatTooLarge"));
    }
    Ok(Reply::new(out))
}

#[cfg(test)]
#[path = "attachment_share_tests.rs"]
mod tests;
