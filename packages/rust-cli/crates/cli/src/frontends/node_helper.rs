//! Fork: the Node helper's launch command and its process (specs/fork-rust-node-helper.md, "Helper command").
//! The Host puts the command in `ZCODE_FORK_NODE_HELPER_COMMAND` as `{"command", "args", "env"}`; Rust runs it as is.
//! The process is a tool-style process tree, so it starts through the process ledger: killed when its handle drops,
//! and reaped by the next process if this one dies.

use std::io;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_proc::ledger::{Containment, Isolation, Ledger, Purpose};
use rust_cli_protocol_zcode::{Context, NodeHelper, NodeHelperLauncher, NodeHelperProcess, Timing};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// The env var the Host sets in Rust mode.
pub(crate) const COMMAND_ENV: &str = "ZCODE_FORK_NODE_HELPER_COMMAND";

/// A parsed helper command. The env is applied on top of the inherited environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Command {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

/// `Ok(None)` when the variable is unset or blank. A refusal names only the field, never its value.
pub(crate) fn parse(raw: Option<&str>) -> Result<Option<Command>, &'static str> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| "the command is not JSON")?;
    let object = value.as_object().ok_or("the command is not an object")?;
    let program = object
        .get("command")
        .and_then(Value::as_str)
        .filter(|program| !program.is_empty())
        .ok_or("command must be a non-empty string")?;
    let args = match object.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or("args must be strings")
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("args must be an array"),
    };
    let env = match object.get("env") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(name, value)| {
                value
                    .as_str()
                    .map(|value| (name.clone(), value.to_owned()))
                    .ok_or("env values must be strings")
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("env must be an object"),
    };
    Ok(Some(Command {
        program: program.to_owned(),
        args,
        env,
    }))
}

/// Starts the helper command as a process tree owned by this process.
pub(crate) struct ProcessLauncher {
    command: Command,
    ledger: Ledger,
    spawner: Spawner,
}

#[async_trait]
impl NodeHelperLauncher for ProcessLauncher {
    async fn launch(&self) -> io::Result<NodeHelperProcess> {
        let mut command = rust_cli_proc::command(&self.command.program);
        command
            .args(&self.command.args)
            .envs(self.command.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Group isolation, as MCP stdio servers get: the helper's children die with it.
        let mut tree = self
            .ledger
            .spawn(
                &mut command,
                Purpose::Mcp,
                Isolation::Group,
                Containment::ProcessJob,
            )
            .await?;
        let child = tree.child();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("the helper has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("the helper has no stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            drop(
                self.spawner
                    .spawn("node-helper-stderr", forward_stderr(stderr)),
            );
        }
        Ok(NodeHelperProcess {
            stdin: Box::new(stdin),
            stdout: Box::new(BufReader::new(stdout)),
            guard: Box::new(tree),
        })
    }
}

async fn forward_stderr(stderr: impl AsyncRead + Unpin + Send + 'static) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(event = "helper.stderr", line = %line, "the node helper wrote to stderr");
    }
}

/// Reads the Host's command from `raw` and, when there is one, installs the helper on `context`. A refused command
/// logs one warning and leaves the families unavailable, as without a helper.
pub(crate) fn install(
    context: &Context,
    raw: Option<&str>,
    temp: &std::path::Path,
    spawner: &Spawner,
) {
    let command = match parse(raw) {
        Ok(Some(command)) => command,
        Ok(None) => return,
        Err(reason) => {
            tracing::warn!(
                event = "helper.command.invalid",
                reason,
                "the node helper command is refused; its methods stay unavailable"
            );
            return;
        }
    };
    let launcher = ProcessLauncher {
        command,
        ledger: Ledger::open(rust_cli_proc::private::user_dir(temp)),
        spawner: spawner.clone(),
    };
    context.set_node_helper(NodeHelper::new(
        Arc::new(launcher),
        spawner.clone(),
        context.peer.clone(),
        Timing::default(),
    ));
}

#[cfg(test)]
#[path = "node_helper_tests.rs"]
mod tests;
