//! Fork: the Node helper's launch command and its process (specs/fork-rust-node-helper.md, "Helper command").
//! The Host puts the command in `ZCODE_FORK_NODE_HELPER_COMMAND` as `{"command", "args", "env"}`; Rust runs it as is.
//! The process is a tool-style process tree, so it starts through the process ledger: killed when its handle drops,
//! and reaped by the next process if this one dies.

use std::io;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_base::names::env::ZCODE_FORK_NODE_HELPER_COMMAND;
use rust_cli_proc::ledger::{Containment, Isolation, Ledger, Purpose, Tracked};
use rust_cli_proc::tree::Shutdown;
use rust_cli_protocol_zcode::{
    Context, NodeHelper, NodeHelperLauncher, NodeHelperProcess, NodeHelperTiming,
};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, BufReader};

/// The env var the Host sets in Rust mode.
pub(crate) const COMMAND_ENV: &str = ZCODE_FORK_NODE_HELPER_COMMAND;

/// A parsed helper command. The env is applied on top of the inherited environment.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Command {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

/// Names only: the Host may pass credentials in `env`, so a value never reaches a log through `{:?}`.
impl std::fmt::Debug for Command {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Command")
            .field("program", &self.program)
            .field("args", &self.args.len())
            .field(
                "env",
                &self.env.iter().map(|(name, _)| name).collect::<Vec<_>>(),
            )
            .finish()
    }
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
        .map(str::trim)
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

/// The program's file name only: the directory can hold the user's name, and launch failures are logged.
fn program_file(program: &str) -> String {
    std::path::Path::new(program).file_name().map_or_else(
        || program.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
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
        // Group isolation, as MCP stdio servers get: the helper's children die with it. Its own Job, unlike MCP
        // servers: the helper is ended only by dropping its guard (idle reclaim, timeout, crash restart), and on
        // Windows only an own Job is closed, ending the tree, when the guard drops. The process Job would keep each
        // dropped helper alive until this process exits.
        let mut tree = self
            .ledger
            .spawn(
                &mut command,
                Purpose::Mcp,
                Isolation::Group,
                Containment::OwnJob,
            )
            .await
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("{}: {error}", program_file(&self.command.program)),
                )
            })?;
        if !tree.ends_with_drop() {
            // Windows fell back to the process Job: dropping the guard would end nothing, and every reclaimed or
            // timed-out helper would live on until this process exits. A failed launch instead (cooldown, warning).
            let _ = tree.terminate(Shutdown::Graceful).await;
            return Err(io::Error::other(format!(
                "{}: the helper process tree cannot be contained in its own Job",
                program_file(&self.command.program)
            )));
        }
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
            guard: Box::new(StopOnDrop {
                tree: Some(tree),
                spawner: self.spawner.clone(),
            }),
        })
    }
}

/// The helper's process tree, stopped when the helper drops it (idle reclaim, timeout, crash restart). The stop runs
/// in a task so it is confirmed: the tree is reaped and its ledger record removed, instead of one record per
/// generation waiting for the next process's sweep. If the task never runs (the scope is closing), dropping the tree
/// still kills it.
struct StopOnDrop {
    tree: Option<Tracked>,
    spawner: Spawner,
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        let Some(mut tree) = self.tree.take() else {
            return;
        };
        drop(self.spawner.spawn("node-helper-stop", async move {
            if let Err(error) = tree.terminate(Shutdown::Graceful).await {
                tracing::debug!(
                    event = "helper.stop_unconfirmed",
                    %error,
                    "the node helper's process tree could not be confirmed stopped"
                );
            }
        }));
    }
}

async fn forward_stderr(stderr: impl AsyncRead + Unpin + Send + 'static) {
    read_lines(BufReader::new(stderr), |line| {
        tracing::debug!(event = "helper.stderr", line = %line, "the node helper wrote to stderr");
    })
    .await;
}

/// Reads lines until end of input or a read error. Bytes that are not UTF-8 are replaced, so one bad byte neither
/// ends the reader nor closes the pipe on the helper.
async fn read_lines(mut reader: impl AsyncBufRead + Unpin, mut line: impl FnMut(String)) {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) => return,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buffer);
                line(text.trim_end_matches(['\n', '\r']).to_owned());
            }
            Err(error) => {
                tracing::debug!(
                    event = "helper.stderr.closed",
                    error = %error,
                    "the node helper's stderr could not be read"
                );
                return;
            }
        }
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
        NodeHelperTiming::default(),
    ));
}

#[cfg(test)]
#[path = "node_helper_tests.rs"]
mod tests;
