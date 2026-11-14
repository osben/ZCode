//! Fork: the Node-compatible stdin of one command hook run and its transcript file (Node `createCompatibleHookStdin`,
//! specs/fork-rust-agent-parity.md "Command hook stdin").

use std::sync::Arc;

use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};
use serde_json::{Map, Value};
use tokio::task::JoinHandle;

use crate::input;
use crate::run::HookPorts;

/// The Node stdin of an event, before the transcript path is known.
pub(crate) struct NodeStdin {
    pub input: Map<String, Value>,
    pub transcript: String,
}

/// The stdin text of one command hook run and the guard that removes its transcript directory.
pub(crate) struct Staged {
    pub text: String,
    pub guard: Option<TranscriptGuard>,
}

/// Removes one transcript directory (Node removes it in the callback's `finally`). The owner awaits [`Self::remove`];
/// a guard dropped without it (the run's future dropped, a panic) removes the directory in a spawned task, or
/// synchronously where that task cannot run (no runtime, or the runtime shutting down). Either way one task owns the
/// removal.
pub(crate) struct TranscriptGuard {
    removal: Option<Removal>,
}

struct Removal {
    transcripts: Arc<dyn HookTranscripts>,
    file: HookTranscript,
    /// The file's write runs in its own task: a dropped run cannot stop a write already under way, so the removal
    /// waits for it first (removing while it runs would leave the new file behind).
    write: Option<JoinHandle<std::io::Result<()>>>,
    /// Set before the first await on [`HookTranscripts::remove`]: a removal dropped from then on (the runtime shutting
    /// down with it in flight) leaves the directory to the blocking removal already under way.
    started: bool,
}

/// Writes the transcript of one run, in its own directory (as Node). The guard exists before the file does, so a run
/// dropped while the file is written still removes the directory, once the write has ended.
pub(crate) async fn stage(
    ports: &HookPorts,
    transcripts: &Arc<dyn HookTranscripts>,
    node: &NodeStdin,
) -> Staged {
    let (mut guard, file) = match place(ports, transcripts, &node.transcript) {
        Ok(placed) => placed,
        Err(error) => {
            tracing::warn!(error = %error, "hook transcript file could not be placed");
            return Staged {
                text: input::with_transcript(node.input.clone(), ""),
                guard: None,
            };
        }
    };
    match guard.written().await {
        Ok(()) => Staged {
            text: input::with_transcript(node.input.clone(), &file.path),
            guard: Some(guard),
        },
        Err(error) => {
            tracing::warn!(error = %error, "hook transcript file could not be written");
            // The guard still removes what the failed write left.
            Staged {
                text: input::with_transcript(node.input.clone(), ""),
                guard: Some(guard),
            }
        }
    }
}

/// Locates the file and starts its write; the guard owns both before the first await.
fn place(
    ports: &HookPorts,
    transcripts: &Arc<dyn HookTranscripts>,
    text: &str,
) -> std::io::Result<(TranscriptGuard, HookTranscript)> {
    let file = transcripts.locate(&format!("zcode-hook-{}", ports.ids.execution()))?;
    let write = {
        let transcripts = transcripts.clone();
        let file = file.clone();
        let text = text.to_owned();
        tokio::spawn(async move { transcripts.create(&file, &text).await })
    };
    let guard = TranscriptGuard {
        removal: Some(Removal {
            transcripts: transcripts.clone(),
            file: file.clone(),
            write: Some(write),
            started: false,
        }),
    };
    Ok((guard, file))
}

impl TranscriptGuard {
    /// Waits for the file's write.
    async fn written(&mut self) -> std::io::Result<()> {
        match self.removal.as_mut() {
            Some(removal) => removal.written().await,
            None => Ok(()),
        }
    }

    pub(crate) async fn remove(mut self) {
        // One owner: the removal runs in its own task, so a drop of this future neither stops it nor starts a second
        // removal beside it (the guard is empty from here). A runtime shutting down drops the task unpolled, and
        // `Pending` then removes the directory synchronously.
        let Some(removal) = self.removal.take() else {
            return;
        };
        let _ = tokio::spawn(Pending(Some(removal)).run()).await;
    }
}

impl Removal {
    async fn written(&mut self) -> std::io::Result<()> {
        let Some(write) = self.write.as_mut() else {
            return Ok(());
        };
        let written = write.await;
        self.write = None;
        written.unwrap_or_else(|error| Err(std::io::Error::other(error)))
    }

    async fn run(&mut self) {
        // A failed write already logged; the directory goes either way.
        let _ = self.written().await;
        self.started = true;
        if let Err(error) = self.transcripts.remove(&self.file).await {
            tracing::warn!(error = %error, "hook transcript directory could not be removed");
        }
    }

    fn now(&self) {
        if let Err(error) = self.transcripts.remove_blocking(&self.file) {
            tracing::warn!(error = %error, "hook transcript directory could not be removed");
        }
    }
}

/// A removal handed to a spawned task. A runtime that shuts down drops the task before it ran or while it waits; the
/// drop then removes the directory synchronously, unless the removal already started (it is on the blocking pool).
struct Pending(Option<Removal>);

impl Pending {
    async fn run(mut self) {
        if let Some(removal) = self.0.as_mut() {
            removal.run().await;
        }
        self.0 = None;
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(removal) = self.0.take().filter(|removal| !removal.started) {
            removal.now();
        }
    }
}

impl Drop for TranscriptGuard {
    fn drop(&mut self) {
        let Some(removal) = self.removal.take() else {
            return;
        };
        let pending = Pending(Some(removal));
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => drop(handle.spawn(pending.run())),
            Err(_) => drop(pending),
        }
    }
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
