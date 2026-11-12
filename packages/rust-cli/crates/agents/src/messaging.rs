//! ListAgents、SendMessage（docs/specs/rust-cli/agents.md §6）：本进程里启动过的子代理与本机的同伴会话
//! （docs/specs/rust-cli/cross-session.md，F28；段落与同伴寻址在 `peer_send`）。描述与 schema 在 `prompts/tools/`
//! （ListAgents、SendMessage），删掉了不实的产品句（cross-session.md §2.7）。TaskStop 在 `task_stop`。

use crate::live::Enqueued;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::ids::{AgentId, CommandId};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, parse,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::Core;
use crate::spawn;
use crate::task_stop::TaskStopTool;
use rust_cli_kernel_api::tool_names;

pub(crate) fn tools(core: &Arc<Core>) -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> = [Kind::ListAgents, Kind::SendMessage]
        .into_iter()
        .map(|kind| {
            Arc::new(Messaging {
                core: core.clone(),
                kind,
            }) as Arc<dyn Tool>
        })
        .collect();
    tools.push(Arc::new(TaskStopTool { core: core.clone() }));
    tools
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    ListAgents,
    SendMessage,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::ListAgents => tool_names::LIST_AGENTS,
            Self::SendMessage => tool_names::SEND_MESSAGE,
        }
    }
}

struct Messaging {
    core: Arc<Core>,
    kind: Kind,
}

#[derive(Deserialize)]
struct SendInput {
    to: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    message: String,
}

impl Messaging {
    /// 段落格式：自己那一段、子代理、同伴会话（cross-session.md §1.3）。
    async fn list(&self, context: &ToolUseContext) -> ToolOutput {
        rust_cli_kernel_api::tool::text(crate::peer_send::listing(&self.core, context).await)
    }

    async fn send(
        &self,
        input: SendInput,
        context: &ToolUseContext,
    ) -> Result<ToolOutput, ToolError> {
        let id = AgentId::new(input.to.trim());
        let known = self
            .core
            .live
            .get(&id)
            // Fork: an erased agent's session rows are gone; it is no longer addressable (a restart would write into
            // the erased session).
            .filter(|agent| agent.parent == context.session && !agent.erased);
        let Some(agent) = known else {
            // 进程内没有：按本机的同伴会话寻址（cross-session.md §1.4）。都没有时是打开跨会话后的
            // `No agent named '<to>' is reachable.`（结果 `success: false`、不标 is_error）。以前是关闭跨会话时的
            // `… is currently addressable …`，并标 is_error。
            let text = crate::peer_send::send(
                &self.core,
                &input.to,
                input.summary.as_deref(),
                &input.message,
                context,
            )
            .await;
            return Ok(rust_cli_kernel_api::tool::text(text));
        };
        match self
            .core
            .live
            .enqueue(&id, input.message.clone(), &context.tool_use)
        {
            // Fork: a later message after the stop waits for the run the first one resumes: Node queues it to that
            // running agent (core `runner.ts`).
            Enqueued::Steered | Enqueued::AfterStop { first: false } => {
                return Ok(rust_cli_kernel_api::tool::text(steered_text(
                    &self.core.ports.ids.command(),
                    input.to.trim(),
                )));
            }
            // Fork: a stop claimed the run; it resumes with this message once it settles (`routing::settle`).
            Enqueued::AfterStop { first: true } => {
                return Ok(rust_cli_kernel_api::tool::text(resumed_text(
                    self.core.node_desktop,
                    &input.to,
                    "killed",
                )));
            }
            Enqueued::NotRunning => {}
        }
        // 已结束：在后台续跑子会话。
        let status = agent.status().as_str();
        // Fork: on the desktop the resumed run belongs to this SendMessage call (Node's notification carries its
        // `<tool-use-id>`); the TUI keeps the earlier call.
        let tool_use = if self.core.node_desktop {
            Some(context.tool_use.clone())
        } else {
            agent.tool_use.clone()
        };
        let Some(claimed) = self.core.live.restart(&id, Abort::new(), tool_use) else {
            // 并发的另一条消息刚刚让它跑起来：排进邮箱。
            let text = match self
                .core
                .live
                .enqueue(&id, input.message.clone(), &context.tool_use)
            {
                Enqueued::AfterStop { first: true } => {
                    resumed_text(self.core.node_desktop, &input.to, "killed")
                }
                Enqueued::Steered | Enqueued::AfterStop { first: false } | Enqueued::NotRunning => {
                    steered_text(&self.core.ports.ids.command(), input.to.trim())
                }
            };
            return Ok(rust_cli_kernel_api::tool::text(text));
        };
        // Fork: the forwarder claimed by the restart starts before the resumed run, so a command of that run has a
        // consumer from its first turn.
        if let Some(started) = claimed {
            crate::shell_notices::start(&self.core, &agent.child, &agent.root, started);
        }
        let origin = rust_cli_kernel_api::message::UserOrigin::Human;
        let opening = match spawn::resume(&self.core, &agent, &input.message, origin).await {
            Ok(opening) => opening,
            Err(error) => {
                self.core.live.finish(&id, crate::report::Ending::Failed);
                return Err(ToolError::Failed {
                    message: error.to_string(),
                });
            }
        };
        let Some(running) = self.core.live.get(&id) else {
            return Err(ToolError::Failed {
                message: "the agent disappeared".to_owned(),
            });
        };
        spawn::background(&self.core, running, opening);
        Ok(rust_cli_kernel_api::tool::text(resumed_text(
            self.core.node_desktop,
            &input.to,
            status,
        )))
    }
}

/// The reply to a message that resumes a stopped agent. Fork: the desktop reads Node's wording (core subagent/runner.ts
/// resume text); zcode-rs has no per-agent output file, so Node's trailing `Output:` path is absent.
fn resumed_text(node_desktop: bool, to: &str, status: &str) -> String {
    if node_desktop {
        format!(
            "Agent \"{to}\" was stopped ({status}); resumed it in the background with your message. You'll be notified when it finishes."
        )
    } else {
        format!(
            "Agent \"{to}\" was stopped ({status}); it was resumed in the background with your message. You'll be notified when it finishes."
        )
    }
}

#[async_trait]
impl Tool for Messaging {
    fn name(&self) -> &str {
        self.kind.name()
    }

    /// 延迟加载（docs/specs/rust-cli/tools-more.md §3.1）：ListAgents 内联，SendMessage 延迟。
    fn should_defer(&self) -> bool {
        self.kind == Kind::SendMessage
    }

    /// ToolSearch 的关键词提示。
    fn search_hint(&self) -> Option<&str> {
        Some(match self.kind {
            Kind::ListAgents => "list agents you can SendMessage to",
            Kind::SendMessage => "send messages to agent teammates",
        })
    }

    fn input_schema(&self) -> Value {
        rust_cli_prompts::definition(self.kind.name())
            .schema
            .clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        rust_cli_prompts::definition(self.kind.name())
            .description
            .clone()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        self.kind == Kind::ListAgents
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.kind == Kind::ListAgents
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
        value: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        match self.kind {
            Kind::ListAgents => Ok(self.list(&context).await),
            Kind::SendMessage => {
                let input = parse(&value)?;
                self.send(input, &context).await
            }
        }
    }
}

/// Node 3.17 steers a message for a running agent into its active turn (`message-steering.ts`, delivery
/// `steered`) and answers with this text; the mailbox here delivers at the same boundary, the next model request.
/// Node's message id is `msg_<uuid>`; the native `command` id is a bare uuid.
pub(crate) fn steered_text(id: &CommandId, agent: &str) -> String {
    format!(
        "Message msg_{} was sent to its active turn for local agent {agent}.",
        id.as_str()
    )
}

#[cfg(test)]
#[path = "messaging_tests.rs"]
mod tests;
