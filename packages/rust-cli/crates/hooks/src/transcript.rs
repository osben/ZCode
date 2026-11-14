//! Fork: the Node-compatible stdin of one command hook run and its transcript file (Node `createCompatibleHookStdin`,
//! specs/fork-rust-agent-parity.md "Command hook stdin").

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::env::CommandEvent;
use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};
use rust_cli_kernel_api::machine::CommandEvents;
use serde_json::{Map, Value};

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
/// a guard dropped without it (the run's future dropped, a panic) removes the directory in a spawned task.
pub(crate) struct TranscriptGuard {
    file: Option<(Arc<dyn HookTranscripts>, HookTranscript)>,
}

/// Writes the transcript of one run, in its own directory (as Node). The guard exists before the file does, so a run
/// dropped while the file is written still removes the directory. If the drop lands inside the write itself, the
/// write can still finish after the spawned removal; that window is the write's own duration.
pub(crate) async fn stage(
    ports: &HookPorts,
    transcripts: &Arc<dyn HookTranscripts>,
    node: &NodeStdin,
) -> Staged {
    let (guard, file) = match guard(ports, transcripts) {
        Ok(placed) => placed,
        Err(error) => {
            tracing::warn!(error = %error, "hook transcript file could not be placed");
            return Staged {
                text: input::with_transcript(node.input.clone(), ""),
                guard: None,
            };
        }
    };
    match transcripts.create(&file, &node.transcript).await {
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

/// A plain fn, so the guard is built before the first await of the run (an async fn would build it only when polled
/// past that point).
fn guard(
    ports: &HookPorts,
    transcripts: &Arc<dyn HookTranscripts>,
) -> std::io::Result<(TranscriptGuard, HookTranscript)> {
    let file = transcripts.locate(&format!("zcode-hook-{}", ports.ids.execution()))?;
    let guard = TranscriptGuard {
        file: Some((transcripts.clone(), file.clone())),
    };
    Ok((guard, file))
}

impl TranscriptGuard {
    pub(crate) async fn remove(mut self) {
        if let Some((transcripts, file)) = self.file.take() {
            remove(transcripts.as_ref(), &file).await;
        }
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

impl Drop for TranscriptGuard {
    fn drop(&mut self) {
        let Some((transcripts, file)) = self.file.take() else {
            return;
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move { remove(transcripts.as_ref(), &file).await });
            }
            Err(_) => {
                tracing::warn!(dir = %file.dir, "hook transcript directory left behind: no runtime")
            }
        }
    }
}

async fn remove(transcripts: &dyn HookTranscripts, file: &HookTranscript) {
    if let Err(error) = transcripts.remove(file).await {
        tracing::warn!(error = %error, "hook transcript directory could not be removed");
    }
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
