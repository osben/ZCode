//! Fork: the Node-compatible stdin of one command hook run and its transcript file (Node `createCompatibleHookStdin`,
//! specs/fork-rust-agent-parity.md "Command hook stdin").

use std::sync::Arc;

use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};
use serde_json::{Map, Value};

use crate::input;
use crate::run::HookPorts;

/// The Node stdin of an event, before the transcript path is known.
pub(crate) struct NodeStdin {
    pub input: Map<String, Value>,
    pub transcript: String,
}

/// The stdin text of one command hook run and the transcript file to remove after it.
pub(crate) struct Staged {
    pub text: String,
    file: Option<(Arc<dyn HookTranscripts>, HookTranscript)>,
}

/// Writes the transcript of a foreground run (one directory per run, as Node). A backgrounded (`async`) hook gets
/// `transcript_path: ""`: Rust does not follow it to its end, so it could not remove the file in time.
pub(crate) async fn stage(
    ports: &HookPorts,
    transcripts: &Arc<dyn HookTranscripts>,
    node: &NodeStdin,
    background: bool,
) -> Staged {
    if background {
        return Staged {
            text: input::with_transcript(node.input.clone(), ""),
            file: None,
        };
    }
    let name = format!("zcode-hook-{}", ports.ids.execution());
    match transcripts.create(&name, &node.transcript).await {
        Ok(file) => Staged {
            text: input::with_transcript(node.input.clone(), &file.path),
            file: Some((transcripts.clone(), file)),
        },
        Err(error) => {
            tracing::warn!(error = %error, "hook transcript file could not be written");
            Staged {
                text: input::with_transcript(node.input.clone(), ""),
                file: None,
            }
        }
    }
}

impl Staged {
    pub(crate) async fn remove(self) {
        if let Some((transcripts, file)) = self.file
            && let Err(error) = transcripts.remove(&file).await
        {
            tracing::warn!(error = %error, "hook transcript directory could not be removed");
        }
    }
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
