//! Fork: the command hooks' transcript files on this host (Node `createCompatibleHookStdin` writes them under
//! `os.tmpdir()`; specs/fork-rust-agent-parity.md "Command hook stdin").

use std::io::{Error, ErrorKind};
use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};

const FILE: &str = "transcript.jsonl";

/// The file is written new each time (temp file and rename), owner-only.
const WRITE: rust_cli_fs::WriteOptions = rust_cli_fs::WriteOptions {
    mode: rust_cli_fs::FileMode::Private,
    temp_name: rust_cli_fs::TempName::Hidden,
    parent: rust_cli_fs::ParentDir::Existing,
    rename_retry: &[],
};

/// Transcript files in private directories under the temp root the entry resolved.
pub struct LocalHookTranscripts {
    root: PathBuf,
}

impl LocalHookTranscripts {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `dir` when it is a direct child of the root with a plain name; anything else is refused, so a forged
    /// transcript never removes a directory outside the root.
    fn confined(&self, dir: &str) -> std::io::Result<PathBuf> {
        let dir = PathBuf::from(dir);
        match dir.file_name().and_then(|name| name.to_str()) {
            Some(name) if dir.parent() == Some(self.root.as_path()) && plain(name) => Ok(dir),
            _ => Err(invalid(format!(
                "hook transcript directory outside {}: {}",
                self.root.display(),
                dir.display()
            ))),
        }
    }
}

/// One normal path component: no separator, not `.` or `..`, not empty.
fn plain(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(part)), None) if part == name
    )
}

fn invalid(message: String) -> Error {
    Error::new(ErrorKind::InvalidInput, message)
}

#[async_trait]
impl HookTranscripts for LocalHookTranscripts {
    fn locate(&self, name: &str) -> std::io::Result<HookTranscript> {
        if !plain(name) {
            return Err(invalid(format!("invalid hook transcript name: {name:?}")));
        }
        let dir = self.root.join(name);
        Ok(HookTranscript {
            path: dir.join(FILE).to_string_lossy().into_owned(),
            dir: dir.to_string_lossy().into_owned(),
        })
    }

    async fn create(&self, transcript: &HookTranscript, text: &str) -> std::io::Result<()> {
        let dir = self.confined(&transcript.dir)?;
        rust_cli_fs::create_private_dir_all(&dir).await?;
        rust_cli_fs::atomic_write(&dir.join(FILE), text.as_bytes(), WRITE).await
    }

    async fn remove(&self, transcript: &HookTranscript) -> std::io::Result<()> {
        let dir = self.confined(&transcript.dir)?;
        rust_cli_fs::remove_dir_all_optional(&dir).await
    }

    fn remove_blocking(&self, transcript: &HookTranscript) -> std::io::Result<()> {
        let dir = self.confined(&transcript.dir)?;
        rust_cli_fs::remove_dir_all_optional_blocking(&dir)
    }
}

#[cfg(test)]
#[path = "hook_transcripts_tests.rs"]
mod tests;
