//! Execution side of artifact publishing (Node `workflow-artifact-publish.ts`, `executeArtifactPublish`).
//!
//! A user-facing artifact is bytes the script delivers through `artifact.file` or `artifact.markdown`. This module turns
//! one publish request into a byte copy in the artifact store and returns the version record. It never touches a
//! session or the journal; the engine writes the record.
//!
//! Order: shape, then store, then I/O. Rejections are `WorkflowError`s with Node's codes and messages, and an
//! over-limit input is rejected, never truncated.

// WorkflowError is the engine's error type (Node WorkflowError): its Err path is cold, and boxing it would split the type.
#![allow(clippy::result_large_err)]

use crate::engine_artifacts::ArtifactPublishRequest;
use crate::error::{ErrorCode, WorkflowError};
use crate::world_read::{describe_arg, resolve_within_workspace, to_workspace_relative};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Node `ARTIFACT_CAPS` and `ARTIFACT_ID_PATTERN`.
pub mod caps {
    pub const MAX_ID_LENGTH: usize = 64;
    pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
    pub const MAX_MARKDOWN_BYTES: usize = 256 * 1024;
    pub const MAX_TITLE_LENGTH: usize = 120;
    pub const MAX_DESCRIPTION_LENGTH: usize = 500;
}

/// The owning tool name recorded with every artifact (Node `ARTIFACT_TOOL_NAME`).
pub const ARTIFACT_TOOL_NAME: &str = "CreateWorkflow";

/// A filesystem fault, as the host reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsFault {
    NotFound,
    IsDirectory,
    NotFile,
    /// The file is over the `max_bytes` asked for. The port never returns a truncated read.
    TooLarge,
    Other(String),
}

/// Bytes and real paths from the host. Blocking; runs on a worker thread.
pub trait ArtifactFsPort: Send + Sync {
    /// The bytes of a regular file, or `TooLarge` when it has more than `max_bytes`.
    fn read_file(&self, path: &Path, max_bytes: usize) -> Result<Vec<u8>, FsFault>;
    /// The real path of an existing path, following symlinks.
    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault>;
}

/// The content of one store write.
#[derive(Debug, Clone, Copy)]
pub enum StoreContent<'a> {
    Text(&'a str),
    Binary(&'a [u8]),
}

/// One write to the tool-artifact store (Node `writeToolResultArtifact` / `writeToolResultBinaryArtifact`).
#[derive(Debug, Clone, Copy)]
pub struct StoreWrite<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub retention: &'a str,
    pub content: StoreContent<'a>,
    pub content_type: &'a str,
    pub extension: Option<&'a str>,
}

/// The store's receipt: the bytes it actually wrote and the URI to read them back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreReceipt {
    pub bytes: usize,
    pub uri: String,
}

/// The artifact store. A store without binary writes can publish markdown only.
pub trait ArtifactStorePort: Send + Sync {
    fn supports_binary(&self) -> bool;
    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String>;
}

/// The host's side of a publish: the store (optional), the parent session the store writes under, and the workspace
/// root. `now_ms` is the publication time; the engine has no clock, so the host supplies it.
pub struct PublishDeps<'a> {
    pub fs: &'a dyn ArtifactFsPort,
    pub store: Option<&'a dyn ArtifactStorePort>,
    pub parent_session_id: Option<&'a str>,
    pub cwd: &'a Path,
    pub now_ms: u64,
}

/// Node `executeArtifactPublish`: the version record the engine journals.
pub fn execute_artifact_publish(
    deps: &PublishDeps<'_>,
    request: &ArtifactPublishRequest,
) -> Result<Value, WorkflowError> {
    assert_artifact_id(request)?;
    let opts = publish_options(request)?;
    let (store, session) = require_store(deps, request)?;
    let payload = if request.op == "file" {
        read_file_payload(deps, request, &opts)?
    } else {
        markdown_payload(request)?
    };
    let receipt = write_payload(store, session, request, &payload)?;

    let mut record = Map::new();
    record.insert("id".into(), Value::String(request.id.clone()));
    record.insert("kind".into(), Value::String(request.op.clone()));
    record.insert("version".into(), Value::from(request.version));
    if let Some(title) = &opts.title {
        record.insert("title".into(), Value::String(title.clone()));
    }
    if let Some(description) = &opts.description {
        record.insert("description".into(), Value::String(description.clone()));
    }
    // The locally computed type, not the store's: the viewer dispatches on this exact string.
    record.insert(
        "contentType".into(),
        Value::String(payload.content_type().to_owned()),
    );
    record.insert("bytes".into(), Value::from(receipt.bytes));
    record.insert("uri".into(), Value::String(receipt.uri));
    if let Payload::Binary { source_path, .. } = &payload {
        record.insert("sourcePath".into(), Value::String(source_path.clone()));
    }
    record.insert("publishedAt".into(), Value::from(deps.now_ms));
    Ok(Value::Object(record))
}

fn driver_error(message: impl Into<String>) -> WorkflowError {
    WorkflowError::new(ErrorCode::DriverError, message)
}

fn coded(code: ErrorCode, message: impl Into<String>) -> WorkflowError {
    WorkflowError::new(code, message)
}

/// The id is used as the store's tool-call id and in the persisted filename, so it is checked again here. A bad id is
/// a wiring error (the compiler should have caught it), hence `DriverError`.
fn assert_artifact_id(request: &ArtifactPublishRequest) -> Result<(), WorkflowError> {
    let id = &request.id;
    let valid = !id.is_empty()
        && id.len() <= caps::MAX_ID_LENGTH
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if valid {
        return Ok(());
    }
    Err(driver_error(format!(
        "artifact.{}: id '{id}' is not a valid artifact id. Use at most {} characters from [A-Za-z0-9_.-].",
        request.op,
        caps::MAX_ID_LENGTH
    )))
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PublishOptions {
    title: Option<String>,
    description: Option<String>,
    content_type: Option<String>,
}

/// Node `artifactPublishOptions`: absent is fine; present must be an object. Unknown keys are ignored (the compiler
/// rejects them).
fn publish_options(request: &ArtifactPublishRequest) -> Result<PublishOptions, WorkflowError> {
    let Some(raw) = &request.opts else {
        return Ok(PublishOptions::default());
    };
    let Value::Object(bag) = raw else {
        return Err(driver_error(format!(
            "artifact.{}: opts must be an options object, got {}. Pass an object or omit the argument.",
            request.op,
            describe_arg(Some(raw))
        )));
    };
    let title = optional_text(request, "title", bag.get("title"), caps::MAX_TITLE_LENGTH)?;
    let description = optional_text(
        request,
        "description",
        bag.get("description"),
        caps::MAX_DESCRIPTION_LENGTH,
    )?;
    let content_type = if request.op == "file" {
        optional_content_type(bag.get("contentType"))?
    } else {
        None
    };
    Ok(PublishOptions {
        title,
        description,
        content_type,
    })
}

/// A bounded text option. The length is in UTF-16 code units, as in Node. An over-long value is rejected, not cut.
fn optional_text(
    request: &ArtifactPublishRequest,
    name: &str,
    value: Option<&Value>,
    max: usize,
) -> Result<Option<String>, WorkflowError> {
    let value = match value {
        None => return Ok(None),
        Some(value) => value,
    };
    let Value::String(text) = value else {
        return Err(driver_error(format!(
            "artifact.{}: opts.{name} must be a string, got {}.",
            request.op,
            describe_arg(Some(value))
        )));
    };
    let length = text.encode_utf16().count();
    if length > max {
        return Err(coded(
            ErrorCode::ArtifactTooLarge,
            format!(
                "artifact.{}: opts.{name} is {length} characters, over the cap of {max}. Shorten it.",
                request.op
            ),
        ));
    }
    Ok(Some(text.clone()))
}

/// A bare MIME type (`type/subtype`, no parameters). The viewer dispatches on the exact string.
fn optional_content_type(value: Option<&Value>) -> Result<Option<String>, WorkflowError> {
    let value = match value {
        None => return Ok(None),
        Some(value) => value,
    };
    let Value::String(text) = value else {
        return Err(driver_error(format!(
            "artifact.file: opts.contentType must be a string, got {}.",
            describe_arg(Some(value))
        )));
    };
    if !is_bare_mime(text) {
        return Err(driver_error(format!(
            "artifact.file: opts.contentType '{text}' is not a bare MIME type such as \
             'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on \
             the exact string."
        )));
    }
    Ok(Some(text.clone()))
}

/// `^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$`.
fn is_bare_mime(text: &str) -> bool {
    let Some((kind, subtype)) = text.split_once('/') else {
        return false;
    };
    let token = |part: &str| {
        let mut chars = part.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || "!#$&^_.+-".contains(c))
    };
    token(kind) && token(subtype)
}

/// What is written to the store.
enum Payload {
    Binary {
        bytes: Vec<u8>,
        content_type: String,
        extension: Option<String>,
        source_path: String,
    },
    Text {
        text: String,
    },
}

impl Payload {
    fn content_type(&self) -> &str {
        match self {
            Self::Binary { content_type, .. } => content_type,
            Self::Text { .. } => "text/markdown",
        }
    }
}

/// Node `readFilePayload`: resolve the path, read the bytes with a cap, and pick the type from the extension.
fn read_file_payload(
    deps: &PublishDeps<'_>,
    request: &ArtifactPublishRequest,
    opts: &PublishOptions,
) -> Result<Payload, WorkflowError> {
    let given = match request.path.as_deref() {
        Some(path) if !path.is_empty() => path,
        other => {
            return Err(driver_error(format!(
                "artifact.file: path must be a non-empty string, got {}. Pass the workspace-relative \
                 path the subagent wrote.",
                describe_arg(other.map(|p| Value::String(p.to_owned())).as_ref())
            )));
        }
    };
    let (real, relative) = resolve_workspace_file(deps, given)?;
    let bytes = read_capped(deps, given, &real)?;
    let extension = file_extension(&real);
    let content_type = opts
        .content_type
        .clone()
        .or_else(|| {
            extension
                .as_deref()
                .and_then(extension_content_type)
                .map(str::to_owned)
        })
        // Unknown extensions are not sniffed: the viewer shows a download card.
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    Ok(Payload::Binary {
        bytes,
        content_type,
        extension,
        source_path: relative,
    })
}

/// Node `resolveWorkspaceFile`: the lexical check, then a check on the real path, because the bytes are copied for the
/// user. The source attribution is the script's path, not the link target.
fn resolve_workspace_file(
    deps: &PublishDeps<'_>,
    given: &str,
) -> Result<(PathBuf, String), WorkflowError> {
    let resolved =
        resolve_within_workspace(deps.cwd, given).ok_or_else(|| outside_workspace(given))?;
    let relative = to_workspace_relative(deps.cwd, &resolved.to_string_lossy());
    let real_cwd = deps.fs.real_path(deps.cwd).map_err(|fault| {
        driver_error(format!(
            "artifact.file: cannot resolve the workspace root '{}': {}",
            deps.cwd.display(),
            fault_text(&fault)
        ))
    })?;
    let real = deps
        .fs
        .real_path(&resolved)
        .map_err(|_| source_missing(given))?;
    if resolve_within_workspace(&real_cwd, &real.to_string_lossy()).is_none() {
        return Err(outside_workspace(given));
    }
    Ok((real, relative))
}

/// Node `readCappedBytes`: the port reports a file over the cap as `TooLarge`; the caller never gets a truncated read.
fn read_capped(deps: &PublishDeps<'_>, given: &str, path: &Path) -> Result<Vec<u8>, WorkflowError> {
    let cap = caps::MAX_FILE_BYTES;
    match deps.fs.read_file(path, cap) {
        Ok(bytes) if bytes.len() <= cap => Ok(bytes),
        Ok(_) | Err(FsFault::TooLarge) => Err(too_large(given, cap)),
        Err(FsFault::NotFound | FsFault::IsDirectory | FsFault::NotFile) => {
            Err(source_missing(given))
        }
        Err(fault) => Err(driver_error(format!(
            "artifact.file: failed to read '{given}': {}",
            fault_text(&fault)
        ))),
    }
}

/// Node `markdownPayload`: the body is measured in UTF-8 bytes.
fn markdown_payload(request: &ArtifactPublishRequest) -> Result<Payload, WorkflowError> {
    let Some(content) = &request.content else {
        return Err(driver_error(
            "artifact.markdown: content must be a string, got undefined.",
        ));
    };
    let bytes = content.len();
    let cap = caps::MAX_MARKDOWN_BYTES;
    if bytes > cap {
        return Err(coded(
            ErrorCode::ArtifactTooLarge,
            format!(
                "artifact.markdown: content is {bytes} bytes, over the cap of {cap} bytes. Shorten it, \
                 or write the long content to a workspace file and publish it with artifact.file."
            ),
        ));
    }
    Ok(Payload::Text {
        text: content.clone(),
    })
}

/// Node `requireArtifactStore`: the store, the parent session, and binary support, each checked for the op.
fn require_store<'a>(
    deps: &PublishDeps<'a>,
    request: &ArtifactPublishRequest,
) -> Result<(&'a dyn ArtifactStorePort, &'a str), WorkflowError> {
    let Some(store) = deps.store else {
        return Err(coded(
            ErrorCode::ArtifactStoreUnavailable,
            format!(
                "artifact.{}: cannot publish \"{}\" because this assembly has no artifact store.",
                request.op, request.id
            ),
        ));
    };
    if request.op == "file" && !store.supports_binary() {
        return Err(coded(
            ErrorCode::ArtifactStoreUnavailable,
            format!(
                "artifact.file: cannot publish \"{}\" because this assembly's artifact store does not \
                 support binary writes.",
                request.id
            ),
        ));
    }
    match deps.parent_session_id {
        Some(session) if !session.is_empty() => Ok((store, session)),
        _ => Err(coded(
            ErrorCode::ArtifactStoreUnavailable,
            format!(
                "artifact.{}: cannot publish \"{}\" because the artifact store has no session scope \
                 (parent session id not wired).",
                request.op, request.id
            ),
        )),
    }
}

/// Node `writePayload`. The tool-call id is `<run>:<site>@<ordinal>`, so one version has one set of bytes.
fn write_payload(
    store: &dyn ArtifactStorePort,
    session: &str,
    request: &ArtifactPublishRequest,
    payload: &Payload,
) -> Result<StoreReceipt, WorkflowError> {
    let tool_call_id = format!("{}:{}@{}", request.run_id, request.site_id, request.ordinal);
    let (content, content_type, extension) = match payload {
        Payload::Text { text } => (StoreContent::Text(text), "text/markdown", None),
        Payload::Binary {
            bytes,
            content_type,
            extension,
            ..
        } => (
            StoreContent::Binary(bytes),
            content_type.as_str(),
            extension.as_deref(),
        ),
    };
    store
        .write(&StoreWrite {
            session_id: session,
            tool_call_id: &tool_call_id,
            tool_name: ARTIFACT_TOOL_NAME,
            retention: "project",
            content,
            content_type,
            extension,
        })
        .map_err(|message| {
            driver_error(format!(
                "artifact.{}: writing \"{}\" v{} to the artifact store failed: {message}",
                request.op, request.id, request.version
            ))
        })
}

// ——————————————————————————————— Pure helpers ———————————————————————————————

/// Extension to MIME. Anything outside the table is `application/octet-stream`; content is never sniffed.
pub fn extension_content_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "csv" => "text/csv",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "gif" => "image/gif",
        "htm" | "html" => "text/html",
        "jpeg" | "jpg" => "image/jpeg",
        "json" => "application/json",
        "markdown" | "md" => "text/markdown",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "webp" => "image/webp",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => return None,
    })
}

/// The lowercase extension of the base name, when it is `[a-z0-9]+` and not a leading dot.
pub fn file_extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    if dot == 0 || dot == name.len() - 1 {
        return None;
    }
    let ext = name[dot + 1..].to_ascii_lowercase();
    (!ext.is_empty()
        && ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
    .then_some(ext)
}

fn outside_workspace(given: &str) -> WorkflowError {
    coded(
        ErrorCode::ArtifactPathOutsideWorkspace,
        format!(
            "artifact.file: path '{given}' resolves outside the workspace (symlinks are judged by their \
             real path). Only files inside the workspace can be published."
        ),
    )
}

/// A missing path, a directory, or a path that is not a regular file. The cause is not shown: the script only needs to
/// know the subagent did not write the file.
fn source_missing(given: &str) -> WorkflowError {
    coded(
        ErrorCode::ArtifactSourceMissing,
        format!(
            "artifact.file: '{given}' does not exist or is not a regular file. Confirm the subagent \
             actually wrote it before publishing."
        ),
    )
}

fn too_large(given: &str, cap: usize) -> WorkflowError {
    coded(
        ErrorCode::ArtifactTooLarge,
        format!(
            "artifact.file: '{given}' is over the cap of {cap} bytes. Publish a smaller artifact (a \
             summary, a slice, or a compressed version)."
        ),
    )
}

fn fault_text(fault: &FsFault) -> String {
    match fault {
        FsFault::NotFound => "not found".to_owned(),
        FsFault::IsDirectory => "is a directory".to_owned(),
        FsFault::NotFile => "not a regular file".to_owned(),
        FsFault::TooLarge => "too large".to_owned(),
        FsFault::Other(message) => message.clone(),
    }
}

#[cfg(test)]
#[path = "artifact_publish_tests.rs"]
mod tests;
