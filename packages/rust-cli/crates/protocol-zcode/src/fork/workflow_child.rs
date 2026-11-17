//! Fork: the sandbox child's command (specs/fork-rust-workflow-engine.md, 4.1; decisions Q4 and Q9).
//!
//! Rust spawns the child, because the run's abort, lifetime and settlement are Rust's. The program is the helper
//! command's `execPath` with the helper command's environment, so the child runs on the same Node the helper runs on.
//! The entry file is self-contained, so the child takes no bundle argument. The process itself comes from the
//! injected [`ChildLauncher`]: this crate spawns nothing, as the helper's launcher is injected too.

use std::io;
use std::path::Path;

use async_trait::async_trait;
use tokio::io::{AsyncBufRead, AsyncRead, AsyncWrite};

use super::workflow_host::ChildIo;

/// The V8 heap cap of a sandbox child, in MB (Node's `harness.ts` default).
pub const MAX_OLD_SPACE_MB: u32 = 256;

/// The helper command's program and environment (`ZCODE_FORK_NODE_HELPER_COMMAND`, `command` and `env`).
#[derive(Clone, PartialEq, Eq)]
pub struct ChildCommand {
    pub program: String,
    pub env: Vec<(String, String)>,
}

/// Names only: the environment can carry credentials, so no value reaches a log through `{:?}`.
impl std::fmt::Debug for ChildCommand {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChildCommand")
            .field(
                "env",
                &self.env.iter().map(|(name, _)| name).collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// What a launcher starts: the program, its arguments and the environment (the inherited one plus these).
#[derive(Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Names only, as [`ChildCommand`]: the program path and the arguments (the entry file's directory) can hold the user's
/// name, and the environment can carry credentials, so only the argument count and the environment names are printed.
impl std::fmt::Debug for Invocation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Invocation")
            .field("args", &self.args.len())
            .field(
                "env",
                &self.env.iter().map(|(name, _)| name).collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// The invocation of one child for `entry`: `execPath --max-old-space-size=256 <entry>` with `ELECTRON_RUN_AS_NODE=1`.
pub fn invocation(command: &ChildCommand, entry: &Path) -> Invocation {
    let mut env: Vec<(String, String)> = command
        .env
        .iter()
        .filter(|(name, _)| name != "ELECTRON_RUN_AS_NODE")
        .cloned()
        .collect();
    env.push(("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned()));
    Invocation {
        program: command.program.clone(),
        args: vec![
            format!("--max-old-space-size={MAX_OLD_SPACE_MB}"),
            entry.to_string_lossy().into_owned(),
        ],
        env,
    }
}

/// The three stdio ends of a started child, boxed so the host is not generic over the launcher.
pub type ChildStreams = ChildIo<
    Box<dyn AsyncBufRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
    Box<dyn AsyncRead + Send + Unpin>,
>;

/// A started child: its stdio, and a guard whose drop ends the process tree.
pub struct LaunchedChild {
    pub streams: ChildStreams,
    pub guard: Box<dyn Send>,
}

/// Starts sandbox children for an entry file. The implementation owns the child's process tree, and builds its
/// invocation with [`invocation`] from the helper command it was given.
#[async_trait]
pub trait ChildLauncher: Send + Sync {
    async fn launch(&self, entry: &Path) -> io::Result<LaunchedChild>;
}

#[cfg(test)]
#[path = "workflow_child_tests.rs"]
mod tests;
