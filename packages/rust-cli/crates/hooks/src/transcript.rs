//! Fork: the Node-compatible stdin of one command hook run and its transcript file (Node `createCompatibleHookStdin`,
//! specs/fork-rust-agent-parity.md "Command hook stdin").

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::env::CommandEvent;
use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};
use rust_cli_kernel_api::machine::CommandEvents;
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
/// synchronously where that task cannot run (no runtime, or the runtime shutting down).
pub(crate) struct TranscriptGuard {
    removal: Option<Removal>,
}

struct Removal {
    transcripts: Arc<dyn HookTranscripts>,
    file: HookTranscript,
    /// The file's write runs in its own task: a dropped run cannot stop a write already under way, so the removal
    /// waits for it first (removing while it runs would leave the new file behind).
    write: Option<JoinHandle<std::io::Result<()>>>,
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
        // The removal stays in the guard until it ends, so a drop mid-way still removes the directory.
        if let Some(removal) = self.removal.as_mut() {
            removal.run().await;
        }
        self.removal = None;
    }

    /// An async hook keeps its transcript until its process ends (Node removes it when the background run settles).
    pub(crate) async fn remove_after(self, mut events: CommandEvents) {
        while let Some(event) = events.next().await {
            if matches!(event, Ok(CommandEvent::Finished { .. }) | Err(_)) {
                break;
            }
        }
        self.remove().await;
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

/// A removal handed to a spawned task. A runtime that shuts down drops the task without running it; the drop then
/// removes the directory synchronously.
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
        if let Some(removal) = self.0.take() {
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
