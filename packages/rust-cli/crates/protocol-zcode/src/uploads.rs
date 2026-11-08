//! Fork: the App attachment upload transaction (`v4/attachment/{begin,chunk,commit,abort}`), a port of Node's
//! `attachment-upload-registry.ts`. The registry only stages and validates bytes; the caller stores the committed
//! payload ([`crate::attachments`]) and reports the ref back with [`Registry::committed`].
//!
//! Keys are `connectionId`, `sessionId` and `uploadId`. A repeat of `begin`, a chunk or `commit` with the same metadata
//! or bytes answers the same result, so a client that lost a reply can retry. Limits are `PROTOCOL_V4_LIMITS`.

use std::collections::HashMap;

use serde::Deserialize;

/// `PROTOCOL_V4_LIMITS.attachmentMaxBytes`.
pub(crate) const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes`.
pub(crate) const CHUNK_MAX_BYTES: usize = 512 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks`.
const MAX_CHUNKS: u64 = 64;
/// `PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent`.
const MAX_CONCURRENT: usize = 16;
/// `PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes`.
const MAX_STAGED_BYTES: usize = 64 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentUploadTtlMs`.
const TTL_MS: u64 = 5 * 60_000;

/// `v4/attachment/begin` params (the Host injects `connectionId`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Begin {
    pub connection_id: String,
    pub upload_id: String,
    pub session_id: String,
    pub file_name: String,
    pub mime: String,
    pub total_bytes: u64,
    pub total_chunks: u64,
    pub checksum: String,
}

/// The upload identity of `chunk`, `commit` and `abort`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Target {
    pub connection_id: String,
    pub upload_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Metadata {
    file_name: String,
    mime: String,
    total_bytes: u64,
    total_chunks: u64,
    checksum: String,
}

type Key = (String, String, String);

struct Staged {
    metadata: Metadata,
    chunks: Vec<Vec<u8>>,
    received: usize,
    expires_at: u64,
    committing: bool,
}

struct Committed {
    metadata: Metadata,
    next_chunk: usize,
    reference: String,
    expires_at: u64,
}

/// What `begin` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Began {
    Staging {
        next_chunk: usize,
    },
    Committed {
        next_chunk: usize,
        reference: String,
    },
}

/// What `commit` asks the caller to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Commit {
    /// Already committed: answer this ref.
    Done(String),
    /// Store these bytes, then call [`Registry::committed`] (or [`Registry::release`] when storing failed).
    Store {
        file_name: String,
        mime: String,
        bytes: Vec<u8>,
    },
}

/// The staging registry of one agent process.
#[derive(Default)]
pub(crate) struct Registry {
    staged: HashMap<Key, Staged>,
    committed: HashMap<Key, Committed>,
    staged_bytes: usize,
}

fn key(connection: &str, session: &str, upload: &str) -> Key {
    (connection.to_owned(), session.to_owned(), upload.to_owned())
}

fn fault(code: &str) -> String {
    format!("fault.attachment.{code}")
}

fn valid_upload_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn valid_checksum(checksum: &str) -> bool {
    checksum.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

impl Registry {
    pub(crate) fn begin(&mut self, params: &Begin, now: u64) -> Result<Began, String> {
        self.prune(now);
        if !valid_upload_id(&params.upload_id)
            || !valid_checksum(&params.checksum)
            || params.file_name.is_empty()
            || params.file_name.contains(['\0', '\r', '\n'])
            || params.total_bytes > MAX_BYTES
            || params.total_chunks > MAX_CHUNKS
            || (params.total_bytes == 0) != (params.total_chunks == 0)
        {
            return Err(fault("invalidParams"));
        }
        let key = key(&params.connection_id, &params.session_id, &params.upload_id);
        let metadata = Metadata {
            file_name: params.file_name.clone(),
            mime: params.mime.clone(),
            total_bytes: params.total_bytes,
            total_chunks: params.total_chunks,
            checksum: params.checksum.clone(),
        };
        if let Some(done) = self.committed.get(&key) {
            if done.metadata != metadata {
                return Err(fault("beginConflict"));
            }
            return Ok(Began::Committed {
                next_chunk: done.next_chunk,
                reference: done.reference.clone(),
            });
        }
        if let Some(existing) = self.staged.get_mut(&key) {
            if existing.metadata != metadata {
                return Err(fault("beginConflict"));
            }
            existing.expires_at = now + TTL_MS;
            return Ok(Began::Staging {
                next_chunk: existing.chunks.len(),
            });
        }
        if self.staged.len() >= MAX_CONCURRENT {
            return Err(fault("tooManyUploads"));
        }
        if params.total_chunks > 0
            && params.total_bytes > params.total_chunks * CHUNK_MAX_BYTES as u64
        {
            return Err(fault("chunkCountInsufficient"));
        }
        self.staged.insert(
            key,
            Staged {
                metadata,
                chunks: Vec::new(),
                received: 0,
                expires_at: now + TTL_MS,
                committing: false,
            },
        );
        Ok(Began::Staging { next_chunk: 0 })
    }

    pub(crate) fn chunk(
        &mut self,
        target: &Target,
        index: usize,
        bytes: Vec<u8>,
        now: u64,
    ) -> Result<usize, String> {
        self.prune(now);
        let key = key(&target.connection_id, &target.session_id, &target.upload_id);
        let staged_bytes = self.staged_bytes;
        let upload = self
            .staged
            .get_mut(&key)
            .ok_or_else(|| fault("uploadNotFound"))?;
        if upload.committing {
            return Err(fault("commitInProgress"));
        }
        if bytes.len() > CHUNK_MAX_BYTES {
            return Err(fault("chunkTooLarge"));
        }
        if index < upload.chunks.len() {
            if upload.chunks[index] != bytes {
                return Err(fault("chunkConflict"));
            }
            return Ok(upload.chunks.len());
        }
        if index > upload.chunks.len() {
            return Err(fault("chunkGap"));
        }
        if index as u64 >= upload.metadata.total_chunks {
            return Err(fault("tooManyChunks"));
        }
        if bytes.is_empty() {
            return Err(fault("emptyChunk"));
        }
        if (upload.received + bytes.len()) as u64 > upload.metadata.total_bytes {
            return Err(fault("totalBytesExceeded"));
        }
        if staged_bytes + bytes.len() > MAX_STAGED_BYTES {
            return Err(fault("stagingCapacityExceeded"));
        }
        upload.received += bytes.len();
        upload.expires_at = now + TTL_MS;
        let size = bytes.len();
        upload.chunks.push(bytes);
        let next = upload.chunks.len();
        self.staged_bytes += size;
        Ok(next)
    }

    /// Validates a staged upload and hands its bytes out once; a second commit while the first stores is refused
    /// (Node shares the promise; one agent process serves commits of one upload in order, so this is only a race guard).
    pub(crate) fn commit(&mut self, target: &Target, now: u64) -> Result<Commit, String> {
        self.prune(now);
        let key = key(&target.connection_id, &target.session_id, &target.upload_id);
        if let Some(done) = self.committed.get(&key) {
            return Ok(Commit::Done(done.reference.clone()));
        }
        let upload = self
            .staged
            .get_mut(&key)
            .ok_or_else(|| fault("uploadNotFound"))?;
        if upload.committing {
            return Err(fault("commitInProgress"));
        }
        if upload.chunks.len() as u64 != upload.metadata.total_chunks
            || upload.received as u64 != upload.metadata.total_bytes
        {
            return Err(fault("uploadIncomplete"));
        }
        let bytes = upload.chunks.concat();
        if format!("sha256:{}", rust_cli_base::hash::sha256_hex(&bytes)) != upload.metadata.checksum
        {
            return Err(fault("checksumMismatch"));
        }
        upload.committing = true;
        Ok(Commit::Store {
            file_name: upload.metadata.file_name.clone(),
            mime: upload.metadata.mime.clone(),
            bytes,
        })
    }

    /// The bytes of a [`Commit::Store`] are stored under `reference`.
    pub(crate) fn committed(&mut self, target: &Target, reference: String, now: u64) {
        let key = key(&target.connection_id, &target.session_id, &target.upload_id);
        let Some(upload) = self.remove_staged(&key) else {
            return;
        };
        self.committed.insert(
            key,
            Committed {
                metadata: upload.metadata,
                next_chunk: upload.chunks.len(),
                reference,
                expires_at: now + TTL_MS,
            },
        );
    }

    /// Storing a [`Commit::Store`] failed: the upload can be committed again.
    pub(crate) fn release(&mut self, target: &Target) {
        let key = key(&target.connection_id, &target.session_id, &target.upload_id);
        if let Some(upload) = self.staged.get_mut(&key) {
            upload.committing = false;
        }
    }

    /// Drops a staged upload; a commit in flight keeps it (its result still lands).
    pub(crate) fn abort(&mut self, target: &Target, now: u64) {
        self.prune(now);
        let key = key(&target.connection_id, &target.session_id, &target.upload_id);
        if self
            .staged
            .get(&key)
            .is_some_and(|upload| upload.committing)
        {
            return;
        }
        self.remove_staged(&key);
    }

    pub(crate) fn clear_connection(&mut self, connection: &str) {
        let keys: Vec<Key> = self
            .staged
            .keys()
            .filter(|key| key.0 == connection)
            .cloned()
            .collect();
        for key in keys {
            self.remove_staged(&key);
        }
        self.committed.retain(|key, _| key.0 != connection);
    }

    fn prune(&mut self, now: u64) {
        let expired: Vec<Key> = self
            .staged
            .iter()
            .filter(|(_, upload)| upload.expires_at <= now && !upload.committing)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_staged(&key);
        }
        self.committed.retain(|_, done| done.expires_at > now);
    }

    fn remove_staged(&mut self, key: &Key) -> Option<Staged> {
        let upload = self.staged.remove(key)?;
        self.staged_bytes -= upload.received;
        Some(upload)
    }
}

#[cfg(test)]
#[path = "uploads_tests.rs"]
mod tests;
