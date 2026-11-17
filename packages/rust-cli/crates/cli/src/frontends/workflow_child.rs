//! Fork: the process of a sandbox child of a dynamic workflow run (specs/fork-rust-workflow-engine.md, 4.1; Q4, Q9).
//! The invocation comes from `protocol-zcode` (execPath, the heap cap, the entry file, `ELECTRON_RUN_AS_NODE=1`); this
//! module only starts it as a process tree owned by this process, as the helper process is started
//! (`node_helper.rs`): killed when its guard drops, and reaped by the next process if this one dies.

use std::io;
use std::path::Path;
use std::process::Stdio;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_proc::ledger::{Containment, Isolation, Ledger, Purpose};
use rust_cli_proc::tree::Shutdown;
use rust_cli_protocol_zcode::{
    ChildCommand, ChildIo, ChildLauncher, ChildStreams, LaunchedChild, child_invocation,
};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncWrite, BufReader};

use super::node_helper::StopOnDrop;

/// Starts sandbox children from the helper command's program and environment.
pub(crate) struct ProcessChildLauncher {
    command: ChildCommand,
    ledger: Ledger,
    spawner: Spawner,
}

impl ProcessChildLauncher {
    pub(crate) fn new(command: ChildCommand, ledger: Ledger, spawner: Spawner) -> Self {
        Self {
            command,
            ledger,
            spawner,
        }
    }
}

#[async_trait]
impl ChildLauncher for ProcessChildLauncher {
    async fn launch(&self, entry: &Path) -> io::Result<LaunchedChild> {
        let invocation = child_invocation(&self.command, entry);
        let mut command = rust_cli_proc::command(&invocation.program);
        command
            .args(&invocation.args)
            .envs(invocation.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Group isolation and an own Job on Windows, as the helper gets: the guard's drop ends the tree.
        let mut tree = self
            .ledger
            .spawn(
                &mut command,
                Purpose::Workflow,
                Isolation::Group,
                Containment::OwnJob,
            )
            .await
            .map_err(|error| io::Error::new(error.kind(), format!("the sandbox child: {error}")))?;
        if !tree.ends_with_drop() {
            let _ = tree.terminate(Shutdown::Graceful).await;
            return Err(io::Error::other(
                "the sandbox child's process tree cannot be contained in its own Job",
            ));
        }
        let child = tree.child();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("the sandbox child has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("the sandbox child has no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("the sandbox child has no stderr"))?;
        let streams: ChildStreams = ChildIo {
            stdout: Box::new(BufReader::new(stdout)) as Box<dyn AsyncBufRead + Send + Unpin>,
            stdin: Box::new(stdin) as Box<dyn AsyncWrite + Send + Unpin>,
            stderr: Box::new(stderr) as Box<dyn AsyncRead + Send + Unpin>,
        };
        Ok(LaunchedChild {
            streams,
            guard: Box::new(StopOnDrop {
                tree: Some(tree),
                spawner: self.spawner.clone(),
            }),
        })
    }
}
