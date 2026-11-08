//! TaskOutput (Node's `task-output.ts` + `task-output-bash.ts`): retrieves output from a
//! running or completed background Bash task.
//!
//! Fork (node_desktop): added for the desktop agent, whose regression drives background Bash
//! through this tool with Node's exact model text (`<retrieval_status>`, `<task_id>`,
//! `<task_type>`, `<status>`, `<output>` …). A running task reads the HEAD of its output file
//! (stable across repeated calls); a completed task reads the TAIL. The environment only knows
//! a task while it runs or until its completion notice is acked — after that the kept output
//! file is the remaining fact, and the status is reported as completed (Node's registry would
//! still know the real terminal state; that divergence is accepted).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use rust_cli_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::StatFile;
use rust_cli_kernel_api::env_shell::{BackgroundStatus, BackgroundTask};
use rust_cli_kernel_api::ids::{MachineName, SessionId, ShellTaskId};
use rust_cli_kernel_api::machine::MachineEnv;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, invalid,
    parse,
};
use rust_cli_kernel_api::tool_names;

use crate::Core;

const NAME: &str = tool_names::TASK_OUTPUT;

/// Node's `TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES`: the head read for a running Bash task.
const RUNNING_PREFIX_BYTES: usize = 30_000;
/// Node's `TASK_OUTPUT_FILE_TAIL_BYTES`: the tail read for a completed task. Larger files are
/// not loaded whole through the files port (it has no ranged read); an honest note replaces
/// Node's omitted-prefix plus tail.
const FILE_TAIL_BYTES: u64 = 8 * 1024 * 1024;
/// Node's `TASK_OUTPUT_DEFAULT_LENGTH`: model-visible character cap; past it the tail keeps the
/// `[Truncated. Full output: …]` prefix.
const DEFAULT_LENGTH_CHARS: usize = 32_000;
/// Node's poll interval while blocking (`TASK_OUTPUT_POLL_INTERVAL_MS`).
const POLL: Duration = Duration::from_millis(100);

#[derive(Deserialize)]
struct Input {
    #[serde(default)]
    task_id: String,
    #[serde(default = "default_block")]
    block: Bool,
    #[serde(default = "default_timeout")]
    timeout: f64,
}

/// Node preprocesses the strings "true"/"false" before the boolean default.
#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum Bool {
    Text(String),
    Flag(bool),
}

impl Bool {
    fn unwrap_or(self, fallback: bool) -> bool {
        match self {
            Self::Text(text) => match text.as_str() {
                "true" => true,
                "false" => false,
                _ => fallback,
            },
            Self::Flag(flag) => flag,
        }
    }
}

fn default_block() -> Bool {
    Bool::Flag(true)
}

fn default_timeout() -> f64 {
    30_000.0
}

/// Where a task was found: the machine it runs on, the session owning it (with that session's
/// workspace for port calls) and its status.
struct Found {
    machine: MachineEnv,
    session: SessionId,
    workspace: WorkspaceRef,
    status: BackgroundStatus,
}

/// A resolved task for the model text.
struct TaskView<'a> {
    id: &'a str,
    status: &'a str,
    output: String,
    output_file: Option<String>,
}

pub(crate) struct TaskOutputTool {
    pub(crate) core: Arc<Core>,
}

impl TaskOutputTool {
    /// The machines to ask: the caller's, then the connected remote machines by name (like
    /// TaskStop).
    fn machines(&self, context: &ToolUseContext) -> Vec<MachineEnv> {
        let registry = &self.core.ports.machines;
        let mut machines = vec![context.machine.clone()];
        machines.extend(
            registry
                .machines()
                .machines
                .iter()
                .filter_map(|remote| registry.machine(&MachineName::new(remote.name.as_str()))),
        );
        machines
    }

    /// The sessions whose background commands this caller can see: its own, plus the child
    /// sessions of this root session when called from the main thread (like TaskStop).
    fn sessions(&self, context: &ToolUseContext) -> Vec<(SessionId, WorkspaceRef)> {
        let mut sessions = vec![(context.session.clone(), context.workspace.clone())];
        if context.agent.is_none() {
            let children = self.core.live.with(|agents| {
                agents
                    .values()
                    .filter(|agent| agent.root == context.session)
                    .map(|agent| (agent.child.clone(), agent.workspace.clone()))
                    .collect::<Vec<_>>()
            });
            sessions.extend(children);
        }
        sessions
    }

    /// Look the task up on every machine and session. `None` when no environment knows it
    /// (finished with its notice acked); the caller then falls back to the kept output file.
    async fn find(&self, id: &str, context: &ToolUseContext) -> Option<Found> {
        let task = ShellTaskId::new(id);
        for machine in self.machines(context) {
            for (session, workspace) in self.sessions(context) {
                let key = BackgroundTask {
                    session: session.clone(),
                    task: task.clone(),
                    notify_stop: false,
                };
                // An environment that does not support background commands counts as not
                // knowing the task, same as unknown.
                if let Ok(Some(info)) = machine.background().background_command(key).await {
                    return Some(Found {
                        machine,
                        session,
                        workspace,
                        status: info.status,
                    });
                }
            }
        }
        None
    }

    /// The fallback for an environment-forgotten task: the first session (on any machine) whose
    /// outputs directory still holds `<task>.output`. Reports where the file was found so the
    /// read goes through the same machine and workspace.
    async fn forgotten(&self, id: &str, context: &ToolUseContext) -> Option<Found> {
        let task = ShellTaskId::new(id);
        for machine in self.machines(context) {
            for (session, workspace) in self.sessions(context) {
                let Ok(state) = machine.shell().shell_state(&workspace, &session).await else {
                    continue;
                };
                let Some(dir) = state.outputs else {
                    continue;
                };
                let path = task_output_path(&dir, &task);
                let exists = machine
                    .files()
                    .stat(&workspace, StatFile { path })
                    .await
                    .ok()
                    .flatten()
                    .is_some();
                if exists {
                    return Some(Found {
                        machine,
                        session,
                        workspace,
                        status: BackgroundStatus::Completed,
                    });
                }
            }
        }
        None
    }

    /// The file read for the task: the head while running, the tail once completed (Node's
    /// `readRunningBashOutputFile` / `readTaskOutputFileSnapshot`). Returns the text and the
    /// output file path (kept when the file was read) for the truncation prefix.
    async fn read_output(&self, found: &Found, task: &str) -> Option<(String, Option<String>)> {
        let running = found.status == BackgroundStatus::Running;
        let state = found
            .machine
            .shell()
            .shell_state(&found.workspace, &found.session)
            .await
            .ok()?;
        let dir = state.outputs?;
        let path = task_output_path(&dir, &ShellTaskId::new(task));
        let files = found.machine.files();
        let size = files
            .stat(&found.workspace, StatFile { path: path.clone() })
            .await
            .ok()?
            .map(|stat| stat.size)
            .unwrap_or(0);
        if size == 0 {
            return Some((String::new(), None));
        }
        if !running && size > FILE_TAIL_BYTES {
            return Some((
                format!("[{size} bytes of output; use Read on the output file for the tail]"),
                None,
            ));
        }
        let bytes = files
            .read_file(&found.workspace, ReadFile { path: path.clone() })
            .await
            .ok()?
            .bytes;
        if running {
            let head = &bytes[..bytes.len().min(RUNNING_PREFIX_BYTES)];
            return Some((
                String::from_utf8_lossy(head).into_owned(),
                Some(path.as_str().to_owned()),
            ));
        }
        let omitted = size.saturating_sub(bytes.len() as u64);
        // Node rounds to whole KB (`Math.round(omittedBytes / 1024)`), it does not truncate.
        let note = if omitted > 0 {
            format!("[{}KB of earlier output omitted]\n", (omitted + 512) / 1024)
        } else {
            String::new()
        };
        Some((
            format!("{note}{}", String::from_utf8_lossy(&bytes)),
            Some(path.as_str().to_owned()),
        ))
    }
}

/// `<outputs dir>/<task>.output` — the task's output file as addressed through
/// `ShellState::outputs` (a symlink to the desktop file under the desktop layout).
fn task_output_path(dir: &EnvPath, task: &ShellTaskId) -> EnvPath {
    EnvPath::new(format!("{}/{}.output", dir.as_str(), task.as_str()))
}

/// Node's `truncateTaskOutput`: over the cap the tail keeps a prefix naming the full output.
fn truncate(output: &str, output_file: Option<&str>) -> String {
    let Some(path) = output_file else {
        return output.to_owned();
    };
    let count = output.chars().count();
    if count <= DEFAULT_LENGTH_CHARS {
        return output.to_owned();
    }
    let prefix = format!("[Truncated. Full output: {path}]\n\n");
    let keep = DEFAULT_LENGTH_CHARS.saturating_sub(prefix.chars().count());
    let tail: String = output.chars().skip(count - keep).collect();
    format!("{prefix}{tail}")
}

/// Node's `formatTaskOutputModelContent`.
fn model_text(retrieval: &str, task: &TaskView<'_>) -> String {
    let mut blocks = vec![
        format!("<retrieval_status>{retrieval}</retrieval_status>"),
        format!("<task_id>{}</task_id>", task.id),
        "<task_type>local_bash</task_type>".to_owned(),
        format!("<status>{}</status>", task.status),
    ];
    if !task.output.trim().is_empty() {
        let content = truncate(&task.output, task.output_file.as_deref());
        blocks.push(format!("<output>\n{}\n</output>", content.trim_end()));
    }
    blocks.join("\n\n")
}

fn not_found(id: &str) -> String {
    format!("No task found with ID: {id}")
}

#[async_trait]
impl Tool for TaskOutputTool {
    fn name(&self) -> &str {
        NAME
    }

    /// Node marks the tool deferred (`shouldDefer: true`).
    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("read output from a background task")
    }

    fn input_schema(&self) -> Value {
        rust_cli_prompts::definition(NAME).schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        rust_cli_prompts::definition(NAME).description.clone()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let Ok(parsed) = parse::<Input>(input) else {
            return invalid("task_id must be a string".to_owned());
        };
        let id = parsed.task_id.trim().to_owned();
        if id.is_empty() {
            return invalid("Task ID is required".to_owned());
        }
        if self.known(&id, context).await.is_none() {
            return invalid(not_found(&id));
        }
        Validation::Ok
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let parsed: Input = parse(&input)?;
        let id = parsed.task_id.trim().to_owned();
        if id.is_empty() {
            return Err(ToolError::Failed {
                message: "Task ID is required".to_owned(),
            });
        }
        let block = parsed.block.unwrap_or(true);
        let timeout = Duration::from_millis(parsed.timeout.max(0.0) as u64);
        // `find` first, then the kept-file fallback; together they decide "known".
        let mut found = self.known(&id, &context).await;
        if block {
            let deadline = tokio::time::Instant::now() + timeout;
            while found
                .as_ref()
                .is_some_and(|found| found.status == BackgroundStatus::Running)
                && tokio::time::Instant::now() < deadline
            {
                if context.cancel.is_cancelled() {
                    return Err(ToolError::Cancelled);
                }
                tokio::time::sleep(POLL).await;
                found = self.known(&id, &context).await;
            }
        }
        let Some(found) = found else {
            return Err(ToolError::Failed {
                message: not_found(&id),
            });
        };
        let retrieval = if found.status == BackgroundStatus::Running {
            if block { "timeout" } else { "not_ready" }
        } else {
            "success"
        };
        let (output, output_file) = self.read_output(&found, &id).await.unwrap_or_default();
        let view = TaskView {
            id: &id,
            status: found.status.as_str(),
            output,
            output_file,
        };
        Ok(rust_cli_kernel_api::tool::text(model_text(
            retrieval, &view,
        )))
    }
}

impl TaskOutputTool {
    /// A task this caller can see: live or unacked in an environment, or forgotten but with its
    /// kept output file still present.
    async fn known(&self, id: &str, context: &ToolUseContext) -> Option<Found> {
        match self.find(id, context).await {
            Some(found) => Some(found),
            None => self.forgotten(id, context).await,
        }
    }
}

#[cfg(test)]
#[path = "task_output_tests.rs"]
mod tests;
