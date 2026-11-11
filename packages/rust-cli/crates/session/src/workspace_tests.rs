//! 工作目录的 owner 是会话 actor（docs/specs/rust-cli/tools-more.md §11.4）：工具改了目录后，同一回合里
//! 后续的工具调用立即在新目录，执行环境的 shell cwd 一并设好；执行环境拒绝时目录不变。

use rust_cli_base::sync::LockUnpoisoned;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvError, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::machine::{MachineEnv, Shell};
use rust_cli_kernel_api::message::{ContentBlock, Message, ToolResultContent};
use rust_cli_kernel_api::session_api::{SessionHandle, StartSource};
use rust_cli_kernel_api::testing::{
    MemoryEnvironment, ScriptedModel, text_response, tool_use_response, unsupported_machine,
};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::test_support::{GatedModel, Setup, env, finished, submit, until};

/// 内存执行环境，另外记下 shell cwd；`refuse` 时拒绝设置。
struct CwdEnv {
    inner: Arc<MemoryEnvironment>,
    cwd: Mutex<Vec<String>>,
    refuse: bool,
}

impl CwdEnv {
    /// 环境事实、文件与命令是内存执行环境的，shell 是自己的；其余端口返回 `Unsupported`。
    fn machine(self: Arc<Self>) -> MachineEnv {
        unsupported_machine()
            .with_info(self.inner.clone())
            .with_files(self.inner.clone())
            .with_commands(self.inner.clone())
            .with_shell(self)
    }
}

#[async_trait]
impl Shell for CwdEnv {
    async fn set_shell_cwd(&self, _session: &SessionId, cwd: EnvPath) -> Result<(), EnvError> {
        if self.refuse {
            return Err(EnvError::Unsupported {
                what: "set_shell_cwd".to_owned(),
            });
        }
        self.cwd.lock_unpoisoned().push(cwd.as_str().to_owned());
        Ok(())
    }
}

/// `Switch` 请求改目录；`Where` 报告自己的工具上下文里的目录。
struct DirTool(&'static str);

#[async_trait]
impl Tool for DirTool {
    fn name(&self) -> &str {
        self.0
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    fn description(&self, _context: &PromptContext) -> String {
        String::new()
    }

    async fn call(
        &self,
        _input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let text = if self.0 == "Switch" {
            match context
                .session_ops
                .set_workspace(EnvPath::new("/work/.zcode/worktrees/a"))
                .await
            {
                Ok(()) => "switched".to_owned(),
                Err(error) => error.to_string(),
            }
        } else {
            context.workspace.root.as_str().to_owned()
        };
        Ok(ToolOutput {
            content: vec![ToolResultContent::Text { text }],
            is_error: false,
            display: Value::Null,
        })
    }
}

async fn run(refuse: bool) -> (Vec<String>, Vec<String>, String) {
    let model = Arc::new(ScriptedModel::new(vec![
        tool_use_response("toolu_1", "Switch", &json!({})),
        tool_use_response("toolu_2", "Where", &json!({})),
        text_response(&["done"]),
    ]));
    let cwd_env = Arc::new(CwdEnv {
        inner: env(),
        cwd: Mutex::default(),
        refuse,
    });
    let mut setup = Setup::new(model);
    setup.set_machine(cwd_env.clone().machine());
    setup.tools = vec![Arc::new(DirTool("Switch")), Arc::new(DirTool("Where"))];
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "go")).await;
    until(&mut events, finished).await;
    let view = built.session.view().await.unwrap();
    let results = view
        .messages
        .iter()
        .flat_map(|message| match message {
            Message::User(user) => user.content.clone(),
            _ => Vec::new(),
        })
        .filter_map(|block| match block {
            ContentBlock::ToolResult { content, .. } => match content.as_slice() {
                [ToolResultContent::Text { text }] => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    let cwd = cwd_env.cwd.lock_unpoisoned().clone();
    (results, cwd, view.meta.workspace.root.as_str().to_owned())
}

#[tokio::test]
async fn a_workspace_change_applies_to_the_next_tool_call_in_the_same_turn() {
    let (results, cwd, root) = run(false).await;
    assert_eq!(results, ["switched", "/work/.zcode/worktrees/a"]);
    assert_eq!(cwd, ["/work/.zcode/worktrees/a"]);
    assert_eq!(root, "/work/.zcode/worktrees/a");
}

#[tokio::test]
async fn a_refused_shell_cwd_keeps_the_old_workspace() {
    let (results, cwd, root) = run(true).await;
    assert_eq!(results.len(), 2);
    assert_eq!(results[1], "/work");
    assert!(cwd.is_empty());
    assert_eq!(root, "/work");
}

/// 复现（R1-3）：以前工具改了工作目录（EnterWorktree / ExitWorktree）不发事件，前端只能自存一份目录，只有 `/cd`
/// 才更新它——之后的 `/diff`、`@` 补全、`/export`、`/permissions` 用旧目录。现在 actor 改目录时发
/// `WorkspaceChanged`，前端只从事件与快照取。
#[tokio::test]
async fn a_workspace_change_is_announced_to_the_front_end() {
    use rust_cli_kernel_api::session_api::KernelEvent;

    let model = Arc::new(ScriptedModel::new(vec![
        tool_use_response("toolu_1", "Switch", &json!({})),
        text_response(&["done"]),
    ]));
    let cwd_env = Arc::new(CwdEnv {
        inner: env(),
        cwd: Mutex::default(),
        refuse: false,
    });
    let mut setup = Setup::new(model);
    setup.set_machine(cwd_env.machine());
    setup.tools = vec![Arc::new(DirTool("Switch"))];
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "go")).await;
    let seen = until(&mut events, finished).await;
    let changed: Vec<&str> = seen
        .iter()
        .filter_map(|event| match event {
            KernelEvent::WorkspaceChanged { workspace } => Some(workspace.root.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(changed, ["/work/.zcode/worktrees/a"]);
}

/// 规则文件来源的替身：新目录有一条规则。
struct OneRule;

#[async_trait]
impl rust_cli_kernel_api::orchestration::DirectoryRules for OneRule {
    async fn directory_rules(
        &self,
        workspace: &WorkspaceRef,
        history: &[Message],
    ) -> Option<String> {
        Some(format!(
            "rules for {} after {} messages",
            workspace.root.as_str(),
            history.len()
        ))
    }
}

/// `/cd` 整个由 actor 判定（R1-3）：与自己的工作目录相同时 `Unchanged`；移动时设 shell cwd、发事件、提交
/// 说明加新目录的规则文件（用 actor 自己的历史，不复制给调用方）；运行中按固定的文字拒绝。
#[tokio::test]
async fn change_directory_is_judged_by_the_actor() {
    use rust_cli_kernel_api::manage::DirectoryOutcome;
    use rust_cli_kernel_api::session_api::{Ack, Command, KernelEvent};

    use crate::test_support::envelope;

    let gate = Arc::new(tokio::sync::Notify::new());
    let cwd_env = Arc::new(CwdEnv {
        inner: env(),
        cwd: Mutex::default(),
        refuse: false,
    });
    let mut setup = Setup::new(Arc::new(GatedModel::new(gate.clone())));
    setup.set_machine(cwd_env.clone().machine());
    setup.directory_rules = Arc::new(OneRule);
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    let cd = |id: &str, root: &str| {
        envelope(
            id,
            Command::ChangeDirectory {
                root: EnvPath::new(root),
            },
        )
    };
    let outcome = |ack: Ack| match ack {
        Ack::Accepted {
            result: rust_cli_kernel_api::session_api::CommandResult::Directory(outcome),
        } => outcome,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        outcome(built.session.send(cd("c1", "/work")).await),
        DirectoryOutcome::Unchanged
    );
    // 回合进行中：拒绝（固定的文字），目录不变。
    built.session.send(submit("c2", "go")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnStarted { .. })
    })
    .await;
    let Ack::Rejected { reason } = built.session.send(cd("c3", "/work/other")).await else {
        panic!("a running turn must refuse the move");
    };
    assert!(reason.starts_with("A turn is in progress"), "{reason}");
    gate.notify_one();
    until(&mut events, finished).await;
    assert_eq!(
        outcome(built.session.send(cd("c4", "/work/other")).await),
        DirectoryOutcome::Moved
    );
    let seen = until(&mut events, |event| {
        matches!(event, KernelEvent::MessageDone { .. })
    })
    .await;
    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::WorkspaceChanged { workspace } if workspace.root.as_str() == "/work/other"
    )));
    let view = built.session.view().await.unwrap();
    assert_eq!(view.meta.workspace.root.as_str(), "/work/other");
    let Some(Message::User(note)) = view.messages.last() else {
        panic!("no note");
    };
    let ContentBlock::Text { text } = &note.content[0] else {
        panic!("not text");
    };
    assert!(
        text.starts_with(
            "<system-reminder>\nThe session's working directory has changed to /work/other (via /cd)."
        ),
        "{text}"
    );
    assert!(
        text.ends_with("\n\nrules for /work/other after 2 messages"),
        "{text}"
    );
    assert_eq!(*cwd_env.cwd.lock_unpoisoned(), ["/work/other"]);
}

/// 工作线 F57：`/cd` 的“已经在这里”用 kernel-api `env_path` 的键判断（规范化；Windows 上不分大小写），与没有会话时
/// runtime 的判断相同。以前按字符串 `==`：Windows 上 `/cd c:\work` 回到 `C:\Work` 被当成换目录（说明文字、规则文件
/// 都再来一遍），POSIX 上 `/work/` 也是。
#[tokio::test]
async fn the_same_directory_is_judged_by_its_path_key() {
    use rust_cli_kernel_api::manage::DirectoryOutcome;
    use rust_cli_kernel_api::session_api::{Ack, Command};

    use crate::test_support::envelope;

    let unchanged = |root: &'static str, target: &'static str| async move {
        let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
        setup.set_machine(
            Arc::new(CwdEnv {
                inner: env(),
                cwd: Mutex::default(),
                refuse: false,
            })
            .machine(),
        );
        setup.root = root;
        let built = setup.build().await;
        let command = Command::ChangeDirectory {
            root: EnvPath::new(target),
        };
        let ack = built.session.send(envelope("c1", command)).await;
        let Ack::Accepted {
            result: rust_cli_kernel_api::session_api::CommandResult::Directory(outcome),
        } = ack
        else {
            panic!("refused: {ack:?}");
        };
        outcome == DirectoryOutcome::Unchanged
    };
    assert!(unchanged(r"C:\Work", r"c:\work").await);
    assert!(unchanged(r"C:\Work", r"C:\Work\").await);
    assert!(unchanged("/work", "/work/").await);
    // POSIX 区分大小写：是另一个目录。
    assert!(!unchanged("/work", "/WORK").await);
}

/// 修复线 F105（tui-input.md §11.1）：为投递插话而转后台（`DeliverMessage`）只在 next 通道里还有排着的插话时转——界面的
/// 队列可能落后一个事件，是否还有插话只看 actor 自己的通道；用户按的转后台（`User`）照旧。旧代码不看通道，没有插话时
/// 也转。
#[tokio::test]
async fn delivering_moves_the_foreground_only_while_an_input_waits() {
    use rust_cli_kernel_api::env::BackgroundReason;
    use rust_cli_kernel_api::session_api::{Command, Delivery, KernelEvent};

    use crate::test_support::envelope;

    let gate = Arc::new(tokio::sync::Notify::new());
    let mut setup = Setup::new(Arc::new(GatedModel::new(gate.clone())));
    let memory = env();
    setup.set_env(memory.clone());
    let built = setup.build().await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "hi")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnStarted { .. })
    })
    .await;
    let deliver = |id| {
        envelope(
            id,
            Command::BackgroundForeground {
                reason: BackgroundReason::DeliverMessage,
            },
        )
    };
    built.session.send(deliver("c2")).await;
    assert!(memory.moved().is_empty(), "no input waits yet");
    let steer = Command::Submit {
        text: "also this".to_owned(),
        attachments: Vec::new(),
        delivery: Delivery::Steer,
    };
    built.session.send(envelope("c3", steer)).await;
    built.session.send(deliver("c4")).await;
    let by_user = Command::BackgroundForeground {
        reason: BackgroundReason::User,
    };
    built.session.send(envelope("c5", by_user)).await;
    assert_eq!(
        memory.moved(),
        [BackgroundReason::DeliverMessage, BackgroundReason::User]
    );
    // The first reply ends without tool calls: the steer joins that turn (Node 3.17 text-only drain) and the
    // model is asked again; release that request too. One turn finishes.
    gate.notify_one();
    for _ in 0..200 {
        if built.session.view().await.unwrap().queue.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(built.session.view().await.unwrap().queue.is_empty());
    gate.notify_one();
    until(&mut events, finished).await;
}

/// Fork: the prepared-worktree activation (`Command::SetExecutionRoot`, specs/fork-rust-agent-parity.md "Execution
/// worktree") moves the shell cwd and the workspace like `/cd` but commits no note: the first turn starts in the
/// worktree with nothing about the parent in its history. A running turn refuses it.
#[tokio::test]
async fn the_execution_root_moves_the_session_without_a_note() {
    use rust_cli_kernel_api::session_api::{Ack, Command, KernelEvent};

    use crate::test_support::envelope;

    let gate = Arc::new(tokio::sync::Notify::new());
    let cwd_env = Arc::new(CwdEnv {
        inner: env(),
        cwd: Mutex::default(),
        refuse: false,
    });
    let mut setup = Setup::new(Arc::new(GatedModel::new(gate.clone())));
    setup.set_machine(cwd_env.clone().machine());
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    let set = |id: &str, root: &str| {
        envelope(
            id,
            Command::SetExecutionRoot {
                root: EnvPath::new(root),
            },
        )
    };
    assert!(matches!(
        built.session.send(set("c1", "/work/.worktrees/a")).await,
        Ack::Accepted { .. }
    ));
    let seen = until(&mut events, |event| {
        matches!(event, KernelEvent::WorkspaceChanged { .. })
    })
    .await;
    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::WorkspaceChanged { workspace } if workspace.root.as_str() == "/work/.worktrees/a"
    )));
    let view = built.session.view().await.unwrap();
    assert_eq!(view.meta.workspace.root.as_str(), "/work/.worktrees/a");
    assert!(view.messages.is_empty(), "{:?}", view.messages);
    assert_eq!(*cwd_env.cwd.lock_unpoisoned(), ["/work/.worktrees/a"]);

    built.session.send(submit("c2", "go")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnStarted { .. })
    })
    .await;
    let Ack::Rejected { reason } = built.session.send(set("c3", "/elsewhere")).await else {
        panic!("a running turn must refuse the move");
    };
    assert!(reason.starts_with("A turn is in progress"), "{reason}");
    gate.notify_one();
    until(&mut events, finished).await;
    assert_eq!(
        built
            .session
            .view()
            .await
            .unwrap()
            .meta
            .workspace
            .root
            .as_str(),
        "/work/.worktrees/a"
    );
}

/// Fork: a session created for a prepared worktree (`SessionState::start_held`) holds SessionStart until the activation
/// moves it, so the hook runs in the worktree, as Node starts the runtime there.
#[tokio::test]
async fn a_prepared_session_runs_session_start_in_the_worktree_after_the_move() {
    held_start_runs_in_the_worktree(crate::Opened::Created, StartSource::Startup, "startup").await;
}

/// Fork: a prepared session reopened cold before its activation (an agent restart) still holds SessionStart, so the
/// hook never runs in the parent checkout.
#[tokio::test]
async fn a_prepared_session_reopened_cold_holds_session_start_until_the_move() {
    held_start_runs_in_the_worktree(crate::Opened::Loaded, StartSource::Resume, "resume").await;
}

async fn held_start_runs_in_the_worktree(opened: crate::Opened, start: StartSource, source: &str) {
    use rust_cli_kernel_api::hooks::{HookEventName, HookOutcome};
    use rust_cli_kernel_api::session_api::{Ack, Command};

    use crate::test_support::{ScriptedHooks, envelope};

    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        HookOutcome::default(),
    ));
    let cwd_env = Arc::new(CwdEnv {
        inner: env(),
        cwd: Mutex::default(),
        refuse: false,
    });
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
    setup.set_machine(cwd_env.clone().machine());
    setup.hooks = hooks.clone();
    setup.start_held = true;
    setup.opened = opened;
    setup.start = start;
    let built = setup.build().await;
    // A round trip through the actor: it has started, and SessionStart has not.
    let view = built.session.view().await.unwrap();
    assert!(!view.running);
    assert!(hooks.seen().is_empty(), "{:?}", hooks.seen());

    let moved = built
        .session
        .send(envelope(
            "c1",
            Command::SetExecutionRoot {
                root: EnvPath::new("/work/.worktrees/a"),
            },
        ))
        .await;
    assert!(matches!(moved, Ack::Accepted { .. }), "{moved:?}");
    let started = async {
        loop {
            if let Some(event) = hooks.seen().first().cloned() {
                return event;
            }
            tokio::task::yield_now().await;
        }
    };
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), started)
        .await
        .unwrap();
    assert_eq!(event.name, HookEventName::SessionStart);
    assert_eq!(event.workspace.root.as_str(), "/work/.worktrees/a");
    assert_eq!(event.payload["source"], source);
}

/// Fork: an activation retried after a restart between the admitted first input and the active marker. The session
/// was reopened cold in its stored worktree with SessionStart held; the same-root move releases it (source `resume`)
/// without moving the shell, and a further same-root move is an accepted no-op.
#[tokio::test]
async fn a_same_root_move_releases_the_held_start_once() {
    use rust_cli_kernel_api::hooks::{HookEventName, HookOutcome};
    use rust_cli_kernel_api::session_api::{Ack, Command};

    use crate::test_support::{ScriptedHooks, envelope};

    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        HookOutcome::default(),
    ));
    let cwd_env = Arc::new(CwdEnv {
        inner: env(),
        cwd: Mutex::default(),
        refuse: false,
    });
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
    setup.set_machine(cwd_env.clone().machine());
    setup.hooks = hooks.clone();
    setup.start_held = true;
    setup.opened = crate::Opened::Loaded;
    setup.start = StartSource::Resume;
    setup.root = "/work/.worktrees/a";
    let built = setup.build().await;
    built.session.view().await.unwrap();
    assert!(hooks.seen().is_empty(), "{:?}", hooks.seen());

    let same_root = |id: &str| {
        envelope(
            id,
            Command::SetExecutionRoot {
                root: EnvPath::new("/work/.worktrees/a"),
            },
        )
    };
    let moved = built.session.send(same_root("c1")).await;
    assert!(matches!(moved, Ack::Accepted { .. }), "{moved:?}");
    let started = async {
        loop {
            if let Some(event) = hooks.seen().first().cloned() {
                return event;
            }
            tokio::task::yield_now().await;
        }
    };
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), started)
        .await
        .unwrap();
    assert_eq!(event.name, HookEventName::SessionStart);
    assert_eq!(event.workspace.root.as_str(), "/work/.worktrees/a");
    assert_eq!(event.payload["source"], "resume");
    assert!(cwd_env.cwd.lock_unpoisoned().is_empty());

    let again = built.session.send(same_root("c2")).await;
    assert!(matches!(again, Ack::Accepted { .. }), "{again:?}");
    built.session.view().await.unwrap();
    assert_eq!(hooks.seen().len(), 1, "{:?}", hooks.seen());
}
