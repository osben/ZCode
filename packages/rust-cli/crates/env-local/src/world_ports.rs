//! Production world ports over the local environment (W7-4; Node `workflow-world-read.ts` and
//! `workflow-artifact-publish.ts`). The workflow crate owns the traits and every check (caps, argument shapes, containment
//! by name, the store's record); this module supplies the bytes and the process results.
//!
//! The ports are blocking, as the traits say: each call blocks on a tokio handle, so it must run on a worker thread,
//! never inside the runtime. The owner's world jobs already do that.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use rust_cli_kernel_api::env::{
    CommandEvent, EnvError, EnvPath, OperationContext, Origin, OutputStream, ReadFile,
    StartCommand, WorkspaceRef,
};
use rust_cli_kernel_api::env_files::{
    GlobFiles, GrepFileLines, GrepLineKind, GrepMode, GrepOutcome, GrepSearch,
};
use rust_cli_kernel_api::env_shell::CwdScope;
use rust_cli_kernel_api::ids::{EnvironmentId, Generation, OperationId, ShellTaskId};
use rust_cli_kernel_api::machine::{Commands, Files, Search};
use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactStore};
use rust_cli_workflow::artifact_publish::{
    ArtifactFsPort, ArtifactStorePort, FsFault, StoreContent, StoreReceipt, StoreWrite,
};
use rust_cli_workflow::world_read::{
    GlobHits, GrepEntry, GrepHits, RunOutcome, RunRequest, RunStatus, RunStream, WorldReadPorts,
    caps,
};

use crate::LocalEnvironment;

/// The `WorldReadPorts` of one workspace: globs, reads, greps and runs through the local environment. Every call
/// blocks on `handle`.
pub struct WorldPorts {
    env: Arc<LocalEnvironment>,
    root: PathBuf,
    handle: tokio::runtime::Handle,
    next: AtomicU64,
}

impl WorldPorts {
    pub fn new(env: Arc<LocalEnvironment>, root: PathBuf, handle: tokio::runtime::Handle) -> Self {
        Self {
            env,
            root,
            handle,
            next: AtomicU64::new(1),
        }
    }

    fn workspace(&self, root: &Path) -> WorkspaceRef {
        WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new(root.to_string_lossy()),
        }
    }

    /// A fresh operation for one run. The process id keeps the task file names apart between two processes that share
    /// a scratch directory.
    fn operation(&self) -> (OperationContext, ShellTaskId) {
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        let name = format!("world-{}-{n}", std::process::id());
        let context = OperationContext::new(
            EnvironmentId::new("local"),
            Generation::new("world"),
            OperationId::new(name.clone()),
            Origin::User { session: None },
        );
        (context, ShellTaskId::new(name))
    }
}

fn env_text(error: &EnvError) -> String {
    error.to_string()
}

impl WorldReadPorts for WorldPorts {
    fn glob(&self, pattern: &str, limit: usize) -> Result<GlobHits, String> {
        // The same options as the Glob tool: the port is the UI's file search, so it sees hidden files and ignores
        // nothing. The workflow sorts the result and checks the cap.
        let request = GlobFiles {
            root: EnvPath::new(self.root.to_string_lossy()),
            pattern: pattern.to_owned(),
            limit,
            hidden: true,
            respect_ignore: false,
        };
        let matches = self
            .handle
            .block_on(self.env.glob(&self.workspace(&self.root), request))
            .map_err(|error| env_text(&error))?;
        Ok(GlobHits {
            files: matches
                .files
                .iter()
                .map(|path| path.as_str().to_owned())
                .collect(),
            total: matches.total,
        })
    }

    fn read_text(&self, path: &str) -> Result<String, String> {
        let content = self
            .handle
            .block_on(self.env.read_file(
                &self.workspace(&self.root),
                ReadFile {
                    path: EnvPath::new(path),
                },
            ))
            .map_err(|error| env_text(&error))?;
        Ok(String::from_utf8_lossy(&content.bytes).into_owned())
    }

    fn grep(
        &self,
        pattern: &str,
        glob: Option<&str>,
        head_limit: usize,
    ) -> Result<GrepHits, String> {
        // Matches with the Grep tool's options (hidden files in, no ignore files changed). The port has no head limit,
        // so every match is read and the head is cut here: `truncated` says more matches followed.
        let request = GrepSearch {
            root: EnvPath::new(self.root.to_string_lossy()),
            pattern: pattern.to_owned(),
            case_insensitive: false,
            multiline: false,
            globs: glob.map(|glob| vec![glob.to_owned()]).unwrap_or_default(),
            file_type: None,
            hidden: true,
            mode: GrepMode::Content {
                before: 0,
                after: 0,
            },
        };
        let outcome = self
            .handle
            .block_on(self.env.grep(&self.workspace(&self.root), request))
            .map_err(|error| env_text(&error))?;
        let files = match outcome {
            GrepOutcome::Content { files } => files,
            GrepOutcome::Rejected { message } => return Err(message),
            other => return Err(format!("unexpected grep outcome {other:?}")),
        };
        let entries = content_entries(files);
        let truncated = entries.len() > head_limit;
        Ok(GrepHits {
            entries: entries.into_iter().take(head_limit).collect(),
            truncated,
        })
    }

    fn run(&self, request: &RunRequest) -> Result<RunOutcome, String> {
        let (context, task) = self.operation();
        let start = StartCommand {
            timeout_ms: Some(request.timeout_ms.unwrap_or(caps::RUN_DEFAULT_TIMEOUT_MS)),
            cwd_scope: CwdScope::Pinned,
            ..StartCommand::argv(
                request.file.clone(),
                request.args.clone(),
                EnvPath::new(request.cwd.to_string_lossy()),
                task,
            )
        };
        let workspace = self.workspace(&request.cwd);
        // A program that cannot start is a result for the workflow (`spawn_error`), not a port fault.
        let events = match self
            .handle
            .block_on(self.env.start_command(&workspace, context, start))
        {
            Ok(events) => events,
            Err(error) => {
                return Ok(RunOutcome {
                    status: RunStatus::SpawnError,
                    exit_code: None,
                    error: Some(env_text(&error)),
                    stdout: RunStream::default(),
                    stderr: RunStream::default(),
                });
            }
        };
        let mut collected = Collected::new(request);
        let finished = self.handle.block_on(async {
            let mut events = events;
            while let Some(event) = events.next().await {
                match event.map_err(|error| env_text(&error))? {
                    CommandEvent::Output { stream, data, .. } => match stream {
                        OutputStream::Stdout => collected.stdout.push(&data),
                        OutputStream::Stderr => collected.stderr.push(&data),
                    },
                    finished @ CommandEvent::Finished { .. } => return Ok(finished),
                    _ => {}
                }
            }
            Err("the command ended without a result".to_owned())
        })?;
        let CommandEvent::Finished {
            outcome,
            exit_code,
            timed_out,
            output_limit,
            ..
        } = finished
        else {
            return Err("the command ended without a result".to_owned());
        };
        let (status, error) = run_status(outcome, exit_code, timed_out, output_limit);
        Ok(RunOutcome {
            status,
            exit_code,
            error,
            stdout: collected.stdout.finish(),
            stderr: collected.stderr.finish(),
        })
    }
}

/// The content lines of a grep, as the workflow reads them: one entry per match line, with the line's text and line
/// number. Context lines are not matches and are left out. The line ending is not part of the text.
fn content_entries(files: Vec<GrepFileLines>) -> Vec<GrepEntry> {
    let mut entries = Vec::new();
    for file in files {
        for line in file.lines {
            if line.kind != GrepLineKind::Match {
                continue;
            }
            let text = line
                .text
                .strip_suffix('\n')
                .map_or(line.text.as_str(), |text| {
                    text.strip_suffix('\r').unwrap_or(text)
                });
            entries.push(GrepEntry {
                path: file.path.as_str().to_owned(),
                line: Some(line.line_number),
                text: Some(text.to_owned()),
            });
        }
    }
    entries
}

/// How a run ended, as the workflow reads it. A nonzero exit is a `Failed` with no error (a result, not a failure of
/// the observation). A timeout, a cancel and an output limit are not exits.
fn run_status(
    outcome: rust_cli_kernel_api::env::Outcome,
    exit_code: Option<i32>,
    timed_out: bool,
    output_limit: Option<String>,
) -> (RunStatus, Option<String>) {
    use rust_cli_kernel_api::env::Outcome;
    if let Some(limit) = output_limit {
        return (RunStatus::Failed, Some(limit));
    }
    if timed_out {
        return (RunStatus::TimedOut, None);
    }
    match outcome {
        Outcome::Completed if exit_code.unwrap_or(0) == 0 => (RunStatus::Completed, None),
        Outcome::Completed => (RunStatus::Failed, None),
        Outcome::Cancelled => (RunStatus::Cancelled, None),
        Outcome::Failed { message, .. } => (RunStatus::Failed, Some(message)),
        other => (RunStatus::Failed, Some(format!("{other:?}"))),
    }
}

/// One stream of a run, kept as the workflow needs it: the head up to the inline limit, the byte count, and the tail
/// when one was asked for. The rest of the output is counted and dropped, never buffered.
struct Stream {
    head: Vec<u8>,
    inline: usize,
    total: usize,
    tail_bytes: Option<usize>,
    tail: std::collections::VecDeque<u8>,
}

impl Stream {
    fn push(&mut self, data: &[u8]) {
        self.total += data.len();
        let room = self.inline.saturating_sub(self.head.len());
        self.head.extend_from_slice(&data[..room.min(data.len())]);
        if let Some(keep) = self.tail_bytes {
            self.tail.extend(data.iter().copied());
            while self.tail.len() > keep {
                self.tail.pop_front();
            }
        }
    }

    fn finish(self) -> RunStream {
        RunStream {
            text: String::from_utf8_lossy(&self.head).into_owned(),
            bytes: self.total,
            truncated: self.total > self.inline,
            // A tail that was asked for always comes back, even empty.
            tail: self.tail_bytes.map(|_| {
                String::from_utf8_lossy(&self.tail.iter().copied().collect::<Vec<_>>()).into_owned()
            }),
        }
    }
}

struct Collected {
    stdout: Stream,
    stderr: Stream,
}

impl Collected {
    fn new(request: &RunRequest) -> Self {
        let stream = || Stream {
            head: Vec::new(),
            inline: request.max_inline_bytes,
            total: 0,
            tail_bytes: request.tail_bytes,
            tail: std::collections::VecDeque::new(),
        };
        Self {
            stdout: stream(),
            stderr: stream(),
        }
    }
}

/// The file side of the artifact publish, on the real filesystem. `read_file` stats before it opens, so a fifo or a
/// device is refused from its metadata and never opened; it reads at most `max_bytes` and reports `TooLarge` past it.
pub struct WorldFs;

fn fault(error: &io::Error) -> FsFault {
    if error.kind() == io::ErrorKind::NotFound {
        FsFault::NotFound
    } else {
        FsFault::Other(error.to_string())
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "env-local is the entry for workspace file IO (docs/specs/rust-cli/README.md §4)"
)]
impl ArtifactFsPort for WorldFs {
    fn read_file(&self, path: &Path, max_bytes: usize) -> Result<Vec<u8>, FsFault> {
        // Metadata follows symlinks, so the checks are on the file the link names.
        let metadata = fs::metadata(path).map_err(|error| fault(&error))?;
        if metadata.is_dir() {
            return Err(FsFault::IsDirectory);
        }
        if !metadata.is_file() {
            return Err(FsFault::NotFile);
        }
        if metadata.len() > max_bytes as u64 {
            return Err(FsFault::TooLarge);
        }
        let file = fs::File::open(path).map_err(|error| fault(&error))?;
        // One byte past the limit proves a file that grew between the stat and the read.
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| fault(&error))?;
        if bytes.len() > max_bytes {
            return Err(FsFault::TooLarge);
        }
        Ok(bytes)
    }

    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault> {
        fs::canonicalize(path).map_err(|error| fault(&error))
    }
}

/// The artifact store over the kernel's `ArtifactStore`. The store takes no tool-call id, retention or file extension, so
/// those are not written (divergence in spec 9.11).
pub struct StoreAdapter {
    store: Arc<dyn ArtifactStore>,
    handle: tokio::runtime::Handle,
}

impl StoreAdapter {
    pub fn new(store: Arc<dyn ArtifactStore>, handle: tokio::runtime::Handle) -> Self {
        Self { store, handle }
    }
}

impl ArtifactStorePort for StoreAdapter {
    fn supports_binary(&self) -> bool {
        true
    }

    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String> {
        let bytes = match write.content {
            StoreContent::Text(text) => text.as_bytes().to_vec(),
            StoreContent::Binary(bytes) => bytes.to_vec(),
        };
        let session = rust_cli_kernel_api::ids::SessionId::new(write.session_id);
        let reference = self
            .handle
            .block_on(self.store.put(
                &session,
                ArtifactPurpose::Deliverable,
                write.content_type.to_owned(),
                bytes,
            ))
            .map_err(|error| error.to_string())?;
        Ok(StoreReceipt {
            bytes: reference.size as usize,
            uri: format!(
                "zcode-artifact://{}/{}",
                reference.session.as_str(),
                reference.id.as_str()
            ),
        })
    }
}
