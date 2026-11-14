//! Fork: the command hooks' transcript files on this host (Node `createCompatibleHookStdin` writes them under
//! `os.tmpdir()`; specs/fork-rust-agent-parity.md "Command hook stdin").

use std::path::PathBuf;

use async_trait::async_trait;
use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};

/// Transcript files in private directories under the temp root the entry resolved.
pub struct LocalHookTranscripts {
    root: PathBuf,
}

impl LocalHookTranscripts {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

#[async_trait]
impl HookTranscripts for LocalHookTranscripts {
    async fn create(&self, name: &str, text: &str) -> std::io::Result<HookTranscript> {
        let dir = self.root.join(name);
        rust_cli_fs::create_private_dir_all(&dir).await?;
        let path = dir.join("transcript.jsonl");
        rust_cli_fs::append(&path, text.as_bytes()).await?;
        Ok(HookTranscript {
            path: path.to_string_lossy().into_owned(),
            dir: dir.to_string_lossy().into_owned(),
        })
    }

    async fn remove(&self, transcript: &HookTranscript) -> std::io::Result<()> {
        rust_cli_fs::remove_dir_all_optional(std::path::Path::new(&transcript.dir)).await
    }
}

#[cfg(test)]
#[path = "hook_transcripts_tests.rs"]
mod tests;
