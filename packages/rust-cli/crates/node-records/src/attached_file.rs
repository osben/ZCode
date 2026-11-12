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

use rust_cli_kernel_api::message::{
    AttachedBody, AttachedFile, ImageInfo, ImageSource, TextRead, ToolResultContent,
};
use rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME;
use serde_json::{Value, json};

/// The MIME Node stores for an inline text attachment.
const TEXT_MIME: &str = "text/plain";

/// Node's `errorCode` of a text file that could not be read; the model gets nothing for it.
const READ_FAILED: &str = "attachment_read_failed";

/// Node `safeAttachmentOriginalRef` of an inline data URL: a marker, not a ref the App can open.
const INLINE_DATA_URL: &str = "inline:data-url";

/// Node `metadata.image` ([`ImageInfo`]).
fn image_metadata(image: &ImageInfo) -> Value {
    let mut out = json!({"maxDimension": image.max_dimension, "resized": image.resized,
        "transformedSizeBytes": image.transformed_size_bytes});
    for (key, value) in [
        ("width", image.width),
        ("height", image.height),
        ("originalWidth", image.original_width),
        ("originalHeight", image.original_height),
    ] {
        if let Some(value) = value {
            out[key] = json!(value);
        }
    }
    out
}

fn image_info(metadata: &Value) -> Option<Box<ImageInfo>> {
    let image = metadata.get("image").filter(|image| image.is_object())?;
    let dimension = |key: &str| {
        image[key]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
    };
    Some(Box::new(ImageInfo {
        width: dimension("width"),
        height: dimension("height"),
        original_width: dimension("originalWidth"),
        original_height: dimension("originalHeight"),
        max_dimension: dimension("maxDimension").unwrap_or_default(),
        resized: image["resized"].as_bool().unwrap_or(false),
        transformed_size_bytes: image["transformedSizeBytes"].as_u64().unwrap_or_default(),
    }))
}

/// Node `FilePartSource` of a local file: `text.value` is what the reminders name.
fn source(path: &str, value: &str) -> Value {
    json!({"type": "file", "path": path,
        "text": {"value": value, "start": 0, "end": value.encode_utf16().count()}})
}

/// The view of a stored text part (Node `metadata.preview` and `source.text.value`). `None` when it is the view a
/// web-remote text part has (named by the file name, all of it from line 1), so such a part reads back unchanged.
fn text_read(part: &Value, name: &str, text: &str) -> Option<Box<TextRead>> {
    let preview = &part["metadata"]["preview"];
    let path = part["source"]["text"]["value"].as_str().unwrap_or(name);
    let read = TextRead {
        path: path.to_owned(),
        start_line: preview["startLine"].as_u64().unwrap_or(1),
        total_lines: preview["totalLines"]
            .as_u64()
            .unwrap_or_else(|| text.split('\n').count() as u64),
        original_bytes: preview["originalBytes"]
            .as_u64()
            .unwrap_or(text.len() as u64),
        truncated: preview["truncated"].as_bool().unwrap_or(false),
        truncated_by_token_cap: preview["truncatedByTokenCap"].as_bool().unwrap_or(false),
        notice: preview["partialViewNotice"].as_str().map(str::to_owned),
    };
    let plain =
        read.path == name && read.start_line == 1 && !read.truncated && read.notice.is_none();
    (!plain).then(|| Box::new(read))
}

/// [`AttachedFile`] → Node `file` part.
pub fn part(id: String, (session, message): (&str, &str), file: &AttachedFile) -> Value {
    let mut out = json!({"id": id, "messageID": message, "sessionID": session, "type": "file"});
    let reference = file.reference.as_deref();
    // An unnamed part's chip name is not a ref: Node would read it back as one (`attachmentMetasOfMessage`).
    let unnamed_url = match file.unnamed {
        true => "",
        false => file.name.as_str(),
    };
    let mut metadata = json!({});
    if let Some(reference) = reference {
        metadata["originalUrl"] = json!(reference);
    }
    // Fork key; Node ignores it.
    if let Some(preview) = &file.preview_reference {
        metadata["previewRef"] = json!(preview);
    }
    match &file.body {
        AttachedBody::Text { text, read: None } => {
            out["mime"] = json!(TEXT_MIME);
            out["filename"] = json!(file.name);
            out["url"] = json!(reference.unwrap_or(&file.name));
            out["source"] = source(reference.unwrap_or(&file.name), &file.name);
            metadata["preview"] = json!({"text": text, "truncated": false,
                "originalBytes": text.len(), "startLine": 1, "totalLines": text.split('\n').count()});
            metadata["recoverability"] = json!("provider_ready");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!("inline");
        }
        // Node `resolveLocalFileAttachment`: the submitted path is the part's `url`, `source` and the Read label.
        AttachedBody::Text {
            text,
            read: Some(read),
        } => {
            out["mime"] = json!(TEXT_MIME);
            out["filename"] = json!(file.name);
            out["url"] = json!(read.path);
            out["source"] = source(&read.path, &read.path);
            let mut preview = json!({"text": text, "truncated": read.truncated,
                "originalBytes": read.original_bytes, "startLine": read.start_line, "totalLines": read.total_lines});
            if read.truncated_by_token_cap {
                preview["truncatedByTokenCap"] = json!(true);
            }
            if let Some(notice) = &read.notice {
                preview["partialViewNotice"] = json!(notice);
            }
            metadata["preview"] = preview;
            metadata["recoverability"] = json!(if read.truncated {
                "preview_only"
            } else {
                "provider_ready"
            });
            metadata["sizeBytes"] = json!(read.original_bytes);
            metadata["storageKind"] = json!("inline");
        }
        // Node `resolvedPlaceholderAttachment(…, "attachment_read_failed")` of a local text file.
        AttachedBody::ReadFailed => {
            let path = reference.unwrap_or(&file.name);
            out["mime"] = json!(TEXT_MIME);
            out["filename"] = json!(file.name);
            out["url"] = json!(path);
            out["source"] = source(path, path);
            metadata["errorCode"] = json!(READ_FAILED);
            metadata["recoverability"] = json!("metadata_only");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!("local_ref");
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
        // Node `resolvedPlaceholderAttachment`: the App's MIME, the path the App sent. `storageKind` and `originalUrl`
        // follow that path only (`attachment.path ? "local_ref" : "metadata_only"`); without one, `originalUrl` is Node
        // `safeAttachmentOriginalRef` of the content behind the stored `url` (`inline:data-url` for an inline data URL,
        // which `inline:pdf` and a video's `inline:data-url` stand for). An unnamed part is Node's, written without
        // `source`; its `sizeBytes` is written when Node gave one (a PDF's or video's parsed size).
        AttachedBody::Placeholder { code, url, .. } => {
            use rust_cli_kernel_api::prompt_attachment::submitted_path;
            let path = reference.and_then(submitted_path);
            let stored_url = url.as_deref().or(reference).unwrap_or(unnamed_url);
            out["mime"] = json!(file.mime);
            out["filename"] = json!(file.name);
            out["url"] = json!(stored_url);
            let original = match path {
                Some(path) => Some(path),
                None if stored_url.starts_with("data:") || stored_url.starts_with("inline:") => {
                    Some(INLINE_DATA_URL)
                }
                None => reference,
            };
            // `None` only without a reference, so nothing was written above.
            if let Some(original) = original {
                metadata["originalUrl"] = json!(original);
            }
            if let Some(path) = path.filter(|_| !file.unnamed) {
                out["source"] = source(path, path);
            }
            metadata["errorCode"] = json!(code);
            metadata["recoverability"] = json!("metadata_only");
            if !file.unnamed || file.bytes > 0 {
                metadata["sizeBytes"] = json!(file.bytes);
            }
            metadata["storageKind"] = json!(match path {
                Some(_) => "local_ref",
                None => "metadata_only",
            });
        }
        AttachedBody::Omitted => {
            out["mime"] = json!(file.mime);
            out["filename"] = json!(file.name);
            out["url"] = json!(reference.unwrap_or(unnamed_url));
            metadata["recoverability"] = json!("metadata_only");
            metadata["sizeBytes"] = json!(file.bytes);
            metadata["storageKind"] = json!(if reference.is_some() {
                "local_ref"
            } else {
                "metadata_only"
            });
        }
    }
    if let Some(image) = &file.image {
        metadata["image"] = image_metadata(image);
    }
    if file.unnamed
        && let Some(out) = out.as_object_mut()
    {
        out.remove("filename");
    }
    out["metadata"] = metadata;
    out
}

/// A user message's `file` part that is an App attachment → [`AttachedFile`]; `index` is its place among the message's
/// file parts. An artifact-backed image comes back with [`AttachedBody::Omitted`] and [`AttachedFile::stored`] set:
/// reading the artifact is file IO, which the store does after the database read (node-store `load`).
pub fn from_part(part: &Value, index: usize) -> Option<AttachedFile> {
    let mime = part["mime"].as_str().unwrap_or_default().to_owned();
    let metadata = &part["metadata"];
    let url = part["url"].as_str().unwrap_or_default();
    // Node `resolvedPlaceholderAttachment` (a path reference has no `errorCode`).
    let placeholder = metadata["errorCode"]
        .as_str()
        .filter(|_| metadata["recoverability"] == "metadata_only");
    let name = match part["filename"].as_str() {
        Some(name) => name.to_owned(),
        // Node's web-remote image and video parts carry no `filename`; a Rust TUI image has none either, and is the
        // one Node never writes: inline without `sizeBytes`, or an artifact with `metadata.rustCli`. Node's placeholder
        // written without options (any error code and MIME) has no `sizeBytes` either.
        None if metadata[crate::records::RUST_CLI].is_null()
            && (metadata["sizeBytes"].is_u64() || placeholder.is_some()) =>
        {
            // Node `attachmentMetasOfMessage`: `filename ?? (basenameFromUrl || attachment-${index + 1})`.
            let basename = match url.starts_with("data:") {
                true => "",
                false => url.rsplit(['/', '\\']).next().unwrap_or_default(),
            };
            if basename.is_empty() {
                format!("attachment-{}", index + 1)
            } else {
                basename.to_owned()
            }
        }
        None => return None,
    };
    let reference = metadata["originalUrl"]
        .as_str()
        .filter(|original| *original != INLINE_DATA_URL)
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
    // Node skips a failed text read only when it has a source; a source-less one goes as an inline-text reminder.
    let failed = metadata["errorCode"] == READ_FAILED
        && mime.starts_with("text/")
        && part["source"].is_object();
    let unnamed = part["filename"].as_str().is_none();
    let body = if failed {
        AttachedBody::ReadFailed
    } else if let Some(code) = placeholder {
        // Node's live line names `path ?? attachment-<n>`; a path is the part's `originalUrl` (`storageKind: local_ref`).
        let path = metadata["originalUrl"]
            .as_str()
            .filter(|_| metadata["storageKind"] == "local_ref");
        AttachedBody::Placeholder {
            code: code.into(),
            label: unnamed.then(|| {
                path.map_or_else(|| format!("attachment-{}", index + 1).into(), Box::from)
            }),
            url: url.starts_with("data:").then(|| Box::from(url)),
        }
    } else if let Some(text) = path_reference {
        AttachedBody::PathReference {
            text: text.to_owned(),
        }
    } else {
        match preview {
            Some(text) if recoverable && mime.starts_with("text/") => AttachedBody::Text {
                text: text.to_owned(),
                read: text_read(part, &name, text),
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
                // A failed image's `url` is the App's ref: nothing of it is loaded.
                && !matches!(body, AttachedBody::Placeholder { .. })
        })
        .map(Box::from);
    let bytes = metadata["sizeBytes"]
        .as_u64()
        .or_else(|| preview.map(|text| text.len() as u64))
        .unwrap_or(0);
    Some(AttachedFile {
        name,
        mime,
        bytes,
        reference,
        preview_reference: metadata["previewRef"].as_str().map(Box::from),
        stored,
        material: None,
        image: image_info(metadata),
        unnamed,
        body,
    })
}

#[cfg(test)]
#[path = "attached_file_tests.rs"]
mod tests;
