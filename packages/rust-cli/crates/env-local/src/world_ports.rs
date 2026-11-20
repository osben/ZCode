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
    GlobFiles, GrepFileLines, GrepLineKind, GrepMode, GrepOutcome, GrepSearch, StatFile, VCS_DIRS,
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

use regex::Regex;

use crate::LocalEnvironment;

/// The `WorldReadPorts` of one workspace: globs, reads, greps and runs through the local environment. Every call
/// blocks on `handle`.
pub struct WorldPorts {
    env: Arc<LocalEnvironment>,
    root: PathBuf,
    handle: tokio::runtime::Handle,
}

/// The operation counter of the whole process. A per-instance counter let two ports hand out the same task id, and
/// the same output file (Finding: two `WorldPorts` in one process share the scratch directory).
static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);

/// The cap on one `files.read` (Node has none; this is a divergence in spec 9.19). It is the run stream cap, so a
/// read and a run are bounded by the same number.
pub const READ_TEXT_CAP_BYTES: usize = caps::RUN_STREAM_MAX_BYTES;

impl WorldPorts {
    pub fn new(env: Arc<LocalEnvironment>, root: PathBuf, handle: tokio::runtime::Handle) -> Self {
        Self { env, root, handle }
    }

    /// The environment under these ports (the tests build a second port over the same one).
    #[cfg(test)]
    pub(crate) fn env(&self) -> Arc<LocalEnvironment> {
        self.env.clone()
    }

    fn workspace(&self, root: &Path) -> WorkspaceRef {
        WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new(root.to_string_lossy()),
        }
    }

    /// A fresh operation for one run. The counter is process-wide and the process id keeps two processes that share a
    /// scratch directory apart, so no two runs share an output file.
    pub(crate) fn operation(&self) -> (OperationContext, ShellTaskId) {
        let n = NEXT_OPERATION.fetch_add(1, Ordering::Relaxed);
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

impl WorldPorts {
    /// `files.read` with a size guard: the size is taken from a stat first, so an over-cap file is never read; the
    /// bytes are checked again after the read, for a file that grew in between.
    pub(crate) fn read_text_capped(&self, path: &str, cap: usize) -> Result<String, String> {
        let workspace = self.workspace(&self.root);
        let stat = self
            .handle
            .block_on(self.env.stat(
                &workspace,
                StatFile {
                    path: EnvPath::new(path),
                },
            ))
            .map_err(|error| env_text(&error))?;
        if let Some(stat) = stat
            && stat.size > cap as u64
        {
            return Err(format!(
                "files.read: {path} is {} bytes, over the {cap}-byte cap. Read a narrower file.",
                stat.size
            ));
        }
        let content = self
            .handle
            .block_on(self.env.read_file(
                &self.workspace(&self.root),
                ReadFile {
                    path: EnvPath::new(path),
                },
            ))
            .map_err(|error| env_text(&error))?;
        if content.bytes.len() > cap {
            return Err(format!(
                "files.read: {path} grew past the {cap}-byte cap while it was read."
            ));
        }
        decode_node_text(&content.bytes, path)
    }
}

fn env_text(error: &EnvError) -> String {
    error.to_string()
}

impl WorldReadPorts for WorldPorts {
    fn glob(&self, pattern: &str, limit: usize) -> Result<GlobHits, String> {
        // Node `searchFiles`: trim, refuse an empty pattern, then walk every regular file (hidden files in, ignore files
        // not read, version-control directories skipped) and keep the names the matcher accepts. The walk is the
        // environment's own; the matching and the VCS skip are Node's, applied here so the total is Node's total.
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return Err("Glob pattern must not be empty".to_owned());
        }
        let matcher = GlobMatcher::new(pattern)?;
        let request = GlobFiles {
            root: EnvPath::new(self.root.to_string_lossy()),
            pattern: "**/*".to_owned(),
            limit: usize::MAX,
            hidden: true,
            respect_ignore: false,
        };
        let all = self
            .handle
            .block_on(self.env.glob(&self.workspace(&self.root), request))
            .map_err(|error| env_text(&error))?;
        let mut hits = Vec::new();
        for path in all.files.iter().map(EnvPath::as_str) {
            let Some(relative) = relative_to(&self.root, path) else {
                continue;
            };
            if under_vcs_directory(&relative) || !matcher.matches(&relative) {
                continue;
            }
            hits.push(path.to_owned());
        }
        Ok(GlobHits {
            total: hits.len(),
            files: hits.into_iter().take(limit).collect(),
        })
    }

    fn read_text(&self, path: &str) -> Result<String, String> {
        self.read_text_capped(path, READ_TEXT_CAP_BYTES)
    }

    fn grep(
        &self,
        pattern: &str,
        glob: Option<&str>,
        head_limit: usize,
    ) -> Result<GrepHits, String> {
        // Node `searchText` through ripgrep: trim, refuse an empty pattern, split the glob as Node does, search hidden
        // files and skip version-control directories. Like Node's adapter, every match is read and the head is cut after
        // (`applyHeadLimit`), and `truncated` says more matches followed.
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return Err("Grep pattern must not be empty".to_owned());
        }
        let request = GrepSearch {
            root: EnvPath::new(self.root.to_string_lossy()),
            pattern: pattern.to_owned(),
            case_insensitive: false,
            multiline: false,
            globs: grep_globs(glob),
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
        let entries: Vec<GrepEntry> = content_entries(files)
            .into_iter()
            .filter(|entry| {
                relative_to(&self.root, &entry.path).is_some_and(|rel| !under_vcs_directory(&rel))
            })
            .collect();
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
pub(crate) fn run_status(
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
        Outcome::Completed if exit_code == Some(0) => (RunStatus::Completed, None),
        // A finished process with no exit code is not a success: the observation did not report one.
        Outcome::Completed if exit_code.is_none() => (
            RunStatus::Failed,
            Some("the command finished without an exit code".to_owned()),
        ),
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

#[cfg(unix)]
#[expect(
    clippy::disallowed_methods,
    reason = "env-local is the entry for workspace file IO (docs/specs/rust-cli/README.md §4)"
)]
fn open_nonblocking(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_nonblocking(path: &Path) -> io::Result<fs::File> {
    fs::File::open(path)
}

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
        // Non-blocking open: a fifo that a writer has not opened would otherwise block here forever. The metadata of the
        // open file (not of the path) is checked again, so a path swapped for a fifo between the two calls is refused.
        let file = open_nonblocking(path).map_err(|error| fault(&error))?;
        let opened = file.metadata().map_err(|error| fault(&error))?;
        if opened.is_dir() {
            return Err(FsFault::IsDirectory);
        }
        if !opened.is_file() {
            return Err(FsFault::NotFile);
        }
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

/// Node `createGlobMatcher` (`workflow-world-read` reads it through `searchFiles`): the pattern becomes an anchored
/// regex over the relative path, and a pattern with no slash also tries the file's basename. `**/` spans directories,
/// `*` and `?` stay inside one segment, `{a,b}` alternates.
struct GlobMatcher {
    whole: Regex,
    basename: Option<Regex>,
}

impl GlobMatcher {
    fn new(pattern: &str) -> Result<Self, String> {
        let normalized = pattern.replace('\\', "/");
        let normalized = normalized
            .strip_prefix("./")
            .unwrap_or(&normalized)
            .to_owned();
        let whole = glob_regex(&normalized)?;
        let basename = (!normalized.contains('/')).then(|| whole.clone());
        Ok(Self { whole, basename })
    }

    fn matches(&self, relative: &str) -> bool {
        let name = relative.rsplit('/').next().unwrap_or(relative);
        self.whole.is_match(relative) || self.basename.as_ref().is_some_and(|re| re.is_match(name))
    }
}

/// Node `globPatternToRegExp`, token for token.
fn glob_regex(pattern: &str) -> Result<Regex, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut regex = String::from("^");
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        match ch {
            '*' if next == Some('*') => {
                if chars.get(index + 2) == Some(&'/') {
                    regex.push_str("(?:.*/)?");
                    index += 3;
                } else {
                    regex.push_str(".*");
                    index += 2;
                }
                continue;
            }
            '*' => regex.push_str("[^/]*"),
            '?' => regex.push_str("[^/]"),
            '{' => {
                let end = chars[index + 1..]
                    .iter()
                    .position(|c| *c == '}')
                    .map(|at| at + index + 1);
                if let Some(end) = end {
                    let alternatives: Vec<String> = chars[index + 1..end]
                        .split(|c| *c == ',')
                        .map(|part| regex::escape(&part.iter().collect::<String>()))
                        .collect();
                    regex.push_str(&format!("(?:{})", alternatives.join("|")));
                    index = end + 1;
                    continue;
                }
                regex.push_str(&regex::escape("{"));
            }
            other => regex.push_str(&regex::escape(&other.to_string())),
        }
        index += 1;
    }
    regex.push('$');
    Regex::new(&regex).map_err(|_| format!("Invalid glob pattern: {pattern}"))
}

/// The globs of one grep, as Node's `createRipgrepSearchPlan` passes them: the version-control directories excluded
/// (`!dir` and `!**/dir/**`), then the caller's globs.
fn grep_globs(glob: Option<&str>) -> Vec<String> {
    let mut globs: Vec<String> = VCS_DIRS
        .iter()
        .flat_map(|dir| [format!("!{dir}"), format!("!**/{dir}/**")])
        .collect();
    globs.extend(glob.map(split_glob_patterns).unwrap_or_default());
    globs
}

/// Node `splitRipgrepGlobPatterns`: split on whitespace, then on commas, unless a token has braces; trim; drop empties.
fn split_glob_patterns(glob: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    for token in glob.split_whitespace() {
        if token.contains('{') && token.contains('}') {
            patterns.push(token.to_owned());
        } else {
            patterns.extend(token.split(',').map(str::to_owned));
        }
    }
    patterns
        .into_iter()
        .map(|pattern| pattern.trim().to_owned())
        .filter(|pattern| !pattern.is_empty())
        .collect()
}

/// The path under `root`, with `/` separators (Node `toPosixRelative`). `None` for a path outside the root.
fn relative_to(root: &Path, path: &str) -> Option<String> {
    let rest = Path::new(path).strip_prefix(root).ok()?;
    Some(rest.to_string_lossy().replace('\\', "/"))
}

/// True when a directory between the root and the file is a version-control directory (Node skips those subtrees).
fn under_vcs_directory(relative: &str) -> bool {
    let mut parts = relative.split('/');
    parts.next_back();
    parts.any(|part| VCS_DIRS.contains(&part))
}

/// Node `decodeTextBuffer` plus `normalizeLineEndings` for a `files.read` (no size guard). A UTF-8 or UTF-16LE byte order
/// mark selects that encoding and is kept in the text, as Node's `Buffer#toString` keeps it. Otherwise binary content
/// (a NUL, or more than 30% control bytes) and bytes that are not UTF-8 are refused with Node's message. Legacy Chinese
/// encodings that Node decodes with iconv are refused here (divergence in spec 9.11). CRLF becomes LF.
fn decode_node_text(bytes: &[u8], path: &str) -> Result<String, String> {
    let refused = || format!("Unsupported or binary text encoding: {path}");
    let text = if bytes.len() >= 3 && bytes[..3] == [0xEF, 0xBB, 0xBF] {
        String::from_utf8_lossy(bytes).into_owned()
    } else if bytes.len() >= 2 && bytes[..2] == [0xFF, 0xFE] {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        char::decode_utf16(units)
            .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    } else if looks_like_binary(bytes) {
        return Err(refused());
    } else {
        std::str::from_utf8(bytes)
            .map_err(|_| refused())?
            .to_owned()
    };
    Ok(text.replace("\r\n", "\n"))
}

/// Node `looksLikeBinary`: any NUL, or more than 30% of the bytes are control characters other than tab, LF, VT, FF, CR.
fn looks_like_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let mut controls = 0usize;
    for &byte in bytes {
        if byte == 0 {
            return true;
        }
        if byte < 0x09 || (byte > 0x0d && byte < 0x20) {
            controls += 1;
        }
    }
    controls as f64 / bytes.len() as f64 > 0.3
}
