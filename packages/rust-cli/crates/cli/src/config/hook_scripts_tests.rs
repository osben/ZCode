//! Entry script reads (specs/fork-rust-hook-script-entry.md): the states Node `readWorkspaceHookScriptState` gives.
#![allow(
    clippy::disallowed_methods,
    reason = "the test lays out entry scripts in a temporary workspace"
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use rust_cli_kernel_api::env::{
    FileContent, FileVersion, OperationContext, WriteFile, WriteReceipt,
};
use rust_cli_kernel_api::env_files::FileStat;
use rust_cli_kernel_api::ids::EnvironmentId;

use super::*;

fn sha(bytes: &[u8]) -> ScriptState {
    ScriptState::File(rust_cli_base::hash::sha256_hex(bytes))
}

#[tokio::test]
async fn local_reads_hash_files_and_tell_missing_from_unverifiable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    std::fs::create_dir_all(dir.path().join("scripts/dir")).unwrap();
    std::fs::write(dir.path().join("scripts/check.sh"), b"echo ok\n").unwrap();
    std::fs::write(dir.path().join("plain"), b"x").unwrap();

    let local = Scripts::Local;
    assert_eq!(
        local.state(root, "scripts/check.sh").await,
        sha(b"echo ok\n")
    );
    assert_eq!(
        local.state(root, "scripts/gone.sh").await,
        ScriptState::Missing
    );
    // A path through a file is ENOTDIR: missing, like Node.
    assert_eq!(local.state(root, "plain/x.sh").await, ScriptState::Missing);
    assert_eq!(
        local.state(root, "scripts/dir").await,
        ScriptState::Unverifiable
    );
}

#[tokio::test]
async fn a_discovery_reads_each_path_once_and_stops_at_its_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    std::fs::write(dir.path().join("a.sh"), b"a").unwrap();
    let states = read_states(
        Scripts::Local,
        root,
        vec!["a.sh".to_owned(), "b.sh".to_owned()],
    )
    .await;
    assert_eq!(states.len(), 2);
    assert_eq!(states["a.sh"], sha(b"a"));
    assert_eq!(states["b.sh"], ScriptState::Missing);

    // Reads still running at the deadline leave no state: their entries are unverifiable.
    let slow = Remote::new(HashMap::new());
    slow.stall.store(1, Ordering::SeqCst);
    let workspace = remote_workspace();
    let states = read_states_within(
        Scripts::Port {
            files: &slow,
            workspace: &workspace,
        },
        "/repo",
        vec!["a.sh".to_owned()],
        Duration::from_millis(20),
    )
    .await;
    assert!(states.is_empty());
}

#[tokio::test]
async fn remote_reads_go_through_the_files_port() {
    let files = Remote::new(HashMap::from([
        ("/repo/run.sh".to_owned(), b"run".to_vec()),
        (
            "/repo/big.sh".to_owned(),
            vec![0; (MAX_SCRIPT_BYTES + 1) as usize],
        ),
    ]));
    let workspace = remote_workspace();
    let scripts = Scripts::of(&files, &workspace);
    assert!(!scripts.is_local());
    assert_eq!(scripts.state("/repo/", "run.sh").await, sha(b"run"));
    assert_eq!(
        scripts.state("/repo", "none.sh").await,
        ScriptState::Missing
    );
    assert_eq!(
        scripts.state("/repo", "big.sh").await,
        ScriptState::Unverifiable
    );
    assert_eq!(
        files.reads.load(Ordering::SeqCst),
        1,
        "a large file is not read"
    );

    let local = WorkspaceRef {
        environment: EnvironmentId::new(rust_cli_node_store::LOCAL_ENVIRONMENT),
        root: EnvPath::new("/repo"),
    };
    assert!(Scripts::of(&files, &local).is_local());
}

fn remote_workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("ssh-box"),
        root: EnvPath::new("/repo"),
    }
}

/// An environment's files: a map of path to bytes; `stall` makes every stat wait forever.
struct Remote {
    files: HashMap<String, Vec<u8>>,
    stall: AtomicUsize,
    reads: AtomicUsize,
}

impl Remote {
    fn new(files: HashMap<String, Vec<u8>>) -> Self {
        Self {
            files,
            stall: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Files for Remote {
    async fn read_file(
        &self,
        _workspace: &WorkspaceRef,
        request: ReadFile,
    ) -> Result<FileContent, EnvError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        match self.files.get(request.path.as_str()) {
            Some(bytes) => Ok(FileContent {
                bytes: bytes.clone(),
                version: FileVersion::new("1"),
            }),
            None => Err(EnvError::NotFound {
                path: request.path.as_str().to_owned(),
            }),
        }
    }

    async fn write_file(
        &self,
        _workspace: &WorkspaceRef,
        _context: OperationContext,
        _request: WriteFile,
    ) -> Result<WriteReceipt, EnvError> {
        unreachable!("scripts are only read")
    }

    async fn stat(
        &self,
        _workspace: &WorkspaceRef,
        request: StatFile,
    ) -> Result<Option<FileStat>, EnvError> {
        if self.stall.load(Ordering::SeqCst) > 0 {
            std::future::pending::<()>().await;
        }
        Ok(self.files.get(request.path.as_str()).map(|bytes| FileStat {
            kind: FileKind::File,
            size: bytes.len() as u64,
            mtime_ms: 0,
            version: FileVersion::new("1"),
        }))
    }
}
