//! Fork: an App file attachment of a user message ↔ Node's `file` part (`persistUserPrompt` of a resolved
//! `TurnAttachment`). The part is the one owner of the attachment: Node and this runtime both rebuild the model's
//! reminders and the App's chips from it, so a session reopened in either runtime keeps the file.
//!
//! The shapes follow Node `resolveLocalFileAttachment` (inline text: `mime: text/plain`, `source.text`,
//! `metadata.preview`, `storageKind: inline`, `recoverability: provider_ready`, which Node's
//! `shouldAddReadLikePromptAttachmentReminder` requires), the image branch of `persistAttachmentDataUrl` (`url` is the session artifact, or the data URL when none was
//! stored) and
//! `resolvedPlaceholderAttachment` (`recoverability: metadata_only`) and `resolvedPathReferenceAttachment`
//! (`storageKind: local_ref`, `metadata.pathReferenceText`). The App's ref is kept as `metadata.originalUrl`.

use rust_cli_kernel_api::message::{AttachedBody, AttachedFile, ImageSource, ToolResultContent};
use rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME;
use serde_json::{Value, json};

/// The MIME Node stores for an inline text attachment.
const TEXT_MIME: &str = "text/plain";

/// [`AttachedFile`] → Node `file` part.
pub fn part(id: String, (session, message): (&str, &str), file: &AttachedFile) -> Value {
    let mut out = json!({"id": id, "messageID": message, "sessionID": session, "type": "file"});
    let reference = file.reference.as_deref();
    let mut metadata = json!({});
    if let Some(reference) = reference {
        metadata["originalUrl"] = json!(reference);
    }
    // Fork key; Node ignores it.
    if let Some(preview) = &file.preview_reference {
        metadata["previewRef"] = json!(preview);
    }
    match &file.body {
        AttachedBody::Text { text } => {
            out["mime"] = json!(TEXT_MIME);
            out["filename"] = json!(file.name);
            out["url"] = json!(reference.unwrap_or(&file.name));
            out["source"] = json!({"type": "file", "path": reference.unwrap_or(&file.name),
                "text": {"value": file.name, "start": 0, "end": file.name.encode_utf16().count()}});
            metadata["preview"] = json!({"text": text, "truncated": false,
                "originalBytes": text.len(), "startLine": 1, "totalLines": text.split('\n').count()});
            metadata["recoverability"] = json!("provider_ready");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!("inline");
        }
        // Node's artifact shape (`persistAttachmentDataUrl`): Node builds the chip's ref from a `url` that is not a data
        // URL and reads the image or video back from `metadata.artifactUri`.
        AttachedBody::Image { source } | AttachedBody::Video { source }
            if file.stored.is_some() =>
        {
            let stored = file.stored.as_deref().unwrap_or_default();
            let media_type = match source {
                ImageSource::Base64 { media_type, .. }
                | ImageSource::Artifact { media_type, .. } => media_type.as_str(),
            };
            out["mime"] = json!(media_type);
            out["filename"] = json!(file.name);
            out["url"] = json!(stored);
            metadata["artifactUri"] = json!(stored);
            metadata["recoverability"] = json!("provider_ready");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!("artifact");
        }
        AttachedBody::Image { source } | AttachedBody::Video { source } => {
            let (media_type, url) = match source {
                ImageSource::Base64 { media_type, data } => (
                    media_type.as_str(),
                    format!("data:{media_type};base64,{data}"),
                ),
                // Attachments are read inline when the input is accepted; an artifact image is never built here.
                ImageSource::Artifact { media_type, .. } => (
                    media_type.as_str(),
                    reference.unwrap_or_default().to_owned(),
                ),
            };
            out["mime"] = json!(media_type);
            out["filename"] = json!(file.name);
            out["url"] = json!(url);
            metadata["recoverability"] = json!("provider_ready");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!("inline");
        }
        // Node `resolvedPathReferenceAttachment`: the note is the part's `pathReferenceText`.
        // Text material written by this runtime names the stored file, which Node also keeps as `originalUrl`.
        AttachedBody::PathReference { text } => {
            use rust_cli_kernel_api::prompt_attachment::{mime_of_path, path_reference_mime};
            let path = file.stored.as_deref().or(reference).unwrap_or(&file.name);
            metadata["originalUrl"] = json!(path);
            out["mime"] = json!(path_reference_mime(text).unwrap_or_else(|| mime_of_path(path)));
            out["filename"] = json!(file.name);
            out["url"] = json!(path);
            out["source"] = json!({"type": "file", "path": path,
                "text": {"value": path, "start": 0, "end": path.encode_utf16().count()}});
            metadata["pathReferenceText"] = json!(text);
            metadata["recoverability"] = json!("metadata_only");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!("local_ref");
        }
        AttachedBody::Omitted => {
            out["mime"] = json!(file.mime);
            out["filename"] = json!(file.name);
            out["url"] = json!(reference.unwrap_or(&file.name));
            metadata["recoverability"] = json!("metadata_only");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!(if reference.is_some() {
                "local_ref"
            } else {
                "metadata_only"
            });
        }
    }
    out["metadata"] = metadata;
    out
}

/// A user message's `file` part that is an App attachment (it has a `filename`; a TUI image has none) → [`AttachedFile`].
/// An artifact-backed image comes back with [`AttachedBody::Omitted`] and [`AttachedFile::stored`] set: reading the
/// artifact is file IO, which the store does after the database read (node-store `load`).
pub fn from_part(part: &Value) -> Option<AttachedFile> {
    let name = part["filename"].as_str()?.to_owned();
    let mime = part["mime"].as_str().unwrap_or_default().to_owned();
    let metadata = &part["metadata"];
    let url = part["url"].as_str().unwrap_or_default();
    let reference = metadata["originalUrl"]
        .as_str()
        .or((!url.is_empty() && !url.starts_with("data:")).then_some(url))
        .map(str::to_owned);
    let recoverable = matches!(
        metadata["recoverability"].as_str(),
        Some("provider_ready" | "preview_only")
    );
    let preview = metadata["preview"]["text"].as_str();
    let path_reference = metadata["pathReferenceText"]
        .as_str()
        .filter(|_| metadata["storageKind"] == "local_ref");
    let body = if let Some(text) = path_reference {
        AttachedBody::PathReference {
            text: text.to_owned(),
        }
    } else {
        match preview {
            Some(text) if recoverable && mime.starts_with("text/") => AttachedBody::Text {
                text: text.to_owned(),
            },
            _ if recoverable && mime.starts_with("video/") => {
                match rust_cli_kernel_api::prompt_attachment::video_of_data_url(url) {
                    Some(source) => AttachedBody::Video { source },
                    None => AttachedBody::Omitted,
                }
            }
            _ if recoverable && mime.starts_with("image/") => {
                match crate::tool_content::from_file_part(part) {
                    ToolResultContent::Image { source } => AttachedBody::Image { source },
                    _ => AttachedBody::Omitted,
                }
            }
            _ => AttachedBody::Omitted,
        }
    };
    // An image or video whose bytes live in a session artifact (both runtimes write Node's shape); the store reads it
    // back.
    let stored = metadata["artifactUri"]
        .as_str()
        .or(Some(url))
        .filter(|uri| {
            (mime.starts_with("image/") || mime.starts_with("video/"))
                && uri.starts_with(ARTIFACT_SCHEME)
        })
        .map(str::to_owned);
    let bytes = metadata["sizeBytes"]
        .as_u64()
        .or_else(|| preview.map(|text| text.len() as u64))
        .unwrap_or(0);
    Some(AttachedFile {
        name,
        mime,
        bytes,
        reference,
        preview_reference: metadata["previewRef"].as_str().map(str::to_owned),
        stored,
        material: None,
        body,
    })
}

#[cfg(test)]
#[path = "attached_file_tests.rs"]
mod tests;
